import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vite-plus/test";

import { createAdminApp, type AppState } from "./admin";
import { parseConfig } from "./config";
import { ServerLifecycle } from "./lifecycle";
import { UpdateManager } from "./updates";

it("keeps serving while the package installs, then drains before restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-update-admin-"));
  let releaseInstall: (() => void) | undefined;
  const installWait = new Promise<void>((resolve) => {
    releaseInstall = resolve;
  });
  let restarted = false;
  let onDisk = "0.0.1";
  const lifecycle = new ServerLifecycle();
  const updates = new UpdateManager({
    current: "0.0.1",
    cachePath: join(dir, "updates.json"),
    installation: { channel: "npm", command: "npm install --global jevonian@latest" },
    fetchLatest: async () => "0.0.2",
    install: async () => {
      await installWait;
      onDisk = "0.0.2";
    },
    readInstalledVersion: () => onDisk,
  });
  await updates.check({ force: true });
  const state: AppState = {
    config: parseConfig({}),
    updates,
    lifecycle,
    restart: () => {
      restarted = true;
    },
  };
  const app = createAdminApp(state);

  try {
    const response = await app.request("/update/install", { method: "POST" });
    expect(response.status).toBe(202);
    expect(lifecycle.draining).toBe(false);
    const inFlight = lifecycle.beginRequest();

    releaseInstall?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lifecycle.draining).toBe(true);
    expect(restarted).toBe(false);

    inFlight();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restarted).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("resumes serving when the package install fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-update-admin-"));
  const lifecycle = new ServerLifecycle();
  const updates = new UpdateManager({
    current: "0.0.1",
    cachePath: join(dir, "updates.json"),
    installation: { channel: "npm", command: "npm install --global jevonian@latest" },
    fetchLatest: async () => "0.0.2",
    install: async () => {
      throw new Error("registry unavailable");
    },
    readInstalledVersion: () => "0.0.1",
  });
  await updates.check({ force: true });
  const state: AppState = {
    config: parseConfig({}),
    updates,
    lifecycle,
    restart: () => {
      throw new Error("restart should not run");
    },
  };
  const app = createAdminApp(state);

  try {
    const response = await app.request("/update/install", { method: "POST" });
    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lifecycle.draining).toBe(false);
    expect(state.updateError).toBe("registry unavailable");
    const status = await app.request("/update");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ error: "registry unavailable" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("refreshes a stale update cache when the dashboard polls GET /update", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-update-admin-"));
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  let calls = 0;
  const updates = new UpdateManager({
    current: "0.0.1",
    cachePath: join(dir, "updates.json"),
    installation: { channel: "npm", command: "npm install --global jevonian@latest" },
    now: () => now,
    fetchLatest: async () => {
      calls += 1;
      return calls === 1 ? "0.0.1" : "0.0.2";
    },
    readInstalledVersion: () => "0.0.1",
  });
  await updates.check();
  expect(calls).toBe(1);
  now += 24 * 60 * 60 * 1_000 + 1;

  const app = createAdminApp({
    config: parseConfig({}),
    updates,
    lifecycle: new ServerLifecycle(),
  });

  try {
    const response = await app.request("/update");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      update: { latest: "0.0.2", updateAvailable: true },
    });
    expect(calls).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("restarts without reinstalling when the package on disk is already latest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-update-admin-"));
  let restarted = false;
  const lifecycle = new ServerLifecycle();
  const updates = new UpdateManager({
    current: "0.1.5",
    cachePath: join(dir, "updates.json"),
    installation: { channel: "npm", command: "npm install --global jevonian@latest" },
    fetchLatest: async () => "0.1.6",
    install: async () => {
      throw new Error("should not reinstall");
    },
    readInstalledVersion: () => "0.1.6",
  });
  await updates.check({ force: true });
  const app = createAdminApp({
    config: parseConfig({}),
    updates,
    lifecycle,
    restart: () => {
      restarted = true;
    },
  });

  try {
    const response = await app.request("/update/install", { method: "POST" });
    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restarted).toBe(true);
    expect(updates.status().current).toBe("0.1.6");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
