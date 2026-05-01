import chalk from "chalk";
import {
  isConfigured,
  getAgentProvider,
  getCodexConfig,
  getFeishuConfig,
  getClaudeConfig,
  getConfigPath,
} from "../config.js";
import { getDaemonStatus } from "../daemon/service.js";
import { checkClaudeSdkAvailable, getAnthropicEnvVarNames } from "../claude/executor.js";
import {
  checkCodexSdkAvailable,
  getCodexRuntimeDescription,
  getOpenAIEnvVarNames,
} from "../codex/executor.js";
import { listSessions } from "../session/store.js";
import { CLAUDE_ENV_PATH } from "../claude/env.js";
import { getLogPath } from "../daemon/paths.js";

export async function statusCommand(): Promise<void> {
  console.log(chalk.cyan("\nraven-ts status\n"));

  // Configuration status
  console.log(chalk.bold("Configuration:"));
  console.log(`  Config file: ${getConfigPath()}`);

  if (isConfigured()) {
    const feishuConfig = getFeishuConfig()!;
    console.log(`  Feishu App ID: ${feishuConfig.appId}`);
    console.log(`  Domain: ${feishuConfig.domain}`);
    console.log(chalk.green("  [OK] Configured"));
  } else {
    console.log(chalk.yellow("  [WARN] Not configured"));
    console.log("    Run 'raven-ts init' to configure");
  }
  console.log();

  console.log(chalk.bold("Agent:"));
  console.log(`  Provider: ${getAgentProvider()}`);
  console.log();

  console.log(chalk.bold("Claude Agent SDK:"));
  const claudeAvailable = await checkClaudeSdkAvailable();
  if (claudeAvailable) {
    console.log(chalk.green("  [OK] Available"));
  } else {
    console.log(chalk.red("  [ERROR] Not found"));
    console.log("    Run npm install in the raven-ts project");
  }
  const envVars = getAnthropicEnvVarNames();
  console.log(`  Current ANTHROPIC_* vars: ${envVars.length ? envVars.join(", ") : "(none)"}`);
  console.log(`  Service env file: ${CLAUDE_ENV_PATH}`);
  console.log();

  console.log(chalk.bold("Codex Agent SDK:"));
  const codexAvailable = await checkCodexSdkAvailable();
  if (codexAvailable) {
    console.log(chalk.green("  [OK] Available"));
  } else {
    console.log(chalk.red("  [ERROR] Not found"));
    console.log("    Run npm install in the raven-ts project");
  }
  const openAIEnvVars = getOpenAIEnvVarNames();
  console.log(`  Current OPENAI_*/CODEX_* vars: ${openAIEnvVars.length ? openAIEnvVars.join(", ") : "(none)"}`);
  console.log();

  // Working directory
  const claudeConfig = getClaudeConfig();
  console.log(chalk.bold("Settings:"));
  console.log(`  Default work dir: ${claudeConfig.defaultWorkDir}`);
  console.log(`  Max turns: ${claudeConfig.maxTurns}`);
  console.log(`  Timeout: ${claudeConfig.timeoutMs}ms`);
  const codexConfig = getCodexConfig();
  console.log(`  Codex runtime: ${getCodexRuntimeDescription()}`);
  console.log(`  Codex model: ${codexConfig.model || "gpt-5.3-codex"}`);
  console.log(`  Codex binary: ${codexConfig.codexBin || "(SDK default)"}`);
  console.log(`  Codex reasoning: ${codexConfig.reasoningEffort}`);
  console.log(`  Codex timeout: ${codexConfig.timeoutMs}ms`);
  console.log();

  // Daemon status
  console.log(chalk.bold("Background Service:"));
  const daemonStatus = await getDaemonStatus();
  console.log(`  Platform: ${daemonStatus.platform}`);

  if (daemonStatus.installed) {
    console.log(chalk.green("  [OK] Installed"));
  } else {
    console.log(chalk.yellow("  [WARN] Not installed"));
  }

  if (daemonStatus.running) {
    console.log(chalk.green("  [OK] Running"));
    console.log(`  Logs: ${getLogPath()}`);
  } else {
    console.log(chalk.dim("  [INFO] Not running"));
  }
  console.log();

  // Sessions
  const sessions = listSessions();
  console.log(chalk.bold("Sessions:"));
  console.log(`  Total: ${sessions.length}`);

  if (sessions.length > 0) {
    console.log("  Recent:");
    sessions.slice(0, 5).forEach((s) => {
      const time = new Date(s.updatedAt).toLocaleString();
      console.log(
        `    - ${s.chatId.slice(0, 20)}... (${s.claudeSessionId || s.codexThreadId ? "agent session" : "no agent session"}, ${time})`
      );
    });
  }
  console.log();
}
