import { spawnSync } from "child_process";
import { createRequire } from "module";
import type {
  CanUseTool,
  PermissionResult,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

const require = createRequire(import.meta.url);

export interface ExecuteResult {
  success: boolean;
  output: string;
  error?: string;
  duration: number;
  claudeSessionId?: string;
}

export interface ExecuteOptions {
  workDir: string;
  resumeSessionId?: string;
  timeout: number;
  maxTurns: number;
}

const DENIED_BASH_MESSAGE = "Bash command denied by raven-ts allowlist";
const SYSTEM_PROMPT_APPEND = [
  "raven-ts runs Claude from a Feishu/Lark bot with non-interactive permissions.",
  "For network access, prefer built-in WebSearch or WebFetch tools. Do not use Bash network commands such as curl, wget, nc, or ad-hoc Python HTTP clients.",
  "If a tool is denied by raven-ts, continue the turn and explain the denied command instead of waiting for manual approval.",
].join("\n");
let cachedClaudeCodeExecutablePath: string | undefined | null;

/**
 * Execute a prompt through the Claude Agent SDK.
 */
export async function executeClaude(
  prompt: string,
  options: ExecuteOptions
): Promise<ExecuteResult> {
  const startTime = Date.now();
  const abortController = new AbortController();
  const deniedCommands: string[] = [];
  const assistantText: string[] = [];
  let resultMessage: SDKResultMessage | undefined;
  let claudeSessionId = options.resumeSessionId;
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, options.timeout);

  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath();
    const stream = query({
      prompt,
      options: {
        cwd: options.workDir,
        resume: options.resumeSessionId,
        permissionMode: "acceptEdits",
        tools: { type: "preset", preset: "claude_code" },
        allowedTools: ["WebSearch", "WebFetch"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: SYSTEM_PROMPT_APPEND,
        },
        env: process.env,
        maxTurns: options.maxTurns,
        pathToClaudeCodeExecutable,
        abortController,
        canUseTool: createCanUseTool(deniedCommands),
      },
    });

    for await (const message of stream) {
      claudeSessionId = getMessageSessionId(message) ?? claudeSessionId;

      if (message.type === "assistant") {
        assistantText.push(...extractAssistantText(message.message.content));
      }

      if (message.type === "result") {
        resultMessage = message;
      }
    }

    const duration = resultMessage?.duration_ms ?? Date.now() - startTime;
    const fallbackOutput = assistantText.join("\n\n").trim();

    if (deniedCommands.length > 0) {
      const error = deniedCommands.join("\n");
      return {
        success: false,
        output: fallbackOutput,
        error,
        duration,
        claudeSessionId,
      };
    }

    if (!resultMessage) {
      return {
        success: false,
        output: fallbackOutput,
        error: timedOut
          ? `Execution timed out after ${options.timeout}ms`
          : "Claude SDK finished without a result message",
        duration: Date.now() - startTime,
        claudeSessionId,
      };
    }

    claudeSessionId = resultMessage.session_id;

    if (resultMessage.subtype === "success") {
      return {
        success: true,
        output: resultMessage.result || fallbackOutput,
        duration,
        claudeSessionId,
      };
    }

    const errorText = formatSdkError(resultMessage, fallbackOutput);
    return {
      success: false,
      output: fallbackOutput,
      error: errorText,
      duration,
      claudeSessionId,
    };
  } catch (err) {
    const deniedError = deniedCommands.join("\n");
    return {
      success: false,
      output: assistantText.join("\n\n").trim(),
      error: deniedError || formatThrownSdkError(err, timedOut, options.timeout),
      duration: Date.now() - startTime,
      claudeSessionId,
    };
  } finally {
    clearTimeout(timeoutId);
  }
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
  });
  return !result.error && result.status === 0;
}

function createCanUseTool(deniedCommands: string[]): CanUseTool {
  return async (toolName, input, permissionOptions): Promise<PermissionResult> => {
    if (toolName !== "Bash") {
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID: permissionOptions.toolUseID,
        decisionClassification: "user_temporary",
      };
    }

    const command = getBashCommand(input);
    if (command && isAllowedBashCommand(command)) {
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID: permissionOptions.toolUseID,
        decisionClassification: "user_temporary",
      };
    }

    const message = command
      ? `${DENIED_BASH_MESSAGE}: ${command}`
      : `${DENIED_BASH_MESSAGE}: missing command`;
    deniedCommands.push(message);

    return {
      behavior: "deny",
      message,
      toolUseID: permissionOptions.toolUseID,
      decisionClassification: "user_reject",
    };
  };
}

function getBashCommand(input: Record<string, unknown>): string {
  const command = input.command;
  return typeof command === "string" ? command.trim() : "";
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

function extractAssistantText(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const textBlocks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const record = block as Record<string, unknown>;
    if (typeof record.text === "string") {
      textBlocks.push(record.text);
    }
  }

  return textBlocks;
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
