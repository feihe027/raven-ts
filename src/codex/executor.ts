import {
  Codex,
  type ModelReasoningEffort,
  type Thread,
  type ThreadItem,
  type ThreadOptions,
  type Usage,
  type UserInput,
} from "@openai/codex-sdk";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { CodexConfig } from "../config.js";
import {
  getImageExtension,
  normalizeAgentPrompt,
  parseImageDataUri,
  type AgentPrompt,
} from "../agent/prompt.js";

export interface ExecuteCodexResult {
  success: boolean;
  output: string;
  error?: string;
  duration: number;
  codexThreadId?: string;
  injected?: boolean;
  busy?: boolean;
  interrupted?: boolean;
  interruptReason?: "stop" | "bang_prefix";
  inputTokens?: number;
  outputTokens?: number;
}

export interface ExecuteCodexOptions {
  conversationId: string;
  workDir: string;
  resumeThreadId?: string;
  config: CodexConfig;
  onTextDelta?: (delta: string) => Promise<void> | void;
  onStreamEvent?: (event: CodexStreamEvent) => Promise<void> | void;
}

export type CodexStreamEvent =
  | { type: "reasoning"; id: string; text: string }
  | {
      type: "command_execution";
      id: string;
      command: string;
      output: string;
      status: "in_progress" | "completed" | "failed";
      exitCode?: number;
    }
  | {
      type: "file_change";
      id: string;
      status: "completed" | "failed";
      changes: Array<{ path: string; kind: "add" | "delete" | "update" }>;
    }
  | {
      type: "mcp_tool_call";
      id: string;
      server: string;
      tool: string;
      arguments: unknown;
      status: "in_progress" | "completed" | "failed";
      result?: unknown;
      error?: { message: string };
    }
  | { type: "web_search"; id: string; query: string }
  | { type: "todo_list"; id: string; items: Array<{ text: string; completed: boolean }> }
  | { type: "error"; id: string; message: string };

interface ActiveRun {
  abortController: AbortController;
  startedAt: number;
  codexThreadId?: string;
  interruptReason?: "stop" | "bang_prefix";
}

interface CachedRuntime {
  codex: Codex;
  thread: Thread;
  signature: string;
  startedAt: number;
  threadId?: string;
}

const activeRuns = new Map<string, ActiveRun>();
const cachedRuntimes = new Map<string, CachedRuntime>();

const BASE_INSTRUCTIONS = [
  "You are Codex, OpenAI's coding agent. You are not Claude.",
  "raven-ts runs Codex from a Feishu/Lark bot with non-interactive permissions.",
  "Do not wait for manual approval. If a command or edit is blocked, explain the blocked action and continue.",
  "raven-ts installs a feishu-docx-bot skill. When asked to save research, paper lists, reports, or generated content into Feishu Docs, follow that skill and use the existing raven-ts Feishu client helpers.",
  "The raven-ts service may run on Windows. Do not invoke bash.exe unless it is already known to exist.",
  "When a user says Bash in a permission-test prompt, treat that as a request to execute a shell command, not as a requirement to start a literal bash.exe process.",
  "On Windows, run simple commands directly or with PowerShell-compatible syntax. For example, use node -v instead of bash -lc \"node -v\".",
].join("\n");

export async function executeCodex(
  prompt: string | AgentPrompt,
  options: ExecuteCodexOptions
): Promise<ExecuteCodexResult> {
  const existingRun = activeRuns.get(options.conversationId);
  if (existingRun) {
    return {
      success: false,
      output: "",
      error: "Codex is already running. Use !message to interrupt it, or wait for the current run to finish.",
      duration: Date.now() - existingRun.startedAt,
      codexThreadId: existingRun.codexThreadId ?? options.resumeThreadId,
      busy: true,
    };
  }

  const startTime = Date.now();
  const abortController = new AbortController();
  const runState: ActiveRun = {
    abortController,
    startedAt: startTime,
    codexThreadId: options.resumeThreadId,
  };
  let timedOut = false;

  activeRuns.set(options.conversationId, runState);

  try {
    const runtime = getOrCreateRuntime(options, startTime);
    let codexThreadId = runtime.thread.id ?? runtime.threadId ?? options.resumeThreadId;
    if (codexThreadId) {
      runState.codexThreadId = codexThreadId;
    }

    const textCache = new Map<string, string>();
    let output = "";
    let usage: Usage | undefined;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, options.config.timeoutMs);
    let codexInput: BuiltCodexInput | undefined;

    try {
      codexInput = await buildPrompt(prompt);
      const streamed = await runtime.thread.runStreamed(codexInput.input, {
        signal: abortController.signal,
      });

      for await (const event of streamed.events) {
        if (event.type === "thread.started") {
          codexThreadId = event.thread_id;
          runtime.threadId = codexThreadId;
          runState.codexThreadId = codexThreadId;
          continue;
        }

        if (
          event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed"
        ) {
          const delta = getTextDelta(event.item, textCache);
          if (delta) {
            output += delta;
            await emitTextDelta(options.onTextDelta, delta);
          }
          const streamEvent = getCodexStreamEvent(event.item);
          if (streamEvent) {
            await emitCodexStreamEvent(options.onStreamEvent, streamEvent);
          }
          continue;
        }

        if (event.type === "turn.completed") {
          usage = event.usage;
          continue;
        }

        if (event.type === "turn.failed") {
          throw new Error(event.error.message);
        }

        if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    } finally {
      clearTimeout(timeoutId);
      await codexInput?.cleanup();
    }

    codexThreadId = runtime.thread.id ?? runtime.threadId ?? codexThreadId;
    if (codexThreadId) {
      runtime.threadId = codexThreadId;
    }

    return {
      success: true,
      output: output || "(Codex completed without a final response)",
      duration: Date.now() - startTime,
      codexThreadId,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      error: runState.interruptReason
        ? formatCodexInterrupted(runState.interruptReason)
        : formatCodexError(err, options.config.timeoutMs, timedOut),
      duration: Date.now() - startTime,
      codexThreadId: runState.codexThreadId ?? options.resumeThreadId,
      interrupted: runState.interruptReason !== undefined,
      interruptReason: runState.interruptReason,
    };
  } finally {
    if (activeRuns.get(options.conversationId) === runState) {
      activeRuns.delete(options.conversationId);
    }
  }
}

function getOrCreateRuntime(options: ExecuteCodexOptions, startedAt: number): CachedRuntime {
  const signature = getRuntimeSignature(options);
  const existing = cachedRuntimes.get(options.conversationId);
  if (existing && existing.signature === signature) {
    existing.startedAt = startedAt;
    return existing;
  }

  const codexOptions: ConstructorParameters<typeof Codex>[0] = {
    env: getStringEnv(process.env),
  };
  if (options.config.codexBin) {
    codexOptions.codexPathOverride = options.config.codexBin;
  }

  const codex = new Codex(codexOptions);
  const threadOptions = getThreadOptions(options);
  const thread = options.resumeThreadId
    ? codex.resumeThread(options.resumeThreadId, threadOptions)
    : codex.startThread(threadOptions);

  const runtime: CachedRuntime = {
    codex,
    thread,
    signature,
    startedAt,
    threadId: options.resumeThreadId,
  };

  cachedRuntimes.set(options.conversationId, runtime);
  return runtime;
}

function getThreadOptions(options: ExecuteCodexOptions): ThreadOptions {
  return {
    model: options.config.model || "gpt-5.3-codex",
    workingDirectory: options.workDir,
    skipGitRepoCheck: options.config.skipGitRepoCheck,
    approvalPolicy: "never",
    sandboxMode: options.config.sandboxMode ?? "workspace-write",
    modelReasoningEffort: normalizeReasoningEffort(options.config.reasoningEffort),
    networkAccessEnabled: options.config.networkAccessEnabled,
  };
}

function getRuntimeSignature(options: ExecuteCodexOptions): string {
  return JSON.stringify({
    codexBin: options.config.codexBin,
    workDir: options.workDir,
    model: options.config.model || "gpt-5.3-codex",
    reasoningEffort: normalizeReasoningEffort(options.config.reasoningEffort),
    skipGitRepoCheck: options.config.skipGitRepoCheck,
    networkAccessEnabled: options.config.networkAccessEnabled,
    sandboxMode: options.config.sandboxMode ?? "workspace-write",
  });
}

export function disposeCodexRuntime(conversationId?: string): void {
  if (conversationId) {
    activeRuns.get(conversationId)?.abortController.abort();
    cachedRuntimes.delete(conversationId);
    activeRuns.delete(conversationId);
    return;
  }

  for (const activeRun of activeRuns.values()) {
    activeRun.abortController.abort();
  }
  cachedRuntimes.clear();
  activeRuns.clear();
}

export function isCodexRunActive(conversationId: string): boolean {
  return activeRuns.has(conversationId);
}

export function interruptCodexRun(
  conversationId: string,
  reason: "stop" | "bang_prefix" = "stop"
): boolean {
  const activeRun = activeRuns.get(conversationId);
  if (!activeRun) {
    return false;
  }

  activeRun.interruptReason = reason;
  activeRun.abortController.abort();
  cachedRuntimes.delete(conversationId);
  activeRuns.delete(conversationId);
  return true;
}

process.once("exit", () => {
  disposeCodexRuntime();
});

export async function checkCodexSdkAvailable(): Promise<boolean> {
  try {
    await import("@openai/codex-sdk");
    return true;
  } catch {
    return false;
  }
}

export function getCodexRuntimeDescription(): string {
  return "Official Codex SDK runStreamed over codex exec";
}

export function getOpenAIEnvVarNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((key) => (key.startsWith("OPENAI_") || key.startsWith("CODEX_")) && env[key])
    .sort();
}

function getStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }

  delete result.CODEX_MANAGED_BY_NPM;
  delete result.CODEX_MANAGED_BY_BUN;
  delete result.CODEX_THREAD_ID;
  delete result.CODEX_SANDBOX_NETWORK_DISABLED;

  return result;
}

function normalizeReasoningEffort(effort: CodexConfig["reasoningEffort"]): ModelReasoningEffort {
  return effort;
}

interface BuiltCodexInput {
  input: string | UserInput[];
  cleanup: () => Promise<void>;
}

async function buildPrompt(input: string | AgentPrompt): Promise<BuiltCodexInput> {
  const prompt = normalizeAgentPrompt(input);
  const text = `${BASE_INSTRUCTIONS}\n\nUser request:\n${prompt.text}`;
  if (!prompt.imageDataUris?.length) {
    return {
      input: text,
      cleanup: async () => {},
    };
  }

  let tempDir: string | undefined;
  try {
    tempDir = await mkdtemp(join(tmpdir(), "raven-ts-codex-images-"));
    const items: UserInput[] = [{ type: "text", text }];

    for (const [index, dataUri] of prompt.imageDataUris.entries()) {
      const parsed = parseImageDataUri(dataUri);
      if (!parsed) {
        continue;
      }
      const path = join(tempDir, `image-${index + 1}.${getImageExtension(parsed.mime)}`);
      await writeFile(path, Buffer.from(parsed.data, "base64"));
      items.push({ type: "local_image", path });
    }

    return {
      input: items.length > 1 ? items : text,
      cleanup: async () => {
        if (tempDir) {
          await rm(tempDir, { recursive: true, force: true });
        }
      },
    };
  } catch (err) {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    throw err;
  }
}

function getTextDelta(item: ThreadItem, textCache: Map<string, string>): string {
  if (item.type === "agent_message") {
    return deltaText(textCache, item.id, item.text);
  }

  if (item.type === "error") {
    return deltaText(textCache, item.id, item.message);
  }

  return "";
}

function getCodexStreamEvent(item: ThreadItem): CodexStreamEvent | undefined {
  switch (item.type) {
    case "reasoning":
      return item.text ? { type: "reasoning", id: item.id, text: item.text } : undefined;
    case "command_execution":
      return {
        type: "command_execution",
        id: item.id,
        command: item.command,
        output: item.aggregated_output,
        status: item.status,
        exitCode: item.exit_code,
      };
    case "file_change":
      return {
        type: "file_change",
        id: item.id,
        status: item.status,
        changes: item.changes,
      };
    case "mcp_tool_call":
      return {
        type: "mcp_tool_call",
        id: item.id,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        status: item.status,
        result: item.result,
        error: item.error,
      };
    case "web_search":
      return { type: "web_search", id: item.id, query: item.query };
    case "todo_list":
      return { type: "todo_list", id: item.id, items: item.items };
    case "error":
      return { type: "error", id: item.id, message: item.message };
    case "agent_message":
      return undefined;
  }
}

function deltaText(cache: Map<string, string>, id: string, next: string): string {
  const previous = cache.get(id) ?? "";
  cache.set(id, next);
  if (!previous) {
    return next;
  }

  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

function formatCodexError(err: unknown, timeoutMs: number, timedOut: boolean): string {
  if (timedOut) {
    return `Execution timed out after ${timeoutMs}ms`;
  }

  if (err instanceof Error) {
    if (err.name === "AbortError" || err.message.toLowerCase().includes("abort")) {
      return "Execution aborted";
    }
    if (err.message.toLowerCase().includes("timeout")) {
      return `Execution timed out after ${timeoutMs}ms`;
    }
    return err.message;
  }
  return String(err);
}

function formatCodexInterrupted(reason: "stop" | "bang_prefix"): string {
  return reason === "bang_prefix"
    ? "Execution interrupted by a newer ! message"
    : "Execution interrupted by /r stop";
}

async function emitTextDelta(
  handler: ExecuteCodexOptions["onTextDelta"],
  delta: string
): Promise<void> {
  if (!handler || !delta) {
    return;
  }

  try {
    await handler(delta);
  } catch (err) {
    console.error("[Stream] Codex text delta handler failed:", err);
  }
}

async function emitCodexStreamEvent(
  handler: ExecuteCodexOptions["onStreamEvent"],
  event: CodexStreamEvent
): Promise<void> {
  if (!handler) {
    return;
  }

  try {
    await handler(event);
  } catch (err) {
    console.error("[Stream] Codex stream event handler failed:", err);
  }
}
