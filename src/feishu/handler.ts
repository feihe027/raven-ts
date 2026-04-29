import * as Lark from "@larksuiteoapi/node-sdk";
import { existsSync, statSync } from "fs";
import { resolve } from "path";
import { getFeishuConfig, getClaudeConfig } from "../config.js";
import {
  createFeishuClient,
  createFeishuWSClient,
  createEventDispatcher,
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
  setWorkDir,
  setClaudeSessionId,
} from "../session/store.js";
import { executeClaude, checkClaudeSdkAvailable } from "../claude/executor.js";
import { getDaemonStatus } from "../daemon/service.js";

const COMMAND_PREFIX = "/cc";

// Track recently processed messages to prevent duplicates
const processedMessages = new Map<string, number>();
const MESSAGE_DEDUP_TTL = 60000; // 1 minute

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  const lastProcessed = processedMessages.get(messageId);

  if (lastProcessed && now - lastProcessed < MESSAGE_DEDUP_TTL) {
    return true;
  }

  processedMessages.set(messageId, now);

  // Clean up old entries
  for (const [id, time] of processedMessages) {
    if (now - time > MESSAGE_DEDUP_TTL) {
      processedMessages.delete(id);
    }
  }

  return false;
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
  if (process.env.CC_YS_DEBUG_EVENTS === "1") {
    console.log("[Debug] Raw event:", JSON.stringify(event, null, 2));
  }

  const messageEvent = parseMessageContent(event);
  if (!messageEvent) {
    console.error("Failed to parse message event");
    return;
  }

  const { messageId, chatId, senderId, content, msgType } = messageEvent;

  // Skip duplicate messages
  if (isDuplicate(messageId)) {
    console.log(`[Skip] Duplicate message: ${messageId}`);
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

  console.log(`[Message] ${senderId}: ${content}`);

  const trimmedContent = content.trim();
  if (!trimmedContent) {
    return;
  }

  // Handle commands
  if (trimmedContent.startsWith(COMMAND_PREFIX)) {
    await handleCommand(trimmedContent, messageEvent, context);
    return;
  }

  // Regular message - execute Claude Agent SDK
  await handleClaudeRequest(trimmedContent, messageEvent, context);
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
        `**cc-ys Commands**

\`/cc help\` - Show this help
\`/cc cd <path>\` - Change working directory
\`/cc pwd\` - Show current directory
\`/cc clear\` - Clear Claude SDK session
\`/cc status\` - Show session status

Just send any message without prefix to execute with Claude Agent SDK.`,
        "Help"
      );
      break;

    case "cd": {
      const newPath = args.slice(1).join(" ");
      if (!newPath) {
        await replyToMessage(context.client, event.messageId, "Please specify a path: /cc cd <path>");
        return;
      }
      const session = getOrCreateSession(event.chatId, getClaudeConfig().defaultWorkDir);
      const resolvedPath = resolveWorkDir(session.workDir, newPath);
      if (!isExistingDirectory(resolvedPath)) {
        await replyToMessage(context.client, event.messageId, `Directory not found: ${resolvedPath}`);
        return;
      }
      setWorkDir(session, resolvedPath);
      await replyToMessage(context.client, event.messageId, `Working directory changed to: ${resolvedPath}`);
      break;
    }

    case "pwd": {
      const session = getOrCreateSession(event.chatId, getClaudeConfig().defaultWorkDir);
      await replyToMessage(context.client, event.messageId, `Current directory: ${session.workDir}`);
      break;
    }

    case "clear": {
      const session = getOrCreateSession(event.chatId, getClaudeConfig().defaultWorkDir);
      clearSession(session.id);
      createSession(event.chatId, session.workDir);
      await replyToMessage(context.client, event.messageId, "Claude SDK session cleared. Next message starts fresh.");
      break;
    }

    case "status": {
      const session = getOrCreateSession(event.chatId, getClaudeConfig().defaultWorkDir);
      const claudeAvailable = await checkClaudeSdkAvailable();
      const daemonStatus = await getDaemonStatus();
      await replyWithCard(
        context.client,
        event.messageId,
        `**Working Directory:** \`${session.workDir}\`
**Claude SDK:** ${claudeAvailable ? "Available" : "Not found"}
**Claude SDK Session:** \`${session.claudeSessionId ?? "none"}\`
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
        `Unknown command: ${command}\nType /cc help for available commands.`
      );
  }
}

/**
 * Handle Claude Agent SDK execution request
 */
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
    if (process.env.CC_YS_DEBUG_EVENTS === "1") {
      console.log(`[Debug] Response length: ${responseText.length} chars`);
    }

    try {
      await replyWithCard(
        context.client,
        event.messageId,
        responseText,
        `✅ Completed (${formatDuration(result.duration)})`
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
        `❌ **Error**\n\n\`\`\`\n${truncateForFeishu(errorText, 3000)}\n\`\`\``,
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
    throw new Error("Feishu not configured. Run 'cc-ys init' first.");
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
      // Read receipts are not used by cc-ys.
    },
  });

  // Start WebSocket
  wsClient.start({ eventDispatcher });

  return { wsClient, botOpenId: botOpenId ?? "" };
}
