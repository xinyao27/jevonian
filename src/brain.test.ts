import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  askJev,
  cloudflareAiRunUrl,
  httpQuestions,
  normalizeEvaluationResult,
  parseSystemOneResponse,
  routingCriteria,
  unwrapCloudflareAiPayload,
  JEV_CHANNELS,
  findJevChannel,
} from "./brain";

let previousKey: string | undefined;
let previousCredentials: string | undefined;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-brain-"));
  previousCredentials = process.env.JEVONIAN_CREDENTIALS;
  process.env.JEVONIAN_CREDENTIALS = join(dir, "credentials.json");
  previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousCredentials === undefined) delete process.env.JEVONIAN_CREDENTIALS;
  else process.env.JEVONIAN_CREDENTIALS = previousCredentials;
  if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = previousKey;
  rmSync(dir, { recursive: true, force: true });
});

describe("parseSystemOneResponse", () => {
  it("reads choice answers with confidence", () => {
    const parsed = parseSystemOneResponse({
      model: "jev-1.13.0",
      answers: {
        model: {
          choice: "deepseek-v4.1-flash",
          confidence: 0.82,
          probabilities: { "deepseek-v4-pro": 0.1, "deepseek-v4.1-flash": 0.82 },
        },
      },
    });
    expect(parsed.model).toBe("deepseek-v4.1-flash");
    expect(parsed.confidence).toBe(0.82);
    expect(parsed.probabilities).toEqual({
      "deepseek-v4-pro": 0.1,
      "deepseek-v4.1-flash": 0.82,
    });
    expect(parsed.modelName).toBe("jev-1.13.0");
  });

  it("falls back to the grouped answer shape and max probability", () => {
    const parsed = parseSystemOneResponse({
      choices: {
        model: {
          choice: "deepseek-v4-pro",
          probabilities: { "deepseek-v4-pro": 0.7, "deepseek-v4.1-flash": 0.3 },
        },
      },
    });
    expect(parsed.model).toBe("deepseek-v4-pro");
    expect(parsed.confidence).toBe(0.7);
    expect(parsed.probabilities).toEqual({
      "deepseek-v4-pro": 0.7,
      "deepseek-v4.1-flash": 0.3,
    });
  });

  it("reads the none_of_the_above escape hatch", () => {
    const parsed = parseSystemOneResponse({
      answers: { model: { choice: "none_of_the_above", confidence: 0.55 } },
    });
    expect(parsed.model).toBe("none_of_the_above");
    expect(parsed.confidence).toBe(0.55);
    expect(parsed.probabilities).toBeUndefined();
  });

  it("ignores a missing choice", () => {
    const parsed = parseSystemOneResponse({ answers: { model: {} } });
    expect(parsed.model).toBeUndefined();
    expect(parsed.confidence).toBe(0);
  });

  it("keeps the effort distribution alongside the effort choice", () => {
    const parsed = parseSystemOneResponse({
      answers: {
        model: {
          choice: "plan",
          confidence: 0.37,
          probabilities: { plan: 0.37, execute: 0.31, chat: 0.2, utility: 0.12 },
        },
        effort: {
          choice: "low",
          confidence: 0.6,
          probabilities: { none: 0.1, low: 0.6, medium: 0.2, high: 0.1 },
        },
      },
    });
    expect(parsed.model).toBe("plan");
    expect(parsed.probabilities).toEqual({
      plan: 0.37,
      execute: 0.31,
      chat: 0.2,
      utility: 0.12,
    });
    expect(parsed.effort).toBe("low");
    expect(parsed.effortProbabilities).toEqual({
      none: 0.1,
      low: 0.6,
      medium: 0.2,
      high: 0.1,
    });
  });
});

describe("askJev", () => {
  it("posts state and one model question built from the candidates", async () => {
    let captured: { url: string; body: unknown } | undefined;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const rawBody = typeof init.body === "string" ? init.body : "{}";
      captured = { url: String(url), body: JSON.parse(rawBody) as unknown };
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            model: {
              choice: "deepseek-v4.1-flash",
              confidence: 0.9,
              probabilities: {
                "deepseek-v4.1-flash": 0.9,
                "deepseek-v4-pro": 0.08,
                none_of_the_above: 0.02,
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const verdict = await askJev({
      brain: { channel: "typesafe", timeoutMs: 1_000, minConfidence: 0.6 },
      state: {
        last_user_message: "build a cache",
        candidates: [
          { model: "deepseek-v4-pro", provider: "deepseek" },
          { model: "deepseek-v4.1-flash", provider: "deepseek" },
        ],
      },
    });

    expect(verdict).toEqual({
      model: "deepseek-v4.1-flash",
      confidence: 0.9,
      probabilities: {
        "deepseek-v4.1-flash": 0.9,
        "deepseek-v4-pro": 0.08,
        none_of_the_above: 0.02,
      },
      modelName: "jev-1.13.0",
    });
    expect(captured?.url).toBe("https://api.typesafe.ai/v1/systemone");
    const body = captured?.body as { model: string; questions: Record<string, unknown> };
    expect(body.model).toBe("jev-latest");
    // One request, two questions: which model, and how deeply it should think. Both refer to
    // the same narrowed candidate list, so the pair costs no extra round trip.
    expect(Object.keys(body.questions)).toEqual(["model", "effort"]);
    const question = body.questions.model as { type: string; criteria: Record<string, string> };
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria)).toEqual([
      "deepseek-v4-pro",
      "deepseek-v4.1-flash",
      "none_of_the_above",
    ]);
    const effort = body.questions.effort as { type: string; criteria: Record<string, string> };
    expect(effort.type).toBe("choice");
    expect(Object.keys(effort.criteria)).toContain("medium");
  });

  it("returns undefined without an api key", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const verdict = await askJev({
      brain: { channel: "typesafe", timeoutMs: 1_000, minConfidence: 0.6 },
      state: {},
    });
    expect(verdict).toBeUndefined();
  });

  it("uses an explicit api key override without a stored credential", async () => {
    delete process.env.TYPESAFE_API_KEY;
    let authorization: string | null = null;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      authorization = new Headers(init.headers).get("authorization");
      return new Response(
        JSON.stringify({
          answers: { model: { choice: "deepseek-v4-pro", confidence: 0.7 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const verdict = await askJev({
      brain: { channel: "typesafe", timeoutMs: 1_000, minConfidence: 0.6 },
      state: { candidates: [{ model: "deepseek-v4-pro", provider: "deepseek" }] },
      apiKey: "typed-key",
    });

    expect(verdict?.model).toBe("deepseek-v4-pro");
    expect(authorization).toBe("Bearer typed-key");
  });

  it("returns undefined on upstream errors", async () => {
    process.env.JEVONIAN_UPSTREAM_RETRIES = "0";
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    const verdict = await askJev({
      brain: { channel: "typesafe", timeoutMs: 1_000, minConfidence: 0.6 },
      state: {},
    });
    expect(verdict).toBeUndefined();
    delete process.env.JEVONIAN_UPSTREAM_RETRIES;
  });

  it("posts to Cloudflare Workers AI with account id and an input wrapper", async () => {
    let captured: { url: string; body: unknown } | undefined;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            model: "jev-1.13.0",
            answers: {
              model: {
                choice: "plan",
                confidence: 0.91,
                probabilities: { plan: 0.91, execute: 0.09 },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const verdict = await askJev({
      brain: {
        channel: "cloudflare",
        accountId: "acct_123",
        timeoutMs: 1_000,
        minConfidence: 0.6,
      },
      state: {
        routings: [{ id: "plan", label: "Plan", description: "planning" }],
      },
      apiKey: "cf-token",
    });

    expect(verdict?.model).toBe("plan");
    expect(verdict?.confidence).toBe(0.91);
    expect(captured?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct_123/ai/run");
    const body = captured?.body as {
      model: string;
      input: { state: unknown; questions: Record<string, unknown> };
    };
    expect(body.model).toBe("typesafe/jev");
    expect(Object.keys(body.input.questions)).toEqual(["model", "effort"]);
  });

  it("returns undefined for Cloudflare without an account id", async () => {
    const verdict = await askJev({
      brain: { channel: "cloudflare", timeoutMs: 1_000, minConfidence: 0.6 },
      state: {},
      apiKey: "cf-token",
    });
    expect(verdict).toBeUndefined();
  });

  it("retries a brain 429 before giving up", async () => {
    process.env.JEVONIAN_UPSTREAM_RETRIES = "1";
    process.env.TYPESAFE_API_KEY = "test-key";
    let hits = 0;
    vi.stubGlobal("fetch", async () => {
      hits += 1;
      if (hits === 1) return new Response("slow down", { status: 429 });
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { model: { choice: "execute", confidence: 0.9 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const verdict = await askJev({
      brain: { channel: "typesafe", timeoutMs: 5_000, minConfidence: 0.6 },
      state: { last_user_message: "hi" },
      modelOnly: true,
    });

    expect(verdict?.model).toBe("execute");
    expect(hits).toBe(2);
    delete process.env.JEVONIAN_UPSTREAM_RETRIES;
  });
});

describe("cloudflare helpers", () => {
  it("builds the Workers AI run URL", () => {
    expect(cloudflareAiRunUrl(" abc ")).toBe(
      "https://api.cloudflare.com/client/v4/accounts/abc/ai/run",
    );
  });

  it("unwraps the Cloudflare success envelope", () => {
    expect(
      unwrapCloudflareAiPayload({
        success: true,
        result: { answers: { model: { choice: "plan" } } },
      }),
    ).toEqual({ answers: { model: { choice: "plan" } } });
    expect(unwrapCloudflareAiPayload({ success: false, result: {} })).toBeUndefined();
    expect(unwrapCloudflareAiPayload({ answers: { model: { choice: "plan" } } })).toEqual({
      answers: { model: { choice: "plan" } },
    });
  });
});

describe("channels", () => {
  it("lists the supported Jev routes", () => {
    expect(findJevChannel("typesafe")?.baseUrl).toBe("https://api.typesafe.ai/v1/systemone");
    expect(findJevChannel("openrouter")?.model).toBe("typesafe/jev-1.13");
    expect(findJevChannel("opencode-zen")?.baseUrl).toContain("/systemone");
    expect(findJevChannel("vercel")?.model).toBe("typesafe-ai/jev");
    expect(findJevChannel("cloudflare")?.requiresAccountId).toBe(true);
    expect(findJevChannel("cloudflare")?.model).toBe("typesafe/jev");
    expect(JEV_CHANNELS.some((channel) => channel.requiresBaseUrl)).toBe(true);
  });
});

describe("normalizeEvaluationResult", () => {
  it("maps AI SDK evaluation results into the system one shape", () => {
    const normalized = normalizeEvaluationResult({
      answers: {
        model: {
          type: "choice",
          choice: "deepseek-v4.1-flash",
          probabilities: { "deepseek-v4.1-flash": 0.9, "deepseek-v4-pro": 0.1 },
        },
      },
      response: { modelId: "typesafe-ai/jev" },
    });
    const parsed = parseSystemOneResponse(normalized);
    expect(parsed.model).toBe("deepseek-v4.1-flash");
    expect(parsed.confidence).toBe(0.9);
    expect(parsed.probabilities).toEqual({
      "deepseek-v4.1-flash": 0.9,
      "deepseek-v4-pro": 0.1,
    });
    expect(parsed.modelName).toBe("typesafe-ai/jev");
  });
});

describe("routingCriteria", () => {
  it("builds label and description criteria for each routing", () => {
    const criteria = routingCriteria([
      { id: "frontend", label: "Frontend", description: "React, CSS, UI polish" },
      { id: "plan", label: "Plan", description: "planning" },
    ]);
    expect(criteria.frontend).toBe("Frontend: React, CSS, UI polish");
    expect(criteria.plan).toBe("Plan: planning");
    expect(criteria.none_of_the_above).toContain("No listed routing");
  });
});

describe("routing instructions", () => {
  it("tells Jev that models are listed in preference order", () => {
    const questions = httpQuestions({
      brain: { channel: "typesafe", timeoutMs: 1_000, minConfidence: 0.6 },
      state: {
        routings: [{ id: "plan", label: "Plan", description: "planning" }],
      },
    });
    const model = questions.model as { instructions?: string } | undefined;
    expect(model?.instructions ?? "").toContain("preference order");
  });
});
