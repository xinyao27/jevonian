import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { OverviewSkeleton } from "@/components/page-skeletons";
import { QuotaGrid } from "@/components/quota-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  api,
  type ProviderQuotaView,
  type QuotaHealthView,
  type StateResponse,
  type StatsResponse,
  type TunnelProviderView,
  type TunnelStatusView,
  type UpdateResponse,
} from "@/lib/api";
import { money, percent } from "@/lib/utils";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      {hint ? (
        <CardContent>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}

function Panel({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <details className="rounded-lg border bg-card p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        {title} <span className="font-normal text-muted-foreground">· {summary}</span>
      </summary>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </details>
  );
}

type TunnelDraft = { provider: TunnelProviderView; command: string; url: string };

export function OverviewPage() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [quotas, setQuotas] = useState<ProviderQuotaView[]>([]);
  const [health, setHealth] = useState<QuotaHealthView[]>([]);
  const [tunnel, setTunnel] = useState<TunnelStatusView | null>(null);
  const [tunnelProvider, setTunnelProvider] = useState<TunnelProviderView>("cloudflare");
  const [tunnelCommand, setTunnelCommand] = useState("");
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelError, setTunnelError] = useState("");
  const [update, setUpdate] = useState<UpdateResponse | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  // True while the local draft differs from what the server last reported. Polling
  // must not overwrite typed input, otherwise a 10s refresh destroys a draft.
  const draftDirty = useRef(false);
  const [draftUnsaved, setDraftUnsaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nextState, nextStats, nextQuotas, nextTunnel, nextUpdate] = await Promise.all([
        api.state(),
        api.stats(),
        api.quota(),
        api.tunnel(),
        api.update(),
      ]);
      setState(nextState);
      setStats(nextStats);
      setQuotas(nextQuotas.quotas);
      setHealth(nextQuotas.health);
      setTunnel(nextTunnel.tunnel);
      setUpdate(nextUpdate);
      if (!draftDirty.current) {
        setTunnelProvider(nextTunnel.config.provider);
        setTunnelCommand(nextTunnel.config.command ?? "");
        setTunnelUrl(nextTunnel.config.url ?? "");
      }
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  function currentDraft(): TunnelDraft {
    return { provider: tunnelProvider, command: tunnelCommand, url: tunnelUrl };
  }

  function editDraft(patch: Partial<TunnelDraft>): void {
    draftDirty.current = true;
    setDraftUnsaved(true);
    if (patch.provider !== undefined) setTunnelProvider(patch.provider);
    if (patch.command !== undefined) setTunnelCommand(patch.command);
    if (patch.url !== undefined) setTunnelUrl(patch.url);
  }

  async function toggleTunnel(): Promise<void> {
    setTunnelBusy(true);
    setTunnelError("");
    try {
      const draft = currentDraft();
      const response = await api.saveTunnel({
        enabled: tunnel?.status !== "on",
        provider: draft.provider,
        ...(draft.provider === "custom" ? { command: draft.command } : {}),
        // ngrok: optional reserved domain; custom: stable URL; cloudflare: clear any leftover
        url: draft.provider === "ngrok" || draft.provider === "custom" ? draft.url.trim() : "",
      });
      setTunnel(response.tunnel);
      if (response.error) setTunnelError(response.error);
      draftDirty.current = false;
      setDraftUnsaved(false);
      void load();
    } catch (cause) {
      setTunnelError(String(cause));
    } finally {
      setTunnelBusy(false);
    }
  }

  async function installUpdate(): Promise<void> {
    setUpdateBusy(true);
    setUpdateError("");
    try {
      setUpdate(await api.installUpdate());
    } catch (cause) {
      setUpdateError(String(cause));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function checkUpdate(): Promise<void> {
    setUpdateBusy(true);
    setUpdateError("");
    try {
      setUpdate(await api.checkUpdate());
    } catch (cause) {
      setUpdateError(String(cause));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function copy(value: string, id: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      setTimeout(() => setCopied((current) => (current === id ? "" : current)), 1_500);
    } catch {
      setTunnelError("Clipboard is unavailable.");
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!state || !stats) return <OverviewSkeleton />;

  const localUrl = `http://${state.config.listen.host}:${state.config.listen.port}/v1`;
  const publicUrl = tunnel?.status === "on" && tunnel.url ? `${tunnel.url}/v1` : undefined;
  const authed = state.keys.length > 0;
  const curl = (base: string) =>
    `curl ${base}/chat/completions \\
  -H "authorization: Bearer <key>" \\
  -H "content-type: application/json" \\
  -d '{"model":"jevonian/auto","messages":[{"role":"user","content":"hi"}]}'`;

  const apiSpendHint =
    stats.apiUsd > 0
      ? `pay-per-token estimate · ${money(stats.apiUsd)} api${
          stats.brainUsd > 0
            ? ` (${money(stats.brainUsd)} brain · ${stats.brainRequests} calls)`
            : ""
        }`
      : "no pay-per-token calls logged yet";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Point any agent at the endpoint below with an API key from the Keys page.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Agent endpoints</CardTitle>
          <CardDescription>
            {authed
              ? "Both endpoints speak OpenAI and Anthropic protocols; every request needs a Jevonian key."
              : "OpenAI- and Anthropic-compatible. No keys exist yet, so requests are accepted without authentication — create one on the Keys page."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">local</Badge>
              <span className="text-xs text-muted-foreground">
                on this machine — no tunnel, nothing published
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded-md bg-muted px-3 py-2 text-sm">{localUrl}</code>
              <Button variant="outline" size="sm" onClick={() => void copy(localUrl, "local")}>
                {copied === "local" ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Agents running locally (Cursor, CLI) can use this URL directly. It is not reachable
              from other machines.
            </p>
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                curl example
              </summary>
              <pre className="mt-2 overflow-auto rounded-md bg-muted p-3 text-xs">
                {curl(localUrl)}
              </pre>
            </details>
          </div>

          <div className="flex flex-col gap-2 border-t pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={publicUrl ? "default" : "outline"}>
                public{publicUrl ? "" : " · off"}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {publicUrl
                  ? `tunneled via ${tunnel?.provider} — kept across restarts until you stop it`
                  : "explicit opt-in: nobody can reach this machine until you start a tunnel"}
              </span>
            </div>
            {publicUrl ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-md bg-muted px-3 py-2 text-sm">{publicUrl}</code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void copy(publicUrl, "public")}
                  >
                    {copied === "public" ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Only <code>/v1</code> is exposed and every request must carry a Jevonian API key.
                  {tunnel?.startedAt
                    ? ` Up since ${new Date(tunnel.startedAt).toLocaleTimeString()}.`
                    : ""}
                </p>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    curl example
                  </summary>
                  <pre className="mt-2 overflow-auto rounded-md bg-muted p-3 text-xs">
                    {curl(publicUrl)}
                  </pre>
                </details>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Start a tunnel under “Public tunnel” below to get a public URL. Until then the local
                URL above is the only endpoint.
              </p>
            )}
          </div>

          <details className="border-t pt-4">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Advanced: virtual models
            </summary>
            <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
              <p>
                <code>jevonian/auto</code> is recommended: Jevonian picks a model per conversation
                phase and sticks to it while the prompt cache stays warm.
              </p>
              <p>
                <code>jevonian/plan</code>, <code>jevonian/execute</code>,{" "}
                <code>jevonian/utility</code>, and <code>jevonian/chat</code> force a single tier. A
                real model id (for example <code>claude-sonnet-4</code>) is passed through
                untouched, so provider-native ids keep working.
              </p>
              <p>
                Tier configuration lives on the Routing page; tier mappings are listed under “Model
                routing” below.
              </p>
            </div>
          </details>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Requests" value={String(stats.requests)} hint={`${stats.sessions} sessions`} />
        <Stat label="Spend · API estimate" value={money(stats.apiUsd)} hint={apiSpendHint} />
        <Stat
          label="Spend · subscription value"
          value={money(stats.subscriptionUsd)}
          hint={
            stats.subscriptionRequests > 0
              ? `${stats.subscriptionRequests} calls on subscription plans · equivalent pay-per-token value, not billed`
              : "no subscription calls logged yet"
          }
        />
        <Stat
          label="Cached input"
          value={percent(stats.cacheHitRate)}
          hint="share of prompt tokens served from cache"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Usage & limits</CardTitle>
          <CardDescription>
            Remaining quota and reset time per provider. Open a provider for source, note, and
            window-by-window detail.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <QuotaGrid quotas={quotas} health={health} bare />
          <details className="border-t pt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Savings and baseline
            </summary>
            <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
              {stats.apiBaselineUsd > 0 ? (
                <>
                  <p className="text-foreground">
                    {stats.savingsPct.toFixed(1)}% lower on pay-per-token traffic (
                    {money(stats.savingsUsd)} saved) against baseline model{" "}
                    <code>{stats.baselineModel ?? "unknown"}</code>.
                  </p>
                  <p>
                    Baseline: the same tokens priced at{" "}
                    <code>{stats.baselineModel ?? "the configured baseline"}</code> (
                    {money(stats.apiBaselineUsd)} estimated) instead of what was actually paid (
                    {money(stats.apiUsd)}).
                  </p>
                  {stats.subscriptionBaselineUsd > 0 ? (
                    <p>
                      Separately, {money(stats.subscriptionBaselineUsd)} of baseline usage ran on
                      subscription plans and is excluded from the savings figure. Recent-window
                      spend per provider is listed on the Providers page.
                    </p>
                  ) : null}
                </>
              ) : (
                <p>
                  No pay-per-token traffic yet
                  {stats.subscriptionBaselineUsd > 0
                    ? `; ${money(stats.subscriptionBaselineUsd)} of baseline usage ran on subscription plans.`
                    : "."}
                </p>
              )}
            </div>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Jevonian updates</CardTitle>
          <CardDescription>
            Installed through the package manager that owns this copy. New requests pause only for
            the final restart; active streams finish first.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Badge variant={update?.update.updateAvailable ? "default" : "outline"}>
            {update?.active
              ? `restarting · ${update.activeRequests ?? 0} active`
              : update?.update.updateAvailable
                ? `v${update.update.latest} available`
                : `v${update?.update.current ?? "—"} · current`}
          </Badge>
          {update?.update.channel !== "source" && update?.update.channel !== "unknown" ? (
            update?.update.updateAvailable ? (
              <Button
                size="sm"
                onClick={() => void installUpdate()}
                disabled={updateBusy || update.active}
              >
                {updateBusy ? "Installing…" : "Update and restart"}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void checkUpdate()}
                disabled={updateBusy}
              >
                Check now
              </Button>
            )
          ) : (
            <span className="text-xs text-muted-foreground">
              Source checkouts update with Git and are never self-updated.
            </span>
          )}
          {updateError || update?.error ? (
            <span className="text-xs text-destructive">{updateError || update?.error}</span>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Public tunnel</CardTitle>
          <CardDescription>
            Explicit opt-in. Jevonian never publishes this machine on its own — a tunnel runs only
            after you start it here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <details className="rounded-md border p-4">
            <summary className="cursor-pointer text-sm font-semibold">
              Tunnel configuration{" "}
              <span className="font-normal text-muted-foreground">
                ·{" "}
                {tunnel?.status === "on"
                  ? `${tunnel.provider} · on`
                  : tunnel?.status === "error"
                    ? "error"
                    : `${tunnelProvider} · off`}
              </span>
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    tunnel?.status === "on"
                      ? "default"
                      : tunnel?.status === "error"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {tunnel?.status ?? "off"}
                </Badge>
                {tunnelProvider === "cloudflare" ? (
                  <span className="text-[11px] text-muted-foreground">
                    quick tunnel URL is kept across restarts — stop the tunnel to release it
                  </span>
                ) : tunnelProvider === "ngrok" ? (
                  <span className="text-[11px] text-muted-foreground">
                    leave domain empty for a random URL, or paste your ngrok reserved domain
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={tunnelProvider}
                  onValueChange={(value) => editDraft({ provider: value as TunnelProviderView })}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cloudflare">cloudflare (quick tunnel)</SelectItem>
                    <SelectItem value="ngrok">ngrok</SelectItem>
                    <SelectItem value="custom">custom command</SelectItem>
                  </SelectContent>
                </Select>
                {tunnelProvider === "ngrok" ? (
                  <Input
                    className="max-w-md"
                    placeholder="casqued-….ngrok-free.dev (optional static domain)"
                    value={tunnelUrl}
                    onChange={(event) => editDraft({ url: event.target.value })}
                  />
                ) : null}
                {tunnelProvider === "custom" ? (
                  <>
                    <Input
                      className="max-w-md"
                      placeholder="cloudflared tunnel run my-named-tunnel"
                      value={tunnelCommand}
                      onChange={(event) => editDraft({ command: event.target.value })}
                    />
                    <Input
                      className="max-w-xs"
                      placeholder="https://ai.example.com (stable URL, optional)"
                      value={tunnelUrl}
                      onChange={(event) => editDraft({ url: event.target.value })}
                    />
                  </>
                ) : null}
                <Button onClick={() => void toggleTunnel()} disabled={tunnelBusy}>
                  {tunnel?.status === "on" ? "Stop tunnel" : "Start tunnel"}
                </Button>
                {draftUnsaved ? (
                  <span className="text-[11px] font-medium text-amber-600">unsaved draft</span>
                ) : null}
              </div>{" "}
              {tunnel?.url ? (
                <div className="flex items-center gap-2">
                  <code className="rounded-md bg-muted px-3 py-2 text-sm">{tunnel.url}/v1</code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void copy(`${tunnel.url}/v1`, "tunnel")}
                  >
                    {copied === "tunnel" ? "Copied" : "Copy"}
                  </Button>
                </div>
              ) : null}
              {tunnel?.command ? (
                <p className="text-xs text-muted-foreground">{tunnel.command}</p>
              ) : null}
              {tunnelError || tunnel?.error ? (
                <p className="text-xs text-destructive">{tunnelError || tunnel?.error}</p>
              ) : null}
              <p className="text-[11px] text-amber-600">
                Security: a tunnel exposes this proxy to the internet. Keep at least one API key
                active, rotate keys you have shared, and stop the tunnel when you are done.
              </p>
            </div>
          </details>
        </CardContent>
      </Card>

      <Panel
        title="Model routing"
        summary={`mode ${state.config.routing.mode} · pricing ${state.pricing.source} · baseline ${
          stats.baselineModel ?? "—"
        }`}
      >
        <div className="flex flex-col gap-2 text-sm">
          {(state.routings ?? state.config.routing.routings ?? []).map((entry) => (
            <div key={entry.id} className="flex justify-between gap-4">
              <span className="text-muted-foreground">{entry.label || entry.id}</span>
              <span className="text-right">{entry.models.join(", ") || "—"}</span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Spend by routing" summary={`${stats.byPhase.length} routings with traffic`}>
        <div className="flex flex-col gap-2 text-sm">
          {stats.byPhase.length === 0 ? (
            <p className="text-muted-foreground">No traffic yet.</p>
          ) : (
            stats.byPhase.map((phase) => (
              <div key={phase.phase} className="flex justify-between">
                <span className="text-muted-foreground">
                  {phase.phase} · {phase.requests} reqs
                </span>
                <span>{money(phase.costUsd)}</span>
              </div>
            ))
          )}
        </div>
      </Panel>
    </div>
  );
}
