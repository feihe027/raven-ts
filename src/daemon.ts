#!/usr/bin/env node

/**
 * Daemon entry point for raven-ts background service.
 * This is the script that gets run by launchd/systemd.
 */

import chalk from "chalk";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { isConfigured, getAgentProvider, getFeishuConfig, getClaudeConfig } from "./config.js";
import { loadClaudeEnvFile } from "./claude/env.js";
import { getPidPath } from "./daemon/paths.js";
import { startFeishuListener } from "./feishu/handler.js";
import { handleFeishuMessage } from "./feishu/handler.js";

async function main(): Promise<void> {
  exitIfAnotherDaemonIsRunning();
  writeCurrentPidFile();
  loadClaudeEnvFile();

  console.log(chalk.cyan("raven-ts daemon starting..."));
  console.log(`PID: ${process.pid}`);
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log();

  if (!isConfigured()) {
    console.error("Error: Not configured. Run 'raven-ts init' first.");
    process.exit(1);
  }

  const feishuConfig = getFeishuConfig()!;
  const claudeConfig = getClaudeConfig();

  console.log(`Feishu App ID: ${feishuConfig.appId}`);
  console.log(`Domain: ${feishuConfig.domain}`);
  console.log(`Agent: ${getAgentProvider()}`);
  console.log(`Working Dir: ${claudeConfig.defaultWorkDir}`);
  console.log();

  // Handle shutdown signals
  process.on("SIGINT", () => {
    console.log("Received SIGINT, shutting down...");
    removeCurrentPidFile();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down...");
    removeCurrentPidFile();
    process.exit(0);
  });

  process.on("exit", removeCurrentPidFile);

  // Handle uncaught errors
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
  });

  try {
    const { botOpenId } = await startFeishuListener(async (event, context) => {
      await handleFeishuMessage(event, context);
    });

    console.log(`Connected! Bot ID: ${botOpenId}`);
    console.log("raven-ts daemon is running.\n");

    // Keep process alive
    await new Promise(() => {});
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

main();

function exitIfAnotherDaemonIsRunning(): void {
  const pid = readPidFile();
  if (pid && pid !== process.pid && isProcessRunning(pid)) {
    console.error(`raven-ts daemon is already running with PID ${pid}.`);
    process.exit(0);
  }
}

function writeCurrentPidFile(): void {
  writeFileSync(getPidPath(), String(process.pid));
}

function removeCurrentPidFile(): void {
  const pidPath = getPidPath();
  try {
    if (existsSync(pidPath) && readFileSync(pidPath, "utf-8").trim() === String(process.pid)) {
      unlinkSync(pidPath);
    }
  } catch {
    // Ignore shutdown cleanup failures.
  }
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
