import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import type { McpServerConfig } from "../config.js";
import { getEnabledMcpServers } from "./config.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface McpSmokeTestResult {
  serverName: string;
  serverInfoName?: string;
  serverInfoVersion?: string;
  tools: string[];
  calls: Array<{
    tool: string;
    ok: boolean;
    text?: string;
    error?: string;
  }>;
}

interface JsonRpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export async function smokeTestConfiguredMcpServer(
  serverName?: string,
  options: { timeoutMs?: number } = {}
): Promise<McpSmokeTestResult> {
  const servers = getEnabledMcpServers();
  const names = Object.keys(servers).sort();
  if (names.length === 0) {
    throw new Error("No enabled MCP servers are configured.");
  }

  const selectedName = serverName || names[0];
  const server = servers[selectedName];
  if (!server) {
    throw new Error(`MCP server not found or disabled: ${selectedName}`);
  }

  return smokeTestMcpServer(selectedName, server, options);
}

export async function smokeTestMcpServer(
  serverName: string,
  server: McpServerConfig,
  options: { timeoutMs?: number } = {}
): Promise<McpSmokeTestResult> {
  if (!isStdioServer(server)) {
    throw new Error(`MCP smoke test currently supports stdio servers only: ${serverName}`);
  }

  const client = new StdioMcpClient(server);
  const timeoutMs = options.timeoutMs ?? 10000;
  try {
    await client.start(timeoutMs);
    const initialized = asRecord(
      await withTimeout(
        client.request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "raven-ts",
            version: "0.1.0",
          },
        }),
        timeoutMs,
        "MCP initialize timed out"
      )
    );
    client.notify("notifications/initialized", {});

    const listed = asRecord(
      await withTimeout(client.request("tools/list", {}), timeoutMs, "MCP tools/list timed out")
    );
    const tools = Array.isArray(listed.tools)
      ? listed.tools.flatMap((tool) => {
          const name = asRecord(tool).name;
          return typeof name === "string" ? [name] : [];
        })
      : [];

    const calls: McpSmokeTestResult["calls"] = [];
    if (tools.includes("echo")) {
      calls.push(await callTextTool(client, "echo", { text: "hello mcp" }));
    }
    if (tools.includes("now")) {
      calls.push(await callTextTool(client, "now", {}));
    }

    const serverInfo = asRecord(initialized.serverInfo);
    return {
      serverName,
      serverInfoName: typeof serverInfo.name === "string" ? serverInfo.name : undefined,
      serverInfoVersion: typeof serverInfo.version === "string" ? serverInfo.version : undefined,
      tools: tools.sort(),
      calls,
    };
  } finally {
    client.close();
  }
}

async function callTextTool(
  client: StdioMcpClient,
  tool: string,
  args: Record<string, unknown>
): Promise<McpSmokeTestResult["calls"][number]> {
  try {
    const result = asRecord(
      await withTimeout(
        client.request("tools/call", {
          name: tool,
          arguments: args,
        }),
        10000,
        `MCP tools/call timed out: ${tool}`
      )
    );
    return {
      tool,
      ok: true,
      text: extractTextContent(result.content),
    };
  } catch (err) {
    return {
      tool,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

class StdioMcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private closed = false;

  constructor(private readonly server: Extract<McpServerConfig, { command: string }>) {}

  start(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const startupTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.close();
          reject(new Error(`MCP server did not start within ${timeoutMs}ms`));
        }
      }, timeoutMs);

      try {
        this.child = spawn(this.server.command, this.server.args ?? [], {
          cwd: this.server.cwd,
          env: {
            ...process.env,
            ...this.server.env,
          },
          windowsHide: true,
        });
      } catch (err) {
        clearTimeout(startupTimeout);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.child.stdout.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.drainOutput();
      });

      this.child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8").trim();
        if (text) {
          console.warn(`[MCP] ${this.server.command} stderr: ${text}`);
        }
      });

      this.child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(startupTimeout);
          reject(err);
          return;
        }
        this.rejectAll(err);
      });

      this.child.on("exit", (code, signal) => {
        this.closed = true;
        const detail = `MCP server exited: code=${code ?? "null"} signal=${signal ?? "null"}`;
        if (!settled) {
          settled = true;
          clearTimeout(startupTimeout);
          reject(new Error(detail));
          return;
        }
        this.rejectAll(new Error(detail));
      });

      settled = true;
      clearTimeout(startupTimeout);
      resolve();
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed || !this.child) {
      return Promise.reject(new Error("MCP server is not running"));
    }

    const id = this.nextId++;
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.closed || !this.child) {
      return;
    }
    this.writeMessage({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error("MCP client closed"));
    }
    this.pending.clear();
    this.child?.kill();
  }

  private writeMessage(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child?.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child?.stdin.write(body);
  }

  private drainOutput(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }

      const headers = this.buffer.subarray(0, headerEnd).toString("utf8");
      const contentLength = parseContentLength(headers);
      if (contentLength === undefined) {
        this.rejectAll(new Error("MCP response missing Content-Length"));
        return;
      }

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) {
        return;
      }

      const rawMessage = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      this.handleResponse(JSON.parse(rawMessage) as JsonRpcResponse);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    if (typeof message.id !== "number") {
      return;
    }

    const waiter = this.pending.get(message.id);
    if (!waiter) {
      return;
    }

    this.pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      return;
    }

    waiter.resolve(message.result);
  }

  private rejectAll(err: Error): void {
    for (const waiter of this.pending.values()) {
      waiter.reject(err);
    }
    this.pending.clear();
  }
}

function parseContentLength(headers: string): number | undefined {
  for (const line of headers.split("\r\n")) {
    const match = /^content-length:\s*(\d+)$/i.exec(line.trim());
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return undefined;
}

function isStdioServer(
  server: McpServerConfig
): server is Extract<McpServerConfig, { command: string }> {
  return "command" in server;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function extractTextContent(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .flatMap((item) => {
      const record = asRecord(item);
      return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n");
}
