import chalk from "chalk";
import { homedir } from "os";
import { resolve } from "path";
import {
  getAgentProvider,
  getCodexConfig,
  getFeishuConfig,
  getClaudeConfig,
  getConfigPath,
  getImageConfig,
  getMcpConfig,
  setAgentProvider,
  setCodexConfig,
  setFeishuConfig,
  setImageConfig,
  setMcpConfig,
  setClaudeConfig,
  type AgentProvider,
  type ClaudeConfig,
  type CodexConfig,
  type FeishuConfig,
  type ImageConfig,
  type McpConfig,
} from "../config.js";
import { getConfiguredMcpServerNames, getMcpServerNames, parseMcpServersJson } from "../mcp/config.js";

export async function configCommand(action: string, key?: string, value?: string): Promise<void> {
  switch (action) {
    case "list":
    case "show":
      showConfig();
      break;

    case "set":
      if (!key || !value) {
        console.log(chalk.red("Usage: raven-ts config set <key> <value>"));
        console.log();
        console.log("Available keys:");
        console.log("  feishu.appId");
        console.log("  feishu.appSecret");
        console.log("  feishu.verificationToken");
        console.log("  feishu.encryptKey");
        console.log("  feishu.domain");
        console.log("  agent.provider");
        console.log("  claude.defaultWorkDir");
        console.log("  claude.maxTurns");
        console.log("  claude.timeoutMs");
        console.log("  claude.authMode");
        console.log("  codex.model");
        console.log("  codex.codexBin");
        console.log("  codex.reasoningEffort");
        console.log("  codex.timeoutMs");
        console.log("  codex.skipGitRepoCheck");
        console.log("  codex.networkAccessEnabled");
        console.log("  codex.sandboxMode");
        console.log("  image.model");
        console.log("  image.size");
        console.log("  image.quality");
        console.log("  image.outputFormat");
        console.log("  image.timeoutMs");
        console.log("  mcp.enabled");
        console.log("  mcp.servers");
        return;
      }
      await setConfigValue(key, value);
      break;

    case "path":
      console.log(getConfigPath());
      break;

    default:
      console.log(chalk.red(`Unknown action: ${action}`));
      console.log("Usage: raven-ts config <list|set|path>");
  }
}

function showConfig(): void {
  console.log(chalk.cyan("\nConfiguration\n"));
  console.log(`Config file: ${getConfigPath()}`);
  console.log();

  const feishu = getFeishuConfig();
  const claude = getClaudeConfig();
  const codex = getCodexConfig();
  const image = getImageConfig();
  const mcp = getMcpConfig();

  console.log(chalk.bold("Agent:"));
  console.log(`  provider: ${getAgentProvider()}`);
  console.log();

  console.log(chalk.bold("Feishu:"));
  if (feishu) {
    console.log(`  appId: ${feishu.appId}`);
    console.log(`  appSecret: ${feishu.appSecret ? "********" : "(not set)"}`);
    console.log(`  domain: ${feishu.domain}`);
    console.log(`  verificationToken: ${feishu.verificationToken ? "********" : "(not set)"}`);
    console.log(`  encryptKey: ${feishu.encryptKey ? "********" : "(not set)"}`);
  } else {
    console.log(chalk.yellow("  Not configured"));
  }
  console.log();

  console.log(chalk.bold("Claude:"));
  console.log(`  defaultWorkDir: ${claude.defaultWorkDir}`);
  console.log(`  maxTurns: ${claude.maxTurns}`);
  console.log(`  timeoutMs: ${claude.timeoutMs}`);
  console.log(`  authMode: ${claude.authMode ?? "safe"}`);
  console.log();

  console.log(chalk.bold("Codex:"));
  console.log(`  model: ${codex.model || "gpt-5.3-codex"}`);
  console.log(`  codexBin: ${codex.codexBin || "(SDK default)"}`);
  console.log(`  reasoningEffort: ${codex.reasoningEffort}`);
  console.log(`  timeoutMs: ${codex.timeoutMs}`);
  console.log(`  skipGitRepoCheck: ${codex.skipGitRepoCheck}`);
  console.log(`  networkAccessEnabled: ${codex.networkAccessEnabled}`);
  console.log(`  sandboxMode: ${codex.sandboxMode ?? "workspace-write"}`);
  console.log();

  console.log(chalk.bold("Image:"));
  console.log(`  model: ${image.model}`);
  console.log(`  size: ${image.size}`);
  console.log(`  quality: ${image.quality ?? "(provider default)"}`);
  console.log(`  outputFormat: ${image.outputFormat}`);
  console.log(`  timeoutMs: ${image.timeoutMs}`);
  console.log();

  console.log(chalk.bold("MCP:"));
  console.log(`  enabled: ${mcp.enabled}`);
  console.log(`  activeServers: ${getMcpServerNames(mcp).join(", ") || "(none)"}`);
  console.log(`  configuredServers: ${getConfiguredMcpServerNames(mcp).join(", ") || "(none)"}`);
  console.log();
}

async function setConfigValue(key: string, value: string): Promise<void> {
  const [section, subkey] = key.split(".");

  if (section === "feishu") {
    setFeishuValue(key, subkey, value);
  } else if (section === "agent") {
    setAgentValue(key, subkey, value);
  } else if (section === "claude") {
    setClaudeValue(key, subkey, value);
  } else if (section === "codex") {
    setCodexValue(key, subkey, value);
  } else if (section === "image") {
    setImageValue(key, subkey, value);
  } else if (section === "mcp") {
    setMcpValue(key, subkey, value);
  } else {
    console.log(chalk.red(`Unknown section: ${section}`));
  }
}

function setFeishuValue(key: string, subkey: string, value: string): void {
  const existing = getFeishuConfig();
  if (!existing) {
    console.log(chalk.red("Feishu not configured. Run 'raven-ts init' first."));
    return;
  }

  const feishu: FeishuConfig = { ...existing };

  switch (subkey) {
    case "appId":
      feishu.appId = value;
      break;
    case "appSecret":
      feishu.appSecret = value;
      break;
    case "verificationToken":
      feishu.verificationToken = value || undefined;
      break;
    case "encryptKey":
      feishu.encryptKey = value || undefined;
      break;
    case "domain":
      if (value !== "feishu" && value !== "lark") {
        console.log(chalk.red("Domain must be 'feishu' or 'lark'"));
        return;
      }
      feishu.domain = value;
      break;
    default:
      console.log(chalk.red(`Unknown key: feishu.${subkey}`));
      return;
  }

  setFeishuConfig(feishu);
  console.log(chalk.green(`Set ${key}`));
}

function setAgentValue(key: string, subkey: string, value: string): void {
  if (subkey !== "provider") {
    console.log(chalk.red(`Unknown key: agent.${subkey}`));
    return;
  }

  if (value !== "claude" && value !== "codex") {
    console.log(chalk.red("Agent provider must be 'claude' or 'codex'"));
    return;
  }

  setAgentProvider(value as AgentProvider);
  console.log(chalk.green(`Set ${key}`));
}

function setClaudeValue(key: string, subkey: string, value: string): void {
  switch (subkey) {
    case "defaultWorkDir":
      setClaudeConfig({ defaultWorkDir: resolveUserPath(value) });
      break;
    case "maxTurns": {
      const parsed = parsePositiveInteger(value, "claude.maxTurns");
      if (parsed === null) return;
      setClaudeConfig({ maxTurns: parsed });
      break;
    }
    case "timeoutMs": {
      const parsed = parsePositiveInteger(value, "claude.timeoutMs");
      if (parsed === null) return;
      setClaudeConfig({ timeoutMs: parsed });
      break;
    }
    case "authMode": {
      const parsed = parseClaudeAuthMode(value);
      if (!parsed) return;
      setClaudeConfig({ authMode: parsed });
      break;
    }
    default:
      console.log(chalk.red(`Unknown key: claude.${subkey}`));
      return;
  }

  console.log(chalk.green(`Set ${key}`));
}

function setCodexValue(key: string, subkey: string, value: string): void {
  const patch: Partial<CodexConfig> = {};

  switch (subkey) {
    case "model":
      patch.model = value || undefined;
      break;
    case "codexBin":
      patch.codexBin = ["", "default", "none", "null"].includes(value.toLowerCase())
        ? undefined
        : value;
      break;
    case "reasoningEffort":
      if (!["minimal", "low", "medium", "high", "xhigh"].includes(value)) {
        console.log(chalk.red("codex.reasoningEffort must be minimal, low, medium, high, or xhigh"));
        return;
      }
      patch.reasoningEffort = (value === "minimal" ? "low" : value) as CodexConfig["reasoningEffort"];
      break;
    case "timeoutMs": {
      const parsed = parsePositiveInteger(value, "codex.timeoutMs");
      if (parsed === null) return;
      patch.timeoutMs = parsed;
      break;
    }
    case "skipGitRepoCheck": {
      const parsed = parseBoolean(value, "codex.skipGitRepoCheck");
      if (parsed === null) return;
      patch.skipGitRepoCheck = parsed;
      break;
    }
    case "networkAccessEnabled": {
      const parsed = parseBoolean(value, "codex.networkAccessEnabled");
      if (parsed === null) return;
      patch.networkAccessEnabled = parsed;
      break;
    }
    case "sandboxMode": {
      const parsed = parseCodexSandboxMode(value);
      if (!parsed) return;
      patch.sandboxMode = parsed;
      break;
    }
    default:
      console.log(chalk.red(`Unknown key: codex.${subkey}`));
      return;
  }

  setCodexConfig(patch);
  console.log(chalk.green(`Set ${key}`));
}

function resolveUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

function setImageValue(key: string, subkey: string, value: string): void {
  const patch: Partial<ImageConfig> = {};

  switch (subkey) {
    case "model":
      patch.model = value;
      break;
    case "size":
      patch.size = value;
      break;
    case "quality":
      patch.quality = ["", "default", "none", "null"].includes(value.toLowerCase())
        ? undefined
        : value;
      break;
    case "outputFormat": {
      const normalized = value.toLowerCase();
      if (normalized !== "png" && normalized !== "jpeg" && normalized !== "webp") {
        console.log(chalk.red("image.outputFormat must be png, jpeg, or webp"));
        return;
      }
      patch.outputFormat = normalized;
      break;
    }
    case "timeoutMs": {
      const parsed = parsePositiveInteger(value, "image.timeoutMs");
      if (parsed === null) return;
      patch.timeoutMs = parsed;
      break;
    }
    default:
      console.log(chalk.red(`Unknown key: image.${subkey}`));
      return;
  }

  setImageConfig(patch);
  console.log(chalk.green(`Set ${key}`));
}

function setMcpValue(key: string, subkey: string, value: string): void {
  const patch: Partial<McpConfig> = {};

  switch (subkey) {
    case "enabled": {
      const parsed = parseBoolean(value, "mcp.enabled");
      if (parsed === null) return;
      patch.enabled = parsed;
      break;
    }
    case "servers":
      try {
        patch.servers = parseMcpServersJson(value);
      } catch (err) {
        console.log(chalk.red(err instanceof Error ? err.message : String(err)));
        return;
      }
      break;
    default:
      console.log(chalk.red(`Unknown key: mcp.${subkey}`));
      return;
  }

  setMcpConfig(patch);
  console.log(chalk.green(`Set ${key}`));
}

function parseClaudeAuthMode(value: string): ClaudeConfig["authMode"] | null {
  const normalized = value.toLowerCase();
  if (normalized === "on") {
    return "auto";
  }
  if (normalized === "off" || normalized === "manual") {
    return "ask";
  }
  if (normalized === "edits" || normalized === "acceptedits") {
    return "accept-edits";
  }
  if (normalized === "danger" || normalized === "skip") {
    return "bypass";
  }
  if (
    normalized === "safe" ||
    normalized === "ask" ||
    normalized === "auto" ||
    normalized === "accept-edits" ||
    normalized === "deny" ||
    normalized === "bypass"
  ) {
    return normalized;
  }
  console.log(
    chalk.red("claude.authMode must be safe, ask, auto, accept-edits, deny, bypass, on, or off")
  );
  return null;
}

function parsePositiveInteger(value: string, key: string): number | null {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.log(chalk.red(`${key} must be a positive integer`));
    return null;
  }
  return parsed;
}

function parseBoolean(value: string, key: string): boolean | null {
  const normalized = value.toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  console.log(chalk.red(`${key} must be true or false`));
  return null;
}

function parseCodexSandboxMode(value: string): CodexConfig["sandboxMode"] | null {
  const normalized = value.toLowerCase();
  if (normalized === "on" || normalized === "true" || normalized === "workspace") {
    return "workspace-write";
  }
  if (normalized === "off" || normalized === "false" || normalized === "danger") {
    return "danger-full-access";
  }
  if (
    normalized === "read-only" ||
    normalized === "workspace-write" ||
    normalized === "danger-full-access"
  ) {
    return normalized;
  }
  console.log(
    chalk.red(
      "codex.sandboxMode must be read-only, workspace-write, danger-full-access, on, or off"
    )
  );
  return null;
}
