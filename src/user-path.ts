import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Directories where users commonly keep CLI tools (Homebrew, cargo, etc.).
 *
 * launchd and some GUI-spawned processes ship a stripped PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) that omits these, so `ngrok` /
 * `cloudflared` look "not installed" even when they are on disk.
 */
export function candidateUserBinDirs(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  if (platform === "win32") {
    return [
      join(home, "AppData", "Local", "Microsoft", "WindowsApps"),
      join(home, ".local", "bin"),
      join(home, "bin"),
    ];
  }
  return [
    join(home, ".local", "bin"),
    join(home, "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/opt/local/bin",
    "/snap/bin",
  ];
}

export interface AugmentPathOptions {
  /** Extra dirs to consider; defaults to {@link candidateUserBinDirs} that exist. */
  dirs?: string[];
  exists?: (dir: string) => boolean;
  delimiter?: string;
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * Prepend missing user/package-manager bin dirs onto a PATH string.
 *
 * Existing entries win on conflict; we only add directories that are present on
 * disk and not already listed.
 */
export function augmentPath(
  pathValue: string | undefined = process.env.PATH,
  options: AugmentPathOptions = {},
): string {
  const sep = options.delimiter ?? delimiter;
  const exists = options.exists ?? existsSync;
  const dirs =
    options.dirs ??
    candidateUserBinDirs(options.platform, options.home).filter((dir) => exists(dir));
  const current = (pathValue ?? "").split(sep).filter(Boolean);
  const seen = new Set(current);
  const prepend: string[] = [];
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    prepend.push(dir);
    seen.add(dir);
  }
  return [...prepend, ...current].join(sep);
}

/** Copy of `env` with PATH expanded for user-installed CLIs. */
export function withAugmentedPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, PATH: augmentPath(env.PATH) };
}

/**
 * Mutate `env.PATH` in place so later spawns (and this process) can find
 * Homebrew / local binaries under launchd-style minimal environments.
 */
export function applyUserBinPath(env: NodeJS.ProcessEnv = process.env): string {
  const next = augmentPath(env.PATH);
  env.PATH = next;
  return next;
}
