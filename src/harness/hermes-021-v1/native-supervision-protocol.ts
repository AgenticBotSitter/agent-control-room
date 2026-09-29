import { types } from "node:util";
import { sha256Digest } from "../../security/canonical-digest";

/**
 * Portable, non-authorizing half of the future Hermes native helper protocol.
 *
 * This module deliberately contains no process launcher, executable path,
 * runtime path, environment, credential, profile, or native descriptor.  It
 * fixes the wire and state rules that a later release-owned native sidecar
 * must implement.  The only current consumers are disposable fixtures.
 */
export const HERMES_NATIVE_SUPERVISION_PROTOCOL_V1 = "ACRHCP1" as const;
export const HERMES_NATIVE_SUPERVISION_FRAME_BYTES_V1 = 64 as const;
export const HERMES_NATIVE_SUPERVISION_MAXIMUM_FRAMES_V1 = 5 as const;
export const HERMES_NATIVE_SUPERVISION_PREPARE_TIMEOUT_MS_V1 = 5_000 as const;
export const HERMES_NATIVE_SUPERVISION_START_TIMEOUT_MS_V1 = 5_000 as const;
export const HERMES_NATIVE_SUPERVISION_RUN_TIMEOUT_MS_V1 = 600_000 as const;
export const HERMES_NATIVE_SUPERVISION_CLEANUP_TIMEOUT_MS_V1 = 5_000 as const;

export const HERMES_NATIVE_SUPERVISION_DESCRIPTOR_LAYOUT_V1 = Object.freeze([
  Object.freeze({ descriptor: 0, helperRole: "controller_control", targetInheritance: "closed" }),
  Object.freeze({ descriptor: 1, helperRole: "controller_status", targetInheritance: "closed" }),
  Object.freeze({ descriptor: 2, helperRole: "helper_diagnostics", targetInheritance: "closed" }),
  Object.freeze({ descriptor: 3, helperRole: "target_stdin", targetInheritance: "stdin" }),
  Object.freeze({ descriptor: 4, helperRole: "target_stdout", targetInheritance: "stdout" }),
  Object.freeze({ descriptor: 5, helperRole: "target_stderr", targetInheritance: "stderr" }),
] as const);

export type HermesNativeSupervisionFrameKindV1 = "prepare" | "verified" | "start" | "terminal" | "cancel";
export type HermesNativeSupervisionOutcomeV1 = "none" | "completed" | "failed" | "cancelled" | "uncertain";
export type HermesNativeProcessGroupStateV1 = "none" | "not_started" | "absent" | "uncertain";
export type HermesNativeEscapedDescendantStateV1 = "none" | "observed" | "not_observed" | "unknown";

export type HermesNativeSupervisionFrameV1 = Readonly<{
  protocol: typeof HERMES_NATIVE_SUPERVISION_PROTOCOL_V1;
  kind: HermesNativeSupervisionFrameKindV1;
  sequence: number;
  bindingDigest: string;
  outcome: HermesNativeSupervisionOutcomeV1;
  ownedProcessGroupState: HermesNativeProcessGroupStateV1;
  escapedDescendantState: HermesNativeEscapedDescendantStateV1;
  descriptorIsolationObserved: boolean;
}>;

export type HermesNativeSupervisionCleanupReportV1 = Readonly<{
  scope: "owned_process_group_only";
  ownedProcessGroupState: Exclude<HermesNativeProcessGroupStateV1, "none">;
  escapedDescendantState: Exclude<HermesNativeEscapedDescendantStateV1, "none">;
  allDescendantsState: "not_claimed";
}>;

type Phase = "prepared" | "verified" | "started" | "cancelling" | "terminal";

const inputNames = ["firstObservedAtUnixMs", "releaseSha256", "runtimeImageSha256", "runtimeManifestSha256",
  "sessionBindingDigest"] as const;
const frameNames = ["bindingDigest", "descriptorIsolationObserved", "escapedDescendantState", "kind", "outcome",
  "ownedProcessGroupState", "protocol", "sequence"] as const;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const magic = Buffer.from("ACRHCP1\n", "ascii");
const kinds = Object.freeze({ prepare: 1, verified: 2, start: 3, terminal: 4, cancel: 5 } as const);
const outcomes = Object.freeze({ none: 0, completed: 1, failed: 2, cancelled: 3, uncertain: 4 } as const);
const groupStates = Object.freeze({ none: 0, not_started: 1, absent: 2, uncertain: 3 } as const);
const escapeStates = Object.freeze({ none: 0, observed: 1, not_observed: 2, unknown: 3 } as const);

const invert = <T extends Readonly<Record<string, number>>>(value: T) => new Map(
  Object.entries(value).map(([name, code]) => [code, name]),
);
const kindNames = invert(kinds), outcomeNames = invert(outcomes), groupNames = invert(groupStates), escapeNames = invert(escapeStates);

function refuse(): never {
  const error = new Error("hermes_native_supervision_protocol_refused");
  error.stack = undefined;
  throw error;
}

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) refuse();
  const properties = Object.getOwnPropertyNames(value);
  if (properties.length !== names.length || properties.some(name => !names.includes(name))
    || names.some(name => !properties.includes(name))) refuse();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) refuse();
  }
  return value as Readonly<Record<string, unknown>>;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) refuse();
  return value;
}

function time(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) refuse();
  return value as number;
}

function frameShape(value: unknown): HermesNativeSupervisionFrameV1 {
  const input = exact(value, frameNames);
  if (input.protocol !== HERMES_NATIVE_SUPERVISION_PROTOCOL_V1 || !Object.hasOwn(kinds, String(input.kind))
    || !Object.hasOwn(outcomes, String(input.outcome)) || !Object.hasOwn(groupStates, String(input.ownedProcessGroupState))
    || !Object.hasOwn(escapeStates, String(input.escapedDescendantState)) || typeof input.descriptorIsolationObserved !== "boolean"
    || !Number.isSafeInteger(input.sequence) || (input.sequence as number) < 1
    || (input.sequence as number) > HERMES_NATIVE_SUPERVISION_MAXIMUM_FRAMES_V1) refuse();
  const frame = Object.freeze({
    protocol: HERMES_NATIVE_SUPERVISION_PROTOCOL_V1,
    kind: input.kind as HermesNativeSupervisionFrameKindV1,
    sequence: input.sequence as number,
    bindingDigest: digest(input.bindingDigest),
    outcome: input.outcome as HermesNativeSupervisionOutcomeV1,
    ownedProcessGroupState: input.ownedProcessGroupState as HermesNativeProcessGroupStateV1,
    escapedDescendantState: input.escapedDescendantState as HermesNativeEscapedDescendantStateV1,
    descriptorIsolationObserved: input.descriptorIsolationObserved,
  });
  const neutral = frame.outcome === "none" && frame.ownedProcessGroupState === "none"
    && frame.escapedDescendantState === "none";
  if (frame.kind === "verified") {
    if (!neutral || frame.descriptorIsolationObserved !== true) refuse();
  } else if (frame.kind !== "terminal") {
    if (!neutral || frame.descriptorIsolationObserved !== false) refuse();
  } else {
    if (frame.outcome === "none" || frame.ownedProcessGroupState === "none"
      || frame.escapedDescendantState === "none" || frame.descriptorIsolationObserved !== false) refuse();
    if (frame.ownedProcessGroupState === "not_started" && frame.escapedDescendantState !== "not_observed") refuse();
    if (frame.outcome === "completed" && frame.ownedProcessGroupState !== "absent") refuse();
  }
  return frame;
}

/** Encodes exactly one bounded frame. It is a wire helper, never launch authority. */
export function encodeHermesNativeSupervisionFrameV1(value: unknown): Uint8Array {
  const frame = frameShape(value), bytes = Buffer.alloc(HERMES_NATIVE_SUPERVISION_FRAME_BYTES_V1);
  magic.copy(bytes, 0); bytes[8] = 1; bytes[9] = kinds[frame.kind]; bytes[10] = outcomes[frame.outcome];
  bytes[11] = groupStates[frame.ownedProcessGroupState]; bytes.writeUInt32BE(frame.sequence, 12);
  bytes[16] = escapeStates[frame.escapedDescendantState]; bytes[17] = frame.descriptorIsolationObserved ? 1 : 0;
  Buffer.from(frame.bindingDigest.slice(7), "hex").copy(bytes, 32);
  return bytes;
}

/** Decodes one frame only. Concatenated, truncated, reserved-bit, or oversized input refuses. */
export function decodeHermesNativeSupervisionFrameV1(value: Uint8Array): HermesNativeSupervisionFrameV1 {
  if (!(value instanceof Uint8Array) || value.byteLength !== HERMES_NATIVE_SUPERVISION_FRAME_BYTES_V1) refuse();
  const bytes = Buffer.from(value);
  if (!bytes.subarray(0, 8).equals(magic) || bytes[8] !== 1 || bytes[17] > 1
    || bytes.subarray(18, 32).some(byte => byte !== 0)) refuse();
  const kind = kindNames.get(bytes[9]), outcome = outcomeNames.get(bytes[10]);
  const group = groupNames.get(bytes[11]), escaped = escapeNames.get(bytes[16]);
  if (!kind || !outcome || !group || !escaped) refuse();
  return frameShape({ protocol: HERMES_NATIVE_SUPERVISION_PROTOCOL_V1, kind, sequence: bytes.readUInt32BE(12),
    bindingDigest: `sha256:${bytes.subarray(32, 64).toString("hex")}`, outcome,
    ownedProcessGroupState: group, escapedDescendantState: escaped,
    descriptorIsolationObserved: bytes[17] === 1 });
}

function neutral(kind: Exclude<HermesNativeSupervisionFrameKindV1, "terminal" | "verified">, sequence: number,
  bindingDigest: string): HermesNativeSupervisionFrameV1 {
  return Object.freeze({ protocol: HERMES_NATIVE_SUPERVISION_PROTOCOL_V1, kind, sequence, bindingDigest,
    outcome: "none", ownedProcessGroupState: "none", escapedDescendantState: "none",
    descriptorIsolationObserved: false });
}

class Session {
  private phase: Phase = "prepared";
  private lastObservedAt: number;
  private deadline: number;
  private sequence = 1;
  private frameCount = 1;
  private cancellationReason: "owner_cancelled" | "deadline_exceeded" | "protocol_failure" | undefined;
  private terminalOutcome: Exclude<HermesNativeSupervisionOutcomeV1, "none"> | undefined;
  private cleanup: HermesNativeSupervisionCleanupReportV1 | undefined;
  readonly prepareFrame: Uint8Array;

  constructor(readonly bindingDigest: string, firstObservedAtUnixMs: number) {
    this.lastObservedAt = firstObservedAtUnixMs;
    this.deadline = firstObservedAtUnixMs + HERMES_NATIVE_SUPERVISION_PREPARE_TIMEOUT_MS_V1;
    this.prepareFrame = encodeHermesNativeSupervisionFrameV1(neutral("prepare", 1, bindingDigest));
  }

  private observe(observedAtUnixMs: number) {
    const observed = time(observedAtUnixMs);
    if (observed < this.lastObservedAt) refuse();
    this.lastObservedAt = observed;
    return observed;
  }

  private issue(kind: "start" | "cancel", observedAtUnixMs: number) {
    const observed = this.observe(observedAtUnixMs);
    if (++this.sequence > HERMES_NATIVE_SUPERVISION_MAXIMUM_FRAMES_V1
      || ++this.frameCount > HERMES_NATIVE_SUPERVISION_MAXIMUM_FRAMES_V1) refuse();
    if (kind === "cancel") {
      this.phase = "cancelling";
      this.deadline = observed + HERMES_NATIVE_SUPERVISION_CLEANUP_TIMEOUT_MS_V1;
    }
    return encodeHermesNativeSupervisionFrameV1(neutral(kind, this.sequence, this.bindingDigest));
  }

  private failProtocol() {
    this.phase = "terminal";
    this.cancellationReason = "protocol_failure";
    this.terminalOutcome = "uncertain";
    this.cleanup = Object.freeze({ scope: "owned_process_group_only", ownedProcessGroupState: "uncertain",
      escapedDescendantState: "unknown", allDescendantsState: "not_claimed" });
  }

  accept(value: Uint8Array, observedAtUnixMs: number): void {
    if (this.phase === "terminal") refuse();
    try {
      const observed = this.observe(observedAtUnixMs);
      if (observed > this.deadline || ++this.frameCount > HERMES_NATIVE_SUPERVISION_MAXIMUM_FRAMES_V1) refuse();
      const frame = decodeHermesNativeSupervisionFrameV1(value);
      if (frame.bindingDigest !== this.bindingDigest || frame.sequence !== ++this.sequence) refuse();
      if (this.phase === "prepared" && frame.kind === "verified") {
        this.phase = "verified";
        this.deadline = observed + HERMES_NATIVE_SUPERVISION_START_TIMEOUT_MS_V1;
        return;
      }
      if ((this.phase === "started" || this.phase === "cancelling") && frame.kind === "terminal") {
        if (this.phase === "cancelling" && !["cancelled", "uncertain"].includes(frame.outcome)) refuse();
        this.cleanup = Object.freeze({ scope: "owned_process_group_only",
          ownedProcessGroupState: frame.ownedProcessGroupState as Exclude<HermesNativeProcessGroupStateV1, "none">,
          escapedDescendantState: frame.escapedDescendantState as Exclude<HermesNativeEscapedDescendantStateV1, "none">,
          allDescendantsState: "not_claimed" });
        this.terminalOutcome = frame.outcome as Exclude<HermesNativeSupervisionOutcomeV1, "none">;
        this.phase = "terminal";
        return;
      }
      refuse();
    } catch {
      this.failProtocol();
      refuse();
    }
  }

  start(observedAtUnixMs: number): Uint8Array {
    const observed = this.observe(observedAtUnixMs);
    if (this.phase !== "verified" || observed > this.deadline) refuse();
    const frame = this.issue("start", observed);
    this.phase = "started";
    this.deadline = observed + HERMES_NATIVE_SUPERVISION_RUN_TIMEOUT_MS_V1;
    return frame;
  }

  cancel(observedAtUnixMs: number): Uint8Array {
    const observed = this.observe(observedAtUnixMs);
    if (!["prepared", "verified", "started"].includes(this.phase) || observed > this.deadline) refuse();
    this.cancellationReason = "owner_cancelled";
    return this.issue("cancel", observed);
  }

  /**
   * Advances only the fixed timeout policy. The first exceeded deadline emits
   * CANCEL; a missing terminal cleanup frame then becomes honest uncertainty.
   */
  observeTimeout(observedAtUnixMs: number): Uint8Array | undefined {
    const observed = this.observe(observedAtUnixMs);
    if (this.phase === "terminal" || observed <= this.deadline) return undefined;
    if (this.phase === "cancelling") {
      this.cleanup = Object.freeze({ scope: "owned_process_group_only", ownedProcessGroupState: "uncertain",
        escapedDescendantState: "unknown", allDescendantsState: "not_claimed" });
      this.terminalOutcome = "uncertain";
      this.phase = "terminal";
      return undefined;
    }
    this.cancellationReason = "deadline_exceeded";
    return this.issue("cancel", observed);
  }

  snapshot() {
    return Object.freeze({ protocol: HERMES_NATIVE_SUPERVISION_PROTOCOL_V1, phase: this.phase,
      bindingDigest: this.bindingDigest, framesObserved: this.frameCount,
      cancellationReason: this.cancellationReason ?? "none", terminalOutcome: this.terminalOutcome ?? "none",
      cleanup: this.cleanup,
      descriptorLayout: HERMES_NATIVE_SUPERVISION_DESCRIPTOR_LAYOUT_V1,
      maximumFrameBytes: HERMES_NATIVE_SUPERVISION_FRAME_BYTES_V1,
      maximumFrames: HERMES_NATIVE_SUPERVISION_MAXIMUM_FRAMES_V1,
      fixtureOnly: true as const, grantsLaunchAuthority: false as const, startsProcess: false as const });
  }
}

export type HermesNativeSupervisionProtocolSessionV1 = Readonly<{
  prepareFrame: Uint8Array;
  accept(value: Uint8Array, observedAtUnixMs: number): void;
  start(observedAtUnixMs: number): Uint8Array;
  cancel(observedAtUnixMs: number): Uint8Array;
  observeTimeout(observedAtUnixMs: number): Uint8Array | undefined;
  snapshot(): ReturnType<Session["snapshot"]>;
}>;

/**
 * Creates a fixture-only state machine. The returned object cannot launch a
 * process and does not accept a path, command, environment, runtime, or port.
 */
export function createHermesNativeSupervisionProtocolSessionV1(value: unknown):
  HermesNativeSupervisionProtocolSessionV1 {
  const input = exact(value, inputNames);
  const firstObservedAtUnixMs = time(input.firstObservedAtUnixMs);
  const material = { protocol: HERMES_NATIVE_SUPERVISION_PROTOCOL_V1,
    releaseSha256: digest(input.releaseSha256), runtimeImageSha256: digest(input.runtimeImageSha256),
    runtimeManifestSha256: digest(input.runtimeManifestSha256), sessionBindingDigest: digest(input.sessionBindingDigest) };
  const session = new Session(sha256Digest(material), firstObservedAtUnixMs);
  return Object.freeze({ prepareFrame: session.prepareFrame,
    accept: session.accept.bind(session), start: session.start.bind(session), cancel: session.cancel.bind(session),
    observeTimeout: session.observeTimeout.bind(session), snapshot: session.snapshot.bind(session) });
}
