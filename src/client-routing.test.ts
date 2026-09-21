import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isAccountProbe } from "./account";
import { applyChatGpt, MANAGED_MARKER, restoreChatGpt } from "./clients";
import type { Config } from "./config";
import { isLocalClientRequest, isLoopbackOrigin, LOCAL_CLIENT_KEYS } from "./local-client";
import { isVirtualModel, VIRTUAL_MODELS } from "./routing";
import { remoteAddressOf, isWebSocketUpgrade } from "./server";

function config(host: string): Config {
  return { listen: { host, port: 8787 } } as Config;
}

describe("isLoopbackOrigin", () => {
  it("accepts loopback in every form Node reports", () => {
    expect(isLoopbackOrigin("127.0.0.1")).toBe(true);
    expect(isLoopbackOrigin("::1")).toBe(true);
    expect(isLoopbackOrigin("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackOrigin("127.0.0.5")).toBe(true);
  });

  it("rejects remote and unknown peers", () => {
    expect(isLoopbackOrigin("192.168.1.10")).toBe(false);
    expect(isLoopbackOrigin("::ffff:8.8.8.8")).toBe(false);
    expect(isLoopbackOrigin(undefined)).toBe(false);
    expect(isLoopbackOrigin("")).toBe(false);
  });
});

describe("isLocalClientRequest", () => {
  /** A sentinel request from a given peer against a loopback-bound server. */
  const sentinel = (token: string, remote: string | undefined, host = "127.0.0.1") =>
    isLocalClientRequest({
      token,
      remoteAddress: remote,
      hasAccountId: false,
      config: config(host),
    });

  /** An account-session request, as Codex sends once a real login exists. */
  const account = (remote: string | undefined, host = "127.0.0.1") =>
    isLocalClientRequest({
      token: "a-real-chatgpt-token",
      remoteAddress: remote,
      hasAccountId: true,
      config: config(host),
    });

  it("accepts a sentinel from loopback on a loopback-bound server", () => {
    expect(sentinel("jevonian-local", "127.0.0.1")).toBe(true);
    expect(sentinel("ollama-local-codex", "::1")).toBe(true);
    expect(sentinel("ollama", "::ffff:127.0.0.1", "localhost")).toBe(true);
  });

  it("accepts a ChatGPT account session from loopback", () => {
    // The normal path once auth.json holds a real login: the token is the
    // user's own ChatGPT credential, which is never a Jevonian key.
    expect(account("127.0.0.1")).toBe(true);
    expect(account("::1")).toBe(true);
  });

  it("rejects a sentinel arriving from a remote peer", () => {
    // The critical case: a tunneled request must never use the sentinel.
    expect(sentinel("jevonian-local", "203.0.113.7")).toBe(false);
  });

  it("rejects an account session arriving from a remote peer", () => {
    // Otherwise anyone could reach the tunnel by sending a bogus account header.
    expect(account("203.0.113.7")).toBe(false);
    expect(account("::ffff:8.8.8.8")).toBe(false);
  });

  it("rejects the sentinel when the server is bound to all interfaces", () => {
    // 0.0.0.0 accepts LAN traffic, so the sentinel would be a public bypass.
    expect(sentinel("jevonian-local", "127.0.0.1", "0.0.0.0")).toBe(false);
    expect(sentinel("jevonian-local", "127.0.0.1", "::")).toBe(false);
    expect(account("127.0.0.1", "0.0.0.0")).toBe(false);
  });

  it("never accepts a real-looking key or empty token as a sentinel", () => {
    expect(sentinel("sk-jev-deadbeef", "127.0.0.1")).toBe(false);
    expect(sentinel("", "127.0.0.1")).toBe(false);
    expect(sentinel("a-real-chatgpt-token", "127.0.0.1")).toBe(false);
  });

  it("recognizes every declared sentinel", () => {
    for (const key of LOCAL_CLIENT_KEYS) {
      expect(sentinel(key, "127.0.0.1")).toBe(true);
    }
  });
});

describe("isAccountProbe", () => {
  const probe = (path: string, headers: Record<string, string> = {}) =>
    ({ req: { path, header: (name: string) => headers[name.toLowerCase()] } }) as never;

  it("detects account endpoints carrying the ChatGPT account header", () => {
    const headers = { "chatgpt-account-id": "acct-1" };
    expect(isAccountProbe(probe("/v1/me", headers))).toBe(true);
    expect(isAccountProbe(probe("/v1/subscription", headers))).toBe(true);
  });

  it("never claims inference paths even with an account header", () => {
    // A Codex model call carries the account header too; proxying it to
    // chatgpt.com would bypass Jevonian's routing entirely.
    const headers = { "chatgpt-account-id": "acct-1" };
    expect(isAccountProbe(probe("/v1/responses", headers))).toBe(false);
    expect(isAccountProbe(probe("/v1/chat/completions", headers))).toBe(false);
    expect(isAccountProbe(probe("/v1/messages", headers))).toBe(false);
    expect(isAccountProbe(probe("/v1/models", headers))).toBe(false);
  });

  it("ignores requests without an account header", () => {
    expect(isAccountProbe(probe("/v1/me"))).toBe(false);
    expect(isAccountProbe(probe("/v1/me", { "chatgpt-account-id": "  " }))).toBe(false);
  });
});

describe("shouldProxyNativeCodex", () => {
  it("keeps jevonian models on the local router", async () => {
    const { shouldProxyNativeCodex } = await import("./account");
    expect(shouldProxyNativeCodex("jevonian/auto", new Headers())).toBe(false);
    expect(shouldProxyNativeCodex("auto", new Headers({ "chatgpt-account-id": "a" }))).toBe(false);
  });

  it("forwards native models to ChatGPT when an account session is present", async () => {
    const { shouldProxyNativeCodex } = await import("./account");
    expect(
      shouldProxyNativeCodex("gpt-5.6-sol", new Headers({ "chatgpt-account-id": "acct-1" })),
    ).toBe("chatgpt");
  });

  it("forwards native models to OpenAI when a real API key is present", async () => {
    const { shouldProxyNativeCodex } = await import("./account");
    expect(
      shouldProxyNativeCodex("gpt-5.6-sol", new Headers({ authorization: "Bearer sk-test" })),
    ).toBe("openai");
  });

  it("refuses to treat the loopback sentinel as an OpenAI credential", async () => {
    const { shouldProxyNativeCodex } = await import("./account");
    expect(
      shouldProxyNativeCodex(
        "gpt-5.6-sol",
        new Headers({ authorization: "Bearer jevonian-local" }),
      ),
    ).toBe(false);
  });
});

describe("isWebSocketUpgrade", () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  it("detects a real websocket upgrade", () => {
    expect(isWebSocketUpgrade(headers({ upgrade: "websocket", connection: "Upgrade" }))).toBe(true);
    // Header casing and token lists vary by client.
    expect(
      isWebSocketUpgrade(headers({ Upgrade: "WebSocket", Connection: "keep-alive, Upgrade" })),
    ).toBe(true);
  });

  it("requires Connection to list upgrade, not just the Upgrade header", () => {
    // A stray `Upgrade: websocket` with no Connection token must not divert a
    // normal HTTP request into the 426 fallback path.
    expect(isWebSocketUpgrade(headers({ upgrade: "websocket" }))).toBe(false);
    expect(isWebSocketUpgrade(headers({ upgrade: "websocket", connection: "keep-alive" }))).toBe(
      false,
    );
  });

  it("ignores ordinary requests", () => {
    expect(isWebSocketUpgrade(headers({ connection: "keep-alive" }))).toBe(false);
    expect(isWebSocketUpgrade(headers({}))).toBe(false);
  });
});

describe("remoteAddressOf", () => {
  const context = (env: unknown, request: unknown = {}) =>
    ({ env, req: { raw: request } }) as never;

  it("reads the peer address from the node adapter's incoming message", () => {
    // @hono/node-server exposes the socket here, not on the Request itself.
    expect(remoteAddressOf(context({ incoming: { socket: { remoteAddress: "127.0.0.1" } } }))).toBe(
      "127.0.0.1",
    );
    expect(remoteAddressOf(context({ incoming: { socket: { remoteAddress: "::1" } } }))).toBe(
      "::1",
    );
    expect(
      remoteAddressOf(context({ incoming: { socket: { remoteAddress: "203.0.113.7" } } })),
    ).toBe("203.0.113.7");
  });

  it("falls back to the request's internal symbol when env is unavailable", () => {
    const key = Symbol("incomingKey");
    const request = { [key]: { socket: { remoteAddress: "127.0.0.1" } } };
    expect(remoteAddressOf(context(undefined, request))).toBe("127.0.0.1");
  });

  it("returns undefined instead of throwing when nothing is available", () => {
    // A silent undefined disables the sentinel bypass, so this must stay
    // explicit rather than becoming a crash.
    expect(remoteAddressOf(context(undefined))).toBeUndefined();
    expect(remoteAddressOf(context({}))).toBeUndefined();
    expect(remoteAddressOf(context({ incoming: {} }))).toBeUndefined();
    expect(remoteAddressOf(context({ incoming: { socket: {} } }))).toBeUndefined();
  });
});

describe("desktop client model list", () => {
  it("advertises Jevonian's routing aliases, not upstream model names", () => {
    // Direct `/v1/models` clients still see phase aliases. Desktop inject is Auto-only.
    for (const alias of VIRTUAL_MODELS) expect(alias.startsWith("jevonian/")).toBe(true);
    expect(VIRTUAL_MODELS).toContain("jevonian/auto");
  });

  it("treats the aliases as virtual so routing accepts them", () => {
    expect(isVirtualModel("jevonian/auto")).toBe(true);
    expect(isVirtualModel("auto")).toBe(true);
    expect(isVirtualModel("jevonian/plan")).toBe(true);
    expect(isVirtualModel("deepseek-v4-1-flash")).toBe(false);
  });

  it("injects only jevonian/auto into desktop pickers", async () => {
    const { desktopModels, isDesktopRoutedModel } = await import("./routing");
    const { parseConfig } = await import("./config");
    const config = parseConfig({
      providers: [
        {
          name: "sub",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "test",
          models: ["m"],
        },
      ],
      routing: { mode: "auto", tiers: { plan: ["m"] } },
    });
    expect(desktopModels(config)).toEqual(["jevonian/auto"]);
    expect(isDesktopRoutedModel("jevonian/auto")).toBe(true);
    expect(isDesktopRoutedModel("gpt-5.6-sol")).toBe(false);
  });

  it("writes a sentinel the server actually accepts", () => {
    // The sentinel goes into Codex's auth.json and Claude Desktop's profile, and
    // both clients then present it to Jevonian. A value the middleware does not
    // recognise makes the app report the gateway as refused — Claude Desktop's
    // connection test shows it as "Gateway /v1/models returned HTTP 401" — which
    // reads as a credential problem rather than a mismatched placeholder.
    expect(LOCAL_CLIENT_KEYS).toContain(MANAGED_MARKER);
  });
});

describe("codex auth safety", () => {
  let home: string;
  let codexDir: string;

  beforeEach(() => {
    // applyChatGpt resolves paths from HOME, so isolate the real ~/.codex.
    home = mkdtempSync(join(tmpdir(), "jev-codex-"));
    codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("JEVONIAN_DATA_DIR", join(home, "data"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const authPath = () => join(codexDir, "auth.json");

  it("never overwrites an existing ChatGPT login", () => {
    // The real failure: a login holds a refresh token that cannot be
    // regenerated without signing in again. It must survive applyChatGpt.
    const login = { auth_mode: "chatgpt", tokens: { refresh_token: "rt-secret" } };
    writeFileSync(authPath(), JSON.stringify(login));

    applyChatGpt({ port: 8787, models: ["jevonian/auto"] });

    expect(JSON.parse(readFileSync(authPath(), "utf8"))).toEqual(login);
  });

  it("creates the sentinel only when no auth file exists", () => {
    applyChatGpt({ port: 8787, models: ["jevonian/auto"] });

    const created = JSON.parse(readFileSync(authPath(), "utf8"));
    expect(created.auth_mode).toBe("apikey");
    expect(created.OPENAI_API_KEY).toBe("jevonian-local");
  });

  it("advertises image input so ChatGPT does not reject attachments", () => {
    applyChatGpt({ port: 8787, models: ["jevonian/auto"] });
    const catalog = JSON.parse(readFileSync(join(codexDir, "jevonian-models.json"), "utf8")) as {
      models: Array<{
        slug: string;
        input_modalities: string[];
        supports_image_detail_original: boolean;
        supported_in_api: boolean;
      }>;
    };
    const injected = catalog.models.find((model) => model.slug === "jevonian/auto");
    expect(injected).toBeDefined();
    expect(injected?.input_modalities).toEqual(["text", "image"]);
    expect(injected?.supports_image_detail_original).toBe(true);
    expect(injected?.supported_in_api).toBe(true);
  });

  it("merges native Codex models into the picker as ChatGPT-only rows", () => {
    writeFileSync(
      join(codexDir, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6-Sol",
            visibility: "list",
            supported_in_api: true,
            priority: 1,
            input_modalities: ["text", "image"],
          },
        ],
      }),
    );

    applyChatGpt({ port: 8787, models: ["jevonian/auto"] });

    const catalog = JSON.parse(readFileSync(join(codexDir, "jevonian-models.json"), "utf8")) as {
      models: Array<{ slug: string; supported_in_api: boolean; priority: number }>;
    };
    expect(catalog.models.map((model) => model.slug)).toEqual(["jevonian/auto", "gpt-5.6-sol"]);
    expect(catalog.models[0]?.supported_in_api).toBe(true);
    expect(catalog.models[1]?.supported_in_api).toBe(false);
    // Injected Auto sorts above natives (lower priority number).
    expect(catalog.models[0]!.priority).toBeLessThan(catalog.models[1]!.priority);

    const routing = JSON.parse(
      readFileSync(join(codexDir, "jevonian-codex-routing.json"), "utf8"),
    ) as { models: Array<{ slug: string }> };
    expect(routing.models).toEqual([{ slug: "jevonian/auto" }]);
  });

  it("keeps a login when restoring, and removes only its own sentinel", () => {
    const login = { auth_mode: "chatgpt", tokens: { refresh_token: "rt-secret" } };
    writeFileSync(authPath(), JSON.stringify(login));

    applyChatGpt({ port: 8787, models: ["jevonian/auto"] });
    restoreChatGpt();

    // The login was never touched, so it is still there.
    expect(JSON.parse(readFileSync(authPath(), "utf8"))).toEqual(login);
  });

  it("deletes the sentinel on restore when it created the file", () => {
    applyChatGpt({ port: 8787, models: ["jevonian/auto"] });
    expect(existsSync(authPath())).toBe(true);

    restoreChatGpt();

    // Jevonian's own placeholder must not be left behind as a fake login.
    expect(existsSync(authPath())).toBe(false);
  });
});
