import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { readNativeCodexCatalogEntries } from "./catalog";
import {
  applyClaudeCode,
  claudeCodeSettingsPath,
  claudeCodeStatus,
  restoreClaudeCode,
} from "./claude-code";
import { claudeGatewayProfileModels } from "./claude-gateway";
import { dataDir } from "./paths";

export type ClientId = "chatgpt" | "claude";

export type ClientStatus = "connected" | "disconnected" | "unavailable";

/** One install surface under a client (e.g. Claude Desktop vs Claude Code). */
export interface ClientSurface {
  id: string;
  label: string;
  status: ClientStatus;
  configPath?: string;
  baseUrl?: string;
  reason?: string;
}

export interface ClientTarget {
  id: ClientId;
  label: string;
  /** True when at least one surface is installed on this machine. */
  installed: boolean;
  status: ClientStatus;
  /** Human readable location of the primary config this integration writes. */
  configPath?: string;
  /** Loopback base URL the client is pointed at, when connected. */
  baseUrl?: string;
  /** Set when the integration cannot run on this platform. */
  reason?: string;
  /** Logo key for the dashboard (`openai`, `claude`, …). */
  logo: string;
  /** Per-app / CLI surfaces Connect touches. */
  surfaces?: ClientSurface[];
}

export interface ApplyResult {
  target: ClientTarget;
  /** True when the desktop app had to be quit and reopened. */
  restarted: boolean;
  /** Files written, for surfacing in the dashboard. */
  written: string[];
}

/**
 * Thrown when a profile change would interrupt a running desktop app. The
 * dashboard surfaces this so the user can explicitly confirm a restart rather
 * than having their in-flight task killed silently.
 */
export class RestartRequiredError extends Error {
  readonly client: ClientId;

  constructor(client: ClientId, label: string) {
    super(`${label} is running. Restart it to apply the Jevonian profile.`);
    this.name = "RestartRequiredError";
    this.client = client;
  }
}

/**
 * Sentinel written into desktop client configs in place of a real Jevonian key.
 * Clients re-read and overwrite their stored credential on launch, so a real
 * key would be clobbered and left in plaintext on disk. The server accepts this
 * value only from a loopback peer (see `src/local-client.ts`), so it has to be
 * one of the values listed there: a profile written with anything else hands the
 * client a credential the server rejects, and the app reports the gateway as
 * refused rather than misconfigured.
 */
export const MANAGED_MARKER = "jevonian-local";

// ---------------------------------------------------------------------------
// Backup helpers
// ---------------------------------------------------------------------------

/** Timestamped sibling backup so a bad apply is always recoverable by hand. */
function backupFile(path: string): void {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    renameSync(path, `${path}.jevonian-backup-${stamp}`);
  } catch {
    // Backup is best-effort; never block the apply on it.
  }
}

function readJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed config falls back to an empty object.
  }
  return {};
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function stateDir(): string {
  return join(dataDir(), "clients");
}

/**
 * Captures the pre-Jevonian state of a file so "Restore" can put it back
 * exactly, matching Ollama's restore-state approach.
 *
 * A restore state is only ever written once per client. Re-running "Connect"
 * must not overwrite it, otherwise the state would capture our own sentinel and
 * the user's real login would be lost permanently.
 */
function saveRestoreState(client: ClientId, files: Record<string, string>): void {
  const path = join(stateDir(), `${client}-restore.json`);
  if (existsSync(path)) return;
  mkdirSync(stateDir(), { recursive: true });
  writeJson(path, { client, savedAt: new Date().toISOString(), files });
}

function loadRestoreState(client: ClientId): Record<string, string> | null {
  const path = join(stateDir(), `${client}-restore.json`);
  if (!existsSync(path)) return null;
  const parsed = readJson(path);
  const files = parsed.files;
  if (!files || typeof files !== "object") return null;
  return files as Record<string, string>;
}

function clearRestoreState(client: ClientId): void {
  const path = join(stateDir(), `${client}-restore.json`);
  backupFile(path);
}

/** Reads a file, returning "" when it does not exist. */
function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// TOML helpers (Codex config.toml)
// ---------------------------------------------------------------------------

/**
 * Replaces a root-level `key = value` assignment, leaving every other line
 * (including tables and user comments) untouched. Appends when absent.
 */
function setTomlRootString(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  const assignment = `${key} = ${JSON.stringify(value)}`;
  let replaced = false;
  let firstTable = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      firstTable = i;
      break;
    }
    if (replaced) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=/.exec(trimmed);
    if (!match || match[1] !== key) continue;
    lines[i] = assignment;
    replaced = true;
  }

  if (replaced) return lines.join("\n");

  // Insert at the end of the root block, before the first table.
  const head = lines.slice(0, firstTable);
  const tail = lines.slice(firstTable);
  while (head.length > 0 && head[head.length - 1].trim() === "") head.pop();
  return [...head, assignment, "", ...tail].join("\n");
}

/** Removes a root-level assignment so the client falls back to its native provider. */
function removeTomlRootValue(text: string, key: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      kept.push(...lines.slice(lines.indexOf(line)));
      break;
    }
    const match = /^([A-Za-z0-9_-]+)\s*=/.exec(trimmed);
    if (match && match[1] === key) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function getTomlRootString(text: string, key: string): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) return undefined;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (match && match[1] === key) {
      return match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Codex / ChatGPT Desktop
// ---------------------------------------------------------------------------

export function codexConfigPath(): string {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(home, "config.toml");
}

function codexCatalogPath(): string {
  return join(dirname(codexConfigPath()), "jevonian-models.json");
}

/** Ollama-style allow-list: only these slugs are served by Jevonian. */
function codexRoutingCatalogPath(): string {
  return join(dirname(codexConfigPath()), "jevonian-codex-routing.json");
}

/**
 * The endpoint Codex should call. Jevonian already speaks the OpenAI Responses
 * API on /v1/responses, which is exactly what the Codex client uses.
 */
export function codexBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

function codexInstalled(): boolean {
  if (existsSync(codexConfigPath())) return true;
  const candidates = [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    join(homedir(), "Applications", "ChatGPT.app"),
  ];
  return candidates.some((candidate) => existsSync(candidate));
}

/**
 * Writes the combined ChatGPT picker catalog the Ollama way:
 * Jevonian-injected models first (`supported_in_api: true`), then native Codex
 * rows marked ChatGPT-only (`supported_in_api: false`). The separate routing
 * catalog — not this file — decides which requests Jevonian serves.
 *
 * Field coverage matters: a sparse entry leaves the client's model parser in an
 * undefined state, which surfaces as the app hanging on startup.
 */
function writeCodexCatalog(models: string[]): string {
  const path = codexCatalogPath();
  const native = readNativeCodexCatalogEntries() ?? [];
  const baseInstructions =
    nativeBaseInstructions(native) ??
    "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.";

  // Reasoning levels the picker offers. ChatGPT's native levels are preserved
  // rather than replaced, so switching back to a native model still works.
  const reasoningLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(
    (effort) => ({ effort, description: reasoningDescription(effort) }),
  );

  const priorityStart = ollamaStylePriorityStart(native, models.length);
  const seen = new Set<string>();
  const entries: Array<Record<string, unknown>> = [];

  for (const [index, model] of models.entries()) {
    const key = catalogModelKey(model);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      slug: model,
      display_name: model === "jevonian/auto" ? "Jevonian Auto" : model,
      description: "Jevonian routed model",
      default_reasoning_level: "medium",
      supported_reasoning_levels: reasoningLevels,
      shell_type: "unified_exec",
      visibility: "list",
      // Only Jevonian rows are API-routable through the loopback proxy.
      supported_in_api: true,
      priority: priorityStart + index,
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
      availability_nux: null,
      upgrade: null,
      base_instructions: baseInstructions,
      model_messages: null,
      include_skills_usage_instructions: true,
      include_plugin_usage_instructions: true,
      include_apps_usage_instructions: true,
      supports_reasoning_summary_parameter: false,
      supports_reasoning_summaries: false,
      default_reasoning_summary: "auto",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      web_search_tool_type: "text",
      truncation_policy: { mode: "tokens", limit: 10_000 },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: true,
      context_window: 128_000,
      max_context_window: 128_000,
      auto_compact_token_limit: null,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      supports_search_tool: true,
    });
  }

  for (const entry of native) {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    const key = catalogModelKey(slug);
    if (!slug || seen.has(key)) continue;
    seen.add(key);
    // Mark native rows ChatGPT-only so API-key sessions do not offer them as
    // loopback-routable models — same flag Ollama sets.
    entries.push({ ...entry, supported_in_api: false });
  }

  writeJson(path, { models: entries });
  return path;
}

/** Allow-list of slugs the proxy must serve locally instead of forwarding. */
function writeCodexRoutingCatalog(models: string[]): string {
  const path = codexRoutingCatalogPath();
  writeJson(path, {
    models: models.map((slug) => ({ slug })),
  });
  return path;
}

function catalogModelKey(slug: string): string {
  return slug.trim().toLowerCase();
}

function nativeBaseInstructions(native: Array<Record<string, unknown>>): string | undefined {
  for (const entry of native) {
    if (typeof entry.base_instructions === "string" && entry.base_instructions.trim()) {
      return entry.base_instructions;
    }
  }
  return undefined;
}

/** Put injected models above natives in the picker (lower priority number). */
function ollamaStylePriorityStart(
  native: Array<Record<string, unknown>>,
  injectedCount: number,
): number {
  let lowest = 0;
  let found = false;
  for (const entry of native) {
    if (typeof entry.priority !== "number") continue;
    if (!found || entry.priority < lowest) {
      lowest = entry.priority;
      found = true;
    }
  }
  if (!found) return 1;
  return lowest - injectedCount;
}

function reasoningDescription(level: string): string {
  switch (level) {
    case "none":
      return "Turn thinking off";
    case "minimal":
      return "Minimal thinking for the fastest responses";
    case "low":
      return "Fast responses with lighter thinking";
    case "medium":
      return "Balances speed and thinking depth for everyday tasks";
    case "high":
      return "Greater thinking depth for complex tasks";
    case "xhigh":
      return "Extra high thinking depth for demanding tasks";
    case "max":
      return "Maximum thinking depth for the hardest tasks";
    case "ultra":
      return "Highest available thinking depth";
    default:
      return "Thinking effort";
  }
}

export function chatgptStatus(port: number): ClientTarget {
  const installed = codexInstalled();
  const configPath = codexConfigPath();
  const text = readText(configPath);
  const baseUrl = getTomlRootString(text, "openai_base_url");
  const catalog = getTomlRootString(text, "model_catalog_json");
  const connected =
    baseUrl !== undefined &&
    catalog !== undefined &&
    baseUrl.startsWith(`http://127.0.0.1:${port}`) &&
    catalog === codexCatalogPath();

  return {
    id: "chatgpt",
    label: "ChatGPT",
    installed,
    status: !installed ? "unavailable" : connected ? "connected" : "disconnected",
    configPath,
    baseUrl: connected ? baseUrl : undefined,
    reason: installed ? undefined : "ChatGPT / Codex app was not found on this machine.",
    logo: "openai",
    surfaces: installed
      ? [
          {
            id: "desktop",
            label: "Desktop (Codex)",
            status: connected ? "connected" : "disconnected",
            configPath,
            baseUrl: connected ? baseUrl : undefined,
          },
        ]
      : undefined,
  };
}

export interface ApplyOptions {
  port: number;
  models: string[];
  /** Claude Code tier remap list; defaults to `models` when omitted. */
  codeModels?: string[];
  /** Set once the user confirms it is safe to quit and reopen the app. */
  restart?: boolean;
}

/**
 * Codex sends whatever credential is in `auth.json` to `openai_base_url`. A
 * real ChatGPT login would be rejected by Jevonian, so the client is given a
 * local sentinel instead.
 *
 * Critically, an existing `auth.json` is NEVER overwritten. A real login holds
 * a refresh token that cannot be regenerated without the user signing in again,
 * so Jevonian only creates the file when it is absent — exactly what Ollama's
 * Codex launcher does with `O_CREATE|O_EXCL`. If a login already exists the
 * client keeps it, and the sentinel bypass in `src/local-client.ts` is what
 * lets that token through to Jevonian.
 */
function authPathFor(configPath: string): string {
  return join(dirname(configPath), "auth.json");
}

function ensureLocalSentinelAuth(configPath: string): { created: boolean; path: string } {
  const authPath = authPathFor(configPath);
  if (existsSync(authPath)) return { created: false, path: authPath };

  writeJson(authPath, { OPENAI_API_KEY: MANAGED_MARKER, auth_mode: "apikey" });
  return { created: true, path: authPath };
}

/** True when auth.json holds our sentinel rather than a real login. */
function isSentinelAuth(authPath: string): boolean {
  const data = readJson(authPath);
  return data.auth_mode === "apikey" && data.OPENAI_API_KEY === MANAGED_MARKER;
}

/**
 * Removes only Jevonian's own sentinel. A user login or API key written after
 * the fact is left untouched.
 */
function clearLocalSentinelAuth(configPath: string): void {
  const authPath = authPathFor(configPath);
  if (!isSentinelAuth(authPath)) return;
  try {
    rmSync(authPath);
  } catch {
    // Already gone; nothing to clean up.
  }
}

export function applyChatGpt(options: ApplyOptions): ApplyResult {
  const configPath = codexConfigPath();
  const authPath = authPathFor(configPath);
  const original = readText(configPath);

  saveRestoreState("chatgpt", { [configPath]: original, [authPath]: readText(authPath) });

  const primary = options.models[0];
  if (!primary) throw new Error("Select at least one model before connecting ChatGPT.");

  const catalogPath = writeCodexCatalog(options.models);
  const routingPath = writeCodexRoutingCatalog(options.models);
  let text = original.length > 0 ? original : "";
  text = setTomlRootString(text, "model", primary);
  text = removeTomlRootValue(text, "model_provider");
  text = setTomlRootString(text, "model_catalog_json", catalogPath);
  text = setTomlRootString(text, "openai_base_url", codexBaseUrl(options.port));

  if (original.length > 0) backupFile(configPath);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");

  // Required: Codex sends this credential to Jevonian, which rejects a real
  // ChatGPT account token.
  ensureLocalSentinelAuth(configPath);

  return {
    target: chatgptStatus(options.port),
    restarted: false,
    written: [configPath, catalogPath, routingPath, authPath],
  };
}

export function restoreChatGpt(): ClientTarget {
  const configPath = codexConfigPath();
  const state = loadRestoreState("chatgpt");
  const original = state?.[configPath];

  if (typeof original === "string") {
    backupFile(configPath);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, original, "utf8");
  } else if (existsSync(configPath)) {
    // No captured state: strip only the keys this integration manages.
    let text = readText(configPath);
    text = removeTomlRootValue(text, "openai_base_url");
    text = removeTomlRootValue(text, "model_catalog_json");
    backupFile(configPath);
    writeFileSync(configPath, text, "utf8");
  }

  // auth.json is never overwritten, so the only thing to undo is a sentinel
  // Jevonian itself created when the file was absent.
  clearLocalSentinelAuth(configPath);

  if (existsSync(codexCatalogPath())) backupFile(codexCatalogPath());
  if (existsSync(codexRoutingCatalogPath())) backupFile(codexRoutingCatalogPath());
  clearRestoreState("chatgpt");
  return chatgptStatus(0);
}

// ---------------------------------------------------------------------------
// Claude Desktop
// ---------------------------------------------------------------------------

/**
 * Claude Desktop keeps third-party inference providers in a separate profile
 * root (`Claude-3p`) plus a deployment-mode flag in the normal config.
 */
function claudePaths() {
  const base = join(homedir(), "Library", "Application Support");
  const thirdParty = join(base, "Claude-3p");
  const profileId = "00000000-0000-4000-8000-000000000114";
  return {
    normalConfig: join(base, "Claude", "claude_desktop_config.json"),
    desktopConfig: join(thirdParty, "claude_desktop_config.json"),
    meta: join(thirdParty, "configLibrary", "_meta.json"),
    profile: join(thirdParty, "configLibrary", `${profileId}.json`),
    profileId,
  };
}

function claudeDesktopInstalled(): boolean {
  return (
    process.platform === "darwin" &&
    existsSync(join(homedir(), "Library", "Application Support", "Claude"))
  );
}

function claudeDesktopSurface(port: number): ClientSurface {
  if (process.platform !== "darwin") {
    return {
      id: "desktop",
      label: "Desktop",
      status: "unavailable",
      reason: "Claude Desktop integration is only supported on macOS.",
    };
  }
  const paths = claudePaths();
  const installed = claudeDesktopInstalled();
  if (!installed) {
    return {
      id: "desktop",
      label: "Desktop",
      status: "unavailable",
      configPath: paths.profile,
      reason: "Claude Desktop was not found on this machine.",
    };
  }
  const profile = readJson(paths.profile);
  const baseUrl =
    typeof profile.inferenceGatewayBaseUrl === "string"
      ? profile.inferenceGatewayBaseUrl
      : undefined;
  const connected =
    profile.inferenceProvider === "gateway" && Boolean(baseUrl && baseUrl.includes(`:${port}`));
  return {
    id: "desktop",
    label: "Desktop",
    status: connected ? "connected" : "disconnected",
    configPath: paths.profile,
    baseUrl: connected ? baseUrl : undefined,
  };
}

function claudeCodeSurface(port: number): ClientSurface {
  const status = claudeCodeStatus(port);
  return {
    id: "cli",
    label: "Claude Code",
    status: status.status,
    configPath: status.configPath,
    baseUrl: status.baseUrl,
    reason: status.reason,
  };
}

function mergeClaudeSurfaces(
  surfaces: ClientSurface[],
): Pick<ClientTarget, "installed" | "status" | "configPath" | "baseUrl" | "reason"> {
  const available = surfaces.filter((surface) => surface.status !== "unavailable");
  const installed = available.length > 0;
  if (!installed) {
    const reasons = surfaces.map((surface) => surface.reason).filter(Boolean);
    return {
      installed: false,
      status: "unavailable",
      reason: reasons[0] ?? "Claude Desktop and Claude Code were not found on this machine.",
    };
  }
  const connected = available.every((surface) => surface.status === "connected");
  const primary = available.find((surface) => surface.status === "connected") ?? available[0];
  return {
    installed: true,
    status: connected ? "connected" : "disconnected",
    configPath: primary?.configPath,
    baseUrl: primary?.baseUrl,
    reason: undefined,
  };
}

export function claudeStatus(port: number): ClientTarget {
  const surfaces = [claudeDesktopSurface(port), claudeCodeSurface(port)];
  const merged = mergeClaudeSurfaces(surfaces);
  return {
    id: "claude",
    label: "Claude",
    logo: "claude",
    surfaces,
    ...merged,
  };
}

/** Writes the Claude Desktop third-party gateway profile only. */
export function applyClaudeDesktop(options: ApplyOptions): ApplyResult {
  if (process.platform !== "darwin") {
    throw new Error("Claude Desktop integration is only supported on macOS.");
  }
  if (!claudeDesktopInstalled()) {
    throw new Error("Claude Desktop was not found on this machine.");
  }
  const paths = claudePaths();

  saveRestoreState("claude", {
    [paths.desktopConfig]: readText(paths.desktopConfig),
    [paths.meta]: readText(paths.meta),
    [paths.profile]: readText(paths.profile),
    [paths.normalConfig]: readText(paths.normalConfig),
  });

  const baseUrl = `http://127.0.0.1:${options.port}`;

  // Enable third-party deployment mode so Claude reads the Claude-3p profile.
  for (const path of [paths.desktopConfig, paths.normalConfig]) {
    const config = readJson(path);
    config.deploymentMode = "3p";
    writeJson(path, config);
  }

  const meta = readJson(paths.meta);
  meta.appliedId = paths.profileId;
  const entries = Array.isArray(meta.entries)
    ? meta.entries.filter((entry) => {
        const record = entry as Record<string, unknown>;
        return record?.id !== paths.profileId;
      })
    : [];
  meta.entries = [...entries, { id: paths.profileId, name: "Jevonian" }];
  writeJson(paths.meta, meta);

  const profile = readJson(paths.profile);
  profile.inferenceProvider = "gateway";
  profile.inferenceGatewayBaseUrl = baseUrl;
  // Claude authenticates to the loopback gateway with a placeholder key; the
  // real upstream credentials stay in Jevonian.
  profile.inferenceGatewayApiKey = MANAGED_MARKER;
  profile.inferenceGatewayAuthScheme = "bearer";
  profile.deploymentDisplayName = "Jevonian";
  profile.chatTabEnabled = true;
  // Claude cannot show Jevonian's aliases: its picker only offers Anthropic
  // model ids it ships a profile for. So the profile lists Jevonian's models
  // under Claude ids it accepts, and Jevonian translates them back on the way
  // in. Declaring the list also switches off model discovery, which is what the
  // app's own setup error recommends when a gateway list would not parse.
  profile.inferenceModels = claudeGatewayProfileModels(options.models);
  profile.modelDiscoveryEnabled = false;
  profile.disableDeploymentModeChooser = true;
  // Cowork opens links and fetches context on Jevonian's behalf, so its egress
  // allowance has to span the hosts a session may touch.
  profile.coworkEgressAllowedHosts = ["*"];
  profile.disableEssentialTelemetry = true;
  profile.disableNonessentialTelemetry = true;
  writeJson(paths.profile, profile);

  return {
    target: claudeStatus(options.port),
    restarted: false,
    written: [paths.desktopConfig, paths.meta, paths.profile, paths.normalConfig],
  };
}

/**
 * Connects every available Claude surface: Desktop gateway profile and Claude
 * Code settings env, the same way Ollama covers both with one integration.
 */
export function applyClaude(options: ApplyOptions): ApplyResult {
  const desktop = claudeDesktopSurface(options.port);
  const code = claudeCodeSurface(options.port);
  const written: string[] = [];

  if (desktop.status === "unavailable" && code.status === "unavailable") {
    throw new Error(
      code.reason ?? desktop.reason ?? "Neither Claude Desktop nor Claude Code was found.",
    );
  }

  if (desktop.status !== "unavailable") {
    const result = applyClaudeDesktop(options);
    written.push(...result.written);
  }
  if (code.status !== "unavailable") {
    const result = applyClaudeCode({
      port: options.port,
      models: options.codeModels ?? options.models,
    });
    written.push(...result.written);
  }

  return {
    target: claudeStatus(options.port),
    restarted: false,
    written,
  };
}

export function restoreClaudeDesktop(): void {
  const paths = claudePaths();
  const state = loadRestoreState("claude");

  if (state) {
    for (const path of [paths.desktopConfig, paths.meta, paths.profile, paths.normalConfig]) {
      const original = state[path];
      if (typeof original !== "string") continue;
      if (original.length === 0) {
        // The file did not exist before we ran; remove it rather than leaving
        // an empty stub that Claude would try to parse.
        try {
          rmSync(path);
        } catch {
          // Already absent.
        }
        continue;
      }
      backupFile(path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, original, "utf8");
    }
  } else if (process.platform === "darwin" && existsSync(paths.profile)) {
    // No captured state: clear only the keys this integration wrote.
    const config = readJson(paths.desktopConfig);
    config.deploymentMode = "1p";
    writeJson(paths.desktopConfig, config);

    const profile = readJson(paths.profile);
    delete profile.inferenceProvider;
    delete profile.inferenceGatewayBaseUrl;
    delete profile.inferenceGatewayApiKey;
    delete profile.inferenceGatewayAuthScheme;
    delete profile.deploymentDisplayName;
    writeJson(paths.profile, profile);
  }

  clearRestoreState("claude");
}

export function restoreClaude(): ClientTarget {
  try {
    restoreClaudeDesktop();
  } catch {
    // Desktop files may be absent outside macOS.
  }
  try {
    restoreClaudeCode();
  } catch {
    // Settings may already be gone.
  }
  return claudeStatus(0);
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export function clientTargets(port: number): ClientTarget[] {
  return [chatgptStatus(port), claudeStatus(port)];
}

export function applyClient(id: ClientId, options: ApplyOptions): ApplyResult {
  return id === "chatgpt" ? applyChatGpt(options) : applyClaude(options);
}

export function restoreClient(id: ClientId): ClientTarget {
  return id === "chatgpt" ? restoreChatGpt() : restoreClaude();
}

/** True when the desktop app looks like it is currently running. */
export function isClientRunning(id: ClientId): boolean {
  if (process.platform !== "darwin") return false;
  try {
    // A single `pgrep -f` pattern per app. `pgrep` treats the argument as an
    // extended regex, so alternation needs -f plus one pattern per candidate.
    const patterns =
      id === "chatgpt" ? ["ChatGPT.app", "Codex.app"] : ["Claude.app/Contents/MacOS/Claude"];
    for (const pattern of patterns) {
      const result = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
      if (result.stdout && result.stdout.trim().length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Quits and reopens the desktop app so a startup-loaded profile takes effect. */
export async function restartClient(id: ClientId): Promise<void> {
  if (process.platform !== "darwin") return;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  const appName = id === "chatgpt" ? "ChatGPT" : "Claude";
  const bundleId = id === "chatgpt" ? "com.openai.codex" : "com.anthropic.claudefordesktop";

  try {
    await run("osascript", ["-e", `tell application "${appName}" to quit`]);
  } catch {
    try {
      await run("osascript", ["-e", `tell application id "${bundleId}" to quit`]);
    } catch {
      // App was not running or refused to quit; reopening below is still safe.
    }
  }

  // Poll for a graceful exit rather than force-killing, so in-flight work can
  // finish flushing. Mirrors the 200ms cadence used by the Ollama launcher.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isClientRunning(id)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  await run("open", ["-b", bundleId]).catch(async () => {
    await run("open", ["-a", appName]).catch(() => undefined);
  });
}

export function clientConfigExists(id: ClientId): boolean {
  if (id === "chatgpt") return existsSync(codexConfigPath());
  return claudeDesktopInstalled() || existsSync(claudeCodeSettingsPath());
}
