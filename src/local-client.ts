import type { Config, Provider } from "./config";
import { resolveApiKey } from "./config";

/**
 * Sentinel credentials used by desktop clients that are configured to talk to
 * a loopback Jevonian instance.
 *
 * Desktop apps cannot be given a real `sk-jev-...` key: the header they send is
 * derived from their own upstream credentials (a ChatGPT account token for
 * Codex, a placeholder for Claude Desktop), and they re-read those credentials
 * on every launch. Writing a real Jevonian key into their config would be
 * overwritten and, worse, would leak a working key onto disk.
 *
 * These values are NOT credentials. They are only accepted from a loopback
 * peer and never authorize access to a tunneled or LAN-facing instance.
 */
export const LOCAL_CLIENT_KEYS = ["jevonian-local", "ollama-local-codex", "ollama"] as const;

/** True when the request arrived over the loopback interface. */
export function isLoopbackOrigin(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  // Node reports IPv4-mapped IPv6 addresses as ::ffff:127.0.0.1
  const normalized = remoteAddress.replace(/^::ffff:/, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized.startsWith("127.")
  );
}

export interface LocalClientRequest {
  /** The credential the client presented. */
  token: string;
  /** Peer address of the connection. */
  remoteAddress: string | undefined;
  /** True when the client identified itself with a ChatGPT account session. */
  hasAccountId: boolean;
  config: Config;
}

/**
 * Decides whether a request may bypass Jevonian's own API-key check.
 *
 * Two kinds of loopback client qualify, and both are gated on the peer being
 * loopback AND the server being bound to loopback, so neither can ever unlock a
 * tunneled or LAN-facing instance:
 *
 * 1. A sentinel key (`jevonian-local`). Used when Codex had no `auth.json`, so
 *    Jevonian created one and the client echoes our placeholder back.
 * 2. A ChatGPT account session, identified by the `ChatGPT-Account-ID` header.
 *    This is the normal case once a real login exists: Codex sends the user's
 *    own ChatGPT token, which is not — and must never be — a Jevonian key.
 *    Accepting it is safe because the token is never trusted as authorization:
 *    it is discarded, and Jevonian resolves its own upstream credentials.
 */
export function isLocalClientRequest(input: LocalClientRequest): boolean {
  const { token, remoteAddress, hasAccountId, config } = input;
  if (!isLoopbackOrigin(remoteAddress)) return false;
  if (!isLoopbackEndpoint(config)) return false;

  if (hasAccountId) return true;
  if (!token) return false;
  return (LOCAL_CLIENT_KEYS as readonly string[]).includes(token);
}

/**
 * The sentinel is only safe when the server is bound to loopback. A `0.0.0.0`
 * or `::` binding accepts LAN traffic, so it must NOT qualify: the sentinel
 * would otherwise let anyone on the network in without a key.
 */
export function isLoopbackEndpoint(config: Config): boolean {
  return isLoopbackOrigin(config.listen.host);
}

/**
 * Falls back to any provider that can serve the OpenAI surface so a desktop
 * client pointed at Jevonian always resolves to something usable when the
 * default provider is missing or not declared.
 */
export function fallbackProvider(config: Config): Provider | undefined {
  if (config.defaultProvider) {
    const named = config.providers.find((provider) => provider.name === config.defaultProvider);
    if (named) return named;
  }
  return (
    config.providers.find((provider) => provider.type === "openai" || provider.type === "both") ??
    config.providers.find((provider) => provider.type === "responses") ??
    config.providers[0]
  );
}

export { resolveApiKey };
