import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { retryingFetch } from "./retry";

export type OAuthSource = "claude-code" | "codex" | "antigravity" | "static";

export const CLAUDE_CODE_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

const execFileAsync = promisify(execFile);
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ANTIGRAVITY_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const ANTIGRAVITY_CLIENT_SECRET = "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";
const ANTIGRAVITY_KEYCHAIN_SERVICE = "gemini";
const ANTIGRAVITY_KEYCHAIN_ACCOUNT = "antigravity";
const REFRESH_SKEW_MS = 120_000;

export interface OAuthToken {
  token: string;
  accountId?: string;
  expiresAt?: number;
}

export interface OAuthFailure {
  error: string;
}

interface StoredCredential {
  data: Record<string, unknown>;
  save?: (next: Record<string, unknown>) => Promise<void>;
  label: string;
}

const cache = new Map<string, OAuthToken>();
const pending = new Map<string, Promise<OAuthToken | OAuthFailure>>();

function jwtExpiry(token: string): number | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function fresh(token: OAuthToken): boolean {
  return token.expiresAt === undefined || token.expiresAt - Date.now() > REFRESH_SKEW_MS;
}

async function readKeychain(service: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-w",
    ]);
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function writeKeychain(
  service: string,
  value: string,
  account: string = userInfo().username,
): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-s",
      service,
      "-a",
      account,
      "-w",
      value,
    ]);
  } catch {
    return;
  }
}

function claudeCredentialsPath(): string {
  if (process.env.JEVONIAN_CLAUDE_CREDENTIALS) return process.env.JEVONIAN_CLAUDE_CREDENTIALS;
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(base, ".credentials.json");
}

async function readClaudeCredential(): Promise<StoredCredential | undefined> {
  const path = claudeCredentialsPath();
  const explicit = Boolean(process.env.JEVONIAN_CLAUDE_CREDENTIALS);
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      return {
        data,
        save: async (next) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, `${JSON.stringify(next)}\n`, { mode: 0o600 });
          chmodSync(path, 0o600);
        },
        label: path,
      };
    } catch {
      return undefined;
    }
  }
  if (explicit) return undefined;
  const value = await readKeychain("Claude Code-credentials");
  if (!value) return undefined;
  try {
    const data = JSON.parse(value) as Record<string, unknown>;
    return {
      data,
      save: (next) => writeKeychain("Claude Code-credentials", JSON.stringify(next)),
      label: "keychain:Claude Code-credentials",
    };
  } catch {
    return undefined;
  }
}

function codexAuthPath(): string {
  if (process.env.JEVONIAN_CODEX_AUTH) return process.env.JEVONIAN_CODEX_AUTH;
  const base = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(base, "auth.json");
}

function readCodexCredential(): StoredCredential | undefined {
  const path = codexAuthPath();
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      data,
      save: async (next) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
      },
      label: path,
    };
  } catch {
    return undefined;
  }
}

function parseKeyringPayload(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  const payload = trimmed.startsWith("go-keyring-base64:")
    ? Buffer.from(trimmed.slice("go-keyring-base64:".length), "base64").toString("utf8")
    : trimmed;
  try {
    const data = JSON.parse(payload) as unknown;
    return typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function readAntigravityCredential(): Promise<StoredCredential | undefined> {
  const override = process.env.JEVONIAN_ANTIGRAVITY_TOKEN;
  if (override && override.trim().length > 0) {
    const path = override.trim();
    if (!existsSync(path)) return undefined;
    try {
      const data = parseKeyringPayload(readFileSync(path, "utf8"));
      if (!data) return undefined;
      return {
        data,
        save: async (next) => {
          writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
          chmodSync(path, 0o600);
        },
        label: path,
      };
    } catch {
      return undefined;
    }
  }
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      ANTIGRAVITY_KEYCHAIN_SERVICE,
      "-a",
      ANTIGRAVITY_KEYCHAIN_ACCOUNT,
      "-w",
    ]);
    const data = parseKeyringPayload(stdout);
    if (!data) return undefined;
    return {
      data,
      save: (next) =>
        writeKeychain(
          ANTIGRAVITY_KEYCHAIN_SERVICE,
          `go-keyring-base64:${Buffer.from(JSON.stringify(next)).toString("base64")}`,
          ANTIGRAVITY_KEYCHAIN_ACCOUNT,
        ),
      label: `keychain:${ANTIGRAVITY_KEYCHAIN_SERVICE}/${ANTIGRAVITY_KEYCHAIN_ACCOUNT}`,
    };
  } catch {
    return undefined;
  }
}

interface AntigravityTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
}

function antigravityTokens(data: Record<string, unknown>): AntigravityTokens | undefined {
  const token =
    typeof data.token === "object" && data.token !== null
      ? (data.token as Record<string, unknown>)
      : {};
  const accessToken = typeof token.access_token === "string" ? token.access_token : "";
  if (!accessToken) return undefined;
  const refreshToken = typeof token.refresh_token === "string" ? token.refresh_token : "";
  const expiry = typeof token.expiry === "string" ? Date.parse(token.expiry) : undefined;
  const expiresAt = expiry !== undefined && !Number.isNaN(expiry) ? expiry : undefined;
  return { accessToken, refreshToken, ...(expiresAt === undefined ? {} : { expiresAt }) };
}

async function refreshAntigravity(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number } | undefined> {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: refreshToken,
    });
    const response = await retryingFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) return undefined;
    const json = (await response.json()) as Record<string, unknown>;
    const accessToken = typeof json.access_token === "string" ? json.access_token : "";
    if (!accessToken) return undefined;
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    return { accessToken, expiresAt: Date.now() + expiresIn * 1000 };
  } catch {
    return undefined;
  }
}

async function resolveAntigravity(): Promise<OAuthToken | OAuthFailure> {
  const credential = await readAntigravityCredential();
  if (!credential) {
    return {
      error:
        "Antigravity credentials not found. Sign in with the Antigravity IDE or `agy` CLI, or set JEVONIAN_ANTIGRAVITY_TOKEN.",
    };
  }
  const tokens = antigravityTokens(credential.data);
  if (!tokens) {
    return { error: "Antigravity credential has an unexpected shape." };
  }
  if (tokens.expiresAt === undefined || tokens.expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return {
      token: tokens.accessToken,
      ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
    };
  }
  if (!tokens.refreshToken) {
    return {
      error: "Antigravity token is expired and has no refresh token. Run `agy` to sign in again.",
    };
  }
  const refreshed = await refreshAntigravity(tokens.refreshToken);
  if (!refreshed) {
    return { error: "Antigravity token refresh failed. Run `agy` to sign in again." };
  }
  const token =
    typeof credential.data.token === "object" && credential.data.token !== null
      ? (credential.data.token as Record<string, unknown>)
      : {};
  const next = {
    ...credential.data,
    token: {
      ...token,
      access_token: refreshed.accessToken,
      expiry: new Date(refreshed.expiresAt).toISOString(),
    },
  };
  if (credential.save) {
    try {
      await credential.save(next);
    } catch {
      // in-memory cache still carries the refreshed token
    }
  }
  return { token: refreshed.accessToken, expiresAt: refreshed.expiresAt };
}

export function resolveAntigravityProject(): string {
  const override = process.env.JEVONIAN_ANTIGRAVITY_PROJECT;
  if (override && override.trim().length > 0) return override.trim();
  try {
    const path = join(homedir(), ".gemini", "antigravity-cli", "cache", "default_project_id.txt");
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (value.length > 0) return value;
    }
  } catch {
    // fall through to the shared default
  }
  return "default-cli-project";
}

interface RefreshedClaude {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

async function refreshClaude(refreshToken: string): Promise<RefreshedClaude | undefined> {
  try {
    const response = await retryingFetch("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }),
    });
    if (!response.ok) return undefined;
    const json = (await response.json()) as Record<string, unknown>;
    const accessToken = typeof json.access_token === "string" ? json.access_token : "";
    if (!accessToken) return undefined;
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    return {
      accessToken,
      refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  } catch {
    return undefined;
  }
}

async function resolveClaude(): Promise<OAuthToken | OAuthFailure> {
  const credential = await readClaudeCredential();
  if (!credential) {
    return {
      error:
        "Claude Code credentials not found. Sign in with `claude` first, or point JEVONIAN_CLAUDE_CREDENTIALS at a credentials file.",
    };
  }
  const oauth = (credential.data.claudeAiOauth ?? {}) as Record<string, unknown>;
  const accessToken = typeof oauth.accessToken === "string" ? oauth.accessToken : "";
  const refreshToken = typeof oauth.refreshToken === "string" ? oauth.refreshToken : "";
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : jwtExpiry(accessToken);
  if (accessToken && (expiresAt === undefined || expiresAt - Date.now() > REFRESH_SKEW_MS)) {
    return { token: accessToken, ...(expiresAt === undefined ? {} : { expiresAt }) };
  }
  if (!refreshToken) {
    return {
      error:
        "Claude Code token is expired and has no refresh token. Run `claude` to sign in again.",
    };
  }
  const refreshed = await refreshClaude(refreshToken);
  if (!refreshed) {
    return { error: "Claude OAuth refresh failed. Run `claude` to sign in again." };
  }
  const next = {
    ...credential.data,
    claudeAiOauth: {
      ...oauth,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
    },
  };
  if (credential.save) {
    try {
      await credential.save(next);
    } catch {
      // in-memory cache still carries the refreshed token
    }
  }
  return { token: refreshed.accessToken, expiresAt: refreshed.expiresAt };
}

interface RefreshedCodex {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt?: number;
}

async function refreshCodex(refreshToken: string): Promise<RefreshedCodex | undefined> {
  try {
    const response = await retryingFetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: "openid profile email",
      }),
    });
    if (!response.ok) return undefined;
    const json = (await response.json()) as Record<string, unknown>;
    const accessToken = typeof json.access_token === "string" ? json.access_token : "";
    if (!accessToken) return undefined;
    return {
      accessToken,
      refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : refreshToken,
      ...(typeof json.id_token === "string" ? { idToken: json.id_token } : {}),
      ...(jwtExpiry(accessToken) === undefined ? {} : { expiresAt: jwtExpiry(accessToken) }),
    };
  } catch {
    return undefined;
  }
}

async function resolveCodex(): Promise<OAuthToken | OAuthFailure> {
  const credential = readCodexCredential();
  if (!credential) {
    return {
      error: "Codex credentials not found. Sign in with `codex` first, or set JEVONIAN_CODEX_AUTH.",
    };
  }
  const tokens = (credential.data.tokens ?? {}) as Record<string, unknown>;
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : "";
  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : "";
  const accountId = typeof tokens.account_id === "string" ? tokens.account_id : undefined;
  const expiresAt = accessToken ? jwtExpiry(accessToken) : undefined;
  if (accessToken && (expiresAt === undefined || expiresAt - Date.now() > REFRESH_SKEW_MS)) {
    return {
      token: accessToken,
      ...(accountId ? { accountId } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }
  if (!refreshToken) {
    return {
      error: "Codex token is expired and has no refresh token. Run `codex` to sign in again.",
    };
  }
  const refreshed = await refreshCodex(refreshToken);
  if (!refreshed) {
    return { error: "Codex OAuth refresh failed. Run `codex` to sign in again." };
  }
  const next = {
    ...credential.data,
    tokens: {
      ...tokens,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      ...(accountId ? { account_id: accountId } : {}),
      ...(refreshed.idToken ? { id_token: refreshed.idToken } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
  if (credential.save) {
    try {
      await credential.save(next);
    } catch {
      // in-memory cache still carries the refreshed token
    }
  }
  return {
    token: refreshed.accessToken,
    ...(accountId ? { accountId } : {}),
    ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
  };
}

export function invalidateOAuthToken(source: OAuthSource): void {
  cache.delete(source);
}

/**
 * Reports whether the local credential file for a live OAuth source exists and holds a token.
 * Used for status display only; it never hits the network.
 */
export function hasOAuthCredential(source: OAuthSource): boolean {
  if (source === "static") return false;
  if (source === "codex") return readCodexCredential() !== undefined;
  if (source === "antigravity") {
    const override = process.env.JEVONIAN_ANTIGRAVITY_TOKEN;
    if (override && existsSync(override.trim())) return true;
    return process.platform === "darwin";
  }
  if (process.env.JEVONIAN_CLAUDE_CREDENTIALS) {
    return existsSync(process.env.JEVONIAN_CLAUDE_CREDENTIALS);
  }
  if (existsSync(claudeCredentialsPath())) return true;
  return process.platform === "darwin";
}

export function resolveOAuthToken(options: {
  source: OAuthSource;
  staticToken?: string;
}): Promise<OAuthToken | OAuthFailure> {
  if (options.source === "static") {
    if (!options.staticToken) {
      return Promise.resolve({ error: "No OAuth token stored for this provider." });
    }
    return Promise.resolve({ token: options.staticToken });
  }
  const cached = cache.get(options.source);
  if (cached && fresh(cached)) return Promise.resolve(cached);
  const inflight = pending.get(options.source);
  if (inflight) return inflight;
  const resolve =
    options.source === "claude-code"
      ? resolveClaude
      : options.source === "codex"
        ? resolveCodex
        : resolveAntigravity;
  const task = resolve().then((result) => {
    if (!("error" in result)) cache.set(options.source, result);
    return result;
  });
  pending.set(options.source, task);
  void task.finally(() => pending.delete(options.source));
  return task;
}

export function oauthCredentialLabel(source: OAuthSource): string {
  if (source === "claude-code") return "Claude Code credentials";
  if (source === "codex") return "Codex credentials";
  if (source === "antigravity") return "Antigravity credentials";
  return "stored token";
}
