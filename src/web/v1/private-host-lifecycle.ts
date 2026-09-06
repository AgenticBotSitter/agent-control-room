import { bindPrivateHostShutdown } from "./private-host-shutdown";

/** Explicit entrypoint composition, not an automatic service or retry loop.
 * Registers supplied stop events before one startup attempt, then reuses the
 * existing bounded shutdown bridge. The caller supplies an authorized start.
 */
export function startPrivateHostLifecycle<Host extends { close(): Promise<void> }>(input: {
  start(signal: AbortSignal): Promise<Host>;
  signals: Parameters<typeof bindPrivateHostShutdown>[1];
  shutdownMs?: number;
}) {
  const controller = new AbortController();
  const start = input.start.bind(input);
  const on = input.signals.on.bind(input.signals), off = input.signals.off.bind(input.signals);
  const listeners = new Map<string, () => void>();
  let attempted = false;
  const shutdown = bindPrivateHostShutdown({ async close() {
    controller.abort();
    let host: Host;
    try { host = await starting; }
    catch { if (!attempted) return; throw new Error("private_host_start_cleanup_uncertain"); }
    await host.close();
  } }, {
    on(signal, listener) {
      const wrapped = () => { controller.abort(); listener(); };
      listeners.set(signal, wrapped);
      return on(signal, wrapped);
    },
    off(signal) {
      const wrapped = listeners.get(signal);
      if (wrapped) { off(signal, wrapped); listeners.delete(signal); }
    },
  }, input.shutdownMs);
  const starting = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw new Error("private_host_start_canceled");
    attempted = true;
    return start(controller.signal);
  });
  const ready = starting.then(host => {
    if (controller.signal.aborted) throw new Error("private_host_start_canceled");
    return host;
  }).catch(() => {
    void shutdown.stop();
    throw new Error("private_host_start_unavailable");
  });
  // Own failure observation even if an operator starts waiting on completed first.
  // The original ready promise still rejects for its caller.
  void ready.catch(() => {});
  return Object.freeze({ ready, completed: shutdown.completed,
    stop() { controller.abort(); return shutdown.stop(); } });
}
