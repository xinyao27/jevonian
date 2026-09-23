export type ProviderTypeView = "openai" | "anthropic" | "responses" | "both" | "gemini";
export type ProviderAuthView = "api-key" | "oauth";
export type ProviderBillingView = "api" | "subscription";

export interface ProviderQuotaSpecView {
  fiveHourUsd?: number;
  weeklyUsd?: number;
  monthlyUsd?: number;
}

export interface ProviderView {
  name: string;
  type: ProviderTypeView;
  baseUrl: string;
  apiKeyEnv?: string;
  auth?: ProviderAuthView;
  oauthSource?: string;
  billing?: ProviderBillingView;
  quota?: ProviderQuotaSpecView;
  keySource: string;
  models: string[];
  /**
   * Explicit override. Absent: follow the default (sync only for the OAuth sources listed in
   * `StateResponse.modelSyncDefaultSources`).
   */
  syncModels?: boolean;
  /** Model ids discovery must not re-add after a deliberate removal. */
  excludeModels?: string[];
}

export interface PresetView {
  id: string;
  name: string;
  type: ProviderTypeView;
  baseUrl: string;
  apiKeyEnv?: string;
  hint: string;
  keysUrl?: string;
  auth?: ProviderAuthView;
  oauthSource?: string;
  billing?: ProviderBillingView;
}

export interface BrainView {
  channel: string;
  baseUrl?: string;
  accountId?: string;
  apiKeyEnv?: string;
  model?: string;
  timeoutMs: number;
  minConfidence: number;
  fullPrompt?: boolean;
  keySource?: string;
}

export interface BrainChannelView {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  requiresBaseUrl?: boolean;
  requiresAccountId?: boolean;
  hint?: string;
  keysUrl?: string;
}

export interface QuotaGuardView {
  enabled: boolean;
  lowPercent: number;
}

export interface ModelCapacityView {
  contextWindow?: number;
  maxOutput?: number;
  efforts?: string[];
}

export interface RoutingEntryView {
  id: string;
  label: string;
  description: string;
  models: string[];
  /**
   * Which providers may serve each model within this routing, in preference order.
   * Absent → every provider that serves the model. Empty → the model is withheld.
   */
  providers?: Record<string, string[]>;
}

export interface RoutingView {
  mode: "auto" | "off";
  routings: RoutingEntryView[];
  tiers: { plan: string[]; execute: string[]; utility: string[]; chat: string[] };
  sessionTtlMinutes: number;
  baselineModel?: string;
  quotaGuard?: QuotaGuardView;
  /** Ask the brain for a thinking level alongside the model. */
  brainPicksEffort: boolean;
  /** Level used when the brain does not pick one, or cannot be asked. */
  defaultEffort?: string;
  /** Per-model overrides for what the models.dev catalog states. */
  capacities?: Record<string, ModelCapacityView>;
  brains: BrainView[];
}

export interface KeyView {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  requests: number;
  /** USD ceiling for pay-as-you-go spend. `null` means unlimited. */
  limitUsd?: number | null;
  /** Estimated pay-as-you-go spend attributed to this key. */
  spendUsd?: number;
  /** Value consumed from flat-rate subscriptions, kept separate from real spend. */
  subscriptionUsd?: number;
}

export type ActivityTimeRangeView = "today" | "24h" | "7d" | "30d" | "all";

export interface ActivitySeriesPointView {
  timestamp: string;
  label: string;
  spendUsd: number;
  subscriptionUsd: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  requests: number;
  errorRequests: number;
}

export interface ActivityModelStatView {
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  spendUsd: number;
  subscriptionUsd: number;
  percentSpend: number;
}

export interface ActivityKeyStatView {
  id: string;
  name: string;
  requests: number;
  spendUsd: number;
  subscriptionUsd: number;
}

export interface ActivityReportView {
  range: ActivityTimeRangeView;
  keyId: string;
  startTime: string;
  endTime: string;
  summary: {
    totalSpendUsd: number;
    apiSpendUsd: number;
    subscriptionValueUsd: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
    totalRequests: number;
    successfulRequests: number;
    errorRequests: number;
    avgLatencyMs: number;
  };
  series: ActivitySeriesPointView[];
  models: ActivityModelStatView[];
  keys: ActivityKeyStatView[];
}

export interface UpdateStatusView {
  current: string;
  latest?: string;
  updateAvailable: boolean;
  channel: "npm" | "pnpm" | "source" | "unknown";
  installCommand?: string;
  checkedAt?: string;
  error?: string;
}

export interface UpdateResponse {
  update: UpdateStatusView;
  active: boolean;
  activeRequests?: number;
  error?: string;
}

export interface ModelSyncConfigView {
  enabled: boolean;
  intervalMinutes: number;
}

export interface ModelSyncProviderResultView {
  provider: string;
  added: string[];
  skipped?: "opted-out" | "default-off";
  error?: string;
}

export interface ModelSyncResponse {
  config: ModelSyncConfigView;
  lastCheckedAt?: string;
  lastAdded: number;
  providers: ModelSyncProviderResultView[];
  providersSkipped: string[];
  result?: {
    checkedAt: string;
    added: number;
    changed: boolean;
    providers: ModelSyncProviderResultView[];
  };
}

export interface StateResponse {
  config: {
    listen: { host: string; port: number };
    defaultProvider?: string;
    providers: ProviderView[];
    routing: RoutingView;
    modelSync?: ModelSyncConfigView;
  };
  tiers: { plan: string[]; execute: string[]; utility: string[]; chat: string[] };
  routings: RoutingEntryView[];
  pricing: { source: string; models: number };
  keys: KeyView[];
  brainChannels: BrainChannelView[];
  presets: PresetView[];
  /** OAuth sources that auto-sync when a provider has no explicit `syncModels`. */
  modelSyncDefaultSources?: string[];
  update?: UpdateStatusView;
}

export interface ModelView {
  id: string;
  provider: string;
  configured: boolean;
  canonical?: string;
  price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

export interface CanonicalModelView {
  id: string;
  /** The catalog's vendor label for this model, when it names one ("DeepSeek V4.1 Flash"). */
  name?: string;
  /** The catalog's brand line — wider than a model, diagnostics only. */
  family?: string;
  variants: Array<{ provider: string; model: string; viaIdentity?: boolean; official?: boolean }>;
}

export interface LogRecord {
  id?: string;
  requestId?: string;
  ts: string;
  session: string;
  path: string;
  provider: string;
  model: string;
  stream: boolean;
  status: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  kind?: "request" | "brain";
  billing?: string;
  requestedModel?: string;
  phase?: string;
  routed?: boolean;
  reason?: string;
  brain?: string;
  brainChannel?: string;
  /** The thinking level sent upstream, after clamping to what the model supports. */
  effort?: string;
  effortNote?: string;
  /** Models code withheld from the brain, each with why. Never dropped silently. */
  skipped?: Array<{ model: string; provider: string; reason: string; detail: string }>;
  error?: string;
  /** Jevonian key that authorized the request, or "local" / "unauthenticated". */
  keyId?: string;
  /** Key name captured at request time, so a revoked key still reads sensibly. */
  keyName?: string;
}

export interface LogDetailResponse {
  record: LogRecord;
  body?: unknown;
  brainCalls: Array<{ record: LogRecord; body?: unknown }>;
}

/** Filters shared by the list, the live stream, and the header chart. */
export interface LogQuery {
  phase?: string;
  model?: string;
  /** Free-text match over model, provider, phase, session, reason, and effort. */
  q?: string;
}

export interface LogPage {
  logs: LogRecord[];
  /** Matching records in the whole ledger, not just this page. */
  total: number;
  /**
   * Exclusive cursor for the next page. `null` means the ledger is exhausted, which
   * is how the list knows to stop asking for more.
   */
  nextBefore: number | null;
}

export interface LogSeriesBucket {
  start: string;
  requests: number;
  errors: number;
  costUsd: number;
  avgLatencyMs: number;
}

export interface LogSeries {
  minutes: number;
  buckets: LogSeriesBucket[];
}

/** A stable identity for a ledger row, falling back to its shape when no id exists. */
export function logKey(log: LogRecord): string {
  return log.id ?? `${log.ts}-${log.session}-${log.model}`;
}

export interface QuotaWindow {
  id: string;
  label: string;
  usedPercent?: number;
  usedUsd?: number;
  limitUsd?: number;
  resetsAt?: string;
  status?: string;
}

export interface ProviderQuotaView {
  provider: string;
  billing: ProviderBillingView;
  auth: string;
  source: "live" | "headers" | "ledger" | "none";
  plan?: string;
  note?: string;
  balance?: { amount: number; currency: string };
  windows: QuotaWindow[];
  spend: {
    fiveHourUsd: number;
    dayUsd: number;
    weekUsd: number;
    monthUsd: number;
    monthRequests: number;
  };
  fetchedAt: string;
  error?: string;
}

export type QuotaStatusView = "ok" | "low" | "exhausted" | "unknown";

export interface QuotaHealthView {
  provider: string;
  billing?: ProviderBillingView;
  status: QuotaStatusView;
  usedPercent?: number;
  remainingPercent?: number;
  window?: string;
  resetsAt?: string;
  remainingUsd?: number;
  avgRequestUsd?: number;
  note?: string;
}

export interface QuotaResponse {
  quotas: ProviderQuotaView[];
  health: QuotaHealthView[];
  guard: QuotaGuardView;
}

export type TunnelProviderView = "cloudflare" | "ngrok" | "custom";
export interface TunnelStatusView {
  status: "off" | "starting" | "on" | "error";
  provider: TunnelProviderView;
  publicPort: number;
  url?: string;
  error?: string;
  startedAt?: string;
  command?: string;
}

export interface TunnelResponse {
  config: {
    enabled: boolean;
    provider: TunnelProviderView;
    command?: string;
    url?: string;
    publicPort?: number;
  };
  tunnel: TunnelStatusView | null;
  error?: string;
}

export type ClientIdView = "chatgpt" | "claude";
export type ClientStatusView = "connected" | "disconnected" | "unavailable";

export interface ClientSurfaceView {
  id: string;
  label: string;
  status: ClientStatusView;
  configPath?: string;
  baseUrl?: string;
  reason?: string;
}

export interface ClientTargetView {
  id: ClientIdView;
  label: string;
  installed: boolean;
  status: ClientStatusView;
  configPath?: string;
  baseUrl?: string;
  reason?: string;
  logo: string;
  surfaces?: ClientSurfaceView[];
}

export interface ClientsResponse {
  clients: ClientTargetView[];
  /** Machine running the Jevonian server, i.e. where the files get written. */
  hostname: string;
  platform: string;
}

export interface ApplyClientResponse {
  result: {
    target: ClientTargetView;
    restarted: boolean;
    written: string[];
  };
}

export interface StatsResponse {
  requests: number;
  sessions: number;
  costUsd: number;
  apiUsd: number;
  subscriptionUsd: number;
  subscriptionRequests: number;
  brainUsd: number;
  brainRequests: number;
  baselineUsd: number;
  apiBaselineUsd: number;
  subscriptionBaselineUsd: number;
  baselineModel?: string;
  savingsUsd: number;
  savingsPct: number;
  cacheHitRate: number;
  unpriced: number;
  byModel: Array<{ model: string; requests: number; costUsd: number; unpriced: number }>;
  byPhase: Array<{ phase: string; requests: number; costUsd: number }>;
}

export interface RestartRequiredView {
  error: "restart-required";
  running: true;
  client: ClientIdView;
  message: string;
}

export function isRestartRequired(value: unknown): value is RestartRequiredView {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { error?: unknown }).error === "restart-required"
  );
}

/**
 * Applies the Jevonian profile to a desktop client. Returns `restart-required`
 * instead of throwing when the app is running and the user has not yet
 * confirmed the restart, so the UI can prompt rather than show an error.
 */
export async function connectClient(
  id: ClientIdView,
  restart = false,
): Promise<ApplyClientResponse | RestartRequiredView> {
  const response = await fetch(`/api/clients/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ restart }),
  });
  const body = (await response.json().catch(() => ({}))) as
    | ApplyClientResponse
    | RestartRequiredView
    | { error?: string };
  if (isRestartRequired(body)) return body;
  if (!response.ok) {
    const message = (body as { error?: string }).error ?? `request failed: ${response.status}`;
    throw new Error(message);
  }
  return body as ApplyClientResponse;
}

export async function disconnectClient(
  id: ClientIdView,
  restart = false,
): Promise<{ clients: ClientTargetView[] } | RestartRequiredView> {
  const response = await fetch(`/api/clients/${id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ restart }),
  });
  const body = (await response.json().catch(() => ({}))) as
    | { clients: ClientTargetView[] }
    | RestartRequiredView
    | { error?: string };
  if (isRestartRequired(body)) return body;
  if (!response.ok) {
    const message = (body as { error?: string }).error ?? `request failed: ${response.status}`;
    throw new Error(message);
  }
  return body as { clients: ClientTargetView[] };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `request failed: ${response.status}`);
  return body;
}

export interface PriceInfo {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export const api = {
  state: () => request<StateResponse>("/api/state"),
  models: () => request<{ models: ModelView[]; canonicals: CanonicalModelView[] }>("/api/models"),
  prices: (provider: string) =>
    request<{ provider: string; prices: Record<string, PriceInfo> }>(
      `/api/pricing?provider=${encodeURIComponent(provider)}`,
    ),
  catalog: () =>
    request<{
      pricing: { present: boolean; fresh: boolean; fetchedAt?: string; ttlMs: number };
      leaderboard: {
        present: boolean;
        fresh: boolean;
        fetchedAt?: string;
        boards: string[];
        models: number;
        ttlMs: number;
      };
    }>("/api/catalog"),
  refreshCatalog: () =>
    request<{
      pricing: {
        models: number;
        fetchedAt: string;
        source: string;
        cached: boolean;
        error?: string;
      };
      leaderboard: {
        boards: number;
        models: number;
        fetchedAt: string;
        source: string;
        cached: boolean;
        error?: string;
      };
      status: {
        pricing: { present: boolean; fresh: boolean; fetchedAt?: string; ttlMs: number };
        leaderboard: {
          present: boolean;
          fresh: boolean;
          fetchedAt?: string;
          boards: string[];
          models: number;
          ttlMs: number;
        };
      };
    }>("/api/catalog/refresh", { method: "POST" }),
  stats: () => request<StatsResponse>("/api/stats"),
  update: () => request<UpdateResponse>("/api/update"),
  checkUpdate: () => request<UpdateResponse>("/api/update/check", { method: "POST" }),
  installUpdate: () => request<UpdateResponse>("/api/update/install", { method: "POST" }),
  clients: () => request<ClientsResponse>("/api/clients"),
  tunnel: () => request<TunnelResponse>("/api/tunnel"),
  saveTunnel: (payload: {
    enabled?: boolean;
    provider?: TunnelProviderView;
    command?: string;
    url?: string;
    publicPort?: number;
  }) =>
    request<TunnelResponse>("/api/tunnel", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  quota: (refresh = false) => request<QuotaResponse>(`/api/quota${refresh ? "?refresh=1" : ""}`),
  logs: (
    params: { limit?: number; phase?: string; model?: string; q?: string; before?: number } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.phase) query.set("phase", params.phase);
    if (params.model) query.set("model", params.model);
    if (params.q) query.set("q", params.q);
    if (params.before !== undefined) query.set("before", String(params.before));
    const suffix = query.toString();
    return request<LogPage>(`/api/logs${suffix ? `?${suffix}` : ""}`);
  },
  logSeries: (params: { minutes?: number; buckets?: number } & LogQuery = {}) => {
    const query = new URLSearchParams();
    if (params.minutes) query.set("minutes", String(params.minutes));
    if (params.buckets) query.set("buckets", String(params.buckets));
    if (params.phase) query.set("phase", params.phase);
    if (params.model) query.set("model", params.model);
    if (params.q) query.set("q", params.q);
    const suffix = query.toString();
    return request<LogSeries>(`/api/logs/series${suffix ? `?${suffix}` : ""}`);
  },
  logDetail: (id: string) => request<LogDetailResponse>(`/api/logs/${encodeURIComponent(id)}`),
  addBrain: (payload: Partial<BrainView> & { apiKey?: string }) =>
    request<{ brains: BrainView[]; brainChannels: BrainChannelView[] }>("/api/brains", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateBrain: (index: number, payload: Partial<BrainView> & { apiKey?: string }) =>
    request<{ brains: BrainView[]; brainChannels: BrainChannelView[] }>(`/api/brains/${index}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  deleteBrain: (index: number) =>
    request<{ brains: BrainView[]; brainChannels: BrainChannelView[] }>(`/api/brains/${index}`, {
      method: "DELETE",
    }),
  moveBrain: (index: number, direction: "up" | "down") =>
    request<{ brains: BrainView[]; brainChannels: BrainChannelView[] }>(
      `/api/brains/${index}/move`,
      { method: "POST", body: JSON.stringify({ direction }) },
    ),
  // Leave policy fields to server defaults or existing configuration.
  saveRouting: (payload: { routings: RoutingEntryView[]; quotaGuard?: Partial<QuotaGuardView> }) =>
    request<{
      routing: RoutingView;
      tiers: RoutingView["tiers"];
      routings: RoutingEntryView[];
    }>("/api/routing", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  testBrain: (payload?: Partial<BrainView> & { apiKey?: string }) =>
    request<{
      ok: boolean;
      error?: string;
      channel?: string;
      model?: string;
      /** Wall-clock time for the askJev round trip. */
      latencyMs?: number;
      verdict?: {
        model: string;
        confidence: number;
        probabilities?: Record<string, number>;
        effort?: string;
        effortProbabilities?: Record<string, number>;
      };
    }>("/api/brain/test", { method: "POST", body: JSON.stringify(payload ?? {}) }),
  addProvider: (payload: {
    name: string;
    type: string;
    baseUrl: string;
    apiKey?: string;
    apiKeyEnv?: string;
    auth?: ProviderAuthView;
    oauthSource?: string;
    billing?: ProviderBillingView;
    quota?: ProviderQuotaSpecView;
    models?: string[];
    /** `null` clears the override so the provider follows the OAuth-source default. */
    syncModels?: boolean | null;
    excludeModels?: string[];
  }) =>
    request<{ config: unknown }>("/api/providers", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteProvider: (name: string) =>
    request<{ config: unknown }>(`/api/providers/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  discover: (payload: {
    name?: string;
    type: string;
    baseUrl: string;
    apiKey?: string;
    auth?: ProviderAuthView;
    oauthSource?: string;
  }) =>
    request<{ models: string[]; error?: string }>("/api/providers/discover", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  modelSync: () => request<ModelSyncResponse>("/api/model-sync"),
  saveModelSync: (payload: { enabled?: boolean; intervalMinutes?: number }) =>
    request<ModelSyncResponse>("/api/model-sync", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  runModelSync: () => request<ModelSyncResponse>("/api/model-sync/run", { method: "POST" }),
  createKey: (name: string, limitUsd?: number | null) =>
    request<{ key: string; record: KeyView }>("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name, limitUsd }),
    }),
  updateKey: (id: string, patch: { name?: string; limitUsd?: number | null }) =>
    request<{ key: KeyView; keys: KeyView[] }>(`/api/keys/${id}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  revokeKey: (id: string) => request<{ keys: KeyView[] }>(`/api/keys/${id}`, { method: "DELETE" }),
  activity: (params: { range?: ActivityTimeRangeView; keyId?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.range) query.set("range", params.range);
    if (params.keyId) query.set("keyId", params.keyId);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return request<ActivityReportView>(`/api/activity${suffix}`);
  },
};
