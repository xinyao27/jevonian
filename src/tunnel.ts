import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { TunnelConfig } from "./config";
import { scrubProxyEnv } from "./proxy";
import { withAugmentedPath } from "./user-path";

export type TunnelProvider = "cloudflare" | "ngrok" | "custom";
export type TunnelStatus = "off" | "starting" | "on" | "error";

export interface TunnelState {
  status: TunnelStatus;
  provider: TunnelProvider;
  publicPort: number;
  url?: string;
  error?: string;
  startedAt?: string;
  command?: string;
}

export interface TunnelRecord {
  pid: number;
  provider: TunnelProvider;
  publicPort: number;
  command: string;
  url?: string;
  startedAt: string;
}

export interface TunnelHost {
  alive(pid: number): boolean;
  identify(pid: number, command: string): boolean;
  terminate(pid: number, group: boolean): void;
}

export const systemHost: TunnelHost = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  identify(pid, command) {
    if (process.platform === "win32") return true;
    try {
      return execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).includes(command);
    } catch {
      return false;
    }
  },
  terminate(pid, group) {
    if (process.platform !== "win32" && group) {
      try {
        process.kill(-pid, "SIGTERM");
        return;
      } catch {
        // not a group leader — fall through to the pid
      }
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  },
};

const URL_PATTERNS: Record<TunnelProvider, RegExp> = {
  cloudflare: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
  // free static domains use .ngrok-free.dev; random tunnels still use .ngrok-free.app / .ngrok.app
  ngrok: /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|dev)/,
  custom: /https?:\/\/[^\s"'`]+/,
};

export function extractTunnelUrl(provider: TunnelProvider, text: string): string | undefined {
  return text.match(URL_PATTERNS[provider])?.[0];
}

/** True when `url` is a known stable address (named / reserved), not a discovered quick-tunnel host. */
export function usesConfiguredTunnelUrl(config: TunnelConfig): boolean {
  return Boolean(config.url) && (config.provider === "custom" || config.provider === "ngrok");
}

export function buildTunnelCommand(
  config: TunnelConfig,
  publicPort: number,
): { command: string; args: string[] } | { error: string } {
  if (config.provider === "custom" || config.command) {
    if (!config.command) return { error: "custom tunnel needs a command" };
    return { command: "sh", args: ["-c", config.command.replaceAll("{port}", String(publicPort))] };
  }
  if (config.provider === "ngrok") {
    const args = ["http", String(publicPort)];
    // Reserved / static domain: bind the known hostname instead of asking ngrok to mint one.
    if (config.url) args.push("--url", config.url);
    args.push("--log", "stdout");
    return { command: "ngrok", args };
  }
  return {
    command: "cloudflared",
    args: ["tunnel", "--url", `http://127.0.0.1:${publicPort}`, "--no-autoupdate"],
  };
}

type SpawnFn = typeof spawn;

export interface TunnelManagerOptions {
  spawnFn?: SpawnFn;
  timeoutMs?: number;
  statePath?: string;
  logPath?: string;
  host?: TunnelHost;
}

export class TunnelManager {
  private child: ChildProcess | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private config: TunnelConfig;
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;
  private readonly statePath: string | undefined;
  private readonly logPath: string | undefined;
  private readonly host: TunnelHost;
  private readonly detached = process.platform !== "win32";
  private adopted: { pid: number; command: string } | undefined;
  private state: TunnelState;

  constructor(config: TunnelConfig, port: number, options: TunnelManagerOptions = {}) {
    this.config = config;
    this.spawnFn = options.spawnFn ?? spawn;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.statePath = options.statePath;
    this.logPath = options.logPath;
    this.host = options.host ?? systemHost;
    this.state = {
      status: "off",
      provider: config.provider,
      publicPort: config.publicPort ?? port + 1,
    };
  }

  status(): TunnelState {
    if (this.state.status === "on" && this.adopted && !this.host.alive(this.adopted.pid)) {
      this.adopted = undefined;
      this.clearRecord();
      this.state = {
        ...this.state,
        status: "error",
        error: "tunnel process exited",
        url: undefined,
        startedAt: undefined,
      };
    }
    return { ...this.state };
  }

  update(config: TunnelConfig, port: number): void {
    const publicPort = config.publicPort ?? port + 1;
    const changed =
      config.provider !== this.config.provider ||
      (config.command ?? "") !== (this.config.command ?? "") ||
      (config.url ?? "") !== (this.config.url ?? "") ||
      publicPort !== this.state.publicPort;
    this.config = config;
    this.state.provider = config.provider;
    this.state.publicPort = publicPort;
    // a running spawn points at the old provider/port — restart so the new config takes effect
    if (changed && (this.state.status === "on" || this.state.status === "starting")) this.stop();
  }

  start(): TunnelState {
    if (this.state.status === "starting" || this.state.status === "on") return this.status();
    this.stopping = false;
    const adopted = this.adopt();
    if (adopted) return adopted;
    const built = buildTunnelCommand(this.config, this.state.publicPort);
    if ("error" in built) {
      this.state = { ...this.state, status: "error", error: built.error, url: undefined };
      return this.status();
    }
    const label = `${built.command} ${built.args.join(" ")}`;
    this.state = {
      ...this.state,
      status: "starting",
      error: undefined,
      url: undefined,
      command: label,
    };
    const logFd = this.openLog();
    let child: ChildProcess;
    try {
      child = this.spawnFn(built.command, built.args, {
        stdio: logFd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", logFd, logFd],
        // Tunnel binaries must dial Cloudflare/ngrok directly. Inheriting a local
        // Clash-style HTTPS_PROXY is how a healthy tunnel turns into socket resets.
        // Augment PATH so launchd / GUI-started serves still find Homebrew ngrok.
        env: withAugmentedPath(scrubProxyEnv(process.env)),
        detached: this.detached,
      });
    } catch (error) {
      if (logFd !== undefined) closeSync(logFd);
      this.state = { ...this.state, status: "error", error: String(error) };
      return this.status();
    }
    if (logFd !== undefined) closeSync(logFd);
    this.child = child;
    child.unref?.();
    const startedAt = new Date().toISOString();
    if (child.pid) {
      this.writeRecord({
        pid: child.pid,
        provider: this.state.provider,
        publicPort: this.state.publicPort,
        command: label,
        startedAt,
      });
    }
    let settled = false;
    const isCurrent = (): boolean => this.child === child;
    const settle = (url: string): void => {
      if (settled || !isCurrent()) return;
      settled = true;
      this.clearTimers();
      this.state = { ...this.state, status: "on", url, startedAt, error: undefined };
      this.saveUrl(url);
    };
    const onData = (chunk: Buffer): void => {
      const url = extractTunnelUrl(this.state.provider, chunk.toString("utf8"));
      if (url) settle(url);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // Named / reserved endpoints already know their public URL; quick tunnels must wait for logs.
    if (usesConfiguredTunnelUrl(this.config) && this.config.url) settle(this.config.url);
    if (this.logPath !== undefined) {
      const tick = (): void => {
        if (settled || !isCurrent()) return;
        let text = "";
        try {
          text = readFileSync(this.logPath ?? "", "utf8");
        } catch {
          // log not created yet
        }
        const url = text ? extractTunnelUrl(this.state.provider, text) : undefined;
        if (url) settle(url);
      };
      tick();
      this.poll = setInterval(tick, 250);
      this.poll.unref?.();
    }
    child.on("error", (error) => {
      if (!isCurrent()) return;
      settled = true;
      this.clearTimers();
      this.clearRecord();
      this.state = {
        ...this.state,
        status: "error",
        error:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `${built.command} is not installed`
            : String(error),
        url: undefined,
      };
    });
    child.on("exit", (code) => {
      if (!isCurrent()) return;
      this.child = undefined;
      this.clearTimers();
      this.clearRecord();
      if (this.stopping) return;
      this.state = {
        ...this.state,
        status: "error",
        error: `tunnel exited (code ${code ?? "?"})`,
        url: undefined,
      };
    });
    this.timer = setTimeout(() => {
      if (settled || !isCurrent()) return;
      settled = true;
      this.clearTimers();
      this.state = { ...this.state, status: "error", error: "tunnel did not report a URL" };
    }, this.timeoutMs);
    this.timer.unref?.();
    return this.status();
  }

  stop(): TunnelState {
    this.stopping = true;
    this.clearTimers();
    const child = this.child;
    this.child = undefined;
    if (child) this.terminateOwned(child);
    const adopted = this.adopted;
    this.adopted = undefined;
    if (adopted && this.host.identify(adopted.pid, adopted.command)) {
      this.host.terminate(adopted.pid, this.detached);
    }
    this.clearRecord();
    this.state = {
      ...this.state,
      status: "off",
      url: undefined,
      error: undefined,
      startedAt: undefined,
    };
    return this.status();
  }

  cleanup(): void {
    const record = this.readRecord();
    if (
      record?.pid &&
      this.host.alive(record.pid) &&
      this.host.identify(record.pid, record.command)
    ) {
      this.host.terminate(record.pid, this.detached);
    }
    this.clearRecord();
  }

  private adopt(): TunnelState | undefined {
    const record = this.readRecord();
    if (!record) return undefined;
    const matches =
      record.provider === this.state.provider && record.publicPort === this.state.publicPort;
    const alive =
      matches && typeof record.pid === "number" && record.pid > 0 && this.host.alive(record.pid);
    const ours = alive && this.host.identify(record.pid, record.command);
    const url = this.config.url ?? record.url ?? this.scrapeLog();
    if (!ours || !url) {
      if (ours) this.host.terminate(record.pid, this.detached);
      this.clearRecord();
      return undefined;
    }
    this.adopted = { pid: record.pid, command: record.command };
    this.state = {
      ...this.state,
      status: "on",
      url,
      error: undefined,
      command: record.command,
      startedAt: record.startedAt,
    };
    return this.status();
  }

  private scrapeLog(): string | undefined {
    if (this.logPath === undefined) return undefined;
    try {
      return extractTunnelUrl(this.state.provider, readFileSync(this.logPath, "utf8"));
    } catch {
      return undefined;
    }
  }

  private terminateOwned(child: ChildProcess): void {
    if (this.detached && child.pid) {
      this.host.terminate(child.pid, true);
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.timer = undefined;
    this.poll = undefined;
  }

  private openLog(): number | undefined {
    if (this.logPath === undefined) return undefined;
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
      return openSync(this.logPath, "w");
    } catch {
      return undefined;
    }
  }

  private readRecord(): TunnelRecord | undefined {
    if (this.statePath === undefined) return undefined;
    try {
      const record = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<TunnelRecord>;
      if (typeof record.pid !== "number" || typeof record.publicPort !== "number") return undefined;
      if (typeof record.provider !== "string" || typeof record.command !== "string")
        return undefined;
      return record as TunnelRecord;
    } catch {
      return undefined;
    }
  }

  private writeRecord(record: TunnelRecord): void {
    if (this.statePath === undefined) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(record, null, 2));
    } catch {
      // persistence is best-effort
    }
  }

  private saveUrl(url: string): void {
    if (this.statePath === undefined) return;
    const record = this.readRecord();
    if (!record) return;
    this.writeRecord({ ...record, url });
  }

  private clearRecord(): void {
    if (this.statePath === undefined) return;
    try {
      rmSync(this.statePath, { force: true });
    } catch {
      // best-effort
    }
  }
}
