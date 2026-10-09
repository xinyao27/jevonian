import assert from "node:assert/strict";
import { test } from "node:test";

import {
  firstScheduleError,
  hasScheduleErrors,
  moveWindow,
  partialOverlaps,
  runsPastMidnight,
  scheduleErrors,
  scheduleIsIdle,
  scheduleSummary,
  shadowedWindows,
  windowSlug,
  windowsOverlap,
} from "../web/src/lib/schedule.ts";

const window = (id, start, end) => ({ id, label: id, start, end });

test("windowsOverlap catches plain and past-midnight ranges", () => {
  assert.equal(windowsOverlap(window("a", "09:00", "17:00"), window("b", "12:00", "13:00")), true);
  assert.equal(windowsOverlap(window("a", "09:00", "17:00"), window("b", "17:00", "18:00")), false);
  // 22:00-08:00 crosses midnight, so it contains 23:00-01:00 and 02:00-03:00.
  assert.equal(windowsOverlap(window("a", "22:00", "08:00"), window("b", "23:00", "01:00")), true);
  assert.equal(windowsOverlap(window("a", "22:00", "08:00"), window("b", "02:00", "03:00")), true);
  assert.equal(windowsOverlap(window("a", "22:00", "08:00"), window("b", "09:00", "10:00")), false);
  // An invalid clock never overlaps, so a half-typed value does not raise a false alarm.
  assert.equal(windowsOverlap(window("a", "", "08:00"), window("b", "02:00", "03:00")), false);
});

test("shadowedWindows names a window an earlier one fully covers", () => {
  const covered = shadowedWindows([
    window("workday", "09:00", "17:00"),
    window("lunch", "12:00", "13:00"),
  ]);
  assert.equal(covered.length, 1);
  assert.equal(covered[0].window.id, "lunch");
  assert.equal(covered[0].by.id, "workday");

  // The same pair in the other order leaves both reachable.
  assert.deepEqual(
    shadowedWindows([window("lunch", "12:00", "13:00"), window("workday", "09:00", "17:00")]),
    [],
  );
  // A partial overlap is not shadowed: it still runs in the minutes the earlier one misses.
  assert.deepEqual(
    shadowedWindows([window("workday", "09:00", "17:00"), window("evening", "16:00", "20:00")]),
    [],
  );
});

test("partialOverlaps reports overlap that keeps both windows reachable", () => {
  const pairs = partialOverlaps([
    window("workday", "09:00", "17:00"),
    window("evening", "16:00", "20:00"),
  ]);
  assert.equal(pairs.length, 1);
  assert.deepEqual(
    pairs[0].map((entry) => entry.id),
    ["evening", "workday"],
  );
  // A fully covered window is a shadow, not a partial overlap.
  assert.deepEqual(
    partialOverlaps([window("workday", "09:00", "17:00"), window("lunch", "12:00", "13:00")]),
    [],
  );
});

test("runsPastMidnight is true when the end is before the start", () => {
  assert.equal(runsPastMidnight(window("a", "22:00", "08:00")), true);
  assert.equal(runsPastMidnight(window("a", "09:00", "17:00")), false);
});

test("windowSlug makes a unique lowercase id", () => {
  assert.equal(windowSlug("Off-nights", []), "off-nights");
  assert.equal(windowSlug("Off-nights", ["off-nights"]), "off-nights-2");
  // A label that starts with a digit drops the leading run, and an empty slug falls back.
  assert.equal(windowSlug("2 peak", []), "peak");
  assert.equal(windowSlug("!!!", []), "window");
  // "auto" is reserved for the routing id, so it is renamed here.
  assert.equal(windowSlug("auto", []), "auto-window");
});

test("scheduleErrors reports each problem at its own field", () => {
  const errors = scheduleErrors({
    timezone: "Not/AZone",
    windows: [
      { id: "a", label: "", start: "09:00", end: "17:00" },
      { id: "b", label: "Workday", start: "09:00", end: "09:00" },
    ],
  });
  assert.equal(typeof errors.timezone, "string");
  assert.equal(errors.windows.a.label, "Name this window.");
  assert.equal(errors.windows.b.start, "The start and the end must differ.");
  assert.equal(hasScheduleErrors(errors), true);
  // The summary prefers the time zone error, and otherwise names the first bad window.
  assert.equal(firstScheduleError(errors, []), errors.timezone);
  assert.equal(
    firstScheduleError(
      { windows: errors.windows },
      [{ id: "a", label: "", start: "09:00", end: "17:00" }],
    ),
    "An unnamed window: Name this window.",
  );
});

test("scheduleErrors is clean for a valid schedule and limits the window count", () => {
  const clean = scheduleErrors({
    timezone: "Asia/Singapore",
    windows: [window("off-nights", "22:00", "08:00")],
  });
  assert.equal(hasScheduleErrors(clean), false);
  assert.equal(firstScheduleError(clean, []), "");

  const many = scheduleErrors({
    timezone: "",
    windows: Array.from({ length: 13 }, (_, index) =>
      window(`w${index}`, "09:00", "17:00"),
    ),
  });
  assert.match(many.timezone ?? "", /at most 12 windows/);
});

test("scheduleIsIdle is true only when no task lists models for a window", () => {
  const schedule = { timezone: "", windows: [window("off-nights", "22:00", "08:00")] };
  assert.equal(scheduleIsIdle([{ windows: undefined }, { windows: {} }], schedule), true);
  assert.equal(scheduleIsIdle([{ windows: { "off-nights": [] } }], schedule), true);
  assert.equal(
    scheduleIsIdle([{ windows: { "off-nights": ["deepseek-v4.1-flash"] } }], schedule),
    false,
  );
  // A list for a window that no longer exists does not count.
  assert.equal(scheduleIsIdle([{ windows: { gone: ["m"] } }], schedule), true);
  // No schedule at all is never the idle state this reports.
  assert.equal(scheduleIsIdle([{ windows: {} }], undefined), false);
});

test("moveWindow moves one entry and ignores out-of-range moves", () => {
  assert.deepEqual(moveWindow(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
  assert.deepEqual(moveWindow(["a", "b", "c"], 0, -1), ["a", "b", "c"]);
  assert.deepEqual(moveWindow(["a", "b", "c"], 0, 3), ["a", "b", "c"]);
  assert.deepEqual(moveWindow(["a", "b", "c"], 1, 1), ["a", "b", "c"]);
});

test("scheduleSummary states what is active and when it changes", () => {
  const windows = [window("off-nights", "22:00", "08:00"), window("workday", "12:00", "13:00")];
  const active = scheduleSummary(
    {
      timezone: "Asia/Singapore",
      now: "2026-10-09T17:13:00+08:00",
      active: "workday",
      activeLabel: "Workday",
      nextChange: "2026-10-10T22:00:00+08:00",
      nextActive: "off-nights",
    },
    windows,
  );
  assert.match(active, /It is 17:13 in Asia\/Singapore\./);
  assert.match(active, /Workday is active\./);
  assert.match(active, /off-nights starts at 22:00 tomorrow\./);

  // The active window ends and nothing takes over.
  const ending = scheduleSummary(
    {
      timezone: "Asia/Singapore",
      now: "2026-10-09T17:13:00+08:00",
      active: "workday",
      activeLabel: "Workday",
      nextChange: "2026-10-09T13:00:00+08:00",
    },
    windows,
  );
  assert.match(ending, /Workday ends at 13:00 today\./);

  const idle = scheduleSummary(
    { timezone: "Asia/Singapore", now: "2026-10-09T17:13:00+08:00", active: "" },
    windows,
  );
  assert.match(idle, /No window is active/);
});
