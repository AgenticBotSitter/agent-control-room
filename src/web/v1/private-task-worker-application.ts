import type { PrivateApplication } from "./private-process";

/** Joint host lifecycle, not a process supervisor. Install this view only after
 * both components are ready. Caller keeps raw application operations server-only
 * for canonical worker routing; this view exposes no SQL, identity or queue input. */
export function composePrivateTaskWorkerApplication(
  application: PrivateApplication & { isReady(): boolean },
  worker: { close(): Promise<void>; status(): { accepting: boolean } },
  timeoutMs = 60_000,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error("private_task_worker_config_invalid");
  const handle = application.handle.bind(application), closeApp = application.close.bind(application);
  const appReady = application.isReady.bind(application), workerState = worker.status.bind(worker), closeWorker = worker.close.bind(worker);
  let closing = false, closePromise: Promise<void> | undefined;
  const isReady = () => {
    try { return !closing && appReady() && workerState().accepting; } catch { return false; }
  };
  const bounded = async (work: () => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error()), timeoutMs);
    })]); } finally { clearTimeout(timer); }
  };
  return Object.freeze({ isReady,
    handle: ((...args) => {
      if (!isReady()) return Promise.resolve(new Response("Service unavailable", {
        status: 503, headers: { "cache-control": "no-store" },
      }));
      return handle(...args);
    }) as PrivateApplication["handle"],
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        let uncertain = false;
        // Current deliveries retain application/session services until the worker
        // drains. No new browser requests are admitted after close begins.
        try { await bounded(closeWorker); } catch { uncertain = true; }
        try { await bounded(closeApp); } catch { uncertain = true; }
        if (uncertain) {
          const error = new Error("private_task_worker_cleanup_uncertain"); error.stack = undefined; throw error;
        }
      })();
      return closePromise;
    },
  });
}
