// One column template for the Logs table header, its rows and the loading skeleton, so they line up.
// Time, Phase, Effort, Status, Cost, Latency and Details keep a width that fits their content.
// Model and Provider share the rest of the row.
export const LOGS_ROW_GRID =
  "grid grid-cols-[5rem_minmax(7.5rem,3fr)_minmax(5rem,2fr)_4rem_4rem_3.5rem_4rem_4rem_5rem] gap-2 px-4";

// Narrower than this, the table scrolls sideways instead of squeezing the columns into each other.
// The fixed columns, the minimum Model and Provider widths, the gaps and the padding add up to 48rem.
export const LOGS_TABLE_MIN_WIDTH = "min-w-[48rem]";

// The inspector sits beside the table only when the table keeps LOGS_TABLE_MIN_WIDTH next to the
// filter rail (15rem), the 30rem inspector and the gaps. With the sidebar (16rem) and the page
// padding (5rem) that is 1848px of window, and 1888px leaves room for a scrollbar.
// Narrower, the inspector opens in a drawer.
// Keep this in step with the `min-[118rem]` class on the inspector in pages/logs.tsx.
export const INLINE_INSPECTOR_QUERY = "(min-width: 118rem)";
