export interface ParsedPost {
  text: string;
  imageKeys: string[];
}

interface PostElement {
  tag?: string;
  text?: string;
  href?: string;
  user_id?: string;
  user_name?: string;
  emoji_type?: string;
  image_key?: string;
  un_escape?: boolean;
}

interface PostLocale {
  title?: string;
  content?: unknown;
}

interface PostEnvelope extends PostLocale {
  zh_cn?: PostLocale;
  en_us?: PostLocale;
}

const ENTITY_MAP: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
};

export function parsePost(rawContent: string): ParsedPost {
  const envelope = JSON.parse(rawContent) as PostEnvelope;
  const locale = pickLocale(envelope);
  if (!Array.isArray(locale.content)) {
    throw new Error("parsePost: content is not an array");
  }

  const imageKeys: string[] = [];
  const paragraphs: string[] = [];
  const title = locale.title?.trim();
  if (title) {
    paragraphs.push(title);
  }

  for (const paragraph of locale.content) {
    if (!Array.isArray(paragraph)) {
      throw new Error("parsePost: paragraph is not an array");
    }

    const rendered = (paragraph as PostElement[])
      .map((element) => renderElement(element, imageKeys))
      .join("");
    if (rendered) {
      paragraphs.push(rendered);
    }
  }

  return {
    text: paragraphs.join("\n\n").trim(),
    imageKeys,
  };
}

function pickLocale(envelope: PostEnvelope): PostLocale {
  if (Array.isArray(envelope.content)) {
    return envelope;
  }
  if (Array.isArray(envelope.zh_cn?.content)) {
    return envelope.zh_cn;
  }
  if (Array.isArray(envelope.en_us?.content)) {
    return envelope.en_us;
  }
  return envelope;
}

function renderElement(element: PostElement, imageKeys: string[]): string {
  switch (element.tag) {
    case "text":
    case "md": {
      const text = element.text ?? "";
      return element.un_escape === true ? unescapeEntities(text) : text;
    }
    case "a":
      return element.href ? `${element.text ?? ""} (${element.href})` : (element.text ?? "");
    case "at":
      return `@${element.user_name ?? element.user_id ?? "user"}`;
    case "emotion":
      return `:${element.emoji_type ?? ""}:`;
    case "img":
    case "media":
      if (element.image_key) {
        imageKeys.push(element.image_key);
      }
      return "";
    default:
      return "";
  }
}

function unescapeEntities(value: string): string {
  return value.replace(/&(?:lt|gt|amp|quot|#39);/g, (match) => ENTITY_MAP[match] ?? match);
}

