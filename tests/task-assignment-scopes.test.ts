import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1,
  CODEX_OWNER_TRUSTED_LOCAL_START_OPERATION_V1 } from "../src/harness/codex-v1/owner-trusted-local-task-planning-contract";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator } from "../src/web/v1/task-assignment-coordinator";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import type { FleetSignalEnvelope } from "../src/node-fleet/v1/schemas";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { createAccessVerifier, WebAccessError } from "../src/web/v1/access-verifier";
import { request, token, trust } from "./helpers/web-foundation";
import { taskAssignmentFixture } from "./helpers/task-assignment";

test("pre-upgrade assignment without worker identity remains replayable", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const first = await f.assign();
  await f.db.query("DROP TRIGGER control_attempts_payload_mirror ON control_attempts");
  await f.db.query(`UPDATE control_attempts SET worker_id=NULL,payload=payload - 'workerId'
    WHERE tenant_id=$1 AND id=$2`, [f.scope.tenantId, first.receipt.attemptId]);

  const replay = await f.assign();
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, first.receipt);
});

test("assignment scopes refuse overlap, allow disjoint work, and recover after expiry or a crash", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  let now = instant + 8_000;
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:codex",
    allowedOperations: [CODEX_OWNER_TRUSTED_LOCAL_START_OPERATION_V1], credentialRefs: ["credential:codex"], filesystemRoots: [],
    networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
    maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:assignment-scopes", adapter: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1,
    authority, instructions: "Return a bounded plain-text review only.", connectorProfileDigest: sha256Digest("scope-profile"),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(61),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints,
    localAdapterAdmission: { enabledAdapters: [CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1] } }, () => now);
  const route = [{ nodeId: binding.nodeId, executorId: authority.allowedExecutor,
    capabilityProbeId: CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1, maxConcurrentTasks: 8,
    requiredScratchBytes: 0, leaseSeconds: 10 },
  { nodeId: "node:alternate-holder", executorId: authority.allowedExecutor,
    capabilityProbeId: CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1, maxConcurrentTasks: 8,
    requiredScratchBytes: 0, leaseSeconds: 10 }] as const;
  const signals = new FleetSignalStore(f.db);
  const common = { schemaVersion: "1.0.0" as const, tenantId: binding.tenantId, nodeId: binding.nodeId, sequence: 1,
    observedAt: at(7_000), expiresAt: at(240_000), trust: "reported" as const };
  const telemetry: FleetSignalEnvelope = { ...common, fingerprint: sha256Digest("scope-telemetry"), kind: "telemetry",
    source: "telemetry_port", payload: { samplingIntervalSeconds: 30,
      cpuUtilizationPercent: { quality: "observed", value: 10 }, availableMemoryBytes: { quality: "observed", value: 1000 },
      availableStorageBytes: { quality: "observed", value: 1000 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } };
  const capability: FleetSignalEnvelope = { ...common, fingerprint: sha256Digest("scope-capability"), kind: "capability",
    source: "probe_runner", payload: { probeId: CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1,
      probeVersion: "1.0.0", outcome: "pass", reasonCode: "fixture" } };
  await signals.ingestAuthenticated(telemetry, at(7_000), binding);
  await signals.ingestAuthenticated(capability, at(7_000), binding);
  const assignments = new TaskAssignmentCoordinator(f.db, f.scope, planner, route, () => now);

  async function prepare(key: string, path?: string, kind: "file" | "tree" = "tree") {
    const draft = { title: `Scoped task ${key}`, instructions: "Make one bounded change and return evidence.",
      ...(path === undefined ? {} : { scopes: [{ kind, path }] }) } as const;
    const proposed = await f.tasks.propose(f.identity, binding.projectId, draft, `scope-proposal-${key}`);
    const planned = await planner.plan(f.identity, binding.projectId, proposed.receipt.jobId,
      sha256Digest({ title: draft.title, instructions: draft.instructions }));
    return planned.receipt;
  }

  const first = await prepare("first", "src/shared");
  const firstAssignment = await assignments.assign(f.identity, binding.projectId, first.jobId, binding.nodeId, first.inputDigest);
  assert.equal(firstAssignment.receipt.leaseCurrent, true);

  const overlapping = await prepare("overlap", "src/shared/child.ts", "file");
  await assert.rejects(assignments.assign(f.identity, binding.projectId, overlapping.jobId, binding.nodeId, overlapping.inputDigest),
    (error: unknown) => (error as { code?: string }).code === "conflict", "an active tree lease excludes a nested file scope");

  const undeclared = await prepare("undeclared");
  const defaultScopes = (await f.db.query<{ scope_kind: string; path: string }>(
    "SELECT scope_kind,path FROM control_task_declared_scopes WHERE tenant_id=$1 AND job_id=$2",
    [binding.tenantId, undeclared.jobId])).rows;
  assert.deepEqual(defaultScopes, [{ scope_kind: "tree", path: "" }], "omitted scopes persist as whole-repository ownership");
  await assert.rejects(assignments.assign(f.identity, binding.projectId, undeclared.jobId, binding.nodeId, undeclared.inputDigest),
    (error: unknown) => (error as { code?: string }).code === "conflict", "an omitted declaration cannot evade an active scope");

  const disjoint = await prepare("disjoint", "docs/owner-guide.md", "file");
  const disjointAssignment = await assignments.assign(f.identity, binding.projectId, disjoint.jobId, binding.nodeId, disjoint.inputDigest);
  assert.equal(disjointAssignment.receipt.leaseCurrent, true, "disjoint scopes can run concurrently");

  now = instant + 19_000;
  const afterExpiry = await prepare("expired", "src/shared/new.ts", "file");
  const expiryAssignment = await assignments.assign(f.identity, binding.projectId, afterExpiry.jobId, binding.nodeId, afterExpiry.inputDigest);
  assert.equal(expiryAssignment.receipt.leaseCurrent, true, "wall-clock expiry frees an overlapping scope");
  const originalLease = (await f.db.query<{ state: string }>(
    "SELECT state FROM control_leases WHERE tenant_id=$1 AND id=$2", [binding.tenantId, firstAssignment.receipt.leaseId])).rows[0];
  assert.equal(originalLease?.state, "active", "recovery does not require a crashed worker to release its lease record");
  const staleScopeCount = (await f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_assignment_lease_scopes WHERE tenant_id=$1 AND lease_id=$2",
    [binding.tenantId, firstAssignment.receipt.leaseId])).rows[0];
  assert.equal(staleScopeCount?.count, "0", "a later assignment prunes crash-expired scope rows");

  now = instant + 30_000;
  const expired = await assignments.expire(f.identity, binding.projectId, expiryAssignment.receipt.jobId, expiryAssignment.receipt.inputDigest);
  assert.equal(expired.receipt.leaseState, "expired");
  const explicitlyExpiredScopeCount = (await f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_assignment_lease_scopes WHERE tenant_id=$1 AND lease_id=$2",
    [binding.tenantId, expiryAssignment.receipt.leaseId])).rows[0];
  assert.equal(explicitlyExpiredScopeCount?.count, "0", "explicit expiry removes its scope rows");

  const renewable = await prepare("renewable", "src/leased");
  const renewableAssignment = await assignments.assign(f.identity, binding.projectId, renewable.jobId, binding.nodeId, renewable.inputDigest);
  const leaseRow = (await f.db.query<{ version: number }>(
    "SELECT version FROM control_leases WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, renewableAssignment.receipt.leaseId])).rows[0]!;
  const holder = { tenantId: binding.tenantId, nodeId: binding.nodeId, expiresAt: at(240_000), assertCurrent() {} };
  const nonHolder = { ...holder, nodeId: "node:alternate-holder" };
  const wrongTenant = { ...holder, tenantId: "tenant:other" };
  now = instant + 35_000;
  await assert.rejects(assignments.renewByHolder(nonHolder, binding.projectId, renewable.jobId,
    renewableAssignment.receipt.leaseId, renewableAssignment.receipt.leaseEpoch, leaseRow.version,
    "renewal:holder-1", at(35_000), at(45_000)),
  (error: unknown) => (error as { code?: string }).code === "conflict", "only the authenticated holder can renew");
  await assert.rejects(assignments.renewByHolder(wrongTenant, binding.projectId, renewable.jobId,
    renewableAssignment.receipt.leaseId, renewableAssignment.receipt.leaseEpoch, leaseRow.version,
    "renewal:tenant-1", at(35_000), at(45_000)),
  (error: unknown) => (error as { code?: string }).code === "conflict", "a holder from another tenant cannot renew");
  await assert.rejects(assignments.renewByHolder(holder, binding.projectId, renewable.jobId,
    renewableAssignment.receipt.leaseId, renewableAssignment.receipt.leaseEpoch, leaseRow.version,
    "renewal:overlong-1", at(35_000), at(46_000)),
  (error: unknown) => (error as { code?: string }).code === "conflict", "renewal cannot exceed the configured route duration");
  const renewed = await assignments.renewByHolder(holder, binding.projectId, renewable.jobId,
    renewableAssignment.receipt.leaseId, renewableAssignment.receipt.leaseEpoch, leaseRow.version,
    "renewal:holder-1", at(35_000), at(45_000));
  assert.ok(Date.parse(renewed.receipt.expiresAt) > Date.parse(renewableAssignment.receipt.expiresAt));
  const renewalReplay = await assignments.renewByHolder(holder, binding.projectId, renewable.jobId,
    renewableAssignment.receipt.leaseId, renewableAssignment.receipt.leaseEpoch, leaseRow.version,
    "renewal:holder-1", at(35_000), at(45_000));
  assert.equal(renewalReplay.replayed, true, "a lost renewal response can replay the exact holder request");
  const inScope = await assignments.assertWriteEffectsInScope(holder, binding.projectId, renewable.jobId,
    renewableAssignment.receipt.leaseId, renewableAssignment.receipt.leaseEpoch, ["src/leased/ok.ts"]);
  assert.deepEqual(inScope.paths, ["src/leased/ok.ts"]);
  await assert.rejects(assignments.assertWriteEffectsInScope(holder, binding.projectId, renewable.jobId,
    renewableAssignment.receipt.leaseId, renewableAssignment.receipt.leaseEpoch, ["src/outside.ts"]),
  (error: unknown) => (error as { code?: string }).code === "conflict", "an out-of-scope write effect is refused");

  const restarted = new TaskAssignmentCoordinator(f.db, f.scope, planner, route, () => now);
  const ownerView = await f.tasks.detail(f.identity, binding.projectId, renewable.jobId);
  assert.deepEqual(ownerView.ownershipLeases, [{ nodeId: binding.nodeId, expiresAt: renewed.receipt.expiresAt,
    state: "active", current: true, scopes: [{ kind: "tree", path: "src/leased" }] }],
  "the owner sees the holder, deadline, state, and exact leased scope after restart");
  const restartOverlap = await prepare("restart-overlap", "src/leased/child.ts", "file");
  await assert.rejects(restarted.assign(f.identity, binding.projectId, restartOverlap.jobId, binding.nodeId, restartOverlap.inputDigest),
    (error: unknown) => (error as { code?: string }).code === "conflict", "a fresh coordinator observes the durable lease");

  const renewedRow = (await f.db.query<{ version: number }>(
    "SELECT version FROM control_leases WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, renewableAssignment.receipt.leaseId])).rows[0]!;
  now = Date.parse(renewed.receipt.expiresAt);
  await assert.rejects(assignments.renewByHolder(holder, binding.projectId, renewable.jobId,
    renewableAssignment.receipt.leaseId, renewableAssignment.receipt.leaseEpoch, renewedRow.version,
    "renewal:at-expiry-1", renewed.receipt.expiresAt, at(46_000)),
  (error: unknown) => (error as { code?: string }).code === "conflict", "renewal at the exact lease expiry is refused");

  const identityAt = new Date(now).toISOString();
  await f.db.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:scope-operator',$1,'human','Scoped operator',$2,$3,'active',$4,$4)`,
  [binding.tenantId, trust.issuer, sha256Digest({ provider: trust.issuer, subject: "scope-operator" }), identityAt]);
  await f.db.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:scope-operator',$1,'identity:scope-operator','operator',$2::jsonb,$3::jsonb,'low',false,false,$4,$4)`,
  [binding.tenantId, JSON.stringify(["*"]), JSON.stringify([binding.projectId]), identityAt]);
  const operatorJwt = token({ sub: "scope-operator", iat: instant / 1000 - 60, exp: instant / 1000 + 600 });
  const operator = createAccessVerifier(f.accessTrust)(request(undefined, undefined, undefined, undefined, operatorJwt), now);
  await assert.rejects(restarted.revoke(operator, binding.projectId, renewable.jobId, renewable.inputDigest),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied",
  "a fully privileged operator remains unable to revoke an ownership lease without the owner role");

  const revoked = await restarted.revoke(f.identity, binding.projectId, renewable.jobId, renewable.inputDigest);
  assert.equal(revoked.receipt.leaseState, "revoked");
  assert.equal((await f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_assignment_lease_scopes WHERE tenant_id=$1 AND lease_id=$2",
    [binding.tenantId, renewableAssignment.receipt.leaseId])).rows[0]?.count, "0");
  const afterRevoke = await restarted.assign(f.identity, binding.projectId, restartOverlap.jobId, binding.nodeId, restartOverlap.inputDigest);
  assert.equal(afterRevoke.receipt.leaseCurrent, true, "owner revocation releases the scope");

  const concurrentA = await prepare("concurrent-a", "src/concurrent");
  const concurrentB = await prepare("concurrent-b", "src/concurrent/child.ts", "file");
  const concurrent = await Promise.allSettled([
    restarted.assign(f.identity, binding.projectId, concurrentA.jobId, binding.nodeId, concurrentA.inputDigest),
    restarted.assign(f.identity, binding.projectId, concurrentB.jobId, binding.nodeId, concurrentB.inputDigest),
  ]);
  assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1,
    "database-serialized acquisition has exactly one winner");
  assert.equal(concurrent.filter(result => result.status === "rejected").length, 1);
});
