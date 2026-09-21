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
  command?: string;
}

export interface UpdateStatus {
  current: string;
  latest?: string;
  updateAvailable: boolean;
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
}

function resolveEntry(entry: string): string {
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
}

export function detectInstallation(entry = process.argv[1] ?? ""): Installation {
  const override = process.env.JEVONIAN_INSTALL_CHANNEL;
  if (override === "npm" || override === "pnpm") {
    return { channel: override, command: installCommand(override) };
  }
  if (override === "source" || override === "unknown") return { channel: override };

  const path = resolveEntry(entry).replaceAll("\\", "/");
  if (path.includes("/node_modules/.pnpm/") && path.includes("/node_modules/jevonian/")) {
    return { channel: "pnpm", command: installCommand("pnpm") };
  }
  if (path.includes("/node_modules/jevonian/")) {
    return {
      channel: path.includes("/pnpm/") || path.includes("/.pnpm/") ? "pnpm" : "npm",
      command: installCommand(path.includes("/pnpm/") || path.includes("/.pnpm/") ? "pnpm" : "npm"),
    };
  }
  if (/\/src\/cli\.(ts|js|mjs)$/.test(path)) return { channel: "source" };
  return { channel: "unknown" };
}

function installCommand(channel: "npm" | "pnpm"): string {
  return channel === "pnpm"
    ? `pnpm add --global ${PACKAGE_NAME}@latest`
    : `npm install --global ${PACKAGE_NAME}@latest`;
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
  private readonly current: string;
  private readonly cachePath: string;
  private readonly installation: Installation;
  private readonly now: () => number;
  private readonly fetchLatest: () => Promise<string>;
  private readonly runInstall: (command: string) => Promise<void>;
  private latest?: string;
  private checkedAt?: string;
  private error?: string;

  constructor(options: UpdateManagerOptions) {
    this.current = options.current ?? readPackageVersion();
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
    return {
      current: this.current,
      ...(this.latest ? { latest: this.latest } : {}),
      updateAvailable: this.latest ? isNewerVersion(this.latest, this.current) : false,
      channel: this.installation.channel,
      ...(this.installation.command ? { installCommand: this.installation.command } : {}),
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
    if (!status.updateAvailable) return status;
    if (!this.installation.command) {
      throw new Error(
        `cannot update a ${this.installation.channel} installation; install ${PACKAGE_NAME} from npm first`,
      );
    }
    await this.runInstall(this.installation.command);
    return this.status();
  }
}
