import chalk from "chalk";
import { isConfigured, getFeishuConfig, getClaudeConfig, getConfigPath } from "../config.js";
import { getDaemonStatus } from "../daemon/service.js";
import { checkClaudeSdkAvailable, getAnthropicEnvVarNames } from "../claude/executor.js";
import { listSessions } from "../session/store.js";
import { CLAUDE_ENV_PATH } from "../claude/env.js";

export async function statusCommand(): Promise<void> {
  console.log(chalk.cyan("\ncc-ys status\n"));

  // Configuration status
  console.log(chalk.bold("Configuration:"));
  console.log(`  Config file: ${getConfigPath()}`);

  if (isConfigured()) {
    const feishuConfig = getFeishuConfig()!;
    console.log(`  Feishu App ID: ${feishuConfig.appId}`);
    console.log(`  Domain: ${feishuConfig.domain}`);
    console.log(chalk.green("  ✓ Configured"));
  } else {
    console.log(chalk.yellow("  ✗ Not configured"));
    console.log("    Run 'cc-ys init' to configure");
  }
  console.log();

  console.log(chalk.bold("Claude Agent SDK:"));
  const claudeAvailable = await checkClaudeSdkAvailable();
  if (claudeAvailable) {
    console.log(chalk.green("  ✓ Available"));
  } else {
    console.log(chalk.red("  ✗ Not found"));
    console.log("    Run npm install in the cc-ys project");
  }
  const envVars = getAnthropicEnvVarNames();
  console.log(`  Current ANTHROPIC_* vars: ${envVars.length ? envVars.join(", ") : "(none)"}`);
  console.log(`  Service env file: ${CLAUDE_ENV_PATH}`);
  console.log();

  // Working directory
  const claudeConfig = getClaudeConfig();
  console.log(chalk.bold("Settings:"));
  console.log(`  Default work dir: ${claudeConfig.defaultWorkDir}`);
  console.log(`  Max turns: ${claudeConfig.maxTurns}`);
  console.log(`  Timeout: ${claudeConfig.timeoutMs}ms`);
  console.log();

  // Daemon status
  console.log(chalk.bold("Background Service:"));
  const daemonStatus = await getDaemonStatus();
  console.log(`  Platform: ${daemonStatus.platform}`);

  if (daemonStatus.installed) {
    console.log(chalk.green("  ✓ Installed"));
  } else {
    console.log(chalk.yellow("  ✗ Not installed"));
  }

  if (daemonStatus.running) {
    console.log(chalk.green("  ✓ Running"));
    console.log("  Logs: /tmp/cc-ys.log");
  } else {
    console.log(chalk.dim("  ○ Not running"));
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
        `    - ${s.chatId.slice(0, 20)}... (${s.claudeSessionId ? "sdk session" : "no sdk session"}, ${time})`
      );
    });
  }
  console.log();
}
