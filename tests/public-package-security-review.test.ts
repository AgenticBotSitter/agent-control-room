import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_OBSERVATION_CONTRACT_V1,
  PUBLIC_OBSERVATION_EVENT_V1,
  assertNoSensitiveValuesV1,
  freezePublicDataV1,
  sha256DigestV1,
  snapshotPublicDataV1,
} from "../packages/control-room-core/src/index";
import {
  OBSERVATION_ADAPTER_SDK_VERSION_V1,
  defineObservationAdapterV1,
  runObservationAdapterConformanceV1,
  type ObservationAdapterV1,
} from "../packages/control-room-adapter-sdk/src/index";
import { runObservationConformanceKitV1 } from "../packages/control-room-conformance-kit/src/index";
import { observedProxy } from "./proxy-test-helper";

const manifest = {
  schemaVersion: PUBLIC_OBSERVATION_CONTRACT_V1,
  adapterId: "adapter.security.review.v1",
  adapterVersion: "0.1.0",
  harness: "example" as const,
  harnessVersion: "0.0.0-synthetic",
  harnessRevision: "0000000000000000000000000000000000000000",
  runtime: { name: "synthetic" as const, minimumVersion: "0.1.0", supportedPlatforms: ["macos" as const] },
  observationKinds: ["stream" as const],
  eventSchemaVersion: PUBLIC_OBSERVATION_EVENT_V1,
  effectAuthority: "none" as const,
  accessMode: "none" as const,
  outputForms: ["structured_events" as const],
  license: "Apache-2.0",
  distribution: "redistributable" as const,
};
const context = { tenantId: "tenant.synthetic.v1", runId: "run.synthetic.v1", sequence: 1, occurredAt: "2026-01-01T00:00:00.000Z" };

function event() {
  return {
    schemaVersion: PUBLIC_OBSERVATION_EVENT_V1,
    tenantId: context.tenantId,
    runId: context.runId,
    sequence: context.sequence,
    occurredAt: context.occurredAt,
    source: "adapter" as const,
    sourceEventKeyDigest: sha256DigestV1({ source: "security-review", sequence: 1 }),
    payload: { category: "transport" as const, state: "connected" as const },
  };
}

function adapter(overrides: Partial<Pick<ObservationAdapterV1, "evaluateCompatibility" | "normalizeObservation">> = {}): ObservationAdapterV1 {
  return defineObservationAdapterV1({
    sdkVersion: OBSERVATION_ADAPTER_SDK_VERSION_V1,
    manifest,
    evaluateCompatibility: () => ({ compatible: true, reasons: [] }),
    normalizeObservation: () => ({ events: [event()] }),
    ...overrides,
  });
}

function conformanceInput(value: ObservationAdapterV1) {
  return { adapter: value, compatibilityEvidence: { synthetic: true }, fixtures: [{ name: "security review", frame: { kind: "synthetic.ready" }, context, expectedEventCount: 1 }] };
}

test("CR10Q-SEC-000 public data boundaries reject Proxies without executing traps", () => {
  for (const operation of [snapshotPublicDataV1, freezePublicDataV1, sha256DigestV1, (value: unknown) => assertNoSensitiveValuesV1(value, "review")]) {
    const proxied = observedProxy({ safe: "value" }, "throwing");
    assert.throws(() => operation(proxied.value));
    assert.equal(proxied.trapCount(), 0);
  }
});

test("CR10Q-SEC-000 public data boundaries reject accessors without invoking them", () => {
  for (const operation of [snapshotPublicDataV1, freezePublicDataV1, sha256DigestV1, (value: unknown) => assertNoSensitiveValuesV1(value, "review")]) {
    let getters = 0;
    const value = Object.defineProperty({}, "safe", { enumerable: true, get() { getters += 1; return "value"; } });
    assert.throws(() => operation(value));
    assert.equal(getters, 0);
  }
});

test("CR10Q-SEC-020 public data boundaries reject prototype-mutating property names before nested values", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const nested = observedProxy({ safe: "value" }, "throwing");
    const value = Object.defineProperty({}, key, {
      configurable: true,
      enumerable: true,
      value: nested.value,
      writable: true,
    });
    for (const operation of [snapshotPublicDataV1, freezePublicDataV1, sha256DigestV1, (input: unknown) => assertNoSensitiveValuesV1(input, "review")]) {
      assert.throws(() => operation(value), /public data property name invalid/);
      assert.equal(nested.trapCount(), 0);
    }
  }
});

test("CR10Q-SEC-020 public data property names are bounded and snapshots have no inherited state", () => {
  const maximumKey = "a".repeat(256);
  const accepted = snapshotPublicDataV1({ [maximumKey]: "value" });
  assert.equal(Object.getPrototypeOf(accepted), null);
  assert.equal(Object.hasOwn(accepted, maximumKey), true);
  assert.equal(accepted[maximumKey], "value");

  const oversized = { ["a".repeat(257)]: "value" };
  for (const operation of [snapshotPublicDataV1, freezePublicDataV1, sha256DigestV1, (input: unknown) => assertNoSensitiveValuesV1(input, "review")]) {
    assert.throws(() => operation(oversized), /public data property name invalid/);
  }
});

test("CR10Q-SEC-020 conformance rejects reserved compatibility evidence before adapter execution", () => {
  let compatibilityCalls = 0;
  const compatibilityEvidence = Object.defineProperty({}, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { synthetic: true },
    writable: true,
  });
  const result = runObservationAdapterConformanceV1({
    ...conformanceInput(adapter({
      evaluateCompatibility: () => {
        compatibilityCalls += 1;
        return { compatible: true, reasons: [] };
      },
    })),
    compatibilityEvidence,
  });
  assert.equal(result.compatible, false);
  assert.deepEqual(result.reasons, ["fixture_invalid"]);
  assert.equal(compatibilityCalls, 0);
});

test("CR10Q-SEC-000 adapter definition captures only exact ordinary data properties", () => {
  const raw = {
    sdkVersion: OBSERVATION_ADAPTER_SDK_VERSION_V1,
    manifest,
    evaluateCompatibility: () => ({ compatible: true, reasons: [] }),
    normalizeObservation: () => ({ events: [event()] }),
  };
  const proxied = observedProxy(raw, "throwing");
  assert.throws(() => defineObservationAdapterV1(proxied.value));
  assert.equal(proxied.trapCount(), 0);
  let getters = 0;
  const accessor = { ...raw };
  Object.defineProperty(accessor, "normalizeObservation", { enumerable: true, get() { getters += 1; return raw.normalizeObservation; } });
  assert.throws(() => defineObservationAdapterV1(accessor));
  assert.equal(getters, 0);
});

test("CR10Q-SEC-000 conformance rejects Proxy input and fixture boundaries without executing traps", () => {
  const valid = conformanceInput(adapter());
  const proxiedInput = observedProxy(valid, "throwing");
  assert.equal(runObservationAdapterConformanceV1(proxiedInput.value).compatible, false);
  assert.equal(proxiedInput.trapCount(), 0);
  const proxiedFixture = observedProxy(valid.fixtures[0]!, "throwing");
  assert.equal(runObservationAdapterConformanceV1({ ...valid, fixtures: [proxiedFixture.value] }).compatible, false);
  assert.equal(proxiedFixture.trapCount(), 0);
});

test("CR10Q-SEC-000 conformance rejects hostile compatibility results without executing them", () => {
  const proxiedDecision = observedProxy({ compatible: true, reasons: [] }, "throwing");
  const proxyResult = runObservationAdapterConformanceV1(conformanceInput(adapter({ evaluateCompatibility: () => proxiedDecision.value })));
  assert.deepEqual(proxyResult.reasons, ["compatibility_rejected"]);
  assert.equal(proxiedDecision.trapCount(), 0);
  let getters = 0;
  const accessorDecision = Object.defineProperty({ reasons: [] }, "compatible", { enumerable: true, get() { getters += 1; return true; } });
  const accessorResult = runObservationAdapterConformanceV1(conformanceInput(adapter({ evaluateCompatibility: () => accessorDecision as never })));
  assert.deepEqual(accessorResult.reasons, ["compatibility_rejected"]);
  assert.equal(getters, 0);
});

test("CR10Q-SEC-000 conformance rejects hostile normalization results without executing them", () => {
  const proxiedOutput = observedProxy({ events: [event()] }, "throwing");
  const proxyResult = runObservationAdapterConformanceV1(conformanceInput(adapter({ normalizeObservation: () => proxiedOutput.value })));
  assert.deepEqual(proxyResult.reasons, ["normalization_failed"]);
  assert.equal(proxiedOutput.trapCount(), 0);
  let getters = 0;
  const accessorOutput = Object.defineProperty({}, "events", { enumerable: true, get() { getters += 1; return [event()]; } });
  const accessorResult = runObservationAdapterConformanceV1(conformanceInput(adapter({ normalizeObservation: () => accessorOutput as never })));
  assert.deepEqual(accessorResult.reasons, ["normalization_failed"]);
  assert.equal(getters, 0);
});

test("CR10Q-SEC-000 conformance kit rejects Proxy cases without executing traps", () => {
  const rawCase = { caseId: "security.review.case", ...conformanceInput(adapter()) };
  const item = { caseId: rawCase.caseId, adapter: rawCase.adapter, compatibilityEvidence: rawCase.compatibilityEvidence, fixtures: rawCase.fixtures };
  const proxied = observedProxy(item, "throwing");
  const report = runObservationConformanceKitV1([proxied.value]);
  assert.equal(report.passed, false);
  assert.deepEqual(report.results[0]?.reasons, ["fixture_invalid"]);
  assert.equal(proxied.trapCount(), 0);
});

test("CR10Q-SEC-000 valid conformance remains immutable and non-authorizing", () => {
  const report = runObservationConformanceKitV1([{ caseId: "security.review.valid", ...conformanceInput(adapter()) }]);
  assert.equal(report.passed, true);
  assert.equal(Object.isFrozen(report) && Object.isFrozen(report.results) && Object.isFrozen(report.results[0]), true);
  assert.equal(JSON.stringify(report).includes("authority") || JSON.stringify(report).includes("credential"), false);
});
