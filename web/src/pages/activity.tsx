import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { RequestsChart, SpendChart, TokensChart } from "@/components/activity-charts";
import { ActivitySkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, type ActivityReportView, type ActivityTimeRangeView, type KeyView } from "@/lib/api";
import { money } from "@/lib/utils";

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatCompactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function ActivityPage() {
  const [range, setRange] = useState<ActivityTimeRangeView>("30d");
  const [keyId, setKeyId] = useState<string>("all");
  const [keysList, setKeysList] = useState<KeyView[]>([]);
  const [report, setReport] = useState<ActivityReportView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [chartTab, setChartTab] = useState<"spend" | "tokens" | "requests">("spend");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [stateRes, reportRes] = await Promise.all([
        api.state(),
        api.activity({ range, keyId: keyId === "all" ? undefined : keyId }),
      ]);
      setKeysList(stateRes.keys);
      setReport(reportRes);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, [range, keyId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  if (loading && !report) {
    return <ActivitySkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Activity</h1>
          <p className="text-sm text-muted-foreground">
            Spend, token usage, and request volume trends across your API keys.
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-48">
            <Select value={keyId} onValueChange={(val) => setKeyId(String(val))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All keys</SelectItem>
                {keysList.map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {k.name} ({k.prefix}…)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="w-36">
            <Select value={range} onValueChange={(val) => setRange(val as ActivityTimeRangeView)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="24h">Last 24 hours</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="all">All time</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button variant="outline" size="sm" onClick={() => void loadData()} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {/* Stat Cards */}
      {report ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase tracking-wider">
                Total Spend
              </CardDescription>
              <CardTitle className="text-2xl font-bold font-mono">
                {money(report.summary.totalSpendUsd)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {money(report.summary.apiSpendUsd)}
                </span>{" "}
                API spend ·{" "}
                <span className="font-medium text-foreground">
                  {money(report.summary.subscriptionValueUsd)}
                </span>{" "}
                sub value
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase tracking-wider">
                Total Tokens
              </CardDescription>
              <CardTitle className="text-2xl font-bold font-mono">
                {formatCompactNumber(report.summary.totalTokens)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {formatCompactNumber(report.summary.promptTokens)} prompt ·{" "}
                {formatCompactNumber(report.summary.completionTokens)} out ·{" "}
                {formatCompactNumber(report.summary.cacheReadTokens)} cache
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase tracking-wider">
                Total Requests
              </CardDescription>
              <CardTitle className="text-2xl font-bold font-mono">
                {formatNumber(report.summary.totalRequests)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {formatNumber(report.summary.successfulRequests)} ok ·{" "}
                <span
                  className={report.summary.errorRequests > 0 ? "text-destructive font-medium" : ""}
                >
                  {formatNumber(report.summary.errorRequests)} err
                </span>{" "}
                · avg {report.summary.avgLatencyMs}ms
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Top lists */}
      {report ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Top models</CardTitle>
              <CardDescription className="text-xs">
                By estimated spend in this window
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {report.models.slice(0, 5).map((m, index) => (
                <div key={m.model} className="flex items-center justify-between gap-3 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-4 shrink-0 text-xs text-muted-foreground">{index + 1}</span>
                    <span className="truncate font-medium">{m.model}</span>
                  </div>
                  <div className="shrink-0 text-right font-mono text-xs text-muted-foreground">
                    {formatCompactNumber(m.totalTokens)} tok ·{" "}
                    {money(m.spendUsd + m.subscriptionUsd)}
                  </div>
                </div>
              ))}
              {report.models.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  No model traffic yet.
                </p>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Top API keys</CardTitle>
              <CardDescription className="text-xs">Attributed spend across keys</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {report.keys.slice(0, 5).map((k, index) => (
                <button
                  key={k.id}
                  type="button"
                  className="flex items-center justify-between gap-3 text-left text-sm hover:opacity-80"
                  onClick={() => setKeyId(k.id)}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-4 shrink-0 text-xs text-muted-foreground">{index + 1}</span>
                    <span className="truncate font-medium">{k.name}</span>
                  </div>
                  <div className="shrink-0 text-right font-mono text-xs text-muted-foreground">
                    {formatNumber(k.requests)} req · {money(k.spendUsd)}
                  </div>
                </button>
              ))}
              {report.keys.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  No key traffic yet.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Chart Section with Tabs */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 rounded-lg border bg-muted/40 p-1">
            <button
              type="button"
              onClick={() => setChartTab("spend")}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                chartTab === "spend"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Spend
            </button>
            <button
              type="button"
              onClick={() => setChartTab("tokens")}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                chartTab === "tokens"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Tokens
            </button>
            <button
              type="button"
              onClick={() => setChartTab("requests")}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                chartTab === "requests"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Requests
            </button>
          </div>

          <Link
            to="/logs"
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Inspect generation logs →
          </Link>
        </div>

        {report ? (
          chartTab === "spend" ? (
            <SpendChart series={report.series} loading={loading} />
          ) : chartTab === "tokens" ? (
            <TokensChart series={report.series} loading={loading} />
          ) : (
            <RequestsChart series={report.series} loading={loading} />
          )
        ) : (
          <Card className="overflow-hidden border bg-card/70">
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-56" />
            </CardHeader>
            <CardContent className="pt-2">
              <Skeleton className="h-44 w-full rounded-md" />
            </CardContent>
          </Card>
        )}
      </div>

      {/* Model Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Model breakdown</CardTitle>
          <CardDescription>Tokens and cost by model for the selected period</CardDescription>
        </CardHeader>
        <CardContent>
          {report && report.models.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Prompt</TableHead>
                  <TableHead className="text-right">Completion</TableHead>
                  <TableHead className="text-right">Cache Read</TableHead>
                  <TableHead className="text-right">Total Tokens</TableHead>
                  <TableHead className="text-right">API Spend</TableHead>
                  <TableHead className="text-right">Sub Value</TableHead>
                  <TableHead className="text-right w-28">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.models.map((m) => (
                  <TableRow key={m.model}>
                    <TableCell className="font-medium">{m.model}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatNumber(m.requests)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {formatCompactNumber(m.promptTokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {formatCompactNumber(m.completionTokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {formatCompactNumber(m.cacheReadTokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-semibold">
                      {formatCompactNumber(m.totalTokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-medium">
                      {money(m.spendUsd)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {m.subscriptionUsd > 0 ? money(m.subscriptionUsd) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1.5 w-14 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full bg-primary rounded-full"
                            style={{ width: `${Math.min(100, m.percentSpend)}%` }}
                          />
                        </div>
                        <span className="font-mono text-xs w-10 text-right">{m.percentSpend}%</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No model usage recorded in this time range.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Key Breakdown (when All keys is selected) */}
      {keyId === "all" && report && report.keys.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Key breakdown</CardTitle>
            <CardDescription>Spend and activity attributed to each API key</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key Name</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">API Spend</TableHead>
                  <TableHead className="text-right">Subscription Value</TableHead>
                  <TableHead className="text-right">Filter</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.keys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell className="font-medium">{k.name}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatNumber(k.requests)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-semibold">
                      {money(k.spendUsd)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {k.subscriptionUsd > 0 ? money(k.subscriptionUsd) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7"
                        onClick={() => setKeyId(k.id)}
                      >
                        View Key →
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
