import Conf from "conf";
import { homedir } from "os";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  domain: "feishu" | "lark";
}

export interface ClaudeConfig {
  defaultWorkDir: string;
  maxTurns: number;
  timeoutMs: number;
}

export type AgentProvider = "claude" | "codex";

export interface CodexConfig {
  model?: string;
  codexBin?: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
  timeoutMs: number;
  skipGitRepoCheck: boolean;
  networkAccessEnabled: boolean;
}

export interface AppConfig {
  feishu: FeishuConfig | null;
  claude: ClaudeConfig;
  codex: CodexConfig;
  agent: {
    provider: AgentProvider;
  };
}

const defaults: AppConfig = {
  feishu: null,
  claude: {
    defaultWorkDir: homedir(),
    maxTurns: 20,
    timeoutMs: 300000,
  },
  codex: {
    model: "gpt-5.3-codex",
    reasoningEffort: "medium",
    timeoutMs: 300000,
    skipGitRepoCheck: true,
    networkAccessEnabled: true,
  },
  agent: {
    provider: "claude",
  },
};

export const config = new Conf<AppConfig>({
  projectName: "raven-ts",
  defaults,
});

migrateLegacyConfig();

function migrateLegacyConfig(): void {
  if (isValidFeishuConfig(config.get("feishu"))) {
    return;
  }

  for (const projectName of ["raven", "cc-ys"]) {
    const legacyConfig = new Conf<AppConfig>({
      projectName,
      defaults,
    });
    const legacyFeishu = legacyConfig.get("feishu");
    if (!isValidFeishuConfig(legacyFeishu)) {
      continue;
    }

    config.set("feishu", legacyFeishu);
    config.set("claude", legacyConfig.get("claude"));
    config.set("codex", legacyConfig.get("codex"));
    config.set("agent", legacyConfig.get("agent"));
    return;
  }
}

function isValidFeishuConfig(feishu: FeishuConfig | null): feishu is FeishuConfig {
  return Boolean(feishu?.appId && feishu.appSecret);
}

export function getFeishuConfig(): FeishuConfig | null {
  return config.get("feishu");
}

export function setFeishuConfig(cfg: FeishuConfig): void {
  config.set("feishu", cfg);
}

export function getClaudeConfig(): ClaudeConfig {
  return config.get("claude");
}

export function setClaudeConfig(cfg: Partial<ClaudeConfig>): void {
  config.set("claude", { ...config.get("claude"), ...cfg });
}

export function getCodexConfig(): CodexConfig {
  return config.get("codex");
}

export function setCodexConfig(cfg: Partial<CodexConfig>): void {
  config.set("codex", { ...config.get("codex"), ...cfg });
}

export function getAgentProvider(): AgentProvider {
  return config.get("agent.provider");
}

export function setAgentProvider(provider: AgentProvider): void {
  config.set("agent.provider", provider);
}

export function isConfigured(): boolean {
  const feishu = getFeishuConfig();
  return feishu !== null && feishu.appId !== "" && feishu.appSecret !== "";
}

export function getConfigPath(): string {
  return config.path;
}
