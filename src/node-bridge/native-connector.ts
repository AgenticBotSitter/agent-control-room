import { z } from "zod";
import type { createNativeNodeRuntime } from "../harness/hermes-native-v1/node-runtime";
import { snapshotSchema, terminalNativeState, type NativeState } from "../harness/hermes-native-v1/contracts";
import { createNativeHttpNodeHost, type NativeHttpClient } from "./native-http-host";
import { createNativeNodeHttpsClient } from "./native-https-client";

type Runtime = ReturnType<typeof createNativeNodeRuntime>;
const settingsSchema = z.object({ maxCycles: z.number().int().min(1).max(10_000),
  intervalMs: z.number().int().min(1).max(5_000), timeoutMs: z.number().int().min(1).max(300_000) }).strict();
export type NativeConnectorSettings = z.input<typeof settingsSchema>;
export type NativeConnectorResult = Readonly<{ disposition: "terminal" | "uncertain" | "bounded";
  state: NativeState | "waiting"; cycles: number }>;
type Sources = { assertCurrent(): void; wait?(milliseconds: number, signal: AbortSignal): Promise<void> };
const unavailable = () => new Error("native_connector_unavailable");
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(unavailable()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  });
}

/** Explicit one-task run owner. Journals stay caller-owned and uncertainty never retries. */
export function createNativeConnector(runtime: Runtime, client: NativeHttpClient,
  input: NativeConnectorSettings, sources: Sources) {
  const settings = settingsSchema.parse(input), available = sources.assertCurrent.bind(sources);
  const pause = sources.wait?.bind(sources) ?? wait;
  const ready = runtime.hasAcceptedDispatch.bind(runtime), start = runtime.start.bind(runtime), poll = runtime.poll.bind(runtime);
  const closeRuntime = runtime.close.bind(runtime), host = createNativeHttpNodeHost(runtime, client, available);
  const lifetime = new AbortController(), pending = new Set<Promise<unknown>>();
  let attempted = false, closed = false, closing: Promise<void> | undefined;
  function current(signal?: AbortSignal) { if (closed || lifetime.signal.aborted || signal?.aborted) throw unavailable();
    available(); if (closed || lifetime.signal.aborted || signal?.aborted) throw unavailable(); }
  function track<T>(work: Promise<T>) { pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work; }
  function close() {
    if (closing) return closing; closed = true; lifetime.abort();
    closing = (async () => { let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (async () => { try { await host.close(); } finally { await closeRuntime(); } })();
      try { await Promise.race([Promise.all([cleanup, Promise.allSettled([...pending])]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("native_connector_close_uncertain")), 10_000); })]);
      } catch { throw new Error("native_connector_close_uncertain"); } finally { clearTimeout(timer); }
    })(); return closing;
  }
  return Object.freeze({ close,
    run(mode: "initial" | "recover", signal: AbortSignal): Promise<NativeConnectorResult> {
      current(signal); if (attempted || !(signal instanceof AbortSignal) || !["initial", "recover"].includes(mode)) throw unavailable();
      attempted = true; const controller = new AbortController(), abort = () => controller.abort();
      const deadline = performance.now() + settings.timeoutMs;
      // Timers can be delayed by busy trusted code. Refuse the next connector
      // operation even when the timeout callback has not received a turn yet.
      const runningCurrent = () => {
        current(controller.signal);
        if (performance.now() >= deadline) { controller.abort(); throw unavailable(); }
      };
      lifetime.signal.addEventListener("abort", abort, { once: true }); signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, settings.timeoutMs);
      let rejectStopped!: (error: Error) => void;
      const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
      const stop = () => rejectStopped(unavailable()); controller.signal.addEventListener("abort", stop, { once: true });
      const work = track(Promise.resolve().then(async (): Promise<NativeConnectorResult> => {
        runningCurrent(); await host.open(mode, controller.signal);
        let started = false, state: NativeState | "waiting" = "waiting";
        for (let cycles = 1; cycles <= settings.maxCycles; cycles++) {
          runningCurrent(); await host.step(controller.signal); runningCurrent();
          const dispatchReady = ready(); runningCurrent();
          if (dispatchReady === true) {
            const snapshot = snapshotSchema.parse(await (mode === "initial" && !started ? start(controller.signal) : poll(controller.signal)));
            started = true; state = snapshot.state; runningCurrent();
            await host.step(controller.signal); runningCurrent();
            const disposition = terminalNativeState(state) ? "terminal"
              : state === "ambiguous" || snapshot.availability !== "current" ? "uncertain" : undefined;
            if (disposition) { await host.disconnect(controller.signal); return Object.freeze({ disposition, state, cycles }); }
          }
          if (cycles < settings.maxCycles) { await pause(settings.intervalMs, controller.signal); runningCurrent(); }
          else { await host.disconnect(controller.signal); return Object.freeze({ disposition: "bounded", state, cycles }); }
        }
        throw unavailable();
      }));
      return (async () => {
        try { const result = await Promise.race([work, stopped]); runningCurrent(); return result; }
        catch { throw unavailable(); }
        finally {
          try { await close(); }
          finally { clearTimeout(timer); controller.abort(); controller.signal.removeEventListener("abort", stop);
            signal.removeEventListener("abort", abort); lifetime.signal.removeEventListener("abort", abort); }
        }
      })();
    },
  });
}

export function createNativeHttpsConnector(runtime: Runtime,
  configuration: Parameters<typeof createNativeNodeHttpsClient>[0], settings: NativeConnectorSettings,
  sources: Parameters<typeof createNativeNodeHttpsClient>[1] & Sources,
  ports?: Parameters<typeof createNativeNodeHttpsClient>[2]) {
  const captured = settingsSchema.parse(settings);
  return createNativeConnector(runtime, createNativeNodeHttpsClient(configuration, sources, ports), captured, sources);
}
