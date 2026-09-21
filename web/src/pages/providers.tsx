import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BrainSection } from "@/components/brain-section";
import { KeysHelp } from "@/components/keys-help";
import { ProviderLogo } from "@/components/provider-logo";
import { QuotaGrid } from "@/components/quota-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  api,
  type PresetView,
  type PriceInfo,
  type ProviderAuthView,
  type ProviderBillingView,
  type ProviderQuotaView,
  type ProviderTypeView,
  type QuotaHealthView,
  type StateResponse,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const CUSTOM_PRESET: PresetView = {
  id: "custom",
  name: "Custom",
  type: "openai",
  baseUrl: "",
  hint: "",
};

const AUTO_SELECT_LIMIT = 30;

function numberOrUndefined(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function ProvidersPage() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [quotas, setQuotas] = useState<ProviderQuotaView[]>([]);
  const [health, setHealth] = useState<QuotaHealthView[]>([]);
  const [presetId, setPresetId] = useState("deepseek");
  const [name, setName] = useState("deepseek");
  const [type, setType] = useState("openai");
  const [auth, setAuth] = useState<ProviderAuthView>("api-key");
  const [oauthSource, setOauthSource] = useState("claude-code");
  const [billing, setBilling] = useState<ProviderBillingView>("api");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [quotaFiveHour, setQuotaFiveHour] = useState("");
  const [quotaWeekly, setQuotaWeekly] = useState("");
  const [quotaMonthly, setQuotaMonthly] = useState("");
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [prices, setPrices] = useState<Record<string, PriceInfo>>({});
  const [filter, setFilter] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const initialized = useRef(false);

  const allPresets = useMemo<PresetView[]>(
    () => [...(state?.presets ?? []), CUSTOM_PRESET],
    [state],
  );
  const presets = useMemo<PresetView[]>(
    () => allPresets.filter((preset) => preset.id !== "custom"),
    [allPresets],
  );
  const activePreset = useMemo(
    () => allPresets.find((preset) => preset.id === presetId),
    [allPresets, presetId],
  );
  /** Preset used for docs links — keeps working when editing (forced to custom). */
  const helpPreset = useMemo(() => {
    if (presetId !== "custom" && activePreset && activePreset.id !== "custom") {
      return activePreset;
    }
    const byId = presets.find((preset) => preset.id === name);
    if (byId) return byId;
    const normalized = baseUrl.replace(/\/+$/, "");
    return presets.find((preset) => preset.baseUrl.replace(/\/+$/, "") === normalized);
  }, [presetId, activePreset, presets, name, baseUrl]);

  const load = useCallback(async () => {
    try {
      const [nextState, nextQuotas] = await Promise.all([api.state(), api.quota()]);
      setState(nextState);
      setQuotas(nextQuotas.quotas);
      setHealth(nextQuotas.health);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const applyPreset = useCallback((preset: PresetView | undefined) => {
    if (!preset) return;
    setPresetId(preset.id);
    setName(preset.id === "custom" ? "" : preset.id);
    setType(preset.type);
    setAuth(preset.auth ?? "api-key");
    setOauthSource(preset.oauthSource ?? "claude-code");
    setBilling(preset.billing ?? "api");
    setBaseUrl(preset.baseUrl);
    setApiKey("");
    setApiKeyEnv(preset.apiKeyEnv ?? "");
    setQuotaFiveHour("");
    setQuotaWeekly("");
    setQuotaMonthly("");
    setDiscovered([]);
    setSelected([]);
    setFilter("");
    setCustomModel("");
    setEditing(null);
    setMessage("");
    setError("");
  }, []);

  useEffect(() => {
    if (initialized.current || !state) return;
    initialized.current = true;
    applyPreset(allPresets.find((preset) => preset.id === "deepseek") ?? allPresets[0]);
  }, [state, allPresets, applyPreset]);

  const loadPrices = useCallback(async (provider: string) => {
    if (!provider || provider === "custom") {
      setPrices({});
      return;
    }
    try {
      const result = await api.prices(provider);
      setPrices(result.prices);
    } catch {
      setPrices({});
    }
  }, []);

  useEffect(() => {
    void loadPrices(presetId);
  }, [presetId, loadPrices]);

  const visibleModels = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return discovered;
    return discovered.filter((model) => model.toLowerCase().includes(needle));
  }, [discovered, filter]);

  const extraSelected = useMemo(
    () => selected.filter((model) => !discovered.includes(model)),
    [selected, discovered],
  );

  function resetForm(id = "deepseek") {
    applyPreset(allPresets.find((item) => item.id === id) ?? allPresets[0]);
  }

  function choosePreset(preset: PresetView) {
    if (preset.id === presetId) return;
    if (
      !window.confirm(
        "Switch provider preset? This replaces the current form, including credentials, advanced settings, and selected models. Saved providers are not changed.",
      )
    )
      return;
    applyPreset(preset);
  }

  const lockedType: ProviderTypeView | undefined =
    auth === "oauth" && oauthSource === "claude-code"
      ? "anthropic"
      : auth === "oauth" && oauthSource === "codex"
        ? "responses"
        : auth === "oauth" && oauthSource === "antigravity"
          ? "gemini"
          : undefined;
  const effectiveType = lockedType ?? type;

  async function discover() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api.discover({
        name,
        type: effectiveType,
        baseUrl,
        apiKey,
        auth,
        oauthSource,
      });
      if (result.error) setError(result.error);
      setDiscovered(result.models);
      if (result.models.length > 0 && result.models.length <= AUTO_SELECT_LIMIT) {
        setSelected((current) => [...new Set([...current, ...result.models])]);
      }
      if (!prices || Object.keys(prices).length === 0) void loadPrices(presetId);
      setMessage(`Discovered ${result.models.length} models`);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  function toggleModel(model: string) {
    setSelected((current) =>
      current.includes(model) ? current.filter((item) => item !== model) : [...current, model],
    );
  }

  function addCustomModel() {
    const value = customModel.trim();
    if (!value) return;
    setSelected((current) => (current.includes(value) ? current : [...current, value]));
    setCustomModel("");
  }

  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const quota = {
        ...(numberOrUndefined(quotaFiveHour)
          ? { fiveHourUsd: numberOrUndefined(quotaFiveHour) }
          : {}),
        ...(numberOrUndefined(quotaWeekly) ? { weeklyUsd: numberOrUndefined(quotaWeekly) } : {}),
        ...(numberOrUndefined(quotaMonthly) ? { monthlyUsd: numberOrUndefined(quotaMonthly) } : {}),
      };
      await api.addProvider({
        name,
        type: effectiveType,
        baseUrl,
        apiKey: apiKey || undefined,
        apiKeyEnv: apiKeyEnv || undefined,
        auth,
        oauthSource: auth === "oauth" ? oauthSource : undefined,
        billing,
        quota: Object.keys(quota).length > 0 ? quota : undefined,
        models: selected,
      });
      setMessage(`Saved provider "${name}"`);
      resetForm(presetId);
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(providerName: string) {
    if (
      !window.confirm(
        `Remove provider "${providerName}"? Stored credentials for it are deleted. This cannot be undone.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api.deleteProvider(providerName);
      if (editing === providerName) resetForm();
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function refreshQuota() {
    setBusy(true);
    try {
      const result = await api.quota(true);
      setQuotas(result.quotas);
      setHealth(result.health);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  function edit(provider: {
    name: string;
    type: string;
    baseUrl: string;
    apiKeyEnv?: string;
    auth?: ProviderAuthView;
    oauthSource?: string;
    billing?: ProviderBillingView;
    quota?: { fiveHourUsd?: number; weeklyUsd?: number; monthlyUsd?: number };
    models: string[];
  }) {
    setPresetId("custom");
    setName(provider.name);
    setType(provider.type);
    setAuth(provider.auth ?? "api-key");
    setOauthSource(provider.oauthSource ?? "claude-code");
    setBilling(provider.billing ?? "api");
    setBaseUrl(provider.baseUrl);
    setApiKey("");
    setApiKeyEnv(provider.apiKeyEnv ?? "");
    setQuotaFiveHour(provider.quota?.fiveHourUsd ? String(provider.quota.fiveHourUsd) : "");
    setQuotaWeekly(provider.quota?.weeklyUsd ? String(provider.quota.weeklyUsd) : "");
    setQuotaMonthly(provider.quota?.monthlyUsd ? String(provider.quota.monthlyUsd) : "");
    setDiscovered([]);
    setSelected(provider.models);
    setEditing(provider.name);
    setFormOpen(true);
    setMessage("");
    setError("");
  }

  function beginAdd() {
    resetForm();
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    resetForm();
  }

  const priceLabel = (model: string) => {
    const price = prices[model];
    return price ? `$${price.input}/$${price.output} per M` : "";
  };

  const needsApiKey = auth === "api-key" || oauthSource === "static";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Providers</h1>
        <p className="text-sm text-muted-foreground">
          Connect API providers, subscription endpoints, and local agent credentials. Secrets stay
          on this machine.
        </p>
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <CardTitle>Configured providers</CardTitle>
            <CardDescription>{state?.config.providers.length ?? 0} providers</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={beginAdd} disabled={busy}>
            Add provider
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>provider</TableHead>
                <TableHead>protocol</TableHead>
                <TableHead>billing</TableHead>
                <TableHead>credential</TableHead>
                <TableHead>models</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(state?.config.providers ?? []).map((provider) => (
                <TableRow key={provider.name}>
                  <TableCell>
                    <span className="flex items-center gap-2 font-medium">
                      <ProviderLogo id={provider.name} />
                      <span className="flex flex-col">
                        <span>{provider.name}</span>
                        <span className="max-w-[280px] truncate text-[11px] font-normal text-muted-foreground">
                          {provider.baseUrl}
                        </span>
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>{provider.type}</TableCell>
                  <TableCell>
                    <Badge variant={provider.billing === "subscription" ? "default" : "secondary"}>
                      {provider.billing ?? "api"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={provider.keySource === "none" ? "destructive" : "secondary"}>
                      {provider.keySource}
                    </Badge>
                  </TableCell>
                  <TableCell>{provider.models.length}</TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => edit(provider)}
                      disabled={busy}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void remove(provider.name)}
                      disabled={busy}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(state?.config.providers.length ?? 0) === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-sm text-muted-foreground">
                    No providers yet — choose Add provider to connect one.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">Usage &amp; limits</h2>
          <p className="text-sm text-muted-foreground">
            Subscription windows, reset times, and local spend per provider. Estimates use
            models.dev rates.
          </p>
        </div>
        <QuotaGrid quotas={quotas} health={health} bare />
        <div>
          <Button variant="outline" size="sm" onClick={() => void refreshQuota()} disabled={busy}>
            Refresh quota
          </Button>
        </div>
      </section>

      {state ? <BrainSection state={state} onSaved={setState} /> : null}

      {formOpen ? (
        <Card
          ref={(node) => {
            // The form mounts at the bottom of the page; bring it into view or the
            // "Add provider" click appears to do nothing on a long page.
            node?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <CardTitle>{editing ? `Edit provider "${editing}"` : "Add provider"}</CardTitle>
              <CardDescription>
                {presetId === "custom"
                  ? "Choose the endpoint and protocol first, then authenticate and pick models."
                  : "Pick a preset, choose how it authenticates, then select models."}
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={closeForm} disabled={busy}>
              Close
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => choosePreset(preset)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted",
                    presetId === preset.id && "border-primary bg-muted",
                  )}
                >
                  <ProviderLogo id={preset.id} />
                  <span className="flex min-w-0 flex-col">
                    <span className="leading-tight">{preset.name}</span>
                    {preset.billing === "subscription" ? (
                      <span className="text-[10px] text-muted-foreground">subscription</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => choosePreset(CUSTOM_PRESET)}
              className="self-start text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Add a custom provider
            </button>

            {presetId === "custom" ? (
              <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    value={name}
                    placeholder="my-provider"
                    onChange={(event) => setName(event.target.value)}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Used in routing rules and the provider list.
                  </span>
                </div>
                <div className="col-span-2 flex flex-col gap-1.5 xl:col-span-1">
                  <Label htmlFor="baseUrl">Base URL</Label>
                  <Input
                    id="baseUrl"
                    value={baseUrl}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Where requests are sent from this machine.
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="type">Protocol</Label>
                  <Select
                    value={effectiveType}
                    onValueChange={(value) => setType(String(value))}
                    disabled={lockedType !== undefined}
                  >
                    <SelectTrigger id="type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">openai (chat/completions)</SelectItem>
                      <SelectItem value="anthropic">anthropic (messages)</SelectItem>
                      <SelectItem value="both">both — openai + anthropic</SelectItem>
                      <SelectItem value="responses">responses</SelectItem>
                      <SelectItem value="gemini">gemini — cloud code (Antigravity)</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-[11px] text-muted-foreground">
                    {lockedType
                      ? `Set by the ${oauthSource === "codex" ? "Codex" : "Claude Code"} credential source.`
                      : "Wire format the endpoint expects."}
                  </span>
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-2 rounded-md border p-3">
              <p className="text-sm font-medium">Credential</p>
              <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="auth">Auth</Label>
                  <Select
                    value={auth}
                    onValueChange={(value) => setAuth(value as ProviderAuthView)}
                  >
                    <SelectTrigger id="auth" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="api-key">api key</SelectItem>
                      <SelectItem value="oauth">oauth (subscription)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {auth === "oauth" ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="oauthSource">Credential source</Label>
                    <Select
                      value={oauthSource}
                      onValueChange={(value) => setOauthSource(String(value))}
                    >
                      <SelectTrigger id="oauthSource" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="claude-code">Claude Code (~/.claude)</SelectItem>
                        <SelectItem value="codex">Codex (~/.codex)</SelectItem>
                        <SelectItem value="antigravity">Antigravity (~/.gemini)</SelectItem>
                        <SelectItem value="static">stored token</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {needsApiKey ? (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="apiKey">API key</Label>
                      <Input
                        id="apiKey"
                        type="password"
                        placeholder={
                          editing
                            ? "leave empty to keep the stored key"
                            : "stored in credentials.json (0600)"
                        }
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="apiKeyEnv">or env var</Label>
                      <Input
                        id="apiKeyEnv"
                        placeholder="DEEPSEEK_API_KEY"
                        value={apiKeyEnv}
                        onChange={(event) => setApiKeyEnv(event.target.value)}
                      />
                    </div>
                  </>
                ) : (
                  <p className="col-span-2 self-end text-xs text-muted-foreground xl:col-span-1">
                    {oauthSource === "claude-code"
                      ? "Uses the OAuth token from Claude Code; run `claude` to sign in or refresh."
                      : oauthSource === "codex"
                        ? "Uses the OAuth token from Codex; run `codex` to sign in or refresh."
                        : "Uses the Antigravity token from `agy` / the IDE; run it to sign in or refresh."}
                  </p>
                )}
              </div>
              <KeysHelp
                keysUrl={helpPreset?.keysUrl}
                hint={helpPreset?.hint}
                linkLabel={auth === "oauth" ? "How to sign in" : "Get an API key"}
              />
              <span className="text-[11px] text-muted-foreground">
                Secrets stay on this machine; a blank API key keeps the stored value when editing.
              </span>
            </div>

            <div className="flex flex-col gap-3 rounded-md border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Models</p>
                  <p className="text-xs text-muted-foreground">
                    {selected.length} selected
                    {discovered.length > 0 ? ` · ${discovered.length} discovered` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {discovered.length > 0 ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setSelected(discovered)}>
                        Select all
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                        Clear
                      </Button>
                    </>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void discover()}
                    disabled={busy || !baseUrl}
                  >
                    Discover models
                  </Button>
                </div>
              </div>

              {extraSelected.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {extraSelected.map((model) => (
                    <Badge key={model} variant="outline" className="gap-1">
                      {model}
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => toggleModel(model)}
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : null}

              {discovered.length > 12 ? (
                <Input
                  placeholder="Filter models…"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              ) : null}

              {visibleModels.length > 0 ? (
                <div className="max-h-64 overflow-auto rounded-md border">
                  {visibleModels.map((model) => (
                    <label
                      key={model}
                      className="flex cursor-pointer items-center gap-3 border-b px-3 py-1.5 text-sm last:border-b-0 hover:bg-muted"
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(model)}
                        onChange={() => toggleModel(model)}
                      />
                      <span className="flex-1 truncate">{model}</span>
                      <span className="text-xs text-muted-foreground">{priceLabel(model)}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {discovered.length > 0
                    ? "No models match the filter."
                    : "No models yet — run Discover, or add a model id below."}
                </p>
              )}

              <div className="flex items-center gap-2">
                <Input
                  placeholder="add model id manually"
                  value={customModel}
                  onChange={(event) => setCustomModel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addCustomModel();
                  }}
                />
                <Button variant="outline" onClick={addCustomModel} disabled={!customModel.trim()}>
                  Add
                </Button>
              </div>
            </div>

            {billing === "subscription" ? (
              <div className="flex flex-col gap-3 rounded-md border p-4">
                <div>
                  <p className="text-sm font-medium">Quota caps</p>
                  <p className="text-xs text-muted-foreground">
                    Optional local spend caps for this provider; refresh usage from the quota
                    section above.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="quotaFiveHour">5h cap (USD, optional)</Label>
                    <Input
                      id="quotaFiveHour"
                      value={quotaFiveHour}
                      onChange={(event) => setQuotaFiveHour(event.target.value)}
                      placeholder="12"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="quotaWeekly">weekly cap (USD, optional)</Label>
                    <Input
                      id="quotaWeekly"
                      value={quotaWeekly}
                      onChange={(event) => setQuotaWeekly(event.target.value)}
                      placeholder="30"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="quotaMonthly">monthly cap (USD, optional)</Label>
                    <Input
                      id="quotaMonthly"
                      value={quotaMonthly}
                      onChange={(event) => setQuotaMonthly(event.target.value)}
                      placeholder="60"
                    />
                  </div>
                </div>
              </div>
            ) : null}

            <details className="rounded-md border">
              <summary className="cursor-pointer select-none px-4 py-2 text-sm font-medium">
                Advanced settings
              </summary>
              <div className="flex flex-col gap-4 border-t p-4">
                <p className="text-xs text-muted-foreground">
                  {presetId === "custom"
                    ? "Provider name, endpoint protocol, billing mode, and extra capability flags."
                    : "Fine-tune how this provider is addressed; the preset already fills sensible defaults."}
                </p>
                <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="name">Provider name</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                    <span className="text-[11px] text-muted-foreground">
                      Key used in routing rules and the provider list.
                    </span>
                  </div>
                  <div className="col-span-2 flex flex-col gap-1.5 xl:col-span-1">
                    <Label htmlFor="baseUrl">Base URL</Label>
                    <Input
                      id="baseUrl"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                    />
                    <span className="text-[11px] text-muted-foreground">
                      Preset default — change only for proxies or self-hosted endpoints.
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="type">Protocol</Label>
                    <Select
                      value={effectiveType}
                      onValueChange={(value) => setType(String(value))}
                      disabled={lockedType !== undefined}
                    >
                      <SelectTrigger id="type" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="openai">openai (chat/completions)</SelectItem>
                        <SelectItem value="anthropic">anthropic (messages)</SelectItem>
                        <SelectItem value="both">both — openai + anthropic</SelectItem>
                        <SelectItem value="responses">responses</SelectItem>
                        <SelectItem value="gemini">gemini — cloud code (Antigravity)</SelectItem>
                      </SelectContent>
                    </Select>
                    {lockedType ? (
                      <span className="text-[11px] text-muted-foreground">
                        Set by the {oauthSource === "codex" ? "Codex" : "Claude Code"} credential
                        source.
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="billing">Billing</Label>
                    <Select
                      value={billing}
                      onValueChange={(value) => setBilling(value as ProviderBillingView)}
                    >
                      <SelectTrigger id="billing" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="api">api (pay per token)</SelectItem>
                        <SelectItem value="subscription">subscription</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="text-[11px] text-muted-foreground">
                      Subscription unlocks optional quota caps below.
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="authAdvanced">Auth</Label>
                    <Select
                      value={auth}
                      onValueChange={(value) => setAuth(value as ProviderAuthView)}
                    >
                      <SelectTrigger id="authAdvanced" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="api-key">api key</SelectItem>
                        <SelectItem value="oauth">oauth (subscription)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {auth === "oauth" ? (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="oauthSourceAdvanced">Credential source</Label>
                      <Select
                        value={oauthSource}
                        onValueChange={(value) => setOauthSource(String(value))}
                      >
                        <SelectTrigger id="oauthSourceAdvanced" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="claude-code">Claude Code (~/.claude)</SelectItem>
                          <SelectItem value="codex">Codex (~/.codex)</SelectItem>
                          <SelectItem value="antigravity">Antigravity (~/.gemini)</SelectItem>
                          <SelectItem value="static">stored token</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="apiKeyEnvAdvanced">API key env var</Label>
                    <Input
                      id="apiKeyEnvAdvanced"
                      placeholder="DEEPSEEK_API_KEY"
                      value={apiKeyEnv}
                      onChange={(event) => setApiKeyEnv(event.target.value)}
                    />
                    <span className="text-[11px] text-muted-foreground">
                      Read from this machine&apos;s environment when set.
                    </span>
                  </div>
                </div>
              </div>
            </details>

            <div className="flex items-center gap-3">
              <Button
                onClick={() => void save()}
                disabled={busy || !name || !baseUrl || selected.length === 0}
              >
                {editing ? "Update provider" : "Save provider"}
              </Button>
              {editing ? (
                <Button variant="ghost" onClick={closeForm} disabled={busy}>
                  Cancel
                </Button>
              ) : null}
              {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
              {error ? <span className="text-xs text-destructive">{error}</span> : null}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
