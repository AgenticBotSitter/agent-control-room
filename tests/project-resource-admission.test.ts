import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { adaptPglite } from "../src/persistence/database";
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
  ProjectWorkAdmissionServiceV1,
  findResourceConflictsV1,
  narrowWriteResourcesV1,
  scopesOverlapV1,
} from "../src/project-coordination/v1";

const base = Date.parse("2026-09-14T00:00:00.000Z");
const at = (offset = 0) => new Date(base + offset).toISOString();
const hex = (character: string) => `sha256:${character.repeat(64)}`;
const repositoryDigest = sha256Digest({ resource: "repository:main" });
const otherRepositoryDigest = sha256Digest({ resource: "repository:docs" });
const logicalDigest = sha256Digest({ resource: "logical:news-source" });
const secondLogicalDigest = sha256Digest({ resource: "logical:calendar" });

/** Disposable in-memory acceptance data, matching the PGlite pattern used elsewhere in this suite. */
async function fixture() {
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

  for (const [id, kind, digest] of [
    ["resource:repository:main", "repository", repositoryDigest],
    ["resource:repository:docs", "repository", otherRepositoryDigest],
    ["resource:logical:news-source", "logical", logicalDigest],
    ["resource:logical:calendar", "logical", secondLogicalDigest],
    [NO_WORKSPACE_ANCHOR_RESOURCE_ID_V1, "logical", noWorkspaceAnchorConfigurationDigestV1("tenant:test")],
  ] as const) {
    await raw.query(`INSERT INTO control_work_resources
      (tenant_id,id,kind,canonical_key,comparison_key,configuration_digest,payload,created_at)
      VALUES('tenant:test',$1,$2,$3,lower($3),$4,'{}',$5)`, [id, kind, id, digest, at()]);
  }

  const canonical = new CanonicalStore(db);
  const admissions = new ProjectWorkAdmissionServiceV1(canonical);
  const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: "tenant:test", version: 0,
    createdAt: at(-60_000), updatedAt: at(-60_000) } as const;
  const node: NodeRecord = { ...common, kind: "node", id: "node:test", displayName: "Node",
    state: "pending_enrollment", platform: "linux", architecture: "x64", identityKeyId: "key:test",
    hardwareFingerprint: hex("a"), softwareFingerprint: hex("b"), policyVersion: "1.0.0",
    minimumProtocolVersion: "1.0.0" };
  await canonical.create(node);
  await canonical.transition({ tenantId: "tenant:test", kind: "node", entityId: node.id, expectedVersion: 0,
    toState: "active", transitionId: "transition:node", idempotencyKey: "admission-node-active",
    actor: { actorId: "identity:owner", actorType: "human" }, occurredAt: at(), recordPatch: { enrolledAt: at() } });

  /** One leased worker, exactly as the ordinary claim path produces. */
  async function worker(suffix: string) {
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

  return { raw, db, canonical, admissions, worker, close: () => raw.close() };
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
  routeKind?: "manual" | "scheduled" | "news_collection"; permitted?: boolean; workspaceId?: string;
  policyId?: string } = {}) {
  return { schema: "control-room.project-work-admission-request/v1" as const,
    routeKind: overrides.routeKind ?? "manual", tenantId: "tenant:test", projectId: "project:test",
    jobId: worker.jobId, attemptId: worker.attemptId, leaseId: worker.leaseId, nodeId: "node:test",
    admissionId: worker.admissionId,
    authority: { kind: "owner" as const, ownerIdentityId: "identity:owner" },
    declaration,
    disjointWriters: overrides.permitted
      ? { permitted: true, policyId: overrides.policyId ?? "policy:disjoint",
        enforcedWorkspaceId: overrides.workspaceId ?? "workspace:one" }
      : { permitted: false },
    acquiredAt: at(1_000) };
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
    const first = await f.worker("d1");
    // Without the owner policy, a narrow repository writer must take the whole
    // repository instead of quietly running beside another writer.
    await assert.rejects(f.admissions.admit(admissionRequest(first,
      repositoryDeclaration(first, [{ accessMode: "write", scopeKind: "tree", path: "src/alpha" }]))),
    /resource_disjoint_write_not_permitted/);
    await f.admissions.admit(admissionRequest(first,
      repositoryDeclaration(first, [{ accessMode: "write", scopeKind: "tree", path: "src/alpha" }],
        "workspace:alpha"), { permitted: true, workspaceId: "workspace:alpha" }));

    const second = await f.worker("d2");
    assert.equal((await f.admissions.admit(admissionRequest(second,
      repositoryDeclaration(second, [{ accessMode: "write", scopeKind: "tree", path: "src/beta" }],
        "workspace:beta"), { permitted: true, workspaceId: "workspace:beta" }))).replayed, false);

    // The same enforced workspace is not a separate workspace.
    const third = await f.worker("d3");
    await assert.rejects(f.admissions.admit(admissionRequest(third,
      repositoryDeclaration(third, [{ accessMode: "write", scopeKind: "tree", path: "src/gamma" }],
        "workspace:gamma"), { permitted: true, workspaceId: "workspace:alpha" })),
    /resource_workspace_not_distinct/);
    // Nor is a disjoint declaration a licence to overlap.
    const fourth = await f.worker("d4");
    await assert.rejects(f.admissions.admit(admissionRequest(fourth,
      repositoryDeclaration(fourth, [{ accessMode: "write", scopeKind: "file", path: "src/alpha/one.ts" }],
        "workspace:delta"), { permitted: true, workspaceId: "workspace:delta" })), /resource_conflict/);
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
    const holder = await f.worker("e1");
    await f.admissions.admit(admissionRequest(holder,
      repositoryDeclaration(holder, [{ accessMode: "write", scopeKind: "tree", path: "src/Feature" }],
        "workspace:holder"), { permitted: true, workspaceId: "workspace:holder" }));

    // A different spelling of the same path folds to the same comparison key.
    const evader = await f.worker("e2");
    await assert.rejects(f.admissions.admit(admissionRequest(evader,
      repositoryDeclaration(evader, [{ accessMode: "write", scopeKind: "file", path: "SRC/feature/x.ts" }],
        "workspace:evader"), { permitted: true, workspaceId: "workspace:evader" })), /resource_conflict/);

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
 * decisions, the SQL the transaction issues and the fixed lock order, but it
 * cannot demonstrate two independently supplied connections racing under real
 * MVCC. This test does that with two separate `pg` connections taken from
 * `CONTROL_ROOM_TEST_PG_URL_A` and `CONTROL_ROOM_TEST_PG_URL_B`: connection A
 * opens an admission transaction and holds its row locks, connection B races the
 * conflicting declaration, and exactly one of them commits.
 *
 * It is skipped unless `CONTROL_ROOM_PG_CONCURRENCY_GATE=1` and both URLs are
 * supplied, because provisioning a database, connecting to an external service or
 * running this gate is NOT authorized by this contributor package. The
 * separately authorized run is a parent acceptance gate after the restricted
 * database-role package (#63). Command:
 *
 *   CONTROL_ROOM_PG_CONCURRENCY_GATE=1 \
 *   CONTROL_ROOM_TEST_PG_URL_A=postgres://... \
 *   CONTROL_ROOM_TEST_PG_URL_B=postgres://... \
 *   node --import tsx --test tests/project-resource-admission.test.ts
 */
const concurrencyGateEnabled = process.env.CONTROL_ROOM_PG_CONCURRENCY_GATE === "1"
  && !!process.env.CONTROL_ROOM_TEST_PG_URL_A && !!process.env.CONTROL_ROOM_TEST_PG_URL_B;

test("two independent PostgreSQL connections cannot both admit a conflicting writer",
  { skip: concurrencyGateEnabled ? false : "requires separately authorized disposable PostgreSQL" },
  async () => {
    const { Pool } = await import("pg");
    const a = new Pool({ connectionString: process.env.CONTROL_ROOM_TEST_PG_URL_A, max: 1 });
    const b = new Pool({ connectionString: process.env.CONTROL_ROOM_TEST_PG_URL_B, max: 1 });
    try {
      for (const pool of [a, b]) {
        const probe = await pool.query<{ backend: string }>("SELECT pg_backend_pid()::text AS backend");
        assert.ok(probe.rows[0]?.backend);
      }
      const backends = await Promise.all([a, b].map(async (pool) =>
        (await pool.query<{ backend: string }>("SELECT pg_backend_pid()::text AS backend")).rows[0]!.backend));
      assert.notEqual(backends[0], backends[1], "the gate requires two independent connections");

      // Both connections run the same canonical admission operation against the
      // same repository resource; exactly one may hold the writer.
      const outcomes = await Promise.allSettled([a, b].map(async (pool, index) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", ["tenant:test"]);
          await client.query(`INSERT INTO control_attempt_resource_scopes
            (tenant_id,admission_id,resource_id,access_mode,scope_kind,path,path_fold)
            VALUES($1,$2,$3,'write','tree','','')`,
          ["tenant:test", `admission:gate-${index}`, "resource:repository:main"]);
          await client.query("COMMIT");
        } finally { client.release(); }
      }));
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    } finally {
      await a.end();
      await b.end();
    }
  });
