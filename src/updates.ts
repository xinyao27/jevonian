import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const PACKAGE_NAME = "jevonian";

export type InstallChannel = "npm" | "pnpm" | "source" | "unknown";

export interface Installation {
  channel: InstallChannel;
  /** Absolute package-manager binary when known (avoids PATH shims like vite-plus `vp`). */
  bin?: string;
  command?: string;
}

export interface UpdateStatus {
  /** Version this process started with (what is actually running). */
  current: string;
  /** On-disk package.json version; may lead `current` after an external install. */
  installed: string;
  latest?: string;
  /** Registry has a release newer than the running process. */
  updateAvailable: boolean;
  /** Disk already has a newer build than this process; a restart applies it. */
  restartRequired: boolean;
  channel: InstallChannel;
  installCommand?: string;
  checkedAt?: string;
  error?: string;
}

interface Cache {
  channel: InstallChannel;
  checkedAt: string;
  latest: string;
}

interface UpdateManagerOptions {
  current?: string;
  cachePath: string;
  installation?: Installation;
  now?: () => number;
  fetchLatest?: () => Promise<string>;
  install?: (command: string) => Promise<void>;
  /** Re-read on-disk package version after install (defaults to this build's package.json). */
  readInstalledVersion?: () => string;
}

function resolveEntry(entry: string): string {
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (!/[^\w@%+=:,./-]/i.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Prefer the package manager next to the Node that is running this binary.
 * PATH `npm` may be a shim (e.g. vite-plus `vp`) that installs into a different
 * Node prefix than the one serving `jevonian` on PATH.
 */
export function resolvePackageManagerBin(
  channel: "npm" | "pnpm",
  execPath = process.execPath,
): string | undefined {
  const name =
    process.platform === "win32" ? (channel === "npm" ? "npm.cmd" : "pnpm.cmd") : channel;
  const adjacent = join(dirname(execPath), name);
  return existsSync(adjacent) ? adjacent : undefined;
}

export function detectInstallation(
  entry = process.argv[1] ?? "",
  execPath = process.execPath,
): Installation {
  const override = process.env.JEVONIAN_INSTALL_CHANNEL;
  if (override === "npm" || override === "pnpm") {
    const bin = resolvePackageManagerBin(override, execPath);
    return {
      channel: override,
      ...(bin ? { bin } : {}),
      command: installCommand(override, { bin }),
    };
  }
  if (override === "source" || override === "unknown") return { channel: override };

  const path = resolveEntry(entry).replaceAll("\\", "/");
  if (path.includes("/node_modules/.pnpm/") && path.includes("/node_modules/jevonian/")) {
    const bin = resolvePackageManagerBin("pnpm", execPath);
    return { channel: "pnpm", ...(bin ? { bin } : {}), command: installCommand("pnpm", { bin }) };
  }
  if (path.includes("/node_modules/jevonian/")) {
    const channel: "npm" | "pnpm" =
      path.includes("/pnpm/") || path.includes("/.pnpm/") ? "pnpm" : "npm";
    const bin = resolvePackageManagerBin(channel, execPath);
    return { channel, ...(bin ? { bin } : {}), command: installCommand(channel, { bin }) };
  }
  if (/\/src\/cli\.(ts|js|mjs)$/.test(path)) return { channel: "source" };
  return { channel: "unknown" };
}

export function installCommand(
  channel: "npm" | "pnpm",
  options: { bin?: string; version?: string } = {},
): string {
  const spec = `${PACKAGE_NAME}@${options.version ?? "latest"}`;
  const bin = shellQuote(options.bin ?? channel);
  return channel === "pnpm" ? `${bin} add --global ${spec}` : `${bin} install --global ${spec}`;
}

function readPackageVersion(): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseVersion(value: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  return match ? match.slice(1).map(Number) : undefined;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return false;
}

const ANSI = {
  reset: "\u001B[0m",
  dim: "\u001B[2m",
  green: "\u001B[32m",
  cyan: "\u001B[36m",
  yellow: "\u001B[33m",
} as const;

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

function visibleWidth(value: string): number {
  return [...stripAnsi(value)].length;
}

/**
 * Matches update-notifier's box: yellow rounded border, centered text,
 * dim current → green latest, cyan install command.
 */
export function formatUpdateNotice(
  status: Pick<UpdateStatus, "current" | "latest">,
  options: { updateCommand?: string; colors?: boolean } = {},
): string | undefined {
  if (!status.latest) return undefined;
  const command = options.updateCommand ?? "jevonian update";
  const color = options.colors ?? Boolean(process.stderr.isTTY);
  const paint = (code: string, value: string): string =>
    color ? `${code}${value}${ANSI.reset}` : value;

  const lines = [
    `Update available ${paint(ANSI.dim, status.current)} → ${paint(ANSI.green, status.latest)}`,
    `Run ${paint(ANSI.cyan, command)} to update`,
  ];
  const contentWidth = Math.max(...lines.map(visibleWidth));
  const pad = (line: string): string => {
    const gap = contentWidth - visibleWidth(line);
    const left = Math.floor(gap / 2);
    const right = gap - left;
    return `${" ".repeat(left)}${line}${" ".repeat(right)}`;
  };
  const edge = "─".repeat(contentWidth + 2);
  const border = (value: string): string => paint(ANSI.yellow, value);
  const blank = `${border("│")} ${" ".repeat(contentWidth)} ${border("│")}`;
  const rows = [
    border(`╭${edge}╮`),
    blank,
    ...lines.map((line) => `${border("│")} ${pad(line)} ${border("│")}`),
    blank,
    border(`╰${edge}╯`),
  ];
  return `\n${rows.join("\n")}\n`;
}

async function fetchRegistryVersion(): Promise<string> {
  const url = process.env.JEVONIAN_NPM_REGISTRY ?? "https://registry.npmjs.org/jevonian/latest";
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": `${PACKAGE_NAME}-update-check` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`registry returned ${response.status}`);
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string" || !parseVersion(body.version)) {
    throw new Error("registry response did not contain a valid version");
  }
  return body.version;
}

function spawnCommand(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(signal ? `installer stopped by ${signal}` : `installer exited ${code}`));
    });
  });
}

export class UpdateManager {
  private current: string;
  private readonly cachePath: string;
  private readonly installation: Installation;
  private readonly now: () => number;
  private readonly fetchLatest: () => Promise<string>;
  private readonly runInstall: (command: string) => Promise<void>;
  private readonly readInstalledVersion: () => string;
  private latest?: string;
  private checkedAt?: string;
  private error?: string;

  constructor(options: UpdateManagerOptions) {
    this.readInstalledVersion = options.readInstalledVersion ?? readPackageVersion;
    this.current = options.current ?? this.readInstalledVersion();
    this.cachePath = options.cachePath;
    this.installation = options.installation ?? detectInstallation();
    this.now = options.now ?? Date.now;
    this.fetchLatest = options.fetchLatest ?? fetchRegistryVersion;
    this.runInstall = options.install ?? spawnCommand;
    this.loadCache();
  }

  private loadCache(): void {
    if (!existsSync(this.cachePath)) return;
    try {
      const cache = JSON.parse(readFileSync(this.cachePath, "utf8")) as Partial<Cache>;
      if (
        cache.channel === this.installation.channel &&
        typeof cache.latest === "string" &&
        typeof cache.checkedAt === "string"
      ) {
        this.latest = cache.latest;
        this.checkedAt = cache.checkedAt;
      }
    } catch {
      // A damaged cache must never prevent the CLI from starting.
    }
  }

  private cacheFresh(): boolean {
    if (!this.checkedAt) return false;
    const checked = Date.parse(this.checkedAt);
    return Number.isFinite(checked) && this.now() - checked < UPDATE_INTERVAL_MS;
  }

  private saveCache(): void {
    if (!this.latest || !this.checkedAt || this.installation.channel === "source") return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const temporary = `${this.cachePath}.${process.pid}.tmp`;
      const cache: Cache = {
        channel: this.installation.channel,
        checkedAt: this.checkedAt,
        latest: this.latest,
      };
      writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.cachePath);
    } catch {
      // Update checking is best effort and must never break normal commands.
    }
  }

  status(): UpdateStatus {
    const installed = this.readInstalledVersion();
    const installCmd =
      this.installation.command ??
      (this.installation.channel === "npm" || this.installation.channel === "pnpm"
        ? installCommand(this.installation.channel, { bin: this.installation.bin })
        : undefined);
    const updateAvailable = this.latest ? isNewerVersion(this.latest, this.current) : false;
    // Disk can move ahead of a long-lived process (manual npm install, failed restart).
    const restartRequired = isNewerVersion(installed, this.current);
    return {
      current: this.current,
      installed,
      ...(this.latest ? { latest: this.latest } : {}),
      updateAvailable,
      restartRequired,
      channel: this.installation.channel,
      ...(installCmd ? { installCommand: installCmd } : {}),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async check(options: { force?: boolean } = {}): Promise<UpdateStatus> {
    if (this.installation.channel === "source" || this.installation.channel === "unknown") {
      return this.status();
    }
    if (!options.force && this.cacheFresh()) return this.status();
    try {
      this.latest = await this.fetchLatest();
      this.checkedAt = new Date(this.now()).toISOString();
      this.error = undefined;
      this.saveCache();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    return this.status();
  }

  async install(): Promise<UpdateStatus> {
    const status = await this.check({ force: true });
    if (status.error) throw new Error(`update check failed: ${status.error}`);
    if (!status.latest) return status;
    const needsPackage = isNewerVersion(status.latest, status.installed);
    const needsRestart =
      status.restartRequired || isNewerVersion(status.latest, this.current);
    if (!needsPackage && !needsRestart) return status;
    if (this.installation.channel !== "npm" && this.installation.channel !== "pnpm") {
      throw new Error(
        `cannot update a ${this.installation.channel} installation; install ${PACKAGE_NAME} from npm first`,
      );
    }
    if (needsPackage) {
      // Pin the registry version we just fetched. PATH `npm`/`@latest` can lag or
      // (with shims) install into a different Node prefix than this binary.
      const command = installCommand(this.installation.channel, {
        bin: this.installation.bin,
        version: status.latest,
      });
      await this.runInstall(command);
      const installed = this.readInstalledVersion();
      if (installed !== status.latest) {
        throw new Error(
          `installer finished but ${PACKAGE_NAME} is still ${installed} (expected ${status.latest}). ` +
            `Tried: ${command}`,
        );
      }
    }
    const installed = this.readInstalledVersion();
    this.current = installed;
    this.latest = installed;
    this.checkedAt = new Date(this.now()).toISOString();
    this.error = undefined;
    this.saveCache();
    return this.status();
  }
}
