import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vite-plus/test";

import { detectInstallation, formatUpdateNotice, UpdateManager } from "./updates";

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
    const manager = new UpdateManager({
      current: "0.0.1",
      cachePath: join(dir, "updates.json"),
      installation: { channel: "pnpm", command: "pnpm add --global jevonian@latest" },
      fetchLatest: async () => "0.0.2",
      install: async (command) => {
        installed = command;
      },
    });
    expect((await manager.check({ force: true })).updateAvailable).toBe(true);
    expect((await manager.install()).latest).toBe("0.0.2");
    expect(installed).toBe("pnpm add --global jevonian@latest");
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
