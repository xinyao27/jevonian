import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * `pnpm dev` runs `tsx watch`, which restarts the server on every edit. Opening
 * the dashboard on every boot stacks a new browser tab each time. A small marker
 * on disk records that this session already launched one, so later restarts reuse
 * the existing tab.
 */

export interface BrowserState {
  pid: number;
  openedAt: number;
}

export interface OpenBrowserOptions {
  statePath?: string;
  pid?: number;
  now?: number;
  launch?: (url: string) => void;
}

export interface OpenBrowserResult {
  opened: boolean;
  reason: "opened" | "already-open";
}

function defaultLaunch(url: string): void {
  if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } else if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
  } else {
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  }
}

function readState(path: string): BrowserState | undefined {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as Partial<BrowserState>;
    if (typeof record.pid !== "number" || typeof record.openedAt !== "number") return undefined;
    return { pid: record.pid, openedAt: record.openedAt };
  } catch {
    return undefined;
  }
}

function writeState(path: string, pid: number, now: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ pid, openedAt: now, openedAtIso: new Date(now).toISOString() }, null, 2)}\n`,
  );
}

/** True when a prior launch in this session should be reused. */
export function shouldSkipBrowserOpen(state: BrowserState | undefined): boolean {
  return state !== undefined && Number.isFinite(state.openedAt);
}

/**
 * Open the dashboard once per marker. Without `statePath` every call launches;
 * with one, the first call opens and later calls reuse the tab.
 */
export function openBrowserOnce(url: string, options: OpenBrowserOptions = {}): OpenBrowserResult {
  const launch = options.launch ?? defaultLaunch;
  if (!options.statePath) {
    launch(url);
    return { opened: true, reason: "opened" };
  }
  const state = readState(options.statePath);
  if (shouldSkipBrowserOpen(state)) return { opened: false, reason: "already-open" };
  launch(url);
  writeState(options.statePath, options.pid ?? process.pid, options.now ?? Date.now());
  return { opened: true, reason: "opened" };
}

/** Forget that a dashboard was opened; the next call launches a fresh one. */
export function clearBrowserState(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort
  }
}
