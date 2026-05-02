import type { ImageConfig } from "../config.js";
import { detectImageMime, type SupportedImageMime } from "../feishu/image-mime.js";

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: SupportedImageMime;
  model: string;
  revisedPrompt?: string;
}

type FetchLike = typeof fetch;

interface OpenAIImageResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
  error?: {
    message?: string;
    type?: string;
  };
}

export async function generateOpenAIImage(
  prompt: string,
  config: ImageConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchLike;
  } = {}
): Promise<GeneratedImage> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set. Add it to the raven-ts service environment file and restart.");
  }
  if (!fetchImpl) {
    throw new Error("Global fetch is not available. raven-ts requires Node.js 18 or newer for image generation.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(`${getOpenAIBaseUrl(env)}/images/generations`, {
      method: "POST",
      headers: getOpenAIHeaders(env, apiKey),
      body: JSON.stringify(buildImageRequest(prompt, config)),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as OpenAIImageResponse;
    if (!response.ok) {
      throw new Error(formatOpenAIError(response.status, payload));
    }

    const image = payload.data?.[0];
    if (!image) {
      throw new Error("OpenAI image generation returned no image data.");
    }

    if (image.b64_json) {
      const bytes = Buffer.from(image.b64_json, "base64");
      return {
        bytes,
        mimeType: getConfiguredMimeType(config.outputFormat) ?? detectImageMime(bytes),
        model: config.model,
        revisedPrompt: image.revised_prompt,
      };
    }

    if (image.url) {
      return await downloadGeneratedImage(fetchImpl, image.url, config.model, image.revised_prompt);
    }

    throw new Error("OpenAI image generation returned neither b64_json nor url.");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`OpenAI image generation timed out after ${config.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildImageRequest(prompt: string, config: ImageConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    prompt,
    n: 1,
    size: config.size,
  };

  if (config.quality) {
    body.quality = config.quality;
  }
  if (config.outputFormat) {
    body.output_format = config.outputFormat;
  }

  return body;
}

function getOpenAIBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
}

function getOpenAIHeaders(env: NodeJS.ProcessEnv, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (env.OPENAI_ORG_ID) {
    headers["OpenAI-Organization"] = env.OPENAI_ORG_ID;
  }
  if (env.OPENAI_PROJECT) {
    headers["OpenAI-Project"] = env.OPENAI_PROJECT;
  }
  return headers;
}

async function downloadGeneratedImage(
  fetchImpl: FetchLike,
  url: string,
  model: string,
  revisedPrompt?: string
): Promise<GeneratedImage> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to download generated image: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type");
  return {
    bytes,
    mimeType: parseSupportedMimeType(contentType) ?? detectImageMime(bytes),
    model,
    revisedPrompt,
  };
}

function getConfiguredMimeType(format: ImageConfig["outputFormat"]): SupportedImageMime | undefined {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
  }
}

function parseSupportedMimeType(value: string | null): SupportedImageMime | undefined {
  const mime = value?.split(";")[0]?.trim().toLowerCase();
  if (mime === "image/png" || mime === "image/jpeg" || mime === "image/gif" || mime === "image/webp") {
    return mime;
  }
  return undefined;
}

function formatOpenAIError(status: number, payload: OpenAIImageResponse): string {
  const message = payload.error?.message;
  const type = payload.error?.type;
  return `OpenAI image generation failed: HTTP ${status}${type ? ` ${type}` : ""}${
    message ? `: ${message}` : ""
  }`;
}
