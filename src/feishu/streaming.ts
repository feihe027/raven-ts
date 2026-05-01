import * as Lark from "@larksuiteoapi/node-sdk";
import type { ClaudeStreamEvent } from "../claude/executor.js";
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

type StreamAppendMode = "block" | "delta";

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
    return this.enqueueFlush(title, markdown, true);
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
      await this.updateStatus("Claude is thinking...");
      return;
    }

    if (event.type === "tool_use") {
      await this.updateStatus(`Claude is using ${event.name}...`);
      return;
    }

    await this.updateStatus(
      event.isError ? `Claude tool ${event.toolUseId} failed.` : `Claude tool ${event.toolUseId} finished.`
    );
  }
}

function buildAgentStreamCard(
  markdown: string,
  title: string,
  options: { elementId: string; fallbackStatus: string; headerTemplate: string }
): FeishuCard {
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
    header: {
      title: { tag: "plain_text", content: title },
      template: options.headerTemplate,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          element_id: options.elementId,
          content: formatCardMarkdown(markdown, options.fallbackStatus),
        },
      ],
    },
  };
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
