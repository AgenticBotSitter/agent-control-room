import { Worker } from "node:worker_threads";

let active = 0;
/** Necessary adapter: upstream parsing is synchronous and has no wall-clock
 * cancellation. V8 heap limits are not an OS-wide RSS or security sandbox. */
/**
 * @param {unknown} html
 * @param {unknown} sourceUrl
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} options
 */
export async function extractArticleBounded(html, sourceUrl, options = {}) {
  const { timeoutMs = 3000, signal } = options;
  if (typeof html !== "string" || Buffer.byteLength(html, "utf8") > 524288
    || typeof sourceUrl !== "string" || sourceUrl.length > 4096
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000)
    return { status: "input_rejected" };
  if (signal !== undefined && !(signal instanceof AbortSignal)) return { status: "input_rejected" };
  if (signal?.aborted) return { status: "cancelled" };
  if (active >= 2) return { status: "busy" };
  active++;
  let worker, timer, abort;
  try {
    worker = new Worker(new URL("./article-extraction-worker.mjs", import.meta.url), {
      workerData: { html, sourceUrl }, execArgv: [], env: {},
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    return await new Promise(resolve => {
      let result, timedOut = false, cancelled = false;
      abort = () => { cancelled = true; void worker.terminate().catch(() => {}); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => { timedOut = true; void worker.terminate().catch(() => {}); }, timeoutMs);
      worker.once("message", value => { if (!timedOut) result = value; });
      worker.once("error", () => { if (!timedOut) result = { status: "unavailable" }; });
      // Never report result completion before the parsing worker has exited.
      worker.once("exit", code => resolve(cancelled ? { status: "cancelled" } : timedOut ? { status: "timed_out" }
        : code === 0 && result ? result : { status: "unavailable" }));
    });
  } catch { return { status: "unavailable" }; }
  finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    try { if (worker) await worker.terminate(); } finally { active--; }
  }
}
