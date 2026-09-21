import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono, type Context } from "hono";

import { isAccountProbe, proxyAccountProbe } from "./account";
import { createAdminApp, type AppState } from "./admin";
import { claudeGatewayModels, isClaudeGatewayRequest } from "./claude-gateway";
import { estimateTokens } from "./compaction";
import type { Config } from "./config";
import { hasKeys, keySpendUsd, tokenFromHeaders, verifyKey } from "./keys";
import { readRecords } from "./ledger";
import { isLocalClientRequest } from "./local-client";
import { SessionStore, clientModels, desktopModels } from "./routing";
import { handleAnthropic, handleOpenAI, handleResponses } from "./upstream";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function webDir(): string {
  return process.env.JEVONIAN_WEB_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "web");
}

function serveWebFile(path: string): Response | undefined {
  const root = webDir();
  const candidate = join(root, path === "/" ? "index.html" : path);
  if (!candidate.startsWith(root)) return undefined;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return undefined;
  const extension = candidate.slice(candidate.lastIndexOf("."));
  return new Response(readFileSync(candidate), {
    headers: { "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream" },
  });
}

/**
 * The models Jevonian advertises on its OpenAI-compatible listing.
 *
 * It advertises what it serves rather than everything its providers happen to carry.
 * A client that discovers models — ChatGPT Desktop's picker does — turns a provider-level
 * list into its own suggestions, which is how `gpt-6-astra`, `deepseek-v4-1-flash` and
 * `gemini-3-8-flash` ended up on a picker that was meant to offer `jevonian/auto`. With
 * routing on, the aliases are the surface. A caller that sends a specific provider id is
 * still routed, so this is only the advertised list; the full catalog remains on the
 * dashboard, which is where picking a raw model belongs.
 */
export function modelsPayload(config: Config): Array<Record<string, unknown>> {
  return clientModels(config).map((id) => ({ id, object: "model", owned_by: "jevonian" }));
}

/**
 * The model list in whichever dialect the caller speaks.
 *
 * `jevonian/*` is the whole point of the proxy, so the OpenAI shape is the
 * default. A gateway client (Claude Desktop's third-party mode) parses the
 * Anthropic page instead, and identifies itself with `anthropic-version`.
 */
function modelsResponse(config: Config, headers: Headers): Record<string, unknown> {
  // Claude Desktop's gateway picker only understands Claude stand-in ids. Feed it
  // the desktop inject list (jevonian/auto) so one slot covers Auto routing.
  if (isClaudeGatewayRequest(headers)) return claudeGatewayModels(desktopModels(config));
  return { object: "list", data: modelsPayload(config) };
}

/**
 * Anthropic's token counter. Claude Desktop asks before a turn to size its
 * context meter; answering with an estimate keeps that meter working instead of
 * showing a failed request.
 */
async function handleCountTokens(c: Context): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  }
  return c.json({ input_tokens: estimateTokens(JSON.stringify(body)) });
}

function lifecycleMiddleware(state: AppState) {
  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    if (state.lifecycle?.draining) {
      return c.json(
        {
          error: {
            message: "Jevonian is restarting after an update. Retry shortly.",
            type: "server_error",
          },
        },
        503,
        { "retry-after": "1" },
      );
    }
    const release = state.lifecycle?.beginRequest();
    try {
      await next();
      // Assign onto c.res — a returned Response after next() is ignored once the
      // handler has finalized the context, but trackResponse already locked the
      // original body. That left @hono/node-server calling getReader() on a locked
      // stream (ERR_INVALID_STATE: ReadableStream is locked).
      if (release) c.res = state.lifecycle!.trackResponse(c.res, release);
    } catch (error) {
      release?.();
      throw error;
    }
  };
}

export type AppEnv = {
  Variables: {
    keyId?: string;
    keyName?: string;
  };
};

export function createPublicApp(state: AppState, store: SessionStore): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (!hasKeys()) {
      return c.json(
        {
          error: {
            message: "No Jevonian API key exists yet. Create one in the dashboard first.",
            type: "invalid_request_error",
          },
        },
        401,
      );
    }
    const token = tokenFromHeaders(c.req.raw.headers);
    const key = verifyKey(token);
    if (!key) {
      return c.json({ error: { message: "Invalid API key.", type: "invalid_request_error" } }, 401);
    }
    if (key.limitUsd !== null && key.limitUsd !== undefined) {
      const currentSpend = keySpendUsd(key.id);
      if (currentSpend >= key.limitUsd) {
        return c.json(
          {
            error: {
              message: `Credit limit reached ($${key.limitUsd.toFixed(2)}) for API key "${key.name}". Increase or remove the limit in the Jevonian dashboard.`,
              type: "credit_limit_exceeded",
              code: "credit_limit_exceeded",
            },
          },
          429,
        );
      }
    }
    c.set("keyId", key.id);
    c.set("keyName", key.name);
    return next();
  });
  app.get("/healthz", (c) => c.json({ ok: true, public: true }));
  app.use("/v1/*", lifecycleMiddleware(state));
  app.all("/v1/*", async (c, next) => {
    if (isAccountProbe(c)) {
      const proxied = await proxyAccountProbe(c);
      if (proxied) return proxied;
    }
    return next();
  });
  app.get("/v1/models", (c) => c.json(modelsResponse(state.config, c.req.raw.headers)));
  app.post("/v1/chat/completions", (c) => handleOpenAI(c, state.config, store));
  app.post("/v1/messages", (c) => handleAnthropic(c, state.config, store));
  app.post("/v1/responses", (c) => handleResponses(c, state.config, store));
  app.all("*", (c) => c.notFound());
  return app;
}

/**
 * Detects a WebSocket upgrade request.
 *
 * A single `Upgrade: websocket` header is not enough: proxies and clients also
 * send it on ordinary requests. Ollama's Codex proxy requires the `Connection`
 * header to list `upgrade` as a token, and matching that behaviour keeps the
 * fallback signal identical to the one Codex already handles.
 */
export function isWebSocketUpgrade(headers: Headers): boolean {
  if ((headers.get("upgrade") ?? "").trim().toLowerCase() !== "websocket") return false;
  for (const raw of headers.get("connection")?.split(",") ?? []) {
    if (raw.trim().toLowerCase() === "upgrade") return true;
  }
  return false;
}

/**
 * Reads the peer address of the current request.
 *
 * `@hono/node-server` does not put the socket on the standard `Request`, so a
 * plain property lookup returns undefined. The Node `IncomingMessage` is
 * available at `c.env.incoming`, which is where the socket actually lives.
 * Falls back to the request's internal symbol so this keeps working if the
 * adapter changes how it stashes the inbound message.
 */
export function remoteAddressOf(c: Context): string | undefined {
  const incoming = c.env?.incoming as { socket?: { remoteAddress?: string } } | undefined;
  const fromEnv = incoming?.socket?.remoteAddress;
  if (fromEnv) return fromEnv;

  const request = c.req.raw as Request & Record<symbol, unknown>;
  for (const symbol of Object.getOwnPropertySymbols(request)) {
    const value = request[symbol] as { socket?: { remoteAddress?: string } } | undefined;
    const address = value?.socket?.remoteAddress;
    if (address) return address;
  }
  return undefined;
}

export function createApp(state: AppState, store: SessionStore): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/healthz", (c) =>
    c.json({ ok: true, sessions: store.size, routing: state.config.routing.mode }),
  );

  app.route("/api", createAdminApp(state));

  app.use("/v1/*", lifecycleMiddleware(state));

  app.use("/v1/*", async (c, next) => {
    if (!hasKeys()) {
      c.set("keyId", "unauthenticated");
      c.set("keyName", "unauthenticated");
      return next();
    }
    const token = tokenFromHeaders(c.req.raw.headers);
    const key = verifyKey(token);
    if (!key) {
      // Desktop clients (Codex, Claude Desktop) run on this machine and present
      // their own credential rather than a Jevonian key: a sentinel when
      // Jevonian created auth.json, or the user's real ChatGPT token once a
      // login exists. Accept either from a loopback peer only, so this can
      // never unlock a tunneled endpoint.
      const local = isLocalClientRequest({
        token,
        remoteAddress: remoteAddressOf(c),
        hasAccountId: Boolean(c.req.header("chatgpt-account-id")?.trim()),
        config: state.config,
      });
      if (local) {
        c.set("keyId", "local");
        c.set("keyName", "local desktop client");
        return next();
      }
      const port = state.config.listen.port;
      return c.json(
        {
          error: {
            message: `Invalid API key. Create one at http://127.0.0.1:${port}/keys`,
            type: "invalid_request_error",
          },
        },
        401,
      );
    }
    if (key.limitUsd !== null && key.limitUsd !== undefined) {
      const currentSpend = keySpendUsd(key.id);
      if (currentSpend >= key.limitUsd) {
        return c.json(
          {
            error: {
              message: `Credit limit reached ($${key.limitUsd.toFixed(2)}) for API key "${key.name}". Increase or remove the limit in the Jevonian dashboard.`,
              type: "credit_limit_exceeded",
              code: "credit_limit_exceeded",
            },
          },
          429,
        );
      }
    }
    c.set("keyId", key.id);
    c.set("keyName", key.name);
    return next();
  });

  app.get("/v1/models", (c) => c.json(modelsResponse(state.config, c.req.raw.headers)));

  app.all("/v1/*", async (c, next) => {
    // Codex prefers a WebSocket transport for /v1/responses. Jevonian only
    // implements the HTTP Responses transport, and a bare 404 makes the client
    // give up ("unexpected status 404"). 426 Upgrade Required is the signal
    // Codex reads as "fall back to HTTP for the whole session", which is how
    // Ollama's proxy steers it onto the per-request routing path.
    if (isWebSocketUpgrade(c.req.raw.headers)) {
      return c.json({ error: { message: "Jevonian uses the HTTP Responses transport." } }, 426);
    }

    // Account and session probes must reach the real backend; answering them
    // here is what leaves desktop clients stuck on sign-in.
    if (isAccountProbe(c)) {
      const proxied = await proxyAccountProbe(c);
      if (proxied) return proxied;
    }
    return next();
  });

  app.post("/v1/chat/completions", (c) => handleOpenAI(c, state.config, store));
  app.post("/v1/messages", (c) => handleAnthropic(c, state.config, store));
  app.post("/v1/messages/count_tokens", (c) => handleCountTokens(c));
  app.post("/v1/responses", (c) => handleResponses(c, state.config, store));

  app.get("/stats", (c) => {
    const records = readRecords();
    const costUsd = records.reduce((total, item) => total + (item.costUsd ?? 0), 0);
    const cacheRead = records.reduce((total, item) => total + item.cacheReadTokens, 0);
    const prompt = records.reduce((total, item) => total + item.promptTokens, 0);
    return c.json({
      requests: records.length,
      sessions: store.size,
      costUsd: Number(costUsd.toFixed(6)),
      cacheReadTokens: cacheRead,
      promptTokens: prompt,
    });
  });

  app.get("*", (c) => {
    const path = c.req.path;
    if (path.startsWith("/api") || path.startsWith("/v1")) return c.notFound();
    const webDev = process.env.JEVONIAN_WEB_DEV;
    if (webDev) return c.redirect(`${webDev.replace(/\/+$/, "")}${path}`);
    const file = serveWebFile(path);
    if (file) return file;
    const index = serveWebFile("/");
    if (index) return index;
    return c.html(
      '<!doctype html><meta charset="utf-8"><title>Jevonian</title><h1>Jevonian</h1><p>The web UI is not built. Run <code>pnpm dev</code> for live reload or <code>pnpm build</code> for production.</p>',
    );
  });

  return app;
}
