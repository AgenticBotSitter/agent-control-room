import { createHash } from "node:crypto";
import { z } from "zod";
import { signedNodeFrameSchema } from "../../node-protocol/v1";
import type { NativeTaskSnapshotBody } from "./native-observation";

export const NATIVE_WIRE_MAX_BYTES = 262_144;
type Direction = "node_to_server" | "server_to_node";
const schema = z.object({ schema: z.literal("control-room.native-wire/v1"), raw: z.string(),
  result: z.string().max(87_384).nullable() }).strict();
const fail = (): never => { throw new Error("native_wire_unavailable"); };
function frame(raw: string, direction: Direction) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 131_072) return fail();
  const value = signedNodeFrameSchema.parse(JSON.parse(raw));
  if (value.direction !== direction || value.type === "harness.native.snapshot" && Buffer.byteLength(raw) > 16_384) return fail();
  return value;
}
function claim(value: ReturnType<typeof frame>) {
  return value.type === "harness.native.snapshot" && value.body.state === "completed" && value.body.result
    ? value.body : undefined;
}
function checked(bytes: Uint8Array, body: NativeTaskSnapshotBody) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 65_536 || bytes.byteLength !== body.result?.sizeBytes
    || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== body.result.contentHash) return fail();
  return Uint8Array.from(bytes);
}

/** Transport framing only; existing receivers still authenticate the unchanged inner frame.
 * The synchronous reader is node-private saved evidence, never a provider/remote fetch. */
export function encodeNativeWire(raw: string, direction: Direction, readResult?: (body: NativeTaskSnapshotBody) => Uint8Array): string {
  try {
    const value = frame(raw, direction), body = claim(value);
    if (body && direction !== "node_to_server") return fail();
    const result = body ? Buffer.from(checked(readResult ? readResult(body) : fail(), body)).toString("base64") : null;
    const packet = JSON.stringify({ schema: "control-room.native-wire/v1", raw, result });
    if (Buffer.byteLength(packet) > NATIVE_WIRE_MAX_BYTES) return fail();
    return packet;
  } catch { return fail(); }
}

export function decodeNativeWire(input: string | Uint8Array, direction: Direction): { raw: string; bytes: Uint8Array | undefined } {
  try {
    if (typeof input !== "string" && !(input instanceof Uint8Array)) return fail();
    const size = typeof input === "string" ? Buffer.byteLength(input) : input.byteLength;
    if (size > NATIVE_WIRE_MAX_BYTES) return fail();
    const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
    const packet = schema.parse(JSON.parse(text)), value = frame(packet.raw, direction), body = claim(value);
    if (!body) { if (packet.result !== null) return fail(); return { raw: packet.raw, bytes: undefined }; }
    if (direction !== "node_to_server" || packet.result === null) return fail();
    const bytes = Buffer.from(packet.result, "base64");
    if (bytes.toString("base64") !== packet.result) return fail();
    return { raw: packet.raw, bytes: checked(bytes, body) };
  } catch { return fail(); }
}
