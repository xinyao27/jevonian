import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vite-plus/test";

import {
  detectInstallation,
  formatUpdateNotice,
  resolvePackageManagerBin,
  UpdateManager,
} from "./updates";

it("formats an update-notifier style notice", () => {
  const notice = formatUpdateNotice(
    { current: "0.0.1", latest: "0.1.0" },
    { colors: false, updateCommand: "jevonian update" },
  );
  expect(notice).toContain("Update available 0.0.1 → 0.1.0");
  expect(notice).toContain("Run jevonian update to update");
  expect(notice).toContain("╭");
  expect(notice).toContain("╰");
});

it("caches a successful registry check across instances for 24 hours", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-update-"));
  try {
    const options = {
      current: "0.0.1",
      cachePath: join(dir, "updates.json"),
      install: async () => {},
      installation: { channel: "npm" as const, command: "npm install --global jevonian@latest" },
      fetchLatest: async () => "0.0.2",
    };
    expect((await new UpdateManager(options).check()).latest).toBe("0.0.2");
    const cached = new UpdateManager({
      ...options,
      fetchLatest: async () => {
        throw new Error("offline");
      },
    });
    expect((await cached.check()).latest).toBe("0.0.2");
    expect(cached.status().error).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reports an available update and installs it through the detected package manager", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-update-"));
  try {
    let installed = "";
    let onDisk = "0.0.1";
    const manager = new UpdateManager({
      current: "0.0.1",
      cachePath: join(dir, "updates.json"),
      installation: {
        channel: "pnpm",
        bin: "/opt/pnpm",
        command: "pnpm add --global jevonian@latest",
      },
      fetchLatest: async () => "0.0.2",
      install: async (command) => {
        installed = command;
        onDisk = "0.0.2";
      },
      readInstalledVersion: () => onDisk,
    });
    expect((await manager.check({ force: true })).updateAvailable).toBe(true);
    const after = await manager.install();
    expect(after.latest).toBe("0.0.2");
    expect(after.current).toBe("0.0.2");
    expect(after.updateAvailable).toBe(false);
    expect(installed).toBe("/opt/pnpm add --global jevonian@0.0.2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("pins npm installs to the fetched version using the Node-adjacent npm binary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-update-"));
  try {
    let installed = "";
    const manager = new UpdateManager({
      current: "0.0.1",
      cachePath: join(dir, "updates.json"),
      installation: {
        channel: "npm",
        bin: "/Users/me/.vite-plus/js_runtime/node/24.21.0/bin/npm",
      },
      fetchLatest: async () => "0.0.2",
      install: async (command) => {
        installed = command;
      },
      readInstalledVersion: () => "0.0.2",
    });
    await manager.install();
    expect(installed).toBe(
      "/Users/me/.vite-plus/js_runtime/node/24.21.0/bin/npm install --global jevonian@0.0.2",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("fails the update when the installer leaves the old version on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-update-"));
  try {
    const manager = new UpdateManager({
      current: "0.0.1",
      cachePath: join(dir, "updates.json"),
      installation: { channel: "npm", bin: "/usr/local/bin/npm" },
      fetchLatest: async () => "0.0.2",
      install: async () => {},
      readInstalledVersion: () => "0.0.1",
    });
    await expect(manager.install()).rejects.toThrow(/still 0\.0\.1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("resolves the package manager next to process.execPath", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-node-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const npm = join(bin, "npm");
    writeFileSync(npm, "#!/bin/sh\n", { mode: 0o755 });
    expect(resolvePackageManagerBin("npm", join(bin, "node"))).toBe(npm);
    expect(
      detectInstallation(join(dir, "lib/node_modules/jevonian/dist/cli.mjs"), join(bin, "node")),
    ).toMatchObject({
      channel: "npm",
      bin: npm,
      command: `${npm} install --global jevonian@latest`,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("never treats source checkouts as self-updating npm installations", () => {
  expect(detectInstallation("/Users/me/work/jevonian/src/cli.ts").channel).toBe("source");
  expect(detectInstallation("/usr/local/lib/node_modules/jevonian/dist/cli.mjs").channel).toBe(
    "npm",
  );
  expect(
    detectInstallation("/Users/me/Library/pnpm/global/5/node_modules/jevonian/dist/cli.mjs")
      .channel,
  ).toBe("pnpm");
});

it("ignores an expired or corrupted cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-update-"));
  try {
    const path = join(dir, "updates.json");
    writeFileSync(path, "not json");
    let calls = 0;
    const manager = new UpdateManager({
      current: "0.0.1",
      cachePath: path,
      installation: { channel: "npm" },
      fetchLatest: async () => {
        calls += 1;
        return "0.0.1";
      },
    });
    expect((await manager.check()).updateAvailable).toBe(false);
    expect(calls).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("re-checks the registry after the 24h cache window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-update-"));
  try {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    let calls = 0;
    const manager = new UpdateManager({
      current: "0.0.1",
      cachePath: join(dir, "updates.json"),
      installation: { channel: "npm", command: "npm install --global jevonian@latest" },
      now: () => now,
      fetchLatest: async () => {
        calls += 1;
        return calls === 1 ? "0.0.1" : "0.0.2";
      },
    });
    expect((await manager.check()).updateAvailable).toBe(false);
    expect(calls).toBe(1);
    now += 24 * 60 * 60 * 1_000 + 1;
    expect((await manager.check()).updateAvailable).toBe(true);
    expect(calls).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
