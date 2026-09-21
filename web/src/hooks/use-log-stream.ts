import { useEffect, useRef, useState } from "react";

import type { LogRecord } from "@/lib/api";

export type LogStreamStatus = "connecting" | "live" | "offline";

interface UseLogStreamOptions {
  /** Turn the stream off to stop reconnecting, e.g. when the operator pauses it. */
  enabled: boolean;
  /** Serialized filter query, so changing a filter reconnects with the new one. */
  query: string;
  /** Called for each record the server pushes, in arrival order. */
  onRecord: (record: LogRecord) => void;
  /** Called after (re)connecting, to backfill anything missed while offline. */
  onReady?: () => void;
}

/**
 * Subscribes to the server's ledger tail.
 *
 * The server pushes each record the moment it is appended, so a finished request
 * appears without waiting for a poll interval. `EventSource` reconnects on its own
 * after a dropped connection; the status is surfaced so the UI can say whether the
 * feed is actually live instead of implying it always is.
 */
export function useLogStream({
  enabled,
  query,
  onRecord,
  onReady,
}: UseLogStreamOptions): LogStreamStatus {
  const [status, setStatus] = useState<LogStreamStatus>("connecting");
  // Kept in refs so a new callback identity never tears down the connection.
  const recordRef = useRef(onRecord);
  const readyRef = useRef(onReady);
  recordRef.current = onRecord;
  readyRef.current = onReady;

  useEffect(() => {
    if (!enabled) {
      setStatus("offline");
      return;
    }

    setStatus("connecting");
    const suffix = query ? `?${query}` : "";
    const source = new EventSource(`/api/logs/stream${suffix}`);

    source.addEventListener("ready", () => {
      setStatus("live");
      readyRef.current?.();
    });

    source.addEventListener("log", (event) => {
      try {
        recordRef.current(JSON.parse((event as MessageEvent<string>).data) as LogRecord);
      } catch {
        // A malformed frame is skipped rather than killing the stream.
      }
    });

    // The server sends a comment-like ping to hold the connection open; it carries
    // no record, so it only confirms the transport is still alive.
    source.addEventListener("ping", () => setStatus("live"));

    source.addEventListener("error", () => setStatus("connecting"));

    return () => source.close();
  }, [enabled, query]);

  return status;
}
