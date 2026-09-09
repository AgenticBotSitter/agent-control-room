import { createHash, randomUUID } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { z } from "zod";
import { localId } from "../../harness/v1/native-run-identifiers";
import { nativeHttpLimits, nativeHttpJson, nativeHttpRequestSchema, readNativeHttpBody,
  type NativeHttpResponse } from "../../harness/v1/native-http-exchange";
import { nativeEvidenceRegistrationSchema } from "./native-evidence-receiver";
import type { ManagedNativeSessions } from "./managed-native-sessions";
import { createNativeHttpNodeHandler } from "./native-http-node-handler";

const peerIdentity = { nodeId: localId, certificateDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) };
const peerSchema = z.union([
  z.object({ ...peerIdentity, task: nativeEvidenceRegistrationSchema }).strict(),
  z.object({ ...peerIdentity, assignment: z.literal("queue") }).strict(),
]);
export type NativeHttpPeer = z.input<typeof peerSchema>;
export type NativeHttpSettings = { origin: string; peers: readonly NativeHttpPeer[];
  isPeerCurrent(nodeId: string, certificateDigest: string): boolean };
export function captureNativeHttpSettings(input: NativeHttpSettings) {
  const origin = new URL(input.origin);
  if (origin.protocol !== "https:" || origin.origin !== input.origin || origin.username || origin.password
    || typeof input.isPeerCurrent !== "function") throw new Error("native_http_unavailable");
  const peers = z.array(peerSchema).min(1).max(64).parse(input.peers);
  if (new Set(peers.map(p => p.nodeId)).size !== peers.length
    || new Set(peers.map(p => p.certificateDigest)).size !== peers.length) throw new Error("native_http_unavailable");
  return Object.freeze({ origin: origin.origin, peers, isPeerCurrent: input.isPeerCurrent.bind(input) });
}
type Wire = Awaited<ReturnType<ManagedNativeSessions["attachWire"]>>;
type Record = { nodeId: string; id: string; wire?: Wire; closed: boolean; closing?: Promise<void>;
  packets: string[]; bytes: number; lastSeen: number; delivering?: boolean; dispatching?: boolean };
const error = () => new Error("native_http_unavailable");
const responseHeaders = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };

/** Private machine HTTP application. The native callback must supply its actual TLS socket,
 * never a forwarded peer header. No listener, TLS credential or database is opened here. */
export function createNativeHttpHost(input: NativeHttpSettings & {
  connections: Pick<ManagedNativeSessions, "attachWire">;
  isReady(): boolean;
  clock?: () => number;
}) {
  const settings = captureNativeHttpSettings(input), origin = new URL(settings.origin), peers = settings.peers;
  const attach = input.connections.attachWire.bind(input.connections), ready = input.isReady.bind(input);
  const peerCurrent = settings.isPeerCurrent, clock = (input.clock ?? Date.now).bind(input);
  const records = new Map<string, Record>(), owned = new Set<Record>(), busy = new Set<string>();
  const active = new Set<Promise<unknown>>(), controllers = new Set<AbortController>();
  const deliveries = new WeakMap<Response, Record>();
  let closed = false, uncertain = false, closing: Promise<void> | undefined, highWater = -1;
  function current(peer?: z.infer<typeof peerSchema>, record?: Record) {
    const now = clock();
    if (closed || uncertain || ready() !== true || !Number.isSafeInteger(now) || now < 0 || now < highWater
      || peer && peerCurrent(peer.nodeId, peer.certificateDigest) !== true
      || record && (record.closed || records.get(record.nodeId) !== record || now - record.lastSeen > nativeHttpLimits.idleMs)) throw error();
    highWater = now; return now;
  }
  function closeRecord(record: Record): Promise<void> {
    if (record.closing) return record.closing;
    record.closed = true; record.packets.length = 0; record.bytes = 0;
    if (records.get(record.nodeId) === record) records.delete(record.nodeId);
    record.closing = Promise.resolve().then(() => record.wire?.close()).then(() => { owned.delete(record); },
      () => { uncertain = true; throw new Error("native_http_close_uncertain"); });
    return record.closing;
  }
  function peerFor(socket: TLSSocket) {
    if (!socket?.encrypted || !socket.authorized || socket.destroyed) throw error();
    const raw = socket.getPeerCertificate().raw;
    if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > 32_768) throw error();
    const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    const peer = peers.find(p => p.certificateDigest === digest); if (!peer) throw error();
    current(peer); return peer;
  }
  function drain(record: Record): NativeHttpResponse {
    const output: NativeHttpResponse = { schema: "control-room.native-http/v1", connection: record.id, packets: [], more: false };
    while (record.packets.length && output.packets.length < nativeHttpLimits.packets) {
      const next = record.packets[0]; output.packets.push(next);
      try { nativeHttpJson(output); } catch { output.packets.pop(); break; }
      record.packets.shift(); record.bytes -= Buffer.byteLength(next);
    }
    output.more = record.packets.length > 0;
    if (output.more && !output.packets.length) throw error();
    return output;
  }
  async function handle(request: Request, socket: TLSSocket, nativeDelivery = false): Promise<Response> {
    let peer: z.infer<typeof peerSchema> | undefined, record: Record | undefined, locked = false;
    const controller = new AbortController(), abort = () => controller.abort();
    const timer = setTimeout(abort, nativeHttpLimits.requestMs);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    controllers.add(controller);
    try {
      current(); peer = peerFor(socket);
      if (busy.has(peer.nodeId) || busy.size >= nativeHttpLimits.activeRequests) throw error();
      busy.add(peer.nodeId); locked = true;
      const url = new URL(request.url);
      if (request.method !== "POST" || url.origin !== origin.origin || url.pathname !== nativeHttpLimits.path || url.search
        || url.hash || request.headers.get("content-type") !== "application/json"
        || ["content-encoding", "transfer-encoding", "upgrade", "cookie", "origin", "cf-access-jwt-assertion"].some(h => request.headers.has(h))) throw error();
      const length = request.headers.get("content-length");
      if (!length || !/^(0|[1-9][0-9]{0,6})$/.test(length) || Number(length) > nativeHttpLimits.bodyBytes) throw error();
      const body = await readNativeHttpBody(request.body, controller.signal);
      if (Buffer.byteLength(body) !== Number(length)) throw error();
      const command = nativeHttpRequestSchema.parse(JSON.parse(body)); current(peer);
      if (controller.signal.aborted || socket.destroyed) throw error();
      if (command.operation === "open") {
        // No client-supplied task selector and no implicit outstanding-task
        // recovery. Queue binding is initial-only until recovery is integrated.
        if ("assignment" in peer && command.mode !== "initial") throw error();
        const previous = records.get(peer.nodeId);
        if (previous) await closeRecord(previous);
        current(peer); if (controller.signal.aborted) throw error();
        record = { nodeId: peer.nodeId, id: `connection:http:${randomUUID()}`, closed: false,
          packets: [], bytes: 0, lastSeen: current(peer) };
        records.set(peer.nodeId, record); owned.add(record);
        const captured = record, configured = peer;
        const transport = {
          async send(packet: string) {
            current(configured, captured);
            const size = Buffer.byteLength(packet);
            if (captured.packets.length >= nativeHttpLimits.packets || captured.bytes + size > nativeHttpLimits.queuedBytes) {
              void closeRecord(captured).catch(() => {}); throw error();
            }
            captured.packets.push(packet); captured.bytes += size;
          },
          async close() { captured.closed = true; captured.packets.length = 0; captured.bytes = 0;
            if (records.get(captured.nodeId) === captured) records.delete(captured.nodeId); },
          isAvailable: () => { try { current(configured, captured); return true; } catch { return false; } },
        };
        const wire = await attach(peer.nodeId, transport, "task" in peer
          ? { mode: command.mode, task: peer.task } : { mode: "initial", assignment: "queue" });
        record.wire = wire;
        if (record.closed || controller.signal.aborted || closed) {
          try { await wire.close(); } catch { uncertain = true; }
          throw error();
        }
        current(peer, record);
      } else {
        const existing = records.get(peer.nodeId);
        // A stale token never acquires cleanup ownership of a newer generation.
        if (!existing || existing.id !== command.connection || existing.delivering) throw error();
        record = existing; current(peer, record);
        if (command.operation === "close") {
          await closeRecord(record);
          return new Response(nativeHttpJson({ schema: "control-room.native-http/v1", connection: record.id, packets: [], more: false }),
            { headers: responseHeaders });
        }
        if (command.packet !== null) await record.wire!.receive(command.packet, controller.signal);
      }
      current(peer, record); if (controller.signal.aborted || socket.destroyed) throw error();
      record!.lastSeen = current(peer);
      const response = new Response(nativeHttpJson(drain(record!)), { headers: responseHeaders });
      record!.delivering = nativeDelivery;
      deliveries.set(response, record!);
      return response;
    } catch {
      if (record) { try { await closeRecord(record); } catch { /* Close retains its failed promise. */ } }
      return new Response(JSON.stringify({ error: "native_http_unavailable" }), { status: 503, headers: responseHeaders });
    } finally { clearTimeout(timer); controller.abort(); request.signal.removeEventListener("abort", abort);
      controllers.delete(controller); if (locked) busy.delete(peer!.nodeId); }
  }
  const facade = Object.freeze({
    dispatch(nodeId: string, identity: Parameters<Wire["stage"]>[0], input: Parameters<Wire["stage"]>[1], signal: AbortSignal) {
      const record = records.get(nodeId), peer = peers.find(p => p.nodeId === nodeId);
      if (!record || !peer || record.dispatching || !(signal instanceof AbortSignal) || signal.aborted) throw error();
      current(peer, record);
      const actor = { ...identity }, task = { ...input };
      record.dispatching = true;
      const work = (async () => {
        try {
          await record.wire!.stage(actor, task, signal);
          current(peer, record); if (signal.aborted) throw error();
          const result = await record.wire!.transmit(actor, task, signal);
          current(peer, record); if (signal.aborted) throw error(); return result;
        } finally { record.dispatching = false; }
      })();
      active.add(work); void work.finally(() => active.delete(work)).catch(() => {}); return work;
    },
    async settleResponse(response: Response, delivered: boolean) {
      const record = deliveries.get(response); deliveries.delete(response);
      if (record) record.delivering = false;
      // Delivery uncertainty belongs to this exact generation, never its replacement.
      if (record && !delivered) await closeRecord(record);
    },
    handle(request: Request, socket: TLSSocket, nativeDelivery = false) {
      const work = handle(request, socket, nativeDelivery); active.add(work); void work.finally(() => active.delete(work)).catch(() => {}); return work;
    },
    stage(nodeId: string, ...args: Parameters<Wire["stage"]>) {
      const record = records.get(nodeId), peer = peers.find(p => p.nodeId === nodeId);
      if (!record || !peer) throw error(); current(peer, record); return record.wire!.stage(...args);
    },
    transmit(nodeId: string, ...args: Parameters<Wire["transmit"]>) {
      const record = records.get(nodeId), peer = peers.find(p => p.nodeId === nodeId);
      if (!record || !peer) throw error(); current(peer, record); return record.wire!.transmit(...args);
    },
    isReady: () => { try { current(); return true; } catch { return false; } },
    close() {
      if (closing) return closing;
      closed = true; for (const controller of controllers) controller.abort();
      closing = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([Promise.all([...active, ...[...owned].map(closeRecord)]), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("native_http_close_uncertain")), nativeHttpLimits.closeMs);
        })]); if (uncertain) throw new Error("native_http_close_uncertain"); } finally { clearTimeout(timer); }
      })(); return closing;
    },
  });
  const callback = createNativeHttpNodeHandler(settings.origin, facade);
  return Object.freeze({ ...facade, handleNode: callback.handle, close: callback.close });
}
