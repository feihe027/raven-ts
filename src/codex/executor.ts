import { streamText } from "ai";
import {
  createCodexAppServer,
  type ReasoningEffort,
  type Session,
} from "ai-sdk-provider-codex-app-server";
import type { CodexConfig } from "../config.js";

export interface ExecuteCodexResult {
  success: boolean;
  output: string;
  error?: string;
  duration: number;
  codexThreadId?: string;
  injected?: boolean;
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
}

interface ActiveRun {
  session?: Session;
  startedAt: number;
  interruptReason?: "stop" | "bang_prefix";
}

interface CachedRuntime {
  model: DisposableLanguageModel;
  signature: string;
  startedAt: number;
  currentSession?: Session;
  onCurrentSession?: (session: Session) => void;
}

interface DisposableLanguageModel {
  dispose?: () => void;
}

const activeRuns = new Map<string, ActiveRun>();
const cachedRuntimes = new Map<string, CachedRuntime>();

const BASE_INSTRUCTIONS = [
  "You are Codex, OpenAI's coding agent. You are not Claude.",
  "raven-ts runs Codex from a Feishu/Lark bot with non-interactive permissions.",
  "Do not wait for manual approval. If a command or edit is blocked, explain the blocked action and continue.",
].join("\n");

export async function executeCodex(
  prompt: string,
  options: ExecuteCodexOptions
): Promise<ExecuteCodexResult> {
  const activeRun = activeRuns.get(options.conversationId);
  if (activeRun?.session?.isActive()) {
    await activeRun.session.injectMessage(prompt);
    return {
      success: true,
      output: "Instruction injected into the active Codex run.",
      duration: Date.now() - activeRun.startedAt,
      codexThreadId: activeRun.session.threadId,
      injected: true,
    };
  }

  const startTime = Date.now();
  let currentSession: Session | undefined;
  let runtime: CachedRuntime | undefined;
  const runState: ActiveRun = { startedAt: startTime };

  activeRuns.set(options.conversationId, runState);

  try {
    runtime = getOrCreateRuntime(options, runState, startTime, (session) => {
      currentSession = session;
    });
    const result = streamText({
      model: runtime.model as Parameters<typeof streamText>[0]["model"],
      prompt,
      timeout: options.config.timeoutMs,
    });

    let output = "";
    await withTimeout(
      (async () => {
        for await (const delta of result.textStream) {
          output += delta;
          await emitTextDelta(options.onTextDelta, delta);
        }
      })(),
      options.config.timeoutMs
    );

    const providerMetadata = await withTimeout(Promise.resolve(result.providerMetadata), 5000).catch(
      () => undefined
    );
    const usage = normalizeCodexUsage(
      await withTimeout(Promise.resolve(result.totalUsage), 5000).catch(() => undefined)
    );
    const codexThreadId =
      getProviderSessionId(providerMetadata) ?? currentSession?.threadId ?? options.resumeThreadId;
    if (codexThreadId && runtime) {
      runtime.currentSession = currentSession;
    }

    return {
      success: true,
      output: output || "(Codex completed without a final response)",
      duration: Date.now() - startTime,
      codexThreadId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  } catch (err) {
    if (isRuntimePoisoningError(err)) {
      disposeCodexRuntime(options.conversationId);
    }
    return {
      success: false,
      output: "",
      error: runState.interruptReason
        ? formatCodexInterrupted(runState.interruptReason)
        : formatCodexError(err, options.config.timeoutMs),
      duration: Date.now() - startTime,
      codexThreadId: currentSession?.threadId ?? options.resumeThreadId,
      interrupted: runState.interruptReason !== undefined,
      interruptReason: runState.interruptReason,
    };
  } finally {
    activeRuns.delete(options.conversationId);
  }
}

function getOrCreateRuntime(
  options: ExecuteCodexOptions,
  activeRun: ActiveRun,
  startedAt: number,
  onCurrentSession: (session: Session) => void
): CachedRuntime {
  const signature = getRuntimeSignature(options);
  const existing = cachedRuntimes.get(options.conversationId);
  if (existing && existing.signature === signature) {
    existing.startedAt = startedAt;
    existing.onCurrentSession = onCurrentSession;
    return existing;
  }

  existing?.model.dispose?.();

  const runtime: CachedRuntime = {
    model: {},
    signature,
    startedAt,
  };

  const provider = createCodexAppServer({
    defaultSettings: {
      codexPath: options.config.codexBin,
      cwd: options.workDir,
      approvalMode: "never",
      sandboxMode: "workspace-write",
      threadMode: "persistent",
      resume: options.resumeThreadId,
      reasoningEffort: normalizeReasoningEffort(options.config.reasoningEffort),
      env: getStringEnv(process.env),
      baseInstructions: BASE_INSTRUCTIONS,
      configOverrides: {
        sandbox_workspace_write: {
          network_access: options.config.networkAccessEnabled,
        },
      },
      onSessionCreated: (session) => {
        runtime.currentSession = session;
        runtime.onCurrentSession?.(session);
        activeRun.session = session;
        activeRun.startedAt = runtime.startedAt;
        activeRuns.set(options.conversationId, activeRun);
      },
    },
  });

  runtime.model = provider(options.config.model || "gpt-5.3-codex") as DisposableLanguageModel;
  runtime.onCurrentSession = onCurrentSession;
  cachedRuntimes.set(options.conversationId, runtime);
  return runtime;
}

function getRuntimeSignature(options: ExecuteCodexOptions): string {
  return JSON.stringify({
    codexBin: options.config.codexBin,
    workDir: options.workDir,
    model: options.config.model || "gpt-5.3-codex",
    reasoningEffort: normalizeReasoningEffort(options.config.reasoningEffort),
    networkAccessEnabled: options.config.networkAccessEnabled,
  });
}

export function disposeCodexRuntime(conversationId?: string): void {
  if (conversationId) {
    const runtime = cachedRuntimes.get(conversationId);
    runtime?.model.dispose?.();
    cachedRuntimes.delete(conversationId);
    activeRuns.delete(conversationId);
    return;
  }

  for (const runtime of cachedRuntimes.values()) {
    runtime.model.dispose?.();
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
  disposeCodexRuntime(conversationId);
  return true;
}

process.once("exit", () => {
  disposeCodexRuntime();
});

export async function checkCodexSdkAvailable(): Promise<boolean> {
  try {
    await import("ai-sdk-provider-codex-app-server");
    await import("ai");
    return true;
  } catch {
    return false;
  }
}

export function getCodexRuntimeDescription(): string {
  return "Codex app-server over stdio (provider-managed)";
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

function normalizeReasoningEffort(effort: CodexConfig["reasoningEffort"]): ReasoningEffort {
  if (effort === "minimal") {
    return "low";
  }
  return effort;
}

function getProviderSessionId(providerMetadata: unknown): string | undefined {
  if (!providerMetadata || typeof providerMetadata !== "object") {
    return undefined;
  }

  const codex = (providerMetadata as { codex?: unknown })["codex"];
  if (!codex || typeof codex !== "object") {
    return undefined;
  }

  const sessionId = (codex as { sessionId?: unknown })["sessionId"];
  return typeof sessionId === "string" ? sessionId : undefined;
}

function normalizeCodexUsage(usage: unknown): { inputTokens?: number; outputTokens?: number } {
  if (!usage || typeof usage !== "object") {
    return {};
  }

  const inputTokens = getNumericProperty(usage, "inputTokens");
  const outputTokens = getNumericProperty(usage, "outputTokens");
  if (isCodexPlaceholderUsage(usage, inputTokens, outputTokens)) {
    return {};
  }

  return { inputTokens, outputTokens };
}

function isCodexPlaceholderUsage(
  _usage: object,
  inputTokens: number | undefined,
  outputTokens: number | undefined
): boolean {
  // ai-sdk-provider-codex-app-server currently does not expose token counts and
  // fills AI SDK usage with 0/0 placeholders.
  return inputTokens === 0 && outputTokens === 0;
}

function getNumericProperty(source: object, key: string): number | undefined {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatCodexError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.message.toLowerCase().includes("timeout")) {
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

function isRuntimePoisoningError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  const message = err.message.toLowerCase();
  return (
    err.name === "AbortError" ||
    message.includes("timeout") ||
    message.includes("exited") ||
    message.includes("invalid state") ||
    message.includes("thread") && message.includes("not found")
  );
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Execution timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
