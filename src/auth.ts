import { resolveApiKey, type Provider } from "./config";
import { resolveAntigravityProject, resolveOAuthToken } from "./oauth";

export interface AuthResolution {
  headers: Record<string, string>;
  error?: string;
  project?: string;
}

function antigravityPlatform(): string {
  if (process.platform === "darwin") return "darwin/arm64";
  if (process.platform === "win32") return "windows/amd64";
  return "linux/amd64";
}

function mergeBeta(existing: string | undefined, beta: string): string {
  if (!existing) return beta;
  const parts = existing
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.includes(beta)) return parts.join(",");
  return [...parts, beta].join(",");
}

const OPENROUTER_APP_URL = "https://github.com/xinyao27/jevonian";
const OPENROUTER_APP_TITLE = "Jevonian";

function hostMatches(baseUrl: string, suffix: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === suffix || host.endsWith(`.${suffix}`);
  } catch {
    return false;
  }
}

/**
 * OpenRouter uses `HTTP-Referer` and `X-Title` for app attribution.
 *
 * Add them whenever a request goes to OpenRouter, including model discovery and balance
 * checks, so OpenRouter's activity view attributes every call to Jevonian. Provider headers
 * win because a caller may need to identify a specific integration surface.
 */
export function withOpenRouterAttribution(
  headers: Record<string, string>,
  baseUrl: string,
): Record<string, string> {
  if (!hostMatches(baseUrl, "openrouter.ai")) return headers;
  if (headers["HTTP-Referer"] === undefined && headers["http-referer"] === undefined) {
    headers["HTTP-Referer"] = OPENROUTER_APP_URL;
  }
  if (headers["X-Title"] === undefined && headers["x-title"] === undefined) {
    headers["X-Title"] = OPENROUTER_APP_TITLE;
  }
  return headers;
}

function claudeHeaders(headers: Record<string, string>, provider: Provider, token: string): void {
  if (provider.auth === "oauth") {
    headers.authorization = `Bearer ${token}`;
    headers["anthropic-beta"] = mergeBeta(provider.headers?.["anthropic-beta"], "oauth-2025-04-20");
    // Anthropic gates subscription models on the Claude Code version in User-Agent, so a
    // stale version here hides newer models. Bump it when a new model is refused on OAuth;
    // operators can override per provider via `headers["user-agent"]`.
    headers["user-agent"] =
      provider.headers?.["user-agent"] ?? "claude-cli/2.1.280 (external, cli)";
  } else {
    headers["x-api-key"] = token;
    if (provider.type === "both") headers.authorization = `Bearer ${token}`;
  }
  headers["anthropic-version"] ??= "2023-06-01";
}

function codexHeaders(
  headers: Record<string, string>,
  token: string,
  accountId: string | undefined,
): void {
  headers.authorization = `Bearer ${token}`;
  if (accountId) headers["chatgpt-account-id"] = accountId;
  headers.originator ??= "codex_cli_rs";
  headers["openai-beta"] ??= "responses=experimental";
  headers["user-agent"] ??= "codex_cli_rs/0.114.0";
}

export function withSessionAffinity(
  headers: Record<string, string>,
  provider: Provider,
  session: string,
  incoming: Record<string, string | undefined>,
): void {
  if (!provider.baseUrl.includes("opencode.ai")) return;
  headers["x-opencode-session"] ??= incoming["x-opencode-session"] ?? session;
}

export async function resolveProviderAuth(
  provider: Provider,
  kind: "openai" | "anthropic" | "responses" = "openai",
): Promise<AuthResolution> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...provider.headers,
  };
  let token: string | undefined;
  let accountId: string | undefined;

  if (provider.auth === "oauth") {
    if (provider.oauthSource && provider.oauthSource !== "static") {
      const resolved = await resolveOAuthToken({ source: provider.oauthSource });
      if ("error" in resolved) return { headers: {}, error: resolved.error };
      token = resolved.token;
      accountId = resolved.accountId;
    } else {
      token = resolveApiKey(provider);
      if (!token) {
        return { headers: {}, error: `Missing OAuth token for provider "${provider.name}"` };
      }
    }
  } else {
    token = resolveApiKey(provider);
    if (!token) {
      return { headers: {}, error: `Missing API key for provider "${provider.name}"` };
    }
  }

  const anthropicWire =
    provider.type === "anthropic" || (provider.type === "both" && kind === "anthropic");
  if (anthropicWire) {
    claudeHeaders(headers, provider, token);
  } else if (provider.type === "responses" && provider.auth === "oauth") {
    codexHeaders(headers, token, accountId);
  } else {
    headers.authorization = `Bearer ${token}`;
  }

  withOpenRouterAttribution(headers, provider.baseUrl);

  if (provider.type === "gemini") {
    headers["user-agent"] ??= `antigravity/1.15.8 ${antigravityPlatform()}`;
    headers["x-goog-api-client"] ??= "google-cloud-sdk vscode_cloudshelleditor/0.1";
    headers["client-metadata"] ??= JSON.stringify({
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    });
    return { headers, project: resolveAntigravityProject() };
  }
  return { headers };
}
