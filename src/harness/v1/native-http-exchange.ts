import { z } from "zod";
import { NATIVE_WIRE_MAX_BYTES } from "./native-wire";

export const nativeHttpLimits = Object.freeze({ path: "/v1/control-room/native", bodyBytes: 1_048_576,
  packets: 16, queuedBytes: 1_048_576, bodyMs: 5000, requestMs: 20_000, closeMs: 10_000,
  idleMs: 60_000, activeRequests: 8, exchangesPerStep: 32 });
const version = z.literal("control-room.native-http/v1");
const connection = z.string().regex(/^connection:http:[a-f0-9-]{36}$/);
const packet = z.string().refine(value => Buffer.byteLength(value) <= NATIVE_WIRE_MAX_BYTES);
export const nativeHttpRequestSchema = z.discriminatedUnion("operation", [
  z.object({ schema: version, operation: z.literal("open"), mode: z.enum(["initial", "recover"]) }).strict(),
  z.object({ schema: version, operation: z.literal("exchange"), connection, packet: packet.nullable() }).strict(),
  z.object({ schema: version, operation: z.literal("close"), connection }).strict(),
]);
export const nativeHttpResponseSchema = z.object({ schema: version, connection,
  packets: z.array(packet).max(nativeHttpLimits.packets), more: z.boolean() }).strict();
export type NativeHttpRequest = z.infer<typeof nativeHttpRequestSchema>;
export type NativeHttpResponse = z.infer<typeof nativeHttpResponseSchema>;
export function nativeHttpJson(value: NativeHttpRequest | NativeHttpResponse): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > nativeHttpLimits.bodyBytes) throw new Error("native_http_unavailable");
  return text;
}

/** Bounded collection before parsing. The owner supplies an abort signal for the whole request. */
export async function readNativeHttpBody(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<string> {
  if (!body || signal.aborted) throw new Error("native_http_unavailable");
  const reader = body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const abort = () => { rejectStopped(new Error("native_http_unavailable")); void reader.cancel().catch(() => {}); };
  const timer = setTimeout(abort, nativeHttpLimits.bodyMs);
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), stopped]);
      if (signal.aborted) throw new Error();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new Error();
      bytes += next.value.byteLength;
      if (bytes > nativeHttpLimits.bodyBytes) throw new Error();
      chunks.push(Uint8Array.from(next.value));
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } catch { throw new Error("native_http_unavailable"); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
