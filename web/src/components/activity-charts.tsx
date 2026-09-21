import { useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ActivitySeriesPointView } from "@/lib/api";
import { cn, money } from "@/lib/utils";

function formatCompactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

interface ChartBaseProps {
  series: ActivitySeriesPointView[];
  loading?: boolean;
}

/**
 * Spend Chart:
 * Visualizes pay-as-you-go API spend and subscription value over time.
 */
export function SpendChart({ series }: ChartBaseProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const height = 180;
  const width = 800;
  const padBottom = 26;
  const padTop = 16;
  const chartHeight = height - padBottom - padTop;

  const maxSpend = Math.max(...series.map((pt) => pt.spendUsd + pt.subscriptionUsd), 0.001);

  const barWidth = series.length > 0 ? Math.max(2, (width / series.length) * 0.68) : 8;
  const barGap = series.length > 0 ? (width / series.length) * 0.32 : 2;

  const hovered = hoverIndex !== null ? series[hoverIndex] : null;

  return (
    <Card className="overflow-hidden border bg-card/70">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-sm font-semibold tracking-tight">Spend over time</CardTitle>
          <CardDescription className="text-xs">
            Pay-as-you-go API costs and subscription equivalent value
          </CardDescription>
        </div>
        {hovered ? (
          <div className="flex items-center gap-3 text-xs bg-muted/60 px-2.5 py-1 rounded-md border font-mono">
            <span className="font-sans font-medium text-foreground">{hovered.label}:</span>
            <span className="text-primary font-medium">{money(hovered.spendUsd)} API</span>
            {hovered.subscriptionUsd > 0 ? (
              <span className="text-muted-foreground">· {money(hovered.subscriptionUsd)} sub</span>
            ) : null}
            <span className="text-muted-foreground font-sans">({hovered.requests} reqs)</span>
          </div>
        ) : (
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-primary" /> API spend
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-muted-foreground/40" /> Subscription value
            </span>
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-2">
        <div className="relative w-full">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full overflow-visible"
            style={{ maxHeight: 180 }}
            preserveAspectRatio="none"
            onMouseLeave={() => setHoverIndex(null)}
          >
            <defs>
              <linearGradient id="spend-api-gradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.9" />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.4" />
              </linearGradient>
            </defs>

            {/* Grid lines */}
            <line
              x1="0"
              y1={padTop + chartHeight}
              x2={width}
              y2={padTop + chartHeight}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <line
              x1="0"
              y1={padTop + chartHeight / 2}
              x2={width}
              y2={padTop + chartHeight / 2}
              stroke="var(--border)"
              strokeWidth="0.5"
              strokeDasharray="4 4"
            />

            {/* Bars */}
            {series.map((pt, idx) => {
              const x = idx * (barWidth + barGap);
              const totalVal = pt.spendUsd + pt.subscriptionUsd;
              const totalH = totalVal > 0 ? Math.max(3, (totalVal / maxSpend) * chartHeight) : 0;
              const apiH = totalVal > 0 ? (pt.spendUsd / totalVal) * totalH : 0;
              const subH = totalH - apiH;

              const yTotal = padTop + chartHeight - totalH;
              const yApi = padTop + chartHeight - apiH;
              const isHovered = hoverIndex === idx;

              // Step labels to avoid crowding
              const showLabel =
                series.length <= 14 ||
                idx % Math.ceil(series.length / 10) === 0 ||
                idx === series.length - 1;

              return (
                <g
                  key={pt.timestamp}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoverIndex(idx)}
                >
                  <rect
                    x={x - barGap / 2}
                    y={0}
                    width={barWidth + barGap}
                    height={height}
                    fill="transparent"
                  />
                  {/* Hover background column */}
                  {isHovered ? (
                    <rect
                      x={x - 2}
                      y={padTop}
                      width={barWidth + 4}
                      height={chartHeight}
                      fill="var(--accent)"
                      opacity="0.5"
                      rx="2"
                    />
                  ) : null}

                  {subH > 0 ? (
                    <rect
                      x={x}
                      y={yTotal}
                      width={barWidth}
                      height={subH}
                      rx="1"
                      fill="var(--muted-foreground)"
                      opacity={isHovered ? "0.6" : "0.35"}
                    />
                  ) : null}
                  {apiH > 0 ? (
                    <rect
                      x={x}
                      y={yApi}
                      width={barWidth}
                      height={apiH}
                      rx="1"
                      fill="url(#spend-api-gradient)"
                      className={isHovered ? "brightness-125" : ""}
                    />
                  ) : null}
                  {totalVal === 0 ? (
                    <circle
                      cx={x + barWidth / 2}
                      cy={padTop + chartHeight - 1}
                      r="1"
                      fill="var(--muted-foreground)"
                      opacity="0.3"
                    />
                  ) : null}

                  {showLabel ? (
                    <text
                      x={x + barWidth / 2}
                      y={height - 6}
                      textAnchor="middle"
                      className="fill-muted-foreground text-[10px] select-none"
                    >
                      {pt.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Tokens Chart:
 * Stacked breakdown of Prompt, Completion, and Cache Read tokens.
 */
export function TokensChart({ series }: ChartBaseProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const height = 180;
  const width = 800;
  const padBottom = 26;
  const padTop = 16;
  const chartHeight = height - padBottom - padTop;

  const maxTokens = Math.max(...series.map((pt) => pt.totalTokens), 1);
  const barWidth = series.length > 0 ? Math.max(2, (width / series.length) * 0.68) : 8;
  const barGap = series.length > 0 ? (width / series.length) * 0.32 : 2;

  const hovered = hoverIndex !== null ? series[hoverIndex] : null;

  return (
    <Card className="overflow-hidden border bg-card/70">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-sm font-semibold tracking-tight">Tokens over time</CardTitle>
          <CardDescription className="text-xs">
            Prompt, completion, and cache read volume breakdown
          </CardDescription>
        </div>
        {hovered ? (
          <div className="flex items-center gap-2 text-xs bg-muted/60 px-2.5 py-1 rounded-md border font-mono">
            <span className="font-sans font-medium text-foreground">{hovered.label}:</span>
            <span className="text-foreground font-medium">
              {formatCompactNumber(hovered.totalTokens)} total
            </span>
            <span className="text-muted-foreground">
              ({formatCompactNumber(hovered.promptTokens)} prompt ·{" "}
              {formatCompactNumber(hovered.completionTokens)} out ·{" "}
              {formatCompactNumber(hovered.cacheReadTokens)} cache)
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-primary" /> Prompt
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-emerald-500" /> Completion
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-indigo-400" /> Cache Read
            </span>
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-2">
        <div className="relative w-full">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full overflow-visible"
            style={{ maxHeight: 180 }}
            preserveAspectRatio="none"
            onMouseLeave={() => setHoverIndex(null)}
          >
            <line
              x1="0"
              y1={padTop + chartHeight}
              x2={width}
              y2={padTop + chartHeight}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <line
              x1="0"
              y1={padTop + chartHeight / 2}
              x2={width}
              y2={padTop + chartHeight / 2}
              stroke="var(--border)"
              strokeWidth="0.5"
              strokeDasharray="4 4"
            />

            {series.map((pt, idx) => {
              const x = idx * (barWidth + barGap);
              const totalH =
                pt.totalTokens > 0 ? Math.max(3, (pt.totalTokens / maxTokens) * chartHeight) : 0;
              const promptH = pt.totalTokens > 0 ? (pt.promptTokens / pt.totalTokens) * totalH : 0;
              const compH =
                pt.totalTokens > 0 ? (pt.completionTokens / pt.totalTokens) * totalH : 0;
              const cacheH = totalH - promptH - compH;

              const yCache = padTop + chartHeight - totalH;
              const yComp = yCache + cacheH;
              const yPrompt = yComp + compH;

              const isHovered = hoverIndex === idx;
              const showLabel =
                series.length <= 14 ||
                idx % Math.ceil(series.length / 10) === 0 ||
                idx === series.length - 1;

              return (
                <g
                  key={pt.timestamp}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoverIndex(idx)}
                >
                  <rect
                    x={x - barGap / 2}
                    y={0}
                    width={barWidth + barGap}
                    height={height}
                    fill="transparent"
                  />
                  {isHovered ? (
                    <rect
                      x={x - 2}
                      y={padTop}
                      width={barWidth + 4}
                      height={chartHeight}
                      fill="var(--accent)"
                      opacity="0.5"
                      rx="2"
                    />
                  ) : null}

                  {cacheH > 0 ? (
                    <rect
                      x={x}
                      y={yCache}
                      width={barWidth}
                      height={cacheH}
                      fill="#818cf8"
                      opacity={isHovered ? "0.9" : "0.7"}
                    />
                  ) : null}
                  {compH > 0 ? (
                    <rect
                      x={x}
                      y={yComp}
                      width={barWidth}
                      height={compH}
                      fill="#10b981"
                      opacity={isHovered ? "0.95" : "0.8"}
                    />
                  ) : null}
                  {promptH > 0 ? (
                    <rect
                      x={x}
                      y={yPrompt}
                      width={barWidth}
                      height={promptH}
                      rx="1"
                      fill="var(--primary)"
                      className={isHovered ? "brightness-125" : ""}
                    />
                  ) : null}

                  {pt.totalTokens === 0 ? (
                    <circle
                      cx={x + barWidth / 2}
                      cy={padTop + chartHeight - 1}
                      r="1"
                      fill="var(--muted-foreground)"
                      opacity="0.3"
                    />
                  ) : null}

                  {showLabel ? (
                    <text
                      x={x + barWidth / 2}
                      y={height - 6}
                      textAnchor="middle"
                      className="fill-muted-foreground text-[10px] select-none"
                    >
                      {pt.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Requests Chart:
 * Volume of requests per time interval with error highlight.
 */
export function RequestsChart({
  series,
  title = "Requests over time",
  description = "Volume and error count across all models",
  compact = false,
}: ChartBaseProps & { title?: string; description?: string; compact?: boolean }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const height = compact ? 112 : 180;
  const width = 800;
  const padBottom = compact ? 20 : 26;
  const padTop = compact ? 6 : 16;
  const chartHeight = height - padBottom - padTop;

  const maxReq = Math.max(...series.map((pt) => pt.requests), 1);
  const barWidth = series.length > 0 ? Math.max(2, (width / series.length) * 0.68) : 8;
  const barGap = series.length > 0 ? (width / series.length) * 0.32 : 2;

  const hovered = hoverIndex !== null ? series[hoverIndex] : null;

  return (
    <Card className="overflow-hidden border bg-card/70">
      <CardHeader
        className={cn(
          "flex flex-row items-center justify-between",
          compact ? "gap-2 p-4 pb-1" : "pb-2",
        )}
      >
        <div className="min-w-0">
          <CardTitle className="text-sm font-semibold tracking-tight">{title}</CardTitle>
          <CardDescription className={cn("text-xs", compact && "line-clamp-1")}>
            {description}
          </CardDescription>
        </div>
        {hovered ? (
          <div className="flex shrink-0 items-center gap-2 rounded-md border bg-muted/60 px-2.5 py-1 font-mono text-xs">
            <span className="font-sans font-medium text-foreground">{hovered.label}:</span>
            <span className="font-medium text-foreground">{hovered.requests} requests</span>
            {hovered.errorRequests > 0 ? (
              <span className="font-semibold text-destructive">
                ({hovered.errorRequests} errors)
              </span>
            ) : null}
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-primary" /> Requests
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-destructive" /> Errors
            </span>
          </div>
        )}
      </CardHeader>
      <CardContent className={compact ? "px-4 pt-1 pb-3" : "pt-2"}>
        <div className="relative w-full">
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
              stroke="var(--border)"
              strokeWidth="1"
            />
            <line
              x1="0"
              y1={padTop + chartHeight / 2}
              x2={width}
              y2={padTop + chartHeight / 2}
              stroke="var(--border)"
              strokeWidth="0.5"
              strokeDasharray="4 4"
            />

            {series.map((pt, idx) => {
              const x = idx * (barWidth + barGap);
              const reqH = pt.requests > 0 ? Math.max(3, (pt.requests / maxReq) * chartHeight) : 0;
              const y = padTop + chartHeight - reqH;
              const hasErrors = pt.errorRequests > 0;
              const isHovered = hoverIndex === idx;

              const showLabel =
                series.length <= 14 ||
                idx % Math.ceil(series.length / 10) === 0 ||
                idx === series.length - 1;

              return (
                <g
                  key={pt.timestamp}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoverIndex(idx)}
                >
                  <rect
                    x={x - barGap / 2}
                    y={0}
                    width={barWidth + barGap}
                    height={height}
                    fill="transparent"
                  />
                  {isHovered ? (
                    <rect
                      x={x - 2}
                      y={padTop}
                      width={barWidth + 4}
                      height={chartHeight}
                      fill="var(--accent)"
                      opacity="0.5"
                      rx="2"
                    />
                  ) : null}

                  {reqH > 0 ? (
                    <rect
                      x={x}
                      y={y}
                      width={barWidth}
                      height={reqH}
                      rx="1"
                      fill={hasErrors ? "var(--destructive)" : "var(--primary)"}
                      opacity={isHovered ? "1" : "0.75"}
                    />
                  ) : (
                    <circle
                      cx={x + barWidth / 2}
                      cy={padTop + chartHeight - 1}
                      r="1"
                      fill="var(--muted-foreground)"
                      opacity="0.3"
                    />
                  )}

                  {showLabel ? (
                    <text
                      x={x + barWidth / 2}
                      y={height - 4}
                      textAnchor="middle"
                      className="fill-muted-foreground text-[10px] select-none"
                    >
                      {pt.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}
