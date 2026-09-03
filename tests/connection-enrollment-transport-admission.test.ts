import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  CONNECTION_ENROLLMENT_NODE_INGRESS_RECEIPT_V1,
  CONNECTION_ENROLLMENT_TRANSPORT_ADMISSION_RECEIPT_V1,
  ConnectionEnrollmentNodeIngressErrorV1,
  ConnectionEnrollmentTransportAdmissionErrorV1,
  ConnectionEnrollmentTransportAdmissionV1,
  DisabledConnectionEnrollmentTransportAdmissionV1,
  parseConnectionEnrollmentNodeIngressReceiptV1,
  parseConnectionEnrollmentTransportAdmissionReceiptV1,
  type ConnectionEnrollmentNodeIngressPortV1,
  type ConnectionEnrollmentNodeIngressReceiptV1,
} from "../src/connection-registry/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";

const receivedAt = "2026-09-03T03:00:00.000Z";
const retryAt = "2026-09-03T03:00:10.000Z";
const deliveryId = "delivery:transport-admission:001";
const channelIdentityDigest = sha256Digest({ channel: "private-ssh-tunnel-fixture" });
const digest = (label: string) => sha256Digest({ label });

function configuration(overrides: Record<string, unknown> = {}) {
  return {
    admissionId: "transport-admission:fixture-001",
    transport: "ssh_tunnel" as const,
    listenerVisibility: "private_loopback" as const,
    channelIdentityDigest,
    maximumFrameBytes: 4_096,
    ...overrides,
  };
}

function ingressReceipt(): ConnectionEnrollmentNodeIngressReceiptV1 {
  const material: Omit<ConnectionEnrollmentNodeIngressReceiptV1, "receiptDigest"> = {
    contractVersion: CONNECTION_ENROLLMENT_NODE_INGRESS_RECEIPT_V1,
    ingressReference: "ingress:0123456789abcdef01234567",
    deliveryReference: "delivery:0123456789abcdef01234567",
    intakeReference: "intake:0123456789abcdef01234567",
    protocolFrameDigest: digest("protocol-frame"),
    deliveryEvidenceDigest: digest("delivery-evidence"),
    enrollmentResultDigest: digest("enrollment-result"),
    registryRevision: 1,
    receivedAt,
    protocolDisposition: "accepted",
    ledgerDisposition: "accepted",
    enrollmentDisposition: "accepted",
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseConnectionEnrollmentNodeIngressReceiptV1({ ...material, receiptDigest: sha256Digest(material) });
}

class FixedClock {
  calls = 0;
  constructor(public value: unknown = receivedAt, public failure?: unknown) {}
  now(): unknown {
    this.calls += 1;
    if (this.failure !== undefined) throw this.failure;
    return this.value;
  }
}

class FixedIngress implements ConnectionEnrollmentNodeIngressPortV1 {
  readonly inputs: unknown[] = [];
  constructor(public value: unknown = ingressReceipt(), public failure?: unknown) {}
  async receive(input: unknown): Promise<ConnectionEnrollmentNodeIngressReceiptV1> {
    this.inputs.push(input);
    if (this.failure !== undefined) throw this.failure;
    return this.value as ConnectionEnrollmentNodeIngressReceiptV1;
  }
}

function expectAdmissionCode(action: () => unknown, code: ConnectionEnrollmentTransportAdmissionErrorV1["safeCode"]):
void {
  assert.throws(action, (error: unknown) => error instanceof ConnectionEnrollmentTransportAdmissionErrorV1
    && error.safeCode === code);
}

async function expectAdmissionRejection(action: () => Promise<unknown>,
  code: ConnectionEnrollmentTransportAdmissionErrorV1["safeCode"]): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof ConnectionEnrollmentTransportAdmissionErrorV1
    && error.safeCode === code);
}

test("CR13A-LIVE-060 binds server time and digest-only channel identity into a stable safe receipt", async () => {
  const ingress = new FixedIngress(), clock = new FixedClock();
  const admission = new ConnectionEnrollmentTransportAdmissionV1(ingress, configuration(), clock);
  const first = await admission.admit({ rawFrame: "{}", deliveryId });
  clock.value = retryAt;
  const replay = await admission.admit({ rawFrame: "{}", deliveryId });

  assert.deepEqual(replay, first, "an exact ingress replay must keep the original safe admission receipt");
  assert.equal(first.contractVersion, CONNECTION_ENROLLMENT_TRANSPORT_ADMISSION_RECEIPT_V1);
  assert.deepEqual([first.transport, first.listenerVisibility, first.maximumFrameBytes,
    first.opensListener, first.performsNetworkIo, first.grantsApproval, first.grantsNetworkAuthority,
    first.grantsCommandAuthority, first.grantsLeaseAuthority, first.grantsExecutionAuthority],
  ["ssh_tunnel", "private_loopback", 4_096, false, false, false, false, false, false, false]);
  assert.deepEqual(ingress.inputs, [
    { rawFrame: "{}", deliveryId, receivedAt, transportIdentity: ingress.inputs.length
      ? (ingress.inputs[0] as { transportIdentity: string }).transportIdentity : "" },
    { rawFrame: "{}", deliveryId, receivedAt: retryAt, transportIdentity:
      (ingress.inputs[0] as { transportIdentity: string }).transportIdentity },
  ]);
  const transportIdentity = (ingress.inputs[0] as { transportIdentity: string }).transportIdentity;
  assert.match(transportIdentity, /^transport:ssh_tunnel:[a-f0-9]{64}$/);
  assert.equal(transportIdentity.includes(channelIdentityDigest), false,
    "the rate-limit identity must not reveal the configured channel digest");
  assert.equal(clock.calls, 2);
  assert.deepEqual(parseConnectionEnrollmentTransportAdmissionReceiptV1(first), first);
});

test("CR13A-LIVE-060 rejects public, unbounded, behavioral, and incomplete configuration", () => {
  const ingress = new FixedIngress(), clock = new FixedClock();
  for (const invalid of [
    configuration({ listenerVisibility: "public" }),
    configuration({ transport: "http" }),
    configuration({ maximumFrameBytes: 4_095 }),
    configuration({ maximumFrameBytes: 1_048_577 }),
    configuration({ channelIdentityDigest: "channel:raw-private-identity" }),
    { ...configuration(), extra: true },
  ]) expectAdmissionCode(() => new ConnectionEnrollmentTransportAdmissionV1(ingress, invalid, clock),
    "invalid_configuration");

  let traps = 0;
  const proxyConfiguration = new Proxy(configuration(), {
    get() { traps += 1; throw new Error("configuration getter must remain inert"); },
  });
  expectAdmissionCode(() => new ConnectionEnrollmentTransportAdmissionV1(ingress, proxyConfiguration, clock),
    "invalid_configuration");
  expectAdmissionCode(() => new ConnectionEnrollmentTransportAdmissionV1(
    new Proxy(ingress, { get() { traps += 1; throw new Error("ingress getter must remain inert"); } }),
    configuration(), clock), "invalid_configuration");
  expectAdmissionCode(() => new ConnectionEnrollmentTransportAdmissionV1(ingress, configuration(),
    new Proxy(clock, { get() { traps += 1; throw new Error("clock getter must remain inert"); } })),
  "invalid_configuration");
  assert.equal(traps, 0);
});

test("CR13A-LIVE-060 enforces exact input and UTF-8 bytes before time or ingress", async () => {
  const ingress = new FixedIngress(), clock = new FixedClock();
  const admission = new ConnectionEnrollmentTransportAdmissionV1(ingress, configuration(), clock);
  let behaviorReads = 0;
  const behavioral = {};
  Object.defineProperties(behavioral, {
    rawFrame: { enumerable: true, get() { behaviorReads += 1; return "{}"; } },
    deliveryId: { enumerable: true, value: deliveryId },
  });
  let proxyReads = 0;
  const proxyInput = new Proxy({ rawFrame: "{}", deliveryId }, {
    get() { proxyReads += 1; throw new Error("input getter must remain inert"); },
  });
  for (const invalid of [behavioral, proxyInput, { rawFrame: "{}", deliveryId, receivedAt },
    { rawFrame: "", deliveryId }, { rawFrame: "{}", deliveryId: "?" }]) {
    await expectAdmissionRejection(() => admission.admit(invalid), "invalid_input");
  }
  await expectAdmissionRejection(() => admission.admit({ rawFrame: "😀".repeat(1_025), deliveryId }),
    "frame_too_large");
  assert.deepEqual([behaviorReads, proxyReads, clock.calls, ingress.inputs.length], [0, 0, 0, 0]);
});

test("CR13A-LIVE-060 bounds clock and ingress failures without exposing rejected values", async () => {
  let proxyTraps = 0;
  const proxyFailure: object = new Proxy(Object.create(null) as object, {
    getPrototypeOf() { proxyTraps += 1; throw proxyFailure; },
  });
  const clockFailure = new FixedClock(receivedAt, proxyFailure);
  const clockAdmission = new ConnectionEnrollmentTransportAdmissionV1(new FixedIngress(), configuration(),
    clockFailure);
  let clockRejected: unknown;
  try { await clockAdmission.admit({ rawFrame: "{}", deliveryId }); }
  catch (error) { clockRejected = error; }
  assert.equal(proxyTraps, 0);
  assert.notEqual(clockRejected, proxyFailure);
  assert.ok(clockRejected instanceof ConnectionEnrollmentTransportAdmissionErrorV1);
  assert.equal(clockRejected.safeCode, "time_unavailable");

  const allowedIngressCodes: ConnectionEnrollmentNodeIngressErrorV1["safeCode"][] = ["invalid_input", "disabled",
    "authentication_failed", "wrong_message_type", "scope_mismatch", "enrollment_rejected", "replay_conflict",
    "integrity_failed"];
  for (const code of allowedIngressCodes) {
    const admission = new ConnectionEnrollmentTransportAdmissionV1(
      new FixedIngress(undefined, new ConnectionEnrollmentNodeIngressErrorV1(code)), configuration(),
      new FixedClock());
    await expectAdmissionRejection(() => admission.admit({ rawFrame: "{}", deliveryId }), code);
  }

  const unknownCode = Object.create(ConnectionEnrollmentNodeIngressErrorV1.prototype) as object;
  let behaviorReads = 0;
  Object.defineProperties(unknownCode, {
    safeCode: { value: "not_in_ingress_allowlist" },
    message: { get() { behaviorReads += 1; throw new Error("message must remain unread"); } },
  });
  for (const rejected of [unknownCode, proxyFailure]) {
    const admission = new ConnectionEnrollmentTransportAdmissionV1(new FixedIngress(undefined, rejected),
      configuration(), new FixedClock());
    let failure: unknown;
    try { await admission.admit({ rawFrame: "{}", deliveryId }); }
    catch (error) { failure = error; }
    assert.notEqual(failure, rejected);
    assert.ok(failure instanceof ConnectionEnrollmentTransportAdmissionErrorV1);
    assert.equal(failure.safeCode, "integrity_failed");
  }
  assert.deepEqual([proxyTraps, behaviorReads], [0, 0]);
});

test("CR13A-LIVE-060 rejects non-native ingress thenables before assimilation", async () => {
  let behaviorReads = 0;
  const behavioralThenable = {};
  Object.defineProperty(behavioralThenable, "then", {
    get() { behaviorReads += 1; throw new Error("then getter must remain unread"); },
  });
  const behavioralIngress = {
    receive() { return behavioralThenable as unknown as Promise<ConnectionEnrollmentNodeIngressReceiptV1>; },
  };
  const admission = new ConnectionEnrollmentTransportAdmissionV1(behavioralIngress, configuration(),
    new FixedClock());
  await expectAdmissionRejection(() => admission.admit({ rawFrame: "{}", deliveryId }), "integrity_failed");

  let proxyTraps = 0;
  const proxyThenable = new Proxy(Object.create(null) as object, {
    get() { proxyTraps += 1; throw new Error("Proxy then getter must remain unread"); },
    getPrototypeOf() { proxyTraps += 1; throw new Error("Proxy prototype must remain unread"); },
  });
  const proxyIngress = {
    receive() { return proxyThenable as unknown as Promise<ConnectionEnrollmentNodeIngressReceiptV1>; },
  };
  const proxyAdmission = new ConnectionEnrollmentTransportAdmissionV1(proxyIngress, configuration(),
    new FixedClock());
  await expectAdmissionRejection(() => proxyAdmission.admit({ rawFrame: "{}", deliveryId }), "integrity_failed");
  assert.deepEqual([behaviorReads, proxyTraps], [0, 0]);
});

test("CR13A-LIVE-060 observes malformed intrinsic Promise rejection without process escape", async () => {
  const rawRejectedValue = Object.freeze({ protected: "must-not-reach-process-event" });
  const malformed = Promise.reject(rawRejectedValue);
  let instrumentationReads = 0;
  Object.defineProperty(malformed, "instrumentation", {
    get() { instrumentationReads += 1; throw new Error("instrumentation accessor must remain inert"); },
  });
  const ingress = {
    receive() { return malformed as Promise<ConnectionEnrollmentNodeIngressReceiptV1>; },
  };
  const admission = new ConnectionEnrollmentTransportAdmissionV1(ingress, configuration(), new FixedClock());
  const escaped: unknown[] = [];
  const listener = (value: unknown) => { escaped.push(value); };
  process.on("unhandledRejection", listener);
  try {
    await expectAdmissionRejection(() => admission.admit({ rawFrame: "{}", deliveryId }), "integrity_failed");
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    assert.deepEqual(escaped, []);
    assert.equal(instrumentationReads, 0);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("CR13A-LIVE-060 remains bounded under strict unhandled-rejection policy", () => {
  const probe = `
    import {
      ConnectionEnrollmentTransportAdmissionErrorV1,
      ConnectionEnrollmentTransportAdmissionV1,
    } from "./src/connection-registry/v1/index.ts";
    const rawRejectedValue = Object.freeze({ protected: "must-not-escape" });
    const malformed = Promise.reject(rawRejectedValue);
    Object.defineProperty(malformed, "instrumentation", { value: "unexpected-own-string" });
    const ingress = { receive() { return malformed; } };
    const clock = { now() { return "2026-09-03T03:00:00.000Z"; } };
    const configuration = {
      admissionId: "transport-admission:strict-rejection-probe",
      transport: "ssh_tunnel",
      listenerVisibility: "private_loopback",
      channelIdentityDigest: "sha256:${"a".repeat(64)}",
      maximumFrameBytes: 4096,
    };
    const admission = new ConnectionEnrollmentTransportAdmissionV1(ingress, configuration, clock);
    let bounded = false;
    try {
      await admission.admit({ rawFrame: "{}", deliveryId: "delivery:strict-rejection-probe" });
    } catch (error) {
      bounded = error instanceof ConnectionEnrollmentTransportAdmissionErrorV1
        && error.safeCode === "integrity_failed" && error !== rawRejectedValue;
    }
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    if (!bounded) throw new Error("probe did not return one bounded local failure");
    process.stdout.write("bounded\\n");
  `;
  const completed = spawnSync(process.execPath,
    ["--unhandled-rejections=strict", "--import", "tsx", "--input-type=module", "--eval", probe],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(completed.signal, null);
  assert.equal(completed.stdout, "bounded\n");
  assert.equal(completed.stderr, "");
});

test("CR13A-LIVE-060 rechecks native Promise custody before awaiting ingress", async () => {
  const prototype = Object.getPrototypeOf((async () => undefined)());
  const getDescriptor = Object.getOwnPropertyDescriptor, defineProperty = Object.defineProperty;
  for (const key of ["constructor", "then"] as const) {
    const descriptor = getDescriptor(prototype, key);
    assert.ok(descriptor && "value" in descriptor && typeof descriptor.value === "function");
    let replacementCalls = 0, installed = false;
    const replacement = function (this: unknown, ...args: unknown[]) {
      replacementCalls += 1;
      return Reflect.apply(descriptor.value as (...values: unknown[]) => unknown, this, args);
    };
    const ingress = {
      receive() {
        const pending = (async () => ingressReceipt())();
        defineProperty(prototype, key, { ...descriptor, value: replacement });
        installed = true;
        return pending;
      },
    };
    const admission = new ConnectionEnrollmentTransportAdmissionV1(ingress, configuration(), new FixedClock());
    let pending: Promise<unknown> | undefined;
    try { pending = admission.admit({ rawFrame: "{}", deliveryId }); }
    finally { if (installed) defineProperty(prototype, key, descriptor); }
    await expectAdmissionRejection(() => pending!, "integrity_failed");
    assert.equal(replacementCalls, 0, key);
  }

  const constructorDescriptor = getDescriptor(prototype, "constructor");
  assert.ok(constructorDescriptor && "value" in constructorDescriptor
    && typeof constructorDescriptor.value === "function");
  const promiseConstructor = constructorDescriptor.value;
  const speciesDescriptor = getDescriptor(promiseConstructor, Symbol.species);
  assert.ok(speciesDescriptor && "get" in speciesDescriptor && typeof speciesDescriptor.get === "function");
  let speciesCalls = 0, speciesInstalled = false;
  const ingress = {
    receive() {
      const pending = (async () => ingressReceipt())();
      defineProperty(promiseConstructor, Symbol.species, {
        ...speciesDescriptor,
        get() { speciesCalls += 1; return promiseConstructor; },
      });
      speciesInstalled = true;
      return pending;
    },
  };
  const admission = new ConnectionEnrollmentTransportAdmissionV1(ingress, configuration(), new FixedClock());
  let pending: Promise<unknown> | undefined;
  try { pending = admission.admit({ rawFrame: "{}", deliveryId }); }
  finally {
    if (speciesInstalled) defineProperty(promiseConstructor, Symbol.species, speciesDescriptor);
  }
  await expectAdmissionRejection(() => pending!, "integrity_failed");
  assert.equal(speciesCalls, 0);
});

test("CR13A-LIVE-060 receipt parser detects drift and runs no input behavior", async () => {
  const receipt = await new ConnectionEnrollmentTransportAdmissionV1(new FixedIngress(), configuration(),
    new FixedClock()).admit({ rawFrame: "{}", deliveryId });
  for (const drifted of [{ ...receipt, registryRevision: 2 }, { ...receipt, opensListener: true },
    { ...receipt, extra: true }]) {
    expectAdmissionCode(() => parseConnectionEnrollmentTransportAdmissionReceiptV1(drifted), "integrity_failed");
  }
  let traps = 0;
  const behavioral = new Proxy(receipt, {
    get() { traps += 1; throw new Error("receipt getter must remain inert"); },
  });
  expectAdmissionCode(() => parseConnectionEnrollmentTransportAdmissionReceiptV1(behavioral), "integrity_failed");
  assert.equal(traps, 0);
});

test("CR13A-LIVE-060 rejects ambient runtime replacement before executing it", async () => {
  const receipt = await new ConnectionEnrollmentTransportAdmissionV1(new FixedIngress(), configuration(),
    new FixedClock()).admit({ rawFrame: "{}", deliveryId });
  const getDescriptor = Object.getOwnPropertyDescriptor, defineProperty = Object.defineProperty;
  const hashPrototype = Object.getPrototypeOf(createHash("sha256"));
  const targets: ReadonlyArray<readonly [object, PropertyKey]> = [
    [Object, "getOwnPropertyDescriptor"], [Object, "getPrototypeOf"], [Object, "freeze"], [Object, "keys"],
    [Array, "isArray"], [Array.prototype, "map"], [Array.prototype, "join"], [Array.prototype, "sort"],
    [Number, "isFinite"], [Number, "isSafeInteger"], [JSON, "stringify"], [Date, "parse"],
    [Date.prototype, "getTime"], [Date.prototype, "toISOString"], [String.prototype, "slice"],
    [RegExp.prototype, "exec"], [Reflect, "apply"], [Object.getPrototypeOf(Uint8Array.prototype), "fill"],
    [hashPrototype, "update"], [hashPrototype, "digest"],
  ];
  for (const [owner, key] of targets) {
    const descriptor = getDescriptor(owner, key);
    assert.ok(descriptor && "value" in descriptor && typeof descriptor.value === "function", String(key));
    let replacementCalls = 0;
    const replacement = function (this: unknown, ...args: unknown[]) {
      replacementCalls += 1;
      return Reflect.apply(descriptor.value as (...values: unknown[]) => unknown, this, args);
    };
    defineProperty(owner, key, { ...descriptor, value: replacement });
    let failure: unknown;
    try { parseConnectionEnrollmentTransportAdmissionReceiptV1(receipt); }
    catch (error) { failure = error; }
    finally { defineProperty(owner, key, descriptor); }
    assert.equal(replacementCalls, 0, String(key));
    assert.ok(failure instanceof ConnectionEnrollmentTransportAdmissionErrorV1, String(key));
    assert.equal(failure.safeCode, "integrity_failed", String(key));
  }
});

test("CR13A-LIVE-060 stays disabled in the local pilot and exposes no application listener", async () => {
  await expectAdmissionRejection(() => new DisabledConnectionEnrollmentTransportAdmissionV1().admit({}), "disabled");
  const route = await readFile(resolve("app/api/v1/connections/route.ts"), "utf8");
  const appRuntime = await readFile(resolve("app/control-room-local-pilot-runtime.ts"), "utf8");
  const localRuntime = await readFile(resolve("src/local-pilot/v1/runtime.ts"), "utf8");
  assert.doesNotMatch(route, /TransportAdmission|connection\.enrollment\.deliver|\bPOST\b/);
  assert.doesNotMatch(appRuntime, /TransportAdmission|connection\.enrollment\.deliver/);
  assert.match(localRuntime, /new DisabledConnectionEnrollmentTransportAdmissionV1\(\)/);
  assert.doesNotMatch(localRuntime, /new ConnectionEnrollmentTransportAdmissionV1\(/);
});
