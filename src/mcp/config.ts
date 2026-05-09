import { getMcpConfig, type McpConfig, type McpServerConfig } from "../config.js";

export type ClaudeMcpRuntimeConfig =
  | {
      type?: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      alwaysLoad?: boolean;
    }
  | {
      type: "sse" | "http";
      url: string;
      headers?: Record<string, string>;
      tools?: Array<{
        name: string;
        permission_policy: "always_allow" | "always_ask" | "always_deny";
      }>;
      alwaysLoad?: boolean;
    };

export function getEnabledMcpServers(config: McpConfig = getMcpConfig()): Record<string, McpServerConfig> {
  if (!config.enabled) {
    return {};
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(config.servers ?? {})) {
    if (server.enabled === false) {
      continue;
    }
    servers[name] = stripRuntimeOnlyMcpFields(server);
  }
  return servers;
}

export function getConfiguredMcpServerNames(config: McpConfig = getMcpConfig()): string[] {
  return Object.keys(config.servers ?? {}).sort();
}

export function getMcpServerNames(config: McpConfig = getMcpConfig()): string[] {
  return Object.keys(getEnabledMcpServers(config)).sort();
}

export function getMcpSignature(config: McpConfig = getMcpConfig()): string {
  return stableStringify({
    enabled: config.enabled,
    servers: getEnabledMcpServers(config),
  });
}

export function parseMcpServersJson(value: string): Record<string, McpServerConfig> {
  const parsed = JSON.parse(value) as unknown;
  const root = unwrapMcpServers(parsed);
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("mcp.servers must be a JSON object keyed by server name");
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(root as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(`Invalid MCP server name: ${name}`);
    }
    servers[name] = parseMcpServerConfig(name, server);
  }
  return servers;
}

export function buildClaudeMcpConfig(
  servers: Record<string, McpServerConfig> = getEnabledMcpServers()
): Record<string, ClaudeMcpRuntimeConfig> | undefined {
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    return undefined;
  }

  const result: Record<string, ClaudeMcpRuntimeConfig> = {};
  for (const [name, server] of entries) {
    result[name] = normalizeForClaude(server);
  }
  return result;
}

export function buildCodexMcpConfig(
  servers: Record<string, McpServerConfig> = getEnabledMcpServers()
): Record<string, CodexConfigValue> | undefined {
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    return undefined;
  }

  const result: Record<string, CodexConfigValue> = {};
  for (const [name, server] of entries) {
    result[name] = normalizeForCodex(server);
  }
  return result;
}

type CodexConfigValue =
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | { [key: string]: CodexConfigValue };

type CommonMcpFields = {
  alwaysLoad?: boolean;
  enabled?: boolean;
  required?: boolean;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
  enabled_tools?: string[];
  disabled_tools?: string[];
};

function unwrapMcpServers(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (isPlainRecord(record.mcpServers)) {
    return record.mcpServers;
  }
  if (isPlainRecord(record.mcp_servers)) {
    return record.mcp_servers;
  }
  return value;
}

function parseMcpServerConfig(name: string, value: unknown): McpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`MCP server ${name} must be an object`);
  }

  const record = value as Record<string, unknown>;
  const rawType = typeof record.type === "string" ? record.type : undefined;
  const hasCommand = typeof record.command === "string" && record.command.trim().length > 0;
  const hasUrl = typeof record.url === "string" && record.url.trim().length > 0;

  if (!rawType && hasCommand && hasUrl) {
    throw new Error(`MCP server ${name} has both command and url; set type to stdio, sse, or http`);
  }

  const type = rawType ?? (hasUrl ? "http" : "stdio");
  if (type === "stdio") {
    if (!hasCommand) {
      throw new Error(`MCP stdio server ${name} requires a command`);
    }
    return {
      type: "stdio",
      command: readRequiredString(record, "command", `${name}.command`),
      ...parseCommonFields(name, record),
      ...(Array.isArray(record.args) ? { args: parseStringArray(record.args, `${name}.args`) } : {}),
      ...(record.env ? { env: parseStringRecord(record.env, `${name}.env`) } : {}),
      ...(typeof record.cwd === "string" && record.cwd.trim() ? { cwd: record.cwd } : {}),
      ...parseStringArrayField(record, "env_vars", "envVars", `${name}.env_vars`),
      ...parseStringRecordField(
        record,
        "experimental_environment",
        "experimentalEnvironment",
        `${name}.experimental_environment`
      ),
    };
  }

  if (type === "sse" || type === "http") {
    if (!hasUrl) {
      throw new Error(`MCP ${type} server ${name} requires a url`);
    }
    return {
      type,
      url: readRequiredString(record, "url", `${name}.url`),
      ...parseCommonFields(name, record),
      ...(record.headers ? { headers: parseStringRecord(record.headers, `${name}.headers`) } : {}),
      ...parseStringRecordField(record, "http_headers", "httpHeaders", `${name}.http_headers`),
      ...parseStringRecordField(record, "env_http_headers", "envHttpHeaders", `${name}.env_http_headers`),
      ...parseStringField(record, "bearer_token_env_var", "bearerTokenEnvVar"),
      ...parseStringArrayField(record, "scopes", undefined, `${name}.scopes`),
      ...parseStringField(record, "oauth_resource", "oauthResource"),
      ...parseBooleanField(
        record,
        "supports_parallel_tool_calls",
        "supportsParallelToolCalls"
      ),
      ...(Array.isArray(record.tools) ? { tools: parseToolPolicies(record.tools, `${name}.tools`) } : {}),
    };
  }

  throw new Error(`MCP server ${name} type must be stdio, sse, or http`);
}

function parseCommonFields(
  name: string,
  record: Record<string, unknown>
): CommonMcpFields {
  return {
    ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
    ...(typeof record.alwaysLoad === "boolean" ? { alwaysLoad: record.alwaysLoad } : {}),
    ...(typeof record.required === "boolean" ? { required: record.required } : {}),
    ...parseNumberField(record, "startup_timeout_sec", "startupTimeoutSec", `${name}.startup_timeout_sec`),
    ...parseNumberField(record, "tool_timeout_sec", "toolTimeoutSec", `${name}.tool_timeout_sec`),
    ...parseStringArrayField(record, "enabled_tools", "enabledTools", `${name}.enabled_tools`),
    ...parseStringArrayField(record, "disabled_tools", "disabledTools", `${name}.disabled_tools`),
  };
}

function stripRuntimeOnlyMcpFields(server: McpServerConfig): McpServerConfig {
  const { enabled: _enabled, ...rest } = server;
  return rest as McpServerConfig;
}

function normalizeForClaude(server: McpServerConfig): ClaudeMcpRuntimeConfig {
  if (isRemoteServer(server)) {
    const headers = buildClaudeHeaders(server);
    return {
      type: server.type ?? "http",
      url: server.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(server.tools ? { tools: server.tools } : {}),
      ...(server.alwaysLoad !== undefined ? { alwaysLoad: server.alwaysLoad } : {}),
    };
  }

  return {
    type: "stdio",
    command: server.command,
    ...(server.args ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
    ...(server.alwaysLoad !== undefined ? { alwaysLoad: server.alwaysLoad } : {}),
  };
}

function normalizeForCodex(server: McpServerConfig): { [key: string]: CodexConfigValue } {
  if (isRemoteServer(server)) {
    const headers = mergeRecords(server.headers, server.http_headers);
    return omitUndefinedValues({
      url: server.url,
      http_headers: Object.keys(headers).length > 0 ? headers : undefined,
      env_http_headers: server.env_http_headers,
      bearer_token_env_var: server.bearer_token_env_var,
      scopes: server.scopes,
      oauth_resource: server.oauth_resource,
      supports_parallel_tool_calls: server.supports_parallel_tool_calls,
      ...codexCommonFields(server),
    });
  }

  return omitUndefinedValues({
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
    env_vars: server.env_vars,
    experimental_environment: server.experimental_environment,
    ...codexCommonFields(server),
  });
}

function codexCommonFields(server: McpServerConfig): Record<string, CodexConfigValue | undefined> {
  return {
    required: server.required,
    startup_timeout_sec: server.startup_timeout_sec,
    tool_timeout_sec: server.tool_timeout_sec,
    enabled_tools: server.enabled_tools,
    disabled_tools: server.disabled_tools,
  };
}

function buildClaudeHeaders(server: Extract<McpServerConfig, { url: string }>): Record<string, string> {
  const headers = mergeRecords(server.headers, server.http_headers);

  for (const [headerName, envName] of Object.entries(server.env_http_headers ?? {})) {
    const value = process.env[envName];
    if (value !== undefined) {
      headers[headerName] = value;
    }
  }

  const bearerTokenEnvVar = server.bearer_token_env_var;
  if (bearerTokenEnvVar && !hasHeader(headers, "authorization")) {
    const token = process.env[bearerTokenEnvVar];
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  return headers;
}

function isRemoteServer(server: McpServerConfig): server is Extract<McpServerConfig, { url: string }> {
  return "url" in server;
}

function readRequiredString(record: Record<string, unknown>, key: string, displayKey: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${displayKey} must be a non-empty string`);
  }
  return value;
}

function parseStringArray(value: unknown[], key: string): string[] {
  if (!value.every((item) => typeof item === "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value;
}

function parseStringArrayField(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string | undefined,
  displayKey: string
): Record<string, string[]> {
  const value = readAlias(record, snakeKey, camelKey);
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value)) {
    throw new Error(`${displayKey} must be an array of strings`);
  }
  return { [snakeKey]: parseStringArray(value, displayKey) };
}

function parseStringRecordField(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string | undefined,
  displayKey: string
): Record<string, Record<string, string>> {
  const value = readAlias(record, snakeKey, camelKey);
  if (value === undefined) {
    return {};
  }
  return { [snakeKey]: parseStringRecord(value, displayKey) };
}

function parseStringField(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string | undefined
): Record<string, string> {
  const value = readAlias(record, snakeKey, camelKey);
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${snakeKey} must be a non-empty string`);
  }
  return { [snakeKey]: value };
}

function parseBooleanField(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string | undefined
): Record<string, boolean> {
  const value = readAlias(record, snakeKey, camelKey);
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "boolean") {
    throw new Error(`${snakeKey} must be a boolean`);
  }
  return { [snakeKey]: value };
}

function parseNumberField(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string | undefined,
  displayKey: string
): Record<string, number> {
  const value = readAlias(record, snakeKey, camelKey);
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${displayKey} must be a positive number`);
  }
  return { [snakeKey]: value };
}

function readAlias(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string | undefined
): unknown {
  if (record[snakeKey] !== undefined) {
    return record[snakeKey];
  }
  return camelKey ? record[camelKey] : undefined;
}

function parseStringRecord(value: unknown, key: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }

  const result: Record<string, string> = {};
  for (const [recordKey, recordValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof recordValue !== "string") {
      throw new Error(`${key}.${recordKey} must be a string`);
    }
    result[recordKey] = recordValue;
  }
  return result;
}

function parseToolPolicies(value: unknown[], key: string): Array<{
  name: string;
  permission_policy: "always_allow" | "always_ask" | "always_deny";
}> {
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${key}[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name) {
      throw new Error(`${key}[${index}].name must be a string`);
    }
    if (
      record.permission_policy !== "always_allow" &&
      record.permission_policy !== "always_ask" &&
      record.permission_policy !== "always_deny"
    ) {
      throw new Error(
        `${key}[${index}].permission_policy must be always_allow, always_ask, or always_deny`
      );
    }
    return {
      name: record.name,
      permission_policy: record.permission_policy,
    };
  });
}

function omitUndefinedValues(value: Record<string, CodexConfigValue | undefined>): {
  [key: string]: CodexConfigValue;
} {
  const result: { [key: string]: CodexConfigValue } = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = item;
    }
  }
  return result;
}

function mergeRecords(
  ...records: Array<Record<string, string> | undefined>
): Record<string, string> {
  return Object.assign({}, ...records.filter(Boolean));
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
