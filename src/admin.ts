import { hostname } from "node:os";

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { computeActivityReport } from "./activity";
import { loadBody } from "./bodies";
import { askJev, brainCredentialName, findJevChannel, JEV_CHANNELS } from "./brain";
import { discoverProviderModels } from "./catalog";
import {
  applyClient,
  clientTargets,
  isClientRunning,
  restoreClient,
  restartClient,
  type ClientId,
} from "./clients";
import {
  apiKeySource,
  applyTiersToRoutings,
  DEFAULT_BRAIN,
  findProviderByName,
  isRoutingId,
  loadConfig,
  parseCapacities,
  parseRoutings,
  resolveApiKey,
  saveConfig,
  syncRoutingViews,
  tiersFromRoutings,
  mergeModelEntries,
  providerModelIds,
  type BrainConfig,
  type Config,
  type Provider,
  type ProviderAuth,
  type ProviderBilling,
  type ProviderQuotaSpec,
  type ProviderType,
  type QuotaGuardConfig,
  type RoutingEntry,
} from "./config";
import { parseTunnel } from "./config";
import { getCredential, removeCredential, setCredential } from "./credentials";
import { createKey, hasKeys, listKeysWithUsage, revokeKey, updateKey } from "./keys";
import { readRecords, subscribeLedger, type LedgerRecord } from "./ledger";
import type { ServerLifecycle } from "./lifecycle";
import { canonicalModelId, canonicalModels } from "./models";
import { loadPricingSnapshot } from "./modelsdev";
import type { OAuthSource } from "./oauth";
import { initPricing, priceFor, pricingInfo } from "./pricing";
import { PRESETS } from "./providers";
import { providerQuotaHealth, providerQuotas } from "./quota";
import { claudeCodeModels, deriveRoutings, deriveTiers, desktopModels } from "./routing";
import { summarize } from "./stats";
import type { TunnelManager } from "./tunnel";
import type { UpdateManager, UpdateStatus } from "./updates";

export interface AppState {
  config: Config;
  tunnel?: TunnelManager;
  updates?: UpdateManager;
  lifecycle?: ServerLifecycle;
  restart?: () => void | Promise<void>;
  updateError?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Filter set shared by the paginated list, the live stream, and the header chart.
 *
 * Keeping one matcher means a row can never appear in one view and not another: the
 * chart, the stream, and the pages all agree on what "matching" means.
 */
interface LogFilters {
  phase?: string;
  model?: string;
  query?: string;
}

function logFilters(phase?: string, model?: string, query?: string): LogFilters {
  const trimmed = query?.trim().toLowerCase();
  return {
    ...(phase && phase !== "all" ? { phase } : {}),
    ...(model && model.trim() ? { model: model.trim() } : {}),
    ...(trimmed ? { query: trimmed } : {}),
  };
}

/** Free-text search covers the fields the row actually shows, plus routing reason. */
function haystack(record: LedgerRecord): string {
  return [record.model, record.provider, record.phase, record.session, record.reason, record.effort]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function matchesLogFilters(record: LedgerRecord, filters: LogFilters): boolean {
  if (record.kind === "brain") return false;
  if (filters.phase && (record.phase ?? "-") !== filters.phase) return false;
  if (filters.model && record.model !== filters.model) return false;
  if (filters.query && !haystack(record).includes(filters.query)) return false;
  return true;
}

function parseClientId(value: string): ClientId | undefined {
  // `claude-code` remains accepted as an alias for the merged Claude client.
  if (value === "chatgpt" || value === "claude" || value === "claude-code")
    return value === "claude-code" ? "claude" : value;
  return undefined;
}

/** `null` / empty / non-positive means "no limit"; anything else is a USD ceiling. */
function parseLimitUsd(value: unknown): number | null {
  if (value === null || value === "" || value === undefined) return null;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Models advertised to desktop clients.
 *
 * Clients must see Jevonian's virtual routing aliases, not upstream model
 * names: the whole point is that `jevonian/auto` routes dynamically, so
 * exposing `deepseek-v4-1-flash` would pin the client to one provider and hide
 * Jevonian behind it. Upstream names are only used as a fallback when routing
 * is off and no alias exists.
 */
function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function parseType(value: unknown): ProviderType {
  if (value === "anthropic" || value === "responses" || value === "both" || value === "gemini") {
    return value;
  }
  return "openai";
}

function parseAuth(value: unknown): ProviderAuth {
  return value === "oauth" ? "oauth" : "api-key";
}

function parseOAuthSource(value: unknown): OAuthSource | undefined {
  if (value === "claude-code" || value === "codex" || value === "antigravity" || value === "static")
    return value;
  return undefined;
}

function parseBilling(value: unknown): ProviderBilling {
  return value === "subscription" ? "subscription" : "api";
}

function parseQuotaGuard(value: unknown, fallback: QuotaGuardConfig): QuotaGuardConfig {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return fallback;
  const lowPercent = record.lowPercent;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    lowPercent:
      typeof lowPercent === "number" && lowPercent >= 0 && lowPercent <= 100
        ? lowPercent
        : fallback.lowPercent,
  };
}

function parseQuota(value: unknown): ProviderQuotaSpec | undefined {
  const record = asRecord(value);
  const quota: ProviderQuotaSpec = {};
  if (typeof record.fiveHourUsd === "number" && record.fiveHourUsd > 0) {
    quota.fiveHourUsd = record.fiveHourUsd;
  }
  if (typeof record.weeklyUsd === "number" && record.weeklyUsd > 0) {
    quota.weeklyUsd = record.weeklyUsd;
  }
  if (typeof record.monthlyUsd === "number" && record.monthlyUsd > 0) {
    quota.monthlyUsd = record.monthlyUsd;
  }
  return Object.keys(quota).length > 0 ? quota : undefined;
}

function providerPayload(body: Record<string, unknown>, name: string, baseUrl: string): Provider {
  const auth = parseAuth(body.auth);
  const oauthSource = auth === "oauth" ? parseOAuthSource(body.oauthSource) : undefined;
  const quota = parseQuota(body.quota);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const apiKeyEnv = typeof body.apiKeyEnv === "string" ? body.apiKeyEnv.trim() : "";
  return {
    name,
    type: parseType(body.type),
    baseUrl,
    auth,
    ...(oauthSource ? { oauthSource } : {}),
    billing: parseBilling(body.billing),
    ...(quota ? { quota } : {}),
    ...(apiKey ? {} : apiKeyEnv ? { apiKeyEnv } : {}),
    models: mergeModelEntries(undefined, body.models),
    injectStreamUsage: true,
  };
}

function brainKeySource(brain: BrainConfig): string {
  const channel = findJevChannel(brain.channel);
  if (getCredential(brainCredentialName(brain.channel))) return "credentials";
  const env = brain.apiKeyEnv || channel?.apiKeyEnv;
  if (env && process.env[env]) return `env:${env}`;
  return "none";
}

export function createAdminApp(state: AppState): Hono {
  const app = new Hono();

  const persist = (config: Config): Config => {
    saveConfig(config);
    state.config = config;
    return config;
  };

  app.get("/state", (c) => {
    initPricing();
    const config = state.config;
    return c.json({
      config: {
        listen: config.listen,
        defaultProvider: config.defaultProvider,
        providers: config.providers.map((provider) => ({
          name: provider.name,
          type: provider.type,
          baseUrl: provider.baseUrl,
          apiKeyEnv: provider.apiKeyEnv,
          auth: provider.auth,
          oauthSource: provider.oauthSource,
          billing: provider.billing,
          quota: provider.quota,
          keySource: apiKeySource(provider),
          models: providerModelIds(provider),
        })),
        routing: {
          ...config.routing,
          brains: config.routing.brains.map((brain) => ({
            ...brain,
            keySource: brainKeySource(brain),
          })),
        },
      },
      tiers: deriveTiers(config),
      routings: deriveRoutings(config),
      pricing: pricingInfo(),
      keys: listKeysWithUsage(),
      brainChannels: JEV_CHANNELS,
      presets: PRESETS,
    });
  });

  app.get("/update", async (c) => {
    // Refresh when the 24h cache is stale so a long-lived dashboard
    // picks up a newly published release without a manual "Check now".
    const status: UpdateStatus = state.updates
      ? await state.updates.check()
      : {
          current: "unknown",
          updateAvailable: false,
          channel: "unknown",
        };
    return c.json({
      update: status,
      active: state.lifecycle?.draining ?? false,
      activeRequests: state.lifecycle?.activeRequests ?? 0,
      ...(state.updateError ? { error: state.updateError } : {}),
    });
  });

  app.post("/update/check", async (c) => {
    if (!state.updates) return c.json({ error: "Update checking is unavailable." }, 503);
    state.updateError = undefined;
    return c.json({
      update: await state.updates.check({ force: true }),
      active: state.lifecycle?.draining ?? false,
    });
  });

  app.post("/update/install", async (c) => {
    if (!state.updates || !state.lifecycle || !state.restart) {
      return c.json({ error: "Updates can only be installed from a running server." }, 503);
    }
    if (state.lifecycle.draining) {
      return c.json({ error: "An update is already in progress." }, 409);
    }
    const status = state.updates.status();
    if (!status.updateAvailable) {
      return c.json(
        {
          error: status.latest
            ? `Jevonian ${status.current} is up to date.`
            : "No update check has completed yet.",
        },
        409,
      );
    }
    if (!status.installCommand) {
      return c.json({ error: "This installation is not managed by npm or pnpm." }, 409);
    }
    state.updateError = undefined;
    void (async () => {
      try {
        // Install while the old process keeps serving. Only the final switch
        // drains clients, so a slow npm registry does not become downtime.
        const installed = await state.updates!.install();
        if (installed.error) throw new Error(installed.error);
        await state.lifecycle!.restartAfterDrain(state.restart!);
      } catch (error) {
        state.updateError = error instanceof Error ? error.message : String(error);
        state.lifecycle!.resume();
      }
    })();
    return c.json({ accepted: true, update: status, active: false }, 202);
  });

  app.get("/tunnel", (c) =>
    c.json({ config: state.config.tunnel, tunnel: state.tunnel?.status() ?? null }),
  );

  app.put("/tunnel", async (c) => {
    const body = asRecord(await c.req.json().catch(() => ({})));
    const config = loadConfig() ?? state.config;
    const merged = parseTunnel({
      ...config.tunnel,
      ...body,
      // keep the stored provider when the body omits it
      provider: body.provider ?? config.tunnel.provider,
      enabled: typeof body.enabled === "boolean" ? body.enabled : config.tunnel.enabled,
      command:
        typeof body.command === "string" && body.command.trim()
          ? body.command
          : config.tunnel.command,
      // Explicit `url` (including "") clears a reserved domain; omit keeps the stored value.
      url: Object.prototype.hasOwnProperty.call(body, "url")
        ? typeof body.url === "string"
          ? body.url
          : ""
        : config.tunnel.url,
      publicPort: typeof body.publicPort === "number" ? body.publicPort : config.tunnel.publicPort,
    });
    let error: string | undefined;
    if (merged.enabled && !hasKeys()) {
      merged.enabled = false;
      error =
        "Create a Jevonian API key first — the public endpoint refuses unauthenticated traffic.";
    }
    const next: Config = { ...config, tunnel: merged };
    persist(next);
    if (!state.tunnel) {
      error = "Tunnel manager is not running in this process.";
    } else {
      state.tunnel.update(merged, next.listen.port);
      if (merged.enabled) state.tunnel.start();
      else state.tunnel.stop();
      const status = state.tunnel.status();
      if (status.error) error = status.error;
    }
    return c.json({
      config: next.tunnel,
      tunnel: state.tunnel?.status() ?? null,
      ...(error ? { error } : {}),
    });
  });

  app.get("/quota", async (c) => {
    const refresh = c.req.query("refresh") === "1";
    const quotas = await providerQuotas(state.config, { refresh });
    const guard = state.config.routing.quotaGuard;
    const health = state.config.providers.map((provider) => ({
      ...providerQuotaHealth(provider, { lowPercent: guard.lowPercent }),
      billing: provider.billing,
    }));
    return c.json({ quotas, health, guard });
  });

  const mergeBrain = (current: BrainConfig, raw: unknown): BrainConfig => {
    const brainBody = asRecord(raw);
    if (Object.keys(brainBody).length === 0) return { ...current };
    const channel =
      typeof brainBody.channel === "string" && brainBody.channel
        ? brainBody.channel
        : current.channel;
    const channelPreset = findJevChannel(channel);
    const apiKey = typeof brainBody.apiKey === "string" ? brainBody.apiKey.trim() : "";
    if (apiKey) setCredential(brainCredentialName(channel), apiKey);
    const nextBaseUrl =
      typeof brainBody.baseUrl === "string"
        ? brainBody.baseUrl
        : (current.baseUrl ?? channelPreset?.baseUrl ?? "");
    const nextAccountId =
      typeof brainBody.accountId === "string"
        ? brainBody.accountId.trim()
        : (current.accountId ?? "");
    const nextApiKeyEnv =
      typeof brainBody.apiKeyEnv === "string" ? brainBody.apiKeyEnv : (current.apiKeyEnv ?? "");
    const nextModel =
      typeof brainBody.model === "string"
        ? brainBody.model
        : (current.model ?? channelPreset?.model ?? "");
    return {
      channel,
      ...(nextBaseUrl ? { baseUrl: nextBaseUrl } : {}),
      ...(nextAccountId ? { accountId: nextAccountId } : {}),
      ...(nextApiKeyEnv ? { apiKeyEnv: nextApiKeyEnv } : {}),
      ...(nextModel ? { model: nextModel } : {}),
      timeoutMs:
        typeof brainBody.timeoutMs === "number" && brainBody.timeoutMs > 0
          ? brainBody.timeoutMs
          : current.timeoutMs,
      minConfidence:
        typeof brainBody.minConfidence === "number"
          ? brainBody.minConfidence
          : current.minConfidence,
      ...(brainBody.fullPrompt === true ? { fullPrompt: true } : {}),
    };
  };

  const brainsPayload = (config: Config) => ({
    brains: config.routing.brains.map((brain) => ({
      ...brain,
      keySource: brainKeySource(brain),
    })),
    brainChannels: JEV_CHANNELS,
  });

  const persistBrains = (config: Config, brains: BrainConfig[]): Config => {
    const next: Config = { ...config, routing: { ...config.routing, brains } };
    persist(next);
    return next;
  };

  const mergeBrains = (current: BrainConfig[], raw: unknown): BrainConfig[] => {
    const body = asRecord(raw);
    if (Object.keys(body).length === 0) return current;
    const merged = mergeBrain(current[0] ?? DEFAULT_BRAIN, body);
    return current.length === 0 ? [merged] : [merged, ...current.slice(1)];
  };

  app.get("/brains", (c) => c.json(brainsPayload(state.config)));

  app.post("/brains", async (c) => {
    const body = asRecord(await c.req.json().catch(() => ({})));
    const config = loadConfig() ?? state.config;
    const brain = mergeBrain(DEFAULT_BRAIN, body);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (apiKey) setCredential(brainCredentialName(brain.channel), apiKey);
    const next = persistBrains(config, [...config.routing.brains, brain]);
    return c.json(brainsPayload(next), 201);
  });

  app.put("/brains/:index", async (c) => {
    const index = Number.parseInt(c.req.param("index"), 10);
    const body = asRecord(await c.req.json().catch(() => ({})));
    const config = loadConfig() ?? state.config;
    const current = config.routing.brains[index];
    if (!current) return c.json({ error: `brain ${index} not found` }, 404);
    const brain = mergeBrain(current, body);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (apiKey) setCredential(brainCredentialName(brain.channel), apiKey);
    const brains = [...config.routing.brains];
    brains[index] = brain;
    const next = persistBrains(config, brains);
    return c.json(brainsPayload(next));
  });

  app.delete("/brains/:index", (c) => {
    const index = Number.parseInt(c.req.param("index"), 10);
    const config = loadConfig() ?? state.config;
    const brain = config.routing.brains[index];
    if (!brain) return c.json({ error: `brain ${index} not found` }, 404);
    const brains = config.routing.brains.filter((_, position) => position !== index);
    if (!brains.some((entry) => entry.channel === brain.channel)) {
      removeCredential(brainCredentialName(brain.channel));
    }
    const next = persistBrains(config, brains);
    return c.json(brainsPayload(next));
  });

  app.post("/brains/:index/move", async (c) => {
    const index = Number.parseInt(c.req.param("index"), 10);
    const body = asRecord(await c.req.json().catch(() => ({})));
    const config = loadConfig() ?? state.config;
    const brains = [...config.routing.brains];
    const target = body.direction === "up" ? index - 1 : index + 1;
    if (!brains[index] || target < 0 || target >= brains.length) {
      return c.json({ error: "cannot move that brain" }, 400);
    }
    const swapped = brains[index];
    const other = brains[target];
    if (!swapped || !other) return c.json({ error: "cannot move that brain" }, 400);
    brains[index] = other;
    brains[target] = swapped;
    const next = persistBrains(config, brains);
    return c.json(brainsPayload(next));
  });

  app.put("/routing", async (c) => {
    const body = asRecord(await c.req.json().catch(() => ({})));
    const config = loadConfig() ?? state.config;
    const mode = body.mode ?? config.routing.mode;
    const brains = mergeBrains(config.routing.brains, body.brain);

    let routings: RoutingEntry[];
    try {
      if (Array.isArray(body.routings)) {
        const rawIds = body.routings
          .map((entry) => asRecord(entry).id)
          .filter((id): id is string => typeof id === "string");
        for (const id of ["plan", "execute", "utility", "chat"] as const) {
          if (!rawIds.includes(id)) {
            return c.json({ error: `Cannot remove builtin routing "${id}"` }, 400);
          }
        }
        routings = parseRoutings(body.routings, body.tiers);
        for (const entry of routings) {
          if (!isRoutingId(entry.id)) {
            return c.json({ error: `Invalid routing id "${entry.id}"` }, 400);
          }
        }
      } else {
        // Legacy: only tiers were sent — merge model lists into the existing routings.
        const tiers = asRecord(body.tiers);
        const nextTiers = {
          plan: tiers.plan === undefined ? config.routing.tiers.plan : stringArray(tiers.plan),
          execute:
            tiers.execute === undefined ? config.routing.tiers.execute : stringArray(tiers.execute),
          utility:
            tiers.utility === undefined ? config.routing.tiers.utility : stringArray(tiers.utility),
          chat: tiers.chat === undefined ? config.routing.tiers.chat : stringArray(tiers.chat),
        };
        routings = applyTiersToRoutings(config.routing.routings, nextTiers);
      }
    } catch (cause) {
      return c.json({ error: cause instanceof Error ? cause.message : String(cause) }, 400);
    }

    const next: Config = {
      ...config,
      routing: syncRoutingViews({
        ...config.routing,
        mode: mode === "off" ? "off" : "auto",
        routings,
        tiers: tiersFromRoutings(routings),
        ...(typeof body.sessionTtlMinutes === "number" && body.sessionTtlMinutes > 0
          ? { sessionTtlMinutes: body.sessionTtlMinutes }
          : {}),
        ...(typeof body.baselineModel === "string" ? { baselineModel: body.baselineModel } : {}),
        quotaGuard: parseQuotaGuard(body.quotaGuard, config.routing.quotaGuard),
        ...(typeof body.brainPicksEffort === "boolean"
          ? { brainPicksEffort: body.brainPicksEffort }
          : {}),
        ...(typeof body.defaultEffort === "string" ? { defaultEffort: body.defaultEffort } : {}),
        ...(asRecord(body.capacities) && Object.keys(asRecord(body.capacities)).length > 0
          ? { capacities: parseCapacities(body.capacities) }
          : {}),
        brains,
      }),
    };
    persist(next);
    return c.json({
      routing: next.routing,
      tiers: deriveTiers(next),
      routings: deriveRoutings(next),
    });
  });

  app.post("/brain/test", async (c) => {
    const body = asRecord(await c.req.json().catch(() => ({})));
    const saved = state.config.routing.brains[0] ?? DEFAULT_BRAIN;
    const channelId =
      typeof body.channel === "string" && body.channel ? body.channel : saved.channel;
    const preset = findJevChannel(channelId);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const brain: BrainConfig = {
      ...saved,
      channel: channelId,
      ...(typeof body.baseUrl === "string" && body.baseUrl.trim()
        ? { baseUrl: body.baseUrl.trim() }
        : {}),
      ...(typeof body.accountId === "string"
        ? body.accountId.trim()
          ? { accountId: body.accountId.trim() }
          : { accountId: undefined }
        : {}),
      ...(typeof body.apiKeyEnv === "string" && body.apiKeyEnv.trim()
        ? { apiKeyEnv: body.apiKeyEnv.trim() }
        : {}),
      ...(typeof body.model === "string" && body.model.trim() ? { model: body.model.trim() } : {}),
      ...(typeof body.timeoutMs === "number" && body.timeoutMs > 0
        ? { timeoutMs: body.timeoutMs }
        : {}),
    };
    const baseUrl = (brain.baseUrl || preset?.baseUrl || "").trim();
    if (channelId === "cloudflare") {
      if (!(brain.accountId || "").trim()) {
        return c.json({ ok: false, error: "Set a Cloudflare account ID for this channel." });
      }
    } else if (!baseUrl && channelId !== "vercel") {
      return c.json({ ok: false, error: "Set a base URL for this channel." });
    }
    if (!apiKey && brainKeySource(brain) === "none") {
      return c.json({ ok: false, error: "Add an API key for this channel." });
    }
    const started = Date.now();
    const verdict = await askJev({
      brain,
      ...(apiKey ? { apiKey } : {}),
      state: {
        last_user_message: "Design a caching layer for the settings page.",
        recent_tool_results: [],
        has_tool_results: false,
        consecutive_failures: 0,
        routings: [
          {
            id: "plan",
            label: "Plan",
            description: "planning, coordination, review",
            models: [
              { model: "claude-opus-4-6", provider: "anthropic" },
              { model: "gpt-5.6", provider: "openai" },
            ],
          },
          {
            id: "execute",
            label: "Execute",
            description: "implementation, debugging, tool loops",
            models: [{ model: "deepseek-v4.1-flash", provider: "deepseek" }],
          },
        ],
        candidates: [
          { model: "claude-opus-4-6", provider: "anthropic" },
          { model: "gpt-5.6", provider: "openai" },
          { model: "deepseek-v4.1-flash", provider: "deepseek" },
        ],
        session_turns: 1,
      },
    });
    const latencyMs = Date.now() - started;
    if (!verdict) {
      return c.json({
        ok: false,
        error: "No verdict. Check the endpoint, model, and key.",
        latencyMs,
      });
    }
    return c.json({
      ok: true,
      verdict,
      channel: preset?.label ?? channelId,
      model: brain.model || preset?.model,
      latencyMs,
    });
  });

  app.post("/providers", async (c) => {
    const body = asRecord(await c.req.json().catch(() => ({})));
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : "";
    if (!name || !baseUrl) {
      return c.json({ error: "name and baseUrl are required" }, 400);
    }
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const config = loadConfig() ?? state.config;
    const previous = config.providers.find((provider) => provider.name === name);

    const stored = providerPayload(body, name, baseUrl);
    stored.models = mergeModelEntries(previous?.models, body.models);
    if (apiKey) setCredential(name, apiKey);

    const index = config.providers.findIndex((provider) => provider.name === name);
    const providers = [...config.providers];
    if (index >= 0) providers[index] = stored;
    else providers.push(stored);
    const next: Config = {
      ...config,
      providers,
      defaultProvider: config.defaultProvider ?? name,
    };
    const derived = deriveRoutings(next);
    const filled = next.routing.routings.map((entry) => {
      if (entry.models.length > 0) return entry;
      const auto = derived.find((candidate) => candidate.id === entry.id);
      return auto && auto.models.length > 0 ? { ...entry, models: [...auto.models] } : entry;
    });
    next.routing = syncRoutingViews({ ...next.routing, routings: filled });
    if (!next.routing.baselineModel) {
      const plan = next.routing.routings.find((entry) => entry.id === "plan");
      if (plan?.models[0]) next.routing.baselineModel = plan.models[0];
    }
    persist(next);
    return c.json({ config: next, tiers: deriveTiers(next), routings: deriveRoutings(next) });
  });

  app.delete("/providers/:name", (c) => {
    const name = c.req.param("name");
    const config = loadConfig() ?? state.config;
    const providers = config.providers.filter((provider) => provider.name !== name);
    if (providers.length === config.providers.length) {
      return c.json({ error: `provider "${name}" not found` }, 404);
    }
    const next: Config = {
      ...config,
      providers,
      ...(config.defaultProvider === name
        ? providers[0]
          ? { defaultProvider: providers[0].name }
          : {}
        : {}),
    };
    persist(next);
    return c.json({ config: next, tiers: deriveTiers(next) });
  });

  app.post("/providers/discover", async (c) => {
    const body = asRecord(await c.req.json().catch(() => ({})));
    const name = typeof body.name === "string" ? body.name : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : "";
    if (!baseUrl) return c.json({ models: [], error: "baseUrl is required" }, 400);
    const existing = name ? findProviderByName(state.config, name) : undefined;
    const apiKey =
      (typeof body.apiKey === "string" ? body.apiKey.trim() : "") ||
      (existing ? (resolveApiKey(existing) ?? "") : "");
    const probe: Provider = {
      ...providerPayload(body, name || "probe", baseUrl),
      ...(apiKey ? { apiKey } : {}),
    };
    const entry = await discoverProviderModels(probe);
    return c.json({ models: [...new Set(entry.models)].sort(), error: entry.error });
  });

  app.get("/models", (c) => {
    initPricing();
    const config = state.config;
    const seen = new Set<string>();
    const models: Array<{
      id: string;
      provider: string;
      configured: boolean;
      canonical: string;
      price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
    }> = [];
    for (const provider of config.providers) {
      for (const id of providerModelIds(provider)) {
        const key = `${provider.name}/${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const price = priceFor(id, provider.name);
        models.push({
          id,
          provider: provider.name,
          configured: true,
          canonical: canonicalModelId(id),
          ...(price
            ? {
                price: {
                  input: price.input,
                  output: price.output,
                  ...(price.cacheRead === undefined ? {} : { cacheRead: price.cacheRead }),
                  ...(price.cacheWrite === undefined ? {} : { cacheWrite: price.cacheWrite }),
                },
              }
            : {}),
        });
      }
    }
    const snapshot = loadPricingSnapshot() ?? {};
    for (const provider of config.providers) {
      const prefix = `${provider.name}/`;
      for (const [key, price] of Object.entries(snapshot)) {
        if (!key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        const dedupe = `${provider.name}/${id}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        models.push({
          id,
          provider: provider.name,
          configured: false,
          canonical: canonicalModelId(id),
          price: {
            input: price.input,
            output: price.output,
            ...(price.cacheRead === undefined ? {} : { cacheRead: price.cacheRead }),
            ...(price.cacheWrite === undefined ? {} : { cacheWrite: price.cacheWrite }),
          },
        });
      }
    }
    const canonicals = canonicalModels(config).map((entry) => ({
      id: entry.id,
      variants: entry.variants,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.family ? { family: entry.family } : {}),
    }));
    return c.json({ models, canonicals });
  });

  app.get("/pricing", (c) => {
    const provider = c.req.query("provider") ?? "";
    const snapshot = loadPricingSnapshot() ?? {};
    const prefix = `${provider}/`;
    const prices: Record<
      string,
      { input: number; output: number; cacheRead?: number; cacheWrite?: number }
    > = {};
    for (const [key, price] of Object.entries(snapshot)) {
      if (!provider || !key.startsWith(prefix)) continue;
      prices[key.slice(prefix.length)] = {
        input: price.input,
        output: price.output,
        ...(price.cacheRead === undefined ? {} : { cacheRead: price.cacheRead }),
        ...(price.cacheWrite === undefined ? {} : { cacheWrite: price.cacheWrite }),
      };
    }
    return c.json({ provider, prices });
  });

  app.get("/keys", (c) => c.json({ keys: listKeysWithUsage() }));

  app.post("/keys", async (c) => {
    const body = asRecord(await c.req.json().catch(() => ({})));
    const name = typeof body.name === "string" ? body.name : "default";
    const limitUsd = parseLimitUsd(body.limitUsd);
    const created = createKey(name, limitUsd);
    return c.json(created, 201);
  });

  app.put("/keys/:id", async (c) => {
    const body = asRecord(await c.req.json().catch(() => ({})));
    const patch: { name?: string; limitUsd?: number | null } = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (Object.prototype.hasOwnProperty.call(body, "limitUsd")) {
      patch.limitUsd = parseLimitUsd(body.limitUsd);
    }
    const updated = updateKey(c.req.param("id"), patch);
    if (!updated) return c.json({ error: "key not found" }, 404);
    return c.json({ key: updated, keys: listKeysWithUsage() });
  });

  app.delete("/keys/:id", (c) => {
    const revoked = revokeKey(c.req.param("id"));
    if (!revoked) return c.json({ error: "key not found" }, 404);
    return c.json({ keys: listKeysWithUsage() });
  });

  /**
   * Spend / request / token activity, bucketed and grouped like OpenRouter's
   * Activity page: totals for the window, a time series, per-model and per-key
   * breakdowns. Estimated API spend and subscription value are reported separately
   * so a flat-rate provider never looks like real money spent.
   */
  app.get("/activity", (c) => {
    initPricing();
    const range = c.req.query("range");
    const validRanges = ["today", "24h", "7d", "30d", "all"] as const;
    const parsed = validRanges.find((entry) => entry === range);
    return c.json(
      computeActivityReport({
        range: parsed ?? "30d",
        ...(c.req.query("keyId") ? { keyId: c.req.query("keyId") } : {}),
      }),
    );
  });

  app.get("/logs", (c) => {
    const limit = Math.min(
      Math.max(Number.parseInt(c.req.query("limit") ?? "200", 10) || 200, 1),
      1000,
    );
    const filters = logFilters(c.req.query("phase"), c.req.query("model"), c.req.query("q"));
    const all = readRecords();

    // File-order indices of matching records, oldest first. Indices are stable as
    // the ledger grows: new records append at the end and never shift an earlier
    // index, so a cursor stays valid across pages even while traffic is live.
    const indices: number[] = [];
    for (let index = 0; index < all.length; index += 1) {
      const record = all[index];
      if (record && matchesLogFilters(record, filters)) indices.push(index);
    }

    const beforeRaw = Number.parseInt(c.req.query("before") ?? "", 10);
    const upper = Number.isFinite(beforeRaw) ? beforeRaw : all.length;
    const selected: number[] = [];
    for (let cursor = indices.length - 1; cursor >= 0 && selected.length < limit; cursor -= 1) {
      const index = indices[cursor] as number;
      if (index < upper) selected.push(index);
    }

    const oldest = selected.at(-1);
    const hasMore = oldest !== undefined && (indices[0] ?? Number.POSITIVE_INFINITY) < oldest;
    return c.json({
      logs: selected.map((index) => all[index] as LedgerRecord),
      total: indices.length,
      // Exclusive upper bound for the next page; null when the ledger is exhausted.
      nextBefore: hasMore ? oldest : null,
    });
  });

  /**
   * Live tail of the ledger.
   *
   * Streams records as they are appended instead of making the dashboard poll, so a
   * new request shows up the moment it finishes. Filters apply to the stream too, so
   * a narrowed view does not light up with rows the operator filtered out.
   */
  app.get("/logs/stream", (c) => {
    const filters = logFilters(c.req.query("phase"), c.req.query("model"), c.req.query("q"));
    return streamSSE(c, async (stream) => {
      // Subscribe before the first await. The callback runs synchronously up to this
      // point, so a record appended between the client connecting and the stream
      // opening is still delivered rather than silently missed.
      const queue: LedgerRecord[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = subscribeLedger((record) => {
        if (!matchesLogFilters(record, filters)) return;
        queue.push(record);
        wake?.();
        wake = undefined;
      });
      stream.onAbort(unsubscribe);

      try {
        await stream.writeSSE({ event: "ready", data: JSON.stringify({ ok: true }) });
        while (!stream.aborted && !stream.closed) {
          if (queue.length === 0) {
            // Heartbeat keeps intermediaries from closing an idle connection.
            await Promise.race([
              new Promise<void>((resolve) => {
                wake = resolve;
              }),
              stream.sleep(15_000),
            ]);
          }
          while (queue.length > 0) {
            const record = queue.shift() as LedgerRecord;
            await stream.writeSSE({ event: "log", data: JSON.stringify(record) });
          }
          if (queue.length === 0) await stream.writeSSE({ event: "ping", data: "{}" });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  /**
   * Bucketed activity for the logs header chart.
   *
   * Aggregated server-side over the whole ledger so the chart reflects every
   * matching request, not only the page the client happens to have loaded.
   */
  app.get("/logs/series", (c) => {
    const minutes = Math.min(
      Math.max(Number.parseInt(c.req.query("minutes") ?? "60", 10) || 60, 5),
      24 * 60,
    );
    const count = Math.min(
      Math.max(Number.parseInt(c.req.query("buckets") ?? "30", 10) || 30, 6),
      120,
    );
    const filters = logFilters(c.req.query("phase"), c.req.query("model"), c.req.query("q"));
    const now = Date.now();
    const span = minutes * 60_000;
    const width = span / count;
    const buckets = Array.from({ length: count }, (_, index) => ({
      start: new Date(now - span + index * width).toISOString(),
      requests: 0,
      errors: 0,
      costUsd: 0,
      latencyMs: 0,
    }));

    for (const record of readRecords()) {
      if (!matchesLogFilters(record, filters)) continue;
      const at = Date.parse(record.ts);
      if (!Number.isFinite(at) || at < now - span || at > now) continue;
      const slot = Math.min(Math.floor((at - (now - span)) / width), count - 1);
      const bucket = buckets[slot];
      if (!bucket) continue;
      bucket.requests += 1;
      if (record.status >= 400) bucket.errors += 1;
      bucket.costUsd += record.costUsd ?? 0;
      bucket.latencyMs += record.latencyMs;
    }

    return c.json({
      minutes,
      buckets: buckets.map(({ start, requests, errors, costUsd, latencyMs }) => ({
        start,
        requests,
        errors,
        costUsd: Number(costUsd.toFixed(6)),
        avgLatencyMs: requests > 0 ? Math.round(latencyMs / requests) : 0,
      })),
    });
  });

  app.get("/logs/:id", (c) => {
    const id = c.req.param("id");
    const records = readRecords();
    const record = records.find((entry) => entry.id === id);
    if (!record) return c.json({ error: `record "${id}" not found` }, 404);
    const brainCalls = records
      .filter((entry) => entry.kind === "brain" && entry.requestId === id)
      .map((entry) => ({ record: entry, body: entry.id ? loadBody(entry.id) : undefined }));
    return c.json({ record, body: loadBody(id), brainCalls });
  });

  app.get("/stats", (c) => {
    initPricing();
    return c.json(summarize(readRecords(), state.config));
  });

  app.get("/tiers", (c) =>
    c.json({ tiers: deriveTiers(state.config), routings: deriveRoutings(state.config) }),
  );

  app.get("/clients", (c) => {
    const port = state.config.listen.port;
    return c.json({
      clients: clientTargets(port),
      // Connecting a desktop client writes to files on the machine running the
      // Jevonian server, so the dashboard must say which machine that is.
      hostname: hostname(),
      platform: process.platform,
    });
  });

  app.post("/clients/:id", async (c) => {
    const id = parseClientId(c.req.param("id"));
    if (!id) return c.json({ error: "Unknown client." }, 400);

    const body = asRecord(await c.req.json().catch(() => ({})));
    const restart = body.restart === true;
    const port = state.config.listen.port;
    const models = desktopModels(state.config);
    const codeModels = claudeCodeModels(state.config);

    if (models.length === 0 && (id !== "claude" || codeModels.length === 0)) {
      return c.json({ error: "Configure at least one routed model before connecting." }, 400);
    }

    // The desktop apps load their model profile at startup, so apply the file
    // change first, then restart only when the user confirmed it.
    try {
      const running = isClientRunning(id);
      if (running && !restart) {
        return c.json(
          {
            error: "restart-required",
            running: true,
            client: id,
            message: "The app is running. Confirm the restart to apply the Jevonian profile.",
          },
          409,
        );
      }

      const result = applyClient(id, {
        port,
        models: models.length > 0 ? models : codeModels,
        codeModels,
      });
      if (running && restart) {
        await restartClient(id);
        result.restarted = true;
        result.target = clientTargets(port).find((client) => client.id === id) ?? result.target;
      }
      return c.json({ result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  });

  app.delete("/clients/:id", async (c) => {
    const id = parseClientId(c.req.param("id"));
    if (!id) return c.json({ error: "Unknown client." }, 400);

    const body = asRecord(await c.req.json().catch(() => ({})));
    const restart = body.restart === true;

    try {
      const running = isClientRunning(id);
      if (running && !restart) {
        return c.json(
          {
            error: "restart-required",
            running: true,
            client: id,
            message: "The app is running. Confirm the restart to restore its normal profile.",
          },
          409,
        );
      }

      restoreClient(id);
      if (running && restart) await restartClient(id);
      return c.json({ clients: clientTargets(state.config.listen.port) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
