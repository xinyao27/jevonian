import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, type KeyView } from "@/lib/api";
import { money } from "@/lib/utils";

/** Parses a limit field. Blank means "no limit"; anything unusable is rejected. */
function parseLimitInput(value: string): { ok: true; limit: number | null } | { ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, limit: null };
  const parsed = Number.parseFloat(trimmed.replace(/^\$/, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return { ok: false };
  return { ok: true, limit: parsed };
}

function usagePercent(spend: number, limit: number | null | undefined): number {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, (spend / limit) * 100);
}

export function KeysPage() {
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [name, setName] = useState("my-agent");
  const [newLimit, setNewLimit] = useState("");
  const [createdKey, setCreatedKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Which key's limit is open for editing, and the in-progress value.
  const [editingLimitId, setEditingLimitId] = useState<string | null>(null);
  const [limitDraft, setLimitDraft] = useState("");
  const [limitError, setLimitError] = useState("");

  const load = useCallback(async () => {
    try {
      const state = await api.state();
      setKeys(state.keys);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError("");
    setMessage("");
    const parsed = parseLimitInput(newLimit);
    if (!parsed.ok) {
      setError("Credit limit must be a positive number of dollars, or left blank for unlimited.");
      setBusy(false);
      return;
    }
    try {
      const result = await api.createKey(name, parsed.limit);
      setCreatedKey(result.key);
      setCopied(false);
      setCopyError("");
      setNewLimit("");
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveLimit(key: KeyView) {
    const parsed = parseLimitInput(limitDraft);
    if (!parsed.ok) {
      setLimitError("Enter a positive dollar amount, or leave blank for unlimited.");
      return;
    }
    setBusy(true);
    setLimitError("");
    try {
      const result = await api.updateKey(key.id, { limitUsd: parsed.limit });
      setKeys(result.keys);
      setEditingLimitId(null);
      setLimitDraft("");
      setMessage(
        parsed.limit === null
          ? `Removed the credit limit on “${key.name}”.`
          : `Set a $${parsed.limit.toFixed(2)} credit limit on “${key.name}”.`,
      );
      await load();
    } catch (cause) {
      setLimitError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function copyCreatedKey() {
    try {
      await navigator.clipboard.writeText(createdKey);
      setCopyError("");
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch (cause) {
      setCopyError(`Could not copy: ${String(cause)}`);
    }
  }

  async function revoke(key: KeyView) {
    // Capture whether this was the last key *before* awaiting, since the list reloads after.
    const wasLast = keys.length <= 1;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.revokeKey(key.id);
      setConfirmingId(null);
      setMessage(
        wasLast
          ? `Revoked the last Jevonian key “${key.name}”. Local /v1 requests are unauthenticated again until you create a new key.`
          : `Revoked key “${key.name}”. Requests using it now fail with 401.`,
      );
      setCreatedKey("");
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Jevonian access keys</h1>
        <p className="text-sm text-muted-foreground">
          Keys Jevonian issues so agents can call this router. They are not upstream provider
          secrets — those live in Providers and stay on this machine.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          While at least one key exists, every request to <code>/v1</code> must send it as{" "}
          <code>authorization: Bearer …</code> or <code>x-api-key</code>. With none, local{" "}
          <code>/v1</code> requests are accepted unauthenticated and the tunnel stays disabled.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Create key</CardTitle>
          <CardDescription>
            Give it a name so you can revoke it later. An optional credit limit stops requests once
            estimated pay-as-you-go spend reaches that amount.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex w-64 flex-col gap-1.5">
              <Label htmlFor="keyName">Name</Label>
              <Input id="keyName" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="flex w-40 flex-col gap-1.5">
              <Label htmlFor="keyLimit">Credit limit (USD)</Label>
              <Input
                id="keyLimit"
                inputMode="decimal"
                placeholder="unlimited"
                value={newLimit}
                onChange={(event) => setNewLimit(event.target.value)}
              />
            </div>
            <Button onClick={() => void create()} disabled={busy || !name}>
              Generate key
            </Button>
          </div>
          {createdKey ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40">
              <p className="mb-2 text-xs text-muted-foreground">
                Copy it now — it is shown only once.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-md bg-background px-2 py-1 text-xs">
                  {createdKey}
                </code>
                <Button size="sm" variant="outline" onClick={() => void copyCreatedKey()}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              {copied ? (
                <p className="mt-2 text-xs text-muted-foreground">Copied to clipboard.</p>
              ) : null}
              {copyError ? <p className="mt-2 text-xs text-destructive">{copyError}</p> : null}
            </div>
          ) : null}
          {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active keys</CardTitle>
          <CardDescription>
            {keys.length === 0
              ? "No keys yet"
              : `${keys.length} key${keys.length === 1 ? "" : "s"} · usage is estimated from the local ledger`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>name</TableHead>
                <TableHead>prefix</TableHead>
                <TableHead className="text-right">key usage</TableHead>
                <TableHead>key limit</TableHead>
                <TableHead>last used</TableHead>
                <TableHead className="text-right">requests</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => {
                const spend = key.spendUsd ?? 0;
                const subscription = key.subscriptionUsd ?? 0;
                const limit = key.limitUsd ?? null;
                const pct = usagePercent(spend, limit);
                const overLimit = limit !== null && spend >= limit;
                const nearLimit = limit !== null && !overLimit && pct >= 80;
                return (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <span>{key.name}</span>
                        {overLimit ? (
                          <Badge variant="destructive" className="text-[10px]">
                            limit reached
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{key.prefix}…</TableCell>
                    <TableCell className="text-right">
                      <span className="font-mono text-xs font-medium">{money(spend)}</span>
                      {subscription > 0 ? (
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          +{money(subscription)} sub
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="min-w-[190px]">
                      {editingLimitId === key.id ? (
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-1.5">
                            <Input
                              autoFocus
                              inputMode="decimal"
                              placeholder="unlimited"
                              className="h-8 w-28 text-xs"
                              value={limitDraft}
                              onChange={(event) => setLimitDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void saveLimit(key);
                                if (event.key === "Escape") {
                                  setEditingLimitId(null);
                                  setLimitDraft("");
                                  setLimitError("");
                                }
                              }}
                            />
                            <Button
                              size="sm"
                              className="h-8"
                              onClick={() => void saveLimit(key)}
                              disabled={busy}
                            >
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8"
                              onClick={() => {
                                setEditingLimitId(null);
                                setLimitDraft("");
                                setLimitError("");
                              }}
                              disabled={busy}
                            >
                              Cancel
                            </Button>
                          </div>
                          {limitError ? (
                            <span className="text-[10px] text-destructive">{limitError}</span>
                          ) : null}
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="flex w-full flex-col items-start gap-1.5 text-left"
                          onClick={() => {
                            setEditingLimitId(key.id);
                            setLimitDraft(limit === null ? "" : String(limit));
                            setLimitError("");
                          }}
                          title="Click to edit the credit limit"
                        >
                          <span className="flex items-center gap-2">
                            <span className="border-b border-dotted border-muted-foreground/60 font-mono text-xs">
                              {limit === null
                                ? "unlimited"
                                : `$${limit.toFixed(limit % 1 === 0 ? 0 : 2)}`}
                            </span>
                            <Badge
                              variant="outline"
                              className="h-5 px-1.5 text-[9px] tracking-wider"
                            >
                              TOTAL
                            </Badge>
                          </span>
                          <span className="h-1 w-full overflow-hidden rounded-full bg-muted">
                            <span
                              className={`block h-full rounded-full ${
                                overLimit
                                  ? "bg-destructive"
                                  : nearLimit
                                    ? "bg-amber-500"
                                    : "bg-foreground"
                              }`}
                              style={{
                                width: `${limit === null ? 0 : Math.max(pct, spend > 0 ? 2 : 0)}%`,
                              }}
                            />
                          </span>
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "never"}
                    </TableCell>
                    <TableCell className="text-right text-xs">{key.requests}</TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {confirmingId === key.id ? (
                        <span className="flex items-center justify-end gap-2 text-xs">
                          <span className="text-muted-foreground">
                            {keys.length <= 1
                              ? "Revoke? Local /v1 requests become unauthenticated again."
                              : "Revoke this key? Requests using it start failing with 401."}
                          </span>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => void revoke(key)}
                            disabled={busy}
                          >
                            Revoke
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmingId(null)}
                            disabled={busy}
                          >
                            Cancel
                          </Button>
                        </span>
                      ) : (
                        <span className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmingId(key.id)}
                            disabled={busy}
                          >
                            Revoke
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {keys.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-sm text-muted-foreground">
                    No keys yet — requests are currently accepted without authentication.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          <p className="mt-3 text-xs text-muted-foreground">
            Usage is estimated from ledger records attributed to each key. See{" "}
            <Link to="/activity" className="underline hover:text-foreground">
              Activity
            </Link>{" "}
            for per-model and time-series breakdowns.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
