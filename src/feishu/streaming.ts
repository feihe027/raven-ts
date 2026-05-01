import * as Lark from "@larksuiteoapi/node-sdk";
import type { ClaudeStreamEvent } from "../claude/executor.js";
import type { CodexStreamEvent } from "../codex/executor.js";
import {
  convertMessageIdToCardId,
  patchInteractiveCard,
  replyWithInteractiveCard,
  streamCardElementContent,
} from "./client.js";
import type { FeishuCard } from "./client.js";

const DEFAULT_STREAM_ELEMENT_ID = "agent_stream_md";
const STREAM_UPDATE_INTERVAL_MS = 800;
const STREAM_CARD_MAX_LENGTH = 28000;
const STREAM_DETAIL_ENTRY_MAX_LENGTH = 1800;
const STREAM_DETAILS_MAX_LENGTH = 6000;

type StreamAppendMode = "block" | "delta";
type StreamDetailGroup = "thinking" | "tools" | "events";

interface StreamDetailEntry {
  group: StreamDetailGroup;
  title: string;
  content: string;
}

interface StreamDetailPanel {
  title: string;
  markdown: string;
}

export interface AgentStreamingReplyOptions {
  agentName: string;
  elementId?: string;
  initialStatus?: string;
  streamingTitle?: string;
  headerTemplate?: string;
}

export class AgentStreamingReply {
  private messageId: string | undefined;
  private cardId: string | undefined;
  private sequence = 0;
  private text = "";
  private status: string;
  private streamFailed = false;
  private disabled = false;
  private lastFlushAt = 0;
  private flushTimer: NodeJS.Timeout | undefined;
  private pendingFlush:
    | {
        title: string;
        markdown: string;
      }
    | undefined;
  private flushChain: Promise<boolean> = Promise.resolve(false);
  private readonly agentName: string;
  private readonly elementId: string;
  private readonly streamingTitle: string;
  private readonly headerTemplate: string;
  private readonly details = new Map<string, StreamDetailEntry>();
  private detailSequence = 0;

  constructor(
    private readonly client: Lark.Client,
    private readonly parentMessageId: string,
    options: AgentStreamingReplyOptions
  ) {
    this.agentName = options.agentName;
    this.elementId = options.elementId ?? DEFAULT_STREAM_ELEMENT_ID;
    this.status = options.initialStatus ?? `${options.agentName} is working...`;
    this.streamingTitle = options.streamingTitle ?? `${options.agentName} streaming...`;
    this.headerTemplate = options.headerTemplate ?? "blue";
  }

  async start(): Promise<void> {
    await this.flush(this.streamingTitle, this.renderCurrentContent(), false);
  }

  async finish(markdown: string, title: string): Promise<boolean> {
    this.clearTimer();
    if (!this.messageId && this.disabled) {
      return false;
    }
    return this.enqueueFlush("", formatFinalMarkdown(markdown, title), true);
  }

  async appendText(chunk: string, mode: StreamAppendMode = "block"): Promise<void> {
    if (!chunk) {
      return;
    }

    if (mode === "delta") {
      this.text += chunk;
    } else {
      this.text = this.text ? `${this.text}\n\n${chunk}` : chunk;
    }

    await this.flushThrottled(this.streamingTitle, this.renderCurrentContent());
  }

  async updateStatus(status: string): Promise<void> {
    this.status = status;
    await this.flushThrottled(this.streamingTitle, this.renderCurrentContent());
  }

  addDetail(entry: {
    group: StreamDetailGroup;
    title: string;
    content: string;
    key?: string;
  }): void {
    const content = entry.content.trim();
    if (!content) {
      return;
    }

    const key = entry.key ?? `${entry.group}:${++this.detailSequence}`;
    this.details.set(key, {
      group: entry.group,
      title: entry.title,
      content: truncateForFeishu(content, STREAM_DETAIL_ENTRY_MAX_LENGTH),
    });
  }

  private renderCurrentContent(): string {
    return this.text || `_${this.status}_`;
  }

  private async flushThrottled(title: string, markdown: string): Promise<void> {
    if (!this.messageId) {
      await this.flush(title, markdown, false);
      return;
    }

    const elapsed = Date.now() - this.lastFlushAt;
    if (elapsed >= STREAM_UPDATE_INTERVAL_MS) {
      await this.flush(title, markdown, false);
      return;
    }

    this.scheduleFlush(title, markdown, STREAM_UPDATE_INTERVAL_MS - elapsed);
  }

  private scheduleFlush(title: string, markdown: string, delay: number): void {
    this.pendingFlush = { title, markdown };
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const pending = this.pendingFlush;
      this.pendingFlush = undefined;
      if (pending) {
        void this.flush(pending.title, pending.markdown, false);
      }
    }, delay);
  }

  private async flush(title: string, markdown: string, final: boolean): Promise<boolean> {
    return this.enqueueFlush(title, markdown, final);
  }

  private enqueueFlush(title: string, markdown: string, final: boolean): Promise<boolean> {
    const previous = this.flushChain.catch(() => false);
    const next = previous.then(() => this.flushNow(title, markdown, final));
    this.flushChain = next.catch((err) => {
      console.error(`[Stream] Failed to update ${this.agentName} streaming card:`, err);
      return false;
    });
    return this.flushChain;
  }

  private async flushNow(title: string, markdown: string, final: boolean): Promise<boolean> {
    if (this.disabled) {
      return false;
    }

    const card = buildAgentStreamCard(markdown, title, {
      elementId: this.elementId,
      fallbackStatus: this.status,
      headerTemplate: this.headerTemplate,
      details: final ? this.renderDetailPanels() : [],
    });
    if (!this.messageId) {
      const result = await replyWithInteractiveCard(this.client, this.parentMessageId, card);
      if (!result.messageId) {
        this.disabled = true;
        return false;
      }

      this.messageId = result.messageId;
      try {
        this.cardId = await convertMessageIdToCardId(this.client, result.messageId);
      } catch (err) {
        console.error("[Stream] Failed to enable CardKit streaming:", err);
      }
      this.lastFlushAt = Date.now();
      return true;
    }

    if (!final && this.cardId && !this.streamFailed) {
      this.sequence += 1;
      try {
        await streamCardElementContent(this.client, {
          cardId: this.cardId,
          elementId: this.elementId,
          content: formatCardMarkdown(markdown, this.status),
          sequence: this.sequence,
        });
        this.lastFlushAt = Date.now();
        return true;
      } catch (err) {
        this.streamFailed = true;
        console.error("[Stream] CardKit streaming failed; falling back to patch:", err);
      }
    }

    await patchInteractiveCard(this.client, this.messageId, card);
    this.lastFlushAt = Date.now();
    return true;
  }

  private clearTimer(): void {
    if (!this.flushTimer) {
      return;
    }

    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pendingFlush = undefined;
  }

  private renderDetailPanels(): StreamDetailPanel[] {
    if (this.details.size === 0) {
      return [];
    }

    const groups: Array<{ group: StreamDetailGroup; title: string }> = [
      { group: "thinking", title: "Reasoning / thinking" },
      { group: "tools", title: "Tool calls" },
      { group: "events", title: "Intermediate events" },
    ];
    const panels: StreamDetailPanel[] = [];
    let remaining = STREAM_DETAILS_MAX_LENGTH;

    for (const { group, title } of groups) {
      if (remaining <= 0) {
        break;
      }

      const entries = [...this.details.values()].filter((entry) => entry.group === group);
      if (entries.length === 0) {
        continue;
      }

      const content = entries
        .map((entry, index) => formatDetailEntry(index + 1, entry))
        .join("\n\n---\n\n");
      const markdown = truncateForFeishu(content, remaining);
      panels.push({ title: `${title} (${entries.length})`, markdown });
      remaining -= markdown.length;
    }

    return panels;
  }
}

export class ClaudeStreamingReply extends AgentStreamingReply {
  constructor(client: Lark.Client, parentMessageId: string) {
    super(client, parentMessageId, {
      agentName: "Claude",
      elementId: "claude_stream_md",
      initialStatus: "Claude is working...",
      streamingTitle: "Claude streaming...",
    });
  }

  async handleEvent(event: ClaudeStreamEvent): Promise<void> {
    if (event.type === "assistant_text") {
      await this.appendText(event.text);
      return;
    }

    if (event.type === "thinking") {
      this.addDetail({
        group: "thinking",
        title: "Claude thinking",
        content: event.text,
      });
      await this.updateStatus("Claude is thinking...");
      return;
    }

    if (event.type === "tool_use") {
      this.addDetail({
        group: "tools",
        key: `claude-tool:${event.id}`,
        title: `Claude tool: ${event.name}`,
        content: [`Input:`, codeBlock(formatUnknown(event.input), "json")].join("\n\n"),
      });
      await this.updateStatus(`Claude is using ${event.name}...`);
      return;
    }

    this.addDetail({
      group: "tools",
      key: `claude-tool-result:${event.toolUseId}`,
      title: `Claude tool result: ${event.toolUseId || "unknown"}`,
      content: [
        `Status: ${event.isError ? "failed" : "completed"}`,
        event.text ? codeBlock(event.text) : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    await this.updateStatus(
      event.isError ? `Claude tool ${event.toolUseId} failed.` : `Claude tool ${event.toolUseId} finished.`
    );
  }
}

export class CodexStreamingReply extends AgentStreamingReply {
  constructor(client: Lark.Client, parentMessageId: string) {
    super(client, parentMessageId, {
      agentName: "Codex",
      elementId: "codex_stream_md",
      initialStatus: "Codex is working...",
      streamingTitle: "Codex streaming...",
    });
  }

  async handleEvent(event: CodexStreamEvent): Promise<void> {
    if (event.type === "reasoning") {
      this.addDetail({
        group: "thinking",
        key: `codex-reasoning:${event.id}`,
        title: "Codex reasoning",
        content: event.text,
      });
      await this.updateStatus("Codex is reasoning...");
      return;
    }

    if (event.type === "command_execution") {
      this.addDetail({
        group: "tools",
        key: `codex-command:${event.id}`,
        title: `Command: ${event.status}`,
        content: formatCodexCommandDetail(event),
      });
      await this.updateStatus(`Codex command ${event.status}...`);
      return;
    }

    if (event.type === "mcp_tool_call") {
      this.addDetail({
        group: "tools",
        key: `codex-mcp:${event.id}`,
        title: `MCP tool: ${event.server}.${event.tool}`,
        content: formatCodexMcpToolDetail(event),
      });
      await this.updateStatus(`Codex tool ${event.tool} ${event.status}...`);
      return;
    }

    if (event.type === "web_search") {
      this.addDetail({
        group: "tools",
        key: `codex-web-search:${event.id}`,
        title: "Web search",
        content: event.query,
      });
      await this.updateStatus("Codex is searching the web...");
      return;
    }

    if (event.type === "file_change") {
      this.addDetail({
        group: "events",
        key: `codex-file-change:${event.id}`,
        title: `File changes: ${event.status}`,
        content: event.changes.map((change) => `- ${change.kind}: \`${change.path}\``).join("\n"),
      });
      await this.updateStatus(`Codex file changes ${event.status}...`);
      return;
    }

    if (event.type === "todo_list") {
      this.addDetail({
        group: "events",
        key: `codex-todo:${event.id}`,
        title: "Codex plan",
        content: event.items
          .map((item) => `- [${item.completed ? "x" : " "}] ${item.text}`)
          .join("\n"),
      });
      await this.updateStatus("Codex updated its plan...");
      return;
    }

    this.addDetail({
      group: "events",
      key: `codex-error:${event.id}`,
      title: "Codex stream error",
      content: event.message,
    });
    await this.updateStatus("Codex reported an error...");
  }
}

function buildAgentStreamCard(
  markdown: string,
  title: string,
  options: {
    elementId: string;
    fallbackStatus: string;
    headerTemplate: string;
    details: StreamDetailPanel[];
  }
): FeishuCard {
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      element_id: options.elementId,
      content: formatCardMarkdown(markdown, options.fallbackStatus),
    },
  ];

  for (const panel of options.details) {
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      background_color: "grey-100",
      header: buildCollapsiblePanelHeader(panel.title),
      elements: [
        {
          tag: "markdown",
          content: formatCardMarkdown(panel.markdown, panel.title),
        },
      ],
    });
  }

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: 35 },
        print_step: { default: 3 },
        print_strategy: "fast",
      },
    },
    header: title
      ? {
          title: { tag: "plain_text", content: title },
          template: options.headerTemplate,
        }
      : undefined,
    body: {
      elements,
    },
  };
}

function formatFinalMarkdown(markdown: string, status: string): string {
  const trimmedMarkdown = markdown.trim();
  const trimmedStatus = status.trim();
  if (!trimmedStatus) {
    return trimmedMarkdown;
  }
  return trimmedMarkdown ? `${trimmedStatus}\n\n${trimmedMarkdown}` : trimmedStatus;
}

function formatCardMarkdown(markdown: string, fallbackStatus: string): string {
  const content = markdown.trim() || `_${fallbackStatus}_`;
  return truncateForFeishu(sanitizeForFeishuMarkdown(content), STREAM_CARD_MAX_LENGTH);
}

function sanitizeForFeishuMarkdown(text: string): string {
  return text.replace(/(?<!\\)!(\[[^\]]*\]\([^)\s]+\))/g, "$1");
}

function truncateForFeishu(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n\n... (truncated)`;
}

function buildCollapsiblePanelHeader(title: string): Record<string, unknown> {
  return {
    title: { tag: "plain_text", content: title },
    vertical_align: "center",
    padding: "4px 0px 4px 8px",
    icon: {
      tag: "standard_icon",
      token: "down-small-ccm_outlined",
      size: "16px 16px",
    },
    icon_position: "right",
    icon_expanded_angle: -180,
  };
}

function formatDetailEntry(index: number, entry: StreamDetailEntry): string {
  return `**${index}. ${entry.title}**\n\n${entry.content}`;
}

function formatCodexCommandDetail(event: Extract<CodexStreamEvent, { type: "command_execution" }>): string {
  const parts = [`Command:`, codeBlock(event.command)];

  if (event.exitCode !== undefined) {
    parts.push(`Exit code: \`${event.exitCode}\``);
  }

  if (event.output) {
    parts.push(`Output:`, codeBlock(event.output));
  }

  return parts.join("\n\n");
}

function formatCodexMcpToolDetail(event: Extract<CodexStreamEvent, { type: "mcp_tool_call" }>): string {
  const parts = [
    `Status: ${event.status}`,
    `Arguments:`,
    codeBlock(formatUnknown(event.arguments), "json"),
  ];

  if (event.result !== undefined) {
    parts.push(`Result:`, codeBlock(formatUnknown(event.result), "json"));
  }

  if (event.error) {
    parts.push(`Error:`, codeBlock(event.error.message));
  }

  return parts.join("\n\n");
}

function formatUnknown(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function codeBlock(text: string, language = "text"): string {
  return `\`\`\`${language}\n${text.replace(/```/g, "``\\`")}\n\`\`\``;
}
