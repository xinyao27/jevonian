import type {
  ProviderView,
  RoutingEntryView,
  ScheduleStatusView,
  ScheduleView,
  ScheduleWindowView,
} from "./api.ts";

/** The server accepts at most this many windows. */
export const MAX_SCHEDULE_WINDOWS = 12;

/**
 * Claude plans cost the same at every hour, so there is nothing to schedule when every connected
 * provider signs in with the Claude Code login. An empty Schedule card would only be noise there.
 * Providers on other plans (an API key, or a token plan with an off-peak discount) keep the card.
 */
export function offersTimeBasedModels(providers: Pick<ProviderView, "oauthSource">[]): boolean {
  return providers.length === 0 || providers.some((provider) => provider.oauthSource !== "claude-code");
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** HH:MM on a 24-hour clock. */
export function validClock(value: string): boolean {
  return CLOCK.test(value);
}

/** A window whose end is before its start covers midnight, such as 22:00 to 08:00. */
export function runsPastMidnight(window: Pick<ScheduleWindowView, "start" | "end">): boolean {
  return validClock(window.start) && validClock(window.end) && window.end < window.start;
}

export function windowRange(window: Pick<ScheduleWindowView, "start" | "end">): string {
  return `${window.start}–${window.end}`;
}

/** A unique window id (lowercase letters, digits, hyphens; starts with a letter) from a label. */
export function windowSlug(label: string, taken: string[]): string {
  let base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .replace(/-+$/, "")
      .slice(0, 40) || "window";
  if (base === "auto") base = "auto-window";
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

export function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone this browser runs in, a good default for a new schedule. */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
}

/** IANA zone names this browser knows, for the zone picker. May be empty on old browsers. */
export function knownZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/** Per-window validation errors, keyed by window id, so each can render at its own field. */
export interface WindowErrors {
  label?: string;
  start?: string;
  end?: string;
}

export interface ScheduleErrors {
  timezone?: string;
  windows: Record<string, WindowErrors>;
}

/** Every reason a schedule cannot be saved, so the editor can show them all at once. */
export function scheduleErrors(schedule: ScheduleView): ScheduleErrors {
  const errors: ScheduleErrors = { windows: {} };
  if (schedule.timezone && !validZone(schedule.timezone)) {
    errors.timezone = `"${schedule.timezone}" is not a time zone name. Use a name such as Asia/Singapore.`;
  }
  if (schedule.windows.length > MAX_SCHEDULE_WINDOWS) {
    errors.timezone = errors.timezone ?? `Use at most ${MAX_SCHEDULE_WINDOWS} windows.`;
  }
  for (const window of schedule.windows) {
    const entry: WindowErrors = {};
    if (!window.label.trim()) entry.label = "Name this window.";
    if (!validClock(window.start) || !validClock(window.end)) {
      if (!validClock(window.start)) entry.start = "Pick a start time such as 22:00.";
      if (!validClock(window.end)) entry.end = "Pick an end time such as 08:00.";
    } else if (window.start === window.end) {
      entry.start = "The start and the end must differ.";
    }
    if (entry.label || entry.start || entry.end) errors.windows[window.id] = entry;
  }
  return errors;
}

export function hasScheduleErrors(errors: ScheduleErrors): boolean {
  return Boolean(errors.timezone) || Object.keys(errors.windows).length > 0;
}

/** First error message, in a stable order, for a top-level alert. */
export function firstScheduleError(errors: ScheduleErrors, windows: ScheduleWindowView[]): string {
  if (errors.timezone) return errors.timezone;
  for (const window of windows) {
    const entry = errors.windows[window.id];
    if (!entry) continue;
    const name = window.label.trim() || "An unnamed window";
    const message = entry.label ?? entry.start ?? entry.end;
    if (message) return `${name}: ${message}`;
  }
  return "";
}

/** Minutes since midnight for a "HH:MM" clock, or null when it is not valid. */
function clockMinutes(value: string): number | null {
  if (!validClock(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * True when two daily windows share any minute. A window whose end is before its start
 * covers midnight, so 22:00-08:00 overlaps 23:00-01:00.
 */
export function windowsOverlap(
  a: Pick<ScheduleWindowView, "start" | "end">,
  b: Pick<ScheduleWindowView, "start" | "end">,
): boolean {
  const from = clockMinutes(a.start);
  const to = clockMinutes(a.end);
  const otherFrom = clockMinutes(b.start);
  const otherTo = clockMinutes(b.end);
  if (from === null || to === null || otherFrom === null || otherTo === null) return false;
  // Expand each window into minute sets on a 1440-minute day, then intersect.
  const minutes = (start: number, end: number): Set<number> => {
    const set = new Set<number>();
    if (start < end) {
      for (let m = start; m < end; m += 1) set.add(m);
    } else {
      for (let m = start; m < 1440; m += 1) set.add(m);
      for (let m = 0; m < end; m += 1) set.add(m);
    }
    return set;
  };
  const first = minutes(from, to);
  for (const minute of minutes(otherFrom, otherTo)) {
    if (first.has(minute)) return true;
  }
  return false;
}

/** A named window that can never apply, because an earlier window always covers it first. */
export interface ShadowedWindow {
  /** The window that is hidden. */
  window: ScheduleWindowView;
  /** The earlier window that covers it. */
  by: ScheduleWindowView;
}

/**
 * Windows that the first-match rule makes unreachable. A window is shadowed when an
 * earlier window in the list covers every minute it covers, so it can never be active.
 */
export function shadowedWindows(windows: ScheduleWindowView[]): ShadowedWindow[] {
  const shadowed: ShadowedWindow[] = [];
  for (let i = 0; i < windows.length; i += 1) {
    const later = windows[i];
    for (let j = 0; j < i; j += 1) {
      const earlier = windows[j];
      if (windowsOverlap(later, earlier) && within(later, earlier)) {
        shadowed.push({ window: later, by: earlier });
        break;
      }
    }
  }
  return shadowed;
}

/** True when every minute of `inner` is also inside `outer`. */
function within(
  inner: Pick<ScheduleWindowView, "start" | "end">,
  outer: Pick<ScheduleWindowView, "start" | "end">,
): boolean {
  const innerFrom = clockMinutes(inner.start);
  const innerTo = clockMinutes(inner.end);
  const outerFrom = clockMinutes(outer.start);
  const outerTo = clockMinutes(outer.end);
  if (innerFrom === null || innerTo === null || outerFrom === null || outerTo === null) return false;
  const inOuter = (minute: number): boolean => {
    if (outerFrom < outerTo) return minute >= outerFrom && minute < outerTo;
    return minute >= outerFrom || minute < outerTo;
  };
  if (innerFrom < innerTo) {
    for (let m = innerFrom; m < innerTo; m += 1) if (!inOuter(m)) return false;
    return true;
  }
  for (let m = innerFrom; m < 1440; m += 1) if (!inOuter(m)) return false;
  for (let m = 0; m < innerTo; m += 1) if (!inOuter(m)) return false;
  return true;
}

/** Windows that overlap an earlier window but are not fully hidden by it. */
export function partialOverlaps(windows: ScheduleWindowView[]): [ScheduleWindowView, ScheduleWindowView][] {
  const hidden = new Set(shadowedWindows(windows).map((entry) => entry.window.id));
  const pairs: [ScheduleWindowView, ScheduleWindowView][] = [];
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (hidden.has(windows[i].id)) continue;
      if (windowsOverlap(windows[i], windows[j])) pairs.push([windows[i], windows[j]]);
    }
  }
  return pairs;
}

/** True when no task lists models for any window, so the schedule changes nothing yet. */
export function scheduleIsIdle(
  routes: Pick<RoutingEntryView, "windows">[],
  schedule: ScheduleView | undefined,
): boolean {
  if (!schedule || schedule.windows.length === 0) return false;
  const known = new Set(schedule.windows.map((window) => window.id));
  return !routes.some((route) =>
    Object.entries(route.windows ?? {}).some(([id, models]) => known.has(id) && models.length > 0),
  );
}

/** Move the window at `index` to `to`, returning a new list. */
export function moveWindow<T>(windows: T[], index: number, to: number): T[] {
  if (to < 0 || to >= windows.length || index === to) return windows;
  const next = windows.slice();
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Drop per-window model lists whose window is gone, and empty lists. */
export function pruneWindowLists(
  routes: RoutingEntryView[],
  schedule: ScheduleView | null,
): RoutingEntryView[] {
  const known = new Set(schedule?.windows.map((window) => window.id) ?? []);
  return routes.map((route) => {
    if (!route.windows) return route;
    const kept = Object.fromEntries(
      Object.entries(route.windows).filter(([id, models]) => known.has(id) && models.length > 0),
    );
    if (Object.keys(kept).length > 0) return { ...route, windows: kept };
    const copy = { ...route };
    delete copy.windows;
    return copy;
  });
}

/** HH:MM of an RFC 3339 time, read in the zone the server wrote it in. */
export function clockOf(iso: string | undefined): string {
  return iso && iso.length >= 16 ? iso.slice(11, 16) : "";
}

/** "today", "tomorrow", or the date, for `iso` as seen from `nowIso` (both in the schedule zone). */
export function dayWord(iso: string | undefined, nowIso: string | undefined): string {
  if (!iso || !nowIso) return "";
  const day = iso.slice(0, 10);
  const today = nowIso.slice(0, 10);
  if (day === today) return "today";
  const next = new Date(`${today}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return day === next.toISOString().slice(0, 10) ? "tomorrow" : day;
}

/** One sentence on what is active now and when that changes. */
export function scheduleSummary(status: ScheduleStatusView, windows: ScheduleWindowView[]): string {
  const label = (id: string | undefined) => windows.find((window) => window.id === id)?.label ?? id;
  const now = `It is ${clockOf(status.now)} in ${status.timezone}.`;
  const active = status.active
    ? `${status.activeLabel ?? label(status.active)} is active.`
    : "No window is active, so every task uses its default models.";
  if (!status.nextChange) return `${now} ${active}`;
  const when = `${clockOf(status.nextChange)} ${dayWord(status.nextChange, status.now)}`;
  const next = status.nextActive
    ? `${label(status.nextActive)} starts at ${when}.`
    : `${status.activeLabel ?? "The window"} ends at ${when}.`;
  return `${now} ${active} ${next}`;
}
