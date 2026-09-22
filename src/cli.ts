#!/usr/bin/env node
import { spawn } from "node:child_process";

import { serve } from "@hono/node-server";

import type { AppState } from "./admin";
import { brainCredentialName, findJevChannel } from "./brain";
import { openBrowserOnce } from "./browser";
import { catalogPath, discoverProviderModels, loadCatalog, refreshCatalog } from "./catalog";
import {
  apiKeySource,
  loadConfig,
  parseConfig,
  resolveApiKey,
  saveConfig,
  writeExampleConfig,
  type Config,
  type Provider,
  type ProviderAuth,
  type ProviderBilling,
  type ProviderType,
} from "./config";
import { credentialsPath, getCredential, removeCredential, setCredential } from "./credentials";
import { readRecords, type LedgerRecord } from "./ledger";
import { ServerLifecycle } from "./lifecycle";
import { canonicalVariants, identityGaps } from "./models";
import { loadProviderMeta, loadPricingSnapshot, refreshPricing } from "./modelsdev";
import type { OAuthSource } from "./oauth";
import {
  browserStatePath,
  configPath,
  dataDir,
  ledgerPath,
  tunnelLogPath,
  tunnelStatePath,
  updateStatePath,
} from "./paths";
import { costOf, initPricing, priceFor, type Usage } from "./pricing";
import { ask, askChoice, askSecret, askYesNo, isInteractive } from "./prompt";
import { findPreset, normalizeBaseUrl, PRESETS } from "./providers";
import { formatFetchError, isTransientProxyError, useSystemProxy } from "./proxy";
import { providerQuotaHealth, providerQuotas } from "./quota";
import { deriveRoutings, deriveTiers, claudeCodeModels } from "./routing";
import { SessionStore } from "./routing";
import { createApp, createPublicApp } from "./server";
import {
  ensureService,
  isManagedByLaunchd,
  readServeLogTail,
  serviceStatus,
  stopService,
  uninstallService,
} from "./service";
import { TunnelManager } from "./tunnel";
import { formatUpdateNotice, UPDATE_INTERVAL_MS, UpdateManager } from "./updates";
import { applyUserBinPath } from "./user-path";

/** How often serve re-runs a (cache-aware) update check while staying up. */
const UPDATE_POLL_MS = 60 * 60 * 1_000;

function printUpdateNotice(status: {
  current: string;
  latest?: string;
  updateAvailable: boolean;
}): void {
  if (!status.updateAvailable) return;
  const notice = formatUpdateNotice(status);
  if (notice) console.error(notice);
}

/**
 * Show a cached update box immediately (covers "before/at open"), then refresh
 * the registry in the background for the next run.
 */
function notifyCachedUpdate(): void {
  const updates = new UpdateManager({ cachePath: updateStatePath() });
  printUpdateNotice(updates.status());
  void updates.check().catch(() => {});
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split("=") as [string, string | undefined];
    if (inline !== undefined) {
      flags[key] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = "";
    }
  }
  return { positionals, flags };
}

const parsed = parseArgs(process.argv.slice(2));
const command = parsed.positionals[0] ?? "serve";
const rest = parsed.positionals.slice(1);
const flags = parsed.flags;

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

function usageOf(record: LedgerRecord): Usage {
  return {
    input: record.promptTokens,
    output: record.completionTokens,
    cacheRead: record.cacheReadTokens,
    cacheWrite: record.cacheWriteTokens,
  };
}

function baselineModel(config: Config | null, records: LedgerRecord[]): string | undefined {
  if (config?.routing.baselineModel) return config.routing.baselineModel;
  if (config) {
    const tiers = deriveTiers(config);
    if (tiers.plan[0]) return tiers.plan[0];
  }
  const priced = [...new Set(records.map((record) => record.model))]
    .flatMap((model) => {
      const price = priceFor(model);
      return price ? [{ model, output: price.output }] : [];
    })
    .sort((left, right) => right.output - left.output);
  return priced[0]?.model;
}

function report(): void {
  initPricing();
  const records = readRecords();
  if (records.length === 0) {
    console.log("No requests recorded yet.");
    return;
  }
  const config = loadConfig();
  const baseline = baselineModel(config, records);
  const baselinePriced = baseline ? priceFor(baseline) : undefined;

  interface Row {
    requests: number;
    prompt: number;
    output: number;
    cacheRead: number;
    cost: number;
    unpriced: number;
  }

  const byModel = new Map<string, Row>();
  let actualCost = 0;
  let baselineCost = 0;
  let cacheRead = 0;
  let prompt = 0;
  let brainDecided = 0;
  const byEffort = new Map<string, { requests: number; cost: number }>();

  for (const record of records) {
    const row = byModel.get(record.model) ?? {
      requests: 0,
      prompt: 0,
      output: 0,
      cacheRead: 0,
      cost: 0,
      unpriced: 0,
    };
    row.requests += 1;
    row.prompt += record.promptTokens;
    row.output += record.completionTokens;
    row.cacheRead += record.cacheReadTokens;
    if (record.costUsd === null) {
      row.unpriced += 1;
    } else {
      row.cost += record.costUsd;
      actualCost += record.costUsd;
    }
    byModel.set(record.model, row);
    cacheRead += record.cacheReadTokens;
    prompt += record.promptTokens;
    if (record.brain) brainDecided += 1;
    // The level the model was actually sent; "default" means the router applied none.
    const effort = record.effort ?? "default";
    const effortRow = byEffort.get(effort) ?? { requests: 0, cost: 0 };
    effortRow.requests += 1;
    if (record.costUsd !== null) effortRow.cost += record.costUsd;
    byEffort.set(effort, effortRow);
    if (baseline && baselinePriced) {
      const baselineProvider = config?.providers.find((provider) =>
        provider.models.some((entry) => entry.id === baseline),
      )?.name;
      const estimate = costOf(baseline, usageOf(record), new Date(record.ts), baselineProvider).usd;
      if (estimate !== null) baselineCost += estimate;
    }
  }

  const columns = ["model", "reqs", "prompt", "output", "cache read", "cost"];
  console.log(
    `${pad(columns[0] ?? "model", 24)} ${padStart(columns[1] ?? "reqs", 6)} ${padStart(columns[2] ?? "prompt", 10)} ${padStart(columns[3] ?? "output", 10)} ${padStart(columns[4] ?? "cache read", 12)} ${padStart(columns[5] ?? "cost", 10)}`,
  );
  for (const [model, row] of [...byModel.entries()].sort(
    (left, right) => right[1].cost - left[1].cost,
  )) {
    const unpriced = row.unpriced > 0 ? ` (+${row.unpriced} unpriced)` : "";
    console.log(
      `${pad(model || "(none)", 24)} ${padStart(String(row.requests), 6)} ${padStart(String(row.prompt), 10)} ${padStart(String(row.output), 10)} ${padStart(String(row.cacheRead), 12)} ${padStart(money(row.cost) + unpriced, 10)}`,
    );
  }

  const byPhase = new Map<string, { requests: number; cost: number }>();
  for (const record of records) {
    const key = record.phase ?? "-";
    const entry = byPhase.get(key) ?? { requests: 0, cost: 0 };
    entry.requests += 1;
    entry.cost += record.costUsd ?? 0;
    byPhase.set(key, entry);
  }

  console.log("");
  console.log(
    `${records.length} requests, ${new Set(records.map((record) => record.session)).size} sessions`,
  );
  console.log(
    `cache hits: ${cacheRead + prompt > 0 ? ((cacheRead / (cacheRead + prompt)) * 100).toFixed(1) : "0.0"}% (${cacheRead} cached tokens)`,
  );
  console.log(`brain-decided: ${brainDecided}`);
  console.log("");
  console.log("by phase:");
  for (const [phase, entry] of [...byPhase.entries()].sort(
    (left, right) => right[1].cost - left[1].cost,
  )) {
    console.log(
      `${pad(phase, 12)} ${padStart(String(entry.requests), 6)} reqs ${padStart(money(entry.cost), 12)}`,
    );
  }

  if (byEffort.size > 0) {
    console.log("");
    console.log("by thinking effort:");
    for (const [effort, entry] of [...byEffort.entries()].sort(
      (left, right) => right[1].cost - left[1].cost,
    )) {
      console.log(
        `${pad(effort, 12)} ${padStart(String(entry.requests), 6)} reqs ${padStart(money(entry.cost), 12)}`,
      );
    }
  }

  if (baseline && baselinePriced) {
    const savings = baselineCost - actualCost;
    const percent = baselineCost > 0 ? (savings / baselineCost) * 100 : 0;
    console.log("");
    console.log(`actual:   ${money(actualCost)}`);
    console.log(`baseline: ${money(baselineCost)} (${baseline} for everything)`);
    console.log(`savings:  ${money(savings)} (${percent.toFixed(1)}%)`);
  }
}

async function doctor(network: boolean): Promise<void> {
  console.log(`config:  ${configPath()}`);
  const config = loadConfig();
  if (!config) {
    console.log("         missing — run `jevonian` and configure everything in the web UI");
    return;
  }
  const pricing = initPricing();
  console.log(`data:    ${dataDir()}`);
  console.log(`ledger:  ${ledgerPath()} (${readRecords().length} records)`);
  console.log(`catalog: ${catalogPath()} (${loadCatalog().length} providers cached)`);
  console.log(
    `pricing: ${pricing.source} (${pricing.models} models)${pricing.source === "bundled-fallback" ? " — run `jevonian pricing --refresh`" : ""}`,
  );
  console.log("");
  for (const provider of config.providers) {
    const source = apiKeySource(provider);
    const display =
      source === "none" && provider.apiKeyEnv ? `missing (${provider.apiKeyEnv})` : source;
    console.log(
      `${provider.name}: ${provider.type} ${provider.baseUrl} auth=${provider.auth}${provider.oauthSource ? `:${provider.oauthSource}` : ""} billing=${provider.billing} credential=${display} models=${provider.models.length}`,
    );
  }
  const routings = deriveRoutings(config);
  console.log("");
  console.log(`routing: ${config.routing.mode}`);
  for (const entry of routings) {
    console.log(
      `  ${entry.id}: ${entry.models.join(", ") || "(none)"}${entry.description ? ` — ${entry.description}` : ""}`,
    );
  }
  console.log(
    `  baseline: ${config.routing.baselineModel ?? routings.find((entry) => entry.id === "plan")?.models[0] ?? "(none)"}`,
  );
  const declared = new Set<string>();
  for (const entry of routings) {
    for (const model of entry.models) declared.add(model);
  }
  const lines: string[] = [];
  for (const gap of identityGaps(config, [...declared].sort())) {
    lines.push(`  ${gap.model} — catalog: ${gap.identity.displayName ?? gap.identity.label}`);
    const state = gap.sameModel
      .map((entry) => `${entry.provider}/${entry.model}${entry.official ? " (official)" : ""}`)
      .join(", ");
    lines.push(`    same model served by: ${state}`);
    if (gap.suggestion) lines.push(`    fix: ${gap.suggestion}`);
  }
  const withoutAliases = { ...config, modelAliases: {} };
  const redundant = Object.keys(config.modelAliases ?? {}).filter((canonical) => {
    const automatic = canonicalVariants(withoutAliases, canonical);
    const configured = canonicalVariants(config, canonical);
    // Only call an alias redundant if removing it preserves candidates and their priority.
    return (
      configured.length > 0 &&
      configured.length === automatic.length &&
      configured.every(
        (variant, index) =>
          variant.provider === automatic[index]?.provider &&
          variant.model === automatic[index]?.model,
      )
    );
  });
  for (const canonical of redundant) {
    lines.push(`  ${canonical} — alias already redundant: identity routing finds the provider`);
  }
  if (lines.length > 0) {
    console.log("");
    console.log("identity (same model, different ids):");
    for (const line of lines) console.log(line);
  }
  const brains = config.routing.brains;
  if (brains.length === 0) {
    console.log("  brains:  (none) — jevonian/auto is disabled until one is configured");
  } else {
    console.log(`  brains:  ${brains.length} configured (tried in order)`);
    for (const [index, brain] of brains.entries()) {
      const channel = findJevChannel(brain.channel);
      const brainEnv = brain.apiKeyEnv || channel?.apiKeyEnv;
      const brainKey = getCredential(brainCredentialName(brain.channel))
        ? "credentials"
        : brainEnv && process.env[brainEnv]
          ? `env:${brainEnv}`
          : "none";
      console.log(
        `    ${index + 1}. ${channel?.label ?? brain.channel}${brain.model ? ` · ${brain.model}` : ""} · key=${brainKey}`,
      );
    }
  }

  if (network) {
    console.log("");
    console.log("probing providers...");
    const entries = await refreshCatalog(config);
    for (const entry of entries) {
      console.log(
        `  ${entry.provider}: ${entry.error ? `error: ${entry.error}` : `${entry.models.length} models`}`,
      );
    }
    console.log("");
    for (const item of await providerQuotas(config, { refresh: true })) {
      const windows = item.windows
        .map((window) =>
          window.usedPercent === undefined
            ? `${window.label} —`
            : `${window.label} ${window.usedPercent.toFixed(0)}%`,
        )
        .join(" · ");
      console.log(
        `  ${item.provider}: ${item.source}${item.error ? ` (${item.error})` : ""}${windows ? ` — ${windows}` : ""}`,
      );
    }
  }
}

async function models(refresh: boolean): Promise<void> {
  const config = loadConfig();
  if (!config || config.providers.length === 0) {
    console.error("No providers configured. Run `jevonian` and add one in the web UI.");
    process.exit(1);
  }
  const entries = refresh ? await refreshCatalog(config) : loadCatalog();
  if (entries.length === 0) {
    console.log("No catalog yet. Run `jevonian models --refresh`.");
    return;
  }
  for (const entry of entries) {
    console.log(
      `${entry.provider}: ${entry.error ? `error: ${entry.error}` : `${entry.models.length} models`}`,
    );
    for (const model of entry.models) {
      console.log(`  ${model}`);
    }
  }
}

async function pricing(refresh: boolean): Promise<void> {
  if (refresh) {
    console.log("fetching models.dev/api.json...");
    const result = await refreshPricing();
    console.log(`saved ${result.models} models from ${result.source} at ${result.fetchedAt}`);
  }
  const info = initPricing();
  console.log(`pricing source: ${info.source} (${info.models} models)`);
}

function ensureConfig(): Config {
  const existing = loadConfig();
  if (existing) return existing;
  const config = parseConfig({});
  saveConfig(config);
  return config;
}

function modelsFromSnapshot(providerName: string): string[] {
  const snapshot = loadPricingSnapshot();
  if (!snapshot) return [];
  const prefix = `${providerName}/`;
  return [
    ...new Set(
      Object.keys(snapshot)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)),
    ),
  ].sort();
}

async function addProvider(): Promise<void> {
  const config = ensureConfig();
  const interactive = isInteractive() && !("yes" in flags);

  if (!loadPricingSnapshot() && interactive) {
    if (await askYesNo("Fetch model prices from models.dev now? (recommended)", true)) {
      try {
        const result = await refreshPricing();
        console.log(`pricing: ${result.models} models from ${result.source}`);
      } catch (error) {
        console.log(`pricing fetch failed: ${String(error)}`);
      }
    }
  }
  initPricing();

  let id = rest[0] ?? "";
  let preset = id ? findPreset(id) : undefined;
  let meta = id ? loadProviderMeta()[id] : undefined;

  if (!id && interactive) {
    const choices = [
      ...PRESETS.map((item) => ({ id: item.id, label: `${item.name} (${item.id})` })),
      { id: "custom", label: "custom — enter name, base URL, and protocol yourself" },
    ];
    const chosen = await askChoice(
      "Which provider do you want to add?",
      choices,
      (choice) => choice.label,
    );
    id = chosen.id;
    preset = findPreset(id);
    meta = loadProviderMeta()[id];
  }
  if (!id) {
    console.error(
      "Usage: jevonian add <provider> [--key K] [--env NAME] [--models a,b] [--base-url URL] [--type openai|anthropic|responses] [--auth oauth --oauth-source claude-code|codex|static] [--billing subscription]",
    );
    process.exit(1);
  }

  let name = preset?.id ?? id;
  let baseUrl = flags["base-url"] ?? preset?.baseUrl ?? meta?.api ?? "";
  let type: ProviderType =
    flags.type === "anthropic" ||
    flags.type === "openai" ||
    flags.type === "responses" ||
    flags.type === "both" ||
    flags.type === "gemini"
      ? flags.type
      : (preset?.type ?? meta?.type ?? "openai");
  let apiKeyEnv = flags.env ?? preset?.apiKeyEnv ?? meta?.env[0] ?? "";
  const auth: ProviderAuth = flags.auth === "oauth" ? "oauth" : (preset?.auth ?? "api-key");
  const oauthSource: OAuthSource | undefined =
    auth === "oauth"
      ? ((flags["oauth-source"] as OAuthSource | undefined) ?? preset?.oauthSource ?? "static")
      : undefined;
  const billing: ProviderBilling =
    flags.billing === "api"
      ? "api"
      : flags.billing === "subscription"
        ? "subscription"
        : (preset?.billing ?? "api");

  const unknown = !preset && !meta;
  if (!baseUrl) {
    if (!interactive) {
      console.error(
        `Unknown provider "${id}". Pass --base-url and --type, or use one of: ${PRESETS.map((item) => item.id).join(", ")}`,
      );
      process.exit(1);
    }
    name = await ask("Provider name", name === "custom" ? "my-provider" : name);
    baseUrl = await ask("Base URL (OpenAI-, Anthropic-, or Responses-compatible)", baseUrl);
    const typed = await ask("Protocol type (openai/anthropic/responses/both)", type);
    type = typed === "anthropic" || typed === "responses" || typed === "both" ? typed : "openai";
    if (!apiKeyEnv) apiKeyEnv = await ask("Environment variable name for the key (optional)");
  } else if (unknown && interactive && name === "custom") {
    name = await ask("Provider name", "my-provider");
  }
  if (!baseUrl) {
    console.error("A base URL is required.");
    process.exit(1);
  }
  if (preset?.keysUrl) console.log(`Get a key at ${preset.keysUrl}`);
  else if (preset?.hint) console.log(preset.hint);

  const needsKey = auth !== "oauth" || oauthSource === "static";
  let apiKey = needsKey ? (flags.key ?? "") : "";
  if (needsKey && !apiKey && !flags.env && interactive) {
    apiKey = await askSecret(
      `Paste the API key (enter to use ${apiKeyEnv || "an environment variable"} instead)`,
    );
  }
  if (!needsKey && interactive) {
    console.log(
      oauthSource === "claude-code"
        ? "Using Claude Code credentials from ~/.claude (run `claude` to sign in)."
        : "Using Codex credentials from ~/.codex (run `codex` to sign in).",
    );
  }

  const probe: Provider = {
    name,
    type,
    baseUrl: normalizeBaseUrl(baseUrl),
    auth,
    ...(oauthSource ? { oauthSource } : {}),
    billing,
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    models: [],
    injectStreamUsage: true,
  };

  let models: string[] = [];
  if (flags.models)
    models = flags.models
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
  if (models.length === 0) {
    const resolved = resolveApiKey(probe);
    if (resolved) {
      const entry = await discoverProviderModels({ ...probe, apiKey: resolved });
      if (entry.error) console.log(`model discovery failed: ${entry.error}`);
      models = [...new Set(entry.models)].sort();
    }
  }
  if (models.length === 0) models = modelsFromSnapshot(name);
  if (models.length === 0 && interactive) {
    const typed = await ask("Model ids to enable (comma separated, empty to skip)");
    models = typed
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
  }
  if (models.length > 0) {
    const preview = models.length <= 8 ? `: ${models.join(", ")}` : "";
    console.log(`enabling ${models.length} models${preview}`);
  }

  const stored: Provider = {
    name,
    type,
    baseUrl: normalizeBaseUrl(baseUrl),
    auth,
    ...(oauthSource ? { oauthSource } : {}),
    billing,
    ...(apiKey ? {} : apiKeyEnv ? { apiKeyEnv } : {}),
    models: models.map((id) => ({ id })),
    injectStreamUsage: true,
  };
  if (apiKey) setCredential(name, apiKey);

  const index = config.providers.findIndex((provider) => provider.name === name);
  if (index >= 0) config.providers[index] = stored;
  else config.providers.push(stored);
  if (!config.defaultProvider) config.defaultProvider = name;

  const derived = deriveRoutings(config);
  config.routing.routings = config.routing.routings.map((entry) => {
    if (entry.models.length > 0) return entry;
    const auto = derived.find((candidate) => candidate.id === entry.id);
    return auto && auto.models.length > 0 ? { ...entry, models: [...auto.models] } : entry;
  });
  config.routing.tiers = {
    plan: config.routing.routings.find((entry) => entry.id === "plan")?.models ?? [],
    execute: config.routing.routings.find((entry) => entry.id === "execute")?.models ?? [],
    utility: config.routing.routings.find((entry) => entry.id === "utility")?.models ?? [],
    chat: config.routing.routings.find((entry) => entry.id === "chat")?.models ?? [],
  };
  if (!config.routing.baselineModel) {
    const plan = config.routing.routings.find((entry) => entry.id === "plan");
    if (plan?.models[0]) config.routing.baselineModel = plan.models[0];
  }

  const configFile = saveConfig(config);
  console.log("");
  console.log(`Added provider "${name}" (${type}) with ${models.length} models`);
  console.log(
    `  auth: ${auth === "oauth" ? `oauth (${oauthSource ?? "static"})` : apiKey ? `stored in ${credentialsPath()} (0600)` : apiKeyEnv ? `env ${apiKeyEnv}` : "none"}`,
  );
  console.log(`  billing: ${billing}`);
  for (const entry of config.routing.routings) {
    if (entry.models[0]) console.log(`  ${entry.id}: ${entry.models.join(", ")}`);
  }
  console.log(`config: ${configFile}`);
  console.log("Next: jevonian serve");
}

function listProviders(): void {
  const config = loadConfig();
  if (!config || config.providers.length === 0) {
    console.log("No providers configured. Run `jevonian add`.");
    return;
  }
  for (const provider of config.providers) {
    const source = apiKeySource(provider);
    const key =
      source === "none" && provider.apiKeyEnv ? `missing (${provider.apiKeyEnv})` : source;
    console.log(
      `${pad(provider.name, 24)} ${pad(`${provider.type}${provider.billing === "subscription" ? "/sub" : ""}`, 14)} ${pad(provider.baseUrl, 46)} key=${key} models=${provider.models.length}`,
    );
  }
}

async function quota(refresh: boolean): Promise<void> {
  initPricing();
  const config = loadConfig();
  if (!config || config.providers.length === 0) {
    console.log("No providers configured. Run `jevonian add`.");
    return;
  }
  const guard = config.routing.quotaGuard;
  const quotas = await providerQuotas(config, { refresh });
  for (const item of quotas) {
    const plan = item.plan ? ` · ${item.plan}` : "";
    const provider = config.providers.find((candidate) => candidate.name === item.provider);
    const health = provider
      ? providerQuotaHealth(provider, { lowPercent: guard.lowPercent })
      : undefined;
    const healthLabel = health ? ` · ${health.status}` : "";
    console.log(`${item.provider} · ${item.billing} · ${item.source}${plan}${healthLabel}`);
    for (const window of item.windows) {
      const used =
        window.usedPercent !== undefined
          ? `${window.usedPercent.toFixed(1)}%`
          : window.usedUsd !== undefined
            ? money(window.usedUsd)
            : "?";
      const limit = window.limitUsd !== undefined ? ` / ${money(window.limitUsd)}` : "";
      const reset = window.resetsAt ? ` · resets ${window.resetsAt}` : "";
      console.log(`  ${pad(window.label, 8)} ${used}${limit}${reset}`);
    }
    console.log(
      `  spend: 5h ${money(item.spend.fiveHourUsd)} · 24h ${money(item.spend.dayUsd)} · 7d ${money(item.spend.weekUsd)} · 30d ${money(item.spend.monthUsd)} (${item.spend.monthRequests} reqs)`,
    );
    if (item.note) console.log(`  note: ${item.note}`);
    if (item.error) console.log(`  note: ${item.error}`);
    if (health?.remainingUsd !== undefined) {
      const average =
        health.avgRequestUsd === undefined ? "" : ` · ~${money(health.avgRequestUsd)}/request`;
      console.log(`  remaining: ${money(health.remainingUsd)}${average}`);
    }
    if (item.windows.length === 0 && !item.error)
      console.log("  no quota source for this provider");
  }
}

function removeProvider(): void {
  const name = rest[0];
  if (!name) {
    console.error("Usage: jevonian remove <provider> [--keep-key]");
    process.exit(1);
  }
  const config = loadConfig();
  if (!config) {
    console.error("No config found.");
    process.exit(1);
  }
  const before = config.providers.length;
  config.providers = config.providers.filter((provider) => provider.name !== name);
  if (config.providers.length === before) {
    console.error(`Provider "${name}" not found.`);
    process.exit(1);
  }
  if (config.defaultProvider === name) config.defaultProvider = config.providers[0]?.name;
  if (!("keep-key" in flags)) removeCredential(name);
  saveConfig(config);
  console.log(`Removed provider "${name}"${"keep-key" in flags ? " (key kept)" : ""}`);
}

async function init(): Promise<void> {
  if (!isInteractive()) {
    const path = writeExampleConfig();
    console.log(`Wrote ${path}`);
    console.log("Set the API key env var for your provider, then run: jevonian serve");
    return;
  }
  const config = loadConfig();
  if (config && config.providers.length > 0) {
    console.log(
      `Config already exists at ${configPath()} with ${config.providers.length} providers.`,
    );
    console.log("Add another with: jevonian add");
    return;
  }
  console.log("Welcome to Jevonian. Let's add your first provider.");
  await addProvider();
}

function launchBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    return;
  }
}

/**
 * Open the dashboard. Under `pnpm dev` (`JEVONIAN_WEB_DEV`), remember the launch
 * so `tsx watch` restarts reuse the existing tab instead of stacking a new one
 * on every edit. Plain `jevonian serve` still opens every time.
 */
function openBrowser(url: string): void {
  if ("no-open" in flags || process.env.JEVONIAN_NO_OPEN) return;
  const watch = Boolean(process.env.JEVONIAN_WEB_DEV);
  const result = openBrowserOnce(url, {
    ...(watch ? { statePath: browserStatePath() } : {}),
    launch: launchBrowser,
  });
  if (result.reason === "already-open") {
    console.log(`dashboard already open at ${url} — reusing the tab`);
  }
}

async function launchCommand(argv: string[]): Promise<void> {
  const dash = argv.indexOf("--");
  const head = dash === -1 ? argv : argv.slice(0, dash);
  const passthrough = dash === -1 ? [] : argv.slice(dash + 1);
  const target = head[0];
  if (target !== "claude" && target !== "claude-code") {
    console.log("Usage: jevonian launch claude [--model M] [--] [claude args...]");
    process.exit(1);
  }

  const { positionals, flags: launchFlags } = parseArgs(head.slice(1));
  const config = loadConfig();
  if (!config) {
    console.error(
      `No config at ${configPath()}. Run \`jevonian init\` or \`jevonian serve\` first.`,
    );
    process.exit(1);
  }

  const models = claudeCodeModels(config);
  if (models.length === 0) {
    console.error("Configure at least one routed model before launching Claude Code.");
    process.exit(1);
  }

  const model = launchFlags.model?.trim() || undefined;
  const extra = [...positionals, ...passthrough];
  const { launchClaudeCode } = await import("./claude-code");
  try {
    const code = await launchClaudeCode({
      port: config.listen.port,
      models,
      model,
      args: extra,
    });
    process.exit(code);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function updateCommand(): Promise<void> {
  const updates = new UpdateManager({ cachePath: updateStatePath() });
  const checking = !("check" in flags);
  const status = checking ? await updates.install() : await updates.check({ force: true });
  console.log(`current: ${status.current}`);
  console.log(`channel: ${status.channel}`);
  if (status.latest) console.log(`latest:  ${status.latest}`);
  if (status.error) {
    console.error(`update check failed: ${status.error}`);
    process.exitCode = 1;
    return;
  }
  if (!status.updateAvailable) {
    console.log("Jevonian is up to date.");
    return;
  }
  if (!checking) {
    const notice = formatUpdateNotice(status);
    if (notice) console.error(notice);
    else
      console.log(`update available: ${status.installCommand ?? "no supported install command"}`);
    return;
  }
  console.log(`updated to ${status.latest}. Restart Jevonian to use the new version.`);
}

function printServiceStatus(): void {
  const status = serviceStatus();
  console.log(`label:   ${status.label}`);
  console.log(`plist:   ${status.plistPath}${status.plistInstalled ? "" : " (missing)"}`);
  console.log(`loaded:  ${status.loaded ? "yes" : "no"}`);
  if (status.pid) console.log(`pid:     ${status.pid}`);
  console.log(`log:     ${status.logPath}`);
  if (status.detail && status.detail !== "loaded") console.log(`detail:  ${status.detail}`);
  const tail = readServeLogTail(12);
  if (tail) {
    console.log("");
    console.log("recent log:");
    console.log(tail);
  }
}

async function stopCommand(): Promise<void> {
  if (process.platform !== "darwin") {
    console.error("Background service control is only available on macOS.");
    process.exitCode = 1;
    return;
  }
  try {
    if ("uninstall" in flags) {
      uninstallService();
      console.log("stopped and uninstalled the LaunchAgent");
      return;
    }
    stopService();
    console.log("stopped");
    printServiceStatus();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function statusCommand(): Promise<void> {
  printServiceStatus();
}

async function main(): Promise<void> {
  // Before anything reaches out: a machine behind a proxy can only be reached from
  // here if that proxy is installed first.
  const systemProxy = useSystemProxy();
  // Short commands: surface a previously cached update before the user opens serve.
  // `serve` and `update` manage their own checks.
  if (command !== "serve" && command !== "update") notifyCachedUpdate();
  if (command === "init") {
    await init();
  } else if (command === "add") {
    await addProvider();
  } else if (command === "providers") {
    listProviders();
  } else if (command === "remove") {
    removeProvider();
  } else if (command === "report") {
    report();
  } else if (command === "doctor") {
    await doctor("network" in flags);
  } else if (command === "models") {
    await models("refresh" in flags);
  } else if (command === "pricing") {
    await pricing("refresh" in flags);
  } else if (command === "quota") {
    await quota("refresh" in flags);
  } else if (command === "update") {
    await updateCommand();
  } else if (command === "stop") {
    await stopCommand();
  } else if (command === "status") {
    await statusCommand();
  } else if (command === "launch") {
    await launchCommand(process.argv.slice(3));
  } else if (command === "serve") {
    // macOS default: install/start a LaunchAgent and exit. Foreground only when
    // launchd is already driving us, or the user asked for it / one-shot flags.
    const foreground =
      isManagedByLaunchd() ||
      "foreground" in flags ||
      "fg" in flags ||
      process.platform !== "darwin" ||
      "tunnel" in flags ||
      "no-tunnel" in flags;
    if (!foreground) {
      await ensurePersistentServe();
      return;
    }
    // launchd PATH is /usr/bin:/bin:/usr/sbin:/sbin — restore Homebrew / local bins
    // so tunnel providers (ngrok, cloudflared) resolve without a shell profile.
    applyUserBinPath();
    const loaded = loadConfig();
    const config = loaded ?? parseConfig({});
    if (!loaded) {
      console.log("No config yet — starting with defaults. Add a provider in the web UI:");
      console.log(`  http://${config.listen.host}:${config.listen.port}/providers`);
    }
    const pricingInfo = initPricing();
    if (!loadPricingSnapshot()) {
      void refreshPricing()
        .then((result) => {
          initPricing();
          console.log(`pricing: fetched ${result.models} models from models.dev`);
        })
        .catch((error) => {
          console.log(`pricing fetch failed: ${formatFetchError(error)}`);
        });
    }
    // A flaky local proxy (Clash et al.) can drop sockets outside any await; keep
    // serve up and log once instead of dumping TypeError: terminated and exiting.
    process.on("unhandledRejection", (reason) => {
      if (isTransientProxyError(reason)) {
        console.log(`proxy: connection dropped (${formatFetchError(reason)})`);
        return;
      }
      console.error("unhandledRejection:", reason);
    });
    for (const provider of config.providers) {
      if (apiKeySource(provider) === "none") {
        console.error(
          `warning: provider "${provider.name}" has no API key. Run \`jevonian add ${provider.name}\`.`,
        );
      }
    }
    // Pull live subscription windows once at boot so the quota guard can skip a spent
    // OpenCode Go / Command Code before the first client turn discovers it via 429.
    void providerQuotas(config, { refresh: true })
      .then((quotas) => {
        const spent = quotas.filter((item) =>
          item.windows.some((window) => (window.usedPercent ?? 0) >= 100),
        );
        if (spent.length === 0) return;
        console.log(
          `quota: routing around ${spent.map((item) => item.provider).join(", ")} (limit reached)`,
        );
      })
      .catch((error) => console.log(`quota refresh failed: ${formatFetchError(error)}`));
    const tunnelConfig = {
      ...config.tunnel,
      enabled: "tunnel" in flags ? true : "no-tunnel" in flags ? false : config.tunnel.enabled,
    };
    const tunnel = new TunnelManager(tunnelConfig, config.listen.port, {
      statePath: tunnelStatePath(),
      logPath: tunnelLogPath(),
    });
    if (!tunnelConfig.enabled) tunnel.cleanup();
    const lifecycle = new ServerLifecycle();
    const updates = new UpdateManager({ cachePath: updateStatePath() });
    const state: AppState = { config, tunnel, lifecycle, updates };
    const store = new SessionStore(config.routing.sessionTtlMinutes * 60_000);
    const app = createApp(state, store);
    const publicApp = createPublicApp(state, store);
    const publicPort = tunnel.status().publicPort;
    let publicServer: ReturnType<typeof serve> | undefined;
    let mainServer: ReturnType<typeof serve> | undefined;
    const closeServer = (server: ReturnType<typeof serve> | undefined): Promise<void> =>
      new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });

    state.restart = async () => {
      // The lifecycle has already waited for active responses. Closing the
      // listeners releases the port, then the newly installed CLI takes over.
      await Promise.all([closeServer(mainServer), closeServer(publicServer)]);
      // Under launchd KeepAlive, exiting is enough — spawning a child would race
      // the agent for the same ports.
      if (isManagedByLaunchd()) {
        process.exit(0);
      }
      const entry = process.argv[1];
      if (!entry) {
        console.error("update installed, but Jevonian could not restart automatically.");
        process.exit(1);
      }
      const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
        detached: true,
        stdio: "inherit",
        env: { ...process.env, JEVONIAN_NO_OPEN: "1" },
      });
      child.unref();
      process.exit(0);
    };

    try {
      publicServer = serve(
        { fetch: publicApp.fetch, hostname: "127.0.0.1", port: publicPort },
        () => {
          console.log(`public surface on http://127.0.0.1:${publicPort} (only /v1, key required)`);
        },
      );
    } catch (error) {
      console.error(`warning: public listener on port ${publicPort} failed: ${String(error)}`);
    }

    const stopTunnel = (): void => {
      tunnel.stop();
    };
    process.once("SIGINT", () => {
      stopTunnel();
      process.exit(0);
    });
    // SIGTERM is how `tsx watch` restarts the process on a file change: leave the tunnel
    // running (detached, recorded on disk) so the next process adopts the same URL.
    process.once("SIGTERM", () => {
      process.exit(0);
    });

    mainServer = serve(
      { fetch: app.fetch, hostname: config.listen.host, port: config.listen.port },
      (info) => {
        const url = `http://${config.listen.host === "0.0.0.0" ? "127.0.0.1" : config.listen.host}:${info.port}/`;
        console.log(`jevonian listening on ${url}`);
        console.log(
          `providers: ${config.providers.map((provider) => provider.name).join(", ") || "(none) — add one in the web UI"}`,
        );
        console.log(
          `routing: ${config.routing.mode}${config.routing.mode === "auto" ? ` (models: ${["jevonian/auto", ...config.routing.routings.map((entry) => `jevonian/${entry.id}`)].join(", ")})` : ""}`,
        );
        console.log(`pricing: ${pricingInfo.source} (${pricingInfo.models} models)`);
        // At open: check once. While open: poll hourly; registry is hit at most
        // every UPDATE_INTERVAL_MS (24h) because UpdateManager caches.
        let announcedLatest: string | undefined;
        const runUpdateCheck = (): void => {
          void updates
            .check()
            .then((status) => {
              if (!status.updateAvailable || !status.latest) return;
              if (announcedLatest === status.latest) return;
              announcedLatest = status.latest;
              printUpdateNotice(status);
            })
            .catch(() => {});
        };
        runUpdateCheck();
        const updatePoll = setInterval(
          runUpdateCheck,
          Math.min(UPDATE_POLL_MS, UPDATE_INTERVAL_MS),
        );
        updatePoll.unref?.();
        if (systemProxy) {
          console.log(`proxy: ${systemProxy.url} (from the machine's network settings)`);
        }
        if (tunnelConfig.enabled) {
          console.log("tunnel: starting…");
          tunnel.start();
          const started = Date.now();
          const poll = setInterval(() => {
            const status = tunnel.status();
            if (status.status === "on" && status.url) {
              clearInterval(poll);
              console.log(`tunnel: ${status.url}/v1 (${status.provider})`);
            } else if (status.status === "error" || Date.now() - started > 30_000) {
              clearInterval(poll);
              console.log(`tunnel: ${status.error ?? "timed out"}`);
            }
          }, 500);
          poll.unref?.();
        }
        openBrowser(url);
      },
    );
  } else {
    console.log(
      "Usage: jevonian [serve|stop|status|add|providers|remove|report|doctor|models|pricing|quota|update|launch|init]",
    );
    process.exit(1);
  }
}

async function ensurePersistentServe(): Promise<void> {
  notifyCachedUpdate();
  try {
    const { status, action } = ensureService();
    const config = loadConfig() ?? parseConfig({});
    const url = `http://${config.listen.host === "0.0.0.0" ? "127.0.0.1" : config.listen.host}:${config.listen.port}/`;
    if (action === "installed") console.log("Jevonian is now running in the background.");
    else if (action === "updated") console.log("Jevonian service updated and restarted.");
    else if (action === "started") console.log("Jevonian service started.");
    else console.log("Jevonian is already running in the background.");
    console.log(`dashboard: ${url}`);
    if (status.pid) console.log(`pid:       ${status.pid}`);
    console.log(`log:       ${status.logPath}`);
    console.log("stop:      jevonian stop");
    console.log("status:    jevonian status");
    console.log("foreground: jevonian --foreground");
    openBrowser(url);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Could not start the background service. Try `jevonian --foreground`.");
    process.exitCode = 1;
  }
}

await main();
