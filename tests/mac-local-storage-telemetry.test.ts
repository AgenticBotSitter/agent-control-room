import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { macLocalStorageAllowsAssignmentV1, measureMacLocalArtifactStorageV1 } from "../src/web/v1/mac-local-storage-telemetry";
import type { FleetSignalEnvelope } from "../src/node-fleet/v1/schemas";

test("failed artifact-volume measurement cannot make a worker assignable", async () => {
  const measured = await measureMacLocalArtifactStorageV1("/private/fixture", async () => { throw new Error("denied"); });
  assert.deepEqual(measured, { quality: "unavailable" });
  const observedAt = "2026-09-25T12:00:00.000Z";
  const signal: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: "tenant:local", nodeId: "mac-1.codex",
    sequence: 1, observedAt, expiresAt: "2026-09-25T12:01:00.000Z", trust: "reported",
    fingerprint: sha256Digest("local-storage-test"), kind: "telemetry", source: "telemetry_port",
    payload: { samplingIntervalSeconds: 30, cpuUtilizationPercent: { quality: "unavailable" },
      availableMemoryBytes: { quality: "unavailable" }, availableStorageBytes: measured,
      networkClass: "unavailable", powerState: "unavailable", thermalState: "unavailable" } };
  assert.equal(macLocalStorageAllowsAssignmentV1(signal, "2026-09-25T12:00:01.000Z"), false);
  assert.equal(macLocalStorageAllowsAssignmentV1({ ...signal, payload: { ...signal.payload,
    availableStorageBytes: { quality: "observed", value: 1 } } }, "2026-09-25T12:00:01.000Z"), true);
});
