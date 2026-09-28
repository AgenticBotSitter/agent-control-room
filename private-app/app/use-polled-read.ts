"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPolledReadScheduler, type PolledReadIntervalReason } from "../../src/web/v1/polled-read-scheduler";
import { sharePolledRequest } from "../../src/web/v1/polled-request-sharing";

/**
 * The one shared polling hook for the owner website.
 *
 * This is deliberately a new file so that adopting it elsewhere is a mechanical
 * edit inside a single component's effect, with no restyling of the pages it
 * reads. It is the only place the owner UI decides how often to read.
 *
 * Behaviour, all of it enforced by `createPolledReadScheduler`:
 *  - reads pause while the tab is hidden, and refresh on focus or return;
 *  - requests never overlap, and a trigger during a read is coalesced;
 *  - failures back off, and unchanged data backs off, both bounded;
 *  - components asking for the same `shareKey` on one page share one request.
 */

export interface PolledReadState<T> {
  value: T | undefined;
  error: unknown;
  loading: boolean;
  /** Immediately read again at the base interval, from a button or a caller. */
  refresh: () => void;
  /**
   * Drop the held value without reading again. For a caller that learns its
   * own last read is stale, such as a write that failed to record.
   */
  clear: () => void;
}

export interface UsePolledReadOptions<T> {
  /** Stable identity for the read. Changing it restarts polling. */
  key: string;
  read: (signal: AbortSignal) => Promise<T>;
  baseIntervalMs: number;
  /** Set false to stop polling entirely (for example a closed panel). */
  enabled?: boolean;
  /**
   * Shared-request key. Two components passing the same key on one page issue
   * one request. Defaults to `key`, which is usually what you want.
   */
  shareKey?: string;
  unchanged?: (previous: T, next: T) => boolean;
  onAccept?: (value: T) => void;
  onFailure?: (reason: unknown) => void;
  onInterval?: (delayMs: number, reason: PolledReadIntervalReason) => void;
}

export function usePolledRead<T>(options: UsePolledReadOptions<T>): PolledReadState<T> {
  const { key, read, baseIntervalMs, enabled = true, shareKey, unchanged, onAccept, onFailure, onInterval } = options;
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const scheduler = useRef<ReturnType<typeof createPolledReadScheduler<T>> | undefined>(undefined);
  // Callers pass inline closures, so the latest ones are read through a ref.
  // The effect depends on the identity of the read, not of the callbacks.
  const latest = useRef({ read, unchanged, onAccept, onFailure, onInterval });
  latest.current = { read, unchanged, onAccept, onFailure, onInterval };

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    const current = latest.current;
    // Deferring the first read lets React's development StrictMode clean up its
    // probe effect before any network request begins.
    const instance = createPolledReadScheduler<T>({
      read: signal => sharePolledRequest(`${shareKey ?? key}`,
        signal2 => current.read(signal2), signal),
      accept: next => { setValue(next); setError(undefined); setLoading(false); current.onAccept?.(next); },
      failed: reason => { setError(reason); setLoading(false); current.onFailure?.(reason); },
      baseIntervalMs,
      hidden: () => typeof document === "undefined" ? false : document.hidden,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
      unchanged: current.unchanged,
      observe: current.onInterval,
    });
    scheduler.current = instance;
    setLoading(true);
    instance.start();
    // A tab that was hidden when this effect ran still needs its first read
    // once it is shown, so a hidden mount does not wait for the first interval.
    const visible = () => { if (!document.hidden) instance.trigger(); };
    const focused = () => instance.trigger();
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", visible);
    return () => {
      scheduler.current = undefined;
      instance.stop();
      window.removeEventListener("focus", focused);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [key, shareKey, baseIntervalMs, enabled]);

  const refresh = useCallback(() => scheduler.current?.trigger(), []);
  const clear = useCallback(() => { setValue(undefined); setError(undefined); }, []);
  return { value, error, loading, refresh, clear };
}
