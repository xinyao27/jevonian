import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { RequestsChart } from "@/components/activity-charts";
import { ProviderLogo } from "@/components/provider-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Autocomplete } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLogStream } from "@/hooks/use-log-stream";
import { useVirtualizer } from "@/hooks/use-virtualizer";
import {
  api,
  logKey,
  type ActivitySeriesPointView,
  type LogRecord,
  type LogSeries,
} from "@/lib/api";
import { providerDisplayName } from "@/lib/provider-name";
import { cn, formatTime, money } from "@/lib/utils";

const MODEL_SUGGESTION_LIMIT = 50;
const ROW_ESTIMATE_HEIGHT = 44;

/** Map the logs series endpoint onto the shared Activity chart shape. */
function toRequestSeries(series: LogSeries | null): ActivitySeriesPointView[] {
  if (!series) return [];
  return series.buckets.map((bucket) => {
    const at = new Date(bucket.start);
    const label = Number.isNaN(at.getTime())
      ? bucket.start
      : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    return {
      timestamp: bucket.start,
      label,
      spendUsd: bucket.costUsd,
      subscriptionUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      requests: bucket.requests,
      errorRequests: bucket.errors,
    };
  });
}

export function LogsPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState("all");
  const [model, setModel] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [live, setLive] = useState(true);

  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [newLogIds, setNewLogIds] = useState<Set<string>>(() => new Set());
  const [series, setSeries] = useState<LogSeries | null>(null);
  const [knownModels, setKnownModels] = useState<string[]>([]);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const queryParams = useMemo(() => {
    const q = new URLSearchParams();
    if (phase && phase !== "all") q.set("phase", phase);
    if (model.trim()) q.set("model", model.trim());
    if (search.trim()) q.set("q", search.trim());
    return q.toString();
  }, [phase, model, search]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchDraft), 300);
    return () => clearTimeout(timer);
  }, [searchDraft]);

  const loadInitial = useCallback(async () => {
    setLoadingInitial(true);
    try {
      const [res, chartRes] = await Promise.all([
        api.logs({
          limit: 100,
          phase: phase === "all" ? "" : phase,
          model: model.trim(),
          q: search.trim(),
        }),
        api.logSeries({
          minutes: 60,
          buckets: 40,
          phase: phase === "all" ? "" : phase,
          model: model.trim(),
          q: search.trim(),
        }),
      ]);
      setLogs(res.logs);
      setTotal(res.total);
      setNextBefore(res.nextBefore);
      setSeries(chartRes);
      setError("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoadingInitial(false);
    }
  }, [phase, model, search]);

  const loadMore = useCallback(async () => {
    if (loadingMore || nextBefore === null) return;
    setLoadingMore(true);
    try {
      const res = await api.logs({
        limit: 100,
        before: nextBefore,
        phase: phase === "all" ? "" : phase,
        model: model.trim(),
        q: search.trim(),
      });
      setLogs((prev) => {
        const existing = new Set(prev.map(logKey));
        const append = res.logs.filter((item) => !existing.has(logKey(item)));
        return [...prev, ...append];
      });
      setNextBefore(res.nextBefore);
      setTotal(res.total);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextBefore, phase, model, search]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.logs({ limit: 1000 });
        if (cancelled) return;
        setKnownModels((current) => {
          const next = new Set(current);
          for (const log of result.logs) next.add(log.model);
          return [...next].sort((a, b) => a.localeCompare(b));
        });
      } catch {
        // Suggestions are convenience.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const chartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshChart = useCallback(() => {
    if (chartTimer.current) clearTimeout(chartTimer.current);
    chartTimer.current = setTimeout(() => {
      void api
        .logSeries({
          minutes: 60,
          buckets: 40,
          phase: phase === "all" ? "" : phase,
          model: model.trim(),
          q: search.trim(),
        })
        .then(setSeries)
        .catch(() => {});
    }, 800);
  }, [phase, model, search]);

  useEffect(() => {
    return () => {
      if (chartTimer.current) clearTimeout(chartTimer.current);
    };
  }, []);

  const handleLiveRecord = useCallback(
    (record: LogRecord) => {
      const key = logKey(record);
      setNewLogIds((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      setTimeout(() => {
        setNewLogIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }, 2400);
      setLogs((prev) => {
        if (prev.some((item) => logKey(item) === key)) return prev;
        return [record, ...prev];
      });
      setTotal((prev) => (prev !== null ? prev + 1 : 1));
      refreshChart();
    },
    [refreshChart],
  );

  const streamStatus = useLogStream({
    enabled: live,
    query: queryParams,
    onRecord: handleLiveRecord,
    onReady: refreshChart,
  });

  const virtualizer = useVirtualizer({
    count: logs.length,
    estimateSize: () => ROW_ESTIMATE_HEIGHT,
    overscan: 10,
    getScrollElement: () => scrollContainerRef.current,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight - (scrollTop + clientHeight) < 250) void loadMore();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [loadMore]);

  const suggestions = useMemo(() => knownModels.slice(0, MODEL_SUGGESTION_LIMIT), [knownModels]);
  const filtered = Boolean(model.trim() || phase !== "all" || search.trim());
  const requestSeries = useMemo(() => toRequestSeries(series), [series]);
  const chartDescription = useMemo(() => {
    const window = series?.minutes ?? 60;
    const count = total !== null ? total : logs.length;
    const scope = filtered ? "matching the current filters" : "across the ledger";
    return `Last ${window} minutes ${scope}. Primary bars are request volume; red marks intervals that include errors. ${count} ${count === 1 ? "record" : "records"} loaded.`;
  }, [series?.minutes, total, logs.length, filtered]);

  return (
    <div className="flex h-[calc(100svh-6rem)] flex-col gap-3 md:h-[calc(100svh-3rem)]">
      <div className="flex shrink-0 items-center justify-between gap-4">
        <h1 className="shrink-0 text-lg font-semibold tracking-tight">Logs</h1>
        <div className="flex min-w-0 flex-nowrap items-center justify-end gap-2">
          <Select value={phase} onValueChange={(value) => setPhase(String(value))}>
            <SelectTrigger className="h-9 w-[7.5rem] shrink-0" aria-label="Phase">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">all phases</SelectItem>
              <SelectItem value="plan">plan</SelectItem>
              <SelectItem value="execute">execute</SelectItem>
              <SelectItem value="utility">utility</SelectItem>
              <SelectItem value="chat">chat</SelectItem>
            </SelectContent>
          </Select>

          <Autocomplete
            value={model}
            onChange={setModel}
            options={suggestions.map((known) => ({ value: known, label: known }))}
            placeholder="Model"
            emptyText="No recorded model matches — the typed id is used as-is."
            className="w-44 shrink-0"
          />

          <Input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Search…"
            autoComplete="off"
            className="h-9 w-40 shrink-0"
            aria-label="Search logs"
          />

          {filtered || searchDraft.trim() ? (
            <Button
              variant="ghost"
              className="h-9 shrink-0 px-2.5 text-muted-foreground"
              onClick={() => {
                setPhase("all");
                setModel("");
                setSearchDraft("");
                setSearch("");
              }}
            >
              Clear
            </Button>
          ) : null}

          <Button
            variant="outline"
            className="h-9 shrink-0 gap-2 px-3"
            aria-pressed={live}
            title={live ? "Pause live stream" : "Resume live stream"}
            onClick={() => setLive((current) => !current)}
          >
            <span
              className={cn(
                "size-2 rounded-full",
                streamStatus === "live"
                  ? "animate-pulse bg-emerald-500"
                  : streamStatus === "connecting"
                    ? "animate-pulse bg-amber-500"
                    : "bg-muted-foreground/50",
              )}
            />
            <span className="capitalize">
              {streamStatus === "live"
                ? "Live"
                : streamStatus === "connecting"
                  ? "Connecting"
                  : "Paused"}
            </span>
          </Button>

          <Button variant="outline" className="h-9 shrink-0" onClick={() => void loadInitial()}>
            Refresh
          </Button>
        </div>
      </div>

      {error ? <p className="shrink-0 text-xs text-destructive">{error}</p> : null}

      <div className="shrink-0">
        <RequestsChart
          series={requestSeries}
          title="Requests over time"
          description={chartDescription}
          compact
        />
      </div>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border">
        <div className="grid shrink-0 grid-cols-12 gap-2 border-b bg-muted/40 px-4 py-2.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          <div className="col-span-1">Time</div>
          <div className="col-span-3">Model</div>
          <div className="col-span-2">Provider</div>
          <div className="col-span-1">Phase</div>
          <div className="col-span-1">Effort</div>
          <div className="col-span-1">Status</div>
          <div className="col-span-1">Cost</div>
          <div className="col-span-1">Latency</div>
          <div className="col-span-1 text-right">Details</div>
        </div>

        <div
          ref={scrollContainerRef}
          className="relative min-h-0 flex-1 divide-y divide-border/40 overflow-x-hidden overflow-y-auto"
        >
          {loadingInitial ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground animate-pulse">
              Loading requests...
            </div>
          ) : logs.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              {filtered
                ? "No requests match these filters."
                : "No traffic yet — proxied requests will stream in here."}
            </div>
          ) : (
            <div style={{ height: `${totalHeight}px`, width: "100%", position: "relative" }}>
              {virtualItems.map((virtualRow) => {
                const log = logs[virtualRow.index];
                if (!log) return null;
                const key = logKey(log);
                const isNew = newLogIds.has(key);

                return (
                  <div
                    key={key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    onClick={() => {
                      if (log.id) void navigate(`/logs/${log.id}`);
                    }}
                    className={cn(
                      "grid grid-cols-12 items-center gap-2 px-4 py-2.5 text-xs transition-colors hover:bg-muted/60",
                      log.id ? "cursor-pointer" : "",
                      isNew ? "animate-flash-new" : "",
                    )}
                    title={log.id ? "Open request details" : "No record ID captured"}
                  >
                    <div className="col-span-1 font-mono whitespace-nowrap text-muted-foreground">
                      {formatTime(log.ts)}
                    </div>
                    <div className="col-span-3 flex min-w-0 items-center gap-1.5 pr-2">
                      <span className="truncate font-medium text-foreground">{log.model}</span>
                      {log.billing === "subscription" ? (
                        <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">
                          sub
                        </Badge>
                      ) : null}
                    </div>
                    <div className="col-span-2 flex min-w-0 items-center gap-1.5">
                      <ProviderLogo id={log.provider} />
                      <span className="truncate text-muted-foreground">
                        {providerDisplayName(log.provider)}
                      </span>
                    </div>
                    <div className="col-span-1">
                      <Badge
                        variant={
                          log.phase === "plan"
                            ? "default"
                            : log.phase === "execute"
                              ? "secondary"
                              : "outline"
                        }
                        className="text-[10px]"
                      >
                        {log.phase ?? "-"}
                      </Badge>
                    </div>
                    <div className="col-span-1">
                      {log.effort ? (
                        <Badge
                          variant="outline"
                          title={log.effortNote ?? undefined}
                          className="text-[10px]"
                        >
                          {log.effort}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">default</span>
                      )}
                    </div>
                    <div
                      className={cn(
                        "col-span-1 font-mono font-medium",
                        log.status >= 400 ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {log.status}
                    </div>
                    <div className="col-span-1 font-mono text-muted-foreground">
                      {log.costUsd === null ? "—" : money(log.costUsd)}
                    </div>
                    <div className="col-span-1 font-mono text-muted-foreground">
                      {log.latencyMs}ms
                    </div>
                    <div className="col-span-1 text-right text-muted-foreground">
                      {log.id ? "details →" : "no id"}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {loadingMore ? (
            <div className="border-t bg-muted/20 py-2.5 text-center text-xs text-muted-foreground animate-pulse">
              Loading older records...
            </div>
          ) : nextBefore === null && logs.length > 0 ? (
            <div className="border-t bg-muted/10 py-2.5 text-center text-xs text-muted-foreground">
              Beginning of ledger reached ({logs.length} records)
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
