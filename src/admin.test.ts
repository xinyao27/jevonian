import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createAdminApp, type AppState } from "./admin";
import { saveBody } from "./bodies";
import { loadConfig, parseConfig } from "./config";
import { getCredential } from "./credentials";
import { appendRecord } from "./ledger";

let dir = "";
let previousConfig: string | undefined;
let previousData: string | undefined;
let previousLedger: string | undefined;
let previousCredentials: string | undefined;

const baseProvider = (name: string) => ({
  name,
  type: "openai" as const,
  baseUrl: `https://${name}.example.com/v1`,
  apiKey: "test",
  models: [`${name}-model`],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-admin-"));
  previousConfig = process.env.JEVONIAN_CONFIG;
  previousData = process.env.JEVONIAN_DATA_DIR;
  previousLedger = process.env.JEVONIAN_LEDGER;
  previousCredentials = process.env.JEVONIAN_CREDENTIALS;
  process.env.JEVONIAN_CONFIG = join(dir, "config.json");
  process.env.JEVONIAN_DATA_DIR = join(dir, "data");
  process.env.JEVONIAN_LEDGER = join(dir, "ledger.jsonl");
  process.env.JEVONIAN_CREDENTIALS = join(dir, "credentials.json");
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.JEVONIAN_CONFIG;
  else process.env.JEVONIAN_CONFIG = previousConfig;
  if (previousData === undefined) delete process.env.JEVONIAN_DATA_DIR;
  else process.env.JEVONIAN_DATA_DIR = previousData;
  if (previousLedger === undefined) delete process.env.JEVONIAN_LEDGER;
  else process.env.JEVONIAN_LEDGER = previousLedger;
  if (previousCredentials === undefined) delete process.env.JEVONIAN_CREDENTIALS;
  else process.env.JEVONIAN_CREDENTIALS = previousCredentials;
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(path: string, providers: ReturnType<typeof baseProvider>[]): void {
  writeFileSync(path, `${JSON.stringify({ providers }, null, 2)}\n`);
}

describe("admin config writes", () => {
  it("merges routing changes into the file instead of clobbering external edits", async () => {
    const path = process.env.JEVONIAN_CONFIG ?? "";
    writeConfig(path, [baseProvider("alpha")]);

    const stale = parseConfig({ providers: [baseProvider("alpha")] });
    const state: AppState = { config: stale };
    const app = createAdminApp(state);

    writeConfig(path, [baseProvider("alpha"), baseProvider("beta")]);

    const response = await app.request("/routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "auto",
        tiers: { plan: ["beta-model"], execute: [], utility: [] },
        sessionTtlMinutes: 900,
      }),
    });
    expect(response.status).toBe(200);

    const written = JSON.parse(readFileSync(path, "utf8")) as {
      providers: Array<{ name: string }>;
      routing: {
        tiers: { plan: string[] };
        routings: Array<{ id: string; models: string[] }>;
        sessionTtlMinutes: number;
      };
    };
    expect(written.providers.map((provider) => provider.name)).toEqual(["alpha", "beta"]);
    expect(written.routing.tiers.plan).toEqual(["beta-model"]);
    expect(written.routing.routings.find((entry) => entry.id === "plan")?.models).toEqual([
      "beta-model",
    ]);
    expect(written.routing.sessionTtlMinutes).toBe(900);
    expect(state.config.providers).toHaveLength(2);
  });

  it("manages multiple brains with fallback order", async () => {
    const path = process.env.JEVONIAN_CONFIG ?? "";
    writeConfig(path, []);
    const state: AppState = { config: loadConfig() ?? parseConfig({}) };
    const app = createAdminApp(state);

    const post = async (body: unknown): Promise<Response> =>
      app.request("/brains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const first = await post({
      channel: "custom",
      baseUrl: "http://127.0.0.1:1/x",
      model: "jev-latest",
      apiKey: "secret",
    });
    expect(first.status).toBe(201);
    const second = await post({ channel: "openrouter", apiKey: "secret2" });
    expect(second.status).toBe(201);

    let config = loadConfig() ?? parseConfig({});
    expect(config.routing.brains.map((brain) => brain.channel)).toEqual(["custom", "openrouter"]);
    expect(getCredential("brain:custom")).toBe("secret");
    expect(getCredential("brain:openrouter")).toBe("secret2");

    const moved = await app.request("/brains/1/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "up" }),
    });
    expect(moved.status).toBe(200);
    config = loadConfig() ?? parseConfig({});
    expect(config.routing.brains.map((brain) => brain.channel)).toEqual(["openrouter", "custom"]);

    const deleted = await app.request("/brains/0", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    config = loadConfig() ?? parseConfig({});
    expect(config.routing.brains.map((brain) => brain.channel)).toEqual(["custom"]);
    expect(getCredential("brain:openrouter")).toBeUndefined();
    expect(getCredential("brain:custom")).toBe("secret");
  });

  it("serves a log detail with the prompt and brain calls", async () => {
    const requestId = "11111111-2222-3333-4444-555555555555";
    appendRecord({
      id: requestId,
      ts: new Date().toISOString(),
      session: "s",
      path: "/chat/completions",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      stream: false,
      status: 200,
      latencyMs: 10,
      promptTokens: 3,
      completionTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.001,
      pricingKnown: true,
      kind: "request",
    });
    saveBody(requestId, {
      kind: "request",
      body: { messages: [{ role: "user", content: "jev check" }] },
    });
    const brainId = "66666666-7777-8888-9999-000000000000";
    appendRecord({
      id: brainId,
      requestId,
      kind: "brain",
      ts: new Date().toISOString(),
      session: "s",
      path: "/brain",
      provider: "brain:typesafe",
      model: "jev-latest",
      stream: false,
      status: 200,
      latencyMs: 5,
      promptTokens: 120,
      completionTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      pricingKnown: false,
    });
    saveBody(brainId, {
      kind: "brain",
      state: { last_user_message: "jev check" },
      verdict: { model: "deepseek-v4.1-flash", confidence: 0.9 },
    });
    const app = createAdminApp({ config: parseConfig({}) });

    const response = await app.request(`/logs/${requestId}`);
    expect(response.status).toBe(200);
    const detail = (await response.json()) as {
      body: { body: { messages: Array<{ content: string }> } };
      brainCalls: Array<{ record: { provider: string }; body: { verdict: { model: string } } }>;
    };
    expect(detail.body.body.messages[0]?.content).toBe("jev check");
    expect(detail.brainCalls).toHaveLength(1);
    expect(detail.brainCalls[0]?.record.provider).toBe("brain:typesafe");
    expect(detail.brainCalls[0]?.body.verdict.model).toBe("deepseek-v4.1-flash");

    expect((await app.request("/logs/does-not-exist")).status).toBe(404);
  });

  it("paginates logs with an exclusive cursor and reports totals", async () => {
    for (let index = 0; index < 25; index += 1) {
      appendRecord({
        id: `page-${index}`,
        ts: new Date(Date.now() + index).toISOString(),
        session: `s-${index}`,
        path: "/chat/completions",
        provider: "deepseek",
        model: index % 2 === 0 ? "deepseek-v4-pro" : "claude-fable-5-1",
        phase: index % 2 === 0 ? "execute" : "plan",
        stream: false,
        status: 200,
        latencyMs: index,
        promptTokens: 1,
        completionTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.001,
        pricingKnown: true,
        kind: "request",
      });
    }
    const app = createAdminApp({ config: parseConfig({}) });

    const first = (await (await app.request("/logs?limit=10")).json()) as {
      logs: Array<{ id: string }>;
      total: number;
      nextBefore: number | null;
    };
    expect(first.logs).toHaveLength(10);
    expect(first.total).toBe(25);
    expect(first.nextBefore).not.toBeNull();
    // Newest first.
    expect(first.logs[0]?.id).toBe("page-24");

    const second = (await (
      await app.request(`/logs?limit=10&before=${first.nextBefore}`)
    ).json()) as { logs: Array<{ id: string }>; nextBefore: number | null };
    expect(second.logs).toHaveLength(10);
    // Pages must not overlap: cursor is exclusive.
    const firstIds = new Set(first.logs.map((log) => log.id));
    for (const log of second.logs) expect(firstIds.has(log.id)).toBe(false);

    const last = (await (
      await app.request(`/logs?limit=10&before=${second.nextBefore}`)
    ).json()) as { logs: Array<{ id: string }>; nextBefore: number | null };
    expect(last.logs).toHaveLength(5);
    // Exhausted: the client is told to stop asking.
    expect(last.nextBefore).toBeNull();
  });

  it("filters the paginated list, the chart series, and the total consistently", async () => {
    for (const [index, phase] of ["plan", "execute", "execute", "chat"].entries()) {
      appendRecord({
        id: `filter-${index}`,
        ts: new Date().toISOString(),
        session: "s",
        path: "/chat/completions",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        phase,
        stream: false,
        status: 200,
        latencyMs: 5,
        promptTokens: 1,
        completionTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.002,
        pricingKnown: true,
        kind: "request",
      });
    }
    // A brain record must never surface in the request list or the counts.
    appendRecord({
      id: "filter-brain",
      kind: "brain",
      ts: new Date().toISOString(),
      session: "s",
      path: "/brain",
      provider: "brain:typesafe",
      model: "jev-latest",
      stream: false,
      status: 200,
      latencyMs: 5,
      promptTokens: 1,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      pricingKnown: false,
    });
    const app = createAdminApp({ config: parseConfig({}) });

    const execute = (await (await app.request("/logs?phase=execute")).json()) as {
      logs: unknown[];
      total: number;
    };
    expect(execute.logs).toHaveLength(2);
    expect(execute.total).toBe(2);

    const series = (await (
      await app.request("/logs/series?minutes=60&buckets=6&phase=execute")
    ).json()) as { buckets: Array<{ requests: number; errors: number; avgLatencyMs: number }> };
    expect(series.buckets).toHaveLength(6);
    // The chart must agree with the list for the same filter.
    const charted = series.buckets.reduce((total, bucket) => total + bucket.requests, 0);
    expect(charted).toBe(2);
    const latest = series.buckets.at(-1);
    expect(latest?.avgLatencyMs).toBe(5);
  });

  it("pushes appended records to the log stream", async () => {
    const app = createAdminApp({ config: parseConfig({}) });
    const response = await app.request("/logs/stream");
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Drain the initial `ready` frame before writing, so the assertion below cannot
    // accidentally match it.
    const firstChunk = await reader?.read();
    buffer += decoder.decode(firstChunk?.value, { stream: true });
    expect(buffer).toContain("event: ready");

    appendRecord({
      id: "stream-1",
      ts: new Date().toISOString(),
      session: "s",
      path: "/chat/completions",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      phase: "execute",
      stream: false,
      status: 200,
      latencyMs: 7,
      promptTokens: 1,
      completionTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.001,
      pricingKnown: true,
      kind: "request",
    });

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !buffer.includes("stream-1")) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    expect(buffer).toContain("event: log");
    expect(buffer).toContain("stream-1");
    await reader?.cancel();
  });

  it("keeps provider edits made through the api", async () => {
    const path = process.env.JEVONIAN_CONFIG ?? "";
    writeConfig(path, [baseProvider("alpha")]);
    const state: AppState = { config: parseConfig({ providers: [baseProvider("alpha")] }) };
    const app = createAdminApp(state);

    const response = await app.request("/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "gamma",
        type: "openai",
        baseUrl: "https://gamma.example.com/v1",
        apiKey: "test",
        models: ["gamma-model"],
      }),
    });
    expect(response.status).toBe(200);

    const written = JSON.parse(readFileSync(path, "utf8")) as {
      providers: Array<{ name: string }>;
    };
    expect(written.providers.map((provider) => provider.name)).toEqual(["alpha", "gamma"]);
  });

  it("round-trips syncModels and records dashboard removals in excludeModels", async () => {
    const path = process.env.JEVONIAN_CONFIG ?? "";
    writeFileSync(
      path,
      `${JSON.stringify({
        providers: [
          {
            ...baseProvider("alpha"),
            models: ["a", "b"],
            syncModels: true,
          },
        ],
      })}\n`,
    );
    const state: AppState = { config: loadConfig() ?? parseConfig({}) };
    const app = createAdminApp(state);

    const view = (await (await app.request("/state")).json()) as {
      config: { providers: Array<{ name: string; syncModels?: boolean }> };
    };
    // An explicit `true` must reach the form, or the next save would silently turn sync off.
    expect(view.config.providers[0]?.syncModels).toBe(true);

    const post = (body: Record<string, unknown>) =>
      app.request("/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "alpha",
          type: "openai",
          baseUrl: "https://alpha.example.com/v1",
          ...body,
        }),
      });
    const written = () =>
      JSON.parse(readFileSync(path, "utf8")) as {
        providers: Array<{ models: string[]; syncModels?: boolean; excludeModels?: string[] }>;
      };

    // Absent keeps the override; dropping "b" is remembered.
    expect((await post({ models: ["a"] })).status).toBe(200);
    expect(written().providers[0]?.syncModels).toBe(true);
    expect(written().providers[0]?.excludeModels).toEqual(["b"]);

    // `null` clears the override so the provider follows its default again.
    expect((await post({ models: ["a"], syncModels: null })).status).toBe(200);
    expect(written().providers[0]).not.toHaveProperty("syncModels");
    expect(written().providers[0]?.excludeModels).toEqual(["b"]);
  });

  it("clamps a too-short model-sync interval", async () => {
    const path = process.env.JEVONIAN_CONFIG ?? "";
    writeConfig(path, [baseProvider("alpha")]);
    const app = createAdminApp({ config: loadConfig() ?? parseConfig({}) });
    const response = await app.request("/model-sync", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intervalMinutes: 5 }),
    });
    const body = (await response.json()) as { config: { intervalMinutes: number } };
    expect(body.config.intervalMinutes).toBe(15);
  });

  it("saves custom routings and rejects dropping a builtin", async () => {
    const path = process.env.JEVONIAN_CONFIG ?? "";
    writeConfig(path, [baseProvider("alpha")]);
    const state: AppState = { config: loadConfig() ?? parseConfig({}) };
    const app = createAdminApp(state);

    const ok = await app.request("/routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routings: [
          { id: "plan", label: "Plan", description: "plan", models: ["alpha-model"] },
          { id: "execute", label: "Execute", description: "exec", models: ["alpha-model"] },
          { id: "utility", label: "Background", description: "bg", models: ["alpha-model"] },
          { id: "chat", label: "Chat", description: "chat", models: ["alpha-model"] },
          {
            id: "frontend",
            label: "Frontend",
            description: "React UI",
            models: ["alpha-model"],
          },
        ],
      }),
    });
    expect(ok.status).toBe(200);
    const payload = (await ok.json()) as {
      routings: Array<{ id: string; description: string }>;
    };
    expect(payload.routings.some((entry) => entry.id === "frontend")).toBe(true);

    const withOrder = await app.request("/routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routings: [
          {
            id: "plan",
            label: "Plan",
            description: "plan",
            models: ["alpha-model"],
            providers: { "alpha-model": ["beta", "alpha"] },
          },
          { id: "execute", label: "Execute", description: "exec", models: ["alpha-model"] },
          { id: "utility", label: "Background", description: "bg", models: ["alpha-model"] },
          { id: "chat", label: "Chat", description: "chat", models: ["alpha-model"] },
        ],
      }),
    });
    expect(withOrder.status).toBe(200);
    const ordered = (await withOrder.json()) as {
      routings: Array<{ id: string; providers?: Record<string, string[]> }>;
    };
    expect(ordered.routings.find((entry) => entry.id === "plan")?.providers).toEqual({
      "alpha-model": ["beta", "alpha"],
    });

    // Removing the last provider must survive the round-trip as an empty list. Dropping it
    // would read back as "no entry", i.e. every provider — the opposite of the edit.
    const emptied = await app.request("/routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routings: [
          {
            id: "plan",
            label: "Plan",
            description: "plan",
            models: ["alpha-model"],
            providers: { "alpha-model": [] },
          },
          { id: "execute", label: "Execute", description: "exec", models: ["alpha-model"] },
          { id: "utility", label: "Background", description: "bg", models: ["alpha-model"] },
          { id: "chat", label: "Chat", description: "chat", models: ["alpha-model"] },
        ],
      }),
    });
    expect(emptied.status).toBe(200);
    const stored = JSON.parse(readFileSync(path, "utf8")) as {
      routing: { routings: Array<{ id: string; providers?: Record<string, string[]> }> };
    };
    expect(stored.routing.routings.find((entry) => entry.id === "plan")?.providers).toEqual({
      "alpha-model": [],
    });

    const rejected = await app.request("/routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routings: [
          { id: "plan", label: "Plan", description: "plan", models: [] },
          { id: "execute", label: "Execute", description: "exec", models: [] },
          { id: "utility", label: "Background", description: "bg", models: [] },
          // chat missing — builtin must remain
        ],
      }),
    });
    expect(rejected.status).toBe(400);
  });
});
