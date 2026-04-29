import { existsSync, mkdirSync } from "fs";
import { homedir, platform, tmpdir } from "os";
import { join } from "path";

export function getRuntimeDir(): string {
  if (platform() === "win32") {
    const baseDir =
      process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), "AppData", "Local");
    return join(baseDir, "cc-ys");
  }

  return join(homedir(), ".config", "cc-ys");
}

export function ensureRuntimeDir(): string {
  return ensureDir(getRuntimeDir());
}

export function getLogPath(): string {
  if (platform() === "win32") {
    return join(getRuntimeDir(), "cc-ys.log");
  }
  return join(tmpdir(), "cc-ys.log");
}

export function getErrorLogPath(): string {
  if (platform() === "win32") {
    return join(getRuntimeDir(), "cc-ys.error.log");
  }
  return join(tmpdir(), "cc-ys.error.log");
}

export function getPidPath(): string {
  return join(getRuntimeDir(), "cc-ys.pid");
}

export function getWindowsMarkerPath(): string {
  return join(getRuntimeDir(), "service.json");
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
