import type { HerdrObservationSource } from './herdr-observation-source';

/** Thin adaptation of the evaluated Herdr pane-list observer. The trusted port
 * must perform only the pinned CLI's `pane list`, bound output, isolate its
 * environment and own cancellation/terminal cleanup. No arbitrary command port.
 * These functions do not qualify an executable, endpoint or OS isolation.
 */
export function createHerdrCollector(source: HerdrObservationSource, ports: {
  endpointIdentity(signal: AbortSignal): Promise<string>;
  paneList(signal: AbortSignal): Promise<string>;
}, timeoutMs = 2000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000)
    throw new Error('observation_configuration_invalid');
  const identity = ports.endpointIdentity.bind(ports), read = ports.paneList.bind(ports);
  let closed = false, busy = false, generation = 0, previousIdentity: string | undefined;
  let active: AbortController | undefined;
  const unavailable = () => new Error('observation_unavailable');
  return Object.freeze({
    close() { closed = true; active?.abort(); source.revoke(); },
    disconnect() { active?.abort(); source.disconnect(); },
    async poll(signal: AbortSignal): Promise<void> {
      if (closed || busy || signal.aborted) throw unavailable();
      const ticket = source.begin();
      busy = true;
      const controller = new AbortController(); active = controller;
      const end = performance.now() + timeoutMs;
      const stop = () => controller.abort();
      let rejectStopped!: () => void;
      const stopped = new Promise<never>((_, reject) => { rejectStopped = () => reject(unavailable()); });
      void stopped.catch(() => {});
      controller.signal.addEventListener('abort', rejectStopped, { once: true });
      signal.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, timeoutMs);
      const current = () => {
        if (closed || signal.aborted || controller.signal.aborted || performance.now() >= end
            || source.view().status === 'not_configured') throw unavailable();
      };
      const operation = (async () => {
        current();
        const before = await identity(controller.signal); current();
        if (typeof before !== 'string' || !before.length || before.length > 512) throw unavailable();
        const raw = await read(controller.signal); current();
        const after = await identity(controller.signal); current();
        if (before !== after) throw unavailable();
        const next = previousIdentity === before ? generation : generation + 1;
        ticket.accept(raw, next);
        previousIdentity = before; generation = next;
      })();
      // A timeout reports unavailability, but cannot free admission while an
      // ignored cancellation is still executing. Only terminal port settlement
      // releases busy. Late settlements are observed, never published/retried.
      void operation.finally(() => { busy = false; if (active === controller) active = undefined; }).catch(() => {});
      try { await Promise.race([operation, stopped]); }
      catch { ticket.fail(); throw unavailable(); }
      finally { clearTimeout(timer); signal.removeEventListener('abort', stop);
        controller.signal.removeEventListener('abort', rejectStopped); }
    },
  });
}
