import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveProviderAuth } from "./auth";
import type { Config, Provider, ProviderQuotaSpec } from "./config";
import { apiKeySource } from "./config";
import { readRecords, type LedgerRecord } from "./ledger";
import { resolveOAuthToken } from "./oauth";
import { dataDir } from "./paths";

export interface QuotaWindow {
  id: string;
  label: string;
  usedPercent?: number;
  usedUsd?: number;
  limitUsd?: number;
  resetsAt?: string;
  status?: string;
}

export interface ProviderSpend {
  fiveHourUsd: number;
  dayUsd: number;
  weekUsd: number;
  monthUsd: number;
  monthRequests: number;
}

export type QuotaSource = "live" | "headers" | "ledger" | "none";
export type QuotaStatus = "ok" | "low" | "exhausted" | "unknown";

export interface QuotaHealth {
  provider: string;
  status: QuotaStatus;
  usedPercent?: number;
  remainingPercent?: number;
  window?: string;
  resetsAt?: string;
  remainingUsd?: number;
  avgRequestUsd?: number;
  note?: string;
}

export const DEFAULT_LOW_PERCENT = 10;
const SUFFICIENT_REQUEST_MULTIPLE = 3;

export interface ProviderBalance {
  amount: number;
  currency: string;
}

export interface ProviderQuota {
  provider: string;
  billing: "api" | "subscription";
  auth: string;
  source: QuotaSource;
  plan?: string;
  note?: string;
  balance?: ProviderBalance;
  windows: QuotaWindow[];
  spend: ProviderSpend;
  fetchedAt: string;
  error?: string;
}

interface HeaderQuotaFile {
  [provider: string]: { windows: QuotaWindow[]; plan?: string; fetchedAt: string };
}

interface LiveCacheEntry {
  at: number;
  quota: Omit<ProviderQuota, "spend">;
}

const liveCache = new Map<string, LiveCacheEntry>();
let headerQuotaCache: HeaderQuotaFile | undefined;
let ledgerCache: { at: number; records: LedgerRecord[] } | undefined;

const LEDGER_TTL_MS = 15_000;
const HEADER_SNAPSHOT_TTL_MS = 60_000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  return undefined;
}

function percent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = value <= 1 ? value * 100 : value;
  return Math.min(100, Math.max(0, normalized));
}

/**
 * Already-scaled 0-100 usage (OpenCode Go `percent`, Codex `used_percent`).
 *
 * A raw value of `1` means "1% used", not 100%. Running it through {@link percent}
 * treats `<= 1` as a 0-1 fraction, so an almost-idle Codex weekly window becomes
 * fully spent and drops the provider from routing.
 */
function percentPoints(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function sameWindows(a: QuotaWindow[], b: QuotaWindow[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A window's `usedPercent` and `resetsAt` can stay identical for an entire reset
 * period, so window equality alone is not enough to conclude the snapshot is
 * current. Without a TTL an entry written once could be served forever.
 */
function snapshotStale(fetchedAt: string): boolean {
  const at = Date.parse(fetchedAt);
  return Number.isNaN(at) || Date.now() - at >= HEADER_SNAPSHOT_TTL_MS;
}

/**
 * Snapshots are a fallback, not a source of truth. Once one ages past the TTL we
 * must not present it as live: doing so hides real exhaustion (a stale "0% used"
 * reads as plenty of headroom) and can drive wrong routing decisions. We keep
 * serving the numbers, since old data beats none, but flag them as stale so the
 * UI can surface the age instead of implying they are current.
 */
function stalenessNote(fetchedAt: string): string | undefined {
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return "snapshot timestamp is unreadable";
  const ageMs = Date.now() - at;
  if (ageMs < HEADER_SNAPSHOT_TTL_MS) return undefined;
  const minutes = Math.floor(ageMs / 60_000);
  const age =
    minutes < 60
      ? `${minutes}m`
      : minutes < 1_440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1_440)}d`;
  return `measured ${age} ago`;
}

export function quotaStatePath(): string {
  return join(dataDir(), "quota.json");
}

export function resetQuotaCache(): void {
  headerQuotaCache = undefined;
  liveCache.clear();
  ledgerCache = undefined;
}

function ledgerRecords(now: number): LedgerRecord[] {
  if (!ledgerCache || now - ledgerCache.at > LEDGER_TTL_MS) {
    ledgerCache = { at: now, records: readRecords() };
  }
  return ledgerCache.records;
}

export function headerQuotas(): HeaderQuotaFile {
  if (headerQuotaCache) return headerQuotaCache;
  const path = quotaStatePath();
  if (!existsSync(path)) {
    headerQuotaCache = {};
    return headerQuotaCache;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const parsed: HeaderQuotaFile = {};
    for (const [provider, value] of Object.entries(raw)) {
      const entry = asRecord(value);
      if (!Array.isArray(entry.windows)) continue;
      parsed[provider] = {
        windows: entry.windows as QuotaWindow[],
        fetchedAt: typeof entry.fetchedAt === "string" ? entry.fetchedAt : "",
        ...(typeof entry.plan === "string" ? { plan: entry.plan } : {}),
      };
    }
    headerQuotaCache = parsed;
    return parsed;
  } catch {
    headerQuotaCache = {};
    return headerQuotaCache;
  }
}

function saveHeaderQuotas(next: HeaderQuotaFile): void {
  headerQuotaCache = next;
  try {
    mkdirSync(dirname(quotaStatePath()), { recursive: true });
    writeFileSync(quotaStatePath(), `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    return;
  }
}

/**
 * Forgets a snapshot recorded by {@link captureUsageLimit}.
 *
 * Those snapshots exist to make the very next routing decision avoid a provider that
 * just refused, so they are written without a real observation behind them. Once a
 * live probe succeeds the provider is demonstrably reachable again, and leaving the
 * snapshot in place is actively harmful: the `rejected` window sits in
 * `quota.json` at 100% used forever, and every time the 60s live cache goes cold —
 * which is most of the time — the provider reads as exhausted and drops out of
 * routing for a limit that expired days ago.
 *
 * Only a *successful* probe clears it. A failed one leaves the snapshot alone, so a
 * genuinely spent provider keeps being skipped and keeps its reset time.
 */
function clearRejection(provider: string): void {
  const current = headerQuotas();
  const snapshot = current[provider];
  if (!snapshot || !snapshot.windows.some((window) => window.status === "rejected")) return;
  const next = { ...current };
  delete next[provider];
  saveHeaderQuotas(next);
}

export function anthropicWindowsFromHeaders(headers: Headers): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const parse = (suffix: string): number | undefined => {
    const value = headers.get(`anthropic-ratelimit-unified-${suffix}`);
    if (value === null || value.trim().length === 0) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const read = (suffix: string): string | null =>
    headers.get(`anthropic-ratelimit-unified-${suffix}`);
  const fiveHour = percent(parse("5h-utilization"));
  if (fiveHour !== undefined) {
    const resetsAt = toIso(parse("5h-reset"));
    const status = read("5h-status") ?? undefined;
    windows.push({
      id: "5h",
      label: "5h",
      usedPercent: fiveHour,
      ...(resetsAt ? { resetsAt } : {}),
      ...(status ? { status } : {}),
    });
  }
  const sevenDay = percent(parse("7d-utilization"));
  if (sevenDay !== undefined) {
    const resetsAt = toIso(parse("7d-reset"));
    const status = read("7d-status") ?? undefined;
    windows.push({
      id: "7d",
      label: "7d",
      usedPercent: sevenDay,
      ...(resetsAt ? { resetsAt } : {}),
      ...(status ? { status } : {}),
    });
  }
  return windows;
}

function windowMinutesLabel(minutes: number | undefined): string {
  if (minutes === undefined || minutes <= 0) return "window";
  const hours = minutes / 60;
  if (hours <= 6) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function codexWindow(id: string, raw: unknown): QuotaWindow | undefined {
  const window = asRecord(raw);
  // Codex reports used_percent on a 0-100 scale (1 = 1%), same as OpenCode Go.
  const usedPercent = percentPoints(window.used_percent);
  if (usedPercent === undefined) return undefined;
  const seconds =
    typeof window.limit_window_seconds === "number"
      ? window.limit_window_seconds
      : typeof window.window_minutes === "number"
        ? window.window_minutes * 60
        : undefined;
  const resetsAt = toIso(window.reset_at ?? window.resets_at);
  const status = typeof window.status === "string" ? window.status : undefined;
  return {
    id,
    label: windowMinutesLabel(seconds === undefined ? undefined : seconds / 60),
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
    ...(status ? { status } : {}),
  };
}

export function codexWindowsFromHeaders(headers: Headers): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const parse = (suffix: string): number | undefined => {
    const value = headers.get(`x-codex-${suffix}`);
    if (value === null || value.trim().length === 0) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const window = (id: string, prefix: string): QuotaWindow | undefined => {
    const usedPercent = percentPoints(parse(`${prefix}-used-percent`));
    if (usedPercent === undefined) return undefined;
    const minutes = parse(`${prefix}-window-minutes`);
    const resetsAt = toIso(parse(`${prefix}-reset-at`));
    return {
      id,
      label: windowMinutesLabel(minutes),
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
    };
  };
  const primary = window("codex-primary", "primary");
  if (primary) windows.push(primary);
  const secondary = window("codex-secondary", "secondary");
  if (secondary) windows.push(secondary);
  return windows;
}

export function captureQuotaHeaders(provider: Provider, headers: Headers): void {
  const windows = [...anthropicWindowsFromHeaders(headers), ...codexWindowsFromHeaders(headers)];
  if (windows.length === 0) return;
  const current = headerQuotas();
  const previous = current[provider.name];
  if (previous && !snapshotStale(previous.fetchedAt) && sameWindows(previous.windows, windows)) {
    return;
  }
  saveHeaderQuotas({
    ...current,
    [provider.name]: { windows, fetchedAt: new Date().toISOString() },
  });
}

/**
 * Why an upstream refused in a way that means "do not keep hitting this provider".
 * Both feed the same exhausted bit that {@link providerQuotaHealth} already reads.
 */
export type ProviderSpendSignal = "billing" | "quota";

/**
 * Structured exhaustion markers upstreams actually emit. Prefer these over free-text
 * messages — providers rename copy constantly, but keep stable `type` / `code` fields.
 */
const QUOTA_TOKENS = new Set([
  "usage_limit_reached",
  "gousagelimiterror",
  "rate_limited",
  "quota_exceeded",
  "weekly_usage_limit",
]);

const BILLING_TOKENS = new Set([
  "insufficient_credits",
  "insufficient_balance",
  "payment_required",
  "billing_not_active",
  "budget_exhausted",
]);

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Pull type/code tokens from the common OpenAI / Anthropic / gateway error envelopes. */
function errorTokens(body: string): string[] {
  const tokens: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== "string" || value.length === 0) return;
    tokens.push(normalizeToken(value));
  };
  try {
    const json = JSON.parse(body) as unknown;
    const walk = (value: unknown, depth: number): void => {
      if (depth > 4 || value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry, depth + 1);
        return;
      }
      const record = value as Record<string, unknown>;
      add(record.type);
      add(record.code);
      add(record.error_type);
      // Nested envelopes: `{ error: { type, code } }` and `{ type:"error", error:{…} }`.
      walk(record.error, depth + 1);
    };
    walk(json, 0);
  } catch {
    // Non-JSON bodies have no structured signal.
  }
  return tokens;
}

/**
 * Unified "is this provider spent?" classifier for a failed upstream response.
 *
 * Evidence, strongest first:
 * 1. HTTP 402 Payment Required — always billing
 * 2. Structured `type` / `code` tokens in the JSON body
 *
 * Free-text messages are deliberately ignored: they are locale- and marketing-dependent,
 * and chasing them with regex is how we keep rediscovering the same bug.
 */
export function providerSpendSignal(status: number, body: string): ProviderSpendSignal | undefined {
  if (status === 402) return "billing";
  if (status !== 429 && status !== 403) return undefined;

  const tokens = errorTokens(body);
  if (tokens.some((token) => BILLING_TOKENS.has(token))) return "billing";
  if (tokens.some((token) => QUOTA_TOKENS.has(token))) return "quota";
  return undefined;
}

/** @deprecated Prefer {@link providerSpendSignal}. */
export function isUsageLimitError(status: number, body: string): boolean {
  return providerSpendSignal(status, body) !== undefined;
}

/**
 * Records a provider as exhausted when the upstream answers with a spend signal.
 *
 * Without a snapshot the quota guard cannot route around a spent provider and every
 * client probe keeps landing on the same dead end. Returns true when a limit was
 * recorded so the caller can immediately re-route.
 */
export function captureUsageLimit(provider: Provider, status: number, body: string): boolean {
  const signal = providerSpendSignal(status, body);
  if (!signal) return false;
  const weekly = /week/i.test(body);
  let resetsAt: string | undefined;
  // Codex returns unix seconds: `"resets_at":1789929256`.
  const unixReset = /"resets_at"\s*:\s*(\d{9,12})/.exec(body);
  if (unixReset) {
    const seconds = Number(unixReset[1]);
    if (Number.isFinite(seconds) && seconds > 1_000_000_000) {
      resetsAt = new Date(seconds * 1000).toISOString();
    }
  }
  const isoReset = /resets?\s+at\s+(\d{4}-\d{2}-\d{2}T[^\s".]+)/i.exec(body);
  if (!resetsAt && isoReset) {
    const parsed = Date.parse(isoReset[1]);
    if (!Number.isNaN(parsed)) resetsAt = new Date(parsed).toISOString();
  }
  if (!resetsAt) {
    const secondsMatch = /"resets_in_seconds"\s*:\s*(\d+)/i.exec(body);
    if (secondsMatch) {
      const seconds = Number(secondsMatch[1]);
      if (Number.isFinite(seconds)) {
        resetsAt = new Date(Date.now() + seconds * 1000).toISOString();
      }
    }
  }
  if (!resetsAt) {
    const resetsMatch =
      /resets?\s+in\s+(\d+)\s*hr(?:\s+(\d+)\s*min)?/i.exec(body) ??
      /resets?\s+in\s+(\d+)\s*h(?:\s*(\d+)\s*m)?/i.exec(body);
    if (resetsMatch) {
      const hours = Number(resetsMatch[1] ?? 0);
      const minutes = Number(resetsMatch[2] ?? 0);
      if (Number.isFinite(hours)) {
        resetsAt = new Date(Date.now() + (hours * 60 + minutes) * 60_000).toISOString();
      }
    }
  }
  const window: QuotaWindow = {
    id: signal === "billing" ? "balance" : weekly ? "week" : "limit",
    label: signal === "billing" ? "balance" : weekly ? "week" : "limit",
    usedPercent: 100,
    ...(resetsAt ? { resetsAt } : {}),
    status: "rejected",
  };
  const current = headerQuotas();
  saveHeaderQuotas({
    ...current,
    [provider.name]: { windows: [window], fetchedAt: new Date().toISOString() },
  });
  liveCache.delete(provider.name);
  return true;
}

function spendOf(records: LedgerRecord[], provider: string): ProviderSpend {
  const now = Date.now();
  const spend: ProviderSpend = {
    fiveHourUsd: 0,
    dayUsd: 0,
    weekUsd: 0,
    monthUsd: 0,
    monthRequests: 0,
  };
  for (const record of records) {
    if (record.provider !== provider) continue;
    const at = Date.parse(record.ts);
    if (Number.isNaN(at)) continue;
    const age = now - at;
    const cost = record.costUsd ?? 0;
    if (age <= 5 * 3_600_000) spend.fiveHourUsd += cost;
    if (age <= 86_400_000) spend.dayUsd += cost;
    if (age <= 7 * 86_400_000) spend.weekUsd += cost;
    if (age <= 30 * 86_400_000) {
      spend.monthUsd += cost;
      spend.monthRequests += 1;
    }
  }
  return {
    fiveHourUsd: round(spend.fiveHourUsd),
    dayUsd: round(spend.dayUsd),
    weekUsd: round(spend.weekUsd),
    monthUsd: round(spend.monthUsd),
    monthRequests: spend.monthRequests,
  };
}

function specWindows(spec: ProviderQuotaSpec, spend: ProviderSpend): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const push = (id: string, usedUsd: number, limitUsd: number | undefined): void => {
    if (!limitUsd) return;
    windows.push({
      id,
      label: id,
      usedUsd: round(usedUsd),
      limitUsd,
      usedPercent: Math.min(100, Math.max(0, (usedUsd / limitUsd) * 100)),
    });
  };
  push("5h", spend.fiveHourUsd, spec.fiveHourUsd);
  push("week", spend.weekUsd, spec.weeklyUsd);
  push("month", spend.monthUsd, spec.monthlyUsd);
  return windows;
}

function isOpenCodeGo(provider: Provider): boolean {
  return provider.baseUrl.includes("opencode.ai/zen/go");
}

function isCommandCode(provider: Provider): boolean {
  return provider.baseUrl.includes("commandcode.ai");
}

function isAntigravity(provider: Provider): boolean {
  return (
    provider.type === "gemini" ||
    (provider.auth === "oauth" && provider.oauthSource === "antigravity")
  );
}

function hostOf(provider: Provider): string | undefined {
  try {
    return new URL(provider.baseUrl).hostname;
  } catch {
    return undefined;
  }
}

function isDeepSeek(provider: Provider): boolean {
  return hostOf(provider)?.endsWith("deepseek.com") === true;
}

function isOpenRouter(provider: Provider): boolean {
  return hostOf(provider)?.endsWith("openrouter.ai") === true;
}

function isMoonshot(provider: Provider): boolean {
  return hostOf(provider)?.endsWith("moonshot.ai") === true;
}

function balance(amount: number | undefined, currency: string): LiveQuota {
  if (amount === undefined) return { windows: [] };
  return { windows: [], balance: { amount: round(amount), currency } };
}

async function deepseekBalance(provider: Provider): Promise<LiveQuota> {
  const auth = await resolveProviderAuth(provider, "openai");
  if (auth.error) return { error: auth.error };
  try {
    const origin = new URL(provider.baseUrl).origin;
    const response = await fetch(`${origin}/user/balance`, { headers: auth.headers });
    if (response.status === 401) return { error: "DeepSeek rejected the key." };
    if (!response.ok) return { error: `DeepSeek balance request failed (${response.status})` };
    const json = asRecord(await response.json());
    const infos = Array.isArray(json.balance_infos) ? json.balance_infos : [];
    const info = asRecord(infos[0]);
    const raw = typeof info.total_balance === "string" ? Number(info.total_balance) : undefined;
    const amount = raw !== undefined && Number.isFinite(raw) ? raw : undefined;
    const currency = typeof info.currency === "string" ? info.currency : "USD";
    return balance(amount, currency);
  } catch (error) {
    return { error: String(error) };
  }
}

async function openrouterBalance(provider: Provider): Promise<LiveQuota> {
  const auth = await resolveProviderAuth(provider, "openai");
  if (auth.error) return { error: auth.error };
  try {
    const base = provider.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}/credits`, { headers: auth.headers });
    if (response.status === 401) return { error: "OpenRouter rejected the key." };
    if (!response.ok) return { error: `OpenRouter credits request failed (${response.status})` };
    const json = asRecord(await response.json());
    const data = asRecord(json.data);
    const total = number(data.total_credits);
    const usage = number(data.total_usage);
    if (total === undefined || usage === undefined) return { windows: [] };
    return balance(Math.max(0, total - usage), "USD");
  } catch (error) {
    return { error: String(error) };
  }
}

async function moonshotBalance(provider: Provider): Promise<LiveQuota> {
  const auth = await resolveProviderAuth(provider, "openai");
  if (auth.error) return { error: auth.error };
  try {
    const base = provider.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}/users/me/balance`, { headers: auth.headers });
    if (response.status === 401) return { error: "Moonshot rejected the key." };
    if (!response.ok) return { error: `Moonshot balance request failed (${response.status})` };
    const json = asRecord(await response.json());
    const data = asRecord(json.data);
    const amount = number(data.available_balance ?? data.balance);
    return balance(amount, "USD");
  } catch (error) {
    return { error: String(error) };
  }
}

function commandCodeBaseUrl(): string {
  return (process.env.JEVONIAN_COMMANDCODE_BASE_URL ?? "https://api.commandcode.ai").replace(
    /\/+$/,
    "",
  );
}

async function commandCodeOptional(
  path: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(`${commandCodeBaseUrl()}${path}`, { headers });
    if (!response.ok) return undefined;
    return asRecord(await response.json());
  } catch {
    return undefined;
  }
}

function moneyWindow(id: string, label: string, raw: unknown): QuotaWindow | undefined {
  const window = asRecord(raw);
  const used = number(window.used);
  const cap = number(window.cap);
  if (used === undefined || cap === undefined || cap <= 0) return undefined;
  const resetsAt = number(window.resetAt);
  return {
    id,
    label,
    usedUsd: round(used),
    limitUsd: cap,
    usedPercent: Math.min(100, Math.max(0, (used / cap) * 100)),
    ...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt: toIso(resetsAt) } : {}),
    ...(window.exceeded === true ? { status: "exceeded" } : {}),
  };
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function commandCodeUsage(
  provider: Provider,
): Promise<{ windows: QuotaWindow[]; plan?: string; note?: string } | { error: string }> {
  const auth = await resolveProviderAuth(provider, "openai");
  if (auth.error) return { error: auth.error };
  const response = await fetch(`${commandCodeBaseUrl()}/alpha/billing/credits`, {
    headers: auth.headers,
  });
  if (response.status === 401) return { error: "Command Code rejected the key." };
  if (!response.ok) return { error: `Command Code usage request failed (${response.status})` };
  const json = asRecord(await response.json());
  const limits = asRecord(json.windowLimits);
  const windows = [
    moneyWindow("5h", "5h", limits.fiveHour),
    moneyWindow("week", "week", limits.weekly),
  ].filter((window): window is QuotaWindow => window !== undefined);

  const credits = asRecord(json.credits);
  const remaining = number(credits.monthlyCredits);
  const [summary, subscription] = await Promise.all([
    commandCodeOptional("/alpha/usage/summary", auth.headers),
    commandCodeOptional("/alpha/billing/subscriptions", auth.headers),
  ]);
  const used = summary ? number(summary.totalMonthlyCredits) : undefined;
  if (used !== undefined && remaining !== undefined && used + remaining > 0) {
    const cap = used + remaining;
    const end = asRecord(subscription?.data).currentPeriodEnd;
    windows.push({
      id: "month",
      label: "month",
      usedUsd: round(used),
      limitUsd: round(cap),
      usedPercent: Math.min(100, Math.max(0, (used / cap) * 100)),
      ...(typeof end === "string" ? { resetsAt: toIso(end) } : {}),
    });
  }

  const planId = asRecord(subscription?.data).planId;
  const plan =
    typeof planId === "string" ? planId.replace(/^individual-/, "").toUpperCase() : undefined;
  return {
    windows,
    ...(plan ? { plan } : {}),
    ...(remaining === undefined ? {} : { note: `$${remaining.toFixed(2)} credits left` }),
  };
}

/**
 * Antigravity meters quota per *counter*, not per model. Models backed by
 * different upstream providers (Google / Anthropic / OpenAI) draw from separate
 * counters with their own reset times, so collapsing them into one minimum lets
 * a healthy counter mask an exhausted one. We group by `modelProvider` and
 * report one window per counter, labelled so it is obvious which is which.
 */
const ANTIGRAVITY_COUNTER_LABELS: Record<string, string> = {
  MODEL_PROVIDER_GOOGLE: "gemini",
  MODEL_PROVIDER_ANTHROPIC: "claude",
  MODEL_PROVIDER_OPENAI: "openai",
};

const ANTIGRAVITY_COUNTER_ORDER = ["gemini", "claude", "openai"];

interface AntigravityCounter {
  remaining: number;
  resetsAt?: string;
}

function antigravityCounterLabel(raw: unknown, fallbackIndex: number): string {
  const provider = typeof raw === "string" ? raw : "";
  const known = ANTIGRAVITY_COUNTER_LABELS[provider];
  if (known) return known;
  if (provider.startsWith("MODEL_PROVIDER_")) {
    return provider.slice("MODEL_PROVIDER_".length).toLowerCase();
  }
  return `counter-${fallbackIndex}`;
}

function antigravityCounters(models: Record<string, unknown>): Map<string, AntigravityCounter> {
  const counters = new Map<string, AntigravityCounter>();
  let unknownIndex = 0;
  for (const raw of Object.values(models)) {
    const model = asRecord(raw);
    const quota = asRecord(model.quotaInfo);
    const fraction = number(quota.remainingFraction);
    if (fraction === undefined) continue;
    const label = antigravityCounterLabel(model.modelProvider, unknownIndex++);
    const resetsAt = toIso(quota.resetTime);
    const existing = counters.get(label);
    // Within one counter the values agree; track the tightest and its reset.
    if (!existing || fraction < existing.remaining) {
      counters.set(label, {
        remaining: fraction,
        ...(resetsAt ? { resetsAt } : existing?.resetsAt ? { resetsAt: existing.resetsAt } : {}),
      });
    } else if (!existing.resetsAt && resetsAt) {
      existing.resetsAt = resetsAt;
    }
  }
  return counters;
}

async function antigravityUsage(
  provider: Provider,
): Promise<{ windows: QuotaWindow[]; note?: string } | { error: string }> {
  const auth = await resolveProviderAuth(provider, "openai");
  if (auth.error) return { error: auth.error };
  const base = provider.baseUrl.replace(/\/+$/, "").replace(/\/v1internal$/, "");
  const response = await fetch(`${base}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: auth.headers,
    body: JSON.stringify({ project: auth.project ?? "default-cli-project" }),
  });
  if (response.status === 401) return { error: "Antigravity rejected the token." };
  if (!response.ok) return { error: `Antigravity usage request failed (${response.status})` };
  const json = asRecord(await response.json());
  const models = asRecord(json.models);
  const counters = antigravityCounters(models);
  if (counters.size === 0) return { windows: [] };

  const labels = [...counters.keys()].sort((a, b) => {
    const ai = ANTIGRAVITY_COUNTER_ORDER.indexOf(a);
    const bi = ANTIGRAVITY_COUNTER_ORDER.indexOf(b);
    if (ai !== bi)
      return (
        (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi)
      );
    return a.localeCompare(b);
  });

  const windows: QuotaWindow[] = labels.map((label) => {
    const counter = counters.get(label) as AntigravityCounter;
    return {
      id: `antigravity-${label}`,
      label,
      usedPercent: Math.min(100, Math.max(0, (1 - counter.remaining) * 100)),
      ...(counter.resetsAt ? { resetsAt: counter.resetsAt } : {}),
    };
  });

  return {
    windows,
    ...(windows.length > 1 ? { note: `${windows.length} quota counters` } : {}),
  };
}

async function opencodeGoUsage(
  provider: Provider,
): Promise<{ windows: QuotaWindow[] } | { error: string }> {
  const auth = await resolveProviderAuth(provider);
  if (auth.error) return { error: auth.error };
  const response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/usage`, {
    headers: auth.headers,
  });
  if (response.status === 401) return { error: "OpenCode Go rejected the key." };
  if (response.status === 403) return { error: "No OpenCode Go subscription on this key." };
  if (!response.ok) return { error: `OpenCode Go usage request failed (${response.status})` };
  const json = asRecord(await response.json());
  const usage = asRecord(json.usage);
  const windows: QuotaWindow[] = [];
  const entries: Array<[string, string]> = [
    ["rolling", "5h"],
    ["weekly", "week"],
    ["monthly", "month"],
  ];
  for (const [key, label] of entries) {
    const window = asRecord(usage[key]);
    const usedPercent = percentPoints(window.percent);
    if (usedPercent === undefined) continue;
    const resetsAt = toIso(window.resetsAt);
    windows.push({
      id: label,
      label,
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
      ...(typeof window.status === "string" ? { status: window.status } : {}),
    });
  }
  return { windows };
}

async function claudeUsage(
  provider: Provider,
): Promise<{ windows: QuotaWindow[] } | { error: string }> {
  const auth = await resolveProviderAuth(provider);
  if (auth.error) return { error: auth.error };
  const origin = new URL(provider.baseUrl).origin;
  const response = await fetch(`${origin}/api/oauth/usage`, { headers: auth.headers });
  if (response.status === 429)
    return { error: "Claude usage endpoint is rate limited; using the last snapshot." };
  if (!response.ok) return { error: `Claude usage request failed (${response.status})` };
  const json = asRecord(await response.json());
  const windows: QuotaWindow[] = [];
  const fiveHour = asRecord(json.five_hour);
  const usedFiveHour = percent(fiveHour.utilization);
  if (usedFiveHour !== undefined) {
    const resetsAt = toIso(fiveHour.resets_at);
    windows.push({
      id: "5h",
      label: "5h",
      usedPercent: usedFiveHour,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const sevenDay = asRecord(json.seven_day);
  const usedSevenDay = percent(sevenDay.utilization);
  if (usedSevenDay !== undefined) {
    const resetsAt = toIso(sevenDay.resets_at);
    windows.push({
      id: "7d",
      label: "7d",
      usedPercent: usedSevenDay,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return { windows };
}

async function codexUsage(
  provider: Provider,
): Promise<{ windows: QuotaWindow[]; plan?: string; note?: string } | { error: string }> {
  if (provider.auth !== "oauth" || provider.oauthSource !== "codex") return { windows: [] };
  const resolved = await resolveOAuthToken({ source: "codex" });
  if ("error" in resolved) return { error: resolved.error };
  const url = process.env.JEVONIAN_CODEX_USAGE_URL ?? "https://chatgpt.com/backend-api/wham/usage";
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${resolved.token}`,
      accept: "application/json",
      ...(resolved.accountId ? { "chatgpt-account-id": resolved.accountId } : {}),
    },
  });
  if (!response.ok) return { error: `Codex usage request failed (${response.status})` };
  const json = asRecord(await response.json());
  const rateLimit = asRecord(json.rate_limit);
  const windows: QuotaWindow[] = [];
  const primary = codexWindow("codex-primary", rateLimit.primary_window);
  if (primary) windows.push(primary);
  const secondary = codexWindow("codex-secondary", rateLimit.secondary_window);
  if (secondary) windows.push(secondary);
  const credits = asRecord(json.credits);
  const balance = credits.balance;
  const note =
    typeof balance === "string" && balance.length > 0
      ? `credits ${balance}`
      : credits.unlimited === true
        ? "unlimited credits"
        : undefined;
  const plan = typeof json.plan_type === "string" ? json.plan_type : undefined;
  return {
    windows,
    ...(plan ? { plan } : {}),
    ...(note ? { note } : {}),
  };
}

function liveTtl(provider: Provider): number {
  if (provider.auth === "oauth" && provider.oauthSource === "claude-code") return 300_000;
  return 60_000;
}

type LiveQuota =
  | { windows: QuotaWindow[]; plan?: string; note?: string; balance?: ProviderBalance }
  | { error: string };

async function fetchLive(provider: Provider): Promise<LiveQuota | undefined> {
  try {
    if (isOpenCodeGo(provider)) return await opencodeGoUsage(provider);
    if (isCommandCode(provider)) return await commandCodeUsage(provider);
    if (isAntigravity(provider)) return await antigravityUsage(provider);
    if (isDeepSeek(provider)) return await deepseekBalance(provider);
    if (isOpenRouter(provider)) return await openrouterBalance(provider);
    if (isMoonshot(provider)) return await moonshotBalance(provider);
    if (provider.auth === "oauth" && provider.oauthSource === "claude-code") {
      return await claudeUsage(provider);
    }
    if (provider.auth === "oauth" && provider.oauthSource === "codex") {
      return await codexUsage(provider);
    }
    return undefined;
  } catch (error) {
    return { error: String(error) };
  }
}

async function buildQuota(
  provider: Provider,
  spend: ProviderSpend,
): Promise<Omit<ProviderQuota, "spend">> {
  const base = {
    provider: provider.name,
    billing: provider.billing,
    auth: apiKeySource(provider),
  };
  const live = await fetchLive(provider);
  const liveError = live && "error" in live ? live.error : undefined;
  if (live && !("error" in live) && (live.windows.length > 0 || live.balance)) {
    // The probe answered. Drop a synthetic rejection, and when live returns real
    // windows overwrite the on-disk snapshot too — otherwise a cold live cache
    // falls back to a stale 100% (mis-scaled Codex `used_percent: 1`, or an old
    // rejection) and routing skips a healthy provider.
    if (live.windows.length > 0) {
      const current = headerQuotas();
      saveHeaderQuotas({
        ...current,
        [provider.name]: {
          windows: live.windows,
          fetchedAt: new Date().toISOString(),
          ...(live.plan ? { plan: live.plan } : {}),
        },
      });
    } else {
      clearRejection(provider.name);
    }
    return {
      ...base,
      source: "live",
      windows: live.windows,
      fetchedAt: new Date().toISOString(),
      ...(live.plan ? { plan: live.plan } : {}),
      ...(live.note ? { note: live.note } : {}),
      ...(live.balance ? { balance: live.balance } : {}),
    };
  }
  const header = headerQuotas()[provider.name];
  if (header && header.windows.length > 0) {
    const staleNote = stalenessNote(header.fetchedAt);
    return {
      ...base,
      source: "headers",
      windows: header.windows,
      fetchedAt: header.fetchedAt,
      ...(header.plan ? { plan: header.plan } : {}),
      ...(staleNote ? { note: staleNote } : {}),
      ...(liveError ? { error: liveError } : {}),
    };
  }
  if (provider.quota) {
    const windows = specWindows(provider.quota, spend);
    if (windows.length > 0) {
      const quota: Omit<ProviderQuota, "spend"> = {
        ...base,
        source: "ledger",
        windows,
        fetchedAt: new Date().toISOString(),
        ...(liveError ? { error: liveError } : {}),
      };
      return quota;
    }
  }
  return {
    ...base,
    source: "none",
    windows: [],
    fetchedAt: new Date().toISOString(),
    ...(liveError ? { error: liveError } : {}),
  };
}

interface KnownWindows {
  windows: QuotaWindow[];
  source: QuotaSource;
  staleNote?: string;
}

function knownWindows(provider: Provider, now: number, spend: ProviderSpend): KnownWindows {
  const cached = liveCache.get(provider.name);
  if (cached && now - cached.at < liveTtl(provider)) {
    return { windows: cached.quota.windows, source: cached.quota.source };
  }
  const header = headerQuotas()[provider.name];
  if (header && header.windows.length > 0) {
    const staleNote = stalenessNote(header.fetchedAt);
    return {
      windows: header.windows,
      source: "headers",
      ...(staleNote ? { staleNote } : {}),
    };
  }
  if (provider.quota) {
    const windows = specWindows(provider.quota, spend);
    if (windows.length > 0) return { windows, source: "ledger" };
  }
  return { windows: [], source: "none" };
}

function averageRequestUsd(spend: ProviderSpend): number | undefined {
  if (spend.monthRequests < 3 || spend.monthUsd <= 0) return undefined;
  return spend.monthUsd / spend.monthRequests;
}

export function providerQuotaHealth(
  provider: Provider,
  options: { lowPercent?: number; now?: number } = {},
): QuotaHealth {
  const now = options.now ?? Date.now();
  const lowPercent = options.lowPercent ?? DEFAULT_LOW_PERCENT;
  const spend = spendOf(ledgerRecords(now), provider.name);
  const known = knownWindows(provider, now, spend);
  let worst: QuotaWindow | undefined;
  for (const window of known.windows) {
    if (window.resetsAt) {
      const resets = Date.parse(window.resetsAt);
      if (!Number.isNaN(resets) && resets <= now) continue;
    }
    if (!worst || (window.usedPercent ?? 0) > (worst.usedPercent ?? 0)) worst = window;
  }
  if (known.windows.length === 0) return { provider: provider.name, status: "unknown" };
  if (!worst) {
    return { provider: provider.name, status: "ok", note: "windows reset" };
  }
  const usedPercent = Math.min(100, Math.max(0, worst.usedPercent ?? 0));
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const avgRequestUsd = averageRequestUsd(spend);
  const remainingUsd =
    worst.limitUsd !== undefined && worst.usedUsd !== undefined
      ? Math.max(0, worst.limitUsd - worst.usedUsd)
      : undefined;
  let status: QuotaStatus =
    usedPercent >= 100 ? "exhausted" : remainingPercent < lowPercent ? "low" : "ok";
  if (remainingUsd !== undefined && avgRequestUsd !== undefined) {
    if (remainingUsd < avgRequestUsd) status = "exhausted";
    else if (remainingUsd < avgRequestUsd * SUFFICIENT_REQUEST_MULTIPLE && status === "ok") {
      status = "low";
    }
  }
  const note =
    known.source === "ledger"
      ? "estimated from the local ledger"
      : known.staleNote
        ? `stale snapshot (${known.staleNote})`
        : undefined;
  return {
    provider: provider.name,
    status,
    usedPercent,
    remainingPercent,
    window: worst.label,
    ...(worst.resetsAt ? { resetsAt: worst.resetsAt } : {}),
    ...(remainingUsd === undefined ? {} : { remainingUsd: round(remainingUsd) }),
    ...(avgRequestUsd === undefined ? {} : { avgRequestUsd: round(avgRequestUsd) }),
    ...(note ? { note } : {}),
  };
}

export async function providerQuotas(
  config: Config,
  options: { refresh?: boolean } = {},
): Promise<ProviderQuota[]> {
  const records = readRecords();
  return Promise.all(
    config.providers.map(async (provider) => {
      const spend = spendOf(records, provider.name);
      const cached = liveCache.get(provider.name);
      if (!options.refresh && cached && Date.now() - cached.at < liveTtl(provider)) {
        return { ...cached.quota, spend };
      }
      const quota = await buildQuota(provider, spend);
      liveCache.set(provider.name, { at: Date.now(), quota });
      return { ...quota, spend };
    }),
  );
}
