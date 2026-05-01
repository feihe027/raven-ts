import { randomUUID } from "crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import {
  patchInteractiveCard,
  replyToMessage,
  replyWithInteractiveCard,
  type FeishuCard,
} from "./client.js";

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
const INPUT_PREVIEW_MAX_LENGTH = 1600;

export type PermissionChoice = "allow" | "deny";

export interface FeishuToolPermissionRequest {
  client: Lark.Client;
  parentMessageId: string;
  ownerOpenId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  signal: AbortSignal;
  title?: string;
  displayName?: string;
  description?: string;
  suggestions?: PermissionUpdate[];
}

export interface FeishuCardActionResult {
  card?: FeishuCard;
}

export interface ResolveToolPermissionResult {
  status: "resolved" | "not_found" | "ambiguous" | "forbidden";
  requestId?: string;
  toolName?: string;
  ownerOpenId?: string;
}

interface PendingPermission {
  requestId: string;
  client: Lark.Client;
  cardMessageId: string;
  parentMessageId: string;
  ownerOpenId: string;
  toolName: string;
  toolUseId: string;
  timeout: NodeJS.Timeout;
  resolve: (result: PermissionResult) => void;
  signal: AbortSignal;
  abortHandler: () => void;
}

const pendingPermissions = new Map<string, PendingPermission>();

export async function requestFeishuToolPermission(
  request: FeishuToolPermissionRequest
): Promise<PermissionResult> {
  console.log(
    `[Permission] Sending Feishu permission card tool=${request.toolName} toolUseId=${request.toolUseId}`
  );

  if (request.signal.aborted) {
    return denyPermission(request.toolUseId, "Permission request cancelled.");
  }

  const requestId = randomUUID();
  const card = buildPermissionCard({
    requestId,
    toolName: request.toolName,
    input: request.input,
    title: request.title,
    displayName: request.displayName,
    description: request.description,
  });

  let sent;
  try {
    sent = await replyWithInteractiveCard(request.client, request.parentMessageId, card);
  } catch (err) {
    console.error("[Permission] Failed to send permission card:", err);
    return denyPermission(request.toolUseId, "Failed to send permission card.");
  }

  if (!sent.messageId) {
    console.error("[Permission] Feishu permission card reply returned no message id");
    return denyPermission(request.toolUseId, "Failed to send permission card.");
  }

  console.log(
    `[Permission] Feishu permission card sent messageId=${sent.messageId} requestId=${requestId}`
  );

  return new Promise<PermissionResult>((resolve) => {
    const abortHandler = (): void => {
      resolvePendingPermission(requestId, "deny", "Permission request cancelled.");
    };
    const timeout = setTimeout(() => {
      autoDenyPermission(requestId);
    }, PERMISSION_TIMEOUT_MS);

    request.signal.addEventListener("abort", abortHandler, { once: true });
    pendingPermissions.set(requestId, {
      requestId,
      client: request.client,
      cardMessageId: sent.messageId!,
      parentMessageId: request.parentMessageId,
      ownerOpenId: request.ownerOpenId,
      toolName: request.toolName,
      toolUseId: request.toolUseId,
      timeout,
      resolve,
      signal: request.signal,
      abortHandler,
    });
  });
}

export async function handleFeishuCardAction(event: unknown): Promise<FeishuCardActionResult> {
  console.log(`[Permission] Card action callback received: ${formatCardActionSummary(event)}`);

  const action = parsePermissionAction(event);
  if (!action) {
    console.warn("[Permission] Ignored card action callback: not a raven-ts permission action");
    return {};
  }

  const pending = pendingPermissions.get(action.requestId);
  if (!pending) {
    console.warn(`[Permission] Permission request not found: requestId=${action.requestId}`);
    return { card: buildPermissionExpiredCard() };
  }

  if (action.senderOpenId !== pending.ownerOpenId) {
    console.warn(
      `[Permission] Permission click rejected: sender=${action.senderOpenId} owner=${pending.ownerOpenId}`
    );
    await replyToMessage(
      pending.client,
      pending.parentMessageId,
      "Only the user who started this run can approve or deny this tool call."
    ).catch((err) => {
      console.error("[Permission] Failed to send forbidden click notice:", err);
    });
    return {};
  }

  console.log(
    `[Permission] Resolving permission requestId=${action.requestId} choice=${action.choice}`
  );
  const result = resolvePendingPermission(action.requestId, action.choice);
  return result ? { card: result.card } : {};
}

export async function resolvePendingToolPermissionByText(args: {
  requestIdOrPrefix: string;
  senderOpenId: string;
  choice: PermissionChoice;
}): Promise<ResolveToolPermissionResult> {
  const requestIdOrPrefix = args.requestIdOrPrefix.trim();
  const pending = findPendingPermission(requestIdOrPrefix);
  if (pending === "ambiguous") {
    return { status: "ambiguous" };
  }
  if (!pending) {
    return { status: "not_found" };
  }

  if (args.senderOpenId !== pending.ownerOpenId) {
    return {
      status: "forbidden",
      requestId: pending.requestId,
      toolName: pending.toolName,
      ownerOpenId: pending.ownerOpenId,
    };
  }

  const result = resolvePendingPermission(pending.requestId, args.choice);
  if (!result) {
    return { status: "not_found" };
  }

  await patchInteractiveCard(
    result.pending.client,
    result.pending.cardMessageId,
    result.card
  ).catch((err) => {
    console.error("[Permission] Failed to patch text-resolved permission card:", err);
  });

  return {
    status: "resolved",
    requestId: result.pending.requestId,
    toolName: result.pending.toolName,
  };
}

export function cancelPendingToolPermissions(reason: string, parentMessageId?: string): void {
  const snapshot = [...pendingPermissions.values()].filter(
    (pending) => !parentMessageId || pending.parentMessageId === parentMessageId
  );
  for (const pending of snapshot) {
    const requestId = pending.requestId;
    const result = resolvePendingPermission(requestId, "deny", reason);
    if (!result) {
      continue;
    }

    void patchInteractiveCard(
      result.pending.client,
      result.pending.cardMessageId,
      buildPermissionResolvedCard(result.pending.toolName, "deny", reason)
    ).catch((err) => {
      console.error("[Permission] Failed to patch cancelled permission card:", err);
    });
  }
}

function autoDenyPermission(requestId: string): void {
  const result = resolvePendingPermission(
    requestId,
    "deny",
    "Permission request timed out."
  );
  if (!result) {
    return;
  }

  void patchInteractiveCard(
    result.pending.client,
    result.pending.cardMessageId,
    buildPermissionTimedOutCard(result.pending.toolName)
  ).catch((err) => {
    console.error("[Permission] Failed to patch timed out permission card:", err);
  });
}

function resolvePendingPermission(
  requestId: string,
  choice: PermissionChoice,
  denyMessage = "User denied the tool call."
): { pending: PendingPermission; card: FeishuCard } | undefined {
  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    return undefined;
  }

  pendingPermissions.delete(requestId);
  clearTimeout(pending.timeout);
  pending.signal.removeEventListener("abort", pending.abortHandler);

  if (choice === "allow") {
    pending.resolve({
      behavior: "allow",
      toolUseID: pending.toolUseId,
      decisionClassification: "user_temporary",
    });
  } else {
    pending.resolve(denyPermission(pending.toolUseId, denyMessage));
  }

  return {
    pending,
    card: buildPermissionResolvedCard(pending.toolName, choice, denyMessage),
  };
}

function findPendingPermission(requestIdOrPrefix: string): PendingPermission | "ambiguous" | undefined {
  if (!requestIdOrPrefix) {
    return undefined;
  }

  const exact = pendingPermissions.get(requestIdOrPrefix);
  if (exact) {
    return exact;
  }

  if (requestIdOrPrefix.length < 8) {
    return undefined;
  }

  const matches = [...pendingPermissions.values()].filter((pending) =>
    pending.requestId.startsWith(requestIdOrPrefix)
  );
  if (matches.length > 1) {
    return "ambiguous";
  }
  return matches[0];
}

function denyPermission(toolUseId: string, message: string): PermissionResult {
  return {
    behavior: "deny",
    message,
    toolUseID: toolUseId,
    decisionClassification: "user_reject",
  };
}

function parsePermissionAction(
  event: unknown
): { senderOpenId: string; requestId: string; choice: PermissionChoice } | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }

  const record = event as Record<string, unknown>;
  const senderOpenId = getSenderOpenId(record);
  const value = parseActionValue(getNested(record, ["action", "value"]));
  if (!senderOpenId || !value) {
    return undefined;
  }

  const action = value;
  if (action.kind !== "tool_permission" && action.kind !== "permission") {
    return undefined;
  }

  const requestId = action.request_id;
  const choice = action.choice;
  if (
    typeof requestId !== "string" ||
    (choice !== "allow" && choice !== "deny")
  ) {
    return undefined;
  }

  return { senderOpenId, requestId, choice };
}

function getSenderOpenId(record: Record<string, unknown>): string {
  const candidates = [
    getNested(record, ["operator", "open_id"]),
    getNested(record, ["operator", "openId"]),
    getNested(record, ["operator", "operator_id", "open_id"]),
    getNested(record, ["operator", "operatorId", "openId"]),
    getNested(record, ["operator", "id", "open_id"]),
    getNested(record, ["operator", "id", "openId"]),
    getNested(record, ["sender", "sender_id", "open_id"]),
    getNested(record, ["sender", "senderId", "openId"]),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }
  return "";
}

function parseActionValue(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== "string" || !value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function getNested(record: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = record;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function formatCardActionSummary(event: unknown): string {
  if (!event || typeof event !== "object") {
    return String(event);
  }

  const record = event as Record<string, unknown>;
  const value = parseActionValue(getNested(record, ["action", "value"]));
  const kind = typeof value?.kind === "string" ? value.kind : "unknown";
  const choice = typeof value?.choice === "string" ? value.choice : "unknown";
  const requestId = typeof value?.request_id === "string" ? value.request_id : "unknown";
  const senderOpenId = getSenderOpenId(record) || "unknown";
  return `sender=${senderOpenId} kind=${kind} choice=${choice} requestId=${requestId}`;
}

function buildPermissionCard(args: {
  requestId: string;
  toolName: string;
  input: unknown;
  title?: string;
  displayName?: string;
  description?: string;
}): FeishuCard {
  const title = args.title || `Claude wants to use ${args.displayName || args.toolName}`;
  const description = args.description || "Approve this tool call to continue.";
  return {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: "plain_text", content: "Tool permission required" },
      template: "yellow",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**${escapeMarkdown(title)}**`,
            "",
            escapeMarkdown(description),
            "",
            `Tool: \`${escapeMarkdown(args.toolName)}\``,
            `Approval ID: \`${shortRequestId(args.requestId)}\``,
          ].join("\n"),
        },
        {
          tag: "markdown",
          content: codeBlock(formatInput(args.input), "json"),
        },
        buttonRow([
          permissionButton("Allow", "allow", args.requestId, "primary"),
          permissionButton("Deny", "deny", args.requestId, "danger"),
        ]),
        {
          tag: "markdown",
          content: `<font color="grey">Only the original requester can approve. If the button shows an error, reply: \`/r allow ${shortRequestId(args.requestId)}\` or \`/r deny ${shortRequestId(args.requestId)}\`. This request auto-denies after 5 minutes.</font>`,
        },
      ],
    },
  };
}

function buildPermissionResolvedCard(
  toolName: string,
  choice: PermissionChoice,
  denyMessage: string
): FeishuCard {
  const label = choice === "allow" ? "Allowed" : `Denied: ${denyMessage}`;
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `${label} · \`${escapeMarkdown(toolName)}\``,
        },
      ],
    },
  };
}

function buildPermissionTimedOutCard(toolName: string): FeishuCard {
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `Timed out · \`${escapeMarkdown(toolName)}\``,
        },
      ],
    },
  };
}

function buildPermissionExpiredCard(): FeishuCard {
  return {
    schema: "2.0",
    body: {
      elements: [
        {
          tag: "markdown",
          content: "This permission request is no longer active.",
        },
      ],
    },
  };
}

function buttonRow(buttons: Record<string, unknown>[]): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "bisect",
    horizontal_spacing: "8px",
    columns: buttons.map((button) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [button],
    })),
  };
}

function permissionButton(
  label: string,
  choice: PermissionChoice,
  requestId: string,
  type: "primary" | "danger"
): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    width: "fill",
    value: { kind: "tool_permission", request_id: requestId, choice },
  };
}

function formatInput(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    json = String(input);
  }

  return truncate(json, INPUT_PREVIEW_MAX_LENGTH);
}

function codeBlock(text: string, language: string): string {
  return `\`\`\`${language}\n${text.replace(/```/g, "``\\`")}\n\`\`\``;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n... (truncated)`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[*_`~[\]]/g, "\\$&");
}

function shortRequestId(requestId: string): string {
  return requestId.slice(0, 8);
}
