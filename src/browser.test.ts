import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { openBrowserOnce, shouldSkipBrowserOpen, type BrowserState } from "./browser";

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), "jevonian-browser-")), "browser-state.json");
}

const NOW = Date.parse("2026-09-20T00:00:00.000Z");

describe("shouldSkipBrowserOpen", () => {
  it("opens when nothing was opened yet", () => {
    expect(shouldSkipBrowserOpen(undefined)).toBe(false);
  });

  it("skips when a marker already exists", () => {
    const previous: BrowserState = { pid: 42, openedAt: NOW };
    expect(shouldSkipBrowserOpen(previous)).toBe(true);
  });
});

describe("openBrowserOnce", () => {
  it("launches once and skips subsequent launches", () => {
    const path = statePath();
    const launch = vi.fn();

    const first = openBrowserOnce("http://127.0.0.1:8787/", {
      statePath: path,
      pid: 100,
      now: NOW,
      launch,
    });
    const second = openBrowserOnce("http://127.0.0.1:8787/", {
      statePath: path,
      pid: 200,
      now: NOW + 60_000,
      launch,
    });

    expect(first).toEqual({ opened: true, reason: "opened" });
    expect(second).toEqual({ opened: false, reason: "already-open" });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: 100, openedAt: NOW });
  });

  it("opens every time without a state path", () => {
    const launch = vi.fn();
    openBrowserOnce("http://127.0.0.1:8787/", { launch });
    openBrowserOnce("http://127.0.0.1:8787/", { launch });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("ignores a corrupted marker", () => {
    const path = statePath();
    writeFileSync(path, "not json");
    const launch = vi.fn();

    const result = openBrowserOnce("http://127.0.0.1:8787/", {
      statePath: path,
      pid: 100,
      now: NOW,
      launch,
    });

    expect(result).toEqual({ opened: true, reason: "opened" });
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
