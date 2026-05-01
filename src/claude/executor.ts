import { spawnSync } from "child_process";
import { createRequire } from "module";
import type {
  CanUseTool,
  HookCallback,
  HookJSONOutput,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  PreToolUseHookInput,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAuthMode } from "../config.js";

const require = createRequire(import.meta.url);

export interface ExecuteResult {
  success: boolean;
  output: string;
  error?: string;
  duration: number;
  claudeSessionId?: string;
  interrupted?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

export type ClaudeStreamEvent =
  | { type: "assistant_text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; text: string };

export interface ClaudeToolPermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  signal: AbortSignal;
  title?: string;
  displayName?: string;
  description?: string;
  suggestions?: PermissionUpdate[];
}

export type ClaudeToolPermissionHandler = (
  request: ClaudeToolPermissionRequest
) => Promise<PermissionResult>;

export interface ExecuteOptions {
  conversationId?: string;
  workDir: string;
  resumeSessionId?: string;
  timeout: number;
  maxTurns: number;
  authMode?: ClaudeAuthMode;
  interruptSignal?: AbortSignal;
  onStreamEvent?: (event: ClaudeStreamEvent) => Promise<void> | void;
  onToolPermission?: ClaudeToolPermissionHandler;
}

const DENIED_BASH_MESSAGE = "Bash command denied by raven-ts allowlist";
const SYSTEM_PROMPT_APPEND = [
  "raven-ts runs Claude from a Feishu/Lark bot. Some tools may require approval from a Feishu permission card.",
  "For network access, prefer built-in WebSearch or WebFetch tools. Do not use Bash network commands such as curl, wget, nc, or ad-hoc Python HTTP clients.",
  "If a tool is denied by raven-ts, continue the turn and explain the denied command instead of waiting for manual approval.",
].join("\n");
let cachedClaudeCodeExecutablePath: string | undefined | null;

interface ClaudeRuntime {
  key: string;
  workDir: string;
  authMode: ClaudeAuthMode;
  input: ClaudeInputQueue;
  query: Query;
  iterator: AsyncIterator<SDKMessage>;
  deniedCommands?: string[];
  permissionHandler?: ClaudeToolPermissionHandler;
  claudeSessionId?: string;
}

interface ToolPermissionContext {
  toolUseID?: string;
  signal: AbortSignal;
  suggestions?: PermissionUpdate[];
  title?: string;
  displayName?: string;
  description?: string;
}

const claudeRuntimes = new Map<string, ClaudeRuntime>();
const DEFAULT_CLAUDE_AUTH_MODE: ClaudeAuthMode = "safe";
const READ_ONLY_CLAUDE_TOOLS = new Set([
  "Glob",
  "Grep",
  "LS",
  "Read",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
]);

/**
 * Execute a prompt through the Claude Agent SDK.
 */
export async function executeClaude(
  prompt: string,
  options: ExecuteOptions
): Promise<ExecuteResult> {
  const startTime = Date.now();
  const runtimeKey = getClaudeRuntimeKey(options);
  const deniedCommands: string[] = [];
  const assistantText: string[] = [];
  let resultMessage: SDKResultMessage | undefined;
  let claudeSessionId = options.resumeSessionId;
  let timedOut = false;
  let interrupted = false;
  let runtime: ClaudeRuntime | undefined;
  let forceCloseTimeoutId: NodeJS.Timeout | undefined;

  const interruptRuntime = (): void => {
    if (!runtime) {
      return;
    }

    const interruptedRuntime = runtime;
    void interruptedRuntime.query.interrupt().catch((err) => {
      console.error("[Claude] Failed to interrupt persistent runtime; disposing it:", err);
      disposeClaudeRuntime(interruptedRuntime.key);
    });
  };

  const onInterrupt = (): void => {
    if (timedOut) {
      return;
    }
    interrupted = true;
    interruptRuntime();
  };

  if (options.interruptSignal?.aborted) {
    onInterrupt();
  } else {
    options.interruptSignal?.addEventListener("abort", onInterrupt, { once: true });
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    interruptRuntime();
    forceCloseTimeoutId = setTimeout(() => {
      disposeClaudeRuntime(runtimeKey);
    }, 10000);
  }, options.timeout);

  try {
    runtime = await getOrCreateClaudeRuntime(runtimeKey, options);
    claudeSessionId = runtime.claudeSessionId ?? claudeSessionId;
    runtime.deniedCommands = deniedCommands;
    runtime.permissionHandler = options.onToolPermission;
    runtime.input.enqueue(createUserMessage(prompt));

    while (true) {
      const next = await runtime.iterator.next();
      if (next.done) {
        disposeClaudeRuntime(runtimeKey);
        break;
      }

      const message = next.value;
      claudeSessionId = getMessageSessionId(message) ?? claudeSessionId;
      runtime.claudeSessionId = claudeSessionId;

      if (message.type === "assistant") {
        for (const event of extractAssistantStreamEvents(message.message.content)) {
          if (event.type === "assistant_text") {
            assistantText.push(event.text);
          }
          await emitStreamEvent(options.onStreamEvent, event);
        }
      }

      if (message.type === "user") {
        for (const event of extractUserStreamEvents(message.message.content)) {
          await emitStreamEvent(options.onStreamEvent, event);
        }
      }

      if (message.type === "result") {
        resultMessage = message;
        break;
      }
    }

    const duration = resultMessage?.duration_ms ?? Date.now() - startTime;
    const fallbackOutput = assistantText.join("\n\n").trim();
    const usage = getResultUsage(resultMessage);

    if (deniedCommands.length > 0) {
      const error = deniedCommands.join("\n");
      return {
        success: false,
        output: fallbackOutput,
        error,
        duration,
        claudeSessionId,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
      };
    }

    if (!resultMessage) {
      return {
        success: false,
        output: fallbackOutput,
        interrupted,
        error: timedOut
          ? `Execution timed out after ${options.timeout}ms`
          : interrupted
            ? "Execution interrupted by raven-ts"
          : "Claude SDK finished without a result message",
        duration: Date.now() - startTime,
        claudeSessionId,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
      };
    }

    claudeSessionId = resultMessage.session_id;

    if (resultMessage.subtype === "success") {
      return {
        success: true,
        output: resultMessage.result || fallbackOutput,
        duration,
        claudeSessionId,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
      };
    }

    const errorText = formatSdkError(resultMessage, fallbackOutput);
    return {
      success: false,
      output: fallbackOutput,
      interrupted,
      error: errorText,
      duration,
      claudeSessionId,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
    };
  } catch (err) {
    if (!interrupted && !timedOut) {
      disposeClaudeRuntime(runtimeKey);
    }
    const deniedError = deniedCommands.join("\n");
    return {
      success: false,
      output: assistantText.join("\n\n").trim(),
      interrupted,
      error: deniedError || formatThrownSdkError(err, timedOut, options.timeout),
      duration: Date.now() - startTime,
      claudeSessionId,
      inputTokens: getResultUsage(resultMessage)?.input_tokens,
      outputTokens: getResultUsage(resultMessage)?.output_tokens,
    };
  } finally {
    clearTimeout(timeoutId);
    if (forceCloseTimeoutId) {
      clearTimeout(forceCloseTimeoutId);
    }
    if (runtime?.deniedCommands === deniedCommands) {
      runtime.deniedCommands = undefined;
    }
    if (runtime && runtime.permissionHandler === options.onToolPermission) {
      runtime.permissionHandler = undefined;
    }
    options.interruptSignal?.removeEventListener("abort", onInterrupt);
  }
}

export function disposeClaudeRuntime(conversationId?: string): void {
  if (conversationId) {
    const runtime = claudeRuntimes.get(conversationId);
    runtime?.input.close();
    runtime?.query.close();
    claudeRuntimes.delete(conversationId);
    return;
  }

  for (const runtime of claudeRuntimes.values()) {
    runtime.input.close();
    runtime.query.close();
  }
  claudeRuntimes.clear();
}

export async function checkClaudeSdkAvailable(): Promise<boolean> {
  try {
    await import("@anthropic-ai/claude-agent-sdk");
    return true;
  } catch {
    return false;
  }
}

export function getAnthropicEnvVarNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith("ANTHROPIC_") && env[key])
    .sort();
}

function resolveClaudeCodeExecutablePath(): string | undefined {
  if (cachedClaudeCodeExecutablePath !== undefined) {
    return cachedClaudeCodeExecutablePath ?? undefined;
  }

  const envPath =
    process.env.RAVEN_TS_CLAUDE_CODE_PATH ||
    process.env.RAVEN_CLAUDE_CODE_PATH ||
    process.env.CC_YS_CLAUDE_CODE_PATH ||
    process.env.CLAUDE_CODE_EXECUTABLE ||
    process.env.CLAUDE_CODE_PATH;
  if (envPath && canRunClaudeCode(envPath)) {
    cachedClaudeCodeExecutablePath = envPath;
    return envPath;
  }

  for (const candidate of getClaudeCodeExecutableCandidates()) {
    const resolved = resolvePackageExecutable(candidate);
    if (resolved && canRunClaudeCode(resolved)) {
      cachedClaudeCodeExecutablePath = resolved;
      return resolved;
    }
  }

  cachedClaudeCodeExecutablePath = null;
  return undefined;
}

function getClaudeCodeExecutableCandidates(): string[] {
  const binaryName = process.platform === "win32" ? "claude.exe" : "claude";

  if (process.platform === "linux" && process.arch === "x64") {
    return [
      `@anthropic-ai/claude-agent-sdk-linux-x64/${binaryName}`,
      `@anthropic-ai/claude-agent-sdk-linux-x64-musl/${binaryName}`,
    ];
  }

  if (process.platform === "linux" && process.arch === "arm64") {
    return [
      `@anthropic-ai/claude-agent-sdk-linux-arm64/${binaryName}`,
      `@anthropic-ai/claude-agent-sdk-linux-arm64-musl/${binaryName}`,
    ];
  }

  if (process.platform === "darwin" && process.arch === "x64") {
    return [`@anthropic-ai/claude-agent-sdk-darwin-x64/${binaryName}`];
  }

  if (process.platform === "darwin" && process.arch === "arm64") {
    return [`@anthropic-ai/claude-agent-sdk-darwin-arm64/${binaryName}`];
  }

  if (process.platform === "win32" && process.arch === "x64") {
    return [`@anthropic-ai/claude-agent-sdk-win32-x64/${binaryName}`];
  }

  if (process.platform === "win32" && process.arch === "arm64") {
    return [`@anthropic-ai/claude-agent-sdk-win32-arm64/${binaryName}`];
  }

  return [];
}

function resolvePackageExecutable(packagePath: string): string | undefined {
  try {
    return require.resolve(packagePath);
  } catch {
    return undefined;
  }
}

function canRunClaudeCode(path: string): boolean {
  const result = spawnSync(path, ["--version"], {
    encoding: "utf-8",
    stdio: "ignore",
    timeout: 5000,
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function createCanUseTool(runtime: ClaudeRuntime): CanUseTool {
  return async (toolName, input, permissionOptions): Promise<PermissionResult> => {
    return decideToolPermission(runtime, toolName, input, permissionOptions);
  };
}

function createBashPreToolUseHook(runtime: ClaudeRuntime): HookCallback {
  return async (hookInput, toolUseId, options): Promise<HookJSONOutput> => {
    if (!isPreToolUseHookInput(hookInput) || hookInput.tool_name !== "Bash") {
      return {};
    }

    const input = asRecord(hookInput.tool_input);
    const result = await decideToolPermission(runtime, "Bash", input, {
      signal: options.signal,
      toolUseID: hookInput.tool_use_id || toolUseId,
      title: "Claude wants to run a Bash command",
      displayName: "Run Bash command",
      description: "Approve this command to continue the Claude turn.",
    });

    if (result.behavior === "allow") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: result.updatedInput,
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: result.message,
      },
    };
  };
}

function buildClaudePermissionOptions(runtime: ClaudeRuntime): {
  canUseTool?: CanUseTool;
  hooks?: { PreToolUse: { matcher: string; hooks: HookCallback[]; timeout: number }[] };
} {
  if (runtime.authMode === "auto" || runtime.authMode === "bypass") {
    return {};
  }

  return {
    canUseTool: createCanUseTool(runtime),
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [createBashPreToolUseHook(runtime)],
          timeout: 310,
        },
      ],
    },
  };
}

function normalizeClaudeAuthMode(authMode?: ClaudeAuthMode): ClaudeAuthMode {
  return authMode ?? DEFAULT_CLAUDE_AUTH_MODE;
}

function getClaudeSdkPermissionMode(authMode: ClaudeAuthMode): PermissionMode {
  switch (authMode) {
    case "auto":
      return "auto";
    case "accept-edits":
      return "acceptEdits";
    case "deny":
      return "dontAsk";
    case "bypass":
      return "bypassPermissions";
    case "ask":
    case "safe":
    default:
      return "default";
  }
}

async function decideToolPermission(
  runtime: ClaudeRuntime,
  toolName: string,
  input: Record<string, unknown>,
  permissionOptions: ToolPermissionContext
): Promise<PermissionResult> {
  const toolUseID = permissionOptions.toolUseID ?? "";
  const authMode = runtime.authMode ?? DEFAULT_CLAUDE_AUTH_MODE;
  const command = toolName === "Bash" ? getBashCommand(input) : "";
  console.log(
    `[Permission] mode=${authMode} tool=${toolName} command=${command || "-"} handler=${runtime.permissionHandler ? "yes" : "no"}`
  );

  if (authMode === "bypass") {
    return {
      behavior: "allow",
      updatedInput: input,
      toolUseID,
      decisionClassification: "user_temporary",
    };
  }

  if (toolName !== "Bash") {
    if (
      authMode === "safe" ||
      authMode === "accept-edits" ||
      READ_ONLY_CLAUDE_TOOLS.has(toolName)
    ) {
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID,
        decisionClassification: "user_temporary",
      };
    }

    if (authMode === "deny") {
      return denyToolPermission(runtime, toolName, toolUseID);
    }

    return requestToolPermission(runtime, toolName, input, permissionOptions);
  }

  if (command && authMode !== "ask" && isAllowedBashCommand(command)) {
    console.log(`[Permission] Auto-allow safe Bash command: ${command}`);
    return {
      behavior: "allow",
      updatedInput: input,
      toolUseID,
      decisionClassification: "user_temporary",
    };
  }

  const message = command
    ? `${DENIED_BASH_MESSAGE}: ${command}`
    : `${DENIED_BASH_MESSAGE}: missing command`;

  if (authMode === "deny") {
    return denyToolPermission(runtime, toolName, toolUseID, message);
  }

  return requestToolPermission(runtime, toolName, input, permissionOptions, message);
}

function requestToolPermission(
  runtime: ClaudeRuntime,
  toolName: string,
  input: Record<string, unknown>,
  permissionOptions: ToolPermissionContext,
  deniedMessage?: string
): Promise<PermissionResult> | PermissionResult {
  const toolUseID = permissionOptions.toolUseID ?? "";
  const command = toolName === "Bash" ? getBashCommand(input) : "";
  if (runtime.permissionHandler) {
    console.log(`[Permission] Requesting Feishu approval for ${toolName}: ${command || "(no command)"}`);
    return runtime.permissionHandler({
      toolName,
      input,
      toolUseId: toolUseID,
      signal: permissionOptions.signal,
      title: permissionOptions.title,
      displayName: permissionOptions.displayName,
      description: permissionOptions.description,
      suggestions: permissionOptions.suggestions,
    });
  }

  const message =
    deniedMessage ||
    (command
      ? `${DENIED_BASH_MESSAGE}: ${command}`
      : `Tool denied by raven-ts auth mode: ${toolName}`);
  console.log(`[Permission] Denying tool without Feishu handler: ${toolName}`);
  runtime.deniedCommands?.push(message);

  return {
    behavior: "deny",
    message,
    toolUseID,
    decisionClassification: "user_reject",
  };
}

function denyToolPermission(
  runtime: ClaudeRuntime,
  toolName: string,
  toolUseID: string,
  message = `Tool denied by raven-ts auth mode: ${toolName}`
): PermissionResult {
  console.log(`[Permission] Denying tool by auth mode: ${toolName}`);
  runtime.deniedCommands?.push(message);
  return {
    behavior: "deny",
    message,
    toolUseID,
    decisionClassification: "user_reject",
  };
}

async function getOrCreateClaudeRuntime(
  key: string,
  options: ExecuteOptions
): Promise<ClaudeRuntime> {
  const authMode = normalizeClaudeAuthMode(options.authMode);
  const existing = claudeRuntimes.get(key);
  if (existing && existing.workDir === options.workDir && existing.authMode === authMode) {
    return existing;
  }

  if (existing) {
    disposeClaudeRuntime(key);
  }

  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const input = new ClaudeInputQueue();
  const runtime = {
    key,
    workDir: options.workDir,
    authMode,
    input,
  } as ClaudeRuntime;
  const permissionOptions = buildClaudePermissionOptions(runtime);

  const stream = query({
    prompt: input,
    options: {
      cwd: options.workDir,
      resume: options.resumeSessionId,
      permissionMode: getClaudeSdkPermissionMode(authMode),
      tools: { type: "preset", preset: "claude_code" },
      allowedTools: ["WebSearch", "WebFetch"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: SYSTEM_PROMPT_APPEND,
      },
      env: process.env,
      maxTurns: options.maxTurns,
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
      allowDangerouslySkipPermissions: authMode === "bypass" ? true : undefined,
      ...permissionOptions,
    },
  });

  runtime.query = stream;
  runtime.iterator = stream[Symbol.asyncIterator]();
  claudeRuntimes.set(key, runtime);
  return runtime;
}

function getClaudeRuntimeKey(options: ExecuteOptions): string {
  return options.conversationId ?? `${options.workDir}:${options.resumeSessionId ?? "new"}`;
}

function createUserMessage(prompt: string): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
    parent_tool_use_id: null,
  };
}

class ClaudeInputQueue implements AsyncIterable<SDKUserMessage> {
  private messages: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
  private closed = false;

  enqueue(message: SDKUserMessage): void {
    if (this.closed) {
      throw new Error("Claude runtime input queue is closed");
    }

    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ done: false, value: message });
      return;
    }

    this.messages.push(message);
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<SDKUserMessage>> {
    const message = this.messages.shift();
    if (message) {
      return Promise.resolve({ done: false, value: message });
    }

    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

process.once("exit", () => {
  disposeClaudeRuntime();
});

function getBashCommand(input: Record<string, unknown>): string {
  const command = input.command;
  return typeof command === "string" ? command.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isPreToolUseHookInput(value: unknown): value is PreToolUseHookInput {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { hook_event_name?: unknown }).hook_event_name === "PreToolUse"
  );
}

export function isAllowedBashCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized || hasShellControlSyntax(normalized)) {
    return false;
  }

  if (/\b(-exec|-execdir|-delete)\b/.test(normalized)) {
    return false;
  }

  const allowedPatterns = [
    /^(pwd|ls|find|cat|head|tail|grep|rg)(\s+.*)?$/,
    /^sed\s+-n(\s+.*)?$/,
    /^git\s+(status|diff|log|show)(\s+.*)?$/,
    /^npm\s+test(\s+.*)?$/,
    /^npm\s+run\s+(test|build)(\s+.*)?$/,
    /^pnpm\s+(test|build)(\s+.*)?$/,
    /^pnpm\s+run\s+(test|build)(\s+.*)?$/,
    /^yarn\s+(test|build)(\s+.*)?$/,
    /^yarn\s+run\s+(test|build)(\s+.*)?$/,
  ];

  return allowedPatterns.some((pattern) => pattern.test(normalized));
}

function hasShellControlSyntax(command: string): boolean {
  return /[;&|`<>]|\$\(|\n|\r/.test(command);
}

function extractAssistantStreamEvents(content: unknown): ClaudeStreamEvent[] {
  if (typeof content === "string") {
    return content ? [{ type: "assistant_text", text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const events: ClaudeStreamEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const record = block as Record<string, unknown>;
    const blockType = record.type;
    if (blockType === "text" && typeof record.text === "string" && record.text) {
      events.push({ type: "assistant_text", text: record.text });
      continue;
    }

    if (blockType === "thinking" && typeof record.thinking === "string" && record.thinking) {
      events.push({ type: "thinking", text: record.thinking });
      continue;
    }

    if (
      blockType === "tool_use" &&
      typeof record.id === "string" &&
      typeof record.name === "string"
    ) {
      events.push({
        type: "tool_use",
        id: record.id,
        name: record.name,
        input: record.input,
      });
    }
  }

  return events;
}

function extractUserStreamEvents(content: unknown): ClaudeStreamEvent[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const events: ClaudeStreamEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const record = block as Record<string, unknown>;
    if (record.type !== "tool_result") {
      continue;
    }

    events.push({
      type: "tool_result",
      toolUseId: typeof record.tool_use_id === "string" ? record.tool_use_id : "",
      isError: record.is_error === true,
      text: extractToolResultText(record.content),
    });
  }

  return events;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }

    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    if (typeof record.text === "string") {
      parts.push(record.text);
    }
  }

  return parts.join("\n");
}

async function emitStreamEvent(
  handler: ExecuteOptions["onStreamEvent"],
  event: ClaudeStreamEvent
): Promise<void> {
  if (!handler) {
    return;
  }

  try {
    await handler(event);
  } catch (err) {
    console.error("[Stream] Claude stream event handler failed:", err);
  }
}

function formatSdkError(message: SDKResultMessage, fallbackOutput: string): string {
  if (message.subtype === "success") {
    return fallbackOutput || "Unknown SDK error";
  }

  const errors = message.errors.filter(Boolean);
  const denials = message.permission_denials.map((denial) => {
    const command = denial.tool_input.command;
    const detail = typeof command === "string" ? `: ${command}` : "";
    return `Permission denied for ${denial.tool_name}${detail}`;
  });

  const parts = [
    ...errors,
    ...denials,
    message.terminal_reason ? `Terminal reason: ${message.terminal_reason}` : "",
    fallbackOutput,
  ].filter(Boolean);

  return parts.join("\n") || `Claude SDK failed with subtype ${message.subtype}`;
}

function formatThrownSdkError(err: unknown, timedOut: boolean, timeout: number): string {
  if (timedOut) {
    return `Execution timed out after ${timeout}ms`;
  }

  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("[ede_diagnostic]")) {
    return [
      "Claude SDK stopped after a tool call before producing a final answer.",
      "This is usually caused by a denied or unfinished tool call. If this session keeps failing, run /r clear and retry.",
      "",
      message,
    ].join("\n");
  }

  return message;
}

function getMessageSessionId(message: SDKMessage): string | undefined {
  if ("session_id" in message && typeof message.session_id === "string") {
    return message.session_id;
  }
  return undefined;
}

function getResultUsage(
  message: SDKResultMessage | undefined
): { input_tokens?: number; output_tokens?: number } | undefined {
  if (!message || !("usage" in message) || !message.usage || typeof message.usage !== "object") {
    return undefined;
  }

  return message.usage as { input_tokens?: number; output_tokens?: number };
}
