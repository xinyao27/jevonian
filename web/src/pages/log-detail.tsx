import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import { LogDetailSkeleton } from "@/components/page-skeletons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type LogDetailResponse, type LogRecord } from "@/lib/api";
import { formatTime, money } from "@/lib/utils";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 border-b py-1.5 text-sm last:border-b-0">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-right">{children}</span>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-md border px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-sm font-medium break-words">{value}</p>
      {hint ? <p className="text-[11px] break-words text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function RawBlock({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="rounded-md border">
      <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
        {summary}
      </summary>
      <div className="border-t p-3">{children}</div>
    </details>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-xs break-words whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function promptMessages(body: unknown): Array<{ role: string; content: unknown }> | undefined {
  const record = (body ?? {}) as Record<string, unknown>;
  const source = Array.isArray(record.messages)
    ? record.messages
    : Array.isArray(record.input)
      ? record.input
      : undefined;
  if (!source) return undefined;
  return source.map((raw) => {
    const message = (raw ?? {}) as Record<string, unknown>;
    return {
      role: typeof message.role === "string" ? message.role : ((message.type as string) ?? "item"),
      content: message.content ?? message.parts ?? raw,
    };
  });
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const record = (block ?? {}) as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        return JSON.stringify(record);
      })
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function sentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

/** One-line, human-readable summary of the routing verdict a brain call returned. */
function verdictSummary(verdict: Record<string, unknown>): string {
  const parts: string[] = [];
  const model = textOf(verdict.model);
  parts.push(model ? `picked ${model}` : "returned no model");
  // The thinking level the brain asked for, when it answered the effort question.
  const effort = textOf(verdict.effort);
  if (effort) parts.push(`thinking ${effort}`);
  if (typeof verdict.confidence === "number") {
    parts.push(`confidence ${(verdict.confidence * 100).toFixed(0)}%`);
  }
  return parts.length > 0 ? sentence(parts.join(" · ")) : "The brain returned a verdict.";
}

/** Ranked option list from a SystemOne probability map, highest first. */
function probabilityRanking(raw: unknown): Array<{ option: string; score: number }> {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>)
    .flatMap(([option, value]) =>
      typeof value === "number" && Number.isFinite(value) ? [{ option, score: value }] : [],
    )
    .sort((left, right) => right.score - left.score || left.option.localeCompare(right.option));
}

function formatPercent(score: number): string {
  return `${(score * 100).toFixed(score >= 0.1 || score === 0 ? 0 : 1)}%`;
}

/** One-line summary of the state the router sent to the brain. */
function stateSummary(state: Record<string, unknown>): string {
  const parts: string[] = [];
  const message = textOf(state.first_user_message);
  if (message) {
    const trimmed = message.length > 140 ? `${message.slice(0, 140)}…` : message;
    parts.push(`first user message: “${trimmed.replaceAll("\n", " ")}”`);
  }
  const tools = state.tools;
  if (Array.isArray(tools)) parts.push(`${tools.length} tool${tools.length === 1 ? "" : "s"}`);
  const count = (key: string): number | undefined =>
    Array.isArray(state[key]) ? (state[key] as unknown[]).length : undefined;
  const messages = count("messages") ?? count("input");
  if (messages !== undefined) parts.push(`${messages} message${messages === 1 ? "" : "s"}`);
  const transcript = textOf(state.transcript);
  if (transcript) {
    const trimmed = transcript.length > 140 ? `${transcript.slice(0, 140)}…` : transcript;
    parts.push(`transcript: “${trimmed.replaceAll("\n", " ")}”`);
  }
  const session = textOf(state.session);
  if (session) parts.push(`session ${session}`);
  return parts.length > 0
    ? sentence(parts.join(" · "))
    : "The router sent routing state to the brain; expand the raw JSON to inspect it.";
}

function BrainSummary({ verdict, state }: { verdict?: unknown; state?: unknown }) {
  const verdictRecord =
    verdict && typeof verdict === "object" ? (verdict as Record<string, unknown>) : undefined;
  const stateRecord =
    state && typeof state === "object" ? (state as Record<string, unknown>) : undefined;
  const ranking = verdictRecord ? probabilityRanking(verdictRecord.probabilities) : [];
  const effortRanking = verdictRecord ? probabilityRanking(verdictRecord.effortProbabilities) : [];
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm">
      <p className="break-words">
        <span className="text-muted-foreground">Verdict: </span>
        {verdictRecord ? verdictSummary(verdictRecord) : "No verdict was captured for this call."}
      </p>
      {ranking.length > 0 ? (
        <div className="min-w-0">
          <p className="text-muted-foreground">All decisions:</p>
          <ul className="mt-1 list-none space-y-0.5 font-mono text-xs">
            {ranking.map(({ option, score }, index) => (
              <li
                key={option}
                className={`break-all ${index === 0 ? "font-medium text-foreground" : ""}`}
              >
                {formatPercent(score).padStart(4)} {option}
                {index === 0 ? " ← chosen" : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {effortRanking.length > 0 ? (
        <div className="min-w-0">
          <p className="text-muted-foreground">Effort:</p>
          <ul className="mt-1 list-none space-y-0.5 font-mono text-xs">
            {effortRanking.map(({ option, score }, index) => (
              <li
                key={option}
                className={`break-all ${index === 0 ? "font-medium text-foreground" : ""}`}
              >
                {formatPercent(score).padStart(4)} {option}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="break-words text-muted-foreground">
        {stateRecord ? stateSummary(stateRecord) : "No brain state was captured for this call."}
      </p>
    </div>
  );
}

function decisionRows(record: LogRecord): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  rows.push({ label: "provider · model", value: `${record.provider} · ${record.model}` });
  if (record.requestedModel && record.requestedModel !== record.model) {
    rows.push({ label: "you requested", value: record.requestedModel });
  }
  rows.push({ label: "phase", value: record.phase ?? "-" });
  // The thinking level the model was actually sent. "default" means no level was applied, so
  // the provider's own default is in force.
  rows.push({ label: "thinking effort", value: record.effort ?? "default" });
  if (record.effortNote) rows.push({ label: "effort note", value: record.effortNote });
  rows.push({ label: "reason", value: record.reason ?? "-" });
  if (record.retries) {
    rows.push({
      label: "network retries",
      value: `${record.retries} (transient upstream failure, recovered)`,
    });
  }
  const brain = [record.brain ?? "-", record.brainChannel ?? ""].filter(Boolean).join(" · ");
  rows.push({ label: "brain", value: brain });
  if (record.skipped && record.skipped.length > 0) {
    rows.push({
      label: "models withheld",
      value: record.skipped
        .map((entry) => `${entry.provider}/${entry.model} (${entry.reason}: ${entry.detail})`)
        .join("; "),
    });
  }
  if (record.error) rows.push({ label: "error", value: record.error });
  return rows;
}

function buildBundle(detail: LogDetailResponse): string {
  const { record } = detail;
  const lines: string[] = [
    `# Jevonian ${record.kind === "brain" ? "routing brain call" : "request"} ${record.id ?? ""}`,
    "",
  ];
  lines.push(
    `- time: ${record.ts}`,
    `- status: ${record.status}`,
    `- provider/model: ${record.provider} / ${record.model}`,
    `- requested: ${record.requestedModel ?? "-"}`,
    `- phase: ${record.phase ?? "-"}`,
    `- thinking effort: ${record.effort ?? "default"}${record.effortNote ? ` (${record.effortNote})` : ""}`,
    `- reason: ${record.reason ?? "-"}`,
    ...(record.retries
      ? [`- network retries: ${record.retries} (transient upstream failure, recovered)`]
      : []),
    `- brain: ${record.brain ?? "-"}${record.brainChannel ? ` (channel ${record.brainChannel})` : ""}`,
    ...(record.skipped && record.skipped.length > 0
      ? [
          `- models withheld: ${record.skipped
            .map((entry) => `${entry.provider}/${entry.model} (${entry.reason}: ${entry.detail})`)
            .join("; ")}`,
        ]
      : []),
    `- session: ${record.session}`,
    `- tokens: ${record.promptTokens} in / ${record.completionTokens} out / ${record.cacheReadTokens} cached`,
    `- cost: ${record.costUsd ?? "-"}${record.billing ? ` (${record.billing})` : ""}`,
    `- latency: ${record.latencyMs}ms`,
    ...(record.error ? [`- error: ${record.error}`] : []),
    ...(record.requestId ? [`- parent request: ${record.requestId}`] : []),
  );

  const body = (detail.body ?? {}) as Record<string, unknown>;
  if (record.kind === "brain") {
    lines.push("", "## Brain state", "```json", JSON.stringify(body.state ?? null, null, 2), "```");
    lines.push("", "## Verdict", "```json", JSON.stringify(body.verdict ?? null, null, 2), "```");
    return lines.join("\n");
  }

  const messages = promptMessages(body.body);
  lines.push("", "## Prompt");
  if (messages) {
    for (const message of messages) {
      lines.push(`### ${message.role}`, "```", contentText(message.content), "```");
    }
  } else {
    lines.push("```json", JSON.stringify(body.body ?? detail.body ?? null, null, 2), "```");
  }
  lines.push(
    "",
    "## Raw request JSON",
    "```json",
    JSON.stringify(body.body ?? null, null, 2),
    "```",
  );

  if (detail.brainCalls.length > 0) {
    lines.push("", `## Routing brain calls (${detail.brainCalls.length}, fallback order)`);
    detail.brainCalls.forEach((call, index) => {
      const data = (call.body ?? {}) as Record<string, unknown>;
      lines.push(
        "",
        `### ${index + 1}. ${call.record.provider} · ${call.record.model} · status ${call.record.status} · ${call.record.latencyMs}ms · ${call.record.promptTokens}/${call.record.completionTokens} tokens`,
      );
      if (data.verdict) {
        lines.push("verdict:", "```json", JSON.stringify(data.verdict, null, 2), "```");
      }
      if (data.state) {
        lines.push("state:", "```json", JSON.stringify(data.state, null, 2), "```");
      }
    });
  }
  return lines.join("\n");
}

function RecordMeta({ record }: { record: LogRecord }) {
  return (
    <div className="flex flex-col">
      <Row label="time">{new Date(record.ts).toLocaleString()}</Row>
      <Row label="status">
        <span className={record.status >= 400 ? "text-destructive" : ""}>{record.status}</span>
      </Row>
      <Row label="session">{record.session}</Row>
      <Row label="tokens">
        {record.promptTokens} in · {record.completionTokens} out · {record.cacheReadTokens} cached
        {record.cacheWriteTokens > 0 ? ` · ${record.cacheWriteTokens} written` : ""}
      </Row>
      <Row label="cost">
        {record.costUsd === null ? "—" : money(record.costUsd)}
        {record.billing === "subscription" ? " (subscription value)" : ""}
      </Row>
      <Row label="latency">
        {record.latencyMs}ms · {record.stream ? "streamed" : "buffered"}
      </Row>
    </div>
  );
}

export function LogDetailPage() {
  const { id = "" } = useParams();
  const [detail, setDetail] = useState<LogDetailResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [error, setError] = useState("");

  async function copyContext(): Promise<void> {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(buildBundle(detail));
      setCopied(true);
      setCopyError("");
      setTimeout(() => setCopied(false), 1_500);
    } catch (cause) {
      setCopyError(String(cause));
    }
  }

  const load = useCallback(async () => {
    try {
      setDetail(await api.logDetail(id));
    } catch (cause) {
      setError(String(cause));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!detail) return <LogDetailSkeleton />;

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const messages = promptMessages(body.body);
  const record = detail.record;
  const isBrain = record.kind === "brain";
  const verdict = body.verdict;
  const state = body.state;
  const hasCalls = detail.brainCalls.length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Link to="/logs" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Logs
        </Link>
        <h1 className="min-w-0 text-lg font-semibold">
          {isBrain ? "Routing brain call" : "Request"} · {formatTime(record.ts)}
        </h1>
        {record.requestId ? (
          <Link
            to={`/logs/${record.requestId}`}
            className="text-xs text-muted-foreground underline underline-offset-4"
          >
            parent request
          </Link>
        ) : null}
        <Button size="sm" className="ml-auto" onClick={() => void copyContext()}>
          {copied ? "Copied" : "Copy context"}
        </Button>
        {copied ? (
          <span className="text-xs text-muted-foreground">Copied to clipboard.</span>
        ) : null}
        {copyError ? <span className="text-xs text-destructive">{copyError}</span> : null}
      </div>

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>Decision summary</CardTitle>
          <CardDescription>
            {isBrain
              ? "Why the router asked the brain, and what it answered."
              : "What the router picked for this turn and how it performed."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="status" value={String(record.status)} />
            <Stat label="cost" value={record.costUsd === null ? "—" : money(record.costUsd)} />
            <Stat label="latency" value={`${record.latencyMs}ms`} />
            <Stat
              label="tokens"
              value={`${record.promptTokens} in / ${record.completionTokens} out`}
              hint={`${record.cacheReadTokens} cached read${
                record.cacheWriteTokens > 0 ? ` · ${record.cacheWriteTokens} cached write` : ""
              }`}
            />
          </div>

          {isBrain ? <BrainSummary verdict={verdict} state={state} /> : null}

          <div className="flex min-w-0 flex-col">
            {decisionRows(record).map((row) => (
              <Row key={row.label} label={row.label}>
                {row.value}
              </Row>
            ))}
          </div>

          <RawBlock summary={isBrain ? "Raw brain state and verdict" : "Raw record fields"}>
            {isBrain ? (
              <div className="flex flex-col gap-3">
                <Json value={state ?? null} />
                <Json value={verdict ?? null} />
              </div>
            ) : (
              <Json value={record} />
            )}
          </RawBlock>
        </CardContent>
      </Card>

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>Request metadata</CardTitle>
          <CardDescription className="break-all">
            id {record.id ?? "-"} {record.requestId ? `· request ${record.requestId}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">
          <RecordMeta record={record} />
        </CardContent>
      </Card>

      {hasCalls ? (
        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <CardTitle>Routing brain</CardTitle>
            <CardDescription>
              {detail.brainCalls.length} call{detail.brainCalls.length === 1 ? "" : "s"} for this
              turn, in fallback order
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-4">
            {detail.brainCalls.map(({ record: call, body: callBody }) => {
              const data = (callBody ?? {}) as Record<string, unknown>;
              return (
                <div
                  key={call.id ?? call.ts}
                  className="flex min-w-0 flex-col gap-3 rounded-md border p-3"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                    <Badge variant={call.status === 200 ? "secondary" : "destructive"}>
                      {call.status}
                    </Badge>
                    <span className="font-medium">{call.provider}</span>
                    <span className="min-w-0 break-all text-muted-foreground">{call.model}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {call.latencyMs}ms · {call.promptTokens} in / {call.completionTokens} out
                      {call.costUsd === null ? "" : ` · ${money(call.costUsd)}`}
                    </span>
                  </div>
                  <BrainSummary verdict={data.verdict} state={data.state} />
                  <RawBlock summary="Raw state and verdict for this call">
                    <div className="flex flex-col gap-3">
                      {data.state ? <Json value={data.state} /> : null}
                      {data.verdict ? <Json value={data.verdict} /> : null}
                    </div>
                  </RawBlock>
                  {call.id ? (
                    <Link
                      to={`/logs/${call.id}`}
                      className="self-start text-xs text-muted-foreground underline underline-offset-4"
                    >
                      Open this brain call
                    </Link>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {isBrain ? null : (
        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <CardTitle>Prompt</CardTitle>
            <CardDescription>
              {messages ? `${messages.length} messages` : "request body"} captured for this request
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-3">
            {messages ? (
              <>
                {messages.map((message, index) => (
                  <div
                    key={`${message.role}-${index}`}
                    className="flex min-w-0 flex-col gap-1 rounded-md border p-3"
                  >
                    <span className="text-xs font-medium text-muted-foreground">
                      {message.role}
                    </span>
                    <pre className="max-h-72 overflow-auto text-xs break-words whitespace-pre-wrap">
                      {contentText(message.content)}
                    </pre>
                  </div>
                ))}
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    raw request JSON
                  </summary>
                  <Json value={body.body} />
                </details>
              </>
            ) : (
              <Json value={body.body ?? detail.body} />
            )}
            <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              Prompts are captured on this machine only, stored with 0600 permissions under the
              Jevonian data directory, and never leave the device. Set{" "}
              <code>JEVONIAN_CAPTURE_BODIES=0</code> to stop capturing them.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
