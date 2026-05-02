export interface AgentPrompt {
  text: string;
  imageDataUris?: string[];
}

export type AgentImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ParsedImageDataUri {
  mime: AgentImageMime;
  data: string;
}

export function normalizeAgentPrompt(prompt: string | AgentPrompt): AgentPrompt {
  return typeof prompt === "string" ? { text: prompt } : prompt;
}

export function parseImageDataUri(dataUri: string): ParsedImageDataUri | null {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUri);
  if (!match) {
    return null;
  }
  return {
    mime: match[1] as AgentImageMime,
    data: match[2].replace(/\s+/g, ""),
  };
}

export function getImageExtension(mime: AgentImageMime): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/jpeg":
      return "jpg";
  }
}
