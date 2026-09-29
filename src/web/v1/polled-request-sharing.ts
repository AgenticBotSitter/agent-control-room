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

type SharedRequest = {
  controller: AbortController;
  promise: Promise<unknown>;
  subscribers: number;
};

const inFlight = new Map<string, SharedRequest>();

/** Collapses concurrent reads of `key` into one request. Never caches a result. */
export function sharePolledRequest<T>(key: string, request: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let shared = inFlight.get(key) as SharedRequest | undefined;
  if (!shared) {
    const controller = new AbortController();
    const started: SharedRequest = {
      controller, subscribers: 0,
      promise: (async () => request(controller.signal))().finally(() => {
        if (inFlight.get(key) === started) inFlight.delete(key);
      }),
    };
    shared = started;
    inFlight.set(key, shared);
  }
  shared.subscribers += 1;
  const entry = shared;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      entry.subscribers -= 1;
      if (entry.subscribers === 0 && inFlight.get(key) === entry) {
        // An abort rejects asynchronously. Remove this entry first so an
        // effect remounted in the same commit starts a live request rather
        // than subscribing to the request we have just cancelled.
        inFlight.delete(key);
        entry.controller.abort();
      }
    };
    const aborted = () => { release(); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
    entry.promise.then(
      value => { if (!settled) { release(); resolve(value as T); } },
      reason => { if (!settled) { release(); reject(reason); } },
    );
  });
}

/** Test-only. Reports the number of requests currently in flight. */
export function sharedRequestCountForTest(): number { return inFlight.size; }
