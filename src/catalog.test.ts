import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { codexModelsCachePath, discoverProviderModels, localCodexModels } from "./catalog";
import { parseConfig } from "./config";
import { invalidateOAuthToken } from "./oauth";

let dir = "";
let previousHome: string | undefined;
let previousToken: string | undefined;
let previousProject: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-catalog-"));
  previousHome = process.env.CODEX_HOME;
  previousToken = process.env.JEVONIAN_ANTIGRAVITY_TOKEN;
  previousProject = process.env.JEVONIAN_ANTIGRAVITY_PROJECT;
  process.env.CODEX_HOME = dir;
});

afterEach(() => {
  invalidateOAuthToken("antigravity");
  vi.unstubAllGlobals();
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  if (previousToken === undefined) delete process.env.JEVONIAN_ANTIGRAVITY_TOKEN;
  else process.env.JEVONIAN_ANTIGRAVITY_TOKEN = previousToken;
  if (previousProject === undefined) delete process.env.JEVONIAN_ANTIGRAVITY_PROJECT;
  else process.env.JEVONIAN_ANTIGRAVITY_PROJECT = previousProject;
  rmSync(dir, { recursive: true, force: true });
});

describe("localCodexModels", () => {
  it("returns undefined when Codex has no cache", () => {
    expect(localCodexModels()).toBeUndefined();
  });

  it("reads visible API models in priority order", () => {
    writeFileSync(
      codexModelsCachePath(),
      JSON.stringify({
        fetched_at: "2026-09-19T06:26:01.867551Z",
        models: [
          { slug: "gpt-5.6-luna", visibility: "list", supported_in_api: true, priority: 2 },
          { slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true, priority: 1 },
          { slug: "gpt-reserve", visibility: "hidden", supported_in_api: true, priority: 3 },
          { slug: "internal-only", visibility: "list", supported_in_api: false, priority: 4 },
        ],
      }),
    );
    expect(localCodexModels()).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);
  });

  it("tolerates an empty or malformed cache", () => {
    writeFileSync(codexModelsCachePath(), JSON.stringify({ models: [] }));
    expect(localCodexModels()).toBeUndefined();
    writeFileSync(codexModelsCachePath(), "{ not json");
    expect(localCodexModels()).toBeUndefined();
  });
});

describe("discoverProviderModels for Antigravity", () => {
  it("reads models through fetchAvailableModels and filters internal entries", async () => {
    const path = join(dir, "antigravity.json");
    writeFileSync(
      path,
      JSON.stringify({
        token: {
          access_token: "token",
          refresh_token: "refresh",
          expiry: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }),
    );
    process.env.JEVONIAN_ANTIGRAVITY_TOKEN = path;
    process.env.JEVONIAN_ANTIGRAVITY_PROJECT = "proj-1";
    let captured: { url: string; body: unknown; headers: Headers } | undefined;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      captured = {
        url,
        body: JSON.parse(init.body as string) as unknown,
        headers: new Headers(init.headers),
      };
      return new Response(
        JSON.stringify({
          models: {
            "gemini-3-flash": { displayName: "Gemini 3 Flash" },
            "gemini-3.8-flash-tiered": { recommended: true, maxOutputTokens: 65536 },
            "gemini-3.6-flash-tiered": { recommended: true },
            tab_flash_lite_preview: {},
            chat_20706: { isInternal: true },
            "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6" },
          },
        }),
        { status: 200 },
      );
    });
    const config = parseConfig({
      providers: [
        {
          name: "antigravity",
          type: "gemini",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          auth: "oauth",
          oauthSource: "antigravity",
          billing: "subscription",
          models: [],
        },
      ],
    });
    const provider = config.providers[0];
    if (!provider) throw new Error("missing provider");
    const entry = await discoverProviderModels(provider);
    expect(entry.error).toBeUndefined();
    expect(entry.models).toEqual([
      "gemini-3-flash",
      "gemini-3.8-flash-tiered",
      "gemini-3.6-flash-tiered",
      "claude-sonnet-4-6",
    ]);
    expect(captured?.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    );
    expect(captured?.body).toEqual({ project: "proj-1" });
    expect(captured?.headers.get("authorization")).toBe("Bearer token");
  });
});
