import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { resolveApiKey, type Provider } from "./config";
import {
  credentialsPath,
  getCredential,
  maskKey,
  removeCredential,
  setCredential,
} from "./credentials";

let dir = "";
let previous = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-creds-"));
  previous = process.env.XDG_CONFIG_HOME ?? "";
  process.env.XDG_CONFIG_HOME = dir;
});

afterEach(() => {
  if (previous) process.env.XDG_CONFIG_HOME = previous;
  else delete process.env.XDG_CONFIG_HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe("credentials", () => {
  it("stores, reads, and removes provider keys", () => {
    setCredential("deepseek", "sk-test-1234567890");
    expect(getCredential("deepseek")).toBe("sk-test-1234567890");
    removeCredential("deepseek");
    expect(getCredential("deepseek")).toBeUndefined();
  });

  it("writes the credentials file with owner-only permissions", () => {
    setCredential("anthropic", "sk-ant-test");
    const mode = statSync(credentialsPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("ignores malformed credentials files", () => {
    const path = credentialsPath();
    mkdirSync(join(dir, "jevonian"), { recursive: true });
    writeFileSync(path, "{ not json");
    expect(getCredential("missing")).toBeUndefined();
    setCredential("deepseek", "sk-test");
    expect(getCredential("deepseek")).toBe("sk-test");
  });

  it("masks keys for display", () => {
    expect(maskKey("sk-1234567890abcdef")).toBe("sk-1…cdef");
    expect(maskKey("short")).toBe("****");
  });

  it("resolves provider keys from the credentials store", () => {
    setCredential("deepseek", "sk-stored");
    const provider: Provider = {
      name: "deepseek",
      type: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKeyEnv: "JEVONIAN_TEST_UNSET_KEY",
      auth: "api-key",
      billing: "api",
      models: [],
      injectStreamUsage: true,
    };
    expect(resolveApiKey(provider)).toBe("sk-stored");
  });
});
