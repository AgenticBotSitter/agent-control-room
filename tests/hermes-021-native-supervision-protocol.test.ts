import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createHermesNativeSupervisionProtocolSessionV1,
  decodeHermesNativeSupervisionFrameV1,
  encodeHermesNativeSupervisionFrameV1,
  HERMES_NATIVE_SUPERVISION_DESCRIPTOR_LAYOUT_V1,
  HERMES_NATIVE_SUPERVISION_FRAME_BYTES_V1,
  HERMES_NATIVE_SUPERVISION_PROTOCOL_V1,
} from "../src/harness/hermes-021-v1/native-supervision-protocol";

const d = (character: string) => `sha256:${character.repeat(64)}`;
const t0 = 1_800_000_000_000;
const input = Object.freeze({ firstObservedAtUnixMs: t0, releaseSha256: d("a"), runtimeImageSha256: d("b"),
  runtimeManifestSha256: d("c"), sessionBindingDigest: d("d") });
const refusal = /^Error: hermes_native_supervision_protocol_refused$/u;

function response(session: ReturnType<typeof createHermesNativeSupervisionProtocolSessionV1>,
  kind: "verified" | "terminal", sequence: number, overrides: Record<string, unknown> = {}) {
  const bindingDigest = session.snapshot().bindingDigest;
  return encodeHermesNativeSupervisionFrameV1({ protocol: HERMES_NATIVE_SUPERVISION_PROTOCOL_V1, kind, sequence,
    bindingDigest, outcome: kind === "terminal" ? "completed" : "none",
    ownedProcessGroupState: kind === "terminal" ? "absent" : "none",
    escapedDescendantState: kind === "terminal" ? "not_observed" : "none",
    descriptorIsolationObserved: kind === "verified", ...overrides });
}

test("fixes PREPARE -> VERIFIED -> START -> TERMINAL without launching or accepting process inputs", () => {
  const session = createHermesNativeSupervisionProtocolSessionV1(input);
  const prepare = decodeHermesNativeSupervisionFrameV1(session.prepareFrame);
  assert.equal(session.prepareFrame.byteLength, HERMES_NATIVE_SUPERVISION_FRAME_BYTES_V1);
  assert.equal(prepare.kind, "prepare"); assert.equal(prepare.sequence, 1);
  assert.equal(session.snapshot().fixtureOnly, true); assert.equal(session.snapshot().startsProcess, false);
  assert.equal(session.snapshot().grantsLaunchAuthority, false);

  session.accept(response(session, "verified", 2), t0 + 1);
  assert.equal(session.snapshot().phase, "verified");
  const start = decodeHermesNativeSupervisionFrameV1(session.start(t0 + 2));
  assert.equal(start.kind, "start"); assert.equal(start.sequence, 3);
  session.accept(response(session, "terminal", 4), t0 + 3);
  assert.equal(session.snapshot().phase, "terminal");
  assert.equal(session.snapshot().terminalOutcome, "completed");
  assert.deepEqual(session.snapshot().cleanup, { scope: "owned_process_group_only", ownedProcessGroupState: "absent",
    escapedDescendantState: "not_observed", allDescendantsState: "not_claimed" });

  for (const forbidden of [{ executablePath: "/owner/hermes" }, { command: "hermes" }, { env: {} },
    { runtimePath: "/owner/runtime" }, { credential: "secret" }, { port: {} }])
    assert.throws(() => createHermesNativeSupervisionProtocolSessionV1({ ...input, ...forbidden }), refusal);
});

test("fixes descriptor isolation and never lets a caller substitute a descriptor layout", () => {
  assert.deepEqual(HERMES_NATIVE_SUPERVISION_DESCRIPTOR_LAYOUT_V1.map(item => item.descriptor), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(HERMES_NATIVE_SUPERVISION_DESCRIPTOR_LAYOUT_V1.map(item => item.targetInheritance),
    ["closed", "closed", "closed", "stdin", "stdout", "stderr"]);
  assert.ok(HERMES_NATIVE_SUPERVISION_DESCRIPTOR_LAYOUT_V1.every(Object.isFrozen));
  assert.equal(Object.isFrozen(HERMES_NATIVE_SUPERVISION_DESCRIPTOR_LAYOUT_V1), true);
  const session = createHermesNativeSupervisionProtocolSessionV1(input);
  assert.throws(() => session.accept(response(session, "verified", 2,
    { descriptorIsolationObserved: false }), t0 + 1), refusal);
  assert.throws(() => createHermesNativeSupervisionProtocolSessionV1({ ...input,
    descriptorLayout: [{ descriptor: 99, helperRole: "secret" }] }), refusal);
});

test("bounds frames, order, correlation, reserved bytes, time and replay", () => {
  const session = createHermesNativeSupervisionProtocolSessionV1(input);
  assert.throws(() => session.start(t0 + 1), refusal);
  assert.throws(() => session.accept(response(session, "verified", 3), t0 + 1), refusal);
  assert.equal(session.snapshot().phase, "terminal", "a protocol fault is permanently fail closed");
  assert.equal(session.snapshot().terminalOutcome, "uncertain");

  const wrongSession = createHermesNativeSupervisionProtocolSessionV1(input);
  const wrong = response(wrongSession, "verified", 2, { bindingDigest: d("e") });
  assert.throws(() => wrongSession.accept(wrong, t0 + 1), refusal);
  assert.equal(wrongSession.snapshot().cancellationReason, "protocol_failure");

  const clean = response(createHermesNativeSupervisionProtocolSessionV1(input), "verified", 2);
  assert.throws(() => decodeHermesNativeSupervisionFrameV1(Buffer.concat([clean, clean])), refusal);
  assert.throws(() => decodeHermesNativeSupervisionFrameV1(clean.subarray(0, 63)), refusal);
  const reserved = Buffer.from(clean); reserved[18] = 1;
  assert.throws(() => decodeHermesNativeSupervisionFrameV1(reserved), refusal);
  assert.throws(() => createHermesNativeSupervisionProtocolSessionV1(new Proxy(input, {})), refusal);
  const getter = { ...input } as Record<string, unknown>;
  Object.defineProperty(getter, "releaseSha256", { enumerable: true, get() { throw new Error("read"); } });
  assert.throws(() => createHermesNativeSupervisionProtocolSessionV1(getter), refusal);
});

test("deadline and owner cancellation are bounded and missing cleanup becomes honest uncertainty", () => {
  const deadline = createHermesNativeSupervisionProtocolSessionV1(input);
  const cancel = decodeHermesNativeSupervisionFrameV1(deadline.observeTimeout(t0 + 5_001)!);
  assert.equal(cancel.kind, "cancel"); assert.equal(cancel.sequence, 2);
  assert.equal(deadline.snapshot().cancellationReason, "deadline_exceeded");
  assert.equal(deadline.observeTimeout(t0 + 10_002), undefined);
  assert.equal(deadline.snapshot().phase, "terminal");
  assert.deepEqual(deadline.snapshot().cleanup, { scope: "owned_process_group_only", ownedProcessGroupState: "uncertain",
    escapedDescendantState: "unknown", allDescendantsState: "not_claimed" });

  const owner = createHermesNativeSupervisionProtocolSessionV1(input);
  owner.accept(response(owner, "verified", 2), t0 + 1);
  assert.equal(decodeHermesNativeSupervisionFrameV1(owner.cancel(t0 + 2)).kind, "cancel");
  owner.accept(response(owner, "terminal", 4, { outcome: "cancelled", ownedProcessGroupState: "not_started",
    escapedDescendantState: "not_observed" }), t0 + 3);
  assert.equal(owner.snapshot().phase, "terminal");
  assert.equal(owner.snapshot().cleanup?.ownedProcessGroupState, "not_started");
});

test("an escaped descendant can coexist with absent owned group and never becomes an all-descendants claim", () => {
  const session = createHermesNativeSupervisionProtocolSessionV1(input);
  session.accept(response(session, "verified", 2), t0 + 1);
  session.start(t0 + 2);
  session.accept(response(session, "terminal", 4, { escapedDescendantState: "observed" }), t0 + 3);
  const cleanup = session.snapshot().cleanup;
  assert.equal(cleanup?.ownedProcessGroupState, "absent", "the owned process group can be proven absent");
  assert.equal(cleanup?.escapedDescendantState, "observed", "the escaped fixture descendant remains distinct");
  assert.equal(cleanup?.allDescendantsState, "not_claimed", "group cleanup must not overclaim descendant cleanup");
  assert.equal(JSON.stringify(cleanup).includes("allDescendantsTerminated"), false);

  const forged = { protocol: HERMES_NATIVE_SUPERVISION_PROTOCOL_V1, kind: "terminal", sequence: 4,
    bindingDigest: session.snapshot().bindingDigest, outcome: "completed", ownedProcessGroupState: "absent",
    escapedDescendantState: "observed", descriptorIsolationObserved: false, allDescendantsTerminated: true };
  assert.throws(() => encodeHermesNativeSupervisionFrameV1(forged), refusal);
});

test("terminal cleanup combinations fail closed and terminal sessions cannot restart", () => {
  for (const overrides of [
    { outcome: "none" },
    { outcome: "completed", ownedProcessGroupState: "uncertain" },
    { ownedProcessGroupState: "not_started", escapedDescendantState: "observed" },
    { descriptorIsolationObserved: true },
  ]) {
    const session = createHermesNativeSupervisionProtocolSessionV1(input);
    assert.throws(() => response(session, "terminal", 2, overrides), refusal);
  }
  const session = createHermesNativeSupervisionProtocolSessionV1(input);
  session.accept(response(session, "verified", 2), t0 + 1); session.start(t0 + 2);
  session.accept(response(session, "terminal", 4), t0 + 3);
  assert.throws(() => session.start(t0 + 4), refusal);
  assert.throws(() => session.cancel(t0 + 4), refusal);
  assert.throws(() => session.accept(response(session, "terminal", 5), t0 + 4), refusal);
});
