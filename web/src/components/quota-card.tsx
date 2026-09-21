import { ProviderLogo } from "@/components/provider-logo";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ProviderQuotaView, QuotaHealthView, QuotaWindow } from "@/lib/api";
import { providerDisplayName } from "@/lib/provider-name";
import { cn, formatTime, money } from "@/lib/utils";

function usedLabel(usage: QuotaWindow): string {
  if (usage.usedPercent !== undefined) return `${usage.usedPercent.toFixed(1)}% used`;
  if (usage.usedUsd !== undefined) return `${money(usage.usedUsd)} used`;
  return "—";
}

function remainingLabel(usage: QuotaWindow): string | undefined {
  if (usage.usedPercent !== undefined) {
    return `${Math.max(0, 100 - usage.usedPercent).toFixed(1)}% left`;
  }
  if (usage.usedUsd !== undefined && usage.limitUsd !== undefined) {
    return `${money(Math.max(0, usage.limitUsd - usage.usedUsd))} left`;
  }
  return undefined;
}

function resetLabel(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const diff = at.getTime() - Date.now();
  if (diff <= 0) return "resetting";
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (hours >= 24) return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

export function balanceLabel(balance: { amount: number; currency: string }): string {
  const symbol =
    balance.currency === "USD" ? "$" : balance.currency === "CNY" ? "¥" : `${balance.currency} `;
  return `${symbol}${balance.amount.toFixed(2)}`;
}

const SOURCE_LABEL: Record<ProviderQuotaView["source"], string> = {
  live: "live",
  headers: "from responses",
  ledger: "local ledger",
  none: "unavailable",
};

export function QuotaWindowRow({ window }: { window: QuotaWindow }) {
  const used = window.usedPercent ?? 0;
  const width = Math.min(100, Math.max(0, used));
  const tone = used >= 90 ? "bg-destructive" : used >= 70 ? "bg-amber-500" : "bg-emerald-500";
  const reset = resetLabel(window.resetsAt);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{window.label}</span>
        <span className="text-muted-foreground">
          {usedLabel(window)}
          {remainingLabel(window) ? ` · ${remainingLabel(window)}` : ""}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", tone)}
          style={{ width: `${width}%` }}
        />
      </div>
      {reset || window.status ? (
        <span className="text-[11px] text-muted-foreground">
          {[reset, window.status && window.status !== "ok" ? window.status : undefined]
            .filter(Boolean)
            .join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

export function ProviderQuotaCard({
  quota,
  health,
}: {
  quota: ProviderQuotaView;
  health?: QuotaHealthView;
}) {
  const spend = quota.spend;
  const payPerToken = quota.billing === "api" && quota.windows.length === 0;
  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium">
            <ProviderLogo id={quota.provider} />
            {providerDisplayName(quota.provider)}
          </p>
          <p className="text-xs text-muted-foreground">
            {quota.billing === "subscription" ? "subscription" : "pay per token"}
            {quota.plan ? ` · ${quota.plan}` : ""}
            {quota.note ? ` · ${quota.note}` : ""}
          </p>
        </div>
        {payPerToken ? (
          <Badge variant="outline">no quota windows</Badge>
        ) : (
          <Badge variant={quota.source === "live" ? "default" : "secondary"}>
            {SOURCE_LABEL[quota.source]}
          </Badge>
        )}
      </div>

      {quota.windows.length > 0 ? (
        <div className="flex flex-col gap-3">
          {quota.windows.map((window) => (
            <QuotaWindowRow key={window.id} window={window} />
          ))}
        </div>
      ) : quota.balance ? (
        <p className="text-sm">
          <span className="text-muted-foreground">remaining balance </span>
          <span className="font-medium">{balanceLabel(quota.balance)}</span>
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {quota.billing === "api"
            ? "Pay per token — no quota window."
            : (quota.error ?? "No quota source for this provider.")}
        </p>
      )}

      {quota.windows.length > 0 && quota.error ? (
        <p className="text-[11px] text-muted-foreground">{quota.error}</p>
      ) : null}

      {health?.remainingUsd !== undefined ? (
        <p className="text-[11px] text-muted-foreground">
          {money(health.remainingUsd)} left in the {health.window ?? "current"} window
          {health.avgRequestUsd === undefined
            ? ""
            : ` · ~${money(health.avgRequestUsd)} per request`}
        </p>
      ) : null}

      <details className="border-t pt-2">
        <summary className="cursor-pointer text-[11px] text-muted-foreground">
          Periods &amp; source
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-[11px] text-muted-foreground">
            Read {SOURCE_LABEL[quota.source]} · fetched {formatTime(quota.fetchedAt)}
            {payPerToken ? " · pay per token, no window" : ""}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>5h {money(spend.fiveHourUsd)}</span>
            <span>24h {money(spend.dayUsd)}</span>
            <span>7d {money(spend.weekUsd)}</span>
            <span>
              30d {money(spend.monthUsd)} · {spend.monthRequests} reqs
            </span>
          </div>
        </div>
      </details>
    </div>
  );
}

export function QuotaGrid({
  quotas,
  health = [],
  title = "Usage & limits",
  description,
  bare = false,
}: {
  quotas: ProviderQuotaView[];
  health?: QuotaHealthView[];
  title?: string;
  description?: string;
  /** Render just the provider grid, for callers that supply their own card. */
  bare?: boolean;
}) {
  const byProvider = new Map(health.map((item) => [item.provider, item]));
  const grid =
    quotas.length === 0 ? (
      <p className="text-sm text-muted-foreground">No providers configured.</p>
    ) : (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {quotas.map((quota) => (
          <ProviderQuotaCard
            key={quota.provider}
            quota={quota}
            health={byProvider.get(quota.provider)}
          />
        ))}
      </div>
    );
  if (bare) return grid;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {description ??
            "Remaining quota, reset times, and per-provider spend. Estimates use models.dev rates."}
        </CardDescription>
      </CardHeader>
      <CardContent>{grid}</CardContent>
    </Card>
  );
}
