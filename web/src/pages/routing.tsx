import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { RoutingSkeleton } from "@/components/page-skeletons";
import { ProviderLogo } from "@/components/provider-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Combobox } from "@/components/ui/combobox";
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
  api,
  type CanonicalModelView,
  type ModelView,
  type QuotaGuardView,
  type QuotaHealthView,
  type QuotaStatusView,
  type RoutingEntryView,
  type RoutingView,
  type StateResponse,
} from "@/lib/api";
import { providerDisplayName } from "@/lib/provider-name";
import { cn } from "@/lib/utils";

const BUILTIN_IDS = new Set(["plan", "execute", "utility", "chat"]);
const GUARD_FALLBACK: QuotaGuardView = { enabled: true, lowPercent: 10 };

/**
 * What actually decides a turn. The brain picks the routing; each card is a scenario pool
 * it can choose from.
 */
const BEHAVIOUR: Array<{ signal: string; decision: string }> = [
  {
    signal: "Every auto request",
    decision: "one Jev call picks the routing and the thinking level",
  },
  {
    signal: "Exhausted provider",
    decision: "removed before the brain is asked; a mid-turn 429 re-routes once",
  },
  {
    signal: "Conversation too large for a model",
    decision: "withheld, and listed in x-jevonian-skipped",
  },
  {
    signal: "Nothing fits the context",
    decision: "the history is compacted, then routing runs again",
  },
  { signal: "Explicit routing or model", decision: "routed without consulting the brain" },
];

/** A routing's models, plus whether they were derived from the price table instead of pinned. */
function routingEntries(
  models: string[],
  derived: string[] | undefined,
): { entries: string[]; auto: boolean } {
  if (models.length > 0) return { entries: models, auto: false };
  if (derived && derived.length > 0) return { entries: derived, auto: true };
  return { entries: [], auto: false };
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function isValidRoutingId(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/.test(value) && value !== "auto";
}

function ProviderChipFace({
  provider,
  rank,
  isNext,
  status,
  official,
  showRank,
}: {
  provider: string;
  rank: number;
  isNext: boolean;
  status?: QuotaStatusView;
  official?: boolean;
  showRank?: boolean;
}) {
  return (
    <>
      {showRank ? (
        <span className="tabular-nums text-[10px] font-medium text-muted-foreground">{rank}</span>
      ) : null}
      <ProviderLogo id={provider} className="size-3.5" />
      <span>{providerDisplayName(provider)}</span>
      {official ? (
        <span className="rounded-full bg-muted px-1 text-[9px] uppercase tracking-wide">
          vendor
        </span>
      ) : null}
      {isNext ? <span className="text-[9px] uppercase tracking-wide opacity-70">next</span> : null}
      {status === "exhausted" ? (
        <span className="text-[9px] uppercase tracking-wide text-destructive">spent</span>
      ) : status === "low" ? (
        <span className="text-[9px] uppercase tracking-wide text-amber-600">low</span>
      ) : null}
    </>
  );
}

function SortableProviderChip({
  provider,
  rank,
  isNext,
  status,
  official,
  onRemove,
}: {
  provider: string;
  rank: number;
  isNext: boolean;
  status?: QuotaStatusView;
  official?: boolean;
  onRemove?: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: provider });
  return (
    <span
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn(
        "relative flex items-center gap-1 rounded-md border bg-background px-1.5 py-1 text-[11px]",
        isNext && "border-foreground/30 font-medium text-foreground",
        !isNext && "text-muted-foreground",
        status === "exhausted" && "opacity-60",
        status === "low" && "border-amber-500/40",
        isDragging && "z-10 opacity-40 shadow-md ring-1 ring-foreground/20",
      )}
      title="Drag to set preference order"
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
        aria-label={`Reorder ${providerDisplayName(provider)}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" />
      </button>
      <ProviderChipFace
        provider={provider}
        rank={rank}
        isNext={isNext}
        status={status}
        official={official}
        showRank
      />
      {onRemove ? (
        <button
          type="button"
          className="shrink-0 rounded text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${providerDisplayName(provider)} from this model`}
          title={`Stop routing this model through ${providerDisplayName(provider)}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onRemove}
        >
          <X className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

/**
 * The provider(s) behind a model id. Drag to set preference order; with `onChangeProviders` the
 * chips become an allow-list — each chip can be removed, and a removed provider is offered back
 * below. An empty list withholds the model, which the caller shows as an empty state.
 */
function ProviderChips({
  providers,
  excluded,
  stale,
  statuses,
  officials,
  editable,
  onChangeProviders,
}: {
  /** Providers routing may use, in preference order. */
  providers: string[];
  /** Providers that could serve this model but are currently removed. */
  excluded?: string[];
  /** Saved names no provider serves any more — kept visible so they can be deleted. */
  stale?: string[];
  statuses?: Map<string, QuotaStatusView>;
  officials?: Set<string>;
  editable?: boolean;
  onChangeProviders?: (next: string[]) => void;
}) {
  // Local order so chips swap as you drag; commit to the parent on drop.
  const [items, setItems] = useState(providers);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    setItems(providers);
  }, [providers]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const next = items.find((provider) => {
    const status = statuses?.get(provider);
    return status !== "low" && status !== "exhausted";
  });

  function moveActive(activeId: string, overId: string) {
    setItems((current) => {
      const from = current.indexOf(activeId);
      const to = current.indexOf(overId);
      if (from < 0 || to < 0 || from === to) return current;
      return arrayMove(current, from, to);
    });
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    moveActive(String(active.id), String(over.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      moveActive(String(active.id), String(over.id));
    }
    // Defer so the last moveActive flush is included.
    queueMicrotask(() => {
      const nextOrder = itemsRef.current;
      if (!sameOrder(nextOrder, providers)) onChangeProviders?.(nextOrder);
    });
  }

  function handleDragCancel() {
    setItems(providers);
  }

  function remove(provider: string) {
    onChangeProviders?.(items.filter((item) => item !== provider));
  }

  function restore(provider: string) {
    onChangeProviders?.([...items, provider]);
  }

  if (!editable) {
    if (providers.length === 0 && (stale?.length ?? 0) === 0) {
      return <span className="text-[11px] text-muted-foreground">Customize to set providers</span>;
    }
    return (
      <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        {[...items, ...(stale ?? [])].map((provider, index) => {
          const status = statuses?.get(provider);
          const missing = stale?.includes(provider) ?? false;
          return (
            <span
              key={provider}
              title={
                missing ? "not configured for this model" : status ? `quota: ${status}` : undefined
              }
              className={cn(
                "flex items-center gap-1 rounded-md border px-1.5 py-0.5",
                provider === next && "border-foreground/20 font-medium text-foreground",
                status === "exhausted" && "opacity-60 line-through",
                status === "low" && "text-amber-600",
                missing && "opacity-60",
              )}
            >
              <ProviderChipFace
                provider={provider}
                rank={index + 1}
                isNext={provider === next}
                status={status}
                official={officials?.has(provider)}
                showRank={items.length + (stale?.length ?? 0) > 1}
              />
            </span>
          );
        })}
      </span>
    );
  }

  const draggable = items.length > 1;

  return (
    <span className="flex flex-col gap-1">
      {items.length === 0 ? (
        <span className="text-[11px] text-muted-foreground">
          No provider — routing will not use this model.
        </span>
      ) : draggable ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext items={items} strategy={rectSortingStrategy}>
            <span className="flex flex-wrap items-center gap-1.5">
              {items.map((provider, index) => (
                <SortableProviderChip
                  key={provider}
                  provider={provider}
                  rank={index + 1}
                  isNext={provider === next}
                  status={statuses?.get(provider)}
                  official={officials?.has(provider)}
                  onRemove={() => remove(provider)}
                />
              ))}
            </span>
          </SortableContext>
        </DndContext>
      ) : (
        <span className="flex flex-wrap items-center gap-1.5">
          {items.map((provider, index) => (
            <span
              key={provider}
              className={cn(
                "flex items-center gap-1 rounded-md border bg-background px-1.5 py-1 text-[11px]",
                provider === next ? "font-medium text-foreground" : "text-muted-foreground",
                statuses?.get(provider) === "exhausted" && "opacity-60",
                statuses?.get(provider) === "low" && "border-amber-500/40",
              )}
            >
              <ProviderChipFace
                provider={provider}
                rank={index + 1}
                isNext={provider === next}
                status={statuses?.get(provider)}
                official={officials?.has(provider)}
                showRank={false}
              />
              <button
                type="button"
                className="shrink-0 rounded text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${providerDisplayName(provider)} from this model`}
                title={`Stop routing this model through ${providerDisplayName(provider)}`}
                onClick={() => remove(provider)}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </span>
      )}
      {stale && stale.length > 0 ? (
        <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {stale.map((provider) => (
            <span
              key={provider}
              title="Saved provider name that no longer serves this model"
              className="flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-muted-foreground"
            >
              <ProviderChipFace provider={provider} rank={0} isNext={false} />
              <button
                type="button"
                className="shrink-0 rounded text-muted-foreground hover:text-destructive"
                aria-label={`Remove stale provider ${provider}`}
                title="Forget this provider name"
                onClick={() => onChangeProviders?.(items)}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </span>
      ) : null}
      {excluded && excluded.length > 0 ? (
        <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-muted-foreground">Removed:</span>
          {excluded.map((provider) => (
            <button
              key={provider}
              type="button"
              className="flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
              title={`Route this model through ${providerDisplayName(provider)} again`}
              onClick={() => restore(provider)}
            >
              <ProviderLogo id={provider} className="size-3.5" />
              <span>{providerDisplayName(provider)}</span>
              <span aria-hidden>+</span>
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function ModelRow({
  model,
  rank,
  showRank,
  providers,
  excluded,
  stale,
  statuses,
  officials,
  catalogName,
  onRemove,
  editableProviders,
  onChangeProviders,
  dragHandle,
}: {
  model: string;
  rank?: number;
  showRank?: boolean;
  providers: string[];
  excluded?: string[];
  stale?: string[];
  statuses?: Map<string, QuotaStatusView>;
  officials?: Set<string>;
  catalogName?: string;
  onRemove?: () => void;
  editableProviders?: boolean;
  onChangeProviders?: (next: string[]) => void;
  /** When set, the row can be dragged to change fallback order within the routing. */
  dragHandle?: {
    attributes: ReturnType<typeof useSortable>["attributes"];
    listeners: ReturnType<typeof useSortable>["listeners"];
    setActivatorNodeRef: ReturnType<typeof useSortable>["setActivatorNodeRef"];
  };
}) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md border bg-background px-2 py-1.5">
      <span className="flex min-w-0 flex-1 items-start gap-1.5">
        {dragHandle ? (
          <button
            ref={dragHandle.setActivatorNodeRef}
            type="button"
            className="mt-0.5 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
            aria-label={`Reorder ${model}`}
            title="Drag to set model fallback order"
            {...dragHandle.attributes}
            {...dragHandle.listeners}
          >
            <GripVertical className="size-3.5" />
          </button>
        ) : null}
        {showRank && rank !== undefined ? (
          <span className="mt-0.5 w-3 shrink-0 text-center tabular-nums text-[10px] font-medium text-muted-foreground">
            {rank}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-xs font-medium">{model}</span>
          {catalogName ? (
            <span className="truncate text-[10px] text-muted-foreground">{catalogName}</span>
          ) : null}
          <ProviderChips
            providers={providers}
            excluded={excluded}
            stale={stale}
            statuses={statuses}
            officials={officials}
            editable={editableProviders}
            onChangeProviders={onChangeProviders}
          />
        </span>
      </span>
      {onRemove ? (
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={`Remove ${model}`}
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function SortableModelRow({
  model,
  rank,
  showRank,
  ...rest
}: {
  model: string;
  rank: number;
  showRank: boolean;
} & Omit<Parameters<typeof ModelRow>[0], "model" | "rank" | "showRank" | "dragHandle">) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: model });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn(isDragging && "z-10 opacity-40 shadow-md ring-1 ring-foreground/20")}
    >
      <ModelRow
        model={model}
        rank={rank}
        showRank={showRank}
        dragHandle={{ attributes, listeners, setActivatorNodeRef }}
        {...rest}
      />
    </div>
  );
}

/**
 * Models in one routing, preferred-first. Dragging reorders the fallback chain: the first
 * model with a healthy provider is used; later ones wait until earlier ones are unavailable.
 */
function ModelList({
  models,
  editable,
  renderRow,
  onReorder,
}: {
  models: string[];
  editable: boolean;
  renderRow: (model: string, index: number, draggable: boolean) => ReactNode;
  onReorder?: (next: string[]) => void;
}) {
  const [items, setItems] = useState(models);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    setItems(models);
  }, [models]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function moveActive(activeId: string, overId: string) {
    setItems((current) => {
      const from = current.indexOf(activeId);
      const to = current.indexOf(overId);
      if (from < 0 || to < 0 || from === to) return current;
      return arrayMove(current, from, to);
    });
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    moveActive(String(active.id), String(over.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      moveActive(String(active.id), String(over.id));
    }
    queueMicrotask(() => {
      const nextOrder = itemsRef.current;
      if (!sameOrder(nextOrder, models)) onReorder?.(nextOrder);
    });
  }

  function handleDragCancel() {
    setItems(models);
  }

  const draggable = editable && items.length > 1 && Boolean(onReorder);

  if (!draggable) {
    return (
      <div className="flex flex-col gap-1.5">
        {items.map((model, index) => renderRow(model, index, false))}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-1.5">
          {items.map((model, index) => renderRow(model, index, true))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

/** Human label for a brain channel id, falling back to the raw id. */
function channelLabel(id: string): string {
  const CHANNELS: Record<string, string> = {
    typesafe: "TypeSafe",
    openrouter: "OpenRouter",
    "opencode-zen": "OpenCode Zen",
    vercel: "Vercel AI Gateway",
    cloudflare: "Cloudflare Workers AI",
  };
  return CHANNELS[id] ?? id;
}

function ensureRoutings(routing: RoutingView, fallback: RoutingEntryView[]): RoutingEntryView[] {
  if (routing.routings && routing.routings.length > 0) return routing.routings;
  return fallback;
}

/**
 * The providers a routing allows for one model, in saved preference order.
 *
 * Mirrors the router: no saved list means every provider that serves the model, while a saved
 * list is an allow-list — so a provider the user removed is gone here too, and an emptied list
 * shows no provider rather than silently restoring all of them.
 */
function allowedProviders(discovered: string[], preferred: string[] | undefined): string[] {
  if (preferred === undefined) return discovered;
  const remaining = [...discovered];
  const ordered: string[] = [];
  for (const name of preferred) {
    const index = remaining.indexOf(name);
    if (index < 0) continue;
    ordered.push(remaining.splice(index, 1)[0]!);
  }
  return ordered;
}

function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function RoutingPage() {
  const [saved, setSaved] = useState<RoutingView | null>(null);
  const [state, setState] = useState<StateResponse | null>(null);
  const [guard, setGuard] = useState<QuotaGuardView>(GUARD_FALLBACK);
  const [health, setHealth] = useState<QuotaHealthView[]>([]);
  const [models, setModels] = useState<ModelView[]>([]);
  const [canonicals, setCanonicals] = useState<CanonicalModelView[]>([]);
  const [drafts, setDrafts] = useState<RoutingEntryView[]>([]);
  const [picker, setPicker] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  /** Which routing card is expanded for editing — one at a time. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newDescription, setNewDescription] = useState("");

  const load = useCallback(async () => {
    try {
      const [state, modelList, quota] = await Promise.all([api.state(), api.models(), api.quota()]);
      setSaved(state.config.routing);
      setState(state);
      setGuard(state.config.routing.quotaGuard ?? GUARD_FALLBACK);
      setDrafts(ensureRoutings(state.config.routing, state.routings ?? []));
      setHealth(quota.health);
      setModels(modelList.models);
      setCanonicals(modelList.canonicals ?? []);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const subscriptionHealth = health.filter((item) => item.billing !== "api");

  /**
   * Every provider that serves a routing entry. Canonical ids resolve through their variants; raw
   * model ids resolve through the providers that list them.
   */
  const providersByModel = useMemo(() => {
    const map = new Map<string, string[]>();
    const push = (key: string, provider: string) => {
      const list = map.get(key) ?? [];
      if (!list.includes(provider)) list.push(provider);
      map.set(key, list);
    };
    for (const model of models) push(model.id, model.provider);
    for (const entry of canonicals) {
      for (const variant of entry.variants) push(entry.id, variant.provider);
    }
    return map;
  }, [models, canonicals]);

  /** Quota status per provider, so a chip can show who serves the next turn and who is thin. */
  const statusByProvider = useMemo(
    () => new Map(health.map((item) => [item.provider, item.status])),
    [health],
  );

  /** Which providers are the vendor that owns a model, and the catalog's label for it. */
  const { officialsByModel, catalogNames } = useMemo(() => {
    const officials = new Map<string, Set<string>>();
    const names = new Map<string, string>();
    for (const entry of canonicals) {
      if (entry.name) names.set(entry.id, entry.name);
      for (const variant of entry.variants) {
        if (!variant.official) continue;
        const set = officials.get(entry.id) ?? new Set();
        set.add(variant.provider);
        officials.set(entry.id, set);
      }
    }
    return { officialsByModel: officials, catalogNames: names };
  }, [canonicals]);

  const derivedById = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of state?.routings ?? []) map.set(entry.id, entry.models);
    return map;
  }, [state]);

  const modelOptions = useCallback(
    (routingId: string) => {
      const used = drafts.find((entry) => entry.id === routingId)?.models ?? [];
      return [
        ...canonicals
          .filter((entry) => !used.includes(entry.id))
          .map((entry) => {
            const providers = providersByModel.get(entry.id) ?? [];
            return {
              value: entry.id,
              label: entry.id,
              hint:
                providers.length > 2
                  ? `${providers.length} providers`
                  : providers.map((provider) => providerDisplayName(provider)).join(", "),
            };
          }),
        ...models
          .filter(
            (model) =>
              !used.includes(model.id) &&
              model.canonical !== undefined &&
              model.canonical !== model.id,
          )
          .map((model) => ({
            value: model.id,
            label: model.id,
            hint: [
              providerDisplayName(model.provider),
              model.price ? `$${model.price.input}/$${model.price.output}` : undefined,
            ]
              .filter(Boolean)
              .join(" · "),
          })),
      ];
    },
    [canonicals, drafts, models, providersByModel],
  );

  const dirty = useMemo(() => {
    if (!saved) return false;
    const persisted = ensureRoutings(saved, state?.routings ?? []);
    const current = { routings: drafts, guard };
    const previous = { routings: persisted, guard: saved.quotaGuard ?? GUARD_FALLBACK };
    return JSON.stringify(current) !== JSON.stringify(previous);
  }, [saved, drafts, guard, state]);

  function updateRouting(id: string, patch: Partial<RoutingEntryView>) {
    setDrafts((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    );
  }

  function addModel(routingId: string) {
    const value = picker[routingId];
    if (!value) return;
    setDrafts((current) =>
      current.map((entry) =>
        entry.id === routingId && !entry.models.includes(value)
          ? { ...entry, models: [...entry.models, value] }
          : entry,
      ),
    );
    setPicker((current) => ({ ...current, [routingId]: "" }));
  }

  function removeModel(routingId: string, model: string) {
    setDrafts((current) =>
      current.map((entry) => {
        if (entry.id !== routingId) return entry;
        const models = entry.models.filter((item) => item !== model);
        const providers = { ...entry.providers };
        delete providers[model];
        const { providers: _drop, ...rest } = entry;
        return Object.keys(providers).length > 0
          ? { ...rest, models, providers }
          : { ...rest, models };
      }),
    );
  }

  function reorderModels(routingId: string, next: string[]) {
    setDrafts((current) =>
      current.map((entry) => (entry.id === routingId ? { ...entry, models: next } : entry)),
    );
  }

  /**
   * Save the provider allow-list for one model. A list matching discovery in order carries no
   * information, so it is dropped rather than stored — that keeps configs free of pins nobody
   * asked for while a genuine removal (or an empty list) is persisted.
   */
  function setModelProviders(routingId: string, model: string, next: string[]) {
    const discovered = providersByModel.get(model) ?? [];
    setDrafts((current) =>
      current.map((entry) => {
        if (entry.id !== routingId) return entry;
        const providers = { ...entry.providers };
        if (sameOrder(next, discovered)) delete providers[model];
        else providers[model] = next;
        const { providers: _drop, ...rest } = entry;
        return Object.keys(providers).length > 0 ? { ...rest, providers } : rest;
      }),
    );
  }

  async function removeRouting(id: string) {
    if (BUILTIN_IDS.has(id)) return;
    const previous = drafts;
    const next = drafts.filter((entry) => entry.id !== id);
    setDrafts(next);
    if (editingId === id) setEditingId(null);
    const ok = await save({ routings: next });
    if (!ok) {
      setDrafts(previous);
      setEditingId(id);
    }
  }

  function createRouting() {
    const id = slugify(newId || newLabel);
    if (!isValidRoutingId(id)) {
      setError("Routing id must be a slug: lowercase letters, digits, hyphens (not “auto”).");
      return;
    }
    if (drafts.some((entry) => entry.id === id)) {
      setError(`Routing id "${id}" already exists.`);
      return;
    }
    const label = newLabel.trim() || id;
    setDrafts((current) => [
      ...current,
      { id, label, description: newDescription.trim(), models: [] },
    ]);
    setNewId("");
    setNewLabel("");
    setNewDescription("");
    setAdding(false);
    setEditingId(id);
    setError("");
  }

  async function save(options?: {
    routings?: RoutingEntryView[];
    quotaGuard?: QuotaGuardView;
  }): Promise<boolean> {
    if (!saved) return false;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.saveRouting({
        routings: options?.routings ?? drafts,
        quotaGuard: options?.quotaGuard ?? guard,
      });
      setMessage("Routing saved");
      await load();
      return true;
    } catch (cause) {
      setError(String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Persist drafts when leaving customize mode (Done, or switching cards). */
  async function commitEditing(nextEditingId: string | null = null): Promise<boolean> {
    if (dirty) {
      const ok = await save();
      if (!ok) return false;
    }
    setEditingId(nextEditingId);
    return true;
  }

  if (!saved || !state) return <RoutingSkeleton />;

  const brains = saved.brains ?? [];
  const primaryBrain = brains[0];
  const brainCount = brains.length;
  const needsAttention = subscriptionHealth.filter(
    (item) => item.status === "low" || item.status === "exhausted",
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Routing</h1>
        <p className="text-sm text-muted-foreground">
          Each card is a scenario Jev can choose. Open{" "}
          <span className="font-medium">Customize</span> on a card to edit its description, models,
          model fallback order, and provider preference. Changes save when you click{" "}
          <span className="font-medium">Done</span>.
        </p>
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <CardTitle>Model routing</CardTitle>
            <CardDescription>
              {guard.enabled
                ? "Healthy providers win first. Drag models within a routing for fallback order; drag providers under a model so your preferred reseller is tried earlier."
                : "Drag models within a routing for fallback order; drag providers under a model for reseller preference."}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setAdding((current) => !current);
              setError("");
            }}
          >
            {adding ? "Cancel" : "Add routing"}
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {adding ? (
            <div className="flex flex-col gap-3 rounded-md border p-3">
              <p className="text-sm font-medium">New routing</p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="newLabel">Name</Label>
                  <Input
                    id="newLabel"
                    value={newLabel}
                    placeholder="Frontend"
                    onChange={(event) => {
                      setNewLabel(event.target.value);
                      if (!newId) setNewId(slugify(event.target.value));
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="newId">Id (jevonian/…)</Label>
                  <Input
                    id="newId"
                    value={newId}
                    placeholder="frontend"
                    onChange={(event) => setNewId(slugify(event.target.value))}
                  />
                </div>
                <div className="flex flex-col gap-1.5 md:col-span-1">
                  <Label htmlFor="newDescription">Description</Label>
                  <Input
                    id="newDescription"
                    value={newDescription}
                    placeholder="React, CSS, UI polish"
                    onChange={(event) => setNewDescription(event.target.value)}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={createRouting} disabled={!newLabel.trim() && !newId}>
                  Create
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  Alias will be <code>jevonian/{newId || "…"}</code>
                </span>
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {drafts.map((routing) => {
              const { entries, auto } = routingEntries(routing.models, derivedById.get(routing.id));
              const builtin = BUILTIN_IDS.has(routing.id);
              const expanded = editingId === routing.id;
              const modelList = expanded ? routing.models : entries;

              return (
                <div
                  key={routing.id}
                  className={cn(
                    "flex flex-col gap-3 rounded-md border p-3 transition-[opacity,box-shadow,background-color]",
                    expanded &&
                      "border-foreground/25 bg-muted/30 shadow-sm ring-1 ring-foreground/10",
                    editingId && !expanded && "opacity-50",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      {expanded ? (
                        <div className="flex flex-col gap-2">
                          <div className="flex flex-col gap-1">
                            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                              Name
                            </Label>
                            <Input
                              value={routing.label}
                              className="h-8 text-sm font-medium"
                              onChange={(event) =>
                                updateRouting(routing.id, { label: event.target.value })
                              }
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                              When Jev should pick this
                            </Label>
                            <Input
                              value={routing.description}
                              className="h-8 text-[12px]"
                              placeholder="e.g. React, CSS, UI polish"
                              onChange={(event) =>
                                updateRouting(routing.id, { description: event.target.value })
                              }
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground">
                            <code>jevonian/{routing.id}</code>
                            {builtin ? " · builtin" : " · custom"}
                          </span>
                        </div>
                      ) : (
                        <div>
                          <p className="text-sm font-medium">{routing.label}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {routing.description || "No description"}
                          </p>
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {expanded ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void commitEditing(null)}
                        >
                          {busy ? "Saving…" : "Done"}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setAdding(false);
                            void commitEditing(routing.id);
                          }}
                        >
                          Customize
                        </Button>
                      )}
                      {!builtin && expanded ? (
                        <button
                          type="button"
                          className="text-[11px] text-muted-foreground hover:text-destructive disabled:opacity-50"
                          disabled={busy}
                          onClick={() => void removeRouting(routing.id)}
                        >
                          Delete routing
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Models
                      </span>
                      {expanded && routing.models.length > 1 ? (
                        <span className="text-[10px] text-muted-foreground">
                          Drag models = fallback order
                        </span>
                      ) : expanded && routing.models.length > 0 ? (
                        <span className="text-[10px] text-muted-foreground">× = stop using</span>
                      ) : null}
                    </div>

                    {modelList.length === 0 ? (
                      <span className="text-[11px] text-muted-foreground">
                        {expanded ? "None yet — add a model below." : "None — customize to add"}
                      </span>
                    ) : (
                      <>
                        {!expanded && auto ? (
                          <span className="text-[11px] text-muted-foreground">
                            Auto — derived from the price table
                          </span>
                        ) : null}
                        <ModelList
                          models={modelList}
                          editable={expanded}
                          onReorder={
                            expanded ? (next) => reorderModels(routing.id, next) : undefined
                          }
                          renderRow={(model, index, draggable) => {
                            const discovered = providersByModel.get(model) ?? [];
                            const allow = routing.providers?.[model];
                            const editableProviders = expanded && routing.models.includes(model);
                            const showRank = modelList.length > 1;
                            const rowProps = {
                              providers: allowedProviders(discovered, allow),
                              excluded:
                                editableProviders && allow
                                  ? discovered.filter((provider) => !allow.includes(provider))
                                  : undefined,
                              stale:
                                editableProviders && allow
                                  ? allow.filter((provider) => !discovered.includes(provider))
                                  : undefined,
                              statuses: statusByProvider,
                              officials: officialsByModel.get(model),
                              catalogName: catalogNames.get(model),
                              onRemove: expanded ? () => removeModel(routing.id, model) : undefined,
                              editableProviders,
                              onChangeProviders: editableProviders
                                ? (next: string[]) => setModelProviders(routing.id, model, next)
                                : undefined,
                            };
                            if (draggable) {
                              return (
                                <SortableModelRow
                                  key={model}
                                  model={model}
                                  rank={index + 1}
                                  showRank={showRank}
                                  {...rowProps}
                                />
                              );
                            }
                            return (
                              <ModelRow
                                key={model}
                                model={model}
                                rank={index + 1}
                                showRank={showRank}
                                {...rowProps}
                              />
                            );
                          }}
                        />
                      </>
                    )}
                  </div>

                  {expanded ? (
                    <div className="flex flex-col gap-2 border-t pt-3">
                      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Add model
                      </Label>
                      <div className="flex flex-wrap items-center gap-2">
                        <Combobox
                          value={picker[routing.id] ?? ""}
                          onChange={(value) =>
                            setPicker((current) => ({ ...current, [routing.id]: value }))
                          }
                          options={modelOptions(routing.id)}
                          placeholder="Search models…"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => addModel(routing.id)}
                          disabled={!picker[routing.id]}
                        >
                          Add
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <details className="rounded-md border">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs text-muted-foreground">
              How a turn is routed
            </summary>
            <div className="flex flex-col gap-1.5 border-t p-3 text-xs">
              {BEHAVIOUR.map((row) => (
                <div key={row.signal} className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{row.signal}</span>
                  <span className="text-right">{row.decision}</span>
                </div>
              ))}
            </div>
          </details>

          {error ? <span className="text-xs text-destructive">{error}</span> : null}
          {!error && message ? (
            <span className="text-xs text-muted-foreground">{message}</span>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Decisions</CardTitle>
            <CardDescription>What picks the routing on each turn.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {primaryBrain ? (
              <>
                <span className="flex items-center gap-2">
                  <Badge variant="default">Jev</Badge>
                  <span>
                    {`${channelLabel(primaryBrain.channel)}${primaryBrain.model ? ` · ${primaryBrain.model}` : ""}`}
                    {brainCount > 1 ? ` · ${brainCount - 1} fallback` : ""}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  One call per routed turn lists the routings with their descriptions; the first
                  confident answer picks the scenario, then the first healthy model in that pool.
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">
                No routing brain configured — <code>jevonian/auto</code> stays disabled until you
                add one.
              </span>
            )}
            <a
              href="/providers#routing-brain"
              className="text-xs font-medium text-foreground underline underline-offset-4"
            >
              Configure on the Providers page
            </a>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <CardTitle>Quota guard</CardTitle>
              <CardDescription>
                {needsAttention.length === 0
                  ? guard.enabled
                    ? "Every provider has room; the guard is on."
                    : "Off — providers are used in listed order, even when spent."
                  : guard.enabled
                    ? `${needsAttention.length} provider${needsAttention.length === 1 ? "" : "s"} thin on quota — the guard routes around them when it can.`
                    : `${needsAttention.length} provider${needsAttention.length === 1 ? "" : "s"} thin on quota, but the guard is off.`}
              </CardDescription>
            </div>
            <a
              href="/providers"
              className="text-xs font-medium text-foreground underline underline-offset-4"
            >
              Manage providers
            </a>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {subscriptionHealth.length > 0 ? (
              <div className="flex flex-col gap-2">
                {subscriptionHealth.map((item) => (
                  <div
                    key={item.provider}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="flex items-center gap-2">
                      <ProviderLogo id={item.provider} />
                      <span className="font-medium">{providerDisplayName(item.provider)}</span>
                    </span>
                    <span className="truncate text-muted-foreground">
                      {item.resetsAt
                        ? `resets ${new Date(item.resetsAt).toLocaleTimeString()}`
                        : ""}
                      {item.note ? ` · ${item.note}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No quota data yet. Connect a subscription provider, or declare caps on the Providers
                page.
              </p>
            )}
            <details className="rounded-md border">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs text-muted-foreground">
                Guard settings
              </summary>
              <div className="flex flex-col gap-4 border-t p-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="guardEnabled">Guard</Label>
                  <Select
                    value={guard.enabled ? "on" : "off"}
                    onValueChange={(value) => setGuard({ ...guard, enabled: value === "on" })}
                  >
                    <SelectTrigger id="guardEnabled" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="on">on — route around thin quota</SelectItem>
                      <SelectItem value="off">off — ignore quota</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="guardLow">Low threshold (% remaining)</Label>
                  <Input
                    id="guardLow"
                    type="number"
                    min={0}
                    max={100}
                    value={guard.lowPercent}
                    onChange={(event) =>
                      setGuard({ ...guard, lowPercent: Number(event.target.value) })
                    }
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Below this share a provider is treated as thin; spent providers are skipped only
                    when an alternative exists.
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void save()}
                    disabled={busy || !dirty}
                  >
                    Save guard
                  </Button>
                  {dirty ? (
                    <span className="text-xs font-medium text-amber-600">unsaved changes</span>
                  ) : null}
                </div>
              </div>
            </details>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
