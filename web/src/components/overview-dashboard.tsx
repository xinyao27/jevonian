import { Badge, Button, LayerCard, Text } from "@cloudflare/kumo";
import { Check, Copy } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import { UsageHeatmapCard } from "@/components/usage-heatmap";
import type { ActivityModelStatView, ActivityReportView, ActivitySeriesPointView } from "@/lib/api";
import { cn, formatCompact } from "@/lib/utils";

function usd(value: number): string {
  if (value >= 100) return `$${value.toFixed(0)}`;
  if (value >= 10) return `$${value.toFixed(1)}`;
  return `$${value.toFixed(2)}`;
}

function IconCopyButton({
  text,
  copiedId,
  activeId,
  onCopy,
}: {
  text: string;
  copiedId: string;
  activeId: string;
  onCopy: (value: string, id: string) => void;
}) {
  const done = copiedId === activeId;
  return (
    <Button
      type="button"
      variant="ghost"
      shape="square"
      size="xs"
      aria-label={done ? "Copied" : "Copy"}
      title={done ? "Copied" : "Copy"}
      className="shrink-0 text-kumo-subtle"
      onClick={() => onCopy(text, activeId)}
    >
      {done ? <Check size={14} className="text-kumo-success" /> : <Copy size={14} />}
    </Button>
  );
}

/** Compact single-metric bar chart used inside dashboard cards. */
function MiniBars({
  series,
  valueOf,
  height = 72,
  className,
  emptyLabel = "No activity in this window",
  formatValue = formatCompact,
}: {
  series: ActivitySeriesPointView[];
  valueOf: (pt: ActivitySeriesPointView) => number;
  height?: number;
  className?: string;
  emptyLabel?: string;
  formatValue?: (n: number) => string;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 640;
  const padTop = 6;
  const padBottom = 16;
  const chartHeight = height - padTop - padBottom;
  const values = series.map(valueOf);
  const max = Math.max(...values, 0);
  const hasSignal = max > 0;
  const barWidth = series.length > 0 ? Math.max(2.5, (width / series.length) * 0.55) : 8;
  const gap = series.length > 0 ? (width / series.length) * 0.45 : 2;
  const hovered = hoverIndex !== null ? series[hoverIndex] : null;

  if (!hasSignal) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-lg border border-dashed border-kumo-hairline bg-kumo-tint/40 text-xs text-kumo-subtle",
          className,
        )}
        style={{ height }}
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className={cn("relative w-full", className)}>
      {hovered ? (
        <div className="pointer-events-none absolute -top-0.5 right-0 z-10 rounded-md border border-kumo-hairline bg-kumo-elevated px-2 py-0.5 font-mono text-xs text-kumo-default shadow-xs">
          <span className="font-sans text-kumo-subtle">{hovered.label}</span>{" "}
          {formatValue(valueOf(hovered))}
        </div>
      ) : null}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full overflow-visible"
        style={{ maxHeight: height }}
        preserveAspectRatio="none"
        onMouseLeave={() => setHoverIndex(null)}
      >
        <line
          x1="0"
          y1={padTop + chartHeight}
          x2={width}
          y2={padTop + chartHeight}
          stroke="var(--color-kumo-hairline)"
          strokeWidth="1"
        />
        {series.map((pt, idx) => {
          const value = values[idx];
          const h = value > 0 ? Math.max(3, (value / max) * chartHeight) : 0;
          const x = idx * (barWidth + gap);
          const y = padTop + chartHeight - h;
          const active = hoverIndex === idx;
          const showLabel =
            series.length <= 10 ||
            idx % Math.ceil(series.length / 7) === 0 ||
            idx === series.length - 1;
          return (
            <g key={pt.timestamp} onMouseEnter={() => setHoverIndex(idx)}>
              <rect
                x={x}
                y={padTop}
                width={barWidth + gap}
                height={chartHeight}
                fill="transparent"
              />
              {value > 0 ? (
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={h}
                  rx={2}
                  fill="var(--color-kumo-brand)"
                  opacity={active ? 1 : 0.35 + 0.65 * (value / max)}
                />
              ) : null}
              {showLabel ? (
                <text
                  x={x + barWidth / 2}
                  y={height - 2}
                  textAnchor="middle"
                  fill="var(--text-color-kumo-subtle)"
                  fontSize="9"
                >
                  {pt.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function TodayTokensCard({
  today,
  week,
  month,
}: {
  today: ActivityReportView;
  week: ActivityReportView;
  month: ActivityReportView;
}) {
  const todayTokens = today.summary.totalTokens;
  const weekTokens = week.summary.totalTokens;
  const weekShare = weekTokens > 0 ? Math.round((todayTokens / weekTokens) * 100) : 0;
  const todaySpend = today.summary.totalSpendUsd;
  const monthSpend = month.summary.totalSpendUsd;
  const dateLabel = new Date(today.endTime || Date.now()).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return (
    <LayerCard className="flex min-h-0 flex-col overflow-hidden shadow-none">
      <div className="flex flex-row items-start justify-between gap-3 px-4 pt-4 pb-2">
        <div>
          <Text variant="secondary" size="xs">
            Today tokens
          </Text>
          <h2 className="mt-1 text-[2rem] font-semibold tracking-[-0.04em] tabular-nums text-kumo-default sm:text-[2.35rem]">
            {formatCompact(todayTokens)}
          </h2>
        </div>
        <span className="rounded-md bg-kumo-tint px-2 py-0.5 text-xs text-kumo-subtle tabular-nums">
          {dateLabel}
        </span>
      </div>
      <div className="flex flex-1 flex-col justify-between gap-4 px-4 pb-4">
        <MiniBars
          series={today.series}
          valueOf={(pt) => pt.totalTokens}
          height={128}
          className="min-h-[8rem]"
          emptyLabel="No tokens yet today"
        />
        <div className="grid grid-cols-3 gap-0 border-t border-kumo-hairline pt-3 text-xs">
          <div className="pr-3">
            <p className="font-medium tabular-nums text-kumo-default">{weekShare}% of week</p>
            <p className="mt-0.5 text-xs text-kumo-subtle">vs last 7 days</p>
          </div>
          <div className="border-l border-kumo-hairline px-3">
            <p className="font-medium tabular-nums text-kumo-default">{usd(todaySpend)} today</p>
            <p className="mt-0.5 text-xs text-kumo-subtle">estimated spend</p>
          </div>
          <div className="border-l border-kumo-hairline pl-3">
            <p className="font-medium tabular-nums text-kumo-default">{usd(monthSpend)} month</p>
            <p className="mt-0.5 text-xs text-kumo-subtle">last 30 days</p>
          </div>
        </div>
      </div>
    </LayerCard>
  );
}

/** Tiny relative bars stand in for per-model sparklines (API has no model series). */
function ShareSpark({ ratio }: { ratio: number }) {
  const steps = 7;
  const filled = Math.max(1, Math.round(ratio * steps));
  return (
    <div className="flex h-5 items-end gap-0.5" aria-hidden>
      {Array.from({ length: steps }, (_, i) => {
        const t = (i + 1) / steps;
        const on = i < filled;
        const h = 30 + t * 70;
        return (
          <span
            key={i}
            className={cn("w-1 rounded-[1px]", on ? "bg-kumo-brand" : "bg-kumo-fill")}
            style={{ height: `${h}%` }}
          />
        );
      })}
    </div>
  );
}

export function ModelsCard({ models }: { models: ActivityModelStatView[] }) {
  const top = models.slice(0, 8);
  const maxTokens = Math.max(...top.map((m) => m.totalTokens), 1);

  return (
    <LayerCard className="flex min-h-0 flex-col overflow-hidden shadow-none">
      <div className="flex flex-row items-center justify-between px-4 pt-4 pb-2">
        <Text variant="heading" as="h3">
          Models
        </Text>
        <Link
          to="/models"
          className="text-xs text-kumo-subtle transition-colors hover:text-kumo-default"
        >
          All models →
        </Link>
      </div>
      <div className="flex flex-1 flex-col gap-0.5 px-3 pb-4">
        {top.length === 0 ? (
          <p className="px-2 py-8 text-center text-xs text-kumo-subtle">No model traffic yet.</p>
        ) : (
          top.map((m) => {
            const ratio = m.totalTokens / maxTokens;
            const cost = m.spendUsd + m.subscriptionUsd;
            return (
              <div
                key={m.model}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-kumo-tint"
              >
                <div className="min-w-0">
                  <p
                    className="truncate text-sm font-medium text-kumo-default"
                    title={m.variants?.join(", ") ?? m.model}
                  >
                    {m.label ?? m.model}
                  </p>
                  <p className="mt-0.5 text-xs text-kumo-subtle tabular-nums">
                    {m.requests.toLocaleString()} req
                    {m.percentSpend > 0 ? ` · ${m.percentSpend.toFixed(0)}% spend` : ""}
                  </p>
                </div>
                <ShareSpark ratio={ratio} />
                <div className="min-w-[5.5rem] shrink-0 text-right font-mono text-xs text-kumo-subtle tabular-nums">
                  <span className="text-kumo-default">{formatCompact(m.totalTokens)}</span>
                  <span className="text-kumo-subtle"> · {usd(cost)}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </LayerCard>
  );
}

export function SpendCard({
  summary,
  series,
}: {
  summary: ActivityReportView["summary"];
  series: ActivitySeriesPointView[];
}) {
  return (
    <LayerCard className="overflow-hidden shadow-none">
      <div className="space-y-1 px-4 pt-4 pb-2">
        <Text variant="secondary" size="xs">
          Cost · 30 days
        </Text>
        <h3 className="text-[1.75rem] font-semibold tracking-[-0.03em] tabular-nums text-kumo-default">
          {usd(summary.totalSpendUsd)}
        </h3>
        <p className="text-xs text-kumo-subtle">
          api {usd(summary.apiSpendUsd)} · sub {usd(summary.subscriptionValueUsd)}
        </p>
      </div>
      <div className="px-4 pb-4">
        <MiniBars
          series={series}
          valueOf={(pt) => pt.spendUsd + pt.subscriptionUsd}
          height={56}
          emptyLabel="No spend in this window"
          formatValue={usd}
        />
      </div>
    </LayerCard>
  );
}

export function TokensCard({
  summary,
  series,
  cacheHitRate,
}: {
  summary: ActivityReportView["summary"];
  series: ActivitySeriesPointView[];
  cacheHitRate: number;
}) {
  return (
    <LayerCard className="overflow-hidden shadow-none">
      <div className="space-y-1 px-4 pt-4 pb-2">
        <Text variant="secondary" size="xs">
          Tokens · 30 days
        </Text>
        <h3 className="text-[1.75rem] font-semibold tracking-[-0.03em] tabular-nums text-kumo-default">
          {formatCompact(summary.totalTokens)}
        </h3>
        <p className="text-xs text-kumo-subtle">
          prompt {formatCompact(summary.promptTokens)} · out{" "}
          {formatCompact(summary.completionTokens)} · cache {formatCompact(summary.cacheReadTokens)}{" "}
          · hit {(cacheHitRate * 100).toFixed(0)}%
        </p>
      </div>
      <div className="px-4 pb-4">
        <MiniBars
          series={series}
          valueOf={(pt) => pt.totalTokens}
          height={56}
          emptyLabel="No tokens in this window"
        />
      </div>
    </LayerCard>
  );
}

function StripChip({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-lg border border-kumo-hairline bg-kumo-base px-2.5 py-1.5",
        className,
      )}
    >
      <span className="text-xs text-kumo-subtle">{label}</span>
      {children}
    </div>
  );
}

export function OverviewStatusStrip({
  running,
  routingMode,
  localUrl,
  apiKeyHint,
  onCopyUrl,
  copied,
}: {
  running: boolean;
  routingMode: string;
  localUrl: string;
  apiKeyHint: string;
  onCopyUrl: (value: string, id: string) => void;
  copied: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StripChip label="Status">
        <Badge
          variant={running ? "success" : "neutral"}
          appearance="dot"
          className="h-5 px-1.5 text-xs font-medium"
        >
          {running ? "Running" : "Offline"}
        </Badge>
      </StripChip>

      <StripChip label="Mode">
        <Badge variant="outline" className="h-5 px-1.5 text-xs font-medium capitalize">
          {routingMode || "auto"}
        </Badge>
      </StripChip>

      <StripChip label="Local URL" className="min-w-0 max-w-full">
        <code className="max-w-[14rem] truncate font-mono text-xs text-kumo-default sm:max-w-[18rem]">
          {localUrl}
        </code>
        <IconCopyButton text={localUrl} copiedId={copied} activeId="local" onCopy={onCopyUrl} />
      </StripChip>

      {apiKeyHint ? (
        <StripChip label="API key">
          <code className="font-mono text-xs tracking-wide text-kumo-default">{apiKeyHint}</code>
        </StripChip>
      ) : null}
    </div>
  );
}

export function OverviewDashboardGrid({
  today,
  week,
  month,
  history,
  cacheHitRate,
}: {
  today: ActivityReportView;
  week: ActivityReportView;
  month: ActivityReportView;
  history: ActivityReportView;
  cacheHitRate: number;
}) {
  const heatmapSeries =
    history.series.length >= 14
      ? history.series
      : month.series.length > 0
        ? month.series
        : week.series;
  // One ranked model list feeds both the Models card and the heatmap footer, so the two
  // never disagree about which models lead.
  const topModels = week.models.length > 0 ? week.models : month.models;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-4">
      <div className="flex flex-col gap-4 lg:col-span-7">
        <TodayTokensCard today={today} week={week} month={month} />
        <ModelsCard models={topModels} />
      </div>
      <div className="flex flex-col gap-4 lg:col-span-5">
        <UsageHeatmapCard
          series={heatmapSeries}
          models={topModels}
          weekTokens={week.summary.totalTokens}
          monthTokens={month.summary.totalTokens}
        />
        <SpendCard summary={month.summary} series={month.series} />
        <TokensCard summary={month.summary} series={month.series} cacheHitRate={cacheHitRate} />
      </div>
    </div>
  );
}
