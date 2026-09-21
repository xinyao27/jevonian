import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ApplyOptions } from "./clients";
import { dataDir } from "./paths";

/**
 * Claude Code CLI integration, mirroring Ollama's `ollama launch claude`.
 *
 * Claude Code does not accept arbitrary model ids in its picker the way
 * ChatGPT Desktop does. Ollama's approach is to point the CLI at a local
 * Anthropic-compatible gateway and remap every built-in tier (opus / sonnet /
 * haiku / subagent) onto one selected model via env vars. Jevonian does the
 * same, and also writes those vars into `~/.claude/settings.json` so a plain
 * `claude` invocation keeps working after Connect — plus display-name overrides
 * so `/model` shows "Jevonian Auto" instead of a raw id.
 */

/** Same sentinel desktop clients use; accepted only from loopback. */
const AUTH_TOKEN = "jevonian-local";

/** Env keys Jevonian owns inside Claude Code's settings `env` block. */
export const CLAUDE_CODE_MANAGED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_FEEDBACK_COMMAND",
  "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
] as const;

export type ClaudeCodeConnStatus = "connected" | "disconnected" | "unavailable";

export interface ClaudeCodeStatus {
  installed: boolean;
  status: ClaudeCodeConnStatus;
  configPath: string;
  baseUrl?: string;
  reason?: string;
}

export interface ClaudeCodeApplyResult {
  status: ClaudeCodeStatus;
  written: string[];
}

export interface ClaudeCodeModelRouting {
  /** Opus / Sonnet / subagent / custom picker entry. */
  primary: string;
  /** Haiku / background. */
  fast: string;
}

export interface ClaudeCodeLaunchOptions {
  port: number;
  /** Models offered by Connect / desktop inject; first wins as primary. */
  models: readonly string[];
  /** Optional explicit model override (`--model`). */
  model?: string;
  /** Extra argv forwarded to the `claude` binary. */
  args?: readonly string[];
}

function clientsStateDir(): string {
  return join(dataDir(), "clients");
}

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

export function claudeCodeSettingsPath(): string {
  return join(claudeHome(), "settings.json");
}

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

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function saveRestoreState(files: Record<string, string>): void {
  const path = join(clientsStateDir(), "claude-code-restore.json");
  if (existsSync(path)) return;
  mkdirSync(clientsStateDir(), { recursive: true });
  writeJson(path, { client: "claude-code", savedAt: new Date().toISOString(), files });
}

function loadRestoreState(): Record<string, string> | null {
  const path = join(clientsStateDir(), "claude-code-restore.json");
  if (!existsSync(path)) return null;
  const parsed = readJson(path);
  const files = parsed.files;
  if (!files || typeof files !== "object") return null;
  return files as Record<string, string>;
}

function clearRestoreState(): void {
  const path = join(clientsStateDir(), "claude-code-restore.json");
  backupFile(path);
}

/** `jevonian/auto` → "Jevonian Auto". */
export function claudeCodeModelLabel(model: string): string {
  const tail = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const words = tail
    .split(/[-_.\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return ["Jevonian", ...words].join(" ");
}

/**
 * Picks the primary and fast models Claude Code's tier env vars should resolve
 * to. Mirrors Ollama: one selected model for opus/sonnet/subagent, and a
 * lighter alias for haiku when `jevonian/utility` is in the offer list.
 */
export function resolveClaudeCodeModels(
  models: readonly string[],
  override?: string,
): ClaudeCodeModelRouting {
  const primary = (override?.trim() || models[0] || "jevonian/auto").trim();
  const utility = models.find(
    (model) => model === "jevonian/utility" || model.endsWith("/utility"),
  );
  return { primary, fast: utility ?? primary };
}

export function claudeCodeBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Env map Claude Code needs to talk to Jevonian — same shape as
 * `ollama launch claude`, plus picker labels so the CLI shows Jevonian names.
 */
export function claudeCodeEnv(options: {
  port: number;
  models: readonly string[];
  model?: string;
}): Record<string, string> {
  const { primary, fast } = resolveClaudeCodeModels(options.models, options.model);
  const primaryLabel = claudeCodeModelLabel(primary);
  const fastLabel = claudeCodeModelLabel(fast);
  return {
    ANTHROPIC_BASE_URL: claudeCodeBaseUrl(options.port),
    ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
    // Empty string clears a shell-exported API key so AUTH_TOKEN wins.
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_DEFAULT_OPUS_MODEL: primary,
    ANTHROPIC_DEFAULT_SONNET_MODEL: primary,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: fast,
    CLAUDE_CODE_SUBAGENT_MODEL: primary,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: primaryLabel,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: primaryLabel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: fastLabel,
    ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: "Routed by Jevonian",
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: "Routed by Jevonian",
    ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION: "Routed by Jevonian",
    // Dedicated picker row so `/model` lists Jevonian even when aliases stay.
    ANTHROPIC_CUSTOM_MODEL_OPTION: primary,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: primaryLabel,
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Routed by Jevonian",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_FEEDBACK_COMMAND: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  };
}

/** `KEY=value` lines suitable for shell exports. */
export function claudeCodeEnvAssignments(options: {
  port: number;
  models: readonly string[];
  model?: string;
}): string[] {
  return Object.entries(claudeCodeEnv(options)).map(([key, value]) => `${key}=${value}`);
}

export function findClaudeCodePath(): string | undefined {
  const viaPath = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], {
    encoding: "utf8",
  });
  const fromPath = viaPath.stdout?.trim().split(/\r?\n/)[0];
  if (fromPath && existsSync(fromPath)) return fromPath;

  const home = homedir();
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  for (const candidate of [
    join(home, ".local", "bin", name),
    join(home, ".claude", "local", name),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function claudeCodeInstalled(): boolean {
  if (findClaudeCodePath()) return true;
  return existsSync(claudeHome());
}

function settingsEnv(settings: Record<string, unknown>): Record<string, string> {
  const raw = settings.env;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function claudeCodeStatus(port: number): ClaudeCodeStatus {
  const installed = claudeCodeInstalled();
  const settingsPath = claudeCodeSettingsPath();
  const env = settingsEnv(readJson(settingsPath));
  const baseUrl = env.ANTHROPIC_BASE_URL;
  const connected =
    Boolean(baseUrl && baseUrl.includes(`:${port}`)) && env.ANTHROPIC_AUTH_TOKEN === AUTH_TOKEN;

  return {
    installed,
    status: !installed ? "unavailable" : connected ? "connected" : "disconnected",
    configPath: settingsPath,
    baseUrl: connected ? baseUrl : undefined,
    reason: installed
      ? undefined
      : "Claude Code CLI was not found. Install it, then Connect or run `jevonian launch claude`.",
  };
}

export function applyClaudeCode(options: ApplyOptions): ClaudeCodeApplyResult {
  if (options.models.length === 0) {
    throw new Error("Select at least one model before connecting Claude Code.");
  }

  const settingsPath = claudeCodeSettingsPath();
  const original = readText(settingsPath);
  saveRestoreState({ [settingsPath]: original });

  const settings = readJson(settingsPath);
  const previous = settingsEnv(settings);
  const next = { ...previous, ...claudeCodeEnv({ port: options.port, models: options.models }) };
  settings.env = next;

  if (original.length > 0) backupFile(settingsPath);
  writeJson(settingsPath, settings);

  return {
    status: claudeCodeStatus(options.port),
    written: [settingsPath],
  };
}

export function restoreClaudeCode(): ClaudeCodeStatus {
  const settingsPath = claudeCodeSettingsPath();
  const state = loadRestoreState();
  const original = state?.[settingsPath];

  if (typeof original === "string") {
    if (original.length === 0) {
      // File did not exist before Connect — remove what we created rather than
      // leaving an empty stub Claude Code would try to parse.
      if (existsSync(settingsPath)) {
        backupFile(settingsPath);
      }
    } else {
      backupFile(settingsPath);
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, original, "utf8");
    }
  } else if (existsSync(settingsPath)) {
    const settings = readJson(settingsPath);
    const env = settingsEnv(settings);
    for (const key of CLAUDE_CODE_MANAGED_ENV_KEYS) delete env[key];
    if (Object.keys(env).length === 0) delete settings.env;
    else settings.env = env;
    backupFile(settingsPath);
    writeJson(settingsPath, settings);
  }

  clearRestoreState();
  return claudeCodeStatus(0);
}

/**
 * Spawns Claude Code with Jevonian env vars, Ollama-style. Returns the process
 * exit code (or 1 when the binary is missing).
 */
export async function launchClaudeCode(options: ClaudeCodeLaunchOptions): Promise<number> {
  const claudePath = findClaudeCodePath();
  if (!claudePath) {
    throw new Error(
      "claude binary not found. Install Claude Code, then re-run `jevonian launch claude`.",
    );
  }

  const { primary } = resolveClaudeCodeModels(options.models, options.model);
  const passModel = Boolean(options.model?.trim() || options.models[0]);
  const args = [...(passModel ? ["--model", primary] : []), ...(options.args ?? [])];
  const env = {
    ...process.env,
    ...claudeCodeEnv({ port: options.port, models: options.models, model: options.model }),
  };

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(claudePath, args, {
      stdio: "inherit",
      env,
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
