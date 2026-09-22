import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { serveLogPath } from "./paths";
import { augmentPath } from "./user-path";

export { serveLogPath };

/** LaunchAgent label. Stable across installs so bootout/bootstrap stay idempotent. */
export const SERVICE_LABEL = "ai.jevonian.serve";

export function servicePlistPath(): string {
  if (process.env.JEVONIAN_SERVICE_PLIST) return process.env.JEVONIAN_SERVICE_PLIST;
  return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

/**
 * True when this process was started by our LaunchAgent.
 *
 * launchd sets `XPC_SERVICE_NAME` to the job label for user agents. Used so an
 * in-process update can exit and let launchd relaunch, instead of spawning a
 * second child that would fight for the port.
 */
export function isManagedByLaunchd(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.XPC_SERVICE_NAME === SERVICE_LABEL;
}

export interface ServeEntry {
  node: string;
  entry: string;
}

/**
 * Absolute paths for the node binary and CLI entry that should run under launchd.
 *
 * Captured at install time so a LaunchAgent keeps pointing at the same checkout
 * (or global install) even if PATH later changes.
 */
export function resolveServeEntry(options?: { execPath?: string; argv1?: string }): ServeEntry {
  const node = options?.execPath ?? process.execPath;
  const raw = options?.argv1 ?? process.argv[1];
  if (!raw) {
    throw new Error("Cannot resolve the Jevonian CLI entry path (process.argv[1] is empty).");
  }
  const absolute = resolve(raw);
  const entry = existsSync(absolute) ? realpathSync(absolute) : absolute;
  return { node, entry };
}

export interface PlistOptions {
  node: string;
  entry: string;
  logPath: string;
  /** Extra environment variables baked into the agent (e.g. JEVONIAN_CONFIG). */
  env?: Record<string, string>;
  workingDirectory?: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function envDictXml(env: Record<string, string>): string {
  const keys = Object.keys(env).sort();
  if (keys.length === 0) return "\t<dict/>";
  const lines = ["\t<dict>"];
  for (const key of keys) {
    lines.push(`\t\t<key>${escapeXml(key)}</key>`);
    lines.push(`\t\t<string>${escapeXml(env[key] ?? "")}</string>`);
  }
  lines.push("\t</dict>");
  return lines.join("\n");
}

/** Builds the LaunchAgent plist body. Pure so tests can assert the shape. */
export function buildServicePlist(options: PlistOptions): string {
  const env = {
    JEVONIAN_NO_OPEN: "1",
    ...options.env,
  };
  const cwd = options.workingDirectory ?? dirname(options.entry);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${escapeXml(SERVICE_LABEL)}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${escapeXml(options.node)}</string>
\t\t<string>${escapeXml(options.entry)}</string>
\t\t<string>serve</string>
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${escapeXml(cwd)}</string>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>5</integer>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>StandardOutPath</key>
\t<string>${escapeXml(options.logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(options.logPath)}</string>
\t<key>EnvironmentVariables</key>
${envDictXml(env)}
</dict>
</plist>
`;
}

function requireDarwin(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      `Background service is only supported on macOS (launchd). This host is ${process.platform}.`,
    );
  }
}

function guiDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) throw new Error("Cannot determine the current user id for launchctl.");
  return `gui/${uid}`;
}

function launchctl(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("launchctl", args, {
    encoding: "utf8",
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function jobTarget(): string {
  return `${guiDomain()}/${SERVICE_LABEL}`;
}

/** Sync sleep for launchd settle windows (bootout → bootstrap races on error 5). */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function bootstrapDetail(result: { stdout: string; stderr: string }): string {
  return (result.stderr || result.stdout || "").trim();
}

/**
 * Register the LaunchAgent, retrying macOS's transient "Bootstrap failed: 5: Input/output error"
 * that shows up when bootout has not finished tearing the old job down.
 */
export function bootstrapService(plistPath = servicePlistPath()): void {
  if (serviceStatus().loaded) return;
  const domain = guiDomain();
  let last = { status: 1, stdout: "", stderr: "bootstrap not attempted" };
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) sleepMs(100 * 2 ** (attempt - 1)); // 100, 200, 400, 800, 1600
    last = launchctl(["bootstrap", domain, plistPath]);
    if (last.status === 0) return;
    // A racing RunAtLoad / prior attempt may have won; treat as success.
    if (serviceStatus().loaded) return;
    const detail = bootstrapDetail(last);
    if (/already (?:bootstrapped|loaded)/i.test(detail)) return;
    // Only retry the known transient EIO; other failures fail fast.
    if (!/Input\/output error|\bBootstrap failed:\s*5\b/i.test(detail)) break;
  }
  if (serviceStatus().loaded) return;
  throw new Error(
    `launchctl bootstrap failed: ${bootstrapDetail(last) || `exit ${last.status}`}`,
  );
}

function bootoutQuiet(): void {
  launchctl(["bootout", jobTarget()]);
  // launchd needs a beat before the label can be bootstrapped again.
  sleepMs(200);
}

/** Environment keys that should move with the LaunchAgent when present at install. */
const PASSTHROUGH_ENV = [
  "JEVONIAN_CONFIG",
  "JEVONIAN_DATA_DIR",
  "JEVONIAN_LEDGER",
  "JEVONIAN_WEB_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

export function passthroughServiceEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

export interface ServiceStatus {
  platform: NodeJS.Platform;
  label: string;
  plistPath: string;
  plistInstalled: boolean;
  loaded: boolean;
  pid?: number;
  logPath: string;
  detail?: string;
}

export function serviceStatus(): ServiceStatus {
  const plist = servicePlistPath();
  const logPath = serveLogPath();
  const base: ServiceStatus = {
    platform: process.platform,
    label: SERVICE_LABEL,
    plistPath: plist,
    plistInstalled: existsSync(plist),
    loaded: false,
    logPath,
  };
  if (process.platform !== "darwin") {
    return { ...base, detail: "launchd is only available on macOS" };
  }
  const printed = launchctl(["print", jobTarget()]);
  if (printed.status !== 0) {
    return {
      ...base,
      detail: (printed.stderr || printed.stdout || "not loaded").trim().slice(0, 200),
    };
  }
  const text = printed.stdout;
  const pidMatch = /\bpid\s*=\s*(\d+)/.exec(text);
  return {
    ...base,
    loaded: true,
    ...(pidMatch ? { pid: Number(pidMatch[1]) } : {}),
    detail: "loaded",
  };
}

export function installService(options?: {
  entry?: ServeEntry;
  env?: Record<string, string>;
}): ServiceStatus {
  requireDarwin();
  const entry = options?.entry ?? resolveServeEntry();
  const logPath = serveLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  mkdirSync(dirname(servicePlistPath()), { recursive: true });
  const plist = buildServicePlist({
    node: entry.node,
    entry: entry.entry,
    logPath,
    // Bake a usable PATH: launchd defaults to /usr/bin:/bin:/usr/sbin:/sbin,
    // which hides Homebrew ngrok/cloudflared from tunnel spawns.
    env: {
      PATH: augmentPath(process.env.PATH),
      ...passthroughServiceEnv(),
      ...options?.env,
    },
    workingDirectory: dirname(entry.entry),
  });
  // Replace any previous registration so KeepAlive / ProgramArguments stay in sync.
  bootoutQuiet();
  writeFileSync(servicePlistPath(), plist, { mode: 0o644 });
  bootstrapService();
  // Ensure it is running even if RunAtLoad raced with an existing listener.
  launchctl(["kickstart", "-k", jobTarget()]);
  return serviceStatus();
}

export function uninstallService(): void {
  requireDarwin();
  bootoutQuiet();
  rmSync(servicePlistPath(), { force: true });
}

export function startService(): ServiceStatus {
  requireDarwin();
  if (!existsSync(servicePlistPath())) {
    throw new Error(`Service is not installed. Run \`jevonian\` first.`);
  }
  if (!serviceStatus().loaded) bootstrapService();
  launchctl(["kickstart", "-k", jobTarget()]);
  return serviceStatus();
}

export function stopService(): ServiceStatus {
  requireDarwin();
  bootoutQuiet();
  return serviceStatus();
}

export function restartService(): ServiceStatus {
  requireDarwin();
  if (!existsSync(servicePlistPath())) {
    throw new Error(`Service is not installed. Run \`jevonian\` first.`);
  }
  const status = serviceStatus();
  if (!status.loaded) return startService();
  const kick = launchctl(["kickstart", "-k", jobTarget()]);
  if (kick.status !== 0) {
    // Fall back to bootout + bootstrap when kickstart is refused.
    bootoutQuiet();
    return startService();
  }
  return serviceStatus();
}

/**
 * Reads the node + entry paths baked into an installed LaunchAgent plist.
 * Returns undefined when the plist is missing or does not look like ours.
 */
export function readInstalledServeEntry(plistPath = servicePlistPath()): ServeEntry | undefined {
  if (!existsSync(plistPath)) return undefined;
  let text: string;
  try {
    text = readFileSync(plistPath, "utf8");
  } catch {
    return undefined;
  }
  const strings = [...text.matchAll(/<string>([^<]*)<\/string>/g)].map((match) =>
    match[1]
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"'),
  );
  // ProgramArguments: node, entry, "serve" — take the first two before the serve token.
  const serveIndex = strings.indexOf("serve");
  if (serveIndex < 2) return undefined;
  const node = strings[serveIndex - 2];
  const entry = strings[serveIndex - 1];
  if (!node || !entry) return undefined;
  return { node, entry };
}

export type EnsureServiceResult = {
  status: ServiceStatus;
  /** What we did: fresh install, plist refresh + restart, kickstart, or nothing. */
  action: "installed" | "updated" | "started" | "running";
};

/** True when the installed agent already carries a PATH (post user-bin fix). */
export function installedPlistHasPath(plistPath = servicePlistPath()): boolean {
  if (!existsSync(plistPath)) return false;
  try {
    return readFileSync(plistPath, "utf8").includes("<key>PATH</key>");
  } catch {
    return false;
  }
}

/**
 * Make sure the LaunchAgent exists, points at this CLI, and is running.
 *
 * Used by bare `jevonian` on macOS so a new install is persistently up without a
 * separate install step. Avoids restarting when the job is already healthy with
 * the same ProgramArguments. PATH for Homebrew tunnel CLIs is applied at serve
 * start and baked into the plist whenever we do reinstall.
 */
export function ensureService(options?: {
  entry?: ServeEntry;
  env?: Record<string, string>;
}): EnsureServiceResult {
  requireDarwin();
  const entry = options?.entry ?? resolveServeEntry();
  const installed = readInstalledServeEntry();
  const sameEntry =
    installed !== undefined && installed.node === entry.node && installed.entry === entry.entry;
  // Do not force a bootout cycle just to add PATH — that races launchd (error 5).
  // Runtime applyUserBinPath + spawn-time PATH cover tunnels; PATH is written on
  // the next real install/update.
  if (!sameEntry) {
    const status = installService({ entry, env: options?.env });
    return { status, action: installed ? "updated" : "installed" };
  }
  const current = serviceStatus();
  if (!current.loaded || !current.pid) {
    const status = startService();
    return { status, action: "started" };
  }
  return { status: current, action: "running" };
}

/** Read the last N lines of the serve log for `service status` diagnostics. */
export function readServeLogTail(maxLines = 20): string {
  const path = serveLogPath();
  if (!existsSync(path)) return "";
  try {
    const text = readFileSync(path, "utf8");
    const lines = text.split(/\r?\n/);
    return lines
      .slice(Math.max(0, lines.length - maxLines))
      .join("\n")
      .trimEnd();
  } catch {
    return "";
  }
}
