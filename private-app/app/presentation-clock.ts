"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

let now = Date.now();
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;
const snapshot = () => now;

/** One visible-page clock for relative ages and expiry, independent of network reads. */
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const refresh = () => {
      if (document.hidden) return;
      now = Date.now();
      for (const notify of listeners) notify();
    };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    stop = () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stop?.(); stop = undefined; }
  };
}

export function usePresentationNow() {
  // React may read the hydration snapshot twice in one render. Keep that
  // value stable while taking a fresh instant for each new server render.
  const [renderedAt] = useState(() => Date.now());
  const serverSnapshot = useCallback(() => renderedAt, [renderedAt]);
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
