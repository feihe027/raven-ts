import { join } from "path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  copyFileSync,
} from "fs";
import { homedir } from "os";
import { v4 as uuidv4 } from "uuid";

export interface Session {
  id: string;
  chatId: string;
  workDir: string;
  claudeSessionId?: string;
  codexThreadId?: string;
  createdAt: number;
  updatedAt: number;
  lastPromptAt?: number;
  lastResultAt?: number;
}

const SESSIONS_DIR = join(homedir(), ".raven-ts", "sessions");
const LEGACY_SESSIONS_DIRS = [
  join(homedir(), ".raven", "sessions"),
  join(homedir(), ".cc-ys", "sessions"),
];

function ensureSessionsDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
  migrateLegacySessions();
}

function migrateLegacySessions(): void {
  const hasRavenSessions = readdirSync(SESSIONS_DIR).some((file) => file.endsWith(".json"));
  if (hasRavenSessions) {
    return;
  }

  for (const legacyDir of LEGACY_SESSIONS_DIRS) {
    if (!existsSync(legacyDir)) {
      continue;
    }
    for (const file of readdirSync(legacyDir)) {
      if (file.endsWith(".json")) {
        copyFileSync(join(legacyDir, file), join(SESSIONS_DIR, file));
      }
    }
    return;
  }
}

function getSessionPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.json`);
}

function getChatIndexSessionPath(chatId: string): string {
  const safeId = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(SESSIONS_DIR, `${safeId}.json`);
}

function normalizeSession(value: unknown): Session | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Partial<Session> & { messages?: unknown[] };
  if (!raw.chatId || !raw.workDir) {
    return null;
  }

  return {
    id: raw.id ?? uuidv4(),
    chatId: raw.chatId,
    workDir: raw.workDir,
    claudeSessionId: raw.claudeSessionId,
    codexThreadId: raw.codexThreadId,
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now(),
    lastPromptAt: raw.lastPromptAt,
    lastResultAt: raw.lastResultAt,
  };
}

export function createSession(chatId: string, workDir: string): Session {
  ensureSessionsDir();

  const session: Session = {
    id: uuidv4(),
    chatId,
    workDir,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  saveSession(session);
  return session;
}

export function getOrCreateSession(chatId: string, workDir?: string): Session {
  const existing = getSessionByChatId(chatId);
  if (existing) {
    return existing;
  }
  return createSession(chatId, workDir || homedir());
}

export function getSession(sessionId: string): Session | null {
  ensureSessionsDir();

  const path = getSessionPath(sessionId);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const data = readFileSync(path, "utf-8");
    return normalizeSession(JSON.parse(data));
  } catch {
    return null;
  }
}

export function getSessionByChatId(chatId: string): Session | null {
  ensureSessionsDir();

  const path = getChatIndexSessionPath(chatId);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const data = readFileSync(path, "utf-8");
    return normalizeSession(JSON.parse(data));
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  ensureSessionsDir();

  session.updatedAt = Date.now();

  const sessionPath = getSessionPath(session.id);
  writeFileSync(sessionPath, JSON.stringify(session, null, 2));

  const chatPath = getChatIndexSessionPath(session.chatId);
  writeFileSync(chatPath, JSON.stringify(session, null, 2));
}

export function markPromptStarted(session: Session): void {
  session.lastPromptAt = Date.now();
  saveSession(session);
}

export function markPromptFinished(session: Session): void {
  session.lastResultAt = Date.now();
  saveSession(session);
}

export function setClaudeSessionId(session: Session, claudeSessionId: string): void {
  session.claudeSessionId = claudeSessionId;
  saveSession(session);
}

export function setCodexThreadId(session: Session, codexThreadId: string): void {
  session.codexThreadId = codexThreadId;
  saveSession(session);
}

export function clearClaudeSessionId(session: Session): void {
  delete session.claudeSessionId;
  saveSession(session);
}

export function clearCodexThreadId(session: Session): void {
  delete session.codexThreadId;
  saveSession(session);
}

export function clearProviderSessions(provider: "claude" | "codex"): number {
  const sessions = listSessions();
  let cleared = 0;

  for (const session of sessions) {
    if (provider === "codex" && session.claudeSessionId) {
      delete session.claudeSessionId;
      saveSession(session);
      cleared++;
    }
    if (provider === "claude" && session.codexThreadId) {
      delete session.codexThreadId;
      saveSession(session);
      cleared++;
    }
  }

  return cleared;
}

export function clearClaudeSession(session: Session): void {
  delete session.claudeSessionId;
  delete session.codexThreadId;
  delete session.lastPromptAt;
  delete session.lastResultAt;
  saveSession(session);
}

export function clearSession(sessionId: string): void {
  ensureSessionsDir();

  const session = getSession(sessionId);
  if (session) {
    const sessionPath = getSessionPath(sessionId);
    const chatPath = getChatIndexSessionPath(session.chatId);

    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
    if (existsSync(chatPath)) {
      unlinkSync(chatPath);
    }
  }
}

export function clearAllSessions(): void {
  ensureSessionsDir();

  const files = readdirSync(SESSIONS_DIR);
  for (const file of files) {
    if (file.endsWith(".json")) {
      unlinkSync(join(SESSIONS_DIR, file));
    }
  }
}

export function listSessions(): Session[] {
  ensureSessionsDir();

  const files = readdirSync(SESSIONS_DIR);
  const sessions: Session[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const data = readFileSync(join(SESSIONS_DIR, file), "utf-8");
      const session = normalizeSession(JSON.parse(data));
      if (session && !seen.has(session.id)) {
        seen.add(session.id);
        sessions.push(session);
      }
    } catch {
      // Skip invalid files.
    }
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function setWorkDir(session: Session, workDir: string): void {
  session.workDir = workDir;
  saveSession(session);
}
