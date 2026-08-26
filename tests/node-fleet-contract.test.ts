import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityProbeRunner, computeDiscoveryFingerprint, createInventoryManifest, discoveryPayloadSchema, evaluateFleetSignalFreshness, fleetSignalEnvelopeSchema, normalizeStaticDiscovery, normalizeTelemetrySample } from "../src/node-fleet/v1";

const digest = `sha256:${"a".repeat(64)}`;
const discovery = {
  platform: "macos" as const, architecture: "arm64", cpuLogicalCores: 10, memoryBytes: 34_359_738_368,
  gpuClasses: ["apple-gpu"], storage: [{ capacityBytes: 1_000, availableBytes: 500, scratchEligible: true, encryptionReported: true }],
  networkClass: "unmetered" as const, inventory: [{ kind: "bridge" as const, id: "bridge.control-room", version: "1.0.0", manifestDigest: digest }], executorManifestDigest: digest,
};

test("discovery has a stable material fingerprint without raw host identity", () => {
  const parsed = discoveryPayloadSchema.parse(discovery);
  assert.match(computeDiscoveryFingerprint(parsed), /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => discoveryPayloadSchema.parse({ ...discovery, hostname: "private-machine" }));
  assert.notEqual(computeDiscoveryFingerprint(parsed), computeDiscoveryFingerprint({ ...parsed, inventory: [{ ...parsed.inventory[0], version: "1.0.1" }] }));
});

test("fleet signals require node-bound sequence, safe trust, and non-expired freshness", () => {
  const signal = fleetSignalEnvelopeSchema.parse({
    schemaVersion: "1.0.0", tenantId: "tenant:1", nodeId: "node:1", kind: "discovery", source: "static_collector", sequence: 1,
    observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z", trust: "reported", fingerprint: digest, payload: discovery,
  });
  assert.deepEqual(evaluateFleetSignalFreshness(signal, "2026-08-26T12:00:00.000Z"), { eligible: true, code: "eligible" });
  assert.deepEqual(evaluateFleetSignalFreshness(signal, "2026-08-28T00:00:00.000Z"), { eligible: false, code: "signal_expired" });
  assert.equal(fleetSignalEnvelopeSchema.safeParse({ ...signal, trust: "verified" }).success, false);
});

test("static discovery normalizes only approved aggregate facts and is deterministic", () => {
  const result = normalizeStaticDiscovery({ ...discovery, gpuClasses: ["apple-gpu", "apple-gpu"], inventory: [...discovery.inventory].reverse() });
  assert.deepEqual(Object.keys(result.payload).sort(), ["architecture", "cpuLogicalCores", "executorManifestDigest", "gpuClasses", "inventory", "memoryBytes", "networkClass", "platform", "storage"]);
  assert.equal(result.fingerprint, computeDiscoveryFingerprint(result.payload));
  assert.throws(() => normalizeStaticDiscovery({ ...discovery, architecture: "arm64\nprivate-host" }));
});

test("inventory manifests are explicit, sorted, and reject ambiguous duplicate identities", () => {
  const manifest = createInventoryManifest([
    { kind: "tool", id: "tool.typescript", version: "5.9.3" },
    { kind: "bridge", id: "bridge.control-room", version: "1.0.0" },
  ]);
  assert.deepEqual(manifest.entries.map((entry) => entry.kind), ["bridge", "tool"]);
  assert.ok(manifest.entries.every((entry) => entry.manifestDigest === manifest.manifestDigest));
  assert.throws(() => createInventoryManifest([
    { kind: "tool", id: "tool.typescript", version: "5.9.3" },
    { kind: "tool", id: "tool.typescript", version: "6.0.0" },
  ]));
});

test("capability probe runner executes only registered, no-privilege, platform-compatible probes", async () => {
  let invoked = 0;
  const runner = new CapabilityProbeRunner({
    platform: "macos",
    probes: [
      { id: "probe.safe", version: "1.0.0", supportedPlatforms: ["macos"], requiredPrivilege: "none", evaluate: async () => { invoked += 1; return { outcome: "pass", reasonCode: "probe_passed", evidenceDigest: digest }; } },
      { id: "probe.native", version: "1.0.0", supportedPlatforms: ["macos"], requiredPrivilege: "native_evidence_required", evaluate: async () => { invoked += 1; return { outcome: "pass", reasonCode: "incorrect" }; } },
      { id: "probe.linux", version: "1.0.0", supportedPlatforms: ["linux"], requiredPrivilege: "none", evaluate: async () => { invoked += 1; return { outcome: "pass", reasonCode: "incorrect" }; } },
    ],
  });
  assert.equal((await runner.run("probe.safe")).outcome, "pass");
  assert.equal((await runner.run("probe.native")).reasonCode, "native_evidence_required");
  assert.equal((await runner.run("probe.linux")).reasonCode, "platform_unsupported");
  assert.equal(invoked, 1);
});

test("telemetry port accepts only a fixed bounded resource vector with a short expiry", () => {
  const normalized = normalizeTelemetrySample({
    observedAt: "2026-08-26T00:00:00.000Z", samplingIntervalSeconds: 120,
    cpuUtilizationPercent: { quality: "observed", value: 32.5 }, availableMemoryBytes: { quality: "observed", value: 2_000 }, availableStorageBytes: { quality: "observed", value: 3_000 },
    networkClass: "unmetered", powerState: "ac", thermalState: "nominal",
  });
  assert.equal(normalized.expiresAt, "2026-08-26T00:05:00.000Z");
  assert.deepEqual(Object.keys(normalized.payload).sort(), ["availableMemoryBytes", "availableStorageBytes", "cpuUtilizationPercent", "networkClass", "powerState", "samplingIntervalSeconds", "thermalState"]);
  assert.throws(() => normalizeTelemetrySample({ ...normalized.payload, observedAt: "invalid" }));
});
