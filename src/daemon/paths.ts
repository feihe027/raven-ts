import { copyFileSync, existsSync, mkdirSync } from "fs";
import { homedir, platform, tmpdir } from "os";
import { join } from "path";

export function getRuntimeDir(): string {
  if (platform() === "win32") {
    const baseDir =
      process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), "AppData", "Local");
    return join(baseDir, "raven-ts");
  }

  return join(homedir(), ".config", "raven-ts");
}

export function ensureRuntimeDir(): string {
  const dir = ensureDir(getRuntimeDir());
  migrateLegacyRuntimeFile("claude.env");
  return dir;
}

export function getLogPath(): string {
  if (platform() === "win32") {
    return join(getRuntimeDir(), "raven-ts.log");
  }
  return join(tmpdir(), "raven-ts.log");
}

export function getErrorLogPath(): string {
  if (platform() === "win32") {
    return join(getRuntimeDir(), "raven-ts.error.log");
  }
  return join(tmpdir(), "raven-ts.error.log");
}

export function getPidPath(): string {
  return join(getRuntimeDir(), "raven-ts.pid");
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

function getLegacyRuntimeDirs(): string[] {
  if (platform() === "win32") {
    const baseDir =
      process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), "AppData", "Local");
    return [join(baseDir, "raven"), join(baseDir, "cc-ys")];
  }

  return [join(homedir(), ".config", "raven"), join(homedir(), ".config", "cc-ys")];
}

function migrateLegacyRuntimeFile(fileName: string): void {
  const target = join(getRuntimeDir(), fileName);
  if (existsSync(target)) {
    return;
  }

  for (const legacyDir of getLegacyRuntimeDirs()) {
    const legacy = join(legacyDir, fileName);
    if (existsSync(legacy)) {
      copyFileSync(legacy, target);
      return;
    }
  }
}
