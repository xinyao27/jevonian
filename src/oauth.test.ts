import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { invalidateOAuthToken, resolveOAuthToken, type OAuthFailure } from "./oauth";

let dir = "";
let claudePath = "";
let codexPath = "";
let previousClaude: string | undefined;
let previousCodex: string | undefined;
let previousAntigravity: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-oauth-"));
  claudePath = join(dir, "claude-credentials.json");
  codexPath = join(dir, "codex-auth.json");
  previousClaude = process.env.JEVONIAN_CLAUDE_CREDENTIALS;
  previousCodex = process.env.JEVONIAN_CODEX_AUTH;
  previousAntigravity = process.env.JEVONIAN_ANTIGRAVITY_TOKEN;
  process.env.JEVONIAN_CLAUDE_CREDENTIALS = claudePath;
  process.env.JEVONIAN_CODEX_AUTH = codexPath;
});

afterEach(() => {
  invalidateOAuthToken("claude-code");
  invalidateOAuthToken("codex");
  invalidateOAuthToken("antigravity");
  if (previousClaude === undefined) delete process.env.JEVONIAN_CLAUDE_CREDENTIALS;
  else process.env.JEVONIAN_CLAUDE_CREDENTIALS = previousClaude;
  if (previousCodex === undefined) delete process.env.JEVONIAN_CODEX_AUTH;
  else process.env.JEVONIAN_CODEX_AUTH = previousCodex;
  if (previousAntigravity === undefined) delete process.env.JEVONIAN_ANTIGRAVITY_TOKEN;
  else process.env.JEVONIAN_ANTIGRAVITY_TOKEN = previousAntigravity;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function jwt(expSeconds: number): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ exp: expSeconds })}.sig`;
}

function failure(result: { token?: string } | OAuthFailure): OAuthFailure {
  if ("error" in result) return result;
  throw new Error(`expected failure, got ${result.token ?? "token"}`);
}

describe("Claude Code credentials", () => {
  it("uses a fresh access token without refreshing", async () => {
    writeFileSync(
      claudePath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fresh-token",
          refreshToken: "refresh-1",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    );
    vi.stubGlobal("fetch", async () => {
      throw new Error("should not refresh a fresh token");
    });
    const result = await resolveOAuthToken({ source: "claude-code" });
    expect("token" in result && result.token).toBe("fresh-token");
  });

  it("refreshes an expired token and writes it back", async () => {
    writeFileSync(
      claudePath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "old-token",
          refreshToken: "refresh-1",
          expiresAt: Date.now() - 1_000,
        },
      }),
    );
    let requestedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      requestedUrl = url;
      return new Response(
        JSON.stringify({ access_token: "new-token", refresh_token: "refresh-2", expires_in: 3600 }),
        { status: 200 },
      );
    });
    const result = await resolveOAuthToken({ source: "claude-code" });
    expect(requestedUrl).toBe("https://console.anthropic.com/v1/oauth/token");
    expect("token" in result && result.token).toBe("new-token");
    const written = JSON.parse(readFileSync(claudePath, "utf8")) as {
      claudeAiOauth: { accessToken: string; refreshToken: string };
    };
    expect(written.claudeAiOauth.accessToken).toBe("new-token");
    expect(written.claudeAiOauth.refreshToken).toBe("refresh-2");
  });

  it("reports missing credentials", async () => {
    const result = await resolveOAuthToken({ source: "claude-code" });
    expect(failure(result).error).toContain("Claude Code credentials not found");
  });
});

describe("Antigravity credentials", () => {
  it("reads the keyring payload and refreshes an expired token", async () => {
    const path = join(dir, "antigravity.json");
    writeFileSync(
      path,
      JSON.stringify({
        token: {
          access_token: "old",
          refresh_token: "refresh-1",
          expiry: new Date(Date.now() - 60_000).toISOString(),
        },
        auth_method: "consumer",
      }),
    );
    previousAntigravity = process.env.JEVONIAN_ANTIGRAVITY_TOKEN;
    process.env.JEVONIAN_ANTIGRAVITY_TOKEN = path;
    let requestedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ access_token: "new-token", expires_in: 3600 }), {
        status: 200,
      });
    });
    const result = await resolveOAuthToken({ source: "antigravity" });
    expect(requestedUrl).toBe("https://oauth2.googleapis.com/token");
    expect("token" in result && result.token).toBe("new-token");
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      token: { access_token: string; refresh_token: string };
    };
    expect(written.token.access_token).toBe("new-token");
    expect(written.token.refresh_token).toBe("refresh-1");
  });

  it("uses a fresh access token without refreshing", async () => {
    const path = join(dir, "antigravity-fresh.json");
    writeFileSync(
      path,
      JSON.stringify({
        token: {
          access_token: "fresh",
          refresh_token: "refresh-1",
          expiry: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }),
    );
    previousAntigravity = process.env.JEVONIAN_ANTIGRAVITY_TOKEN;
    process.env.JEVONIAN_ANTIGRAVITY_TOKEN = path;
    vi.stubGlobal("fetch", async () => {
      throw new Error("should not refresh a fresh token");
    });
    const result = await resolveOAuthToken({ source: "antigravity" });
    expect("token" in result && result.token).toBe("fresh");
  });
});

describe("Codex credentials", () => {
  it("reads the token and account id from auth.json", async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 3_600);
    writeFileSync(
      codexPath,
      JSON.stringify({
        tokens: { access_token: token, refresh_token: "refresh-1", account_id: "acct_1" },
      }),
    );
    vi.stubGlobal("fetch", async () => {
      throw new Error("should not refresh a fresh token");
    });
    const result = await resolveOAuthToken({ source: "codex" });
    expect("token" in result && result.token).toBe(token);
    expect("token" in result && result.accountId).toBe("acct_1");
  });

  it("refreshes an expired token and stores the rotation", async () => {
    const expired = jwt(Math.floor(Date.now() / 1000) - 10);
    const fresh = jwt(Math.floor(Date.now() / 1000) + 3_600);
    writeFileSync(
      codexPath,
      JSON.stringify({
        tokens: { access_token: expired, refresh_token: "refresh-1", account_id: "acct_1" },
      }),
    );
    let requestedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ access_token: fresh, refresh_token: "refresh-2" }), {
        status: 200,
      });
    });
    const result = await resolveOAuthToken({ source: "codex" });
    expect(requestedUrl).toBe("https://auth.openai.com/oauth/token");
    expect("token" in result && result.token).toBe(fresh);
    expect("token" in result && result.accountId).toBe("acct_1");
    const written = JSON.parse(readFileSync(codexPath, "utf8")) as {
      tokens: { access_token: string; refresh_token: string };
      last_refresh: string;
    };
    expect(written.tokens.access_token).toBe(fresh);
    expect(written.tokens.refresh_token).toBe("refresh-2");
    expect(typeof written.last_refresh).toBe("string");
  });
});
