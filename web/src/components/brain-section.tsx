import { useCallback, useState } from "react";

import { KeysHelp } from "@/components/keys-help";
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
import { api, type BrainChannelView, type BrainView, type StateResponse } from "@/lib/api";

const ADD_TEMPLATE: BrainView = {
  channel: "typesafe",
  timeoutMs: 1_500,
  minConfidence: 0.6,
};

function channelOf(channels: BrainChannelView[], id: string): BrainChannelView | undefined {
  return channels.find((channel) => channel.id === id);
}

function keyLabel(view: { keySource?: string }): string {
  if (view.keySource && view.keySource !== "none") return view.keySource;
  return "none";
}

export function BrainSection({
  state,
  onSaved,
}: {
  state: StateResponse;
  onSaved: (state: StateResponse) => void;
}) {
  const brains = state.config.routing.brains ?? [];
  const channels = state.brainChannels;
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<BrainView>(ADD_TEMPLATE);
  const [key, setKey] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const saved = typeof editing === "number" ? brains[editing] : undefined;
  const active = channelOf(channels, draft.channel);
  const dirty =
    editing === "new" ||
    key.length > 0 ||
    draft.channel !== saved?.channel ||
    (draft.baseUrl ?? "") !== (saved?.baseUrl ?? "") ||
    (draft.accountId ?? "") !== (saved?.accountId ?? "") ||
    (draft.model ?? "") !== (saved?.model ?? "") ||
    (draft.apiKeyEnv ?? "") !== (saved?.apiKeyEnv ?? "") ||
    draft.timeoutMs !== saved?.timeoutMs ||
    draft.minConfidence !== saved?.minConfidence ||
    Boolean(draft.fullPrompt) !== Boolean(saved?.fullPrompt);

  const applyChannels = useCallback(
    (next: BrainView[]) => {
      onSaved({
        ...state,
        config: { ...state.config, routing: { ...state.config.routing, brains: next } },
      });
    },
    [state, onSaved],
  );

  function beginAdd(): void {
    setDraft(ADD_TEMPLATE);
    setKey("");
    setResult("");
    setError("");
    setMessage("");
    setEditing("new");
  }

  function beginEdit(index: number): void {
    const current = brains[index];
    if (!current) return;
    setDraft({ ...current });
    setKey("");
    setResult("");
    setError("");
    setMessage("");
    setEditing(index);
  }

  const applyChannel = useCallback(
    (id: string) => {
      const preset = channelOf(channels, id);
      setDraft((current) => ({
        ...current,
        channel: id,
        baseUrl: preset?.requiresAccountId ? "" : (preset?.baseUrl ?? ""),
        accountId: preset?.requiresAccountId
          ? current.channel === id
            ? current.accountId
            : ""
          : "",
        model: preset?.model ?? "",
        apiKeyEnv: preset?.apiKeyEnv ?? "",
      }));
      setKey("");
      setResult("");
    },
    [channels],
  );

  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const payload = { ...draft, ...(key ? { apiKey: key } : {}) };
      const response =
        editing === "new"
          ? await api.addBrain(payload)
          : await api.updateBrain(editing as number, payload);
      applyChannels(response.brains);
      setKey("");
      setResult("");
      setEditing(null);
      setMessage("Brain saved");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setResult("");
    setError("");
    try {
      const response = await api.testBrain({
        ...draft,
        ...(key ? { apiKey: key } : {}),
      });
      const latency =
        typeof response.latencyMs === "number" ? `${response.latencyMs}ms` : undefined;
      if (response.ok && response.verdict) {
        const ranking = Object.entries(response.verdict.probabilities ?? {})
          .sort(([, left], [, right]) => right - left)
          .map(([option, score]) => `${option} ${(score * 100).toFixed(0)}%`)
          .join(" · ");
        const detail = ranking
          ? ranking
          : `chose ${response.verdict.model} · confidence ${(response.verdict.confidence * 100).toFixed(0)}%`;
        setResult([response.channel ?? "brain", latency, detail].filter(Boolean).join(" · "));
      } else {
        setResult([latency, response.error ?? "no verdict"].filter(Boolean).join(" · "));
      }
    } catch (cause) {
      setResult(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(index: number) {
    if (
      !window.confirm(
        "Remove this brain? Brains after it move up; the stored key is deleted when no other brain uses that channel.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await api.deleteBrain(index);
      applyChannels(response.brains);
      if (editing === index) setEditing(null);
      setMessage("Brain removed");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function move(index: number, direction: "up" | "down") {
    setBusy(true);
    setError("");
    try {
      const response = await api.moveBrain(index, direction);
      applyChannels(response.brains);
      setMessage("Fallback order updated");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="routing-brain">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>Routing brain</CardTitle>
          <CardDescription>
            Tried top to bottom on every routed turn; the first confident verdict wins. Adding one
            is required before <code>jevonian/auto</code> can route.
          </CardDescription>
        </div>
        {editing === null ? (
          <Button variant="outline" size="sm" onClick={beginAdd} disabled={busy}>
            Add brain
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>order</TableHead>
              <TableHead>channel</TableHead>
              <TableHead>key</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {brains.map((brain, index) => (
              <TableRow key={`${brain.channel}-${index}`}>
                <TableCell className="text-xs text-muted-foreground">
                  {index + 1}
                  {index === 0 ? " · primary" : ""}
                  {index > 0 ? " · fallback" : ""}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {`${channelOf(channels, brain.channel)?.label ?? brain.channel}${brain.model ? ` · ${brain.model}` : ""}${brain.accountId ? ` · ${brain.accountId}` : ""}`}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={keyLabel(brain) === "none" ? "destructive" : "secondary"}
                    className="text-[10px]"
                  >
                    {keyLabel(brain)}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void move(index, "up")}
                    disabled={busy || index === 0}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void move(index, "down")}
                    disabled={busy || index === brains.length - 1}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => beginEdit(index)}
                    disabled={busy}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void remove(index)}
                    disabled={busy}
                  >
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {brains.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-sm text-muted-foreground">
                  No brain configured — jevonian/auto is disabled until you add one.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>

        {editing === null ? (
          <div className="flex items-center gap-3">
            {brains.length > 0 ? (
              <span className="text-xs text-muted-foreground">
                Tried in this order; add more for redundancy.
              </span>
            ) : null}
            {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
            {error ? <span className="text-xs text-destructive">{error}</span> : null}
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="brainChannel">Channel</Label>
                  <Select
                    value={draft.channel}
                    onValueChange={(value) => applyChannel(String(value))}
                  >
                    <SelectTrigger id="brainChannel" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {channels.map((channel) => (
                        <SelectItem key={channel.id} value={channel.id}>
                          {channel.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-[11px] text-muted-foreground">
                    Where the brain asks for a verdict; picking a channel loads its defaults.
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="brainKey">API key</Label>
                  <Input
                    id="brainKey"
                    type="password"
                    value={key}
                    placeholder={
                      saved?.keySource && saved.keySource !== "none"
                        ? `set (${saved.keySource}) — paste to replace`
                        : "stored per channel (0600)"
                    }
                    onChange={(event) => setKey(event.target.value)}
                  />
                  <KeysHelp keysUrl={active?.keysUrl} hint={active?.hint} />
                  <span className="text-[11px] text-muted-foreground">
                    Stored encrypted on this machine; leave empty to keep the stored key.
                  </span>
                </div>
                {active?.requiresAccountId ? (
                  <div className="col-span-2 flex flex-col gap-1.5">
                    <Label htmlFor="brainAccountId">Account ID</Label>
                    <Input
                      id="brainAccountId"
                      value={draft.accountId ?? ""}
                      placeholder="Cloudflare account id from the dashboard overview"
                      onChange={(event) => setDraft({ ...draft, accountId: event.target.value })}
                    />
                    <span className="text-[11px] text-muted-foreground">
                      Used to call{" "}
                      <code className="text-[10px]">/client/v4/accounts/{"{id}"}/ai/run</code> with
                      model <code className="text-[10px]">{active.model || "typesafe/jev"}</code>.
                    </span>
                  </div>
                ) : null}
              </div>

              <details className="rounded-md border">
                <summary className="cursor-pointer select-none px-4 py-2 text-sm font-medium">
                  Advanced settings
                </summary>
                <div className="flex flex-col gap-4 border-t p-4">
                  <div className="grid grid-cols-2 gap-4">
                    {active?.requiresAccountId ? null : (
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="brainBaseUrl">Endpoint</Label>
                        <Input
                          id="brainBaseUrl"
                          value={draft.baseUrl ?? ""}
                          placeholder={active?.baseUrl || "https://…/v1/systemone"}
                          onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                        />
                      </div>
                    )}
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="brainModel">Model</Label>
                      <Input
                        id="brainModel"
                        value={draft.model ?? ""}
                        placeholder={active?.model ?? "jev-latest"}
                        onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="brainEnv">API key env var</Label>
                      <Input
                        id="brainEnv"
                        value={draft.apiKeyEnv ?? ""}
                        placeholder={active?.apiKeyEnv ?? "TYPESAFE_API_KEY"}
                        onChange={(event) => setDraft({ ...draft, apiKeyEnv: event.target.value })}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="brainTimeout">Timeout (ms)</Label>
                      <Input
                        id="brainTimeout"
                        type="number"
                        value={draft.timeoutMs}
                        onChange={(event) =>
                          setDraft({ ...draft, timeoutMs: Number(event.target.value) })
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="brainConfidence">Min confidence</Label>
                      <Input
                        id="brainConfidence"
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={draft.minConfidence}
                        onChange={(event) =>
                          setDraft({ ...draft, minConfidence: Number(event.target.value) })
                        }
                      />
                      <span className="text-[11px] text-muted-foreground">
                        Below this the turn is marked low-confidence. Later brains are only tried
                        when this channel fails.
                      </span>
                    </div>
                    <div className="col-span-2 flex flex-col gap-1.5">
                      <Label htmlFor="brainContext">Context sent to the brain</Label>
                      <Select
                        value={draft.fullPrompt ? "full" : "compact"}
                        onValueChange={(value) =>
                          setDraft({ ...draft, fullPrompt: value === "full" })
                        }
                      >
                        <SelectTrigger id="brainContext" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="compact">
                            compact — goal, recent turns, tool activity
                          </SelectItem>
                          <SelectItem value="full">full prompt — every message verbatim</SelectItem>
                        </SelectContent>
                      </Select>
                      <span className="text-[11px] text-muted-foreground">
                        compact sends only the goal, recent turns, and tool activity. full prompt
                        sends every message verbatim, which is more private-data exposure but more
                        accurate. This content is sent to the channel above, not stored locally.
                      </span>
                    </div>
                  </div>
                </div>
              </details>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void save()} disabled={busy || !dirty}>
                {editing === "new" ? "Add brain" : "Save brain"}
              </Button>
              <Button variant="outline" onClick={() => void test()} disabled={busy}>
                Test & measure
              </Button>
              <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </Button>
              {dirty ? (
                <span className="text-xs font-medium text-amber-600">unsaved changes</span>
              ) : null}
              {result ? <span className="text-xs text-muted-foreground">{result}</span> : null}
              {error ? <span className="text-xs text-destructive">{error}</span> : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
