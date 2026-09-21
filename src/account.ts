import type { Context } from "hono";

import { LOCAL_CLIENT_KEYS } from "./local-client";
import { isDesktopRoutedModel } from "./routing";

/**
 * Endpoints a Codex/ChatGPT desktop client uses for account and session
 * bookkeeping. These are not model inference calls, so Jevonian must never
 * answer them itself: doing so is what leaves the app stuck on
 * "Loading sign-in requirements…".
 */
const ACCOUNT_PATHS = new Set([
  "/v1/me",
  "/v1/account",
  "/v1/account/usage",
  "/v1/usage",
  "/v1/subscription",
  "/v1/entitlements",
  "/v1/limits",
  "/v1/user",
  "/v1/organizations",
]);

/**
 * Detects an account/session probe from a desktop client. These requests carry
 * the ChatGPT account header rather than an API key, which is how the official
 * client separates "my subscription" traffic from "my API key" traffic.
 */
export function isAccountProbe(c: Context): boolean {
  const account = c.req.header("chatgpt-account-id");
  if (!account || account.trim() === "") return false;

  const path = c.req.path.replace(/\/+$/, "");
  if (ACCOUNT_PATHS.has(path)) return true;

  // Any non-inference path under /v1 coming from an account session is a
  // bookkeeping call; let the real backend answer it.
  return path.startsWith("/v1/") && !isInferencePath(path);
}

/** Endpoints Jevonian genuinely serves by routing to a configured provider. */
export function isInferencePath(path: string): boolean {
  return (
    path === "/v1/responses" ||
    path === "/v1/chat/completions" ||
    path === "/v1/messages" ||
    path === "/v1/messages/count_tokens" ||
    path === "/v1/models"
  );
}

/**
 * Proxies an account probe to the real ChatGPT backend so sign-in and
 * entitlement checks keep working while model traffic goes to Jevonian.
 *
 * Returns undefined when the upstream cannot be reached, letting the caller
 * fall through to its normal handling instead of masking the failure.
 */
export async function proxyAccountProbe(c: Context): Promise<Response | undefined> {
  const target = process.env.JEVONIAN_CHATGPT_UPSTREAM ?? "https://chatgpt.com";

  let url: URL;
  try {
    const incoming = new URL(c.req.url);
    url = new URL(`${incoming.pathname}${incoming.search}`, `${target.replace(/\/+$/, "")}/`);
  } catch {
    return undefined;
  }

  return proxyUpstream(c, url, undefined);
}

/**
 * True when a Codex/ChatGPT Desktop inference call named a native model that
 * should keep using OpenAI / the ChatGPT subscription — the Ollama Apps split.
 */
export function shouldProxyNativeCodex(
  model: string,
  headers: Headers,
): "chatgpt" | "openai" | false {
  if (isDesktopRoutedModel(model)) return false;

  const account = headers.get("chatgpt-account-id")?.trim();
  if (account) return "chatgpt";

  const auth = headers.get("authorization") ?? headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  if ((LOCAL_CLIENT_KEYS as readonly string[]).includes(token)) {
    // Sentinel-only sessions cannot call OpenAI; the user must be signed in.
    return false;
  }
  return "openai";
}

/**
 * Forwards a native Codex model request to ChatGPT or the OpenAI API with the
 * client's own credentials, matching Ollama's loopback router.
 */
export async function proxyNativeCodex(
  c: Context,
  route: "chatgpt" | "openai",
  body: Uint8Array,
): Promise<Response> {
  const chatgptBase =
    process.env.JEVONIAN_CHATGPT_CODEX_UPSTREAM ?? "https://chatgpt.com/backend-api/codex";
  const openaiBase = process.env.JEVONIAN_OPENAI_UPSTREAM ?? "https://api.openai.com/v1";

  const incoming = new URL(c.req.url);
  const path =
    route === "chatgpt"
      ? incoming.pathname.replace(/^\/v1(?=\/|$)/, "") || "/responses"
      : incoming.pathname;
  const base = route === "chatgpt" ? chatgptBase : openaiBase;
  const url = new URL(`${path}${incoming.search}`, `${base.replace(/\/+$/, "")}/`);

  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  // Body was already decoded from zstd when present; never claim compression.
  headers.delete("content-encoding");

  const auth = headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if ((LOCAL_CLIENT_KEYS as readonly string[]).includes(token)) {
    return c.json(
      {
        error: {
          message: "OpenAI models require signing in to ChatGPT or adding an OpenAI API key",
          type: "authentication_error",
        },
      },
      401,
    );
  }

  try {
    const response = await fetch(url, {
      method: c.req.method,
      headers,
      body,
      redirect: "manual",
    });
    const out = new Headers(response.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(response.body, { status: response.status, headers: out });
  } catch (error) {
    return c.json(
      {
        error: {
          message: `Native Codex upstream failed: ${error instanceof Error ? error.message : String(error)}`,
          type: "jevonian_error",
        },
      },
      502,
    );
  }
}

async function proxyUpstream(
  c: Context,
  url: URL,
  body: ArrayBuffer | undefined,
): Promise<Response | undefined> {
  const headers = new Headers(c.req.raw.headers);
  // The Host header must reflect the upstream, and hop-by-hop headers from the
  // loopback request must not be forwarded.
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");

  const method = c.req.method;
  const payload =
    body ??
    (method === "GET" || method === "HEAD"
      ? undefined
      : await c.req.raw.arrayBuffer().catch(() => undefined));

  try {
    const response = await fetch(url, { method, headers, body: payload, redirect: "manual" });
    // Re-wrap so Hono can stream the body without buffering it fully.
    const out = new Headers(response.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(response.body, { status: response.status, headers: out });
  } catch {
    return undefined;
  }
}
