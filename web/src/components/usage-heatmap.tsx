import { LayerCard, Text } from "@cloudflare/kumo";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
} from "motion/react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { ProviderLogo } from "@/components/provider-logo";
import type { ActivityModelStatView, ActivitySeriesPointView } from "@/lib/api";
import { PROVIDER_ICONS, PROVIDER_IMAGES } from "@/lib/logos";
import { resolveProviderIdentity } from "@/lib/provider-name";
import { cn, formatCompact } from "@/lib/utils";

export type UsageLevel = 0 | 1 | 2 | 3 | 4;

type UsageDay = { date: string; count: number; level: UsageLevel };

type UsageModelRow = {
  id: string;
  name: string;
  requests: number;
  brand: string;
};

// Model families the provider vocabulary does not carry: it knows `claude` and `gemini`, but
// not the OpenAI naming. First match wins, so the order matters.
const MODEL_BRAND_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(gpt|chatgpt|o[1-9]|codex)\b/, "openai"],
  [/^claude\b/, "claude-subscription"],
  [/^gemini\b/, "google"],
  [/^grok\b/, "xai"],
  [/^(mistral|magistral|codestral|devstral)\b/, "mistral"],
];

/** The brand key for a model id, for its footer avatar. */
function modelBrand(model: string): string {
  const resolved = resolveProviderIdentity(model).brand;
  if (PROVIDER_ICONS[resolved] ?? PROVIDER_IMAGES[resolved]) return resolved;

  const id = model.toLowerCase();
  for (const [pattern, brand] of MODEL_BRAND_PATTERNS) {
    if (pattern.test(id)) return brand;
  }
  return resolved;
}

function modelRows(models: ActivityModelStatView[]): UsageModelRow[] {
  return models.slice(0, MODEL_ROWS).map((model) => ({
    id: model.model,
    name: model.label ?? model.model,
    requests: model.requests,
    brand: modelBrand(model.model),
  }));
}

const DEFAULT_ACCENT = "var(--color-kumo-brand)";
const DEFAULT_CELL_SIZE = 11;
// Cells grow to fill the card on short histories, but never past this, or a two-week window
// would render a handful of enormous squares.
const MAX_CELL_SIZE = 30;
const STACK_LIMIT = 3;
const MODEL_ROWS = 5;
// A month label narrower than its own text would sit under the next month's cells.
const MIN_LABEL_WEEKS = 3;
const WEEKS_PER_MONTH = 365.25 / 12 / 7;

const LEVELS = [0, 1, 2, 3, 4] as const;
const LEVEL_OPACITY: Record<UsageLevel, number> = { 0: 0, 1: 0.3, 2: 0.52, 3: 0.76, 4: 1 };
const LEVEL_CUTS = [0.2, 0.45, 0.7] as const;

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];
const SPRING = { type: "spring", bounce: 0.2, duration: 0.62 } as const;
const HEADER_SPRING = { ...SPRING, bounce: 0.45 } as const;
const ROW_SPRING = { ...SPRING, bounce: 0.26, delay: 0.08 } as const;
const ROW_OFFSET = 16;
const CELL_FADE = { duration: 0.2, ease: EASE_OUT } as const;
const TOOLTIP_FADE = { duration: 0.14, ease: EASE_OUT } as const;
const TOOLTIP_EDGE = 8;
const COLUMN_STAGGER = 0.012;
const LABEL_BLUR = 6;
const LABEL_REVEAL = { duration: 0.45, ease: EASE_OUT } as const;

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const gapFor = (cellSize: number) => Math.max(2, Math.round(cellSize / 4));
// Never zero: weeks.slice(-0) would hand back the whole history instead of nothing.
const weeksFor = (months: number) => Math.max(1, Math.ceil(months * WEEKS_PER_MONTH));

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function levelFor(count: number, max: number): UsageLevel {
  if (count <= 0 || max <= 0) return 0;
  const ratio = count / max;
  if (ratio < LEVEL_CUTS[0]) return 1;
  if (ratio < LEVEL_CUTS[1]) return 2;
  if (ratio < LEVEL_CUTS[2]) return 3;
  return 4;
}

/**
 * Daily activity buckets are local-midnight instants, so read the day back in local time;
 * slicing the UTC ISO string would shift every cell by one day east of Greenwich.
 */
function toUsageDays(series: ActivitySeriesPointView[]): UsageDay[] {
  const points: Array<{ at: Date; count: number }> = [];
  for (const point of series) {
    const at = new Date(point.timestamp);
    if (!Number.isNaN(at.getTime())) points.push({ at, count: point.totalTokens });
  }
  if (points.length === 0) return [];

  const max = Math.max(...points.map((point) => point.count), 0);
  const days: UsageDay[] = [];

  // Pad the head so the first cell is a Sunday; otherwise every column shears off a weekday.
  const lead = points[0].at.getDay();
  for (let i = lead; i > 0; i--) {
    const date = new Date(points[0].at);
    date.setDate(date.getDate() - i);
    days.push({ date: localDayKey(date), count: 0, level: 0 });
  }

  for (const point of points) {
    days.push({
      date: localDayKey(point.at),
      count: point.count,
      level: levelFor(point.count, max),
    });
  }

  // Pad the tail so the last column is a full week, keeping row positions true to weekday.
  const tail = days.length % 7;
  if (tail !== 0) {
    const last = points[points.length - 1].at;
    for (let i = 1; i <= 7 - tail; i++) {
      const date = new Date(last);
      date.setDate(date.getDate() + i);
      days.push({ date: localDayKey(date), count: 0, level: 0 });
    }
  }

  return days;
}

function toMonthLabels(weeks: UsageDay[][]) {
  const labels: (string | null)[] = weeks.map(() => null);
  const monthAt = (index: number) => weeks[index]?.[0]?.date.slice(5, 7);

  let start = 0;
  for (let i = 1; i <= weeks.length; i++) {
    if (i < weeks.length && monthAt(i) === monthAt(start)) continue;
    if (i - start >= MIN_LABEL_WEEKS) {
      labels[start] = MONTH_NAMES[Number(monthAt(start)) - 1] ?? null;
    }
    start = i;
  }

  return labels;
}

type LevelStyle = { backgroundColor: string; opacity: number };

function toScale(accent: string | string[]): LevelStyle[] {
  if (typeof accent === "string") {
    return LEVELS.map((level) => ({ backgroundColor: accent, opacity: LEVEL_OPACITY[level] }));
  }

  const colors = accent.length > 4 ? accent : ["transparent", ...accent];
  return LEVELS.map((level) => {
    const color = colors[level] ?? colors.at(-1) ?? "transparent";
    return { backgroundColor: color, opacity: color === "transparent" ? 0 : 1 };
  });
}

function toWeeks(days: UsageDay[]): UsageDay[][] {
  const weeks: UsageDay[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

/**
 * Fit the grid to the card: show every week when they all fit and grow the cells to fill the
 * width, otherwise keep the base cell size and show the most recent columns only.
 */
function useFittedGrid(ref: RefObject<HTMLDivElement | null>, baseCell: number, total: number) {
  const [width, setWidth] = useState<number>();

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  const baseGap = gapFor(baseCell);
  if (!width || total <= 0) {
    return { visible: total, cell: baseCell, gap: baseGap };
  }

  const maxColumns = Math.max(1, Math.floor((width + baseGap) / (baseCell + baseGap)));
  if (total > maxColumns) {
    return { visible: maxColumns, cell: baseCell, gap: baseGap };
  }

  // Every week fits, so grow the cells to consume the slack. The while loop matters because
  // the gap grows with the cell, which can push a first-guess size back over the edge.
  let cell = Math.max(
    baseCell,
    Math.min(MAX_CELL_SIZE, Math.floor((width + baseGap) / total) - baseGap),
  );
  let gap = gapFor(cell);
  while (cell > baseCell && total * cell + (total - 1) * gap > width) {
    cell -= 1;
    gap = gapFor(cell);
  }
  return { visible: total, cell, gap };
}

type HoveredDay = { day: UsageDay; x: number; y: number };

function describeDay({ count, date }: UsageDay) {
  const noun = count === 1 ? "token" : "tokens";
  return `${formatCompact(count)} ${noun} on ${DATE_FORMAT.format(new Date(`${date}T00:00:00`))}`;
}

const Tooltip = ({
  hovered,
  reduceMotion,
}: {
  hovered: HoveredDay;
  reduceMotion: boolean | null;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(hovered.x);

  useIsoLayoutEffect(() => {
    const half = (ref.current?.offsetWidth ?? 0) / 2;
    const edge = TOOLTIP_EDGE + half;
    setLeft(Math.min(Math.max(hovered.x, edge), window.innerWidth - edge));
  }, [hovered]);

  return createPortal(
    <div
      className="pointer-events-none fixed z-50"
      style={{ left, top: hovered.y, transform: "translate(-50%, calc(-100% - 8px))" }}
    >
      <motion.div
        ref={ref}
        className="whitespace-nowrap rounded-lg bg-kumo-contrast px-2 py-1 text-[11px] font-medium text-kumo-inverse shadow-md"
        initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
        transition={reduceMotion ? { duration: 0 } : TOOLTIP_FADE}
      >
        {describeDay(hovered.day)}
      </motion.div>
    </div>,
    document.body,
  );
};

const UsageGrid = ({
  weeks,
  scale,
  cellSize,
  gap,
  showMonths,
  label,
  reduceMotion,
}: {
  weeks: UsageDay[][];
  scale: LevelStyle[];
  cellSize: number;
  gap: number;
  showMonths: boolean;
  label: string;
  reduceMotion: boolean | null;
}) => {
  const [hovered, setHovered] = useState<HoveredDay>();
  const sweepEnd = (weeks.length - 1) * COLUMN_STAGGER + CELL_FADE.duration;

  const hover = (day: UsageDay) => (event: ReactPointerEvent) => {
    const cell = event.currentTarget.getBoundingClientRect();
    setHovered({ day, x: cell.left + cell.width / 2, y: cell.top });
  };

  return (
    <div role="img" aria-label={label}>
      {showMonths && (
        <motion.div
          className="flex justify-center"
          style={{ gap, marginBottom: gap }}
          initial={reduceMotion ? false : { opacity: 0, filter: `blur(${LABEL_BLUR}px)` }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          transition={{ ...LABEL_REVEAL, delay: reduceMotion ? 0 : sweepEnd }}
        >
          {toMonthLabels(weeks).map((month, index) => (
            <div key={index} className="relative h-3 shrink-0" style={{ width: cellSize }}>
              {month && (
                <span className="absolute top-0 left-0 text-[10px] leading-none text-kumo-subtle">
                  {month}
                </span>
              )}
            </div>
          ))}
        </motion.div>
      )}

      <div
        className="flex justify-center"
        style={{ gap }}
        onPointerLeave={() => setHovered(undefined)}
      >
        {weeks.map((week, weekIndex) => (
          <div key={weekIndex} className="flex flex-col" style={{ gap }}>
            {week.map((day) => (
              <motion.div
                key={day.date}
                onPointerEnter={hover(day)}
                className="shrink-0 rounded-[3px] bg-kumo-fill"
                style={{ width: cellSize, height: cellSize }}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.4 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ ...CELL_FADE, delay: reduceMotion ? 0 : weekIndex * COLUMN_STAGGER }}
              >
                <div className="h-full w-full rounded-[3px]" style={scale[day.level] ?? scale[0]} />
              </motion.div>
            ))}
          </div>
        ))}
      </div>

      <AnimatePresence>
        {hovered && <Tooltip key="tooltip" hovered={hovered} reduceMotion={reduceMotion} />}
      </AnimatePresence>
    </div>
  );
};

const Avatar = ({
  layoutId,
  transition,
  className,
  children,
}: {
  layoutId: string;
  transition: Transition;
  className?: string;
  children: ReactNode;
}) => (
  <motion.span
    layoutId={layoutId}
    transition={transition}
    className={cn(
      "grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-kumo-fill text-[11px] font-medium uppercase text-kumo-subtle ring-2 ring-kumo-base",
      "[&_img]:size-full [&_img]:object-cover [&_svg]:size-full",
      className,
    )}
  >
    {children}
  </motion.span>
);

const ModelAvatar = ({
  row,
  layoutId,
  transition,
  className,
}: {
  row: UsageModelRow;
  layoutId: string;
  transition: Transition;
  className?: string;
}) => (
  <Avatar layoutId={layoutId} transition={transition} className={className}>
    <ProviderLogo id={row.brand} />
  </Avatar>
);

const ModelRow = ({
  row,
  layoutId,
  transition,
}: {
  row: UsageModelRow;
  layoutId: string;
  transition: Transition;
}) => (
  <div className="mx-2 flex items-center gap-3 rounded-xl px-2 py-2">
    <ModelAvatar row={row} layoutId={layoutId} transition={transition} />
    <span className="flex-1 truncate text-sm text-kumo-default" title={row.name}>
      {row.name}
    </span>
    <span className="text-sm tabular-nums text-kumo-subtle">
      {row.requests.toLocaleString()}
    </span>
  </div>
);

const Chevron = ({ open, transition }: { open: boolean; transition: Transition }) => (
  <motion.svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className="size-7 text-kumo-inactive"
    initial={false}
    animate={{ rotate: open ? 180 : 0 }}
    transition={transition}
  >
    <circle cx="12" cy="12" r="10" />
    <path d="m16 10-4 4-4-4" />
  </motion.svg>
);

export type UsageHeatmapCardProps = {
  /** Daily token buckets for the selected window; `timestamp` is a local-midnight instant. */
  series: ActivitySeriesPointView[];
  /** Models ranked by spend, shown in the collapsible footer. */
  models: ActivityModelStatView[];
  weekTokens: number;
  monthTokens: number;
  /** Cell edge in px; grows toward `MAX_CELL_SIZE` when the history is short. */
  cellSize?: number;
  /** Most weeks to show, counted back from today. */
  months?: number;
  /** A single color (opacity-graded) or up to five explicit level colors. */
  accent?: string | string[];
  showMonths?: boolean;
  label?: string;
  defaultOpen?: boolean;
  className?: string;
};

/**
 * GitHub-style contribution grid for daily token activity, with a collapsible footer that
 * morphs the top-model avatars into a ranked list.
 */
export function UsageHeatmapCard({
  series,
  models,
  weekTokens,
  monthTokens,
  cellSize = DEFAULT_CELL_SIZE,
  months = 12,
  accent = DEFAULT_ACCENT,
  showMonths = true,
  label = "Top models",
  defaultOpen = false,
  className,
}: UsageHeatmapCardProps) {
  const reduceMotion = useReducedMotion();
  const uid = useId();
  const [open, setOpen] = useState(defaultOpen);
  const toggle = () => setOpen((current) => !current);

  const rootRef = useRef<HTMLDivElement>(null);
  const days = useMemo(() => toUsageDays(series), [series]);
  const weeks = useMemo(() => toWeeks(days), [days]);
  const rows = useMemo(() => modelRows(models), [models]);
  const scale = useMemo(() => toScale(accent), [accent]);

  const cap = Math.min(weeks.length, weeksFor(months));
  const fitted = useFittedGrid(rootRef, cellSize, cap);
  const visible = weeks.slice(-Math.max(1, fitted.visible));

  const total = useMemo(() => days.reduce((sum, day) => sum + day.count, 0), [days]);

  const transition = reduceMotion ? { duration: 0 } : SPRING;
  const headerTransition = reduceMotion ? { duration: 0 } : HEADER_SPRING;
  const rowTransition = reduceMotion ? { duration: 0 } : ROW_SPRING;

  const kick = reduceMotion ? {} : { x: ROW_OFFSET, y: ROW_OFFSET };
  const listMotion = {
    initial: { opacity: 0, ...kick },
    animate: { opacity: 1, x: 0, y: 0 },
    exit: { opacity: 0, ...kick },
  };

  const hasGrid = visible.length > 0;

  return (
    <LayerCard
      className={cn(
        "relative p-4 shadow-none",
        hasGrid && rows.length > 0 && "pb-[76px]",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3 px-1.5 pb-3">
        <div className="min-w-0">
          <Text variant="heading" as="h3">
            Usage
          </Text>
          <p className="mt-0.5 truncate text-xs text-kumo-subtle">
            {hasGrid ? `${formatCompact(total)} tokens · daily activity` : "Daily token activity"}
          </p>
        </div>
        <div className="shrink-0 space-y-1 text-right text-xs text-kumo-subtle">
          <p>
            This week{" "}
            <span className="font-medium text-kumo-default tabular-nums">
              {formatCompact(weekTokens)}
            </span>
          </p>
          <p>
            This month{" "}
            <span className="font-medium text-kumo-default tabular-nums">
              {formatCompact(monthTokens)}
            </span>
          </p>
        </div>
      </div>

      <div ref={rootRef} className="relative">
        {hasGrid ? (
          <>
            <UsageGrid
              weeks={visible}
              scale={scale}
              cellSize={fitted.cell}
              gap={fitted.gap}
              showMonths={showMonths}
              label={`Daily token activity: ${total.toLocaleString()} tokens across ${visible.length} weeks`}
              reduceMotion={reduceMotion}
            />
            <div className="mt-3 flex items-center justify-end gap-1 px-1.5 text-xs text-kumo-subtle">
              <span>Less</span>
              {LEVELS.map((level) => (
                <span
                  key={level}
                  className="size-2.5 overflow-hidden rounded-[2px] bg-kumo-fill"
                  aria-hidden
                >
                  <span className="block size-full" style={scale[level]} />
                </span>
              ))}
              <span>More</span>
            </div>
          </>
        ) : (
          <p className="py-6 text-center text-xs text-kumo-subtle">No usage yet.</p>
        )}
      </div>

      {hasGrid && rows.length > 0 && (
        <motion.div
          layout
          id={`${uid}-panel`}
          data-slot="usage-model-panel"
          data-state={open ? "open" : "closed"}
          className={cn(
            "absolute inset-x-3 bottom-3 overflow-hidden bg-kumo-elevated/90 backdrop-blur-xl",
            open && "top-3",
          )}
          style={{ borderRadius: 18 }}
          transition={transition}
        >
          <motion.div
            layout="position"
            transition={headerTransition}
            className="flex items-center justify-between gap-3 px-4 py-3"
          >
            <span className="truncate text-sm text-kumo-default">{label}</span>

            <div className="flex items-center gap-3">
              {!open && (
                <div className="flex items-center">
                  {rows.slice(0, STACK_LIMIT).map((row, index) => (
                    <ModelAvatar
                      key={row.id}
                      row={row}
                      layoutId={`${uid}-${index}`}
                      transition={transition}
                      className="-ml-2 first:ml-0"
                    />
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                aria-controls={`${uid}-panel`}
                aria-label={open ? "Hide top models" : "Show top models"}
                className="grid size-7 shrink-0 place-items-center rounded-full bg-kumo-base"
              >
                <Chevron open={open} transition={transition} />
              </button>
            </div>
          </motion.div>

          <AnimatePresence initial={false} mode="popLayout">
            {open && (
              <motion.ul
                key="list"
                layout="position"
                {...listMotion}
                transition={rowTransition}
                className="px-0.5 pb-1"
              >
                {rows.map((row, index) => (
                  <li key={row.id}>
                    <ModelRow
                      row={row}
                      layoutId={`${uid}-${index}`}
                      transition={transition}
                    />
                  </li>
                ))}
              </motion.ul>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </LayerCard>
  );
}
