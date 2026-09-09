import type { createNativeNodeRuntime } from "../harness/hermes-native-v1/node-runtime";
import { nativeHttpLimits, nativeHttpRequestSchema, nativeHttpResponseSchema,
  type NativeHttpRequest, type NativeHttpResponse } from "../harness/v1/native-http-exchange";
import { NATIVE_WIRE_MAX_BYTES } from "../harness/v1/native-wire";
import { assertSynchronousFence } from "../security/synchronous-fence";

export interface NativeHttpClient {
  exchange(request: NativeHttpRequest, signal: AbortSignal): Promise<NativeHttpResponse>;
  close(): Promise<void>;
}
type Runtime = ReturnType<typeof createNativeNodeRuntime>;
const error = () => new Error("native_http_node_unavailable");

/** Explicit outbound host. Native execution remains a separate runtime action. A step
 * performs bounded protocol exchange only; no HTTP uncertainty is retried. */
export function createNativeHttpNodeHost(runtime: Pick<Runtime, "openWire" | "receiveWire" | "disconnected">,
  supplied: NativeHttpClient, assertCurrent: () => void) {
  const node = { open: runtime.openWire.bind(runtime), receive: runtime.receiveWire.bind(runtime),
    disconnected: runtime.disconnected.bind(runtime) };
  const client = { exchange: supplied.exchange.bind(supplied), close: supplied.close.bind(supplied) };
  const available = assertCurrent, lifetime = new AbortController();
  type Generation = { id: string; packets: string[]; bytes: number; closed: boolean };
  let generation: Generation | undefined, busy = false, closed = false, closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  function current(record?: Generation) {
    if (closed || lifetime.signal.aborted || record && (generation !== record || record.closed)) throw error();
    assertSynchronousFence(available, () => { throw error(); });
    if (closed || lifetime.signal.aborted) throw error();
  }
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  }
  async function exchange(input: NativeHttpRequest, signal: AbortSignal, record?: Generation) {
    current(record); const request = nativeHttpRequestSchema.parse(input);
    const result = await track(client.exchange(request, signal)); current(record);
    if (signal.aborted) throw error();
    const value = nativeHttpResponseSchema.parse(result);
    if (record && value.connection !== record.id) throw error();
    return value;
  }
  async function step(record: Generation, signal: AbortSignal) {
    let more = false;
    for (let i = 0; i < nativeHttpLimits.exchangesPerStep; i++) {
      current(record);
      // Keep the submitted item counted until this exact exchange settles successfully.
      const packet = record.packets[0] ?? null;
      const result = await exchange({ schema: "control-room.native-http/v1", operation: "exchange",
        connection: record.id, packet }, signal, record);
      if (packet !== null) {
        if (record.packets[0] !== packet) throw error();
        record.packets.shift(); record.bytes -= Buffer.byteLength(packet);
      }
      for (const received of result.packets) { current(record); await node.receive(received, signal); current(record); }
      more = result.more;
      if (!record.packets.length && !more) return;
    }
    throw error();
  }
  async function operation<T>(signal: AbortSignal, work: (owned: AbortSignal) => Promise<T>) {
    current();
    if (!(signal instanceof AbortSignal) || signal.aborted || busy) throw error();
    busy = true; const controller = new AbortController();
    const abort = () => controller.abort();
    lifetime.signal.addEventListener("abort", abort, { once: true }); signal.addEventListener("abort", abort, { once: true });
    let rejectStopped!: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
    const cancelled = () => rejectStopped(error()); controller.signal.addEventListener("abort", cancelled, { once: true });
    const timer = setTimeout(abort, nativeHttpLimits.requestMs);
    try {
      const result = await Promise.race([track(Promise.resolve().then(() => {
        current(); if (controller.signal.aborted) throw error(); return work(controller.signal);
      })), stopped]);
      current(); if (controller.signal.aborted) throw error(); return result;
    } catch { void close().catch(() => {}); throw error(); }
    finally { clearTimeout(timer); controller.abort(); busy = false;
      lifetime.signal.removeEventListener("abort", abort); signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", cancelled); }
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; lifetime.abort();
    if (generation) { generation.closed = true; generation.packets.length = 0; generation.bytes = 0; }
    closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.all([Promise.resolve().then(client.close),
          Promise.resolve().then(() => node.disconnected(new AbortController().signal)), Promise.allSettled([...pending])]),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("native_http_node_close_uncertain")), nativeHttpLimits.closeMs); })]);
      } finally { clearTimeout(timer); }
    })(); return closing;
  }
  return Object.freeze({
    open(mode: "initial" | "recover", signal: AbortSignal) {
      return operation(signal, async owned => {
        if (generation) throw error();
        const value = await exchange({ schema: "control-room.native-http/v1", operation: "open", mode }, owned);
        if (value.packets.length || value.more) throw error();
        const record: Generation = { id: value.connection, packets: [], bytes: 0, closed: false }; generation = record;
        await node.open({ async send(packet) {
          current(record); const bytes = Buffer.byteLength(packet);
          if (bytes > NATIVE_WIRE_MAX_BYTES || record.packets.length >= nativeHttpLimits.packets
            || record.bytes + bytes > nativeHttpLimits.queuedBytes) throw error();
          record.packets.push(packet); record.bytes += bytes;
        }, async close() { record.closed = true; record.packets.length = 0; record.bytes = 0; } }, record.id, owned);
        current(record); await step(record, owned);
      });
    },
    step(signal: AbortSignal) { return operation(signal, async owned => {
      if (!generation) throw error(); await step(generation, owned);
    }); },
    disconnect(signal: AbortSignal) { return operation(signal, async owned => {
      const record = generation; if (!record) throw error();
      await exchange({ schema: "control-room.native-http/v1", operation: "close", connection: record.id }, owned, record);
      await node.disconnected(owned); record.closed = true; generation = undefined;
    }); },
    isReady: () => { try { current(generation); return Boolean(generation); } catch { return false; } },
    close,
  });
}
