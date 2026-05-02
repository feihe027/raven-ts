import * as Lark from "@larksuiteoapi/node-sdk";
import { Readable } from "stream";
import { FeishuConfig } from "../config.js";
import { detectImageMime } from "./image-mime.js";
import { parsePost } from "./post-parser.js";

export type { FeishuConfig } from "../config.js";

export interface MessageEvent {
  messageId: string;
  chatId: string;
  senderId: string;
  senderName: string;
  content: string;
  msgType: string;
  createTime: number;
  imageKeys?: string[];
  imageDataUris?: string[];
}

export interface MessageSendResult {
  messageId?: string;
}

export interface FeishuCard {
  schema: "2.0";
  config?: Record<string, unknown>;
  header?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

const FEISHU_MAX_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;

export function resolveDomain(domain: "feishu" | "lark"): Lark.Domain {
  return domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

export function createFeishuClient(config: FeishuConfig): Lark.Client {
  return new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(config.domain),
  });
}

export interface FeishuWSLifecycleHandlers {
  onReady?: () => void;
  onError?: (error: Error) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
}

export function createFeishuWSClient(
  config: FeishuConfig,
  lifecycleHandlers: FeishuWSLifecycleHandlers = {}
): Lark.WSClient {
  return new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: resolveDomain(config.domain),
    loggerLevel: Lark.LoggerLevel.info,
    ...lifecycleHandlers,
  });
}

export function createEventDispatcher(config: FeishuConfig): Lark.EventDispatcher {
  return new Lark.EventDispatcher({
    encryptKey: config.encryptKey,
    verificationToken: config.verificationToken,
  });
}

export function isDebugEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.RAVEN_TS_DEBUG_EVENTS === "1" ||
    env.RAVEN_DEBUG_EVENTS === "1" ||
    env.CC_YS_DEBUG_EVENTS === "1"
  );
}

/**
 * Parse message content from Feishu event
 * The SDK passes the event directly as { sender, message }
 */
export function parseMessageContent(event: unknown): MessageEvent | null {
  try {
    if (isDebugEventsEnabled()) {
      console.log("[Debug] Parsing event:", JSON.stringify(event, null, 2));
    }

    // The event from SDK is directly { sender, message }, not nested
    const data = event as {
      sender?: {
        sender_id?: {
          open_id?: string;
          user_id?: string;
          union_id?: string;
        };
        sender_type?: string;
        tenant_key?: string;
      };
      message?: {
        message_id?: string;
        chat_id?: string;
        msg_type?: string;
        message_type?: string;
        content?: string;
        create_time?: string;
        mentions?: Array<{
          key: string;
          id: { open_id?: string };
          name: string;
        }>;
      };
    };

    const message = data?.message;
    const sender = data?.sender;

    if (!message) {
      if (isDebugEventsEnabled()) {
        console.log("[Debug] No message field in event");
      }
      return null;
    }

    // Parse content based on message type
    let content = message.content ?? "";
    let imageKeys: string[] | undefined;
    const msgType = message.msg_type ?? message.message_type ?? "text";

    if (msgType === "text" && content) {
      try {
        const parsed = JSON.parse(content);
        content = parsed.text ?? content;
      } catch {
        // Keep raw content
      }
    } else if (msgType === "image" && content) {
      try {
        const parsed = JSON.parse(content) as { image_key?: unknown };
        if (typeof parsed.image_key === "string" && parsed.image_key) {
          imageKeys = [parsed.image_key];
        }
        content = "[Image]";
      } catch {
        // Keep raw content
      }
    } else if (msgType === "post" && content) {
      try {
        const parsed = parsePost(content);
        content = parsed.text;
        imageKeys = parsed.imageKeys.length > 0 ? parsed.imageKeys : undefined;
      } catch {
        // Keep raw content
      }
    }

    return {
      messageId: message.message_id ?? "",
      chatId: message.chat_id ?? "",
      senderId: sender?.sender_id?.open_id ?? "",
      senderName: "", // Will be fetched separately if needed
      content,
      msgType,
      createTime: message.create_time ? parseInt(message.create_time, 10) : Date.now(),
      imageKeys,
    };
  } catch (err) {
    console.error("Failed to parse Feishu message event:", err);
    return null;
  }
}

export async function loadImageDataUris(
  client: Lark.Client,
  message: MessageEvent
): Promise<string[]> {
  if (!message.imageKeys?.length) {
    return [];
  }

  const buffers = await Promise.all(
    message.imageKeys.map((imageKey) => downloadImage(client, message.messageId, imageKey))
  );
  return buffers.map((buffer) => `data:${detectImageMime(buffer)};base64,${buffer.toString("base64")}`);
}

export async function downloadImage(
  client: Lark.Client,
  messageId: string,
  imageKey: string
): Promise<Buffer> {
  const response = await client.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: imageKey },
    params: { type: "image" },
  });
  const data =
    response && typeof response === "object" && "data" in response
      ? (response as { data?: unknown }).data
      : response;

  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  }
  if (data instanceof Readable) {
    return streamToBuffer(data);
  }
  if (
    data &&
    typeof data === "object" &&
    "getReadableStream" in data &&
    typeof (data as { getReadableStream?: unknown }).getReadableStream === "function"
  ) {
    return streamToBuffer((data as { getReadableStream: () => Readable }).getReadableStream());
  }

  throw new Error(
    `downloadImage: unexpected response type ${
      (data as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof data
    }`
  );
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Send a text message to a chat
 */
export async function sendTextMessage(
  client: Lark.Client,
  chatId: string,
  text: string
): Promise<void> {
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      content: JSON.stringify({ text }),
      msg_type: "text",
    },
  });
}

export async function sendImageMessage(
  client: Lark.Client,
  chatId: string,
  imageKey: string
): Promise<MessageSendResult> {
  const response = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      content: JSON.stringify({ image_key: imageKey }),
      msg_type: "image",
    },
  });

  return { messageId: getResponseMessageId(response) };
}

/**
 * Reply to a message
 */
export async function replyToMessage(
  client: Lark.Client,
  messageId: string,
  text: string
): Promise<MessageSendResult> {
  const response = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify({ text }),
      msg_type: "text",
    },
  });

  return { messageId: getResponseMessageId(response) };
}

export async function replyWithImage(
  client: Lark.Client,
  messageId: string,
  imageKey: string
): Promise<MessageSendResult> {
  const response = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify({ image_key: imageKey }),
      msg_type: "image",
    },
  });

  return { messageId: getResponseMessageId(response) };
}

export async function uploadImage(client: Lark.Client, image: Buffer): Promise<string> {
  if (image.length === 0) {
    throw new Error("Cannot upload an empty image to Feishu");
  }
  if (image.length > FEISHU_MAX_UPLOAD_IMAGE_BYTES) {
    throw new Error(
      `Feishu image upload limit is 10MB; generated image is ${formatBytes(image.length)}`
    );
  }

  const response = await client.im.v1.image.create({
    data: {
      image_type: "message",
      image,
    },
  });

  const imageKey = getResponseImageKey(response);
  if (!imageKey) {
    throw new Error("Feishu image upload returned no image_key");
  }
  return imageKey;
}

/**
 * Send a markdown card message
 */
export async function sendCardMessage(
  client: Lark.Client,
  chatId: string,
  markdown: string,
  title?: string
): Promise<void> {
  const card = {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    header: title
      ? {
          title: { tag: "plain_text", content: title },
          template: "blue",
        }
      : undefined,
    body: {
      elements: [
        {
          tag: "markdown",
          content: markdown,
        },
      ],
    },
  };

  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      content: JSON.stringify(card),
      msg_type: "interactive",
    },
  });
}

/**
 * Reply with a markdown card
 */
export async function replyWithCard(
  client: Lark.Client,
  messageId: string,
  markdown: string,
  title?: string
): Promise<MessageSendResult> {
  return replyWithInteractiveCard(client, messageId, buildMarkdownCard(markdown, title));
}

export async function replyWithInteractiveCard(
  client: Lark.Client,
  messageId: string,
  card: FeishuCard
): Promise<MessageSendResult> {
  const response = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify(card),
      msg_type: "interactive",
    },
  });

  return { messageId: getResponseMessageId(response) };
}

export async function patchInteractiveCard(
  client: Lark.Client,
  messageId: string,
  card: FeishuCard
): Promise<void> {
  const response = await client.im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(card) },
  });

  assertFeishuSuccess(response, `patch card ${messageId}`);
}

export async function convertMessageIdToCardId(
  client: Lark.Client,
  messageId: string
): Promise<string> {
  const response = await client.cardkit.v1.card.idConvert({
    data: { message_id: messageId },
  });

  assertFeishuSuccess(response, `convert message ${messageId} to card id`);

  const cardId = getResponseCardId(response);
  if (!cardId) {
    throw new Error(`Feishu idConvert returned no card_id for message ${messageId}`);
  }
  return cardId;
}

export async function streamCardElementContent(
  client: Lark.Client,
  args: {
    cardId: string;
    elementId: string;
    content: string;
    sequence: number;
  }
): Promise<void> {
  const response = await client.cardkit.v1.cardElement.content({
    path: { card_id: args.cardId, element_id: args.elementId },
    data: {
      content: args.content,
      sequence: args.sequence,
    },
  });

  assertFeishuSuccess(response, `stream card element ${args.cardId}/${args.elementId}`);
}

function buildMarkdownCard(markdown: string, title?: string): FeishuCard {
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    header: title
      ? {
          title: { tag: "plain_text", content: title },
          template: "blue",
        }
      : undefined,
    body: {
      elements: [
        {
          tag: "markdown",
          content: markdown,
        },
      ],
    },
  };
}

function getResponseMessageId(response: unknown): string | undefined {
  const data = getResponseData(response);
  const messageId = data?.message_id;
  return typeof messageId === "string" ? messageId : undefined;
}

function getResponseCardId(response: unknown): string | undefined {
  const data = getResponseData(response);
  const cardId = data?.card_id;
  return typeof cardId === "string" ? cardId : undefined;
}

function getResponseImageKey(response: unknown): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const topLevel = (response as { image_key?: unknown }).image_key;
  if (typeof topLevel === "string") {
    return topLevel;
  }

  const data = getResponseData(response);
  const imageKey = data?.image_key;
  return typeof imageKey === "string" ? imageKey : undefined;
}

function getResponseData(response: unknown): Record<string, unknown> | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const data = (response as { data?: unknown }).data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
}

function assertFeishuSuccess(response: unknown, action: string): void {
  if (!response || typeof response !== "object") {
    return;
  }

  const code = (response as { code?: unknown }).code;
  if (typeof code !== "number" || code === 0) {
    return;
  }

  const msg = (response as { msg?: unknown }).msg;
  throw new Error(`Failed to ${action}: code=${code} msg=${typeof msg === "string" ? msg : ""}`);
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
