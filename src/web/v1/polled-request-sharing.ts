/**
 * One in-flight request per endpoint per browser tab.
 *
 * Several owner pages mount more than one component that reads the same
 * endpoint. Before this existed, each component ran its own timer and its own
 * `focus` listener, so a page with N news sources or N open article readers
 * issued N requests for the same URL every interval, and a single focus event
 * fired all N at once. Sharing the in-flight promise collapses that to one
 * request whose result every component accepts.
 *
 * The map is module-level, so sharing is scoped to one JavaScript realm, which
 * is exactly one browser tab. It is never shared across tabs, and it holds no
 * response body: only the in-flight promise, which is dropped as soon as it
 * settles. A settled entry is never reused, so this can never serve a stored
 * response to a later reader — it only ever collapses concurrent readers.
 */

const inFlight = new Map<string, Promise<unknown>>();

/** Collapses concurrent reads of `key` into one request. Never caches a result. */
export function sharePolledRequest<T>(key: string, request: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const started = (async () => {
    try { return await request(signal); } finally { inFlight.delete(key); }
  })();
  inFlight.set(key, started);
  return started;
}

/** Test-only. Reports the number of requests currently in flight. */
export function sharedRequestCountForTest(): number { return inFlight.size; }
