#!/usr/bin/env node

import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPath = join(__dirname, "mcp-test-server.js");

let nextId = 1;
let outputBuffer = Buffer.alloc(0);
const pending = new Map();
let timeout;

let child;
try {
  child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
} catch (err) {
  console.error(
    `[ERROR] Failed to start MCP test server: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
}

timeout = setTimeout(() => {
  child.kill();
  fail("Timed out waiting for MCP test server");
}, 10000);

child.stdout.on("data", (chunk) => {
  outputBuffer = Buffer.concat([outputBuffer, chunk]);
  drainOutput();
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

child.on("error", (err) => {
  fail(`Failed to start MCP test server: ${err.message}`);
});

child.on("exit", (code, signal) => {
  if (pending.size > 0) {
    fail(`MCP test server exited early: code=${code ?? "null"} signal=${signal ?? "null"}`);
  }
});

try {
  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "raven-ts-mcp-smoke-test",
      version: "0.1.0",
    },
  });
  assert(initialized.serverInfo?.name === "raven-ts-test-mcp", "unexpected serverInfo.name");

  notify("notifications/initialized", {});

  const listed = await request("tools/list", {});
  const toolNames = listed.tools?.map((tool) => tool.name).sort().join(",");
  assert(toolNames === "echo,now", `unexpected tools: ${toolNames}`);

  const called = await request("tools/call", {
    name: "echo",
    arguments: {
      text: "hello from raven-ts",
    },
  });
  const echoed = called.content?.[0]?.text;
  assert(echoed === "hello from raven-ts", `unexpected echo result: ${echoed}`);

  const now = await request("tools/call", {
    name: "now",
    arguments: {},
  });
  const timestamp = now.content?.[0]?.text;
  assert(typeof timestamp === "string" && !Number.isNaN(Date.parse(timestamp)), "invalid now result");

  clearTimeout(timeout);
  child.kill();
  console.log("[OK] MCP test server initialized, listed tools, and handled tool calls.");
} catch (err) {
  clearTimeout(timeout);
  child.kill();
  fail(err instanceof Error ? err.message : String(err));
}

function request(method, params) {
  const id = nextId++;
  writeMessage({
    jsonrpc: "2.0",
    id,
    method,
    params,
  });

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function notify(method, params) {
  writeMessage({
    jsonrpc: "2.0",
    method,
    params,
  });
}

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}

function drainOutput() {
  while (true) {
    const headerEnd = outputBuffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }

    const headers = outputBuffer.subarray(0, headerEnd).toString("utf8");
    const contentLength = parseContentLength(headers);
    if (contentLength === undefined) {
      fail("MCP response is missing Content-Length");
      return;
    }

    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (outputBuffer.length < bodyEnd) {
      return;
    }

    const rawMessage = outputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
    outputBuffer = outputBuffer.subarray(bodyEnd);
    handleResponse(JSON.parse(rawMessage));
  }
}

function parseContentLength(headers) {
  for (const line of headers.split("\r\n")) {
    const match = /^content-length:\s*(\d+)$/i.exec(line.trim());
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return undefined;
}

function handleResponse(message) {
  const id = message?.id;
  const waiter = pending.get(id);
  if (!waiter) {
    return;
  }

  pending.delete(id);
  if (message.error) {
    waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    return;
  }

  waiter.resolve(message.result);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function fail(message) {
  if (timeout) {
    clearTimeout(timeout);
  }
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}
