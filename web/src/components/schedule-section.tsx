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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, DotsSixVertical, Plus, Warning, X } from "@phosphor-icons/react";
import { Badge, Banner, Button, Input, LayerCard, LayerDialog, Text } from "@cloudflare/kumo";
import { useMemo, useState, type ReactNode } from "react";

import type {
  RoutingEntryView,
  ScheduleStatusView,
  ScheduleView,
  ScheduleWindowView,
} from "@/lib/api";
import {
  browserZone,
  firstScheduleError,
  hasScheduleErrors,
  knownZones,
  MAX_SCHEDULE_WINDOWS,
  moveWindow,
  partialOverlaps,
  runsPastMidnight,
  scheduleErrors,
  scheduleIsIdle,
  scheduleSummary,
  shadowedWindows,
  windowRange,
  windowSlug,
  type ScheduleErrors,
} from "@/lib/schedule";

const EMPTY: ScheduleView = { timezone: "", windows: [] };

export interface ScheduleSectionProps {
  routes: RoutingEntryView[];
  schedule: ScheduleView | undefined;
  status: ScheduleStatusView | undefined;
  /** Models an automatic routing derives, shown when it lists none of its own. */
  derived: Map<string, string[]>;
  /**
   * What each task runs on right now, with the active window applied. An automatic task can pick
   * different models while a window changes an earlier task's list, which `derived` does not show.
   */
  effective?: Record<string, string[]>;
  names: Map<string, string | undefined>;
  disabled: boolean;
  /** Opens the task editor for one routing, so an idle schedule can point at the next step. */
  onCustomize: (id: string) => void;
  /** Saves the schedule (null removes it). Returns an error message, or null on success. */
  onSave: (next: ScheduleView | null) => Promise<string | null>;
}

/** First two model names, then a count. */
function chainText(models: string[], names: Map<string, string | undefined>): string {
  if (models.length === 0) return "No models available";
  const shown = models
    .slice(0, 2)
    .map((id) => names.get(id) || id)
    .join(" → ");
  return models.length > 2 ? `${shown} → +${models.length - 2} more` : shown;
}

/** A window's name, with a fallback for one that has no label yet. */
function windowName(window: Pick<ScheduleWindowView, "label">): string {
  return window.label.trim() || "An unnamed window";
}

/** One draggable window in the editor: a drag handle, up/down buttons, and its fields. */
function WindowRow({
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
          aria-label={`Reorder ${id}`}
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

/**
 * Which models each task uses at which time of day. The table answers "what runs when"; the
 * dialog edits the time zone and the windows. Models for a window are set per task, in Customize.
 */
export function ScheduleSection({
  routes,
  schedule,
  status,
  derived,
  effective,
  names,
  disabled,
  onCustomize,
  onSave,
}: ScheduleSectionProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ScheduleView>(EMPTY);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const zones = useMemo(() => knownZones(), []);
  const windows = schedule?.windows ?? [];

  // Validation runs on the draft, so errors appear while editing rather than only on save.
  const draftErrors: ScheduleErrors = useMemo(() => scheduleErrors(draft), [draft]);
  const draftShadows = useMemo(() => shadowedWindows(draft.windows), [draft.windows]);
  const draftOverlaps = useMemo(() => partialOverlaps(draft.windows), [draft.windows]);

  // The card warns about windows that can never apply, even before the editor is opened.
  const shadows = useMemo(() => shadowedWindows(windows), [windows]);
  const idle = scheduleIsIdle(routes, schedule);
  const firstUnconfigured = routes.find((route) => !Object.keys(route.windows ?? {}).length);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function openEditor() {
    setDraft(
      schedule
        ? {
            timezone: schedule.timezone,
            windows: schedule.windows.map((window) => ({ ...window })),
          }
        : { timezone: browserZone(), windows: [] },
    );
    setError("");
    setConfirmRemove(false);
    setOpen(true);
  }
  function closeEditor() {
    if (!busy) setOpen(false);
  }
  function updateWindow(index: number, patch: Partial<ScheduleView["windows"][number]>) {
    setDraft((current) => ({
      ...current,
      windows: current.windows.map((window, i) => (i === index ? { ...window, ...patch } : window)),
    }));
  }
  function moveDraftWindow(from: number, to: number) {
    setDraft((current) => ({ ...current, windows: moveWindow(current.windows, from, to) }));
  }
  function dropWindow({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = draft.windows.findIndex((window) => window.id === String(active.id));
    const to = draft.windows.findIndex((window) => window.id === String(over.id));
    if (from >= 0 && to >= 0) moveDraftWindow(from, to);
  }
  function addWindow() {
    setDraft((current) => {
      const first = current.windows.length === 0;
      const label = first ? "Off-nights" : `Window ${current.windows.length + 1}`;
      return {
        ...current,
        windows: [
          ...current.windows,
          {
            id: windowSlug(
              label,
              current.windows.map((window) => window.id),
            ),
            label,
            start: first ? "22:00" : "09:00",
            end: first ? "08:00" : "17:00",
          },
        ],
      };
    });
  }
  async function save(next: ScheduleView | null) {
    if (next) {
      const errors = scheduleErrors(next);
      if (hasScheduleErrors(errors)) {
        setError(firstScheduleError(errors, next.windows));
        return;
      }
    }
    setBusy(true);
    setError("");
    const message = await onSave(next);
    setBusy(false);
    if (message) setError(message);
    else setOpen(false);
  }
  function commit() {
    const timezone = draft.timezone.trim();
    // An empty name is an error, not a silent removal: the editor has Remove schedule for that.
    setDraft((current) => ({
      ...current,
      timezone,
      windows: current.windows.map((window) => ({ ...window, label: window.label.trim() })),
    }));
    const errors = scheduleErrors({
      timezone,
      windows: draft.windows.map((window) => ({ ...window, label: window.label.trim() })),
    });
    if (hasScheduleErrors(errors)) {
      setError(firstScheduleError(errors, draft.windows));
      return;
    }
    void save({
      timezone,
      windows: draft.windows.map((window) => ({ ...window, label: window.label.trim() })),
    });
  }

  return (
    <>
      <LayerCard aria-label="Schedule">
        <LayerCard.Secondary className="block">
          <div className="flex items-start justify-between gap-3">
            <span className="flex flex-col gap-1">
              <Text variant="heading" as="h3">
                Schedule
              </Text>
              <Text variant="secondary" size="sm">
                {schedule && status
                  ? scheduleSummary(status, windows)
                  : "Use different models at different times of day, for example cheaper models during an off-peak discount."}
              </Text>
            </span>
            <Button variant="secondary" size="sm" disabled={disabled} onClick={openEditor}>
              {schedule ? "Edit schedule" : "Set up a schedule"}
            </Button>
          </div>
        </LayerCard.Secondary>
        {shadows.length > 0 ? (
          <LayerCard.Primary className="block pt-0">
            <Banner
              variant="alert"
              icon={<Warning size={16} aria-hidden />}
              title={
                shadows.length === 1
                  ? `${windowName(shadows[0].window)} never runs`
                  : `${shadows.length} windows never run`
              }
              description={
                shadows.length === 1
                  ? `${windowName(shadows[0].by)} covers the whole ${windowName(shadows[0].window)} range and comes first, so it is never active.`
                  : shadows
                      .map((entry) => `${windowName(entry.window)} (covered by ${windowName(entry.by)})`)
                      .join(", ")
              }
              action={
                <Banner.Action onClick={openEditor}>Reorder</Banner.Action>
              }
            />
          </LayerCard.Primary>
        ) : null}
        {windows.length > 0 ? (
          <LayerCard.Primary className="block">
            <div className="w-full overflow-x-auto">
              <table className="w-full caption-bottom text-sm">
                <thead>
                  <tr className="border-b border-kumo-hairline">
                    <th className="h-10 px-2 text-left align-bottom font-medium text-kumo-subtle">
                      Task
                    </th>
                    {windows.map((window) => (
                      <th
                        key={window.id}
                        className="h-10 px-2 text-left align-bottom font-medium text-kumo-subtle"
                      >
                        <span className="text-kumo-default">{window.label}</span>{" "}
                        {status?.active === window.id ? (
                          <Badge variant="info" className="text-xs">
                            now
                          </Badge>
                        ) : null}
                        <br />
                        <span className="font-normal">{windowRange(window)}</span>
                        {runsPastMidnight(window) ? (
                          <span className="font-normal"> · past midnight</span>
                        ) : null}
                      </th>
                    ))}
                    <th className="h-10 px-2 text-left align-bottom font-medium text-kumo-subtle">
                      <span className="text-kumo-default">Other times</span>{" "}
                      {status && !status.active ? (
                        <Badge variant="info" className="text-xs">
                          now
                        </Badge>
                      ) : null}
                      <br />
                      <span className="font-normal">Default models</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {routes.map((route) => {
                    const fallback = route.models.length
                      ? route.models
                      : (derived.get(route.id) ?? []);
                    // In the active window, a task with no list of its own can still run on other
                    // models than at other times, when it picks automatically.
                    const now = effective?.[route.id];
                    const shifted = Boolean(now && now.join("\n") !== fallback.join("\n"));
                    return (
                      <tr key={route.id} className="border-b border-kumo-hairline last:border-b-0">
                        <td className="whitespace-nowrap p-2 font-medium">{route.label}</td>
                        {windows.map((window) => {
                          const own = route.windows?.[window.id];
                          return (
                            <td
                              key={window.id}
                              className={`p-2 align-top ${
                                status?.active === window.id ? "bg-kumo-tint" : ""
                              }`}
                            >
                              {own?.length ? (
                                chainText(own, names)
                              ) : status?.active === window.id && shifted && now ? (
                                chainText(now, names)
                              ) : (
                                <span className="text-kumo-subtle">Same as other times</span>
                              )}
                            </td>
                          );
                        })}
                        <td
                          className={`p-2 align-top ${status && !status.active ? "bg-kumo-tint" : ""}`}
                        >
                          {chainText(fallback, names)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {idle ? (
              <div className="pt-3">
                <Banner
                  variant="default"
                  title="No task uses these windows yet"
                  description="A window only changes a task once that task lists models for it. Open a task's Customize and turn on Models by time."
                  action={
                    firstUnconfigured ? (
                      <Banner.Action onClick={() => onCustomize(firstUnconfigured.id)}>
                        Configure {firstUnconfigured.label}
                      </Banner.Action>
                    ) : undefined
                  }
                />
              </div>
            ) : null}
            <p className="pt-3 text-xs text-kumo-subtle">
              Windows repeat every day
              {schedule?.timezone ? ` in ${schedule.timezone}` : " in this machine's time zone"}.
              The first window that contains the time wins. Choose Customize on a task to set its
              models for each window.
            </p>
          </LayerCard.Primary>
        ) : null}
      </LayerCard>

      <LayerDialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) closeEditor();
        }}
        dismissDisabled={busy}
      >
        <LayerDialog.Content size="lg" verticalAlign="top">
          <LayerDialog.Title>Schedule</LayerDialog.Title>
          <LayerDialog.Description>
            Name the time ranges. Then set each task's models for a range with Customize.
          </LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex min-h-0 flex-1 flex-col gap-5 pb-4">
              <Input
                id="schedule-timezone"
                label="Time zone"
                value={draft.timezone}
                disabled={busy}
                list="schedule-zones"
                error={draftErrors.timezone}
                description="Leave empty to use the time zone of the machine that runs Jevonian."
                placeholder="Asia/Singapore"
                onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}
              />
              <datalist id="schedule-zones">
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
              {browserZone() && draft.timezone !== browserZone() ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  disabled={busy}
                  onClick={() => setDraft({ ...draft, timezone: browserZone() })}
                >
                  Use {browserZone()}
                </Button>
              ) : null}

              <fieldset disabled={busy} className="space-y-3">
                <legend className="mb-2 text-sm font-medium">Time windows</legend>
                <p className="text-xs text-kumo-subtle">
                  A window is a daily time range. The first window that contains the time wins, so
                  the order sets the priority.
                </p>
                {draft.windows.length === 0 ? (
                  <p className="rounded-lg bg-kumo-tint p-3 text-sm text-kumo-subtle">
                    No windows yet. A window is a daily time range, such as 22:00 to 08:00 for an
                    off-peak discount.
                  </p>
                ) : null}
                {draftShadows.length > 0 ? (
                  <Banner
                    variant="alert"
                    icon={<Warning size={16} aria-hidden />}
                    title={
                      draftShadows.length === 1
                        ? `${windowName(draftShadows[0].window)} never runs`
                        : `${draftShadows.length} windows never run`
                    }
                    description={draftShadows
                      .map(
                        (entry) =>
                          `${windowName(entry.by)} covers the whole ${windowName(entry.window)} range and comes first.`,
                      )
                      .join(" ")}
                  />
                ) : draftOverlaps.length > 0 ? (
                  <Banner
                    variant="default"
                    title="These windows overlap"
                    description={`${draftOverlaps
                      .map(
                        ([later, earlier]) =>
                          `${windowName(later)} overlaps ${windowName(earlier)}`,
                      )
                      .join(", ")}. The first one wins in the overlap.`}
                  />
                ) : null}
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={dropWindow}
                >
                  <SortableContext
                    items={draft.windows.map((window) => window.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="flex flex-col gap-2">
                      {draft.windows.map((window, index) => {
                        const entry = draftErrors.windows[window.id];
                        return (
                          <WindowRow
                            key={window.id}
                            id={window.id}
                            index={index}
                            count={draft.windows.length}
                            onMove={moveDraftWindow}
                          >
                            <div className="space-y-3">
                              <div className="flex items-end gap-2">
                                <div className="min-w-0 flex-1">
                                  <Input
                                    id={`schedule-label-${window.id}`}
                                    label="Name"
                                    value={window.label}
                                    error={entry?.label}
                                    onChange={(event) =>
                                      updateWindow(index, { label: event.target.value })
                                    }
                                  />
                                </div>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Remove ${window.label || "window"}`}
                                  onClick={() =>
                                    setDraft({
                                      ...draft,
                                      windows: draft.windows.filter((_, i) => i !== index),
                                    })
                                  }
                                >
                                  <X size={16} aria-hidden />
                                </Button>
                              </div>
                              <div className="grid grid-cols-2 gap-3">
                                <Input
                                  id={`schedule-start-${window.id}`}
                                  label="From"
                                  type="time"
                                  value={window.start}
                                  error={entry?.start}
                                  onChange={(event) =>
                                    updateWindow(index, { start: event.target.value })
                                  }
                                />
                                <Input
                                  id={`schedule-end-${window.id}`}
                                  label="Until"
                                  type="time"
                                  value={window.end}
                                  error={entry?.end}
                                  onChange={(event) =>
                                    updateWindow(index, { end: event.target.value })
                                  }
                                />
                              </div>
                              {runsPastMidnight(window) ? (
                                <p className="text-xs text-kumo-subtle">
                                  This window runs past midnight: it ends the next day.
                                </p>
                              ) : null}
                            </div>
                          </WindowRow>
                        );
                      })}
                    </div>
                  </SortableContext>
                </DndContext>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={draft.windows.length >= MAX_SCHEDULE_WINDOWS}
                  onClick={addWindow}
                >
                  <Plus size={16} aria-hidden /> Add window
                </Button>
              </fieldset>

              {error ? (
                <Banner variant="error" title="Cannot save the schedule" description={error} />
              ) : null}

              {confirmRemove ? (
                <Banner
                  variant="alert"
                  title="Remove the schedule?"
                  description="Every task goes back to its default models. The models you set for each window are deleted."
                  action={
                    <>
                      <Banner.Action variant="primary" onClick={() => void save(null)}>
                        Remove schedule
                      </Banner.Action>
                      <Banner.Action onClick={() => setConfirmRemove(false)}>Keep</Banner.Action>
                    </>
                  }
                />
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-hairline pt-3">
                {schedule ? (
                  <Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>
                    Remove schedule
                  </Button>
                ) : (
                  <span className="text-xs text-kumo-subtle">New schedule</span>
                )}
                <div className="flex gap-2">
                  <Button variant="outline" disabled={busy} onClick={closeEditor}>
                    Cancel
                  </Button>
                  <Button variant="primary" disabled={busy} onClick={commit}>
                    {busy ? "Saving…" : "Save schedule"}
                  </Button>
                </div>
              </div>
            </div>
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}
