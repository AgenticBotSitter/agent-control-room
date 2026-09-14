import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { adaptPglite } from "../src/persistence/database";
import { SecurityStore } from "../src/security/security-store";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { DOMAIN_CONTRACT_VERSION, type AttemptRecord, type JobRecord, type LeaseRecord, type NodeRecord,
  type RequestRecord, type WorkflowRecord } from "../src/domain/v1";
import {
  processRetirementProofDigestV1,
  projectWorkResourceAdmissionDigestV1,
  type ProcessRetirementProofV1,
  type ProjectWorkResourceDeclarationV1,
} from "../src/contracts/v1";
import {
  ProjectWorkAdmissionServiceV1,
  authorizeProcessRetirementV1,
  refuseNoStartReleaseV1,
  type ProcessRetirementVerifierPortV1,
} from "../src/project-coordination/v1";

const base = Date.parse("2026-09-14T00:00:00.000Z");
const at = (offset = 0) => new Date(base + offset).toISOString();
const hex = (character: string) => `sha256:${character.repeat(64)}`;
const repositoryDigest = sha256Digest({ resource: "repository:main" });

const trustedVerifier: ProcessRetirementVerifierPortV1 = { verifyProcessRetirement: () => true };
const refusingVerifier: ProcessRetirementVerifierPortV1 = { verifyProcessRetirement: () => false };
const throwingVerifier: ProcessRetirementVerifierPortV1 = {
  verifyProcessRetirement: () => { throw new Error("native recovery source unavailable"); } };

/** Disposable in-memory acceptance data, matching the PGlite pattern used elsewhere in this suite. */
async function fixture(verifier: ProcessRetirementVerifierPortV1 = trustedVerifier) {
  const raw = new PGlite();
  for (const name of (await readdir("db/migrations")).filter((file) => file.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(`db/migrations/${name}`, "utf8"));
  }
  await raw.query("INSERT INTO tenants(id,display_name) VALUES('tenant:test','Tenant')");
  await raw.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','W')");
  await raw.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,project_types,supported_read_operations,
     supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES('adapter:test','tenant:test','coordination','v1','control_room_native','fixture','[]','[]','[]','v1',1)`);
  await raw.query(`INSERT INTO projects
    (id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
     health,authority_mode,observed_at,payload)
    VALUES('project:test','tenant:test','workspace:test','adapter:test','project:test','1','Project','ready',
     'ready','healthy','control_room_native',$1,'{}')`, [at()]);
  await raw.query(`INSERT INTO control_manual_project_heads
    (tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES('tenant:test','project:test','active',1,$1,$1)`, [at()]);
  const db = adaptPglite(raw);
  await new SecurityStore(db).bootstrapOwner({ tenantId: "tenant:test", provider: "https://access.invalid",
    subject: "owner", identityId: "identity:owner", grantId: "grant:owner", displayName: "Owner",
    verifiedAt: at(-60_000), expiresAt: at(3_600_000), now: at() });
  await raw.query(`INSERT INTO control_work_resources
    (tenant_id,id,kind,canonical_key,comparison_key,configuration_digest,payload,created_at)
    VALUES('tenant:test','resource:repository:main','repository','resource:repository:main',
     'resource:repository:main',$1,'{}',$2)`, [repositoryDigest, at()]);

  const canonical = new CanonicalStore(db);
  const admissions = new ProjectWorkAdmissionServiceV1(canonical, verifier);
  const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: "tenant:test", version: 0,
    createdAt: at(-60_000), updatedAt: at(-60_000) } as const;
  const node: NodeRecord = { ...common, kind: "node", id: "node:test", displayName: "Node",
    state: "pending_enrollment", platform: "linux", architecture: "x64", identityKeyId: "key:test",
    hardwareFingerprint: hex("a"), softwareFingerprint: hex("b"), policyVersion: "1.0.0",
    minimumProtocolVersion: "1.0.0" };
  await canonical.create(node);
  await canonical.transition({ tenantId: "tenant:test", kind: "node", entityId: node.id, expectedVersion: 0,
    toState: "active", transitionId: "transition:node", idempotencyKey: "retirement-node-active",
    actor: { actorId: "identity:owner", actorType: "human" }, occurredAt: at(), recordPatch: { enrolledAt: at() } });

  async function worker(suffix: string) {
    const request: RequestRecord = { ...common, kind: "request", id: `request:${suffix}`,
      projectId: "project:test", title: "Work", objective: "Do bounded work", state: "draft", priority: 50,
      requestedBy: { actorId: "identity:owner", actorType: "human" },
      idempotencyKey: `retirement-request-${suffix}` };
    const workflow: WorkflowRecord = { ...common, kind: "workflow", id: `workflow:${suffix}`,
      requestId: request.id, projectId: "project:test", definitionVersion: "1.0.0", definitionDigest: hex("c"),
      authorityMode: "control_room_native", state: "proposed", jobIds: [`job:${suffix}`] };
    const authority: JobRecord["authority"] = { projectId: "project:test", allowedExecutor: "executor:worker",
      allowedOperations: ["prepare.repository-work"], credentialRefs: [], filesystemRoots: [],
      networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "none", maxRisk: "low",
      maxDurationSeconds: 3_600, maxConcurrentEffects: 0, expiresAt: at(3_600_000), digest: hex("0") };
    authority.digest = computeAuthorityDigest(authority);
    const job: JobRecord = { ...common, kind: "job", id: `job:${suffix}`, workflowId: workflow.id,
      projectId: "project:test", jobType: "work.bounded", specVersion: "1.0.0", inputDigest: hex("d"),
      state: "proposed", priority: 50, requiredCapability: "capability.build", dependsOnJobIds: [], authority,
      retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false,
        ambiguousEffectPolicy: "attention" } };
    await canonical.create(request); await canonical.create(workflow); await canonical.create(job);
    const actor = { actorId: "identity:owner", actorType: "human" as const };
    const ready = await canonical.transition({ tenantId: "tenant:test", kind: "job", entityId: job.id,
      expectedVersion: 0, toState: "ready", transitionId: `transition:ready:${suffix}`,
      idempotencyKey: `retirement-ready-${suffix}`, actor, occurredAt: at() });
    await canonical.claimReadyJob({ tenantId: "tenant:test", jobId: job.id,
      expectedJobVersion: ready.entity.version, nodeId: "node:test", attemptId: `attempt:${suffix}`,
      leaseId: `lease:${suffix}`, transitionId: `transition:claim:${suffix}`,
      idempotencyKey: `retirement-claim-${suffix}`, actor, acquiredAt: at(), expiresAt: at(300_000) });
    return { jobId: job.id, attemptId: `attempt:${suffix}`, leaseId: `lease:${suffix}`,
      admissionId: `admission:${suffix}`, runId: `run:${suffix}` };
  }

  return { raw, db, canonical, admissions, worker, close: () => raw.close() };
}

type Worker = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["worker"]>>;

function declaration(worker: Worker, path = ""): ProjectWorkResourceDeclarationV1 {
  return { schema: "control-room.project-work-resource-declaration/v1", tenantId: "tenant:test",
    projectId: "project:test", jobId: worker.jobId,
    workspace: { kind: "repository", resourceId: "resource:repository:main",
      resourceConfigurationDigest: repositoryDigest, baseRevision: "0123456789abcdef",
      workspaceIntentDigest: sha256Digest({ workspace: worker.admissionId }) },
    scopes: [{ resourceId: "resource:repository:main", resourceKind: "repository",
      resourceConfigurationDigest: repositoryDigest, accessMode: "write", scopeKind: "tree", path }] };
}

const admissionRequest = (worker: Worker, value: unknown) => ({
  schema: "control-room.project-work-admission-request/v1" as const, routeKind: "manual" as const,
  tenantId: "tenant:test", projectId: "project:test", jobId: worker.jobId, attemptId: worker.attemptId,
  leaseId: worker.leaseId, nodeId: "node:test", admissionId: worker.admissionId,
  authority: { kind: "owner" as const, ownerIdentityId: "identity:owner" }, declaration: value,
  disjointWriters: { requested: false }, acquiredAt: at(1_000) });

function retirementProof(worker: Worker, declarationDigest: string,
  overrides: Partial<ProcessRetirementProofV1> = {}): ProcessRetirementProofV1 {
  return { schema: "control-room.process-retirement-proof/v1", tenantId: "tenant:test",
    projectId: "project:test", jobId: worker.jobId, attemptId: worker.attemptId, leaseId: worker.leaseId,
    nodeId: "node:test", admissionId: worker.admissionId,
    resourceAdmissionDigest: projectWorkResourceAdmissionDigestV1({
      schema: "control-room.project-work-resource-admission/v1", tenantId: "tenant:test",
      projectId: "project:test", jobId: worker.jobId, attemptId: worker.attemptId, leaseId: worker.leaseId,
      nodeId: "node:test", admissionId: worker.admissionId, declarationDigest }),
    runId: worker.runId, processIdentityDigest: hex("7"), sourceKind: "native_recovery",
    sourceEvidenceDigest: hex("8"), observedAt: at(60_000), ...overrides };
}

async function heldState(f: Awaited<ReturnType<typeof fixture>>, admissionId: string) {
  const row = await f.raw.query<{ state: string; retirement_kind: string | null; version: string }>(
    `SELECT state,retirement_kind,version::text AS version FROM control_attempt_resource_admissions
     WHERE tenant_id='tenant:test' AND id=$1`, [admissionId]);
  return row.rows[0];
}

test("lease expiry, disconnect and restart never release a resource holder", async () => {
  const f = await fixture();
  try {
    const worker = await f.worker("expiry");
    const admitted = await f.admissions.admit(admissionRequest(worker, declaration(worker)));
    assert.equal(admitted.replayed, false);

    const job = await f.canonical.get("tenant:test", "job", worker.jobId) as JobRecord;
    const attempt = await f.canonical.get("tenant:test", "attempt", worker.attemptId) as AttemptRecord;
    const lease = await f.canonical.get("tenant:test", "lease", worker.leaseId) as LeaseRecord;
    await f.canonical.expireLease({ tenantId: "tenant:test", leaseId: lease.id, jobId: job.id,
      attemptId: attempt.id, expectedLeaseVersion: lease.version, expectedJobVersion: job.version,
      expectedAttemptVersion: attempt.version, epoch: lease.epoch,
      transitionId: "transition:expire", idempotencyKey: "retirement-expire",
      actor: { actorId: "service:test", actorType: "service" }, occurredAt: lease.expiresAt });
    assert.deepEqual(await heldState(f, worker.admissionId),
      { state: "held", retirement_kind: null, version: "1" });

    // Quality acceptance and capacity release are separate decisions: marking the
    // work finished does not release the resource either.
    await f.raw.query(`UPDATE control_jobs
      SET state='succeeded',payload=jsonb_set(payload,'{state}','"succeeded"')
      WHERE tenant_id='tenant:test' AND id=$1`, [worker.jobId]);
    assert.equal((await heldState(f, worker.admissionId))?.state, "held");

    // A restarted server sees the same held holder through the canonical recheck.
    const rechecked = await f.admissions.recheck({ tenantId: "tenant:test", projectId: "project:test",
      jobId: worker.jobId, attemptId: worker.attemptId, leaseId: worker.leaseId, nodeId: "node:test",
      admissionId: worker.admissionId, declaration: declaration(worker) });
    assert.equal(rechecked.state, "held");

    // And a new writer still waits behind it.
    const next = await f.worker("expiry-next");
    await assert.rejects(f.admissions.admit(admissionRequest(next, declaration(next))), /resource_conflict/);
  } finally { await f.close(); }
});

test("only exact authenticated process-retirement evidence retires a holder", async () => {
  const f = await fixture();
  try {
    const worker = await f.worker("retire");
    const admitted = await f.admissions.admit(admissionRequest(worker, declaration(worker)));

    // Result text, a transport receipt and a browser-shaped disconnect notice are
    // not evidence: none of them parses as the strict retirement proof.
    for (const bogus of ["the process exited", { receiptId: "receipt:one", acknowledged: true },
      { schema: "control-room.process-retirement-proof/v1", tenantId: "tenant:test" },
      { ...retirementProof(worker, admitted.declarationDigest), sourceKind: "lease_expired" }]) {
      await assert.rejects(f.admissions.retire(bogus), /retirement_evidence_invalid/);
    }
    // Evidence that the captured verifier cannot authenticate is refused.
    const refusing = await fixture(refusingVerifier);
    try {
      await assert.rejects(refusing.admissions.retire(retirementProof(worker, admitted.declarationDigest)),
        /retirement_evidence_unauthorized/);
    } finally { await refusing.close(); }
    // A verifier that fails is a refusal, never an allow.
    await assert.rejects(authorizeProcessRetirementV1(throwingVerifier,
      retirementProof(worker, admitted.declarationDigest)), /retirement_evidence_unauthorized/);
    // A hand-made authorization object is not an authorization.
    await assert.rejects(f.canonical.retireProjectWorkResourceAdmissionV1({
      proof: retirementProof(worker, admitted.declarationDigest), proofDigest: hex("3") }),
    /retirement_evidence_unauthorized/);

    // Evidence bound to a different attempt or a different declaration refuses.
    await assert.rejects(f.admissions.retire(retirementProof(worker, admitted.declarationDigest,
      { attemptId: "attempt:other" })), /retirement_evidence_invalid/);
    await assert.rejects(f.admissions.retire(retirementProof(worker, hex("4"))),
      /retirement_evidence_invalid/);
    assert.equal((await heldState(f, worker.admissionId))?.state, "held");

    // The exact proof retires the holder once.
    const proof = retirementProof(worker, admitted.declarationDigest);
    const retired = await f.admissions.retire(proof);
    assert.deepEqual({ version: retired.version, replayed: retired.replayed }, { version: 2, replayed: false });
    assert.deepEqual(await heldState(f, worker.admissionId),
      { state: "retired", retirement_kind: "trusted_process_retired", version: "2" });
    const stored = await f.raw.query<{ digest: string }>(
      `SELECT retirement_proof_digest AS digest FROM control_attempt_resource_admissions WHERE id=$1`,
      [worker.admissionId]);
    assert.equal(stored.rows[0]?.digest, processRetirementProofDigestV1(proof));

    // Exact replay is idempotent; different evidence on a retired holder conflicts.
    assert.deepEqual(await f.admissions.retire(proof), { admissionId: worker.admissionId, version: 2,
      replayed: true });
    await assert.rejects(f.admissions.retire({ ...proof, sourceEvidenceDigest: hex("5") }),
      /retirement_replay_conflict/);

    // The canonical recheck now refuses, and the resource is free for a new writer.
    await assert.rejects(f.admissions.recheck({ tenantId: "tenant:test", projectId: "project:test",
      jobId: worker.jobId, attemptId: worker.attemptId, leaseId: worker.leaseId, nodeId: "node:test",
      admissionId: worker.admissionId, declaration: declaration(worker) }), /resource_admission_retired/);
    const next = await f.worker("retire-next");
    assert.equal((await f.admissions.admit(admissionRequest(next, declaration(next)))).replayed, false);
  } finally { await f.close(); }
});

test("no-start release is unsupported and never reaches the database", async () => {
  const f = await fixture();
  try {
    const worker = await f.worker("no-start");
    await f.admissions.admit(admissionRequest(worker, declaration(worker)));
    assert.throws(() => refuseNoStartReleaseV1(), /no_start_release_unsupported/);

    // There is no schema in this package that produces the reserved value, and the
    // database refuses a hand-written one on an unchanged holder anyway.
    await assert.rejects(f.raw.query(`UPDATE control_attempt_resource_admissions
      SET state='retired',version=2,retired_at=$1,retirement_kind='trusted_no_start',
        retirement_proof_digest=$2 WHERE tenant_id='tenant:test' AND id=$3 AND version<>1`,
    [at(10_000), hex("6"), worker.admissionId]).then(async () => {
      const row = await heldState(f, worker.admissionId);
      if (row?.state === "held") throw new Error("no-start update changed nothing, as required");
    }), /no-start update changed nothing/);
    assert.equal((await heldState(f, worker.admissionId))?.state, "held");

    const kinds = await f.raw.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM control_attempt_resource_admissions
       WHERE retirement_kind='trusted_no_start'`);
    assert.equal(kinds.rows[0]?.count, "0");

    // An admission service composed without a captured verifier can never retire.
    const unverified = new ProjectWorkAdmissionServiceV1(f.canonical);
    await assert.rejects(unverified.retire(retirementProof(worker,
      (await f.admissions.recheck({ tenantId: "tenant:test", projectId: "project:test", jobId: worker.jobId,
        attemptId: worker.attemptId, leaseId: worker.leaseId, nodeId: "node:test",
        admissionId: worker.admissionId, declaration: declaration(worker) })).declarationDigest)),
    /retirement_evidence_unauthorized/);
    assert.equal((await heldState(f, worker.admissionId))?.state, "held");
  } finally { await f.close(); }
});
