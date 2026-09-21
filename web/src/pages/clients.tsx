import { Laptop, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ProviderLogo } from "@/components/provider-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  connectClient,
  disconnectClient,
  isRestartRequired,
  type ClientIdView,
  type ClientSurfaceView,
  type ClientTargetView,
  type ClientsResponse,
} from "@/lib/api";

interface PendingRestart {
  id: ClientIdView;
  action: "connect" | "disconnect";
  message: string;
}

const STATUS_LABEL: Record<ClientTargetView["status"], string> = {
  connected: "Connected",
  disconnected: "Not connected",
  unavailable: "Unavailable",
};

function statusVariant(status: ClientTargetView["status"]) {
  if (status === "connected") return "default" as const;
  if (status === "disconnected") return "secondary" as const;
  return "outline" as const;
}

function surfaceLine(surfaces: ClientSurfaceView[] | undefined): string | null {
  if (!surfaces || surfaces.length === 0) return null;
  return surfaces.map((surface) => `${surface.label}: ${STATUS_LABEL[surface.status]}`).join(" · ");
}

export function ClientsPage() {
  const [data, setData] = useState<ClientsResponse | null>(null);
  const [busy, setBusy] = useState<ClientIdView | null>(null);
  const [pending, setPending] = useState<PendingRestart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData((await (await fetch("/api/clients")).json()) as ClientsResponse);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clients = data?.clients ?? [];

  const run = useCallback(
    async (id: ClientIdView, action: "connect" | "disconnect", restart: boolean) => {
      setBusy(id);
      setError(null);
      setNotice(null);
      try {
        const result =
          action === "connect"
            ? await connectClient(id, restart)
            : await disconnectClient(id, restart);

        if (isRestartRequired(result)) {
          setPending({ id, action, message: result.message });
          return;
        }

        setPending(null);

        if (action === "connect" && "result" in result) {
          if (id === "claude") {
            setNotice(
              result.result.restarted
                ? "Claude Desktop and Claude Code are connected. Desktop was restarted; open a new `claude` session for the CLI."
                : "Claude Desktop and Claude Code are connected. Reopen Desktop and start a new `claude` session for the CLI.",
            );
          } else {
            setNotice(
              result.result.restarted
                ? "Profile applied and ChatGPT was restarted."
                : "Profile applied. It takes effect the next time you open the app.",
            );
          }
        } else {
          setNotice("Restored the client's normal profile.");
        }
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Clients</h1>
          <p className="text-sm text-muted-foreground">
            Point coding agents on this machine at Jevonian. Claude Connect covers Desktop and the
            CLI together; ChatGPT covers the Codex desktop app. Changes can be reverted at any time.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy !== null}>
          <RefreshCw className="size-4" />
          Refresh
        </Button>
      </div>

      {data ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Laptop className="size-3.5 shrink-0" />
          <span>
            Config files are written on{" "}
            <span className="font-medium text-foreground">{data.hostname}</span> ({data.platform}).
            Run the dashboard on the machine whose apps you want to connect.
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {notice ? (
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {notice}
        </div>
      ) : null}

      {pending ? (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="text-base">
              Restart {clients.find((client) => client.id === pending.id)?.label ?? "the app"}?
            </CardTitle>
            <CardDescription>
              {pending.message} Restarting closes the app now — any running task will stop.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void run(pending.id, pending.action, true)}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Restart and apply
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPending(null)}
              disabled={busy !== null}
            >
              Cancel
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-col gap-4">
        {clients.map((client) => {
          const surfaces = surfaceLine(client.surfaces);
          return (
            <Card key={client.id}>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <ProviderLogo id={client.logo} className="size-6 shrink-0" />
                    <div className="min-w-0">
                      <CardTitle className="text-base leading-6">{client.label}</CardTitle>
                      {surfaces ? (
                        <CardDescription className="text-xs">{surfaces}</CardDescription>
                      ) : client.baseUrl ? (
                        <CardDescription className="font-mono text-xs">
                          {client.baseUrl}
                        </CardDescription>
                      ) : client.configPath ? (
                        <CardDescription className="truncate font-mono text-xs">
                          {client.configPath}
                        </CardDescription>
                      ) : null}
                    </div>
                  </div>
                  <Badge variant={statusVariant(client.status)} className="shrink-0">
                    {STATUS_LABEL[client.status]}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {client.reason ? (
                  <p className="text-sm text-muted-foreground">{client.reason}</p>
                ) : null}
                {client.id === "claude" && client.status !== "unavailable" ? (
                  <p className="text-sm text-muted-foreground">
                    Connect rewrites Claude Desktop&apos;s gateway profile and Claude Code&apos;s{" "}
                    <span className="font-mono text-xs">~/.claude/settings.json</span>. You can also
                    run <span className="font-mono text-xs">jevonian launch claude</span> for a
                    one-shot CLI session.
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={
                      client.status === "unavailable" ||
                      client.status === "connected" ||
                      busy !== null
                    }
                    onClick={() => void run(client.id, "connect", false)}
                  >
                    {busy === client.id ? <Loader2 className="size-4 animate-spin" /> : null}
                    Connect
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      busy !== null ||
                      !(
                        client.status === "connected" ||
                        client.surfaces?.some((surface) => surface.status === "connected")
                      )
                    }
                    onClick={() => void run(client.id, "disconnect", false)}
                  >
                    Restore
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
