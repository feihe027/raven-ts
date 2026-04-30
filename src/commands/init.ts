import chalk from "chalk";
import ora from "ora";
import { homedir } from "os";
import * as readline from "readline";
import {
  setFeishuConfig,
  getFeishuConfig,
  setClaudeConfig,
  setCodexConfig,
  setAgentProvider,
  type FeishuConfig,
  type AgentProvider,
} from "../config.js";
import { createFeishuClient } from "../feishu/client.js";
import { installDaemon, startDaemon } from "../daemon/service.js";
import { writeClaudeEnvFile } from "../claude/env.js";

function prompt(rl: readline.ReadLine, question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const promptText = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(promptText, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function promptConfirm(rl: readline.ReadLine, question: string, defaultValue: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const defaultStr = defaultValue ? "Y/n" : "y/N";
    rl.question(`${question} [${defaultStr}]: `, (answer) => {
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") {
        resolve(defaultValue);
      } else {
        resolve(trimmed === "y" || trimmed === "yes");
      }
    });
  });
}

async function promptSelect(rl: readline.ReadLine, question: string, choices: string[], defaultChoice: string): Promise<string> {
  console.log(chalk.cyan(`${question}`));
  choices.forEach((c, i) => {
    const marker = c === defaultChoice ? ">" : " ";
    console.log(`  ${marker} ${i + 1}. ${c}`);
  });

  const answer = await prompt(rl, "Select", "1");
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < choices.length) {
    return choices[idx];
  }
  return defaultChoice;
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function initCommand(): Promise<void> {
  console.log(chalk.cyan("\nraven-ts init\n"));
  console.log("This will guide you through setting up raven-ts.\n");

  const claudeSpinner = ora("Checking Claude Agent SDK...").start();
  const { checkClaudeSdkAvailable } = await import("../claude/executor.js");
  const claudeAvailable = await checkClaudeSdkAvailable();
  claudeSpinner.stop();

  if (!claudeAvailable) {
    console.log(chalk.yellow("Claude Agent SDK is not available. Run npm install first.\n"));
  } else {
    console.log(chalk.green("Claude Agent SDK found\n"));
  }

  const codexSpinner = ora("Checking Codex Agent SDK...").start();
  const { checkCodexSdkAvailable } = await import("../codex/executor.js");
  const codexAvailable = await checkCodexSdkAvailable();
  codexSpinner.stop();

  if (!codexAvailable) {
    console.log(chalk.yellow("Codex Agent SDK is not available. Run npm install first.\n"));
  } else {
    console.log(chalk.green("Codex Agent SDK found\n"));
  }

  // Show existing config if any
  const existingConfig = getFeishuConfig();
  if (existingConfig) {
    console.log(chalk.dim("Current configuration:"));
    console.log(chalk.dim(`  App ID: ${existingConfig.appId}`));
    console.log(chalk.dim(`  Domain: ${existingConfig.domain}`));
    console.log();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // Domain selection
    const domain = await promptSelect(
      rl,
      "Select Feishu/Lark domain:",
      ["feishu", "lark"],
      existingConfig?.domain ?? "feishu"
    );

    const agentProvider = (await promptSelect(
      rl,
      "Select agent backend:",
      ["claude", "codex"],
      "claude"
    )) as AgentProvider;

    // App ID
    const appId = await prompt(rl, "App ID", existingConfig?.appId);
    if (!appId) {
      console.log(chalk.red("App ID is required"));
      return;
    }

    // App Secret
    const appSecret = await prompt(rl, "App Secret", existingConfig?.appSecret);
    if (!appSecret) {
      console.log(chalk.red("App Secret is required"));
      return;
    }

    // Verification Token (optional)
    const verificationToken = await prompt(rl, "Verification Token (optional)", existingConfig?.verificationToken);

    // Encrypt Key (optional)
    const encryptKey = await prompt(rl, "Encrypt Key (optional)", existingConfig?.encryptKey);

    // Default work dir
    const defaultWorkDir = await prompt(rl, "Default working directory for Claude Agent SDK", homedir());

    const maxTurnsAnswer = await prompt(rl, "Claude SDK max turns", "20");
    const timeoutAnswer = await prompt(rl, "Claude SDK timeout in milliseconds", "300000");
    const codexBin = await prompt(rl, "Codex binary path (optional)", "");

    // Start daemon
    const startDaemonBool = await promptConfirm(rl, "Start as background service?", true);

    // Save configuration
    const feishuConfig: FeishuConfig = {
      appId,
      appSecret,
      verificationToken: verificationToken || undefined,
      encryptKey: encryptKey || undefined,
      domain: domain as "feishu" | "lark",
    };

    setFeishuConfig(feishuConfig);
    setClaudeConfig({
      defaultWorkDir,
      maxTurns: parsePositiveInteger(maxTurnsAnswer, 20),
      timeoutMs: parsePositiveInteger(timeoutAnswer, 300000),
    });
    setCodexConfig({
      codexBin: codexBin || undefined,
    });
    setAgentProvider(agentProvider);

    console.log(chalk.green("\n[OK] Configuration saved\n"));

    const envFile = writeClaudeEnvFile();
    if (envFile.variableNames.length > 0) {
      console.log(chalk.green(`[OK] Claude environment file written: ${envFile.path}`));
      console.log(chalk.dim(`  Variables: ${envFile.variableNames.join(", ")}`));
    } else {
      console.log(chalk.yellow(`Claude environment file written with no ANTHROPIC_* variables: ${envFile.path}`));
      console.log(chalk.dim("  Export ANTHROPIC_*, OPENAI_*, or CODEX_* variables before running init if the service needs API credentials."));
    }
    console.log();

    // Test connection
    const testSpinner = ora("Testing Feishu connection...").start();

    try {
      const client = createFeishuClient(feishuConfig);

      // Use generic request method for bot info API
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (client as any).request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
        data: {},
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (response.code === 0) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const bot = response.bot ?? response.data?.bot;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        testSpinner.succeed(`Connected to Feishu bot: ${(bot?.bot_name as string) ?? "Unknown"}`);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        testSpinner.fail(`Connection failed: code ${response.code as number}`);
      }
    } catch (err) {
      testSpinner.fail(`Connection failed: ${err}`);
    }

    // Start daemon if requested
    if (startDaemonBool) {
      console.log();
      const daemonSpinner = ora("Starting background service...").start();

      const installResult = await installDaemon();
      if (!installResult.success) {
        daemonSpinner.fail(installResult.message);
        return;
      }

      const startResult = await startDaemon();
      if (startResult.success) {
        daemonSpinner.succeed(startResult.message);
      } else {
        daemonSpinner.fail(startResult.message);
      }
    }

    // Show next steps
    console.log();
    console.log(chalk.cyan("Next steps:"));
    console.log();
    console.log("1. Add the bot to a Feishu group chat or start a direct message");
    console.log("2. Send a message to trigger the configured agent SDK");
    console.log();
    console.log(chalk.dim("Commands available in chat:"));
    console.log(chalk.dim("  /r help     - Show available commands"));
    console.log(chalk.dim("  /r cd <dir> - Change working directory"));
    console.log(chalk.dim("  /r pwd      - Show current directory"));
    console.log(chalk.dim("  /r clear    - Clear conversation history"));
    console.log();
  } finally {
    rl.close();
  }
}
