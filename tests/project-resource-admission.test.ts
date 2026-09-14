import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { adaptPglite, type DatabaseClient, type DatabaseSession } from "../src/persistence/database";
import { SecurityStore } from "../src/security/security-store";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { DOMAIN_CONTRACT_VERSION, type JobRecord, type NodeRecord, type RequestRecord,
  type WorkflowRecord } from "../src/domain/v1";
import {
  NO_WORKSPACE_ANCHOR_RESOURCE_ID_V1,
  noWorkspaceAnchorConfigurationDigestV1,
  noWorkspaceIntentDigestV1,
  projectWorkResourceAdmissionDigestV1,
  projectWorkResourceDeclarationDigestV1,
  type ProjectWorkResourceDeclarationV1,
} from "../src/contracts/v1";
import {
  PARALLEL_NARROW_WRITE_POLICY_ACTION_V1,
  PROJECT_WORK_ADMISSION_POLICY_ACTION_V1,
  ProjectWorkAdmissionServiceV1,
  findResourceConflictsV1,
  narrowWriteResourcesV1,
  scopesOverlapV1,
  type EnforcedWorkspaceIdentityV1,
  type EnforcedWorkspacePortV1,
  type ParallelWriteLineageV1,
} from "../src/project-coordination/v1";

const base = Date.parse("2026-09-14T00:00:00.000Z");
const at = (offset = 0) => new Date(base + offset).toISOString();
const hex = (character: string) => `sha256:${character.repeat(64)}`;
const repositoryDigest = sha256Digest({ resource: "repository:main" });
const otherRepositoryDigest = sha256Digest({ resource: "repository:docs" });
const logicalDigest = sha256Digest({ resource: "logical:news-source" });
const secondLogicalDigest = sha256Digest({ resource: "logical:calendar" });

type FixtureQueryV1 = (statement: string, params?: unknown[]) => Promise<unknown>;

const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: "tenant:test", version: 0,
  createdAt: at(-60_000), updatedAt: at(-60_000) } as const;

/** Applies every migration in order. Shared by the PGlite suite and the PostgreSQL gate. */
async function applyMigrationsV1(exec: (statement: string) => Promise<unknown>) {
  for (const name of (await readdir("db/migrations")).filter((file) => file.endsWith(".sql")).sort()) {
    await exec(await readFile(`db/migrations/${name}`, "utf8"));
  }
}

/**
 * Disposable tenant, project, owner, identities and immutable work resources.
 * Both the in-memory suite and the independent-connection gate seed exactly this
 * data, so the gate exercises the same canonical path rather than a private one.
 */
async function seedCoordinationDataV1(query: FixtureQueryV1, db: DatabaseClient) {
  await query("INSERT INTO tenants(id,display_name) VALUES('tenant:test','Tenant')");
  await query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','W')");
  await query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,project_types,supported_read_operations,
     supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES('adapter:test','tenant:test','coordination','v1','control_room_native','fixture','[]','[]','[]','v1',1)`);
  await query(`INSERT INTO projects
    (id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
     health,authority_mode,observed_at,payload)
    VALUES('project:test','tenant:test','workspace:test','adapter:test','project:test','1','Project','ready',
     'ready','healthy','control_room_native',$1,'{}')`, [at()]);
  await query(`INSERT INTO control_manual_project_heads
    (tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES('tenant:test','project:test','active',1,$1,$1)`, [at()]);
  await new SecurityStore(db).bootstrapOwner({ tenantId: "tenant:test", provider: "https://access.invalid",
    subject: "owner", identityId: "identity:owner", grantId: "grant:owner", displayName: "Owner",
    verifiedAt: at(-60_000), expiresAt: at(3_600_000), now: at() });
  for (const [id, kind, digest] of [
    ["resource:repository:main", "repository", repositoryDigest],
    ["resource:repository:docs", "repository", otherRepositoryDigest],
    ["resource:logical:news-source", "logical", logicalDigest],
    ["resource:logical:calendar", "logical", secondLogicalDigest],
    [NO_WORKSPACE_ANCHOR_RESOURCE_ID_V1, "logical", noWorkspaceAnchorConfigurationDigestV1("tenant:test")],
  ] as const) {
    await query(`INSERT INTO control_work_resources
      (tenant_id,id,kind,canonical_key,comparison_key,configuration_digest,payload,created_at)
      VALUES('tenant:test',$1,$2,$3,lower($3),$4,'{}',$5)`, [id, kind, id, digest, at()]);
  }
  await query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:coordinator','tenant:test','agent','Coordinator','internal',$1,'active',$2,$2)`,
  [sha256Digest({ id: "identity:coordinator" }), at()]);
}

/** One enrolled active node, through the ordinary canonical transitions. */
async function enrollNodeV1(canonical: CanonicalStore) {
  const node: NodeRecord = { ...common, kind: "node", id: "node:test", displayName: "Node",
    state: "pending_enrollment", platform: "linux", architecture: "x64", identityKeyId: "key:test",
    hardwareFingerprint: hex("a"), softwareFingerprint: hex("b"), policyVersion: "1.0.0",
    minimumProtocolVersion: "1.0.0" };
  await canonical.create(node);
  await canonical.transition({ tenantId: "tenant:test", kind: "node", entityId: node.id, expectedVersion: 0,
    toState: "active", transitionId: "transition:node", idempotencyKey: "admission-node-active",
    actor: { actorId: "identity:owner", actorType: "human" }, occurredAt: at(), recordPatch: { enrolledAt: at() } });
}

/** One leased worker, exactly as the ordinary claim path produces. */
async function createLeasedWorkerV1(canonical: CanonicalStore, suffix: string) {
  const request: RequestRecord = { ...common, kind: "request", id: `request:${suffix}`,
    projectId: "project:test", title: "Work", objective: "Do bounded work", state: "draft", priority: 50,
    requestedBy: { actorId: "identity:owner", actorType: "human" },
    idempotencyKey: `admission-request-${suffix}` };
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
    idempotencyKey: `admission-ready-${suffix}`, actor, occurredAt: at() });
  await canonical.claimReadyJob({ tenantId: "tenant:test", jobId: job.id,
    expectedJobVersion: ready.entity.version, nodeId: "node:test", attemptId: `attempt:${suffix}`,
    leaseId: `lease:${suffix}`, transitionId: `transition:claim:${suffix}`,
    idempotencyKey: `admission-claim-${suffix}`, actor, acquiredAt: at(), expiresAt: at(300_000) });
  return { jobId: job.id, attemptId: `attempt:${suffix}`, leaseId: `lease:${suffix}`,
    admissionId: `admission:${suffix}` };
}

/** Disposable in-memory acceptance data, matching the PGlite pattern used elsewhere in this suite. */
async function fixture() {
  const raw = new PGlite();
  await applyMigrationsV1((statement) => raw.exec(statement));
  const db = adaptPglite(raw);
  await seedCoordinationDataV1((statement, params) => raw.query(statement, params as never[]), db);

  /**
   * The stored owner policy is the only thing that can permit parallel narrow
   * repository writing. Tests that need one insert it here; a request naming a
   * policy that was never inserted establishes nothing.
   */
  async function insertParallelWritePolicy(options: {
    id?: string; actions?: string[]; resourceIds?: string[]; state?: string; validUntil?: string;
    projectId?: string; ownerIdentityId?: string; coordinatorVersion?: number } = {}) {
    const id = options.id ?? "policy:disjoint";
    await raw.query(`INSERT INTO control_project_delegation_policies
      (tenant_id,id,project_id,coordinator_identity_id,coordinator_version,state,version,policy_digest,
       owner_identity_id,owner_identity_digest,allowed_actions,eligible_routes,risk_ceiling,effect_ceiling,
       max_total_tasks,max_total_cost_microusd,max_concurrent_tasks,valid_from,valid_until,payload,
       created_at,updated_at)
      VALUES('tenant:test',$1,$2,'identity:coordinator',$3,$4,1,$5,$6,$5,$7::jsonb,'[]','low','none',
       8,1000000,8,$8,$9,$10::jsonb,$8,$8)`,
    [id, options.projectId ?? "project:test", options.coordinatorVersion ?? 1, options.state ?? "active",
      hex("c"), options.ownerIdentityId ?? "identity:owner",
      JSON.stringify(options.actions ?? [PARALLEL_NARROW_WRITE_POLICY_ACTION_V1]), at(),
      options.validUntil ?? at(3_600_000),
      JSON.stringify({ parallelNarrowWriteResourceIds: options.resourceIds
        ?? ["resource:repository:main", "resource:repository:docs"] })]);
    return id;
  }

  /**
   * The trusted workspace/lease boundary. It answers for an exact lineage and
   * knows nothing about the request body, so a caller cannot name its own
   * workspace.
   */
  const enforced = new Map<string, EnforcedWorkspaceIdentityV1>();
  const workspacePort: EnforcedWorkspacePortV1 = {
    currentEnforcedWorkspace: (lineage: ParallelWriteLineageV1) => enforced.get(lineage.attemptId),
  };
  function enforceWorkspace(attemptId: string, workspaceId: string, workspaceIntent: string) {
    enforced.set(attemptId, { enforcedWorkspaceId: workspaceId,
      workspaceIntentDigest: sha256Digest({ workspaceIntent }) });
  }

  const canonical = new CanonicalStore(db);
  const admissions = new ProjectWorkAdmissionServiceV1(canonical, undefined, workspacePort);
  /** An engine composed without the trusted workspace boundary at all. */
  const unboundedAdmissions = new ProjectWorkAdmissionServiceV1(canonical);
  await enrollNodeV1(canonical);
  const worker = (suffix: string) => createLeasedWorkerV1(canonical, suffix);

  return { raw, db, canonical, admissions, unboundedAdmissions, worker, enforceWorkspace,
    insertParallelWritePolicy, close: () => raw.close() };
}

type Worker = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["worker"]>>;

function repositoryDeclaration(worker: Worker, scopes: Array<{ accessMode: "read" | "write";
  scopeKind: "file" | "tree"; path: string; resourceId?: string; configurationDigest?: string }>,
workspaceIntent = "workspace:shared"): ProjectWorkResourceDeclarationV1 {
  return { schema: "control-room.project-work-resource-declaration/v1", tenantId: "tenant:test",
    projectId: "project:test", jobId: worker.jobId,
    workspace: { kind: "repository", resourceId: "resource:repository:main",
      resourceConfigurationDigest: repositoryDigest, baseRevision: "0123456789abcdef",
      workspaceIntentDigest: sha256Digest({ workspaceIntent }) },
    scopes: scopes.map((scope) => ({ resourceId: scope.resourceId ?? "resource:repository:main",
      resourceKind: "repository" as const,
      resourceConfigurationDigest: scope.configurationDigest ?? repositoryDigest,
      accessMode: scope.accessMode, scopeKind: scope.scopeKind, path: scope.path })) };
}

function logicalDeclaration(worker: Worker, resourceId: string, configurationDigest: string,
  accessMode: "read" | "write"): ProjectWorkResourceDeclarationV1 {
  const lineage = { tenantId: "tenant:test", projectId: "project:test", jobId: worker.jobId };
  return { schema: "control-room.project-work-resource-declaration/v1", ...lineage,
    workspace: { kind: "none", anchorResourceId: NO_WORKSPACE_ANCHOR_RESOURCE_ID_V1,
      anchorConfigurationDigest: noWorkspaceAnchorConfigurationDigestV1("tenant:test"),
      baseRevision: "no-workspace:v1", workspaceIntentDigest: noWorkspaceIntentDigestV1(lineage) },
    scopes: [{ resourceId, resourceKind: "logical", resourceConfigurationDigest: configurationDigest,
      accessMode, scopeKind: "logical", path: "" }] };
}

function admissionRequest(worker: Worker, declaration: unknown, overrides: {
  routeKind?: "manual" | "scheduled" | "news_collection"; parallel?: boolean; policyId?: string;
  leaseId?: string; attemptId?: string; jobId?: string; acquiredAt?: string } = {}) {
  return { schema: "control-room.project-work-admission-request/v1" as const,
    routeKind: overrides.routeKind ?? "manual", tenantId: "tenant:test", projectId: "project:test",
    jobId: overrides.jobId ?? worker.jobId, attemptId: overrides.attemptId ?? worker.attemptId,
    leaseId: overrides.leaseId ?? worker.leaseId, nodeId: "node:test",
    admissionId: worker.admissionId,
    authority: { kind: "owner" as const, ownerIdentityId: "identity:owner" },
    declaration,
    // A request may only ask; it cannot assert the permission or state its own
    // workspace.
    disjointWriters: overrides.parallel
      ? { requested: true, policyId: overrides.policyId ?? "policy:disjoint" }
      : { requested: false },
    acquiredAt: overrides.acquiredAt ?? at(1_000) };
}

test("two readers share a resource and an overlapping writer refuses", async () => {
  const f = await fixture();
  try {
    const first = await f.worker("reader-one");
    await f.admissions.admit(admissionRequest(first,
      repositoryDeclaration(first, [{ accessMode: "read", scopeKind: "tree", path: "src" }])));
    const second = await f.worker("reader-two");
    const shared = await f.admissions.admit(admissionRequest(second,
      repositoryDeclaration(second, [{ accessMode: "read", scopeKind: "tree", path: "src" }],
        "workspace:second")));
    assert.equal(shared.replayed, false);
    const held = await f.raw.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM control_attempt_resource_admissions WHERE state='held'");
    assert.equal(held.rows[0]?.count, "2");

    // A whole-repository writer meets both readers and refuses.
    const writer = await f.worker("writer-one");
    await assert.rejects(f.admissions.admit(admissionRequest(writer,
      repositoryDeclaration(writer, [{ accessMode: "write", scopeKind: "tree", path: "" }], "workspace:third"))),
    /resource_conflict/);
    // A reader of a file inside a held read tree is still fine.
    const third = await f.worker("reader-three");
    assert.equal((await f.admissions.admit(admissionRequest(third,
      repositoryDeclaration(third, [{ accessMode: "read", scopeKind: "file", path: "src/index.ts" }],
        "workspace:fourth")))).replayed, false);
  } finally { await f.close(); }
});

test("a writer conflicts with an overlapping reader and with another writer", async () => {
  const f = await fixture();
  try {
    const writer = await f.worker("w1");
    await f.admissions.admit(admissionRequest(writer,
      repositoryDeclaration(writer, [{ accessMode: "write", scopeKind: "tree", path: "" }])));
    const reader = await f.worker("r1");
    await assert.rejects(f.admissions.admit(admissionRequest(reader,
      repositoryDeclaration(reader, [{ accessMode: "read", scopeKind: "file", path: "src/index.ts" }],
        "workspace:other"))), /resource_conflict/);
    const second = await f.worker("w2");
    await assert.rejects(f.admissions.admit(admissionRequest(second,
      repositoryDeclaration(second, [{ accessMode: "write", scopeKind: "tree", path: "" }],
        "workspace:other"))), /resource_conflict/);
    // Work on a different repository is unaffected.
    const elsewhere = await f.worker("w3");
    assert.equal((await f.admissions.admit(admissionRequest(elsewhere, {
      schema: "control-room.project-work-resource-declaration/v1", tenantId: "tenant:test",
      projectId: "project:test", jobId: elsewhere.jobId,
      workspace: { kind: "repository", resourceId: "resource:repository:docs",
        resourceConfigurationDigest: otherRepositoryDigest, baseRevision: "abc",
        workspaceIntentDigest: sha256Digest({ workspaceIntent: "workspace:docs" }) },
      scopes: [{ resourceId: "resource:repository:docs", resourceKind: "repository",
        resourceConfigurationDigest: otherRepositoryDigest, accessMode: "write", scopeKind: "tree",
        path: "" }] }))).replayed, false);
  } finally { await f.close(); }
});

test("disjoint writers need an owner policy and distinct enforced workspaces", async () => {
  const f = await fixture();
  try {
    await f.insertParallelWritePolicy();
    const first = await f.worker("d1");
    // Without asking at all, a narrow repository writer must take the whole
    // repository instead of quietly running beside another writer.
    await assert.rejects(f.admissions.admit(admissionRequest(first,
      repositoryDeclaration(first, [{ accessMode: "write", scopeKind: "tree", path: "src/alpha" }]))),
    /resource_disjoint_write_not_permitted/);
    f.enforceWorkspace(first.attemptId, "workspace:alpha", "workspace:alpha");
    await f.admissions.admit(admissionRequest(first,
      repositoryDeclaration(first, [{ accessMode: "write", scopeKind: "tree", path: "src/alpha" }],
        "workspace:alpha"), { parallel: true }));

    const second = await f.worker("d2");
    f.enforceWorkspace(second.attemptId, "workspace:beta", "workspace:beta");
    assert.equal((await f.admissions.admit(admissionRequest(second,
      repositoryDeclaration(second, [{ accessMode: "write", scopeKind: "tree", path: "src/beta" }],
        "workspace:beta"), { parallel: true }))).replayed, false);

    // The same enforced workspace is not a separate workspace: here the trusted
    // boundary itself reports that this attempt runs in the first writer's
    // workspace, and admission refuses.
    const third = await f.worker("d3");
    f.enforceWorkspace(third.attemptId, "workspace:alpha", "workspace:gamma");
    await assert.rejects(f.admissions.admit(admissionRequest(third,
      repositoryDeclaration(third, [{ accessMode: "write", scopeKind: "tree", path: "src/gamma" }],
        "workspace:gamma"), { parallel: true })), /resource_workspace_not_distinct/);
    // Nor is a disjoint declaration a licence to overlap.
    const fourth = await f.worker("d4");
    f.enforceWorkspace(fourth.attemptId, "workspace:delta", "workspace:delta");
    await assert.rejects(f.admissions.admit(admissionRequest(fourth,
      repositoryDeclaration(fourth, [{ accessMode: "write", scopeKind: "file", path: "src/alpha/one.ts" }],
        "workspace:delta"), { parallel: true })), /resource_conflict/);
  } finally { await f.close(); }
});

test("narrow-write permission comes from the stored owner policy, never from the request", async () => {
  const f = await fixture();
  try {
    const worker = await f.worker("p1");
    f.enforceWorkspace(worker.attemptId, "workspace:p1", "workspace:p1");
    const narrow = () => repositoryDeclaration(worker,
      [{ accessMode: "write", scopeKind: "tree", path: "src/alpha" }], "workspace:p1");

    // A policy ID that names no row at all establishes nothing.
    await assert.rejects(f.admissions.admit(admissionRequest(worker, narrow(),
      { parallel: true, policyId: "policy:does-not-exist" })), /resource_disjoint_write_not_permitted/);

    // A real policy that does not allow this action is not permission either.
    await f.insertParallelWritePolicy({ id: "policy:other-action", actions: ["proposal.adopt"],
      coordinatorVersion: 2 });
    await assert.rejects(f.admissions.admit(admissionRequest(worker, narrow(),
      { parallel: true, policyId: "policy:other-action" })), /resource_disjoint_write_not_permitted/);

    // Nor is a policy that permits narrow writing on some other repository.
    await f.insertParallelWritePolicy({ id: "policy:other-resource",
      resourceIds: ["resource:repository:docs"], coordinatorVersion: 3 });
    await assert.rejects(f.admissions.admit(admissionRequest(worker, narrow(),
      { parallel: true, policyId: "policy:other-resource" })), /resource_disjoint_write_not_permitted/);

    // Nor a paused, revoked or expired one.
    await f.insertParallelWritePolicy({ id: "policy:paused", state: "paused", coordinatorVersion: 4 });
    await assert.rejects(f.admissions.admit(admissionRequest(worker, narrow(),
      { parallel: true, policyId: "policy:paused" })), /policy_inactive/);
    await f.insertParallelWritePolicy({ id: "policy:revoked", state: "revoked", coordinatorVersion: 5 });
    await assert.rejects(f.admissions.admit(admissionRequest(worker, narrow(),
      { parallel: true, policyId: "policy:revoked" })), /policy_revoked/);
    await f.insertParallelWritePolicy({ id: "policy:expired", validUntil: at(500), coordinatorVersion: 6 });
    await assert.rejects(f.admissions.admit(admissionRequest(worker, narrow(),
      { parallel: true, policyId: "policy:expired" })), /policy_expired/);

    // Nor one that belongs to a different owner.
    await f.raw.query(`INSERT INTO control_identities
      (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES('identity:other-owner','tenant:test','human','Other','internal',$1,'active',$2,$2)`,
    [sha256Digest({ id: "identity:other-owner" }), at()]);
    await f.insertParallelWritePolicy({ id: "policy:other-owner",
      ownerIdentityId: "identity:other-owner", coordinatorVersion: 7 });
    await assert.rejects(f.admissions.admit(admissionRequest(worker, narrow(),
      { parallel: true, policyId: "policy:other-owner" })), /resource_disjoint_write_not_permitted/);

    // Nothing above created a holder.
    const none = await f.raw.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM control_attempt_resource_admissions");
    assert.equal(none.rows[0]?.count, "0");

    // The exact stored policy does permit it.
    await f.insertParallelWritePolicy({ id: "policy:real", coordinatorVersion: 8 });
    assert.equal((await f.admissions.admit(admissionRequest(worker, narrow(),
      { parallel: true, policyId: "policy:real" }))).replayed, false);
    const stored = await f.raw.query<{ workspace: string; policy: string }>(
      `SELECT payload->>'enforcedWorkspaceId' AS workspace, payload->>'parallelWritePolicyId' AS policy
       FROM control_attempt_resource_admissions WHERE id=$1`, [worker.admissionId]);
    assert.deepEqual(stored.rows[0], { workspace: "workspace:p1", policy: "policy:real" });
  } finally { await f.close(); }
});

test("workspace identity comes from the trusted boundary, never from a request string", async () => {
  const f = await fixture();
  try {
    await f.insertParallelWritePolicy();
    const worker = await f.worker("w-boundary");
    const narrow = (intent: string) => repositoryDeclaration(worker,
      [{ accessMode: "write", scopeKind: "tree", path: "src/alpha" }], intent);

    // The boundary knows nothing about this lineage: there is no enforced
    // workspace, so there is no narrow write.
    await assert.rejects(f.admissions.admit(admissionRequest(worker, narrow("workspace:claimed"),
      { parallel: true })), /resource_workspace_unverified/);

    // An engine composed without the trusted boundary can never admit one.
    await assert.rejects(f.unboundedAdmissions.admit(admissionRequest(worker, narrow("workspace:claimed"),
      { parallel: true })), /resource_workspace_unverified/);

    // The boundary answers, but the declaration was built for a different
    // workspace than the harness actually enforces.
    f.enforceWorkspace(worker.attemptId, "workspace:real", "workspace:real");
    await assert.rejects(f.admissions.admit(admissionRequest(worker, narrow("workspace:claimed"),
      { parallel: true })), /resource_workspace_not_distinct/);

    // A hand-made authorization object is not an authorization.
    await assert.rejects(f.canonical.admitProjectWorkResourcesV1(
      admissionRequest(worker, narrow("workspace:real"), { parallel: true }),
      { lineage: { tenantId: "tenant:test", projectId: "project:test", jobId: worker.jobId,
        attemptId: worker.attemptId, leaseId: worker.leaseId, nodeId: "node:test",
        admissionId: worker.admissionId }, policyId: "policy:disjoint",
      workspace: { enforcedWorkspaceId: "workspace:real",
        workspaceIntentDigest: sha256Digest({ workspaceIntent: "workspace:real" }) } }),
    /resource_disjoint_write_not_permitted/);

    // With the boundary's own answer, the same declaration is admitted.
    assert.equal((await f.admissions.admit(admissionRequest(worker, narrow("workspace:real"),
      { parallel: true }))).replayed, false);
  } finally { await f.close(); }
});

test("admission requires the exact current lease, attempt and job lineage", async () => {
  const f = await fixture();
  try {
    // An expired lease cannot create a holder: nothing would ever produce the
    // process-retirement proof that releases it.
    const expired = await f.worker("l-expired");
    await assert.rejects(f.admissions.admit(admissionRequest(expired,
      repositoryDeclaration(expired, [{ accessMode: "write", scopeKind: "tree", path: "" }]),
      { acquiredAt: at(600_000) })), /resource_lease_expired/);

    // A released or revoked lease is not current either.
    for (const state of ["released", "revoked", "expired"] as const) {
      const worker = await f.worker(`l-state-${state}`);
      await f.raw.query(`UPDATE control_leases
        SET state=$1,payload=jsonb_set(payload,'{state}',to_jsonb($1::text))
        WHERE tenant_id='tenant:test' AND id=$2`, [state, worker.leaseId]);
      await assert.rejects(f.admissions.admit(admissionRequest(worker,
        repositoryDeclaration(worker, [{ accessMode: "write", scopeKind: "tree", path: "" }],
          `workspace:${state}`))), /resource_lease_not_current/, state);
    }

    // A terminal job refuses.
    const terminal = await f.worker("l-terminal");
    await f.raw.query(`UPDATE control_jobs
      SET state='succeeded',payload=jsonb_set(payload,'{state}','"succeeded"')
      WHERE tenant_id='tenant:test' AND id=$1`, [terminal.jobId]);
    await assert.rejects(f.admissions.admit(admissionRequest(terminal,
      repositoryDeclaration(terminal, [{ accessMode: "write", scopeKind: "tree", path: "" }],
        "workspace:terminal"))), /resource_job_not_current/);

    // A terminal attempt refuses even while its job is live.
    const finished = await f.worker("l-attempt");
    await f.raw.query(`UPDATE control_attempts
      SET state='failed',payload=jsonb_set(payload,'{state}','"failed"')
      WHERE tenant_id='tenant:test' AND id=$1`, [finished.attemptId]);
    await assert.rejects(f.admissions.admit(admissionRequest(finished,
      repositoryDeclaration(finished, [{ accessMode: "write", scopeKind: "tree", path: "" }],
        "workspace:attempt"))), /resource_attempt_not_current/);

    // Mismatched lineage: a lease that belongs to a different job/attempt.
    const owner = await f.worker("l-owner");
    const borrower = await f.worker("l-borrower");
    await assert.rejects(f.admissions.admit(admissionRequest(borrower,
      repositoryDeclaration(borrower, [{ accessMode: "write", scopeKind: "tree", path: "" }],
        "workspace:borrow"), { leaseId: owner.leaseId })), /resource_lease_not_current/);
    await assert.rejects(f.admissions.admit(admissionRequest(borrower,
      repositoryDeclaration(borrower, [{ accessMode: "write", scopeKind: "tree", path: "" }],
        "workspace:borrow"), { attemptId: owner.attemptId })), /resource_lease_not_current/);

    // None of the refusals left a holder behind.
    const none = await f.raw.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM control_attempt_resource_admissions");
    assert.equal(none.rows[0]?.count, "0");

    // The exact current lineage is admitted.
    const declaration = repositoryDeclaration(owner,
      [{ accessMode: "write", scopeKind: "tree", path: "" }], "workspace:owner");
    assert.equal((await f.admissions.admit(admissionRequest(owner, declaration))).replayed, false);

    // Replay of an existing holder is deliberately unaffected by the lineage
    // moving on: a restarted server still sees its own held admission rather
    // than an error, and the holder is not released either way.
    await f.raw.query(`UPDATE control_jobs
      SET state='succeeded',payload=jsonb_set(payload,'{state}','"succeeded"')
      WHERE tenant_id='tenant:test' AND id=$1`, [owner.jobId]);
    await f.raw.query(`UPDATE control_leases
      SET state='expired',payload=jsonb_set(payload,'{state}','"expired"')
      WHERE tenant_id='tenant:test' AND id=$1`, [owner.leaseId]);
    assert.equal((await f.admissions.admit(admissionRequest(owner, declaration))).replayed, true);
  } finally { await f.close(); }
});

test("a missing declaration refuses and is never guessed read-only", async () => {
  const f = await fixture();
  try {
    const worker = await f.worker("m1");
    await assert.rejects(f.admissions.admit(admissionRequest(worker, undefined)),
      /resource_declaration_missing/);
    await assert.rejects(f.admissions.admit(admissionRequest(worker, null)),
      /resource_declaration_missing/);
    await assert.rejects(f.admissions.admit(admissionRequest(worker, { schema: "something-else" })),
      /resource_declaration_invalid/);
    const none = await f.raw.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM control_attempt_resource_admissions");
    assert.equal(none.rows[0]?.count, "0");
  } finally { await f.close(); }
});

test("case, aliases and traversal cannot evade the conflict check", async () => {
  const f = await fixture();
  try {
    await f.insertParallelWritePolicy();
    const holder = await f.worker("e1");
    f.enforceWorkspace(holder.attemptId, "workspace:holder", "workspace:holder");
    await f.admissions.admit(admissionRequest(holder,
      repositoryDeclaration(holder, [{ accessMode: "write", scopeKind: "tree", path: "src/Feature" }],
        "workspace:holder"), { parallel: true }));

    // A different spelling of the same path folds to the same comparison key.
    const evader = await f.worker("e2");
    f.enforceWorkspace(evader.attemptId, "workspace:evader", "workspace:evader");
    await assert.rejects(f.admissions.admit(admissionRequest(evader,
      repositoryDeclaration(evader, [{ accessMode: "write", scopeKind: "file", path: "SRC/feature/x.ts" }],
        "workspace:evader"), { parallel: true })), /resource_conflict/);

    // Traversal and absolute paths are not valid declarations at all.
    for (const path of ["../escape", "src/../../escape", "/etc/passwd", "src//double", "src\\windows"]) {
      await assert.rejects(f.admissions.admit(admissionRequest(evader,
        repositoryDeclaration(evader, [{ accessMode: "read", scopeKind: "file", path }], "workspace:evader"))),
      /resource_declaration_invalid/, path);
    }

    // A declaration naming a resource that is not in the immutable registry, or
    // naming a registered resource with the wrong configuration digest, refuses.
    await assert.rejects(f.admissions.admit(admissionRequest(evader, repositoryDeclaration(evader,
      [{ accessMode: "read", scopeKind: "tree", path: "", resourceId: "resource:repository:unknown" }],
      "workspace:evader"))), /resource_declaration_invalid/);
    await assert.rejects(f.admissions.admit(admissionRequest(evader, repositoryDeclaration(evader,
      [{ accessMode: "read", scopeKind: "tree", path: "", configurationDigest: hex("9") }],
      "workspace:evader"))), /resource_declaration_invalid/);

    // And the registry itself refuses a second spelling of an existing resource.
    await assert.rejects(f.raw.query(`INSERT INTO control_work_resources
      (tenant_id,id,kind,canonical_key,comparison_key,configuration_digest,payload,created_at)
      VALUES('tenant:test','resource:Repository:Main','repository','resource:Repository:Main',
       lower('resource:Repository:Main'),$1,'{}',$2)`, [repositoryDigest, at()]));
  } finally { await f.close(); }
});

test("unknown legacy work blocks new admission until it is reconciled", async () => {
  const f = await fixture();
  try {
    // A started attempt with no admission record may be holding anything. This
    // row is written directly: it stands for work that began before the engine
    // existed, which is exactly the case that must never be guessed.
    const legacy = await f.worker("legacy");
    const newcomer = await f.worker("new");
    await f.raw.query(`UPDATE control_attempts
      SET state='running',payload=jsonb_set(jsonb_set(payload,'{state}','"running"'),'{startedAt}',to_jsonb($1::text))
      WHERE tenant_id='tenant:test' AND id=$2`, [at(500), legacy.attemptId]);
    await assert.rejects(f.admissions.admit(admissionRequest(newcomer,
      logicalDeclaration(newcomer, "resource:logical:calendar", secondLogicalDigest, "read"))),
    /resource_legacy_work_unreconciled/);
    await assert.rejects(f.admissions.admit(admissionRequest(newcomer,
      repositoryDeclaration(newcomer, [{ accessMode: "write", scopeKind: "tree", path: "" }]))),
    /resource_legacy_work_unreconciled/);

    // The legacy attempt keeps running and completes through its existing path.
    assert.equal((await f.admissions.admit(admissionRequest(legacy,
      repositoryDeclaration(legacy, [{ accessMode: "write", scopeKind: "tree", path: "" }])))).replayed, false);
    // Once reconciled, ordinary admission resumes.
    assert.equal((await f.admissions.admit(admissionRequest(newcomer,
      logicalDeclaration(newcomer, "resource:logical:calendar", secondLogicalDigest, "read")))).replayed, false);
  } finally { await f.close(); }
});

test("manual, scheduled and news-collection routes share one operation and lock order", async () => {
  const f = await fixture();
  try {
    const kinds = ["manual", "scheduled", "news_collection"] as const;
    const resources: Array<[string, string]> = [
      ["resource:logical:news-source", logicalDigest],
      ["resource:logical:calendar", secondLogicalDigest],
      ["resource:repository:docs", otherRepositoryDigest],
    ];
    const workers: Worker[] = [];
    for (const [index, routeKind] of kinds.entries()) {
      const worker = await f.worker(`route-${routeKind}`);
      workers.push(worker);
      const [resourceId, digest] = resources[index]!;
      const declaration = resourceId.startsWith("resource:logical")
        ? logicalDeclaration(worker, resourceId, digest, "write")
        : { schema: "control-room.project-work-resource-declaration/v1" as const, tenantId: "tenant:test",
          projectId: "project:test", jobId: worker.jobId,
          workspace: { kind: "repository" as const, resourceId, resourceConfigurationDigest: digest,
            baseRevision: "abc", workspaceIntentDigest: sha256Digest({ routeKind }) },
          scopes: [{ resourceId, resourceKind: "repository" as const, resourceConfigurationDigest: digest,
            accessMode: "write" as const, scopeKind: "tree" as const, path: "" }] };
      const admitted = await f.admissions.admit(admissionRequest(worker, declaration, { routeKind }));
      assert.equal(admitted.replayed, false, routeKind);
    }
    const stored = await f.raw.query<{ route_kind: string }>(
      `SELECT payload->>'routeKind' AS route_kind FROM control_attempt_resource_admissions
       ORDER BY payload->>'routeKind'`);
    assert.deepEqual(stored.rows.map((row) => row.route_kind), ["manual", "news_collection", "scheduled"]);

    // The same operation enforces the same conflict across route kinds: a
    // news-collection writer cannot slip past a manual writer's logical resource.
    const crossing = await f.worker("route-crossing");
    await assert.rejects(f.admissions.admit(admissionRequest(crossing,
      logicalDeclaration(crossing, "resource:logical:news-source", logicalDigest, "write"),
      { routeKind: "news_collection" })), /resource_conflict/);
    await assert.rejects(f.admissions.admit(admissionRequest(crossing,
      logicalDeclaration(crossing, "resource:logical:news-source", logicalDigest, "read"),
      { routeKind: "scheduled" })), /resource_conflict/);
  } finally { await f.close(); }
});

test("the admission digest is immutable and a changed declaration fails the canonical recheck", async () => {
  const f = await fixture();
  try {
    const worker = await f.worker("digest");
    const declaration = repositoryDeclaration(worker,
      [{ accessMode: "write", scopeKind: "tree", path: "" }]);
    const admitted = await f.admissions.admit(admissionRequest(worker, declaration));
    assert.equal(admitted.declarationDigest, projectWorkResourceDeclarationDigestV1(declaration));
    assert.equal(admitted.admissionDigest, projectWorkResourceAdmissionDigestV1({
      schema: "control-room.project-work-resource-admission/v1", tenantId: "tenant:test",
      projectId: "project:test", jobId: worker.jobId, attemptId: worker.attemptId, leaseId: worker.leaseId,
      nodeId: "node:test", admissionId: worker.admissionId,
      declarationDigest: admitted.declarationDigest }));
    // One attempt cannot reuse another attempt's declaration digest as its own admission.
    assert.notEqual(admitted.admissionDigest, projectWorkResourceAdmissionDigestV1({
      schema: "control-room.project-work-resource-admission/v1", tenantId: "tenant:test",
      projectId: "project:test", jobId: worker.jobId, attemptId: "attempt:other", leaseId: worker.leaseId,
      nodeId: "node:test", admissionId: worker.admissionId,
      declarationDigest: admitted.declarationDigest }));

    const lineage = { tenantId: "tenant:test", projectId: "project:test", jobId: worker.jobId,
      attemptId: worker.attemptId, leaseId: worker.leaseId, nodeId: "node:test",
      admissionId: worker.admissionId };
    const rechecked = await f.admissions.recheck({ ...lineage, declaration });
    assert.deepEqual({ digest: rechecked.admissionDigest, state: rechecked.state },
      { digest: admitted.admissionDigest, state: "held" });

    await assert.rejects(f.admissions.recheck({ ...lineage, declaration: undefined }),
      /resource_declaration_missing/);
    await assert.rejects(f.admissions.recheck({ ...lineage, declaration: repositoryDeclaration(worker,
      [{ accessMode: "write", scopeKind: "tree", path: "src" }], "workspace:shared") }),
    /resource_declaration_changed/);
    await assert.rejects(f.admissions.recheck({ ...lineage, admissionId: "admission:absent", declaration }),
      /resource_admission_absent/);

    // Exact replay of the same admission returns the same immutable record.
    const replayed = await f.admissions.admit(admissionRequest(worker, declaration));
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.admissionDigest, admitted.admissionDigest);
    // A changed declaration under the same admission id conflicts.
    await assert.rejects(f.admissions.admit(admissionRequest(worker, repositoryDeclaration(worker,
      [{ accessMode: "write", scopeKind: "tree", path: "src" }], "workspace:shared"))),
    /resource_admission_replay_conflict/);
  } finally { await f.close(); }
});

test("a cited standing policy is authority only when it delegates work admission", async () => {
  const f = await fixture();
  try {
    const worker = await f.worker("policy-authority");
    // A real, live, current policy of this exact owner and project, which
    // delegates proposal adoption and nothing else.
    await f.insertParallelWritePolicy({ id: "policy:adopt-only", actions: ["proposal.adopt"] });
    const citedPolicy = { kind: "policy" as const, policyId: "policy:adopt-only",
      ownerIdentityId: "identity:owner" };

    // The widest holder this operation can create is a whole-repository writer;
    // a policy that never delegated admission may not produce one.
    const whole = repositoryDeclaration(worker, [{ accessMode: "write", scopeKind: "tree", path: "" }]);
    await assert.rejects(f.admissions.admit({ ...admissionRequest(worker, whole), authority: citedPolicy }),
      /policy_action_not_permitted/);
    // Nor the narrowest: a single logical reader is refused on the same ground.
    await assert.rejects(f.admissions.admit({ ...admissionRequest(worker,
      logicalDeclaration(worker, "resource:logical:calendar", secondLogicalDigest, "read")),
    authority: citedPolicy }), /policy_action_not_permitted/);
    // A policy that permits parallel narrow writing still does not permit
    // admission itself, so it cannot be the authority for one either.
    f.enforceWorkspace(worker.attemptId, "workspace:policy", "workspace:policy");
    await assert.rejects(f.admissions.admit({ ...admissionRequest(worker,
      repositoryDeclaration(worker, [{ accessMode: "write", scopeKind: "tree", path: "src/alpha" }],
        "workspace:policy"), { parallel: true, policyId: "policy:adopt-only" }),
    authority: citedPolicy }), /policy_action_not_permitted/);

    // A wildcard is not this action either: a delegation policy grants the exact
    // actions it lists and nothing broader.
    await f.insertParallelWritePolicy({ id: "policy:wildcard", actions: ["*"], coordinatorVersion: 8 });
    await assert.rejects(f.admissions.admit({ ...admissionRequest(worker, whole),
      authority: { ...citedPolicy, policyId: "policy:wildcard" } }), /policy_action_not_permitted/);

    // None of that created a holder.
    const none = await f.raw.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM control_attempt_resource_admissions");
    assert.equal(none.rows[0]?.count, "0");

    // Owner authority is unaffected, and a policy that does delegate this exact
    // action admits through the same operation.
    await f.insertParallelWritePolicy({ id: "policy:admits", coordinatorVersion: 2,
      actions: [PROJECT_WORK_ADMISSION_POLICY_ACTION_V1] });
    assert.equal((await f.admissions.admit({ ...admissionRequest(worker, whole),
      authority: { ...citedPolicy, policyId: "policy:admits" } })).replayed, false);
  } finally { await f.close(); }
});

test("an admission replay cannot switch node or any other stored lineage", async () => {
  const f = await fixture();
  try {
    const worker = await f.worker("lineage");
    const declaration = repositoryDeclaration(worker,
      [{ accessMode: "write", scopeKind: "tree", path: "" }]);
    const admitted = await f.admissions.admit(admissionRequest(worker, declaration));
    assert.equal(admitted.replayed, false);

    // The same admission, attempt, lease and declaration, presented for a
    // different node. The node is part of the immutable admission digest, so
    // answering this as a replay would hand back a digest that is not the one
    // persistence holds.
    const foreignDigest = projectWorkResourceAdmissionDigestV1({
      schema: "control-room.project-work-resource-admission/v1", tenantId: "tenant:test",
      projectId: "project:test", jobId: worker.jobId, attemptId: worker.attemptId,
      leaseId: worker.leaseId, nodeId: "node:absent", admissionId: worker.admissionId,
      declarationDigest: admitted.declarationDigest });
    assert.notEqual(foreignDigest, admitted.admissionDigest);
    for (const nodeId of ["node:absent", "node:second"]) {
      await assert.rejects(f.admissions.admit({ ...admissionRequest(worker, declaration), nodeId }),
        /resource_admission_replay_conflict/, nodeId);
    }
    // A replay that changes only the route kind is a changed request too.
    await assert.rejects(f.admissions.admit(admissionRequest(worker, declaration,
      { routeKind: "scheduled" })), /resource_admission_replay_conflict/);

    // The stored holder never moved and its version never advanced.
    const stored = await f.raw.query<{ node_id: string; digest: string; version: string;
      route_kind: string }>(
      `SELECT node_id,payload->>'admissionDigest' AS digest,version::text AS version,
         payload->>'routeKind' AS route_kind
       FROM control_attempt_resource_admissions WHERE tenant_id='tenant:test' AND id=$1`,
      [worker.admissionId]);
    assert.deepEqual(stored.rows, [{ node_id: "node:test", digest: admitted.admissionDigest,
      version: "1", route_kind: "manual" }]);

    // The exact stored lineage still replays, and the answer is the stored
    // record rather than anything re-derived from the request.
    const replayed = await f.admissions.admit(admissionRequest(worker, declaration));
    assert.deepEqual({ replayed: replayed.replayed, admissionDigest: replayed.admissionDigest,
      declarationDigest: replayed.declarationDigest,
      workspaceIntentDigest: replayed.workspaceIntentDigest, version: replayed.version },
    { replayed: true, admissionDigest: admitted.admissionDigest,
      declarationDigest: admitted.declarationDigest,
      workspaceIntentDigest: admitted.workspaceIntentDigest, version: 1 });
  } finally { await f.close(); }
});

test("scope overlap rules cover trees, files and logical resources", () => {
  assert.equal(scopesOverlapV1({ scopeKind: "tree", path: "" }, { scopeKind: "file", path: "a/b" }), true);
  assert.equal(scopesOverlapV1({ scopeKind: "tree", path: "src" }, { scopeKind: "tree", path: "src/a" }), true);
  assert.equal(scopesOverlapV1({ scopeKind: "tree", path: "src" }, { scopeKind: "tree", path: "srcx" }), false);
  assert.equal(scopesOverlapV1({ scopeKind: "file", path: "src/a" }, { scopeKind: "file", path: "src/b" }), false);
  assert.equal(scopesOverlapV1({ scopeKind: "logical", path: "" }, { scopeKind: "logical", path: "" }), true);
  assert.throws(() => scopesOverlapV1({ scopeKind: "file", path: "../x" }, { scopeKind: "file", path: "a" }),
    /resource_declaration_invalid/);
  assert.deepEqual(narrowWriteResourcesV1([
    { resourceId: "r1", resourceKind: "repository", resourceConfigurationDigest: hex("a"),
      accessMode: "write", scopeKind: "tree", path: "" },
    { resourceId: "r2", resourceKind: "repository", resourceConfigurationDigest: hex("a"),
      accessMode: "write", scopeKind: "tree", path: "src" },
  ]), ["r2"]);
  assert.equal(findResourceConflictsV1([{ resourceId: "r1", resourceKind: "logical",
    resourceConfigurationDigest: hex("a"), accessMode: "read", scopeKind: "logical", path: "" }],
  [{ admissionId: "a1", resourceId: "r1", accessMode: "read", scopeKind: "logical", path: "" }]).length, 0);
});

/**
 * Independent-connection PostgreSQL concurrency gate.
 *
 * PGlite runs one embedded engine, so the suite above proves the service
 * decisions, the exact SQL the transaction issues and the fixed lock order, but
 * it cannot demonstrate two independently supplied connections racing under real
 * MVCC. This gate does that: two separate `pg` pools taken from
 * `CONTROL_ROOM_TEST_PG_URL_A` and `CONTROL_ROOM_TEST_PG_URL_B` each build their
 * own `CanonicalStore`, and both call the real canonical admission operation -
 * `admitProjectWorkResourcesV1`, the same one every test above uses - for
 * overlapping write scopes on the same repository resource at the same time. No
 * row is inserted by hand: the parent request/workflow/job/attempt/lease rows are
 * created through the ordinary canonical path first, so the admissions have the
 * lineage the foreign keys require. Exactly one writer may hold the resource; the
 * other must lose on the contract's own terms (a resource conflict, a replay
 * conflict, or a serialization failure that PostgreSQL raised instead).
 *
 * It is skipped unless `CONTROL_ROOM_PG_CONCURRENCY_GATE=1` and both URLs are
 * supplied, because provisioning a database, connecting to an external service or
 * running this gate is NOT authorized by this contributor package, and it has NOT
 * been run. The separately authorized run is a parent acceptance gate after the
 * restricted database-role package (#63). Both URLs must point at the same
 * disposable database; the test drops and recreates the public schema. Command:
 *
 *   CONTROL_ROOM_PG_CONCURRENCY_GATE=1 \
 *   CONTROL_ROOM_TEST_PG_URL_A=postgres://... \
 *   CONTROL_ROOM_TEST_PG_URL_B=postgres://... \
 *   node --import tsx --test tests/project-resource-admission.test.ts
 */
const concurrencyGateEnabled = process.env.CONTROL_ROOM_PG_CONCURRENCY_GATE === "1"
  && !!process.env.CONTROL_ROOM_TEST_PG_URL_A && !!process.env.CONTROL_ROOM_TEST_PG_URL_B;

/** Minimal `DatabaseClient` over one `pg` pool. Each pool is an independent connection. */
function adaptPgPoolV1(pool: { connect(): Promise<{ query(statement: string, params?: unknown[]):
Promise<{ rows: unknown[] }>; release(): void }>; query(statement: string, params?: unknown[]):
Promise<{ rows: unknown[] }> }): DatabaseClient {
  const session = (client: { query(statement: string, params?: unknown[]):
  Promise<{ rows: unknown[] }> }): DatabaseSession => Object.freeze({
    query: <T = Record<string, unknown>>(statement: string, params: unknown[] = []) =>
      client.query(statement, params) as Promise<{ rows: T[] }>,
  });
  async function inTransaction<T>(callback: (tx: DatabaseSession) => Promise<T>,
    preCommitCheck?: () => void | Promise<void>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(session(client));
      if (preCommitCheck) await preCommitCheck();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return Object.freeze({
    query: <T = Record<string, unknown>>(statement: string, params: unknown[] = []) =>
      pool.query(statement, params) as Promise<{ rows: T[] }>,
    transaction: <T>(callback: (tx: DatabaseSession) => Promise<T>) => inTransaction(callback),
    transactionWithPreCommitCheck: <T>(callback: (tx: DatabaseSession) => Promise<T>,
      preCommitCheck: () => void | Promise<void>) => inTransaction(callback, preCommitCheck),
  }) as DatabaseClient;
}

test("two independent PostgreSQL connections cannot both admit a conflicting writer",
  { skip: concurrencyGateEnabled ? false : "requires separately authorized disposable PostgreSQL" },
  async () => {
    const { Pool } = await import("pg");
    const a = new Pool({ connectionString: process.env.CONTROL_ROOM_TEST_PG_URL_A, max: 2 });
    const b = new Pool({ connectionString: process.env.CONTROL_ROOM_TEST_PG_URL_B, max: 2 });
    try {
      const backends = await Promise.all([a, b].map(async (pool) =>
        (await pool.query<{ backend: string }>("SELECT pg_backend_pid()::text AS backend")).rows[0]!.backend));
      assert.notEqual(backends[0], backends[1], "the gate requires two independent connections");

      // Disposable schema, then the same seed data the in-memory suite uses.
      await a.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
      await applyMigrationsV1((statement) => a.query(statement));
      const first = adaptPgPoolV1(a);
      const second = adaptPgPoolV1(b);
      await seedCoordinationDataV1((statement, params) => a.query(statement, params as unknown[]), first);
      const storeA = new CanonicalStore(first);
      const storeB = new CanonicalStore(second);
      await enrollNodeV1(storeA);
      const workerA = await createLeasedWorkerV1(storeA, "gate-a");
      const workerB = await createLeasedWorkerV1(storeA, "gate-b");

      // Both connections invoke the real canonical admission operation for
      // overlapping root-tree write scopes on the same repository resource.
      const outcomes = await Promise.allSettled([
        storeA.admitProjectWorkResourcesV1(admissionRequest(workerA,
          repositoryDeclaration(workerA, [{ accessMode: "write", scopeKind: "tree", path: "" }],
            "workspace:gate-a"))),
        storeB.admitProjectWorkResourcesV1(admissionRequest(workerB,
          repositoryDeclaration(workerB, [{ accessMode: "write", scopeKind: "tree", path: "" }],
            "workspace:gate-b"))),
      ]);
      const admitted = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const refused = outcomes.filter((outcome) => outcome.status === "rejected");
      assert.equal(admitted.length, 1, "exactly one writer may hold the resource");
      assert.equal(refused.length, 1);
      assert.match(String((refused[0] as PromiseRejectedResult).reason),
        /resource_conflict|resource_admission_replay_conflict|could not serialize|deadlock detected/);

      // The durable state agrees: one held holder, written by the canonical path.
      const held = await a.query<{ count: string; admission_id: string }>(
        `SELECT count(*)::text AS count, min(id) AS admission_id
         FROM control_attempt_resource_admissions WHERE state='held'`);
      assert.equal(held.rows[0]?.count, "1");
      const scopes = await a.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM control_attempt_resource_scopes
         WHERE admission_id=$1`, [held.rows[0]!.admission_id]);
      assert.equal(scopes.rows[0]?.count, "1");
    } finally {
      await a.end();
      await b.end();
    }
  });
