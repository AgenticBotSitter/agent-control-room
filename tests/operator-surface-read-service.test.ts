import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { DatabaseOperatorFleetReadSourceV1, OPERATOR_SURFACES_CONTRACT_V1, OperatorSurfaceReadServiceV1, OperatorSurfaceStoreV1 } from "../src/operator-surfaces/v1";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { adaptPglite } from "../src/persistence/database";
import { ServiceIncidentStore } from "../src/services/v1";
import { DOMAIN_CONTRACT_VERSION, type JobRecord, type NodeRecord, type RequestRecord, type ScheduleRecord, type ServiceRecord, type WorkflowRecord } from "../src/domain/v1";
import { computeAuthorityDigest } from "../src/security";
import { FleetSignalStore, type FleetSignalEnvelope } from "../src/node-fleet/v1";

const now = "2026-08-27T12:00:00.000Z";
const inbox = {
  id: "attention:read", tenantId: "tenant:1", projectId: "project:1", kind: "incident" as const, state: "open" as const,
  requestedAction: "Review incident", reasonCode: "service_degraded", blockedWorkItemIds: ["work:1"],
  legalResponses: [{ id: "response:open", kind: "open_source" as const, label: "Open evidence", requiresConfirmation: false, available: true }],
  evidence: [{ id: "incident:1", kind: "incident" as const }], createdAt: now, deliveryState: "delivered" as const,
};

async function database(): Promise<PGlite> {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort()) await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:1','One'),('tenant:2','Two')`);
  return raw;
}

test("CR6E authorized read service assembles only the bound tenant's redacted records", async () => {
  const raw = await database();
  try {
    const client = adaptPglite(raw);
    const surfaces = new OperatorSurfaceStoreV1(client);
    const incidents = new ServiceIncidentStore(client);
    await surfaces.upsertInbox(inbox);
    await incidents.apply({ tenantId: "tenant:1", serviceId: "service:1", correlationKey: "service:1:degraded", action: "open_or_update", severity: "warning", safeReasonCode: "service_degraded", safeRemedyCode: "inspect_service", observedAt: now });
    await incidents.apply({ tenantId: "tenant:2", serviceId: "service:2", correlationKey: "service:2:degraded", action: "open_or_update", severity: "critical", safeReasonCode: "service_degraded", safeRemedyCode: "inspect_service", observedAt: now });
    const calls: string[] = [];
    const reader = new OperatorSurfaceReadServiceV1(surfaces, incidents, {
      fleet: async ({ tenantId }) => { calls.push(`fleet:${tenantId}`); return [{ workerId: "worker:1", platform: "macos", state: "busy", lastObservedAt: now, capacityState: "reported", availableSlots: 0, totalSlots: 1, capabilityState: "verified", telemetryState: "fresh" }]; },
      bottlenecks: async ({ tenantId }) => { calls.push(`bottlenecks:${tenantId}`); return [{ resourceKey: "gpu:1", utilizationPercent: 100, blockedWorkItemIds: ["work:1"], explanation: "Declared capacity is fully reserved." }]; },
      activeWork: async ({ tenantId }) => { calls.push(`active-work:${tenantId}`); return [{ jobId: "job:1", projectId: "project:1", state: "running", jobType: "synthetic:render", priority: 80, requiredCapability: "capability:render", updatedAt: now }]; },
      portfolio: async ({ tenantId }) => { calls.push(`portfolio:${tenantId}`); return [{ projectId: "project:1", workflowCount: 1, activeJobCount: 1, waitingApprovalJobCount: 0, failedJobCount: 0, lastActivityAt: now }]; },
      services: async ({ tenantId }) => { calls.push(`services:${tenantId}`); return [{ serviceId: "service:1", projectId: "project:1", serviceType: "service:backup", state: "degraded", statusCode: "backup_stale", lastObservedAt: now }]; },
      schedules: async ({ tenantId }) => { calls.push(`schedules:${tenantId}`); return [{ scheduleId: "schedule:1", projectId: "project:1", state: "active", scheduleType: "cron", targetType: "service_check", targetId: "service:1", timezone: "UTC", idempotencyWindowSeconds: 60 }]; },
    });
    const result = await reader.read({ scope: { tenantId: "tenant:1", actorId: "actor:owner", grantedAt: now }, now });
    assert.equal(result.snapshot.contractVersion, OPERATOR_SURFACES_CONTRACT_V1);
    assert.equal(result.snapshot.tenantId, "tenant:1");
    assert.deepEqual(result.snapshot.actionInbox.map((item) => item.id), ["attention:read"]);
    assert.deepEqual(result.snapshot.activeWork.map((work) => work.jobId), ["job:1"]);
    assert.deepEqual(result.snapshot.portfolio.map((project) => project.projectId), ["project:1"]);
    assert.deepEqual(result.snapshot.services.map((service) => service.statusCode), ["backup_stale"]);
    assert.deepEqual(result.snapshot.schedules.map((schedule) => schedule.scheduleId), ["schedule:1"]);
    assert.equal("tenantId" in result.snapshot.serviceIncidents[0]!, false);
    assert.deepEqual(result.snapshot.serviceIncidents.map((incident) => incident.reasonCode), ["service_degraded"]);
    assert.deepEqual(result.serviceIncidents.map((incident) => incident.tenantId), ["tenant:1"]);
    assert.deepEqual(calls.sort(), ["active-work:tenant:1", "bottlenecks:tenant:1", "fleet:tenant:1", "portfolio:tenant:1", "schedules:tenant:1", "services:tenant:1"]);
    await assert.rejects(reader.read({ scope: { tenantId: "tenant:1", actorId: "actor:owner", grantedAt: "2026-08-27T12:00:00.001Z" }, now }), (error: unknown) => error instanceof Error && error.message === "invalid_read_scope");
  } finally { await raw.close(); }
});

test("CR6E read service rejects unsafe upstream display text before it reaches a screen", async () => {
  const raw = await database();
  try {
    const client = adaptPglite(raw);
    const reader = new OperatorSurfaceReadServiceV1(new OperatorSurfaceStoreV1(client), new ServiceIncidentStore(client), {
      fleet: async () => [],
      bottlenecks: async () => [{ resourceKey: "gpu:1", utilizationPercent: 1, blockedWorkItemIds: ["work:1"], explanation: "Bearer secret-token-value" }],
      activeWork: async () => [],
      portfolio: async () => [],
      services: async () => [],
      schedules: async () => [],
    });
    await assert.rejects(reader.read({ scope: { tenantId: "tenant:1", actorId: "actor:owner", grantedAt: now }, now }));
  } finally { await raw.close(); }
});

test("CR6E database fleet source reports only persisted node facts and marks absent capacity unavailable", async () => {
  const raw = await database();
  try {
    const client = adaptPglite(raw);
    const node: NodeRecord = {
      contractVersion: DOMAIN_CONTRACT_VERSION, kind: "node", id: "node:1", tenantId: "tenant:1", displayName: "Node One", state: "pending_enrollment", version: 0,
      platform: "macos", architecture: "arm64", identityKeyId: "key:1", hardwareFingerprint: `sha256:${"a".repeat(64)}`, softwareFingerprint: `sha256:${"b".repeat(64)}`,
      policyVersion: "1.0.0", minimumProtocolVersion: "control-room-node/v1", createdAt: now, updatedAt: now,
    };
    await new CanonicalStore(client).create(node);
    const activeNode: NodeRecord = { ...node, state: "active", version: 1, enrolledAt: now };
    await raw.query(`UPDATE control_nodes SET state='active',version=1,payload=$1::jsonb,updated_at=$2 WHERE tenant_id='tenant:1' AND id='node:1'`, [JSON.stringify(activeNode), now]);
    const request: RequestRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "request", id: "request:1", tenantId: "tenant:1", version: 0, createdAt: now, updatedAt: now, title: "Observed job", objective: "Prove active work projection", state: "draft", priority: 80, requestedBy: { actorId: "identity:owner", actorType: "human" }, idempotencyKey: "request-idempotency-001" };
    const workflow: WorkflowRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "workflow", id: "workflow:1", tenantId: "tenant:1", version: 0, createdAt: now, updatedAt: now, requestId: request.id, projectId: "project:1", definitionVersion: "1.0.0", definitionDigest: `sha256:${"a".repeat(64)}`, authorityMode: "control_room_native", state: "proposed", jobIds: ["job:1"] };
    const authority: JobRecord["authority"] = { projectId: workflow.projectId, allowedExecutor: "executor:synthetic", allowedOperations: ["operation:synthetic"], credentialRefs: [], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "none", maxRisk: "low", maxDurationSeconds: 60, maxConcurrentEffects: 0, expiresAt: "2026-08-27T13:00:00.000Z", digest: `sha256:${"b".repeat(64)}` };
    authority.digest = computeAuthorityDigest(authority);
    const job: JobRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "job", id: "job:1", tenantId: "tenant:1", version: 0, createdAt: now, updatedAt: now, workflowId: workflow.id, projectId: workflow.projectId, jobType: "synthetic:render", specVersion: "1.0.0", inputDigest: `sha256:${"c".repeat(64)}`, state: "proposed", priority: 80, requiredCapability: "capability:render", dependsOnJobIds: [], authority, retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" } };
    const service: ServiceRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "service", id: "service:1", tenantId: "tenant:1", version: 0, createdAt: now, updatedAt: now, projectId: workflow.projectId, serviceType: "service:backup", desiredStateDigest: `sha256:${"d".repeat(64)}`, state: "active", lastObservedAt: now };
    const schedule: ScheduleRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "schedule", id: "schedule:1", tenantId: "tenant:1", version: 0, createdAt: now, updatedAt: now, projectId: workflow.projectId, state: "active", scheduleType: "cron", expression: "0 * * * *", timezone: "UTC", targetType: "service_check", targetId: service.id, nextRunAt: "2026-08-27T13:00:00.000Z", idempotencyWindowSeconds: 60 };
    const canonical = new CanonicalStore(client);
    await canonical.create(request);
    await canonical.create(workflow);
    await canonical.create(job);
    await canonical.create(service);
    await canonical.create(schedule);
    const degradedService: ServiceRecord = { ...service, state: "degraded", version: 1, safeStatusCode: "backup_stale" };
    await raw.query(`UPDATE control_services SET state='degraded',version=1,payload=$1::jsonb,updated_at=$2 WHERE tenant_id='tenant:1' AND id='service:1'`, [JSON.stringify(degradedService), now]);
    const runningJob: JobRecord = { ...job, state: "running", version: 1, updatedAt: now };
    await raw.query(`UPDATE control_jobs SET state='running',version=1,payload=$1::jsonb,updated_at=$2 WHERE tenant_id='tenant:1' AND id='job:1'`, [JSON.stringify(runningJob), now]);
    const source = new DatabaseOperatorFleetReadSourceV1(client);
    const fleet = await source.fleet({ tenantId: "tenant:1", now });
    assert.deepEqual(fleet, [{ workerId: "node:1", platform: "macos", state: "degraded", stateReasonCode: "telemetry_missing", lastObservedAt: now, capacityState: "unavailable", capabilityState: "unavailable", telemetryState: "missing" }]);
    assert.deepEqual(await source.activeWork({ tenantId: "tenant:1", now }), [{ jobId: "job:1", projectId: "project:1", state: "running", jobType: "synthetic:render", priority: 80, requiredCapability: "capability:render", updatedAt: now }]);
    assert.deepEqual(await source.portfolio({ tenantId: "tenant:1", now }), [{ projectId: "project:1", workflowCount: 1, activeJobCount: 1, waitingApprovalJobCount: 0, failedJobCount: 0, lastActivityAt: now }]);
    assert.deepEqual(await source.services({ tenantId: "tenant:1", now }), [{ serviceId: "service:1", projectId: "project:1", serviceType: "service:backup", state: "degraded", statusCode: "backup_stale", lastObservedAt: now }]);
    assert.deepEqual(await source.schedules({ tenantId: "tenant:1", now }), [{ scheduleId: "schedule:1", projectId: "project:1", state: "active", scheduleType: "cron", targetType: "service_check", targetId: "service:1", timezone: "UTC", nextRunAt: "2026-08-27T13:00:00.000Z", idempotencyWindowSeconds: 60 }]);
  } finally { await raw.close(); }
});

test("CR6Q fleet projection never turns stale, future, failed, or blocked evidence into current capability", async () => {
  const raw = await database();
  try {
    const client = adaptPglite(raw);
    const canonical = new CanonicalStore(client);
    const signals = new FleetSignalStore(client);
    const digest = `sha256:${"f".repeat(64)}`;
    const signalNodes = ["fresh", "expired", "future", "blocked"];
    const nodes = [...signalNodes, "overlong"];
    for (const suffix of nodes) {
      const id = `node:${suffix}`;
      const node: NodeRecord = {
        contractVersion: DOMAIN_CONTRACT_VERSION, kind: "node", id, tenantId: "tenant:1", displayName: `Node ${suffix}`, state: "pending_enrollment", version: 0,
        platform: "macos", architecture: "arm64", identityKeyId: `key:${suffix}`, hardwareFingerprint: digest, softwareFingerprint: digest,
        policyVersion: "1.0.0", minimumProtocolVersion: "control-room-node/v1", createdAt: "2026-08-27T10:00:00.000Z", updatedAt: "2026-08-27T10:00:00.000Z",
      };
      await canonical.create(node);
      const activeNode: NodeRecord = { ...node, state: "active", version: 1, enrolledAt: "2026-08-27T10:00:00.000Z" };
      await raw.query(`UPDATE control_nodes SET state='active',version=1,payload=$1::jsonb WHERE tenant_id='tenant:1' AND id=$2`, [JSON.stringify(activeNode), id]);
    }
    const telemetryPayload: Extract<FleetSignalEnvelope, { kind: "telemetry" }>["payload"] = {
      samplingIntervalSeconds: 60,
      cpuUtilizationPercent: { quality: "observed", value: 10 },
      availableMemoryBytes: { quality: "observed", value: 1024 },
      availableStorageBytes: { quality: "observed", value: 2048 },
      networkClass: "unmetered", powerState: "ac", thermalState: "nominal",
    };
    const timing = {
      fresh: ["2026-08-27T11:59:00.000Z", "2026-08-27T12:04:00.000Z"],
      expired: ["2026-08-27T11:50:00.000Z", "2026-08-27T11:55:00.000Z"],
      future: ["2026-08-27T12:01:00.000Z", "2026-08-27T12:06:00.000Z"],
      blocked: ["2026-08-27T11:59:00.000Z", "2026-08-27T12:04:00.000Z"],
    } as const;
    for (const suffix of signalNodes) {
      const [observedAt, expiresAt] = timing[suffix as keyof typeof timing];
      const trust = suffix === "blocked" ? "blocked" as const : "reported" as const;
      await signals.ingestAuthenticated({ schemaVersion: "1.0.0", tenantId: "tenant:1", nodeId: `node:${suffix}`, kind: "telemetry", sequence: 1, observedAt, expiresAt, trust, fingerprint: digest, source: "telemetry_port", payload: telemetryPayload }, now);
      await signals.ingestAuthenticated({ schemaVersion: "1.0.0", tenantId: "tenant:1", nodeId: `node:${suffix}`, kind: "capability", sequence: 1, observedAt, expiresAt, trust, fingerprint: digest, source: "probe_runner", payload: { probeId: "probe:render", probeVersion: "1.0.0", outcome: suffix === "blocked" ? "blocked" : "pass", reasonCode: suffix === "blocked" ? "probe_blocked" : "probe_passed", evidenceDigest: digest } }, now);
    }
    const overlongTelemetry = { schemaVersion: "1.0.0", tenantId: "tenant:1", nodeId: "node:overlong", kind: "telemetry", sequence: 1, observedAt: "2026-08-27T11:59:00.000Z", expiresAt: "2027-08-27T11:59:00.000Z", trust: "reported", fingerprint: digest, source: "telemetry_port", payload: telemetryPayload };
    const overlongCapability = { schemaVersion: "1.0.0", tenantId: "tenant:1", nodeId: "node:overlong", kind: "capability", sequence: 1, observedAt: "2026-08-27T11:59:00.000Z", expiresAt: "2027-08-27T11:59:00.000Z", trust: "reported", fingerprint: digest, source: "probe_runner", payload: { probeId: "probe:render", probeVersion: "1.0.0", outcome: "pass", reasonCode: "probe_passed", evidenceDigest: digest } };
    await raw.query(`INSERT INTO control_node_fleet_current (tenant_id,node_id,signal_kind,signal_subject_id,signal_sequence,fingerprint,trust,observed_at,expires_at,payload) VALUES ('tenant:1','node:overlong','telemetry','node',1,$1,'reported',$2,$3,$4::jsonb),('tenant:1','node:overlong','capability','probe:render',1,$1,'reported',$2,$3,$5::jsonb)`, [digest,overlongTelemetry.observedAt,overlongTelemetry.expiresAt,JSON.stringify(overlongTelemetry),JSON.stringify(overlongCapability)]);
    const fleet = await new DatabaseOperatorFleetReadSourceV1(client).fleet({ tenantId: "tenant:1", now });
    const byId = new Map(fleet.map((worker) => [worker.workerId, worker]));
    assert.deepEqual({ state: byId.get("node:fresh")?.state, reason: byId.get("node:fresh")?.stateReasonCode, telemetry: byId.get("node:fresh")?.telemetryState, capability: byId.get("node:fresh")?.capabilityState }, { state: "online", reason: undefined, telemetry: "fresh", capability: "provisional" });
    assert.deepEqual({ state: byId.get("node:expired")?.state, reason: byId.get("node:expired")?.stateReasonCode, telemetry: byId.get("node:expired")?.telemetryState, capability: byId.get("node:expired")?.capabilityState }, { state: "degraded", reason: "telemetry_stale", telemetry: "stale", capability: "expired" });
    assert.deepEqual({ state: byId.get("node:future")?.state, reason: byId.get("node:future")?.stateReasonCode, telemetry: byId.get("node:future")?.telemetryState, capability: byId.get("node:future")?.capabilityState }, { state: "degraded", reason: "telemetry_stale", telemetry: "stale", capability: "unavailable" });
    assert.deepEqual({ state: byId.get("node:blocked")?.state, reason: byId.get("node:blocked")?.stateReasonCode, telemetry: byId.get("node:blocked")?.telemetryState, capability: byId.get("node:blocked")?.capabilityState }, { state: "degraded", reason: "telemetry_missing", telemetry: "missing", capability: "unavailable" });
    assert.deepEqual({ state: byId.get("node:overlong")?.state, reason: byId.get("node:overlong")?.stateReasonCode, telemetry: byId.get("node:overlong")?.telemetryState, capability: byId.get("node:overlong")?.capabilityState }, { state: "degraded", reason: "telemetry_missing", telemetry: "missing", capability: "unavailable" });
    assert.deepEqual(await new DatabaseOperatorFleetReadSourceV1(client).fleet({ tenantId: "tenant:2", now }), []);
  } finally { await raw.close(); }
});
