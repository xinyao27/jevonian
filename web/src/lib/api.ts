import type {
  OAuthSourceName,
  ProviderAuthName,
  ProviderBillingName,
  ProviderTypeName,
} from "./admin-types";

// The server's own vocabulary, type-only: a wire or sign-in source added on the server shows up
// here without a second hand-copied union to forget.
export type ProviderTypeView = ProviderTypeName;
export type ProviderAuthView = ProviderAuthName;
export type ProviderBillingView = ProviderBillingName;
export type OAuthSourceView = OAuthSourceName;

export interface ProviderQuotaSpecView {
  fiveHourUsd?: number;
  weeklyUsd?: number;
  monthlyUsd?: number;
}

/**
 * The local sign-in a provider reads, when it is not the agent's own — a second account of the
 * same agent on the same machine. Every field is optional; absent means the agent's own sign-in.
 */
export interface ProviderLoginView {
  /** Who this account belongs to, as the list shows it ("work", an email, …). */
  label?: string;
  /** Directory the agent keeps this sign-in in (`~/.claude-work`, `~/.codex-work`, …). */
  home?: string;
  /** Path to the credential file, in place of the one the source would read. */
  credentialsPath?: string;
  /** macOS keychain service the sign-in is stored under. */
  keychainService?: string;
  /** macOS keychain account the sign-in is stored under. */
  keychainAccount?: string;
}

export interface ProviderView {
  name: string;
  type: ProviderTypeView;
  baseUrl: string;
  apiKeyEnv?: string;
  auth?: ProviderAuthView;
  oauthSource?: OAuthSourceView;
  /** The local sign-in this provider reads; absent means the agent's own. */
  login?: ProviderLoginView;
  billing?: ProviderBillingView;
  quota?: ProviderQuotaSpecView;
  keySource: string;
  models: string[];
  /**
   * Explicit override. Absent: follow the default (sync only for the OAuth sources listed in
   * `StateResponse.modelSyncDefaultSources`).
   */
  syncModels?: boolean;
  /** Local / keyless server — requests and discovery run without a Bearer token. */
  noKey?: boolean;
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
  oauthSource?: OAuthSourceView;
  billing?: ProviderBillingView;
  /** Local / keyless servers — no API key is required. */
  noKey?: boolean;
  /** Newly added providers from this preset turn on background model sync. */
  syncModels?: boolean;
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

export interface BrainModelView {
  id: string;
  label: string;
  hint?: string;
}

export interface BrainChannelView {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  requiresBaseUrl?: boolean;
  requiresAccountId?: boolean;
  models?: BrainModelView[];
  hint?: string;
  keysUrl?: string;
}

export interface QuotaGuardView {
  enabled: boolean;
  lowPercent: number;
  /** Order candidates so the allowance that renews soonest is used first. */
  resetAware: boolean;
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
  /**
   * Models this routing uses while a schedule window is active, keyed by window id.
   * A window with no entry uses `models`.
   */
  windows?: Record<string, string[]>;
}

/** A daily time range in the schedule's time zone. `end` before `start` runs past midnight. */
export interface ScheduleWindowView {
  id: string;
  label: string;
  /** HH:MM, included. */
  start: string;
  /** HH:MM, excluded. */
  end: string;
}

export interface ScheduleView {
  /** IANA name such as Asia/Singapore. Empty means the machine running Jevonian. */
  timezone: string;
  windows: ScheduleWindowView[];
}

/** Which window applies right now, from the server's clock. */
export interface ScheduleStatusView {
  timezone: string;
  /** RFC 3339 in the schedule's time zone. */
  now: string;
  /** Id of the active window. Empty when no window applies. */
  active: string;
  activeLabel?: string;
  /** RFC 3339 time when the applicable window next changes. */
  nextChange?: string;
  /** Window id that applies after `nextChange`. Absent when none does. */
  nextActive?: string;
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
  /** Absent when no time windows are configured. */
  schedule?: ScheduleView;
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
  /** Canonical group key (vendor prefix / date suffix stripped). */
  model: string;
  /** Human-facing label — catalog display name, else dominant raw spelling. */
  label?: string;
  /** Raw wire ids folded into this row. */
  variants?: string[];
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
  installed: string;
  latest?: string;
  updateAvailable: boolean;
  restartRequired: boolean;
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

export interface TokenSaverConfigView {
  enabled: boolean;
  /** Path to the `rtk` binary, or `"rtk"` to resolve via PATH. */
  command: string;
  /** Per-call timeout before the original tool result is kept. */
  timeoutMs: number;
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
    tokenSaver?: TokenSaverConfigView;
    tunnel?: { enabled: boolean; provider: TunnelProviderView };
    lan?: LanConfigView & { port?: number; bindHost?: string; urls?: string[] };
  };
  tiers: { plan: string[]; execute: string[]; utility: string[]; chat: string[] };
  routings: RoutingEntryView[];
  /** Present only when a schedule is configured. */
  schedule?: ScheduleStatusView;
  /** Models each routing uses at this moment (the active window's lists applied). */
  effective?: Record<string, string[]>;
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
  /**
   * Usage convention of the serving wire: true when `promptTokens` already
   * excludes `cacheReadTokens` (Anthropic, Connect-RPC), false when it includes
   * them (OpenAI, Responses). Absent on rows written before the field existed.
   */
  exclusiveInput?: boolean;
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
  /** Estimated prompt tokens the tool-result saver removed before egress. */
  savedTokens?: number;
  /** Transient upstream failures retried before this turn was recorded. */
  retries?: number;
  /**
   * Every upstream attempt for this turn, in order. Absent on a clean turn, and on a row
   * written before tracing existed — which reads as "not recorded", never "0 attempts".
   */
  tries?: LogAttempt[];
  /** Quota or refusal failovers this turn took before it was served. */
  failovers?: number;
  /** Milliseconds from the request arriving to the first streamed content. */
  ttftMs?: number;
  error?: string;
  /** Jevonian key that authorized the request, or "local" / "unauthenticated". */
  keyId?: string;
  /** Key name captured at request time, so a revoked key still reads sensibly. */
  keyName?: string;
}

/** One upstream attempt for a turn: the first shot, a transient repeat, or a re-route. */
export interface LogAttempt {
  provider: string;
  model: string;
  cause: "initial" | "retry" | "failover";
  /** Epoch ms the attempt began, so the detail page can place it on a timeline. */
  startedAt?: number;
  status?: number;
  /** Wall-clock duration of the attempt. */
  ms?: number;
  /** Milliseconds from the turn starting to this attempt's first streamed content. */
  ttftMs?: number;
  /** Why the attempt failed: `quota`, `http-502`, `fetch: ECONNRESET`, `client-canceled`, … */
  fail?: string;
}

/**
 * What the client actually received for a turn, decoded from the provider's wire format.
 * Older records have no capture at all, so every consumer must treat this as optional.
 */
export interface CapturedResponse {
  wire: "openai" | "anthropic" | "responses";
  status: number;
  stream: boolean;
  /** Assistant visible text; may be empty. */
  text: string;
  /** Thinking text, when the wire exposes it. */
  reasoning?: string;
  /** Tool calls the model asked for; `arguments` is raw JSON text. */
  toolCalls?: Array<{ id?: string; name: string; arguments: string }>;
  /** Native finish reason from the wire. */
  finishReason?: string;
  /** Set when the turn failed. */
  error?: string;
  /** The capture was cut at a size cap. */
  truncated?: boolean;
}

export interface LogDetailResponse {
  record: LogRecord;
  body?: unknown;
  brainCalls: Array<{ record: LogRecord; body?: unknown }>;
}

/**
 * Filters shared by the list, the live stream, the header chart, and the facet
 * counts. Each list is repeatable on the wire: values within one group are
 * OR-ed, groups are AND-ed. `"all"` and empty entries are dropped before send.
 */
export interface LogFilterParams {
  phase?: string[];
  model?: string[];
  provider?: string[];
  /** Only "ok" and "error" carry meaning; the server ignores anything else. */
  status?: string[];
  /** Free-text match over model, provider, phase, session, reason, and effort. */
  q?: string;
  /** Exact, case-sensitive session id, for the session strip on the detail page. */
  session?: string;
}

/** @deprecated Use LogFilterParams; kept under the old name for callers. */
export type LogQuery = LogFilterParams;

export interface LogFacetValue {
  value: string;
  count: number;
}

/**
 * Grouped value counts for the filter rail. Each group's counts apply every
 * current filter except that group's own, so siblings stay visible while one
 * value is checked. `status` always lists both values, even at zero count.
 */
export interface LogFacets {
  total: number;
  groups: {
    status?: LogFacetValue[];
    phase?: LogFacetValue[];
    provider?: LogFacetValue[];
    model?: LogFacetValue[];
  };
}

/** Append one repeatable filter group; `"all"` and blank values are ignored. */
function appendFilterValues(query: URLSearchParams, name: string, values?: string[]): void {
  for (const raw of values ?? []) {
    const value = raw.trim();
    if (!value || value === "all") continue;
    query.append(name, value);
  }
}

/** Serialize the shared filter groups onto an outgoing query string. */
function appendLogFilters(query: URLSearchParams, params: LogFilterParams): void {
  appendFilterValues(query, "phase", params.phase);
  appendFilterValues(query, "model", params.model);
  appendFilterValues(query, "provider", params.provider);
  appendFilterValues(query, "status", params.status);
  if (params.q?.trim()) query.set("q", params.q.trim());
  if (params.session?.trim()) query.set("session", params.session.trim());
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
  /**
   * Share of this bucket's input tokens served from the prompt cache, or `null`
   * when the bucket has no token accounting. Same definition as `cacheHitRate`.
   */
  cacheCoverage: number | null;
}

export interface LogSeries {
  minutes: number;
  buckets: LogSeriesBucket[];
  /** Whole-window cache coverage, or `null` when the window has no accounting. */
  cacheCoverage?: number | null;
  /** Window totals behind `cacheCoverage`. */
  cacheReadTokens?: number;
  promptTokens?: number;
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
  /** Set when the window meters one model instead of the whole account. */
  model?: string;
}

export interface ProviderQuotaView {
  provider: string;
  resets?: { count: number; until?: string; each?: Array<{ expiresAt?: string }> };
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

export interface ModelQuotaHealthView {
  model: string;
  status: string;
  reason?: string;
  resetsAt?: string;
}

export interface QuotaHealthView {
  provider: string;
  billing?: ProviderBillingView;
  status: QuotaStatusView;
  modelHealth?: ModelQuotaHealthView[];
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

/**
 * Exposure of the authenticated `/v1` surface on the local network, so another machine —
 * or another Jevonian — can use this instance as a provider. The dashboard and `/api` are
 * never served on the LAN address.
 */
export interface LanConfigView {
  enabled: boolean;
  /** Interface bound; `0.0.0.0` means every interface. */
  host?: string;
  /** Port the LAN surface listens on. */
  port?: number;
}

export interface LanResponse {
  config: LanConfigView;
  /** Resolved port (defaults to `listen.port + 2`). */
  port: number;
  bindHost: string;
  /** Base URLs a peer can paste into its own Jevonian provider config. */
  urls: string[];
  /** True when the change only takes effect after a restart. */
  restartRequired?: boolean;
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
  /** Estimated prompt tokens the tool-result saver kept out of upstream calls. */
  savedTokens: number;
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
  lan: () => request<LanResponse>("/api/lan"),
  saveLan: (payload: { enabled?: boolean; host?: string; port?: number }) =>
    request<LanResponse>("/api/lan", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  quota: (refresh = false) => request<QuotaResponse>(`/api/quota${refresh ? "?refresh=1" : ""}`),
  resetQuota: (provider: string) =>
    request<{ ok: boolean }>("/api/quota/reset", {
      method: "POST",
      body: JSON.stringify({ provider }),
    }),
  logs: (params: { limit?: number; before?: number } & LogFilterParams = {}) => {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.before !== undefined) query.set("before", String(params.before));
    appendLogFilters(query, params);
    const suffix = query.toString();
    return request<LogPage>(`/api/logs${suffix ? `?${suffix}` : ""}`);
  },
  logSeries: (params: { minutes?: number; buckets?: number } & LogFilterParams = {}) => {
    const query = new URLSearchParams();
    if (params.minutes) query.set("minutes", String(params.minutes));
    if (params.buckets) query.set("buckets", String(params.buckets));
    appendLogFilters(query, params);
    const suffix = query.toString();
    return request<LogSeries>(`/api/logs/series${suffix ? `?${suffix}` : ""}`);
  },
  logFacets: (params: LogFilterParams & { minutes?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.minutes) query.set("minutes", String(params.minutes));
    appendLogFilters(query, params);
    const suffix = query.toString();
    return request<LogFacets>(`/api/logs/facets${suffix ? `?${suffix}` : ""}`);
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
  // `schedule: null` removes the schedule; leaving it out keeps the current one.
  saveRouting: (payload: {
    routings: RoutingEntryView[];
    quotaGuard?: Partial<QuotaGuardView>;
    schedule?: ScheduleView | null;
  }) =>
    request<{
      routing: RoutingView;
      tiers: RoutingView["tiers"];
      routings: RoutingEntryView[];
      schedule?: ScheduleStatusView;
      effective?: Record<string, string[]>;
    }>("/api/routing", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  /** Light refresh of the active window and per-routing models; the clock moves, config does not. */
  routingNow: () =>
    request<{
      routings: RoutingEntryView[];
      schedule?: ScheduleStatusView;
      effective?: Record<string, string[]>;
    }>("/api/tiers"),
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
    oauthSource?: OAuthSourceView;
    /** `null` clears the local sign-in so the provider reads the agent's own again. */
    login?: ProviderLoginView | null;
    billing?: ProviderBillingView;
    quota?: ProviderQuotaSpecView;
    models?: string[];
    /** `null` clears the override so the provider follows the OAuth-source / preset default. */
    syncModels?: boolean | null;
    /** Local / keyless server (Ollama, LM Studio). */
    noKey?: boolean;
    excludeModels?: string[];
  }) =>
    request<{ config: unknown; signedInAs?: string }>("/api/providers", {
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
    oauthSource?: OAuthSourceView;
    noKey?: boolean;
    login?: ProviderLoginView | null;
  }) =>
    request<{ models: string[]; error?: string; signedInAs?: string }>("/api/providers/discover", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  /** Opens WorkBuddy AI browser sign-in and stores the session. */
  signInWorkbuddyAi: (payload?: { login?: ProviderLoginView | null }) =>
    request<{ ok: boolean; user?: string }>("/api/oauth/workbuddy-ai/signin", {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }),
  saveTokenSaver: (payload: Partial<TokenSaverConfigView>) =>
    request<{ tokenSaver: TokenSaverConfigView }>("/api/token-saver", {
      method: "PUT",
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
