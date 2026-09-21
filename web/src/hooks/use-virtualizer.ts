import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface VirtualItem {
  index: number;
  start: number;
  size: number;
}

export interface UseVirtualizerOptions {
  count: number;
  /** Height used until the real row has been measured. */
  estimateSize: (index: number) => number;
  overscan?: number;
  getScrollElement: () => HTMLElement | null;
}

export interface Virtualizer {
  getVirtualItems: () => VirtualItem[];
  getTotalSize: () => number;
  measureElement: (node: HTMLElement | null) => void;
  scrollToIndex: (index: number, options?: { align?: "start" | "end" | "auto" }) => void;
}

/**
 * Zero-dependency vertical virtualizer with dynamic row measurement.
 *
 * Only the rows intersecting the viewport (plus an overscan margin) are rendered, so
 * a ledger with tens of thousands of records scrolls at the same cost as one with a
 * few dozen. Row heights come from a single `ResizeObserver` rather than a fixed
 * constant, so wrapped model names and badges do not cause layout drift.
 */
export function useVirtualizer({
  count,
  estimateSize,
  overscan = 8,
  getScrollElement,
}: UseVirtualizerOptions): Virtualizer {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [measuredVersion, setMeasuredVersion] = useState(0);

  const measuredSizes = useRef<Map<number, number>>(new Map());
  const elements = useRef<Map<number, HTMLElement>>(new Map());
  const observer = useRef<ResizeObserver | null>(null);

  useLayoutEffect(() => {
    observer.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const raw = target.dataset.index;
        if (raw === undefined) continue;
        const index = Number.parseInt(raw, 10);
        const height = target.getBoundingClientRect().height;
        if (height > 0 && measuredSizes.current.get(index) !== height) {
          measuredSizes.current.set(index, height);
          changed = true;
        }
      }
      // One re-render per observer batch, not one per row.
      if (changed) setMeasuredVersion((n) => n + 1);
    });
    const tracked = elements.current;
    const current = observer.current;
    return () => {
      current?.disconnect();
      tracked.clear();
    };
  }, []);

  const measureElement = useCallback((node: HTMLElement | null) => {
    const raw = node?.dataset.index;
    if (!node || raw === undefined) return;
    const index = Number.parseInt(raw, 10);

    const previous = elements.current.get(index);
    if (previous && previous !== node) observer.current?.unobserve(previous);
    elements.current.set(index, node);
    observer.current?.observe(node);

    const height = node.getBoundingClientRect().height;
    if (height > 0 && measuredSizes.current.get(index) !== height) {
      measuredSizes.current.set(index, height);
      setMeasuredVersion((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    const element = getScrollElement();
    if (!element) return;

    const sync = () => setViewportHeight(element.clientHeight);
    const onScroll = () => setScrollTop(element.scrollTop);
    sync();
    onScroll();

    element.addEventListener("scroll", onScroll, { passive: true });
    const resize = new ResizeObserver(sync);
    resize.observe(element);
    return () => {
      element.removeEventListener("scroll", onScroll);
      resize.disconnect();
    };
  }, [getScrollElement]);

  // Offsets are rebuilt each render from the measured sizes. The Maps are mutable
  // refs, so `measuredVersion` is what schedules the recompute; the loop itself is a
  // single linear pass, which is far cheaper than the per-row render it replaces.
  const { offsets, totalSize } = useMemo(() => {
    const next = Array.from<number>({ length: count }).fill(0);
    let running = 0;
    for (let index = 0; index < count; index += 1) {
      next[index] = running;
      running += measuredSizes.current.get(index) ?? estimateSize(index);
    }
    return { offsets: next, totalSize: running };
  }, [count, estimateSize, measuredVersion]);

  const sizeOf = useCallback(
    (index: number) => measuredSizes.current.get(index) ?? estimateSize(index),
    [estimateSize],
  );

  /** First index whose bottom edge is at or below `scroll`. */
  const firstVisible = useMemo(() => {
    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const offset = offsets[mid] ?? 0;
      if (offset + sizeOf(mid) < scrollTop) low = mid + 1;
      else if (offset > scrollTop) high = mid - 1;
      else return mid;
    }
    return Math.max(0, Math.min(count - 1, low));
  }, [count, offsets, scrollTop, sizeOf]);

  const getVirtualItems = useCallback((): VirtualItem[] => {
    if (count === 0 || viewportHeight === 0) {
      // Before the viewport is measured, render a screenful so first paint is not blank.
      const fallback = Math.min(count, 12);
      return Array.from({ length: fallback }, (_, index) => ({
        index,
        start: offsets[index] ?? 0,
        size: sizeOf(index),
      }));
    }

    const items: VirtualItem[] = [];
    const start = Math.max(0, firstVisible - overscan);
    const bottom = scrollTop + viewportHeight;
    for (let index = start; index < count; index += 1) {
      if ((offsets[index] ?? 0) > bottom) break;
      items.push({ index, start: offsets[index] ?? 0, size: sizeOf(index) });
    }
    const last = items.at(-1)?.index ?? start;
    for (let index = last + 1; index < Math.min(count, last + 1 + overscan); index += 1) {
      items.push({ index, start: offsets[index] ?? 0, size: sizeOf(index) });
    }
    return items;
  }, [count, viewportHeight, firstVisible, overscan, scrollTop, offsets, sizeOf]);

  const scrollToIndex = useCallback(
    (index: number, options?: { align?: "start" | "end" | "auto" }) => {
      const element = getScrollElement();
      if (!element || index < 0 || index >= count) return;
      const offset = offsets[index] ?? 0;
      const size = sizeOf(index);
      const align = options?.align ?? "auto";

      if (align === "start") element.scrollTop = offset;
      else if (align === "end") element.scrollTop = offset + size - viewportHeight;
      else if (offset < element.scrollTop) element.scrollTop = offset;
      else if (offset + size > element.scrollTop + viewportHeight) {
        element.scrollTop = offset + size - viewportHeight;
      }
    },
    [getScrollElement, offsets, sizeOf, count, viewportHeight],
  );

  return {
    getVirtualItems,
    getTotalSize: () => totalSize,
    measureElement,
    scrollToIndex,
  };
}
