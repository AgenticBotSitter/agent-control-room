import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import {
  isConnectionEnrollmentDeliveryIdV1,
  NODE_PROTOCOL_MAX_FRAME_BYTES,
} from "../../node-protocol/v1";
import { sha256Digest } from "../../security";
import {
  exactHostDataSnapshotV1,
  exactHostUint8ArrayV1,
  isHostProxyV1,
} from "../../security/host-value";
import { assertConnectionEnrollmentNodeIngressRuntimeV1 } from "./node-ingress";

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAME_V1 =
  "control-room-connection-enrollment-private-loopback-frame/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1 =
  "uint32-be-utf8-single-frame/v1" as const;

const digestPatternV1 = /^sha256:[a-f0-9]{64}$/;
const listenerIdPatternV1 = /^private-loopback-listener:[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const objectFreezeV1 = Object.freeze;
const objectGetOwnPropertyDescriptorV1 = Object.getOwnPropertyDescriptor;
const numberIsSafeIntegerV1 = Number.isSafeInteger;
const jsonObjectV1 = JSON;
const jsonParseV1 = JSON.parse;
const bufferByteLengthV1 = Buffer.byteLength;
const reflectApplyV1 = Reflect.apply;
const regexpExecV1 = RegExp.prototype.exec;
const setConstructorV1 = Set;
const setAddV1 = Set.prototype.add;
const setHasV1 = Set.prototype.has;
const stringSliceV1 = String.prototype.slice;
const uint8ArrayConstructorV1 = Uint8Array;
const uint8ArrayFillV1 = Uint8Array.prototype.fill;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;
const protectedFrameOriginsV1 = new WeakSet<object>();
const textDecoderV1 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const textDecoderPrototypeV1 = Object.getPrototypeOf(textDecoderV1) as object;
const textDecoderDecodeCandidateV1 = objectGetOwnPropertyDescriptorV1(
  textDecoderPrototypeV1, "decode",
)?.value as unknown;
if (typeof textDecoderDecodeCandidateV1 !== "function" || isHostProxyV1(textDecoderDecodeCandidateV1)) {
  throw new Error("private loopback framing runtime unavailable");
}
const textDecoderDecodeV1 = textDecoderDecodeCandidateV1;

function patternMatchesV1(pattern: RegExp, value: string): boolean {
  return reflectApplyV1(regexpExecV1, pattern, [value]) !== null;
}

function assertFramingRuntimeV1(): void {
  assertConnectionEnrollmentNodeIngressRuntimeV1();
  const parseDescriptor = objectGetOwnPropertyDescriptorV1(jsonObjectV1, "parse");
  const byteLengthDescriptor = objectGetOwnPropertyDescriptorV1(Buffer, "byteLength");
  const decodeDescriptor = objectGetOwnPropertyDescriptorV1(textDecoderPrototypeV1, "decode");
  if (!parseDescriptor || !("value" in parseDescriptor) || parseDescriptor.value !== jsonParseV1
    || !byteLengthDescriptor || !("value" in byteLengthDescriptor)
    || byteLengthDescriptor.value !== bufferByteLengthV1
    || !decodeDescriptor || !("value" in decodeDescriptor)
    || decodeDescriptor.value !== textDecoderDecodeV1) {
    throw new ConnectionEnrollmentPrivateLoopbackFramingErrorV1("integrity_failed");
  }
}

export type ConnectionEnrollmentPrivateLoopbackFramingConfigurationV1 = Readonly<{
  listenerId: string;
  transport: "ssh_tunnel";
  listenerVisibility: "private_loopback";
  addressFamily: "ipv4";
  bindAddress: "127.0.0.1";
  framing: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1;
  maximumFrameBytes: number;
  maximumChunks: number;
}>;

/**
 * Protected internal handoff. `rawFrame` is authenticated by the downstream
 * node ingress before any enrollment data is accepted and must never be put in
 * operator receipts, logs, or evidence packets.
 */
export type ConnectionEnrollmentPrivateLoopbackProtectedFrameV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAME_V1;
  listenerId: string;
  transport: "ssh_tunnel";
  listenerVisibility: "private_loopback";
  framing: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1;
  rawFrame: string;
  deliveryId: string;
  frameBytes: number;
  frameDigest: string;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
}>;

export interface ConnectionEnrollmentPrivateLoopbackListenerPortV1 {
  readonly enabled: boolean;
  start(): Promise<void>;
  close(): Promise<void>;
}

export class ConnectionEnrollmentPrivateLoopbackFramingErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_configuration" | "invalid_chunk" | "chunk_limit_exceeded" |
    "malformed_prefix" | "frame_too_large" | "incomplete_frame" | "trailing_bytes" |
    "invalid_utf8" | "invalid_json" | "duplicate_json_member" | "wrong_message_type" |
    "invalid_delivery_id" |
    "integrity_failed" | "disabled" | "state_conflict") {
    super(safeCode);
    this.name = "ConnectionEnrollmentPrivateLoopbackFramingErrorV1";
  }
}

function parseConfigurationV1(value: unknown): ConnectionEnrollmentPrivateLoopbackFramingConfigurationV1 {
  try { assertFramingRuntimeV1(); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackFramingErrorV1("invalid_configuration"); }
  const captured = exactHostDataSnapshotV1(value, ["listenerId", "transport", "listenerVisibility",
    "addressFamily", "bindAddress", "framing", "maximumFrameBytes", "maximumChunks"]);
  if (!captured || typeof captured.listenerId !== "string"
    || captured.listenerId.length < 27 || captured.listenerId.length > 160
    || !patternMatchesV1(listenerIdPatternV1, captured.listenerId)
    || captured.transport !== "ssh_tunnel" || captured.listenerVisibility !== "private_loopback"
    || captured.addressFamily !== "ipv4" || captured.bindAddress !== "127.0.0.1"
    || captured.framing !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1
    || !numberIsSafeIntegerV1(captured.maximumFrameBytes)
    || (captured.maximumFrameBytes as number) < 4_096
    || (captured.maximumFrameBytes as number) > NODE_PROTOCOL_MAX_FRAME_BYTES
    || !numberIsSafeIntegerV1(captured.maximumChunks)
    || (captured.maximumChunks as number) < 1 || (captured.maximumChunks as number) > 4_096) {
    throw new ConnectionEnrollmentPrivateLoopbackFramingErrorV1("invalid_configuration");
  }
  return objectFreezeV1({
    listenerId: captured.listenerId,
    transport: "ssh_tunnel",
    listenerVisibility: "private_loopback",
    addressFamily: "ipv4",
    bindAddress: "127.0.0.1",
    framing: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1,
    maximumFrameBytes: captured.maximumFrameBytes,
    maximumChunks: captured.maximumChunks,
  }) as ConnectionEnrollmentPrivateLoopbackFramingConfigurationV1;
}

function unsignedProtectedFrameV1(value: ConnectionEnrollmentPrivateLoopbackProtectedFrameV1):
Omit<ConnectionEnrollmentPrivateLoopbackProtectedFrameV1, "frameDigest"> {
  const { frameDigest: _frameDigest, ...unsigned } = value;
  void _frameDigest;
  return unsigned;
}

export function parseConnectionEnrollmentPrivateLoopbackProtectedFrameV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackProtectedFrameV1 {
  try { assertFramingRuntimeV1(); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackFramingErrorV1("integrity_failed"); }
  if (!value || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, protectedFrameOriginsV1, [value]) !== true) {
    throw new ConnectionEnrollmentPrivateLoopbackFramingErrorV1("integrity_failed");
  }
  const captured = exactHostDataSnapshotV1(value, ["contractVersion", "listenerId", "transport",
    "listenerVisibility", "framing", "rawFrame", "deliveryId", "frameBytes", "frameDigest", "grantsApproval",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority"]);
  if (!captured) throw new ConnectionEnrollmentPrivateLoopbackFramingErrorV1("integrity_failed");
  const frame = captured as unknown as ConnectionEnrollmentPrivateLoopbackProtectedFrameV1;
  if (frame.contractVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAME_V1
    || typeof frame.listenerId !== "string" || frame.listenerId.length < 27 || frame.listenerId.length > 160
    || !patternMatchesV1(listenerIdPatternV1, frame.listenerId)
    || frame.transport !== "ssh_tunnel" || frame.listenerVisibility !== "private_loopback"
    || frame.framing !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1
    || typeof frame.rawFrame !== "string" || frame.rawFrame.length < 2
    || frame.rawFrame.length > NODE_PROTOCOL_MAX_FRAME_BYTES
    || !numberIsSafeIntegerV1(frame.frameBytes) || frame.frameBytes < 2
    || frame.frameBytes > NODE_PROTOCOL_MAX_FRAME_BYTES
    || reflectApplyV1(bufferByteLengthV1, Buffer, [frame.rawFrame, "utf8"]) !== frame.frameBytes
    || !isConnectionEnrollmentDeliveryIdV1(frame.deliveryId)
    || typeof frame.frameDigest !== "string" || !patternMatchesV1(digestPatternV1, frame.frameDigest)
    || frame.grantsApproval !== false || frame.grantsNetworkAuthority !== false
    || frame.grantsCommandAuthority !== false || frame.grantsLeaseAuthority !== false
    || frame.grantsExecutionAuthority !== false
    || sha256Digest(unsignedProtectedFrameV1(frame)) !== frame.frameDigest) {
    throw new ConnectionEnrollmentPrivateLoopbackFramingErrorV1("integrity_failed");
  }
  const routing = deliveryIdFromRawFrameV1(frame.rawFrame);
  if (routing.status !== "accepted" || routing.deliveryId !== frame.deliveryId) {
    throw new ConnectionEnrollmentPrivateLoopbackFramingErrorV1("integrity_failed");
  }
  // The snapshot above is used only for inert validation. Preserve the
  // module-branded, already-frozen original so provenance survives repeated
  // parser and reducer calls without exposing a caller-manufacturable copy.
  return value as ConnectionEnrollmentPrivateLoopbackProtectedFrameV1;
}

/** Reduce the protected transport record to the exact input admitted downstream. */
export function toConnectionEnrollmentTransportAdmissionInputV1(value: unknown):
Readonly<{ rawFrame: string; deliveryId: string }> {
  const frame = parseConnectionEnrollmentPrivateLoopbackProtectedFrameV1(value);
  return objectFreezeV1({ rawFrame: frame.rawFrame, deliveryId: frame.deliveryId });
}

type JsonContainerV1 = {
  kind: "object";
  state: "key_or_end" | "colon" | "value" | "comma_or_end";
  keys: Set<string>;
} | {
  kind: "array";
  state: "value_or_end" | "comma_or_end";
};

/**
 * Native parsing establishes JSON grammar first. This bounded, iterative pass
 * then rejects duplicate object members before parsed-object routing is used.
 */
function hasUniqueJsonMembersV1(rawFrame: string): boolean {
  const stack: JsonContainerV1[] = [];
  const root = { state: "value" as "value" | "complete" };
  const beginValue = (): boolean => {
    const parent = stack[stack.length - 1];
    if (!parent) {
      if (root.state !== "value") return false;
      root.state = "complete";
      return true;
    }
    if (parent.kind === "object") {
      if (parent.state !== "value") return false;
      parent.state = "comma_or_end";
      return true;
    }
    if (parent.state !== "value_or_end") return false;
    parent.state = "comma_or_end";
    return true;
  };
  let index = 0;
  while (index < rawFrame.length) {
    const character = rawFrame[index]!;
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      index += 1;
      continue;
    }
    if (character === "{") {
      if (!beginValue()) return false;
      stack[stack.length] = { kind: "object", state: "key_or_end", keys: new setConstructorV1<string>() };
      index += 1;
      continue;
    }
    if (character === "[") {
      if (!beginValue()) return false;
      stack[stack.length] = { kind: "array", state: "value_or_end" };
      index += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      const current = stack[stack.length - 1];
      if (!current || (character === "}" && (current.kind !== "object"
        || (current.state !== "key_or_end" && current.state !== "comma_or_end")))
        || (character === "]" && (current.kind !== "array"
          || (current.state !== "value_or_end" && current.state !== "comma_or_end")))) return false;
      stack.length -= 1;
      index += 1;
      continue;
    }
    if (character === ",") {
      const current = stack[stack.length - 1];
      if (!current || current.state !== "comma_or_end") return false;
      current.state = current.kind === "object" ? "key_or_end" : "value_or_end";
      index += 1;
      continue;
    }
    if (character === ":") {
      const current = stack[stack.length - 1];
      if (!current || current.kind !== "object" || current.state !== "colon") return false;
      current.state = "value";
      index += 1;
      continue;
    }
    if (character === "\"") {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < rawFrame.length) {
        const stringCharacter = rawFrame[index]!;
        if (escaped) escaped = false;
        else if (stringCharacter === "\\") escaped = true;
        else if (stringCharacter === "\"") { index += 1; break; }
        index += 1;
      }
      const current = stack[stack.length - 1];
      if (current?.kind === "object" && current.state === "key_or_end") {
        let key: unknown;
        try {
          const token = reflectApplyV1(stringSliceV1, rawFrame, [start, index]) as string;
          key = reflectApplyV1(jsonParseV1, jsonObjectV1, [token]);
        } catch { return false; }
        if (typeof key !== "string") return false;
        if (reflectApplyV1(setHasV1, current.keys, [key]) === true) return false;
        reflectApplyV1(setAddV1, current.keys, [key]);
        current.state = "colon";
      } else if (!beginValue()) return false;
      continue;
    }
    const start = index;
    while (index < rawFrame.length) {
      const scalarCharacter = rawFrame[index]!;
      if (scalarCharacter === " " || scalarCharacter === "\t" || scalarCharacter === "\n"
        || scalarCharacter === "\r" || scalarCharacter === "," || scalarCharacter === "}"
        || scalarCharacter === "]") break;
      index += 1;
    }
    if (index === start || !beginValue()) return false;
  }
  return stack.length === 0 && root.state === "complete";
}

type DeliveryRoutingResultV1 = Readonly<{ status: "accepted"; deliveryId: string }> |
Readonly<{ status: "rejected"; safeCode: "invalid_json" | "duplicate_json_member" |
  "wrong_message_type" | "invalid_delivery_id" }>;

function deliveryIdFromRawFrameV1(rawFrame: string): DeliveryRoutingResultV1 {
  let parsed: unknown;
  try { parsed = reflectApplyV1(jsonParseV1, jsonObjectV1, [rawFrame]); }
  catch { return objectFreezeV1({ status: "rejected", safeCode: "invalid_json" }); }
  if (!hasUniqueJsonMembersV1(rawFrame)) {
    return objectFreezeV1({ status: "rejected", safeCode: "duplicate_json_member" });
  }
  const frame = exactHostDataSnapshotV1(parsed, ["protocol", "direction", "messageId", "correlationId",
    "tenantId", "actorId", "senderKind", "keyId", "connectionId", "sequence", "sentAt", "expiresAt",
    "nonce", "bodyDigest", "signature", "type", "body"], ["causationId"]);
  if (!frame || frame.type !== "connection.enrollment.deliver") {
    return objectFreezeV1({ status: "rejected", safeCode: "wrong_message_type" });
  }
  const body = exactHostDataSnapshotV1(frame.body,
    ["deliveryId", "enrollmentContract", "envelopeDigest", "envelope"]);
  if (!body || !isConnectionEnrollmentDeliveryIdV1(body.deliveryId)) {
    return objectFreezeV1({ status: "rejected", safeCode: "invalid_delivery_id" });
  }
  return objectFreezeV1({ status: "accepted", deliveryId: body.deliveryId });
}

function sealProtectedFrameV1(material: Omit<ConnectionEnrollmentPrivateLoopbackProtectedFrameV1,
"frameDigest">): ConnectionEnrollmentPrivateLoopbackProtectedFrameV1 {
  const protectedFrame = objectFreezeV1({ ...material, frameDigest: sha256Digest(material) });
  reflectApplyV1(weakSetAddV1, protectedFrameOriginsV1, [protectedFrame]);
  return parseConnectionEnrollmentPrivateLoopbackProtectedFrameV1(protectedFrame);
}

/**
 * Effect-free decoder for exactly one length-prefixed UTF-8 JSON frame. It
 * accepts no streams, sockets, iterators, partial views, or caller callbacks.
 */
export class ConnectionEnrollmentPrivateLoopbackFrameDecoderV1 {
  readonly #configuration: ConnectionEnrollmentPrivateLoopbackFramingConfigurationV1;
  readonly #header = new uint8ArrayConstructorV1(4);
  #frame: Uint8Array | undefined;
  #headerBytes = 0;
  #frameBytes = 0;
  #expectedFrameBytes: number | undefined;
  #chunkCount = 0;
  #state: "receiving" | "complete" | "failed" | "closed" = "receiving";

  constructor(configurationValue: unknown) {
    this.#configuration = parseConfigurationV1(configurationValue);
  }

  push(chunkValue: unknown): void {
    if (this.#state !== "receiving") {
      throw new ConnectionEnrollmentPrivateLoopbackFramingErrorV1("state_conflict");
    }
    try { assertFramingRuntimeV1(); }
    catch { this.#fail("integrity_failed"); }
    const chunk = exactHostUint8ArrayV1(chunkValue, this.#configuration.maximumFrameBytes + 4);
    if (!chunk || chunk.byteLength < 1) this.#fail("invalid_chunk");
    this.#chunkCount += 1;
    if (this.#chunkCount > this.#configuration.maximumChunks) this.#fail("chunk_limit_exceeded");
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk.byteAt(index);
      if (byte === undefined) this.#fail("integrity_failed");
      if (this.#headerBytes < 4) {
        this.#header[this.#headerBytes] = byte;
        this.#headerBytes += 1;
        if (this.#headerBytes === 4) this.#openFrameFromHeader();
      } else {
        if (!this.#frame || this.#expectedFrameBytes === undefined) this.#fail("integrity_failed");
        if (this.#frameBytes >= this.#expectedFrameBytes) this.#fail("trailing_bytes");
        this.#frame[this.#frameBytes] = byte;
        this.#frameBytes += 1;
      }
    }
  }

  finish(): ConnectionEnrollmentPrivateLoopbackProtectedFrameV1 {
    if (this.#state !== "receiving") {
      throw new ConnectionEnrollmentPrivateLoopbackFramingErrorV1("state_conflict");
    }
    try { assertFramingRuntimeV1(); }
    catch { this.#fail("integrity_failed"); }
    if (this.#headerBytes < 4 || !this.#frame || this.#expectedFrameBytes === undefined
      || this.#frameBytes !== this.#expectedFrameBytes) this.#fail("incomplete_frame");
    let rawFrame: string;
    try {
      rawFrame = reflectApplyV1(textDecoderDecodeV1, textDecoderV1,
        [this.#frame, { stream: false }]) as string;
    } catch { this.#fail("invalid_utf8"); }
    const routing = deliveryIdFromRawFrameV1(rawFrame);
    if (routing.status !== "accepted") this.#fail(routing.safeCode);
    const deliveryId = routing.deliveryId;
    const material: Omit<ConnectionEnrollmentPrivateLoopbackProtectedFrameV1, "frameDigest"> = {
      contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAME_V1,
      listenerId: this.#configuration.listenerId,
      transport: "ssh_tunnel",
      listenerVisibility: "private_loopback",
      framing: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1,
      rawFrame,
      deliveryId,
      frameBytes: this.#expectedFrameBytes,
      grantsApproval: false,
      grantsNetworkAuthority: false,
      grantsCommandAuthority: false,
      grantsLeaseAuthority: false,
      grantsExecutionAuthority: false,
    };
    let protectedFrame: ConnectionEnrollmentPrivateLoopbackProtectedFrameV1;
    try { protectedFrame = sealProtectedFrameV1(material); }
    catch { this.#fail("integrity_failed"); }
    this.#wipe();
    this.#state = "complete";
    return protectedFrame;
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#wipe();
    this.#state = "closed";
  }

  #openFrameFromHeader(): void {
    const length = ((this.#header[0]! * 0x1000000) + (this.#header[1]! << 16)
      + (this.#header[2]! << 8) + this.#header[3]!) >>> 0;
    if (length < 2) this.#fail("malformed_prefix");
    if (length > this.#configuration.maximumFrameBytes) this.#fail("frame_too_large");
    this.#expectedFrameBytes = length;
    this.#frame = new uint8ArrayConstructorV1(length);
  }

  #wipe(): void {
    try { reflectApplyV1(uint8ArrayFillV1, this.#header, [0]); } catch { /* terminal cleanup */ }
    if (this.#frame) {
      try { reflectApplyV1(uint8ArrayFillV1, this.#frame, [0]); } catch { /* terminal cleanup */ }
    }
    this.#frame = undefined;
    this.#headerBytes = 0;
    this.#frameBytes = 0;
    this.#expectedFrameBytes = undefined;
  }

  #fail(code: ConnectionEnrollmentPrivateLoopbackFramingErrorV1["safeCode"]): never {
    this.#wipe();
    this.#state = "failed";
    throw new ConnectionEnrollmentPrivateLoopbackFramingErrorV1(code);
  }
}

/** Disabled by default: wiring this port into the local pilot opens nothing. */
export class DisabledConnectionEnrollmentPrivateLoopbackListenerV1 implements
ConnectionEnrollmentPrivateLoopbackListenerPortV1 {
  readonly enabled = false;
  async start(): Promise<void> {
    throw new ConnectionEnrollmentPrivateLoopbackFramingErrorV1("disabled");
  }
  async close(): Promise<void> {}
}
