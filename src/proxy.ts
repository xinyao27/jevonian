import { execFileSync } from "node:child_process";

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/**
 * The proxy Jevonian's egress should use.
 *
 * Node's fetch reads the proxy from the environment and nothing else. On macOS the
 * proxy usually lives in the system network settings instead, so a host the user's
 * browser reaches fine is unreachable from here and every turn against it fails as
 * "Upstream request failed: fetch failed" — the ChatGPT subscription provider being
 * the one that breaks first, because chatgpt.com is exactly the kind of host a proxy
 * rule exists for.
 */
export interface SystemProxy {
  /** Proxy URL, e.g. `http://127.0.0.1:1082`. */
  url: string;
  /** Hosts that must be reached directly, loopback first. */
  bypass: string[];
}

/** Loopback never leaves the machine, so it must never be handed to a proxy. */
const LOOPBACK_BYPASS = ["localhost", "127.0.0.1", "::1"];

/** Every spelling Node's proxy support reads, so an existing setting is respected. */
const PROXY_ENV = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];

/** `JEVONIAN_SYSTEM_PROXY=off` keeps Jevonian on a direct connection. */
function isOptedOut(value: string | undefined): boolean {
  const flag = (value ?? "").trim().toLowerCase();
  return flag === "off" || flag === "0" || flag === "false" || flag === "no";
}

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return PROXY_ENV.some((name) => (env[name] ?? "").trim().length > 0);
}

/**
 * Parses the output of `scutil --proxy`, macOS's view of the network settings.
 *
 * The format is an old NeXTSTEP property list — nested `<dictionary> { … }` blocks
 * with `key : value` lines — and the parsing only ever needs the flat scalars plus
 * the flat `ExceptionsList` array, so the nesting is tracked rather than decoded.
 */
export function parseScutilProxy(output: string): SystemProxy | undefined {
  const scalar = new Map<string, string>();
  const exceptions: string[] = [];
  let inExceptions = false;

  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (inExceptions) {
      if (line === "}") {
        inExceptions = false;
        continue;
      }
      const entry = /^\d+\s*:\s*(.+)$/.exec(line);
      if (entry && !exceptions.includes(entry[1].trim())) exceptions.push(entry[1].trim());
      continue;
    }
    const key = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
    if (!key) continue;
    const [, name, value] = key;
    if (/^<.+>\s*\{$/.test(value)) {
      // Structured values are only interesting for the exceptions array; anything
      // else nested (a SOCKS proxy block, say) is skipped whole.
      if (name === "ExceptionsList") inExceptions = true;
      continue;
    }
    scalar.set(name, value);
  }

  const https =
    scalar.get("HTTPSEnable") === "1" && scalar.get("HTTPSProxy")
      ? `${scalar.get("HTTPSProxy")}:${scalar.get("HTTPSPort")}`
      : undefined;
  const http =
    scalar.get("HTTPEnable") === "1" && scalar.get("HTTPProxy")
      ? `${scalar.get("HTTPProxy")}:${scalar.get("HTTPPort")}`
      : undefined;
  // Jevonian's providers are all https, so the https proxy is the one that matters.
  // A machine with only http proxying enabled still gets that proxy for both schemes
  // rather than sending half its traffic direct.
  const target = https ?? http;
  if (!target) return undefined;
  // The machine's own list repeats entries Jevonian adds anyway (`localhost`), so the
  // final list is deduped rather than concatenated.
  return { url: `http://${target}`, bypass: [...new Set([...LOOPBACK_BYPASS, ...exceptions])] };
}

/** Reads macOS's system proxy. Other platforms have no equivalent to read cheaply. */
export function detectSystemProxy(): SystemProxy | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const output = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 5_000 });
    return parseScutilProxy(output);
  } catch {
    return undefined;
  }
}

/** Unions a host list into a `NO_PROXY` value, keeping whatever was already there. */
function mergeBypass(existing: string | undefined, bypass: readonly string[]): string {
  const entries = new Set<string>();
  for (const entry of (existing ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length > 0) entries.add(trimmed);
  }
  for (const entry of bypass) entries.add(entry);
  return [...entries].join(",");
}

/**
 * Copies an env without proxy variables so a child process dials the network directly.
 *
 * cloudflared and similar tunnel binaries break when a local Clash/V2Ray HTTP proxy
 * is inherited via `HTTPS_PROXY` — they need a straight path to the edge.
 */
export function scrubProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const name of PROXY_ENV) delete next[name];
  return next;
}

/**
 * True when a failed fetch looks like the local proxy (or its upstream) dropped the socket.
 *
 * Clash and similar tools routinely reset long downloads; that must not take down the
 * serve process as an unhandled `TypeError: terminated`.
 */
export function isTransientProxyError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (
      code === "UND_ERR_SOCKET" ||
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "EPIPE" ||
      code === "ETIMEDOUT"
    ) {
      return true;
    }
    if (current.message === "terminated" || /other side closed/i.test(current.message)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Compact chain of `message [code]` for proxy/fetch failures. */
export function formatFetchError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && parts.length < 5) {
    const code = (current as { code?: unknown }).code;
    parts.push(typeof code === "string" ? `${current.message} [${code}]` : current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.length === 0 ? String(error) : parts.join(" caused by ");
}

/**
 * How long an idle keep-alive socket is kept for reuse.
 *
 * undici defaults to 4s, which is far shorter than the gap between two turns of a
 * coding agent: the model spends seconds generating, then the user reads the reply
 * before the next request goes out. So the pooled connection to whatever host was
 * reached through the system proxy is already gone by the time the next turn needs
 * it, and the request pays a fresh TLS handshake on the critical path.
 *
 * That handshake is not cheap on a proxied host. Measured on a machine whose proxy
 * egresses overseas: TCP connect to the local proxy was 0.1ms, but a fresh TLS
 * handshake to the brain endpoint was ~1050ms, against ~29ms for a host with a
 * domestic edge. A provider without a local edge therefore lost about a second per
 * turn to re-handshaking, and it hit the routing brain on most turns — 60% of brain
 * calls followed a gap of 4s or more, at p50 1018ms versus 367ms warm.
 *
 * Every provider request shares this dispatcher, so the cost applied to all of them.
 * Holding sockets for 2 minutes measured 1274ms -> 307ms across a 15s idle gap.
 *
 * Note the server's own keep-alive hint can override this, capped by
 * `keepAliveMaxTimeout` (10 minutes by default).
 */
const KEEP_ALIVE_TIMEOUT_MS = 120_000;

/**
 * Builds the dispatcher options, with the socket-lifetime policy applied.
 *
 * Split out so the keep-alive setting is testable without reaching into undici's
 * private pool internals, which is the only place it is otherwise observable.
 */
export function proxyAgentOptions(options?: {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}): {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
  keepAliveTimeout: number;
} {
  return { ...options, keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS };
}

function installProxyAgent(options?: {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}): void {
  const agent = new EnvHttpProxyAgent(proxyAgentOptions(options));
  // Pool-level socket drops are not attached to any fetch promise; swallowing them here
  // keeps the process alive while individual callers still see their own rejections.
  const sink = agent as unknown as { on: (event: string, listener: () => void) => void };
  sink.on("error", () => {});
  setGlobalDispatcher(agent);
}

/**
 * Writes the machine's proxy into the environment Node's proxy support reads.
 *
 * An environment that already names a proxy wins: a shell or service manager that
 * exports `HTTPS_PROXY` has answered this question already, and second-guessing it
 * would be worse than not asking.
 *
 * Prefer {@link useSystemProxy} for the serve path — it installs a dispatcher without
 * mutating the environment, so tunnel children do not inherit the proxy.
 */
export function applySystemProxy(
  env: NodeJS.ProcessEnv = process.env,
  detect: () => SystemProxy | undefined = detectSystemProxy,
): SystemProxy | undefined {
  if (isOptedOut(env.JEVONIAN_SYSTEM_PROXY)) return undefined;
  if (hasProxyEnv(env)) return undefined;
  const proxy = detect();
  if (!proxy) return undefined;
  env.HTTPS_PROXY = proxy.url;
  env.HTTP_PROXY = proxy.url;
  // Loopback is exempt here rather than left to the detector, so the guarantee holds
  // for any proxy source: a provider on 127.0.0.1 must never be dialled through it.
  env.NO_PROXY = mergeBypass(env.NO_PROXY, [...LOOPBACK_BYPASS, ...proxy.bypass]);
  return proxy;
}

/**
 * Detects the machine's proxy and routes Jevonian's egress through it.
 *
 * System-detected proxies are installed via dispatcher options rather than written into
 * `process.env`. That keeps cloudflared and other children on a direct path: inheriting
 * a Clash `HTTPS_PROXY` is what turns a working tunnel into `TypeError: terminated`
 * when the proxy resets a long models.dev download mid-flight.
 *
 * An environment that already names a proxy still wins — the dispatcher reads those
 * variables, and callers that set them intentionally keep that behaviour.
 */
export function useSystemProxy(
  env: NodeJS.ProcessEnv = process.env,
  detect: () => SystemProxy | undefined = detectSystemProxy,
): SystemProxy | undefined {
  if (isOptedOut(env.JEVONIAN_SYSTEM_PROXY)) return undefined;
  if (hasProxyEnv(env)) {
    installProxyAgent();
    return undefined;
  }
  const proxy = detect();
  if (!proxy) {
    // No proxy to route through, but the keep-alive tuning still applies: without a
    // dispatcher of our own, fetch falls back to undici's default and drops idle
    // sockets after 4s, so a direct host is re-handshaked every turn too. A plain
    // Agent is cheaper to reconnect to than a proxied one, but it is the same waste.
    // Installing here keeps both paths on one socket-lifetime policy.
    installProxyAgent();
    return undefined;
  }
  const noProxy = mergeBypass(env.NO_PROXY, [...LOOPBACK_BYPASS, ...proxy.bypass]);
  installProxyAgent({ httpProxy: proxy.url, httpsProxy: proxy.url, noProxy });
  return proxy;
}
