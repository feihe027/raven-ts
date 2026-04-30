import * as Lark from "@larksuiteoapi/node-sdk";
import { createHash } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { join, resolve } from "path";
import {
  getAgentProvider,
  getCodexConfig,
  getFeishuConfig,
  getClaudeConfig,
  setAgentProvider,
} from "../config.js";
import {
  createFeishuClient,
  createFeishuWSClient,
  createEventDispatcher,
  isDebugEventsEnabled,
  parseMessageContent,
  replyToMessage,
  replyWithCard,
  MessageEvent,
} from "./client.js";
import {
  clearSession,
  createSession,
  getOrCreateSession,
  markPromptFinished,
  markPromptStarted,
  setClaudeSessionId,
  setCodexThreadId,
  clearProviderSessions,
} from "../session/store.js";
import { executeClaude, checkClaudeSdkAvailable } from "../claude/executor.js";
import { disposeCodexRuntime, executeCodex, checkCodexSdkAvailable } from "../codex/executor.js";
import { getDaemonStatus } from "../daemon/service.js";
import { getRuntimeDir } from "../daemon/paths.js";

const COMMAND_PREFIX = "/r";

// Track recently processed messages to prevent duplicates
const processedMessages = new Map<string, number>();
const MESSAGE_DEDUP_TTL = 60000; // 1 minute
const CONTENT_DEDUP_TTL = 2000; // Feishu may redeliver the same content with a new id immediately.

function getDuplicateReason(
  messageId: string,
  chatId: string,
  senderId: string,
  content: string
): "message-id" | "content" | undefined {
  const now = Date.now();
  const lastProcessed = processedMessages.get(messageId);

  if (lastProcessed && now - lastProcessed < MESSAGE_DEDUP_TTL) {
    return "message-id";
  }

  processedMessages.set(messageId, now);

  // Clean up old entries
  for (const [id, time] of processedMessages) {
    if (now - time > MESSAGE_DEDUP_TTL) {
      processedMessages.delete(id);
    }
  }

  if (!markMessageIdProcessed(messageId, now)) {
    return "message-id";
  }

  if (!markContentProcessed(chatId, senderId, content, now)) {
    return "content";
  }

  return undefined;
}

function markMessageIdProcessed(messageId: string, now: number): boolean {
  return markDedupKeyProcessed(`message-${messageId}`, now, MESSAGE_DEDUP_TTL);
}

function markContentProcessed(
  chatId: string,
  senderId: string,
  content: string,
  now: number
): boolean {
  const normalizedContent = content.trim().replace(/\s+/g, " ");
  const key = createHash("sha256")
    .update(`${chatId}\n${senderId}\n${normalizedContent}`)
    .digest("hex");
  return markDedupKeyProcessed(`content-${key}`, now, CONTENT_DEDUP_TTL);
}

function markDedupKeyProcessed(key: string, now: number, ttlMs: number): boolean {
  const dir = join(getRuntimeDir(), "message-dedup");
  mkdirSync(dir, { recursive: true });
  cleanupMessageDedupFiles(dir, now);

  const path = join(dir, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.lock`);
  try {
    closeSync(openSync(path, "wx"));
    return true;
  } catch {
    try {
      const age = now - statSync(path).mtimeMs;
      if (age > ttlMs) {
        unlinkSync(path);
        closeSync(openSync(path, "wx"));
        return true;
      }
    } catch {
      // Another process may have removed or created the lock.
    }
    return false;
  }
}

function cleanupMessageDedupFiles(dir: string, now: number): void {
  try {
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      const ttl = file.startsWith("content-") ? CONTENT_DEDUP_TTL : MESSAGE_DEDUP_TTL;
      if (now - statSync(path).mtimeMs > ttl) {
        unlinkSync(path);
      }
    }
  } catch {
    // Best-effort cleanup only.
  }
}

interface HandlerContext {
  client: Lark.Client;
  botOpenId: string;
}

/**
 * Handle incoming Feishu message
 */
export async function handleFeishuMessage(
  event: unknown,
  context: HandlerContext
): Promise<void> {
  if (isDebugEventsEnabled()) {
    console.log("[Debug] Raw event:", JSON.stringify(event, null, 2));
  }

  const messageEvent = parseMessageContent(event);
  if (!messageEvent) {
    console.error("Failed to parse message event");
    return;
  }

  const { messageId, chatId, senderId, content, msgType } = messageEvent;

  // Skip duplicate messages
  const duplicateReason = getDuplicateReason(messageId, chatId, senderId, content);
  if (duplicateReason) {
    console.log(`[Skip pid=${process.pid}] Duplicate ${duplicateReason}: ${messageId}`);
    return;
  }

  // Only handle plain text and rich text post messages.
  if (msgType !== "text" && msgType !== "post") {
    return;
  }

  // Skip messages from the bot itself
  if (senderId === context.botOpenId) {
    return;
  }

  console.log(`[Message pid=${process.pid} id=${messageId} chat=${chatId}] ${senderId}: ${content}`);

  const trimmedContent = content.trim();
  if (!trimmedContent) {
    return;
  }

  // Handle commands
  if (trimmedContent.startsWith(COMMAND_PREFIX)) {
    await handleCommand(trimmedContent, messageEvent, context);
    return;
  }

  // Regular message - execute the configured agent SDK
  await handleAgentRequest(trimmedContent, messageEvent, context);
}

/**
 * Handle slash commands
 */
async function handleCommand(
  content: string,
  event: MessageEvent,
  context: HandlerContext
): Promise<void> {
  const args = content.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
  const command = args[0]?.toLowerCase();

  switch (command) {
    case "help":
      await replyWithCard(
        context.client,
        event.messageId,
        `**raven-ts Commands**

\`/r help\` - Show this help
\`/r cd <path>\` - Change working directory
\`/r pwd\` - Show current directory
\`/r agent [claude|codex]\` - Show or switch agent backend
\`/r claude\` - Switch to Claude
\`/r codex\` - Switch to Codex
\`/r restart\` - Restart Codex runtime for this chat
\`/r clear\` - Clear agent session
\`/r status\` - Show session status

Just send any message without prefix to execute with the configured agent.`,
        "Help"
      );
      break;

    case "cd": {
      const newPath = args.slice(1).join(" ");
      if (!newPath) {
        await replyToMessage(context.client, event.messageId, "Please specify a path: /r cd <path>");
        return;
      }
      const session = getOrCreateSession(event.chatId, getClaudeConfig().defaultWorkDir);
      const resolvedPath = resolveWorkDir(session.workDir, newPath);
      if (!isExistingDirectory(resolvedPath)) {
        await replyToMessage(context.client, event.messageId, `Directory not found: ${resolvedPath}`);
        return;
      }
      if (resolvedPath === session.workDir) {
        await replyToMessage(context.client, event.messageId, `Working directory unchanged: ${resolvedPath}`);
        return;
      }

      disposeCodexRuntime(session.id);
      clearSession(session.id);
      createSession(event.chatId, resolvedPath);
      await replyToMessage(
        context.client,
        event.messageId,
        `Working directory changed to: ${resolvedPath}\nAgent session cleared. Next message starts fresh.`
      );
      break;
    }

    case "pwd": {
      const session = getOrCreateSession(event.chatId, getClaudeConfig().defaultWorkDir);
      await replyToMessage(context.client, event.messageId, `Current directory: ${session.workDir}`);
      break;
    }

    case "clear": {
      const session = getOrCreateSession(event.chatId, getClaudeConfig().defaultWorkDir);
      disposeCodexRuntime(session.id);
      clearSession(session.id);
      createSession(event.chatId, session.workDir);
      await replyToMessage(context.client, event.messageId, "Agent session cleared. Next message starts fresh.");
      break;
    }

    case "restart": {
      const session = getOrCreateSession(event.chatId, getClaudeConfig().defaultWorkDir);
      disposeCodexRuntime(session.id);
      await replyToMessage(
        context.client,
        event.messageId,
        "Codex runtime restarted for this chat. The next Codex request will start a new app-server and resume the saved thread."
      );
      break;
    }

    case "claude":
    case "codex": {
      await switchAgent(command, event, context);
      break;
    }

    case "agent": {
      const requestedProvider = args[1]?.toLowerCase();
      if (!requestedProvider) {
        await replyToMessage(context.client, event.messageId, `Current agent: ${getAgentProvider()}`);
        return;
      }

      if (requestedProvider !== "claude" && requestedProvider !== "codex") {
        await replyToMessage(context.client, event.messageId, "Usage: /r agent <claude|codex>");
        return;
      }

      await switchAgent(requestedProvider, event, context);
      break;
    }

    case "status": {
      const session = getOrCreateSession(event.chatId, getClaudeConfig().defaultWorkDir);
      const claudeAvailable = await checkClaudeSdkAvailable();
      const codexAvailable = await checkCodexSdkAvailable();
      const daemonStatus = await getDaemonStatus();
      await replyWithCard(
        context.client,
        event.messageId,
        `**Working Directory:** \`${session.workDir}\`
**Agent:** ${getAgentProvider()}
**Claude SDK:** ${claudeAvailable ? "Available" : "Not found"}
**Claude SDK Session:** \`${session.claudeSessionId ?? "none"}\`
**Codex SDK:** ${codexAvailable ? "Available" : "Not found"}
**Codex Thread:** \`${session.codexThreadId ?? "none"}\`
**Local Session:** \`${session.id}\`
**Daemon:** ${daemonStatus.running ? "running" : "not running"} (${daemonStatus.platform})
**Last Prompt:** ${formatTimestamp(session.lastPromptAt)}
**Last Result:** ${formatTimestamp(session.lastResultAt)}`,
        "Session Status"
      );
      break;
    }

    default:
      await replyToMessage(
        context.client,
        event.messageId,
        `Unknown command: ${command}\nType /r help for available commands.`
      );
  }
}

async function switchAgent(
  requestedProvider: "claude" | "codex",
  event: MessageEvent,
  context: HandlerContext
): Promise<void> {
  const currentProvider = getAgentProvider();
  setAgentProvider(requestedProvider);
  const cleared = clearProviderSessions(requestedProvider);
  if (requestedProvider !== "codex") {
    disposeCodexRuntime();
  }

  const status =
    currentProvider === requestedProvider
      ? `Agent already set to: ${requestedProvider}.`
      : `Agent switched to: ${requestedProvider}.`;

  await replyToMessage(
    context.client,
    event.messageId,
    `${status} Cleared ${cleared} stale session binding(s).`
  );
}

/**
 * Handle configured agent SDK execution request
 */
async function handleAgentRequest(
  prompt: string,
  event: MessageEvent,
  context: HandlerContext
): Promise<void> {
  const provider = getAgentProvider();

  if (provider === "codex") {
    await handleCodexRequest(prompt, event, context);
    return;
  }

  await handleClaudeRequest(prompt, event, context);
}

async function handleClaudeRequest(
  prompt: string,
  event: MessageEvent,
  context: HandlerContext
): Promise<void> {
  const config = getClaudeConfig();
  const session = getOrCreateSession(event.chatId, config.defaultWorkDir);

  markPromptStarted(session);

  console.log(
    `[Execute] Running Claude Agent SDK in ${session.workDir} (resume: ${session.claudeSessionId ?? "new"})...`
  );

  const result = await executeClaude(prompt, {
    workDir: session.workDir,
    resumeSessionId: session.claudeSessionId,
    timeout: config.timeoutMs,
    maxTurns: config.maxTurns,
  });

  if (result.claudeSessionId) {
    setClaudeSessionId(session, result.claudeSessionId);
  }
  markPromptFinished(session);

  if (result.success) {
    const responseText = truncateForFeishu(result.output);

    console.log(`[Execute] Completed in ${result.duration}ms, sending reply...`);
    if (isDebugEventsEnabled()) {
      console.log(`[Debug] Response length: ${responseText.length} chars`);
    }

    try {
      await replyWithCard(
        context.client,
        event.messageId,
        responseText,
        `[OK] Completed (${formatDuration(result.duration)})`
      );
      console.log(`[Reply] Sent successfully`);
    } catch (replyError) {
      console.error(`[Reply] Failed to send:`, replyError);
    }
  } else {
    const errorText = result.error || result.output || "Unknown error";

    console.error(`[Execute] Failed: ${errorText}`);

    try {
      await replyWithCard(
        context.client,
        event.messageId,
        `[ERROR] **Error**\n\n\`\`\`\n${truncateForFeishu(errorText, 3000)}\n\`\`\``,
        "Execution Failed"
      );
      console.log(`[Reply] Error message sent successfully`);
    } catch (replyError) {
      console.error(`[Reply] Failed to send error message:`, replyError);
    }
  }
}

async function handleCodexRequest(
  prompt: string,
  event: MessageEvent,
  context: HandlerContext
): Promise<void> {
  const claudeConfig = getClaudeConfig();
  const codexConfig = getCodexConfig();
  const session = getOrCreateSession(event.chatId, claudeConfig.defaultWorkDir);

  markPromptStarted(session);

  console.log(
    `[Execute] Running Codex Agent SDK in ${session.workDir} (resume: ${session.codexThreadId ?? "new"})...`
  );

  const result = await executeCodex(prompt, {
    conversationId: session.id,
    workDir: session.workDir,
    resumeThreadId: session.codexThreadId,
    config: codexConfig,
  });

  if (result.codexThreadId) {
    setCodexThreadId(session, result.codexThreadId);
  }
  markPromptFinished(session);

  if (result.injected) {
    try {
      await replyWithCard(context.client, event.messageId, result.output, "[OK] Codex instruction injected");
      console.log(`[Reply] Injection acknowledgement sent successfully`);
    } catch (replyError) {
      console.error(`[Reply] Failed to send injection acknowledgement:`, replyError);
    }
    return;
  }

  await replyExecutionResult("Codex", result, event, context);
}

async function replyExecutionResult(
  agentName: string,
  result: { success: boolean; output: string; error?: string; duration: number },
  event: MessageEvent,
  context: HandlerContext
): Promise<void> {
  if (result.success) {
    const responseText = truncateForFeishu(result.output);

    console.log(`[Execute] ${agentName} completed in ${result.duration}ms, sending reply...`);
    if (isDebugEventsEnabled()) {
      console.log(`[Debug] Response length: ${responseText.length} chars`);
    }

    try {
      await replyWithCard(
        context.client,
        event.messageId,
        responseText,
        `[OK] ${agentName} completed (${formatDuration(result.duration)})`
      );
      console.log(`[Reply] Sent successfully`);
    } catch (replyError) {
      console.error(`[Reply] Failed to send:`, replyError);
    }
  } else {
    const errorText = result.error || result.output || "Unknown error";

    console.error(`[Execute] ${agentName} failed: ${errorText}`);

    try {
      await replyWithCard(
        context.client,
        event.messageId,
        `[ERROR] **${agentName} error**\n\n\`\`\`\n${truncateForFeishu(errorText, 3000)}\n\`\`\``,
        "Execution Failed"
      );
      console.log(`[Reply] Error message sent successfully`);
    } catch (replyError) {
      console.error(`[Reply] Failed to send error message:`, replyError);
    }
  }
}

/**
 * Truncate text for Feishu (max ~30KB per message)
 */
function truncateForFeishu(text: string, maxLength: number = 28000): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + "\n\n... (truncated)";
}

/**
 * Format duration in human readable format
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

function formatTimestamp(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toLocaleString() : "never";
}

function resolveWorkDir(currentWorkDir: string, requestedPath: string): string {
  if (requestedPath === "~" || requestedPath.startsWith("~/")) {
    const home = process.env.HOME ?? "";
    return resolve(home, requestedPath.slice(2));
  }
  return resolve(currentWorkDir, requestedPath);
}

function isExistingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Fetch bot open_id for self-message filtering
 */
export async function fetchBotOpenId(config: ReturnType<typeof getFeishuConfig>): Promise<string | undefined> {
  if (!config) return undefined;

  try {
    const client = createFeishuClient(config);
    // Use generic request method for bot info API
    const response = await (client as unknown as {
      request: (opts: { method: string; url: string; data: Record<string, never> }) => {
        code?: number;
        msg?: string;
        bot?: { open_id?: string; bot_name?: string };
        data?: { bot?: { open_id?: string } };
      };
    }).request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
      data: {},
    });

    if (response.code === 0) {
      const bot = response.bot ?? response.data?.bot;
      return bot?.open_id;
    }
  } catch (err) {
    console.error("Failed to fetch bot info:", err);
  }

  return undefined;
}

/**
 * Create and start the Feishu WebSocket client
 */
export async function startFeishuListener(
  onMessage: (event: unknown, context: HandlerContext) => Promise<void>
): Promise<{ wsClient: Lark.WSClient; botOpenId: string }> {
  const config = getFeishuConfig();
  if (!config) {
    throw new Error("Feishu not configured. Run 'raven-ts init' first.");
  }

  // Fetch bot info
  const botOpenId = await fetchBotOpenId(config);
  console.log(`Bot open_id: ${botOpenId ?? "unknown"}`);

  // Create client and dispatcher
  const client = createFeishuClient(config);
  const wsClient = createFeishuWSClient(config);
  const eventDispatcher = createEventDispatcher(config);

  // Register event handlers
  eventDispatcher.register({
    "im.message.receive_v1": async (data) => {
      await onMessage(data, { client, botOpenId: botOpenId ?? "" });
    },
    "im.message.message_read_v1": async () => {
      // Read receipts are not used by raven-ts.
    },
  });

  // Start WebSocket
  wsClient.start({ eventDispatcher });

  return { wsClient, botOpenId: botOpenId ?? "" };
}
