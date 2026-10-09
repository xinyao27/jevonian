import { Button, Combobox, Input, LayerCard, LayerDialog, Text, Tooltip } from "@cloudflare/kumo";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, DotsSixVertical, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { RoutingSkeleton } from "@/components/page-skeletons";
import { ProviderIdentity } from "@/components/provider-identity";
import { ProviderLogo } from "@/components/provider-logo";
import { ScheduleSection } from "@/components/schedule-section";
import {
  api,
  type ProviderView,
  type QuotaGuardView,
  type RoutingEntryView,
  type StateResponse,
  type CanonicalModelView,
  type ModelView,
  type QuotaHealthView,
  type ScheduleView,
  type TokenSaverConfigView,
} from "@/lib/api";
import { providerDisplayName, resolveProviderIdentity } from "@/lib/provider-name";
import { offersTimeBasedModels, pruneWindowLists, windowRange } from "@/lib/schedule";

import {
  allowedProviders,
  BUILTIN_ROUTING_IDS,
  collectProvidersByModel,
  mergeRoutingDrafts,
  routeSavePayload,
  validRoutingId,
} from "./routing-state";

const GUARD_FALLBACK: QuotaGuardView = { enabled: true, lowPercent: 10, resetAware: true };
const NEW_ROUTE = "__new_route__";

export interface RoutingPageProps {
  embedded?: boolean;
  refreshKey?: number;
  onChanged?: () => void;
  onEditingChange?: (editing: boolean) => void;
  settingsOnly?: boolean;
}

function OrderedRow({
  id,
  index,
  count,
  onMove,
  children,
}: {
  id: string;
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } =
    useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="flex items-start gap-2 rounded-lg border border-kumo-hairline bg-kumo-base p-3"
    >
      <div className="flex shrink-0 flex-col gap-1">
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Drag ${id}`}
          className="touch-none rounded p-1 hover:bg-kumo-tint"
        >
          <DotsSixVertical size={16} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Move ${id} up`}
          disabled={index === 0}
          onClick={() => onMove(index, index - 1)}
          className="rounded p-1 hover:bg-kumo-tint disabled:opacity-30"
        >
          <ArrowUp size={16} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Move ${id} down`}
          disabled={index === count - 1}
          onClick={() => onMove(index, index + 1)}
          className="rounded p-1 hover:bg-kumo-tint disabled:opacity-30"
        >
          <ArrowDown size={16} aria-hidden />
        </button>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function OrderedList({
  items,
  onChange,
  children,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  children: (id: string, index: number) => ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function move(from: number, to: number) {
    onChange(arrayMove(items, from, to));
  }
  function drop({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = items.indexOf(String(active.id));
    const to = items.indexOf(String(over.id));
    if (from >= 0 && to >= 0) move(from, to);
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={drop}>
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2">
          {items.map((id, index) => (
            <OrderedRow key={id} id={id} index={index} count={items.length} onMove={move}>
              {children(id, index)}
            </OrderedRow>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

/**
 * One provider a routing's model may use: the brand logo, and a tooltip with the product name and
 * quota standing. Logos stay readable at a glance where a name would crowd the row.
 */
function ProviderMark({
  provider,
  status,
  record,
}: {
  provider: string;
  status?: string;
  record?: ProviderView;
}) {
  const input = record ?? provider;
  const identity = resolveProviderIdentity(input);
  return (
    <Tooltip
      content={
        <>
          {identity.name}
          {identity.account ? ` · ${identity.account}` : ""} · {status ?? "quota unknown"}
        </>
      }
      render={
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          <ProviderLogo id={identity.brand} className="size-4" />
        </span>
      }
    />
  );
}

export function RoutingPage({
  embedded = false,
  refreshKey = 0,
  onChanged,
  onEditingChange,
  settingsOnly = false,
}: RoutingPageProps = {}) {
  const [state, setState] = useState<StateResponse | null>(null);
  const [models, setModels] = useState<ModelView[]>([]);
  const [canonicals, setCanonicals] = useState<CanonicalModelView[]>([]);
  const [health, setHealth] = useState<QuotaHealthView[]>([]);
  const [drafts, setDrafts] = useState<RoutingEntryView[]>([]);
  const [guard, setGuard] = useState<QuotaGuardView>(GUARD_FALLBACK);
  const [saver, setSaver] = useState<TokenSaverConfigView | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newRoute, setNewRoute] = useState<RoutingEntryView>({
    id: "",
    label: "",
    description: "",
    models: [],
  });
  const [fixedNew, setFixedNew] = useState(false);
  const [fixedEmpty, setFixedEmpty] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saverBusy, setSaverBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const savedRef = useRef<RoutingEntryView[]>([]);
  const guardRef = useRef<QuotaGuardView>(GUARD_FALLBACK);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const [next, catalog, quota] = await Promise.all([api.state(), api.models(), api.quota()]);
      if (version !== loadVersion.current) return;
      // Config routes retain empty model pools. State routes contain the derived pools.
      const fresh = next.config.routing.routings.length
        ? next.config.routing.routings
        : next.routings;
      const previous = savedRef.current;
      setDrafts((current) => mergeRoutingDrafts(fresh, current, previous));
      savedRef.current = fresh;
      const nextGuard = next.config.routing.quotaGuard ?? GUARD_FALLBACK;
      const previousGuard = guardRef.current;
      setGuard((current) =>
        JSON.stringify(current) === JSON.stringify(previousGuard) ? nextGuard : current,
      );
      guardRef.current = nextGuard;
      setState(next);
      setModels(catalog.models);
      setCanonicals(catalog.canonicals ?? []);
      setHealth(quota.health);
      setSaver(next.config.tokenSaver ?? null);
    } catch (cause) {
      if (version === loadVersion.current) setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  useEffect(() => {
    onEditingChange?.(editingId !== null);
  }, [editingId, onEditingChange]);
  useEffect(
    () => () => {
      onEditingChange?.(false);
    },
    [onEditingChange],
  );

  const providersByModel = useMemo(
    () => collectProvidersByModel(models, canonicals),
    [models, canonicals],
  );
  const names = useMemo(
    () => new Map(canonicals.map((entry) => [entry.id, entry.name])),
    [canonicals],
  );
  const statuses = useMemo(
    () => new Map(health.map((entry) => [entry.provider, entry.status])),
    [health],
  );
  const providerRecords = useMemo(
    () => new Map((state?.config.providers ?? []).map((entry) => [entry.name, entry])),
    [state],
  );
  const derived = useMemo(
    () => new Map((state?.routings ?? []).map((entry) => [entry.id, entry.models])),
    [state],
  );
  const schedule = state?.config.routing.schedule;
  const scheduleStatus = state?.schedule;
  // What each task runs on right now. `derived` ignores the active window, but a window that
  // changes one task's models also changes what the automatic tasks after it can pick.
  const effective = state?.effective;
  // The active window changes with the clock, not with the config, so keep it fresh.
  const hasSchedule = Boolean(schedule);
  useEffect(() => {
    if (!hasSchedule) return;
    const timer = window.setInterval(() => {
      api
        .routingNow()
        .then((now) =>
          setState((current) =>
            current ? { ...current, schedule: now.schedule, effective: now.effective } : current,
          ),
        )
        .catch(() => {});
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [hasSchedule]);
  const route = editingId === NEW_ROUTE ? newRoute : drafts.find((entry) => entry.id === editingId);
  const fixed =
    editingId === NEW_ROUTE ? fixedNew : Boolean(route?.models.length || fixedEmpty === editingId);
  const routeDirty = Boolean(
    route &&
    (editingId === NEW_ROUTE
      ? route.id || route.label || route.description || route.models.length || fixedNew
      : JSON.stringify(route) !==
          JSON.stringify(savedRef.current.find((entry) => entry.id === editingId)) ||
        fixedEmpty === editingId),
  );
  const guardDirty = JSON.stringify(guard) !== JSON.stringify(guardRef.current);
  const dirty = routeDirty || guardDirty;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function updateRoute(patch: Partial<RoutingEntryView>) {
    if (editingId === NEW_ROUTE) setNewRoute((current) => ({ ...current, ...patch }));
    else
      setDrafts((current) =>
        current.map((entry) => (entry.id === editingId ? { ...entry, ...patch } : entry)),
      );
  }
  function closeEditor(discard = false) {
    if (busy) return;
    if (routeDirty && !discard) {
      setConfirmClose(true);
      return;
    }
    if (editingId !== NEW_ROUTE) {
      const saved = savedRef.current.find((entry) => entry.id === editingId);
      setDrafts((current) =>
        current.flatMap((entry) => (entry.id !== editingId ? [entry] : saved ? [saved] : [])),
      );
    }
    setEditingId(null);
    setConfirmClose(false);
    setConfirmDelete(false);
    setFixedEmpty(null);
  }
  function setProviders(model: string, preferred: string[] | undefined) {
    if (!route) return;
    const providers = { ...route.providers };
    if (preferred === undefined) delete providers[model];
    else providers[model] = preferred;
    updateRoute({ providers: Object.keys(providers).length ? providers : undefined });
  }
  function removeModel(model: string) {
    if (!route) return;
    const providers = { ...route.providers };
    delete providers[model];
    updateRoute({
      models: route.models.filter((id) => id !== model),
      providers: Object.keys(providers).length ? providers : undefined,
    });
    setFixedEmpty(editingId);
  }
  /** Sets the models a task uses during one schedule window. Undefined means "same as the default". */
  function setWindowModels(windowId: string, list: string[] | undefined) {
    if (!route) return;
    const windows = { ...route.windows };
    if (list === undefined) delete windows[windowId];
    else windows[windowId] = list;
    updateRoute({ windows: Object.keys(windows).length ? windows : undefined });
  }
  async function persist(routes: RoutingEntryView[], quotaGuard?: QuotaGuardView) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api.saveRouting({
        routings: routes,
        ...(quotaGuard ? { quotaGuard } : {}),
      });
      const previous = savedRef.current;
      const fresh = result.routing.routings;
      savedRef.current = fresh;
      setDrafts((current) => mergeRoutingDrafts(fresh, current, previous));
      if (quotaGuard) {
        guardRef.current = result.routing.quotaGuard ?? quotaGuard;
        setGuard(guardRef.current);
      }
      setState((current) =>
        current
          ? {
              ...current,
              config: { ...current.config, routing: result.routing },
              routings: result.routings,
              schedule: result.schedule,
              effective: result.effective,
            }
          : current,
      );
      setMessage("Routing saved");
      onChanged?.();
      return true;
    } catch (cause) {
      setError(String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  /** Saves the schedule (null removes it). Returns an error message, or null on success. */
  async function saveSchedule(next: ScheduleView | null): Promise<string | null> {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      // Lists for windows that no longer exist go with them.
      const result = await api.saveRouting({
        routings: pruneWindowLists(savedRef.current, next),
        schedule: next,
      });
      const previous = savedRef.current;
      savedRef.current = result.routing.routings;
      setDrafts((current) =>
        mergeRoutingDrafts(result.routing.routings, current, previous),
      );
      setState((current) =>
        current
          ? {
              ...current,
              config: { ...current.config, routing: result.routing },
              routings: result.routings,
              schedule: result.schedule,
              effective: result.effective,
            }
          : current,
      );
      setMessage(next ? "Schedule saved" : "Schedule removed");
      onChanged?.();
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    } finally {
      setBusy(false);
    }
  }
  async function saveRoute() {
    if (!route) return;
    if (!validRoutingId(route.id)) {
      setError(
        "Use a lowercase task id with letters, digits, or hyphens. Start with a letter. Do not use auto.",
      );
      return;
    }
    if (editingId === NEW_ROUTE && drafts.some((entry) => entry.id === route.id)) {
      setError("This task id already exists.");
      return;
    }
    if (fixed && route.models.length === 0) {
      setError("Choose at least one model for a fixed fallback chain, or choose automatic mode.");
      return;
    }
    const committed = {
      ...route,
      label: route.label.trim() || route.id,
      description: route.description.trim(),
    };
    if (await persist(routeSavePayload(savedRef.current, committed))) {
      setDrafts((current) =>
        current.map((entry) => (entry.id === committed.id ? committed : entry)),
      );
      setEditingId(null);
      setFixedEmpty(null);
      setConfirmClose(false);
      setConfirmDelete(false);
    }
  }
  async function deleteRoute() {
    if (!route || BUILTIN_ROUTING_IDS.has(route.id) || editingId === NEW_ROUTE) return;
    const id = route.id;
    if (await persist(savedRef.current.filter((entry) => entry.id !== id))) {
      setDrafts((current) => current.filter((entry) => entry.id !== id));
      setEditingId(null);
      setConfirmDelete(false);
    }
  }
  async function saveSaver(patch: Partial<TokenSaverConfigView>) {
    if (!saver) return;
    const previous = state?.config.tokenSaver ?? saver;
    setSaverBusy(true);
    setError("");
    try {
      await api.saveTokenSaver(patch);
      const next = { ...saver, ...patch };
      setSaver(next);
      setState((current) =>
        current ? { ...current, config: { ...current.config, tokenSaver: next } } : current,
      );
    } catch (cause) {
      setSaver(previous);
      setError(String(cause));
    } finally {
      setSaverBusy(false);
    }
  }
  const options = useMemo(() => {
    const entries = new Map<
      string,
      { value: string; label: string; hint?: string; keywords: string }
    >();
    for (const model of models)
      entries.set(model.id, {
        value: model.id,
        label: model.id,
        keywords: providerDisplayName(model.provider),
      });
    for (const model of canonicals)
      entries.set(model.id, {
        value: model.id,
        label: model.id,
        hint: model.name,
        keywords: (providersByModel.get(model.id) ?? []).map(providerDisplayName).join(" "),
      });
    return [...entries.values()].filter((entry) => !route?.models.includes(entry.value));
  }, [models, canonicals, providersByModel, route]);

  if (!state)
    return (
      <div>
        {error ? (
          <p role="alert" className="text-sm text-kumo-danger">
            {error}{" "}
            <Button variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </p>
        ) : (
          <RoutingSkeleton />
        )}
      </div>
    );

  const settings = (
    <div className="grid gap-4 md:grid-cols-2">
      <LayerCard>
        <LayerCard.Secondary className="block">
          <span className="flex flex-col gap-1">
            <Text variant="heading" as="h3">
              Quota guard
            </Text>
            <Text variant="secondary" size="sm">
              Skip exhausted providers when an alternative exists. Keep context checks active.
            </Text>
          </span>
        </LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={guard.enabled}
              onChange={(event) => setGuard({ ...guard, enabled: event.target.checked })}
            />
            Enable quota guard
          </label>
          <Input
            id="routing-guard-low"
            label="Low quota threshold (%)"
            type="number"
            min={0}
            max={100}
            value={guard.lowPercent}
            onChange={(event) => setGuard({ ...guard, lowPercent: Number(event.target.value) })}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={guard.resetAware}
              onChange={(event) => setGuard({ ...guard, resetAware: event.target.checked })}
            />
            Prefer the allowance that resets first
          </label>
          <div className="space-y-1 text-xs text-kumo-subtle">
            {health
              .filter((entry) => entry.billing !== "api")
              .map((entry) => (
                <p key={entry.provider}>
                  {providerDisplayName(entry.provider)}: {entry.status}
                  {entry.note ? ` · ${entry.note}` : ""}
                  {entry.resetsAt ? ` · resets ${new Date(entry.resetsAt).toLocaleString()}` : ""}
                </p>
              ))}
          </div>
          <div className="flex gap-2">
            <Button
              disabled={
                busy ||
                !guardDirty ||
                !Number.isFinite(guard.lowPercent) ||
                guard.lowPercent < 0 ||
                guard.lowPercent > 100
              }
              onClick={() => void persist(savedRef.current, guard)}
            >
              Save guard
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !guardDirty}
              onClick={() => setGuard(guardRef.current)}
            >
              Cancel
            </Button>
          </div>
        </LayerCard.Primary>
      </LayerCard>
      <LayerCard>
        <LayerCard.Secondary className="block">
          <span className="flex flex-col gap-1">
            <Text variant="heading" as="h3">
              Token saver
            </Text>
            <Text variant="secondary" size="sm">
              Compress tool results with rtk before requests leave. Install with brew install rtk.
            </Text>
          </span>
        </LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-4">
          {saver ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={saver.enabled}
                  disabled={saverBusy}
                  onChange={(event) => void saveSaver({ enabled: event.target.checked })}
                />
                Enable token saver
              </label>
              <Input
                id="routing-saver-command"
                label="rtk command"
                value={saver.command}
                disabled={saverBusy}
                onChange={(event) => setSaver({ ...saver, command: event.target.value })}
                onBlur={() => void saveSaver({ command: saver.command })}
              />
              <Input
                id="routing-saver-timeout"
                label="Timeout (ms)"
                type="number"
                min={0}
                value={saver.timeoutMs}
                disabled={saverBusy}
                onChange={(event) => setSaver({ ...saver, timeoutMs: Number(event.target.value) })}
                onBlur={() => {
                  if (Number.isFinite(saver.timeoutMs) && saver.timeoutMs >= 0)
                    void saveSaver({ timeoutMs: saver.timeoutMs });
                }}
              />
            </>
          ) : (
            <p className="text-sm text-kumo-subtle">Token saver settings are unavailable.</p>
          )}
        </LayerCard.Primary>
      </LayerCard>
    </div>
  );

  return (
    <section
      className="flex flex-col gap-4"
      aria-label={settingsOnly ? "Routing settings" : "Task routing"}
    >
      {!settingsOnly ? (
        <>
          <div className="flex items-start justify-between gap-3">
            <div>
              {embedded ? (
                <Text variant="heading" as="h2">
                  Task routing
                </Text>
              ) : (
                <Text variant="heading" size="lg" as="h1">
                  Routing
                </Text>
              )}
              <Text variant="secondary" size="sm">
                Describe the task. Set a short model fallback chain.
              </Text>
            </div>
            <Button
              variant="outline"
              disabled={busy || editingId !== null}
              onClick={() => {
                setNewRoute({ id: "", label: "", description: "", models: [] });
                setFixedNew(false);
                setEditingId(NEW_ROUTE);
              }}
            >
              Add task
            </Button>
          </div>
          {schedule || offersTimeBasedModels(state?.config.providers ?? []) ? (
            <ScheduleSection
              routes={drafts}
              schedule={schedule}
              status={scheduleStatus}
              derived={derived}
              effective={effective}
              names={names}
              disabled={busy || editingId !== null}
              onCustomize={(id) => {
                setEditingId(id);
                setConfirmClose(false);
                setConfirmDelete(false);
              }}
              onSave={saveSchedule}
            />
          ) : null}
          <div className="divide-y divide-kumo-hairline rounded-lg border border-kumo-hairline">
            {drafts.map((entry) => {
              const automatic = entry.models.length === 0;
              // While a window is active and lists models for this task, those models run now.
              const timed = scheduleStatus?.active
                ? entry.windows?.[scheduleStatus.active]
                : undefined;
              const chain = timed?.length
                ? timed
                : automatic
                  ? (effective?.[entry.id] ?? derived.get(entry.id) ?? [])
                  : entry.models;
              const shown = chain.slice(0, 3);
              return (
                <div
                  key={entry.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <h3 className="text-sm font-medium">
                      {entry.label}{" "}
                      <span className="font-normal text-kumo-subtle">· {entry.id}</span>
                    </h3>
                    <p className="text-sm text-kumo-subtle">
                      {entry.description || "No task description"}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                      <span className="text-kumo-subtle">
                        {timed?.length
                          ? `Now · ${scheduleStatus?.activeLabel ?? scheduleStatus?.active}`
                          : automatic
                            ? "Automatic"
                            : "Fixed"}{" "}
                        ·
                      </span>
                      {shown.length ? (
                        shown.map((id, index) => {
                          const discovered = providersByModel.get(id) ?? [];
                          const allowed = allowedProviders(discovered, entry.providers?.[id]);
                          return (
                            <span key={id} className="flex items-center gap-1.5">
                              {index > 0 ? <span className="text-kumo-subtle">→</span> : null}
                              <span className="truncate">{names.get(id) || id}</span>
                              <span className="flex shrink-0 items-center gap-1">
                                {allowed.map((provider) => (
                                  <ProviderMark
                                    key={provider}
                                    provider={provider}
                                    status={statuses.get(provider)}
                                    record={providerRecords.get(provider)}
                                  />
                                ))}
                              </span>
                            </span>
                          );
                        })
                      ) : (
                        <span className="text-kumo-subtle">No models available</span>
                      )}
                      {chain.length > 3 ? (
                        <span className="text-kumo-subtle">→ +{chain.length - 3} more</span>
                      ) : null}
                    </p>
                  </div>
                  <Button
                    className="self-start shrink-0"
                    variant="outline"
                    size="sm"
                    disabled={busy || editingId !== null}
                    onClick={() => {
                      setEditingId(entry.id);
                      setConfirmClose(false);
                      setConfirmDelete(false);
                    }}
                  >
                    Customize
                  </Button>
                </div>
              );
            })}
          </div>
          <details className="rounded-lg border border-kumo-hairline">
            <summary className="cursor-pointer p-3 text-sm text-kumo-subtle">
              How routing works
            </summary>
            <div className="space-y-2 border-t border-kumo-hairline p-3 text-sm text-kumo-subtle">
              <p>
                The brain selects a task and thinking level. An explicit task or model skips the
                brain.
              </p>
              <p>
                The first healthy model in the fallback chain serves the request. Context checks
                withhold models that cannot fit the conversation. Skipped models appear in
                x-jevonian-skipped.
              </p>
              <p>
                If no model fits, routing compacts the history and tries again. A mid-turn quota
                error can route to another provider once.
              </p>
            </div>
          </details>
        </>
      ) : null}
      {settingsOnly ? (
        embedded ? (
          settings
        ) : (
          <details className="rounded-lg border border-kumo-hairline">
            <summary className="cursor-pointer p-3 text-sm text-kumo-subtle">
              Routing settings · quota guard and token saver
            </summary>
            <div className="border-t border-kumo-hairline p-3">{settings}</div>
          </details>
        )
      ) : embedded ? null : (
        <details className="rounded-lg border border-kumo-hairline">
          <summary className="cursor-pointer p-3 text-sm text-kumo-subtle">
            Routing settings · quota guard and token saver
          </summary>
          <div className="border-t border-kumo-hairline p-3">{settings}</div>
        </details>
      )}
      {error ? (
        <p role="alert" className="text-sm text-kumo-danger">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-kumo-subtle">
          {message}
        </p>
      ) : null}
      <LayerDialog.Root
        open={editingId !== null}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        dismissDisabled={busy}
      >
        <LayerDialog.Content size="lg" verticalAlign="top">
          <LayerDialog.Title>
            {editingId === NEW_ROUTE ? "Add task" : `Customize ${route?.label ?? "task"}`}
          </LayerDialog.Title>
          <LayerDialog.Description>
            Changes apply only when you select Save route.
          </LayerDialog.Description>
          <LayerDialog.Body>
            {route ? (
              <div className="flex min-h-0 flex-1 flex-col gap-5 pb-4">
                <Input
                  id="routing-task-id"
                  label="Task id (jevonian/…)"
                  value={route.id}
                  disabled={editingId !== NEW_ROUTE || busy}
                  placeholder="frontend"
                  onChange={(event) => updateRoute({ id: event.target.value })}
                />
                <Input
                  id="routing-task-name"
                  label="Task name"
                  value={route.label}
                  disabled={busy}
                  onChange={(event) => updateRoute({ label: event.target.value })}
                />
                <Input
                  id="routing-task-description"
                  label="When to use this task"
                  value={route.description}
                  disabled={busy}
                  placeholder="React, CSS, and UI changes"
                  onChange={(event) => updateRoute({ description: event.target.value })}
                />
                <fieldset disabled={busy} className="space-y-3">
                  <legend className="mb-2 text-sm font-medium">Model selection</legend>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name="routing-model-mode"
                      checked={!fixed}
                      onChange={() => {
                        updateRoute({ models: [] });
                        if (editingId === NEW_ROUTE) setFixedNew(false);
                        setFixedEmpty(null);
                      }}
                    />
                    Automatic · derive models from the price table
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name="routing-model-mode"
                      checked={fixed}
                      onChange={() => {
                        updateRoute({
                          models: route.models.length
                            ? route.models
                            : [...(derived.get(route.id) ?? [])],
                        });
                        if (editingId === NEW_ROUTE) setFixedNew(true);
                        else setFixedEmpty(editingId);
                      }}
                    />
                    Fixed · choose and order models
                  </label>
                  {!fixed ? (
                    <div className="rounded-lg bg-kumo-tint p-3 text-sm">
                      <p className="mb-2 text-kumo-subtle">
                        These models are derived. Select Fixed to copy and change this chain.
                      </p>
                      <p className="break-words">
                        {(derived.get(route.id) ?? []).join(" → ") ||
                          "No derived models are available for this task yet."}
                      </p>
                    </div>
                  ) : (
                    <>
                      <p className="text-xs text-kumo-subtle">
                        Models run from top to bottom. Expand sources to set provider order.
                      </p>
                      <OrderedList
                        items={route.models}
                        onChange={(next) => updateRoute({ models: next })}
                      >
                        {(model, index) => {
                          const discovered = providersByModel.get(model) ?? [];
                          const preferred = route.providers?.[model];
                          const sources = allowedProviders(discovered, preferred);
                          const stale = (preferred ?? []).filter(
                            (provider) => !discovered.includes(provider),
                          );
                          return (
                            <div className="space-y-2">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="break-words text-sm font-medium">
                                    {index + 1}. {names.get(model) || model}
                                  </p>
                                  {names.get(model) ? (
                                    <p className="break-words text-xs text-kumo-subtle">{model}</p>
                                  ) : null}
                                </div>
                                <button
                                  type="button"
                                  aria-label={`Remove ${model}`}
                                  className="rounded p-1 hover:bg-kumo-tint"
                                  onClick={() => removeModel(model)}
                                >
                                  <X size={16} aria-hidden />
                                </button>
                              </div>
                              <details>
                                <summary className="cursor-pointer text-xs text-kumo-subtle">
                                  Sources ·{" "}
                                  {preferred === undefined
                                    ? "All providers (automatic)"
                                    : `${sources.length} allowed (explicit)`}
                                </summary>
                                <div className="mt-3 space-y-3">
                                  <p className="text-xs text-kumo-subtle">
                                    An explicit empty list blocks this model. All providers includes
                                    new providers automatically.
                                  </p>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      setProviders(
                                        model,
                                        preferred === undefined ? [...discovered] : undefined,
                                      )
                                    }
                                  >
                                    {preferred === undefined
                                      ? "Choose providers explicitly"
                                      : "Use all providers automatically"}
                                  </Button>
                                  {preferred === undefined ? (
                                    <div className="text-xs text-kumo-subtle">
                                      {discovered.map(providerDisplayName).join(" · ") ||
                                        "No provider serves this model."}
                                    </div>
                                  ) : (
                                    <>
                                      <OrderedList
                                        items={preferred}
                                        onChange={(next) => setProviders(model, next)}
                                      >
                                        {(provider) => (
                                          <div className="flex items-center justify-between gap-2 text-xs">
                                            <span className="flex min-w-0 items-center gap-2">
                                              <ProviderIdentity provider={provider} size="size-4" />
                                              <span className="shrink-0 text-kumo-subtle">
                                                ·{" "}
                                                {stale.includes(provider)
                                                  ? "not available"
                                                  : (statuses.get(provider) ?? "quota unknown")}
                                              </span>
                                            </span>
                                            <button
                                              type="button"
                                              aria-label={`Remove ${provider} from ${model}`}
                                              className="rounded p-1 hover:bg-kumo-tint"
                                              onClick={() =>
                                                setProviders(
                                                  model,
                                                  preferred.filter((id) => id !== provider),
                                                )
                                              }
                                            >
                                              <X size={16} aria-hidden />
                                            </button>
                                          </div>
                                        )}
                                      </OrderedList>
                                      {sources.length === 0 ? (
                                        <p className="text-xs text-kumo-danger">
                                          No available provider. Routing will not use this model.
                                        </p>
                                      ) : null}
                                      <div className="flex flex-wrap gap-2">
                                        {discovered
                                          .filter((provider) => !preferred.includes(provider))
                                          .map((provider) => (
                                            <Button
                                              key={provider}
                                              size="sm"
                                              variant="outline"
                                              onClick={() =>
                                                setProviders(model, [...preferred, provider])
                                              }
                                            >
                                              Add {providerDisplayName(provider)}
                                            </Button>
                                          ))}
                                      </div>
                                    </>
                                  )}
                                </div>
                              </details>
                            </div>
                          );
                        }}
                      </OrderedList>
                      <Combobox
                        label="Add model"
                        items={options}
                        itemToStringLabel={(option: any) => option?.label ?? option?.value ?? ""}
                        value={null}
                        onValueChange={(option: any) => {
                          const value = typeof option === "string" ? option : option?.value;
                          if (value) updateRoute({ models: [...route.models, value] });
                        }}
                      >
                        <Combobox.Input
                          placeholder="Search model id, name, or provider…"
                          aria-label="Add model"
                        />
                        <Combobox.Content>
                          <Combobox.Empty>No matching model is available.</Combobox.Empty>
                          <Combobox.List>
                            {(option: any) => (
                              <Combobox.Item key={option.value} value={option}>
                                <span className="flex-1 truncate">{option.label}</span>
                                {option.hint ? (
                                  <span className="text-xs text-kumo-subtle">{option.hint}</span>
                                ) : null}
                              </Combobox.Item>
                            )}
                          </Combobox.List>
                        </Combobox.Content>
                      </Combobox>
                    </>
                  )}
                </fieldset>
                {schedule?.windows.length ? (
                  <fieldset disabled={busy} className="space-y-3">
                    <legend className="mb-2 text-sm font-medium">Models by time</legend>
                    <p className="text-xs text-kumo-subtle">
                      Use other models while a time window is active. Outside every window, and in
                      windows left off, the models above run.
                    </p>
                    {schedule.windows.map((slot) => {
                      const list = route.windows?.[slot.id];
                      const slotOptions = options.filter(
                        (option) => !(list ?? []).includes(option.value),
                      );
                      return (
                        <div
                          key={slot.id}
                          className="space-y-3 rounded-lg border border-kumo-hairline p-3"
                        >
                          <label className="flex items-start gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={list !== undefined}
                              onChange={(event) =>
                                setWindowModels(
                                  slot.id,
                                  event.target.checked
                                    ? [
                                        ...(route.models.length
                                          ? route.models
                                          : (derived.get(route.id) ?? [])),
                                      ]
                                    : undefined,
                                )
                              }
                            />
                            <span>
                              {slot.label} · {windowRange(slot)}
                              {scheduleStatus?.active === slot.id ? " · now" : ""}
                              <br />
                              <span className="text-xs text-kumo-subtle">
                                Use different models in this window
                              </span>
                            </span>
                          </label>
                          {list !== undefined ? (
                            <>
                              <OrderedList
                                items={list}
                                onChange={(next) => setWindowModels(slot.id, next)}
                              >
                                {(model, index) => (
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <p className="break-words text-sm font-medium">
                                        {index + 1}. {names.get(model) || model}
                                      </p>
                                      {names.get(model) ? (
                                        <p className="break-words text-xs text-kumo-subtle">
                                          {model}
                                        </p>
                                      ) : null}
                                    </div>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      aria-label={`Remove ${model} from ${slot.label}`}
                                      onClick={() =>
                                        setWindowModels(
                                          slot.id,
                                          list.filter((id) => id !== model),
                                        )
                                      }
                                    >
                                      <X size={16} aria-hidden />
                                    </Button>
                                  </div>
                                )}
                              </OrderedList>
                              <Combobox
                                label={`Add model for ${slot.label}`}
                                items={slotOptions}
                                itemToStringLabel={(option: any) =>
                                  option?.label ?? option?.value ?? ""
                                }
                                value={null}
                                onValueChange={(option: any) => {
                                  const value =
                                    typeof option === "string" ? option : option?.value;
                                  if (value && !list.includes(value))
                                    setWindowModels(slot.id, [...list, value]);
                                }}
                              >
                                <Combobox.Input
                                  placeholder="Search model id, name, or provider…"
                                  aria-label={`Add model for ${slot.label}`}
                                />
                                <Combobox.Content>
                                  <Combobox.Empty>No matching model is available.</Combobox.Empty>
                                  <Combobox.List>
                                    {(option: any) => (
                                      <Combobox.Item key={option.value} value={option}>
                                        <span className="flex-1 truncate">{option.label}</span>
                                        {option.hint ? (
                                          <span className="text-xs text-kumo-subtle">
                                            {option.hint}
                                          </span>
                                        ) : null}
                                      </Combobox.Item>
                                    )}
                                  </Combobox.List>
                                </Combobox.Content>
                              </Combobox>
                            </>
                          ) : null}
                        </div>
                      );
                    })}
                  </fieldset>
                ) : null}
                {error ? (
                  <p role="alert" className="text-sm text-kumo-danger">
                    {error}
                  </p>
                ) : null}
                {confirmClose ? (
                  <div
                    role="alert"
                    className="space-y-3 rounded-lg border border-kumo-hairline bg-kumo-tint p-3 text-sm"
                  >
                    <p>Discard unsaved route changes?</p>
                    <div className="flex gap-2">
                      <Button variant="destructive" onClick={() => closeEditor(true)}>
                        Discard changes
                      </Button>
                      <Button variant="outline" onClick={() => setConfirmClose(false)}>
                        Keep editing
                      </Button>
                    </div>
                  </div>
                ) : null}
                {confirmDelete ? (
                  <div
                    role="alert"
                    className="space-y-3 rounded-lg border border-kumo-hairline bg-kumo-tint p-3 text-sm"
                  >
                    <p>
                      Delete this task? Clients that use jevonian/{route.id} will need another
                      route.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        disabled={busy}
                        onClick={() => void deleteRoute()}
                      >
                        Confirm delete
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => setConfirmDelete(false)}
                      >
                        Keep task
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-hairline pt-3">
              {route && editingId !== NEW_ROUTE && !BUILTIN_ROUTING_IDS.has(route.id) ? (
                <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  Delete task
                </Button>
              ) : (
                <span className="text-xs text-kumo-subtle">
                  {editingId !== NEW_ROUTE ? "Built-in task" : "New task"}
                </span>
              )}
              <div className="flex gap-2">
                <Button variant="outline" disabled={busy} onClick={() => closeEditor()}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || !route}
                  onClick={() => void saveRoute()}
                >
                  {busy ? "Saving…" : "Save route"}
                </Button>
              </div>
            </div>
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </section>
  );
}
