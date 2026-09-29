"use client";

import { useEffect, useRef } from "react";

/** One shared, serialized refresh loop for read-only saved-state views. Hidden tabs never poll. */
export function useVisiblePolling(load: (signal: AbortSignal) => Promise<void>, enabled = true, intervalMs = 30_000) {
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    refresh.current = () => {};
    if (!enabled) return;
    let live = true, inFlight = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    const schedule = () => { if (live) poll = setTimeout(refreshWhenVisible, intervalMs); };
    const read = async () => {
      if (!live || inFlight) return;
      inFlight = true; clearTimeout(poll); request = new AbortController();
      try { await load(request.signal); }
      finally { request = undefined; inFlight = false; schedule(); }
    };
    const refreshWhenVisible = () => { if (!document.hidden) void read(); };
    refresh.current = refreshWhenVisible;
    const initial = setTimeout(refreshWhenVisible, 0);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      live = false; refresh.current = () => {}; clearTimeout(initial); clearTimeout(poll); request?.abort();
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [enabled, intervalMs, load]);
  return () => refresh.current();
}
