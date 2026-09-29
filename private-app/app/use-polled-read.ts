"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPolledReadScheduler, structuralEqual, type PolledReadIntervalReason } from "../../src/web/v1/polled-read-scheduler";
import { sharePolledRequest } from "../../src/web/v1/polled-request-sharing";
import { createPolledReadFetch, type PolledReadFetch } from "../../src/web/v1/polled-conditional-fetch";

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
  read: (signal: AbortSignal, transport: PolledReadFetch) => Promise<T>;
  baseIntervalMs: number;
  /** Set false to stop polling entirely (for example a closed panel). */
  enabled?: boolean;
  /**
   * Shared-request key. Two components passing the same key on one page issue
   * one request. Defaults to `key`, which is usually what you want.
   */
  shareKey?: string;
  unchanged?: (previous: T, next: T) => boolean;
  /**
   * Drop the last accepted value after a failed read. Use this for reads whose
   * value exposes an authority to act; ordinary status views retain continuity.
   */
  dropValueOnError?: boolean;
  onAccept?: (value: T) => void;
  onFailure?: (reason: unknown) => void;
  onInterval?: (delayMs: number, reason: PolledReadIntervalReason) => void;
}

export function usePolledRead<T>(options: UsePolledReadOptions<T>): PolledReadState<T> {
  const { key, read, baseIntervalMs, enabled = true, shareKey, unchanged, dropValueOnError, onAccept, onFailure, onInterval } = options;
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const scheduler = useRef<ReturnType<typeof createPolledReadScheduler<T>> | undefined>(undefined);
  // Callers pass inline closures, so the latest ones are read through a ref.
  // The effect depends on the identity of the read, not of the callbacks.
  const latest = useRef({ read, unchanged, dropValueOnError, onAccept, onFailure, onInterval });
  latest.current = { read, unchanged, dropValueOnError, onAccept, onFailure, onInterval };

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    // The read and its callbacks are read through the ref at *call* time, not
    // snapshotted here: a caller whose inputs change (a new projectId, a new
    // filter) must have its next read built from the new values, not from the
    // values present when this effect last ran.
    beginRead();
    const transport = createPolledReadFetch();
    const instance = createPolledReadScheduler<T>({
      read: signal => sharePolledRequest(`${shareKey ?? key}`,
        signal2 => latest.current.read(signal2, transport), signal),
      accept: next => { setValue(next); setError(undefined); setLoading(false); latest.current.onAccept?.(next); },
      failed: reason => {
        if (latest.current.dropValueOnError) setValue(undefined);
        setError(reason); setLoading(false); latest.current.onFailure?.(reason);
      },
      baseIntervalMs,
      hidden: () => typeof document === "undefined" ? false : document.hidden,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
      // No predicate supplied means "use the scheduler's own change detection".
      // Defaulting to `?? true` here reported *every* read as unchanged, so a
      // page whose data actually changed still stretched out to the 4x quiet
      // ceiling — the opposite of the discipline this hook exists to provide.
      unchanged: (previous, next) => (latest.current.unchanged ?? structuralEqual)(previous, next),
      observe: (delayMs, reason) => latest.current.onInterval?.(delayMs, reason),
    });
    scheduler.current = instance;
    setLoading(true);
    instance.start();
    // A tab that was hidden when this effect ran still needs its first read
    // once it is shown, so a hidden mount does not wait for the first interval.
    const visible = () => { if (!document.hidden) instance.trigger(); };
    // A `focus` event only reaches a tab the owner is actually looking at, so
    // it is a visible-tab signal even where `document.hidden` is unreliable
    // (a test DOM, or a prerendered document that has never been shown).
    const focused = () => instance.trigger(true);
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", visible);
    return () => {
      scheduler.current = undefined;
      instance.stop();
      window.removeEventListener("focus", focused);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [key, shareKey, baseIntervalMs, enabled]);

  // Initial load and an explicit refresh deliberately clear presentation.
  // Background polls retain the last accepted value until their replacement
  // arrives, matching the hand-written effects and avoiding periodic flicker.
  const beginRead = useCallback(() => { setValue(undefined); setError(undefined); setLoading(true); }, []);

  const refresh = useCallback(() => { beginRead(); scheduler.current?.trigger(); }, [beginRead]);
  const clear = useCallback(() => { setValue(undefined); setError(undefined); setLoading(false); }, []);
  return { value, error, loading, refresh, clear };
}
