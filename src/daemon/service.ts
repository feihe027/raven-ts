import { homedir, platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
} from "fs";
import { CLAUDE_ENV_PATH, ensureClaudeEnvFile } from "../claude/env.js";
import { ensureRuntimeDir, getErrorLogPath, getLogPath, getPidPath, getWindowsMarkerPath } from "./paths.js";

// ES Module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isMacOS = platform() === "darwin";
const isLinux = platform() === "linux";
const isWindows = platform() === "win32";

const LAUNCH_AGENT_NAME = "com.raven-ts";
const SYSTEMD_SERVICE_NAME = "raven-ts";

function getLaunchAgentPath(): string {
  const dir = join(homedir(), "Library", "LaunchAgents");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, `${LAUNCH_AGENT_NAME}.plist`);
}

function getSystemdServicePath(): string {
  const dir = join(homedir(), ".config", "systemd", "user");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, `${SYSTEMD_SERVICE_NAME}.service`);
}

function getNodePath(): string {
  return process.execPath;
}

function getDaemonScriptPath(): string {
  // __dirname is dist/daemon/ (this file is dist/daemon/service.js)
  // daemon.js is in dist/daemon.js
  return join(__dirname, "..", "daemon.js");
}

function getServicePathValue(): string {
  return `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${join(homedir(), ".local", "bin")}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function quoteSystemdArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Generate macOS LaunchAgent plist content
 */
function generateLaunchAgentPlist(): string {
  const nodePath = getNodePath();
  const daemonPath = getDaemonScriptPath();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(LAUNCH_AGENT_NAME)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(nodePath)}</string>
        <string>${escapeXml(daemonPath)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(getLogPath())}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(getErrorLogPath())}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(getServicePathValue())}</string>
    </dict>
</dict>
</plist>`;
}

/**
 * Generate Linux systemd service content
 */
function generateSystemdService(): string {
  const nodePath = getNodePath();
  const daemonPath = getDaemonScriptPath();

  return `[Unit]
Description=raven-ts - Feishu control service for agent SDKs
After=network.target

[Service]
Type=simple
ExecStart=${quoteSystemdArg(nodePath)} ${quoteSystemdArg(daemonPath)}
Restart=always
RestartSec=10
StandardOutput=file:${getLogPath()}
StandardError=file:${getErrorLogPath()}
Environment=${quoteSystemdArg(`PATH=${getServicePathValue()}`)}
EnvironmentFile=${quoteSystemdArg(CLAUDE_ENV_PATH)}

[Install]
WantedBy=default.target
`;
}

export interface DaemonStatus {
  installed: boolean;
  running: boolean;
  platform: "macos" | "linux" | "windows" | "unsupported";
}

/**
 * Check if daemon is installed
 */
export function isDaemonInstalled(): boolean {
  if (isMacOS) {
    return existsSync(getLaunchAgentPath());
  }
  if (isLinux) {
    return existsSync(getSystemdServicePath());
  }
  if (isWindows) {
    return existsSync(getWindowsMarkerPath());
  }
  return false;
}

/**
 * Install daemon service
 */
export async function installDaemon(): Promise<{ success: boolean; message: string }> {
  if (isMacOS) {
    const plistPath = getLaunchAgentPath();
    const plistContent = generateLaunchAgentPlist();

    writeFileSync(plistPath, plistContent);

    return {
      success: true,
      message: `LaunchAgent installed at ${plistPath}`,
    };
  }

  if (isLinux) {
    const servicePath = getSystemdServicePath();
    const serviceContent = generateSystemdService();

    ensureClaudeEnvFile();
    writeFileSync(servicePath, serviceContent);

    return {
      success: true,
      message: `Systemd service installed at ${servicePath}. Run 'systemctl --user daemon-reload' to reload.`,
    };
  }

  if (isWindows) {
    ensureRuntimeDir();
    ensureClaudeEnvFile();
    writeFileSync(
      getWindowsMarkerPath(),
      JSON.stringify(
        {
          node: getNodePath(),
          daemon: getDaemonScriptPath(),
          log: getLogPath(),
          errorLog: getErrorLogPath(),
          envFile: CLAUDE_ENV_PATH,
        },
        null,
        2
      )
    );

    return {
      success: true,
      message: `Windows background runner configured at ${getWindowsMarkerPath()}`,
    };
  }

  return {
    success: false,
    message: "Unsupported platform. macOS, Linux, and Windows are supported.",
  };
}

/**
 * Uninstall daemon service
 */
export async function uninstallDaemon(): Promise<{ success: boolean; message: string }> {
  if (isMacOS) {
    const plistPath = getLaunchAgentPath();

    if (existsSync(plistPath)) {
      // First unload if running
      try {
        const { execFileSync } = await import("child_process");
        execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}`, LAUNCH_AGENT_NAME], {
          stdio: "ignore",
        });
      } catch {
        // Ignore errors if not loaded
      }

      unlinkSync(plistPath);
    }

    return {
      success: true,
      message: "LaunchAgent uninstalled",
    };
  }

  if (isLinux) {
    const servicePath = getSystemdServicePath();

    if (existsSync(servicePath)) {
      unlinkSync(servicePath);
    }

    return {
      success: true,
      message: "Systemd service uninstalled",
    };
  }

  if (isWindows) {
    await stopDaemon();
    const markerPath = getWindowsMarkerPath();
    const pidPath = getPidPath();

    tryRemoveFile(markerPath);
    tryRemoveFile(pidPath);

    return {
      success: true,
      message: "Windows background runner uninstalled",
    };
  }

  return {
    success: false,
    message: "Unsupported platform",
  };
}

/**
 * Start daemon service
 */
export async function startDaemon(): Promise<{ success: boolean; message: string }> {
  if (!isDaemonInstalled()) {
    await installDaemon();
  }

  if (isMacOS) {
    const { execFileSync } = await import("child_process");
    const plistPath = getLaunchAgentPath();
    const uid = process.getuid?.() ?? "";

    // First try to bootout in case service is in weird state
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}`, LAUNCH_AGENT_NAME], {
        stdio: "ignore",
      });
    } catch {
      // Ignore if not loaded
    }

    // Also try remove for cached entries with SIGKILL status
    try {
      execFileSync("launchctl", ["remove", LAUNCH_AGENT_NAME], {
        stdio: "ignore",
      });
    } catch {
      // Ignore if not present
    }

    // Wait a moment for cleanup
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], {
        stdio: "pipe",
      });

      return {
        success: true,
        message: `Daemon started. Logs: ${getLogPath()}`,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to start: ${err}`,
      };
    }
  }

  if (isLinux) {
    const { execFileSync } = await import("child_process");

    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
      execFileSync("systemctl", ["--user", "start", SYSTEMD_SERVICE_NAME], { stdio: "pipe" });
      execFileSync("systemctl", ["--user", "enable", SYSTEMD_SERVICE_NAME], { stdio: "pipe" });

      return {
        success: true,
        message: `Daemon started. Logs: ${getLogPath()}`,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to start: ${err}`,
      };
    }
  }

  if (isWindows) {
    ensureRuntimeDir();
    const currentPid = readPidFile();
    if (currentPid && isProcessRunning(currentPid)) {
      return {
        success: true,
        message: `Daemon already running. Logs: ${getLogPath()}`,
      };
    }

    const { spawn } = await import("child_process");
    const outFd = openSync(getLogPath(), "a");
    const errFd = openSync(getErrorLogPath(), "a");

    try {
      const child = spawn(getNodePath(), [getDaemonScriptPath()], {
        detached: true,
        stdio: ["ignore", outFd, errFd],
        windowsHide: true,
        env: { ...process.env, ...readClaudeEnvFile() },
      });

      child.unref();
      writeFileSync(getPidPath(), String(child.pid));

      return {
        success: true,
        message: `Daemon started. Logs: ${getLogPath()}`,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to start: ${err}`,
      };
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }
  }

  return {
    success: false,
    message: "Unsupported platform",
  };
}

/**
 * Stop daemon service
 */
export async function stopDaemon(): Promise<{ success: boolean; message: string }> {
  if (isMacOS) {
    const { execFileSync } = await import("child_process");

    // Step 1: Kill daemon processes first (while launchd is still managing)
    try {
      execFileSync("pkill", ["-9", "-f", "node.*raven-ts.*daemon.js"], { stdio: "ignore" });
    } catch {
      // Ignore if no process to kill
    }

    // Step 2: Wait for processes to terminate
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Step 3: Bootout from launchd to stop managing
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}`, LAUNCH_AGENT_NAME], {
        stdio: "ignore",
      });
    } catch {
      // Ignore if not loaded
    }

    // Step 3.5: Also remove cached entry (for SIGKILL'd services)
    try {
      execFileSync("launchctl", ["remove", LAUNCH_AGENT_NAME], { stdio: "ignore" });
    } catch {
      // Ignore if not present
    }

    // Step 4: Verify process is stopped
    await new Promise((resolve) => setTimeout(resolve, 500));

    let stillRunning = false;
    try {
      const result = execFileSync("pgrep", ["-f", "node.*raven-ts.*daemon.js"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe"],
      });
      stillRunning = result.toString().trim().length > 0;
    } catch {
      // pgrep returns non-zero when no match
      stillRunning = false;
    }

    if (stillRunning) {
      // Force kill any remaining
      try {
        execFileSync("pkill", ["-9", "-f", "node.*raven-ts.*daemon.js"], { stdio: "ignore" });
      } catch {
        // Ignore
      }
    }

    return {
      success: true,
      message: "Daemon stopped",
    };
  }

  if (isLinux) {
    const { execFileSync } = await import("child_process");

    try {
      execFileSync("systemctl", ["--user", "stop", SYSTEMD_SERVICE_NAME], { stdio: "pipe" });
    } catch {
      // Ignore errors
    }

    return {
      success: true,
      message: "Daemon stopped",
    };
  }

  if (isWindows) {
    const pid = readPidFile();
    let terminated = false;
    let failureReason = "";

    if (pid && isProcessRunning(pid)) {
      const result = await terminateWindowsProcess(pid);
      terminated = result.stopped;
      failureReason = result.detail ?? "";
    } else {
      terminated = true;
    }

    const pidPath = getPidPath();
    const pidFileRemoved = tryRemoveFile(pidPath);
    const stillRunning = pid !== undefined && isProcessRunning(pid);

    if (stillRunning) {
      const detail = failureReason ? ` ${failureReason}` : "";
      return {
        success: false,
        message: `Failed to stop daemon (PID ${pid}).${detail}`,
      };
    }

    if (!pidFileRemoved && existsSync(pidPath)) {
      return {
        success: true,
        message: `Daemon stopped, but the PID file could not be removed: ${pidPath}`,
      };
    }

    return {
      success: true,
      message: terminated ? "Daemon stopped" : "Daemon already stopped",
    };
  }

  return {
    success: false,
    message: "Unsupported platform",
  };
}

/**
 * Get daemon status
 */
export async function getDaemonStatus(): Promise<DaemonStatus> {
  const platformName = isMacOS ? "macos" : isLinux ? "linux" : isWindows ? "windows" : "unsupported";

  if (!isMacOS && !isLinux && !isWindows) {
    return {
      installed: false,
      running: false,
      platform: platformName,
    };
  }

  const installed = isDaemonInstalled();

  let running = false;

  if (isMacOS && installed) {
    try {
      const { execFileSync } = await import("child_process");
      const result = execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? ""}/${LAUNCH_AGENT_NAME}`], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      running = result.includes("state = running");
    } catch {
      running = false;
    }
  }

  if (isLinux && installed) {
    try {
      const { execFileSync } = await import("child_process");
      const result = execFileSync("systemctl", ["--user", "is-active", SYSTEMD_SERVICE_NAME], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      running = result.trim() === "active";
    } catch {
      running = false;
    }
  }

  if (isWindows && installed) {
    const pid = readPidFile();
    running = pid !== undefined && isProcessRunning(pid);
  }

  return {
    installed,
    running,
    platform: platformName,
  };
}

function readPidFile(): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(getPidPath(), "utf-8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function terminateWindowsProcess(pid: number): Promise<{ stopped: boolean; detail?: string }> {
  try {
    process.kill(pid);
  } catch (err) {
    if (!isPermissionError(err)) {
      return {
        stopped: false,
        detail: `process.kill failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  await delay(500);
  if (!isProcessRunning(pid)) {
    return { stopped: true };
  }

  try {
    const { execFileSync } = await import("child_process");
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (err) {
    await delay(500);
    if (!isProcessRunning(pid)) {
      return { stopped: true };
    }

    return {
      stopped: false,
      detail: `taskkill failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await delay(500);
  return isProcessRunning(pid)
    ? { stopped: false, detail: "process is still running after taskkill" }
    : { stopped: true };
}

function tryRemoveFile(path: string): boolean {
  if (!existsSync(path)) {
    return true;
  }

  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function isPermissionError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "code" in err &&
      ((err as { code?: unknown }).code === "EPERM" || (err as { code?: unknown }).code === "EACCES")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readClaudeEnvFile(): NodeJS.ProcessEnv {
  if (!existsSync(CLAUDE_ENV_PATH)) {
    return {};
  }

  const env: NodeJS.ProcessEnv = {};
  for (const line of readFileSync(CLAUDE_ENV_PATH, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex);
    env[key] = unquoteEnvValue(trimmed.slice(equalsIndex + 1));
  }

  return env;
}

function unquoteEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}
