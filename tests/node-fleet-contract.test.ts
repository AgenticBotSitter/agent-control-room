import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { BenchmarkRunner, CapabilityProbeRunner, computeDiscoveryFingerprint, createInventoryManifest, decideRediscovery, discoveryPayloadSchema, evaluateFleetEligibility, evaluateFleetSignalFreshness, fleetSignalEnvelopeSchema, normalizeStaticDiscovery, normalizeTelemetrySample } from "../src/node-fleet/v1";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import { adaptPglite } from "../src/persistence/database";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { DOMAIN_CONTRACT_VERSION, type NodeRecord } from "../src/domain/v1";

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

test("benchmark runner requires explicit owner authorization and binds scores to one environment", async () => {
  let invoked = 0;
  const runner = new BenchmarkRunner({ platform: "macos", benchmarks: [{ id: "benchmark.synthetic", version: "1.0.0", workloadDigest: digest, supportedPlatforms: ["macos"], requiredPrivilege: "none", run: async () => { invoked += 1; return { outcome: "pass", reasonCode: "benchmark_completed", normalizedScore: 99, scoreUnit: "synthetic_points", evidenceDigest: digest }; } }] });
  const denied = await runner.run({ benchmarkId: "benchmark.synthetic", environmentFingerprint: digest, ownerAuthorized: false, observedAt: "2026-08-26T00:00:00.000Z" });
  assert.equal(denied.payload.reasonCode, "owner_authorization_required");
  const completed = await runner.run({ benchmarkId: "benchmark.synthetic", environmentFingerprint: digest, ownerAuthorized: true, observedAt: "2026-08-26T00:00:00.000Z" });
  assert.equal(completed.payload.normalizedScore, 99);
  assert.equal(completed.expiresAt, "2026-09-25T00:00:00.000Z");
  assert.equal(invoked, 1);
});

test("rediscovery is triggered by material or trust-continuity changes, never volatile telemetry", () => {
  const baseline = { currentFingerprint: digest, currentExpiresAt: "2026-08-27T00:00:00.000Z", candidateFingerprint: digest, now: "2026-08-26T00:00:00.000Z" };
  assert.deepEqual(decideRediscovery(baseline), { required: false, reason: "not_required" });
  assert.deepEqual(decideRediscovery({ ...baseline, candidateFingerprint: `sha256:${"b".repeat(64)}` }), { required: true, reason: "material_change" });
  assert.deepEqual(decideRediscovery({ ...baseline, supervisorContinuityKnown: false }), { required: true, reason: "supervisor_continuity_unknown" });
  assert.deepEqual(decideRediscovery({ ...baseline, currentExpiresAt: "2026-08-26T00:00:00.000Z" }), { required: true, reason: "discovery_expired" });
});

test("fleet history is tenant-bound, append-only by sequence, and exact-replay safe", async () => {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort()) await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  try {
    await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:fleet','Fleet')`);
    const node: NodeRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "node", id: "node:fleet", tenantId: "tenant:fleet", displayName: "Fleet node", state: "pending_enrollment", version: 0, platform: "macos", architecture: "arm64", identityKeyId: "key:fleet", hardwareFingerprint: digest, softwareFingerprint: digest, policyVersion: "1.0.0", minimumProtocolVersion: "control-room-node/v1", createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z" };
    await new CanonicalStore(adaptPglite(raw)).create(node);
    await raw.query(`UPDATE control_nodes SET state='active',version=1,payload=$1::jsonb,updated_at=$2 WHERE tenant_id='tenant:fleet' AND id='node:fleet'`, [JSON.stringify({ ...node, state: "active", version: 1, enrolledAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z" }), "2026-08-26T00:00:00.000Z"]);
    const signal = fleetSignalEnvelopeSchema.parse({ schemaVersion: "1.0.0", tenantId: "tenant:fleet", nodeId: "node:fleet", kind: "discovery", source: "static_collector", sequence: 1, observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z", trust: "reported", fingerprint: digest, payload: discovery });
    const store = new FleetSignalStore(adaptPglite(raw));
    assert.deepEqual(await store.ingestAuthenticated(signal, signal.observedAt), { replayed: false });
    assert.deepEqual(await store.ingestAuthenticated(signal, signal.observedAt), { replayed: true });
    await assert.rejects(store.ingestAuthenticated({ ...signal, fingerprint: `sha256:${"b".repeat(64)}` }, signal.observedAt));
    assert.equal((await raw.query<{ signal_sequence: number }>(`SELECT signal_sequence FROM control_node_fleet_current WHERE tenant_id='tenant:fleet'`)).rows[0]?.signal_sequence, 1);
  } finally { await raw.close(); }
});

test("fleet eligibility reports stable, actionable reasons instead of guessing", () => {
  const telemetry = fleetSignalEnvelopeSchema.parse({ schemaVersion: "1.0.0", tenantId: "tenant:1", nodeId: "node:1", kind: "telemetry", source: "telemetry_port", sequence: 1, observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-26T00:05:00.000Z", trust: "reported", fingerprint: digest, payload: { samplingIntervalSeconds: 60, cpuUtilizationPercent: { quality: "observed", value: 20 }, availableMemoryBytes: { quality: "observed", value: 10_000 }, availableStorageBytes: { quality: "observed", value: 500 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } });
  assert.deepEqual(evaluateFleetEligibility({ now: "2026-08-26T00:01:00.000Z", signals: [telemetry], requiredScratchBytes: 1_000, requiredCapabilityProbeId: "probe:gpu", requiredBenchmarkId: "benchmark:render" }), { eligible: false, reasons: ["scratch_insufficient", "capability_missing", "benchmark_missing"] });
  assert.deepEqual(evaluateFleetEligibility({ now: "2026-08-26T00:06:00.000Z", signals: [telemetry], requiredScratchBytes: 1 }), { eligible: false, reasons: ["telemetry_stale"] });
});
