import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vite-plus/test";

import {
  SERVICE_LABEL,
  buildServicePlist,
  isManagedByLaunchd,
  passthroughServiceEnv,
  readInstalledServeEntry,
  resolveServeEntry,
} from "./service";

it("detects our LaunchAgent via XPC_SERVICE_NAME", () => {
  expect(isManagedByLaunchd({ XPC_SERVICE_NAME: SERVICE_LABEL })).toBe(true);
  expect(isManagedByLaunchd({ XPC_SERVICE_NAME: "other.job" })).toBe(false);
  expect(isManagedByLaunchd({})).toBe(false);
});

it("resolves the CLI entry to an absolute path", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-service-"));
  try {
    const entry = join(dir, "cli.mjs");
    writeFileSync(entry, "// stub\n");
    const resolved = resolveServeEntry({
      execPath: "/usr/local/bin/node",
      argv1: entry,
    });
    expect(resolved.node).toBe("/usr/local/bin/node");
    expect(resolved.entry).toBe(realpathSync(entry));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("builds a KeepAlive LaunchAgent plist with serve arguments", () => {
  const plist = buildServicePlist({
    node: "/opt/homebrew/bin/node",
    entry: "/Users/me/jevonian/dist/cli.mjs",
    logPath: "/Users/me/.local/share/jevonian/serve.log",
    env: { JEVONIAN_CONFIG: "/tmp/config.json" },
  });
  expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
  expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
  expect(plist).toContain("<string>/Users/me/jevonian/dist/cli.mjs</string>");
  expect(plist).toContain("<string>serve</string>");
  expect(plist).toContain("<key>KeepAlive</key>");
  expect(plist).toContain("<true/>");
  expect(plist).toContain("<key>RunAtLoad</key>");
  expect(plist).toContain("JEVONIAN_NO_OPEN");
  expect(plist).toContain("<string>1</string>");
  expect(plist).toContain("JEVONIAN_CONFIG");
  expect(plist).toContain("/tmp/config.json");
  expect(plist).toContain("/Users/me/.local/share/jevonian/serve.log");
});

it("escapes XML special characters in plist paths", () => {
  const plist = buildServicePlist({
    node: "/tmp/node&bin",
    entry: "/tmp/cli<x>.mjs",
    logPath: '/tmp/log"out".txt',
  });
  expect(plist).toContain("/tmp/node&amp;bin");
  expect(plist).toContain("/tmp/cli&lt;x&gt;.mjs");
  expect(plist).toContain("/tmp/log&quot;out&quot;.txt");
});

it("forwards selected proxy and path env vars into the agent", () => {
  expect(
    passthroughServiceEnv({
      JEVONIAN_CONFIG: "/c.json",
      HTTPS_PROXY: "http://127.0.0.1:1082",
      IGNORED: "nope",
    }),
  ).toEqual({
    JEVONIAN_CONFIG: "/c.json",
    HTTPS_PROXY: "http://127.0.0.1:1082",
  });
});

it("parses ProgramArguments back out of an installed plist", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-plist-"));
  try {
    const plistPath = join(dir, "ai.jevonian.serve.plist");
    writeFileSync(
      plistPath,
      buildServicePlist({
        node: "/opt/homebrew/bin/node",
        entry: "/Users/me/jevonian/dist/cli.mjs",
        logPath: "/tmp/serve.log",
      }),
    );
    expect(readInstalledServeEntry(plistPath)).toEqual({
      node: "/opt/homebrew/bin/node",
      entry: "/Users/me/jevonian/dist/cli.mjs",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
