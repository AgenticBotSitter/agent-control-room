import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { adaptPglite } from "../src/persistence/database";
import { SecurityStore } from "../src/security/security-store";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { DOMAIN_CONTRACT_VERSION, type ArtifactManifestRecord, type JobRecord, type NodeRecord,
  type RequestRecord, type WorkflowRecord } from "../src/domain/v1";
import {
  projectCoordinatorExecutionBindingDigestV1,
  projectCoordinatorPlanningMarkerDigestV1,
  type ProjectCoordinatorExecutionBindingV1,
  type ProjectCoordinatorPlanningMarkerV1,
} from "../src/contracts/v1";
import {
  ProjectCoordinationAdoptionServiceV1,
  ProjectCoordinationProposalServiceV1,
  ProjectCoordinatorServiceV1,
  coordinationResultContentDigestV1,
  parseStrictJsonObjectV1,
  type CoordinationCostEvidenceV1,
  type CoordinationOperationRequestV1,
  type ProjectCoordinationProposalV1,
} from "../src/project-coordination/v1";

const base = Date.parse("2026-09-14T00:00:00.000Z");
const at = (offset = 0) => new Date(base + offset).toISOString();
const hex = (character: string) => `sha256:${character.repeat(64)}`;

/**
 * Disposable in-memory acceptance data. PGlite is the pattern the rest of this
 * suite already uses for canonical-store coverage; it proves the service
 * decisions and the exact transaction calls, and deliberately does not claim real
 * PostgreSQL serialization. The separately authorized independent-connection gate
 * lives in tests/project-resource-admission.test.ts.
 */
async function fixture() {
  const raw = new PGlite();
  for (const name of (await readdir("db/migrations")).filter((file) => file.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(`db/migrations/${name}`, "utf8"));
  }
  await raw.query("INSERT INTO tenants(id,display_name) VALUES('tenant:test','Coordination tenant')");
  await raw.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','Workspace')");
  await raw.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,project_types,supported_read_operations,
     supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES('adapter:test','tenant:test','coordination','v1','control_room_native','fixture','[]','[]','[]','v1',1)`);
  for (const projectId of ["project:test", "project:other"]) {
    await raw.query(`INSERT INTO projects
      (id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
       health,authority_mode,observed_at,payload)
      VALUES($1,'tenant:test','workspace:test','adapter:test',$1,'1','Project','ready','ready','healthy',
       'control_room_native',$2,'{}')`, [projectId, at()]);
    await raw.query(`INSERT INTO control_manual_project_heads
      (tenant_id,project_id,lifecycle,version,created_at,updated_at) VALUES('tenant:test',$1,'active',1,$2,$2)`,
    [projectId, at()]);
  }
  const db = adaptPglite(raw);
  await new SecurityStore(db).bootstrapOwner({ tenantId: "tenant:test", provider: "https://access.invalid",
    subject: "owner", identityId: "identity:owner", grantId: "grant:owner", displayName: "Owner",
    verifiedAt: at(-60_000), expiresAt: at(3_600_000), now: at() });
  for (const [id, kind] of [["identity:agent", "agent"], ["identity:agent-two", "agent"],
    ["identity:human-coordinator", "human"]] as const) {
    await raw.query(`INSERT INTO control_identities
      (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES($1,'tenant:test',$2,'Coordinator','internal',$3,'active',$4,$4)`,
    [id, kind, sha256Digest({ id }), at()]);
  }
  const canonical = new CanonicalStore(db);
  const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: "tenant:test", version: 0,
    createdAt: at(-60_000), updatedAt: at(-60_000) } as const;
  const node: NodeRecord = { ...common, kind: "node", id: "node:test", displayName: "Node",
    state: "pending_enrollment", platform: "linux", architecture: "x64", identityKeyId: "key:test",
    hardwareFingerprint: hex("a"), softwareFingerprint: hex("b"), policyVersion: "1.0.0",
    minimumProtocolVersion: "1.0.0" };
  await canonical.create(node);
  await canonical.transition({ tenantId: "tenant:test", kind: "node", entityId: node.id, expectedVersion: 0,
    toState: "active", transitionId: "transition:node", idempotencyKey: "coordination-node-active",
    actor: { actorId: "identity:owner", actorType: "human" }, occurredAt: at(), recordPatch: { enrolledAt: at() } });

  /** Creates one ordinary planning job with a leased attempt, as the harness would. */
  async function planningJob(suffix: string, projectId = "project:test") {
    const request: RequestRecord = { ...common, kind: "request", id: `request:plan:${suffix}`, projectId,
      title: "Plan", objective: "Produce a coordination plan", state: "draft", priority: 50,
      requestedBy: { actorId: "identity:owner", actorType: "human" },
      idempotencyKey: `coordination-plan-${suffix}` };
    const workflow: WorkflowRecord = { ...common, kind: "workflow", id: `workflow:plan:${suffix}`,
      requestId: request.id, projectId, definitionVersion: "1.0.0", definitionDigest: hex("c"),
      authorityMode: "control_room_native", state: "proposed", jobIds: [`job:plan:${suffix}`] };
    const authority: JobRecord["authority"] = { projectId, allowedExecutor: "executor:agent",
      allowedOperations: ["prepare.project-coordination"], credentialRefs: [], filesystemRoots: [],
      networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "none", maxRisk: "low",
      maxDurationSeconds: 3_600, maxConcurrentEffects: 0, expiresAt: at(3_600_000), digest: hex("0") };
    authority.digest = computeAuthorityDigest(authority);
    const job: JobRecord = { ...common, kind: "job", id: `job:plan:${suffix}`, workflowId: workflow.id, projectId,
      jobType: "coordination.planning", specVersion: "1.0.0", inputDigest: hex("d"), state: "proposed",
      priority: 50, requiredCapability: "agent.plan.project", dependsOnJobIds: [], authority,
      retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false,
        ambiguousEffectPolicy: "attention" } };
    await canonical.create(request); await canonical.create(workflow); await canonical.create(job);
    const actor = { actorId: "identity:owner", actorType: "human" as const };
    const ready = await canonical.transition({ tenantId: "tenant:test", kind: "job", entityId: job.id,
      expectedVersion: 0, toState: "ready", transitionId: `transition:ready:${suffix}`,
      idempotencyKey: `coordination-ready-${suffix}`, actor, occurredAt: at() });
    await canonical.claimReadyJob({ tenantId: "tenant:test", jobId: job.id,
      expectedJobVersion: ready.entity.version, nodeId: "node:test", attemptId: `attempt:plan:${suffix}`,
      leaseId: `lease:plan:${suffix}`, transitionId: `transition:claim:${suffix}`,
      idempotencyKey: `coordination-claim-${suffix}`, actor, acquiredAt: at(), expiresAt: at(300_000) });
    return { jobId: job.id, attemptId: `attempt:plan:${suffix}`, projectId };
  }

  /** Records the immutable retained-artifact receipt the result boundary would produce. */
  async function retainedArtifact(plan: { jobId: string; attemptId: string; projectId: string }, suffix: string) {
    const artifactId = `artifact:${suffix}`;
    const runId = `run:${suffix}`;
    const artifact: ArtifactManifestRecord = { ...common, kind: "artifact_manifest", id: artifactId,
      projectId: plan.projectId, jobId: plan.jobId, attemptId: plan.attemptId, state: "declared",
      contentHash: sha256Digest({ artifactId }), sizeBytes: 1, mimeType: "application/json",
      logicalRole: "coordination.proposal", schemaVersion: "1.0.0", producerId: "node:test",
      storageClass: "local", retentionClass: "standard" };
    await canonical.create(artifact);
    await raw.query(`INSERT INTO control_harness_runs
      (id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,native_session_key_digest,state,
       run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
      VALUES($1,'tenant:test',$2,$3,$4,'node:test','adapter:test','claude',$5,'succeeded',$6,$7,'{}',$8,$8,$8)`,
    [runId, plan.projectId, plan.jobId, plan.attemptId, sha256Digest({ runId }), hex("e"),
      `hmac-sha256:${"f".repeat(64)}`, at()]);
    const receipt = { runId, artifactId, retainedAt: at() };
    await raw.query(`INSERT INTO control_native_artifact_receipts
      (tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,receipt,auth_tag)
      VALUES('tenant:test',$1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [plan.projectId, plan.jobId, plan.attemptId, runId, artifactId, JSON.stringify(receipt),
      `hmac-sha256:${"1".repeat(64)}`]);
    return { runId, artifactId, receiptDigest: sha256Digest(receipt) };
  }

  return { raw, db, canonical, planningJob, retainedArtifact, close: () => raw.close() };
}

const agentBinding = (coordinatorIdentityId = "identity:agent"): ProjectCoordinatorExecutionBindingV1 => ({
  schema: "control-room.project-coordinator-execution-binding/v1", tenantId: "tenant:test",
  projectId: "project:test", coordinatorIdentityId, executorId: "executor:agent", adapterId: "adapter:test",
  connectorProfileDigest: hex("2"),
});

function marker(overrides: Partial<ProjectCoordinatorPlanningMarkerV1> & {
  planningJobId: string; attemptId: string; runId: string;
}): ProjectCoordinatorPlanningMarkerV1 {
  const binding = agentBinding(overrides.coordinatorIdentityId ?? "identity:agent");
  return {
    schema: "control-room.project-coordinator-planning-marker/v1", tenantId: "tenant:test",
    projectId: "project:test", planningJobDigest: hex("3"), planningInputDigest: hex("4"),
    nodeId: "node:test", coordinatorIdentityId: binding.coordinatorIdentityId, coordinatorVersion: 1,
    adapterId: binding.adapterId, connectorProfileDigest: binding.connectorProfileDigest,
    executionBindingDigest: projectCoordinatorExecutionBindingDigestV1(binding),
    executionRequestDigest: hex("5"), ownerIdentityId: "identity:owner", ownerRequestId: "request:owner",
    ownerRequestDigest: hex("6"), expectedProposalSchema: "control-room.project-coordination-proposal/v1",
    createdAt: at(), ...overrides,
  };
}

const proposalText = (projectId = "project:test", tasks = 2) => JSON.stringify({
  schema: "control-room.project-coordination-proposal/v1", projectId,
  tasks: Array.from({ length: tasks }, (_, index) => ({ localId: `task-${index + 1}`,
    title: `Task ${index + 1}`, instructions: "Do the bounded work", requiredCapability: "capability.build" })),
  edges: tasks > 1 ? [{ fromLocalId: "task-1", toLocalId: "task-2" }] : [],
});

function evidence(input: { marker: ProjectCoordinatorPlanningMarkerV1; artifactId: string;
  receiptDigest: string; resultText: string; contentHash?: string }) {
  return { schema: "control-room.verified-coordination-result-evidence/v1" as const,
    planningMarker: input.marker, executionBinding: agentBinding(input.marker.coordinatorIdentityId),
    artifactId: input.artifactId, artifactReceiptDigest: input.receiptDigest,
    contentHash: input.contentHash ?? coordinationResultContentDigestV1(input.resultText),
    resultText: input.resultText, observedAt: at(1_000) };
}

const appointment = (overrides: Record<string, unknown> = {}) => ({
  tenantId: "tenant:test", projectId: "project:test", ownerIdentityId: "identity:owner",
  coordinatorIdentityId: "identity:agent", coordinatorActorType: "agent" as const,
  executorId: "executor:agent", adapterId: "adapter:test", connectorProfileDigest: hex("2"),
  occurredAt: at(), ...overrides,
});

test("an owner appoints, replaces and revokes a coordinator without granting login authority", async () => {
  const f = await fixture();
  try {
    const coordinators = new ProjectCoordinatorServiceV1(f.canonical);
    assert.deepEqual(await coordinators.appoint(appointment()),
      { version: 1, state: "active", executionBindingDigest: projectCoordinatorExecutionBindingDigestV1(agentBinding()) });

    // The appointment creates no identity, session, role grant or policy decision
    // for the coordinator: it can propose and plan, never log in.
    for (const [table, column] of [["control_role_grants", "identity_id"],
      ["control_policy_decisions", "identity_id"]] as const) {
      const rows = await f.raw.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id='tenant:test' AND ${column}='identity:agent'`);
      assert.equal(rows.rows[0]?.count, "0", table);
    }

    const replaced = await coordinators.replace(appointment({ coordinatorIdentityId: "identity:agent-two" }));
    assert.equal(replaced.version, 2);
    const revoked = await coordinators.revoke(appointment({ coordinatorIdentityId: "identity:agent-two" }));
    assert.deepEqual(revoked, { version: 3, state: "revoked" });
    // A revoked row remains and its next assignment increments the same head version.
    assert.equal((await coordinators.appoint(appointment())).version, 4);
    const head = await f.raw.query<{ state: string; version: string; coordinator_identity_id: string }>(
      "SELECT state,version::text AS version,coordinator_identity_id FROM control_project_coordinator_heads");
    assert.deepEqual(head.rows, [{ state: "active", version: "4", coordinator_identity_id: "identity:agent" }]);

    // A human coordinator has no execution binding at all.
    await coordinators.appoint(appointment({ coordinatorIdentityId: "identity:human-coordinator",
      coordinatorActorType: "human", executorId: undefined, adapterId: undefined,
      connectorProfileDigest: undefined }));
    const human = await f.raw.query<{ execution_binding_digest: string | null }>(
      "SELECT execution_binding_digest FROM control_project_coordinator_heads");
    assert.equal(human.rows[0]?.execution_binding_digest, null);

    // The coordinator cannot appoint, replace or revoke itself.
    await assert.rejects(coordinators.appoint(appointment({ ownerIdentityId: "identity:agent" })),
      /owner_authority_missing/);
    await assert.rejects(coordinators.revoke(appointment({ ownerIdentityId: "identity:agent" })),
      /owner_authority_missing/);
    // An identity that is not the coordinator's own executor is required.
    await assert.rejects(coordinators.appoint(appointment({ executorId: "identity:agent" })), /invalid_input/);
  } finally { await f.close(); }
});

test("valid exact retained results become accepted proposals", async () => {
  const f = await fixture();
  try {
    await new ProjectCoordinatorServiceV1(f.canonical).appoint(appointment());
    const plan = await f.planningJob("one");
    const artifact = await f.retainedArtifact(plan, "one");
    const proposals = new ProjectCoordinationProposalServiceV1(f.canonical);
    const text = proposalText();
    const recorded = await proposals.ingestVerifiedResult({ proposalId: "proposal:one", ingestedAt: at(2_000),
      evidence: evidence({ marker: marker({ planningJobId: plan.jobId, attemptId: plan.attemptId,
        runId: artifact.runId }), artifactId: artifact.artifactId, receiptDigest: artifact.receiptDigest,
      resultText: text }) });
    assert.equal(recorded.validationState, "accepted");
    const row = await f.raw.query<{ proposal_schema: string; task_count: number; edge_count: number;
      proposal_digest: string; safe_reason_code: string | null }>(
      `SELECT proposal_schema,task_count,edge_count,proposal_digest,safe_reason_code
       FROM control_project_coordination_proposals WHERE id='proposal:one'`);
    assert.equal(row.rows[0]?.proposal_schema, "control-room.project-coordination-proposal/v1");
    assert.equal(row.rows[0]?.task_count, 2);
    assert.equal(row.rows[0]?.edge_count, 1);
    assert.equal(row.rows[0]?.safe_reason_code, null);

    // Exact re-ingestion of the same run is a replay, not a second proposal.
    const replay = await proposals.ingestVerifiedResult({ proposalId: "proposal:one", ingestedAt: at(3_000),
      evidence: evidence({ marker: marker({ planningJobId: plan.jobId, attemptId: plan.attemptId,
        runId: artifact.runId }), artifactId: artifact.artifactId, receiptDigest: artifact.receiptDigest,
      resultText: text }) });
    assert.equal(replay.replayed, true);
    const count = await f.raw.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM control_project_coordination_proposals");
    assert.equal(count.rows[0]?.count, "1");
  } finally { await f.close(); }
});

test("malformed, over-limit, mismatched and cross-project results are safely rejected", async () => {
  const f = await fixture();
  try {
    await new ProjectCoordinatorServiceV1(f.canonical).appoint(appointment());
    const plan = await f.planningJob("two");
    const proposals = new ProjectCoordinationProposalServiceV1(f.canonical);
    const secret = "sk_live_notarealsecretvalue0001";
    const cases: Array<[string, string, string]> = [
      ["fence", "```json\n" + proposalText() + "\n```", "content_not_one_json_object"],
      ["prose", `Here is the plan: ${proposalText()} Thanks!`, "content_not_one_json_object"],
      ["trailing", `${proposalText()}{}`, "content_not_one_json_object"],
      ["duplicate", `{"schema":"control-room.project-coordination-proposal/v1","projectId":"project:test",` +
        `"projectId":"project:other","tasks":[{"localId":"a","title":"T","instructions":"i",` +
        `"requiredCapability":"capability.build"}],"edges":[]}`, "content_duplicate_key"],
      ["oversize", JSON.stringify({ schema: "control-room.project-coordination-proposal/v1",
        projectId: "project:test", tasks: [{ localId: "a", title: "T", instructions: "x".repeat(70_000),
          requiredCapability: "capability.build" }], edges: [] }), "content_over_limit"],
      ["too-many-tasks", JSON.stringify({ schema: "control-room.project-coordination-proposal/v1",
        projectId: "project:test", tasks: Array.from({ length: 33 }, (_, index) => ({ localId: `t-${index}`,
          title: "T", instructions: "i", requiredCapability: "capability.build" })), edges: [] }),
      "proposal_limit_exceeded"],
      ["authority-field", JSON.stringify({ schema: "control-room.project-coordination-proposal/v1",
        projectId: "project:test", coordinatorIdentityId: "identity:agent-two",
        tasks: [{ localId: "a", title: "T", instructions: "i", requiredCapability: "capability.build" }],
        edges: [] }), "proposal_schema_mismatch"],
      ["credential-field", JSON.stringify({ schema: "control-room.project-coordination-proposal/v1",
        projectId: "project:test", tasks: [{ localId: "a", title: "T", instructions: `use ${secret}`,
          requiredCapability: "capability.build" }], edges: [] }), "proposal_unsafe_material"],
      ["cross-project", proposalText("project:other"), "proposal_cross_project"],
      ["wrong-schema", JSON.stringify({ schema: "control-room.other/v1" }), "proposal_schema_mismatch"],
    ];
    for (const [suffix, text, expected] of cases) {
      const artifact = await f.retainedArtifact(plan, `two-${suffix}`);
      const recorded = await proposals.ingestVerifiedResult({ proposalId: `proposal:two-${suffix}`,
        ingestedAt: at(2_000), evidence: evidence({ marker: marker({ planningJobId: plan.jobId,
          attemptId: plan.attemptId, runId: artifact.runId }), artifactId: artifact.artifactId,
        receiptDigest: artifact.receiptDigest, resultText: text }) });
      assert.equal(recorded.validationState, "rejected", suffix);
      assert.equal(recorded.safeReasonCode, expected, suffix);
    }
    // No rejection copied raw content, a credential or a fragment of either into
    // the durable row; only the bounded reason is stored.
    const rows = await f.raw.query<{ proposal: unknown; safe_reason_code: string }>(
      "SELECT proposal,safe_reason_code FROM control_project_coordination_proposals");
    assert.equal(rows.rows.length, cases.length);
    for (const row of rows.rows) {
      assert.equal(row.proposal, null);
      assert.ok(/^[a-z_]+$/.test(row.safe_reason_code));
    }
  } finally { await f.close(); }
});

test("stale, revoked and tampered evidence cannot attribute a proposal to a coordinator", async () => {
  const f = await fixture();
  try {
    const coordinators = new ProjectCoordinatorServiceV1(f.canonical);
    await coordinators.appoint(appointment());
    const plan = await f.planningJob("three");
    const proposals = new ProjectCoordinationProposalServiceV1(f.canonical);

    // Content that does not hash to the retained artifact's exact content digest.
    const tampered = await f.retainedArtifact(plan, "three-tampered");
    assert.equal((await proposals.ingestVerifiedResult({ proposalId: "proposal:tampered", ingestedAt: at(2_000),
      evidence: evidence({ marker: marker({ planningJobId: plan.jobId, attemptId: plan.attemptId,
        runId: tampered.runId }), artifactId: tampered.artifactId, receiptDigest: tampered.receiptDigest,
      resultText: proposalText(), contentHash: hex("7") }) })).safeReasonCode, "evidence_content_mismatch");

    // A marker that names a binding it does not match.
    const forged = await f.retainedArtifact(plan, "three-forged");
    assert.equal((await proposals.ingestVerifiedResult({ proposalId: "proposal:forged", ingestedAt: at(2_000),
      evidence: evidence({ marker: marker({ planningJobId: plan.jobId, attemptId: plan.attemptId,
        runId: forged.runId, executionBindingDigest: hex("8") }), artifactId: forged.artifactId,
      receiptDigest: forged.receiptDigest, resultText: proposalText() }) })).safeReasonCode,
    "evidence_binding_mismatch");

    // A stale coordinator version, and an artifact receipt that does not match.
    const stale = await f.retainedArtifact(plan, "three-stale");
    assert.equal((await proposals.ingestVerifiedResult({ proposalId: "proposal:stale", ingestedAt: at(2_000),
      evidence: evidence({ marker: marker({ planningJobId: plan.jobId, attemptId: plan.attemptId,
        runId: stale.runId, coordinatorVersion: 9 }), artifactId: stale.artifactId,
      receiptDigest: stale.receiptDigest, resultText: proposalText() }) })).safeReasonCode,
    "coordinator_not_current");
    const wrongReceipt = await f.retainedArtifact(plan, "three-receipt");
    assert.equal((await proposals.ingestVerifiedResult({ proposalId: "proposal:receipt", ingestedAt: at(2_000),
      evidence: evidence({ marker: marker({ planningJobId: plan.jobId, attemptId: plan.attemptId,
        runId: wrongReceipt.runId }), artifactId: wrongReceipt.artifactId, receiptDigest: hex("9"),
      resultText: proposalText() }) })).safeReasonCode, "artifact_receipt_mismatch");

    // A browser-supplied agent identity is not a field this port accepts at all.
    const injected = await f.retainedArtifact(plan, "three-injected");
    await assert.rejects(proposals.ingestVerifiedResult({ proposalId: "proposal:injected", ingestedAt: at(2_000),
      evidence: { ...evidence({ marker: marker({ planningJobId: plan.jobId, attemptId: plan.attemptId,
        runId: injected.runId }), artifactId: injected.artifactId, receiptDigest: injected.receiptDigest,
      resultText: proposalText() }), suppliedAgentIdentity: "identity:agent-two" } }),
    /proposal_evidence_mismatch/);

    // After revocation, results from the former coordinator stop being adoptable.
    await coordinators.revoke(appointment());
    const late = await f.retainedArtifact(plan, "three-late");
    assert.equal((await proposals.ingestVerifiedResult({ proposalId: "proposal:late", ingestedAt: at(4_000),
      evidence: evidence({ marker: marker({ planningJobId: plan.jobId, attemptId: plan.attemptId,
        runId: late.runId }), artifactId: late.artifactId, receiptDigest: late.receiptDigest,
      resultText: proposalText() }) })).safeReasonCode, "coordinator_revoked");
  } finally { await f.close(); }
});

test("the strict reader accepts exactly one JSON object", () => {
  assert.deepEqual(parseStrictJsonObjectV1('{"a":1,"b":{"c":[1,2]}}'), { a: 1, b: { c: [1, 2] } });
  assert.throws(() => parseStrictJsonObjectV1('{"a":1,"a":2}'), /proposal_duplicate_key/);
  assert.throws(() => parseStrictJsonObjectV1('{"a":{"b":1,"b":2}}'), /proposal_duplicate_key/);
  assert.throws(() => parseStrictJsonObjectV1('{"__proto__":{"polluted":true}}'), /proposal_content_invalid/);
  assert.throws(() => parseStrictJsonObjectV1("[1,2]"), /proposal_content_invalid/);
  assert.throws(() => parseStrictJsonObjectV1('{"a":1} trailing'), /proposal_content_invalid/);
  assert.throws(() => parseStrictJsonObjectV1('{"a":01}'), /proposal_content_invalid/);
  assert.throws(() => parseStrictJsonObjectV1('{"a":1,}'), /proposal_content_invalid/);
  assert.equal(Object.getPrototypeOf(parseStrictJsonObjectV1('{"a":1}')), Object.prototype);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

const routes = { resolveRoute: () => "executor:agent" };
const knownCost = (micro: number): { currentCost: () => CoordinationCostEvidenceV1 } => ({
  currentCost: () => ({ kind: "known", admittedCostMicroUsd: micro, evidenceDigest: hex("b") }) });
const unknownCost = { currentCost: (): CoordinationCostEvidenceV1 => ({ kind: "unknown" }) };

function operationRequest(overrides: Partial<CoordinationOperationRequestV1> = {}): CoordinationOperationRequestV1 {
  return { tenantId: "tenant:test", projectId: "project:test", proposalId: "proposal:one",
    idempotencyKey: "coordination-adopt-0001", operationId: "operation:one", requestId: "request:adopt:one",
    workflowId: "workflow:adopt:one", selectedLocalIds: ["task-1", "task-2"],
    approvedRouteIds: ["executor:agent"], authorization: { kind: "owner", ownerIdentityId: "identity:owner" },
    routeKind: "manual", occurredAt: at(5_000), authorityExpiresAt: at(3_600_000),
    ...overrides } as CoordinationOperationRequestV1;
}


/** Appoints one coordinator and records one accepted proposal per requested suffix. */
async function acceptedProposals(f: Awaited<ReturnType<typeof fixture>>, suffixes: string[]) {
  await new ProjectCoordinatorServiceV1(f.canonical).appoint(appointment());
  const proposals = new ProjectCoordinationProposalServiceV1(f.canonical);
  for (const suffix of suffixes) {
    const plan = await f.planningJob(suffix);
    const artifact = await f.retainedArtifact(plan, suffix);
    const recorded = await proposals.ingestVerifiedResult({ proposalId: `proposal:${suffix}`,
      ingestedAt: at(2_000), evidence: evidence({ marker: marker({ planningJobId: plan.jobId,
        attemptId: plan.attemptId, runId: artifact.runId }), artifactId: artifact.artifactId,
      receiptDigest: artifact.receiptDigest, resultText: proposalText() }) });
    assert.equal(recorded.validationState, "accepted", suffix);
  }
  return JSON.parse(proposalText()) as ProjectCoordinationProposalV1;
}

async function insertPolicy(f: Awaited<ReturnType<typeof fixture>>, overrides: {
  id?: string; maxTotalTasks?: number; maxCost?: number; maxConcurrent?: number; validUntil?: string;
  routes?: string[]; coordinatorVersion?: number } = {}) {
  const id = overrides.id ?? "policy:one";
  // Only one active or paused policy may exist per coordinator version, so each
  // scenario retires the previous one first.
  await f.raw.query(`UPDATE control_project_delegation_policies
    SET state='revoked',version=version+1,updated_at=$1
    WHERE tenant_id='tenant:test' AND state IN ('active','paused')`, [at(10_000)]);
  await f.raw.query(`INSERT INTO control_project_delegation_policies
    (tenant_id,id,project_id,coordinator_identity_id,coordinator_version,state,version,policy_digest,
     owner_identity_id,owner_identity_digest,allowed_actions,eligible_routes,risk_ceiling,effect_ceiling,
     max_total_tasks,max_total_cost_microusd,max_concurrent_tasks,valid_from,valid_until,payload,
     created_at,updated_at)
    VALUES('tenant:test',$1,'project:test','identity:agent',$2,'active',1,$3,'identity:owner',$3,
     '["proposal.adopt"]',$4::jsonb,'low','none',$5,$6,$7,$8,$9,'{}',$8,$8)`,
  [id, overrides.coordinatorVersion ?? 1, hex("c"),
    JSON.stringify(overrides.routes ?? ["executor:agent"]), overrides.maxTotalTasks ?? 8,
    overrides.maxCost ?? 1_000_000, overrides.maxConcurrent ?? 8, at(), overrides.validUntil ?? at(3_600_000)]);
  return id;
}

test("owner adoption and policy adoption create canonical work through the same operation", async () => {
  const f = await fixture();
  try {
    const proposal = await acceptedProposals(f, ["one", "two", "three"]);
    const policyId = await insertPolicy(f);
    const owner = new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, knownCost(1_000));

    const adopted = await owner.adopt({ request: operationRequest(), proposal });
    assert.equal(adopted.replayed, false);
    assert.equal(adopted.jobIds.length, 2);
    const jobs = await f.raw.query<{ state: string; id: string }>(
      "SELECT id,state FROM control_jobs WHERE id = ANY($1::text[]) ORDER BY id", [adopted.jobIds]);
    assert.deepEqual(jobs.rows.map((row) => row.state), ["proposed", "proposed"]);
    const edges = await f.raw.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM control_job_dependencies WHERE tenant_id='tenant:test'");
    assert.equal(edges.rows[0]?.count, "1");
    const attention = await f.raw.query<{ kind: string; state: string; reason_code: string }>(
      `SELECT kind,state,payload->>'reasonCode' AS reason_code FROM control_action_inbox
       WHERE tenant_id='tenant:test'`);
    assert.deepEqual(attention.rows, [{ kind: "review", state: "resolved",
      reason_code: "project_coordination_owner_adopted" }]);

    // Exact replay returns the original receipt and consumes nothing again.
    const replayed = await owner.adopt({ request: operationRequest(), proposal });
    assert.deepEqual({ receiptId: replayed.receiptId, receiptDigest: replayed.receiptDigest,
      replayed: replayed.replayed },
    { receiptId: adopted.receiptId, receiptDigest: adopted.receiptDigest, replayed: true });
    const receipts = await f.raw.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM control_project_coordination_operation_receipts");
    assert.equal(receipts.rows[0]?.count, "1");

    // Changed content under the same idempotency key conflicts instead of adopting again.
    await assert.rejects(owner.adopt({ request: operationRequest({ selectedLocalIds: ["task-1"] }), proposal }),
      /adoption_replay_conflict/);
    // A second adoption of the same proposal under a fresh key is refused outright.
    await assert.rejects(owner.adopt({ proposal, request: operationRequest({
      idempotencyKey: "coordination-adopt-again", operationId: "operation:again",
      requestId: "request:adopt:again", workflowId: "workflow:adopt:again" }) }), /proposal_already_adopted/);

    // Policy adoption reaches the same canonical operation and the same tables.
    const automatic = new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, knownCost(1_000));
    const policyAdopted = await automatic.adopt({ proposal, request: operationRequest({
      proposalId: "proposal:two", idempotencyKey: "coordination-adopt-0002", operationId: "operation:two",
      requestId: "request:adopt:two", workflowId: "workflow:adopt:two",
      authorization: { kind: "policy", policyId, ownerIdentityId: "identity:owner" }, routeKind: "scheduled" }) });
    assert.equal(policyAdopted.taskUnits, 2);

    // A partial selection that would drop half of a dependency edge refuses.
    await assert.rejects(automatic.adopt({ proposal, request: operationRequest({
      proposalId: "proposal:three", idempotencyKey: "coordination-adopt-half", operationId: "operation:half",
      requestId: "request:adopt:half", workflowId: "workflow:adopt:half", selectedLocalIds: ["task-2"] }) }),
    /invalid_input/);
    const stored = await f.raw.query<{ authorization_kind: string; policy_id: string | null;
      admitted_cost_microusd: string | null }>(
      `SELECT authorization_kind,policy_id,admitted_cost_microusd::text AS admitted_cost_microusd
       FROM control_project_coordination_operation_receipts ORDER BY id`);
    assert.deepEqual(stored.rows.map((row) => row.authorization_kind), ["owner", "policy"]);
    assert.equal(stored.rows[1]?.policy_id, policyId);
    assert.equal(stored.rows[1]?.admitted_cost_microusd, "2000");
    assert.equal(stored.rows[0]?.admitted_cost_microusd, "2000");

    // Nothing adopted is runnable: no attempt, lease or effect intent was created
    // for a destination job, and no proposal job carries execution authority.
    for (const table of ["control_attempts", "control_leases", "control_effect_intents"] as const) {
      const rows = await f.raw.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id='tenant:test' AND job_id = ANY($1::text[])`,
        [adopted.jobIds]);
      assert.equal(rows.rows[0]?.count, "0", table);
    }
    const authority = await f.raw.query<{ effect_policy: string; network_policy: string; cost: string }>(
      `SELECT payload->'authority'->>'effectPolicy' AS effect_policy,
         payload->'authority'->>'networkPolicy' AS network_policy,
         payload->'authority'->>'maxCostUsd' AS cost
       FROM control_jobs WHERE id = ANY($1::text[])`, [adopted.jobIds]);
    for (const row of authority.rows) {
      assert.deepEqual(row, { effect_policy: "none", network_policy: "none", cost: "0" });
    }
  } finally { await f.close(); }
});

test("policy expiry, revocation, exhaustion, unknown cost and route mismatch all fail closed", async () => {
  const f = await fixture();
  try {
    const proposal = await acceptedProposals(f, ["one", "two", "three", "four", "five"]);
    const coordinators = new ProjectCoordinatorServiceV1(f.canonical);
    const policyRequest = (policyId: string, overrides: Partial<CoordinationOperationRequestV1>) =>
      operationRequest({ ...overrides, authorization: { kind: "policy", policyId,
        ownerIdentityId: "identity:owner" } });

    // Unknown cost evidence can never satisfy a ceiling, even a zero ceiling.
    const zeroCeiling = await insertPolicy(f, { id: "policy:unknown-cost", maxCost: 0 });
    await assert.rejects(new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, unknownCost)
      .adopt({ proposal, request: policyRequest(zeroCeiling, {}) }), /policy_cost_unknown/);
    // The same operation with owner authority remains usable on an unpriced route.
    assert.equal((await new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, unknownCost)
      .adopt({ proposal, request: operationRequest() })).replayed, false);
    const unpriced = await f.raw.query<{ cost: string | null; evidence: string | null }>(
      `SELECT admitted_cost_microusd::text AS cost,cost_evidence_digest AS evidence
       FROM control_project_coordination_operation_receipts WHERE id='operation:one'`);
    assert.deepEqual(unpriced.rows, [{ cost: null, evidence: null }]);

    // Cost above the ceiling refuses.
    const tight = await insertPolicy(f, { id: "policy:tight-cost", maxCost: 500 });
    await assert.rejects(new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, knownCost(400))
      .adopt({ proposal, request: policyRequest(tight, { proposalId: "proposal:two",
        operationId: "operation:cost", idempotencyKey: "coordination-adopt-cost",
        requestId: "request:adopt:cost", workflowId: "workflow:adopt:cost" }) }),
    /policy_cost_allowance_exhausted/);

    // Task allowance.
    const oneTask = await insertPolicy(f, { id: "policy:one-task", maxTotalTasks: 1 });
    await assert.rejects(new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, knownCost(1))
      .adopt({ proposal, request: policyRequest(oneTask, { proposalId: "proposal:two",
        operationId: "operation:tasks", idempotencyKey: "coordination-adopt-task",
        requestId: "request:adopt:task", workflowId: "workflow:adopt:task" }) }),
    /policy_task_allowance_exhausted/);

    // Concurrency allowance: adopted, non-terminal work keeps holding its unit.
    const concurrency = await insertPolicy(f, { id: "policy:concurrency", maxConcurrent: 2 });
    const bounded = new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, knownCost(1));
    await bounded.adopt({ proposal, request: policyRequest(concurrency, { proposalId: "proposal:two",
      operationId: "operation:c1", idempotencyKey: "coordination-adopt-c1", requestId: "request:adopt:c1",
      workflowId: "workflow:adopt:c1" }) });
    await assert.rejects(bounded.adopt({ proposal, request: policyRequest(concurrency, {
      proposalId: "proposal:three", operationId: "operation:c2", idempotencyKey: "coordination-adopt-c2",
      requestId: "request:adopt:c2", workflowId: "workflow:adopt:c2" }) }),
    /policy_concurrency_exhausted/);

    // Route mismatch: eligible routes are server-resolved, never agent content.
    const wrongRoute = await insertPolicy(f, { id: "policy:route", routes: ["executor:other"] });
    await assert.rejects(new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, knownCost(1))
      .adopt({ proposal, request: policyRequest(wrongRoute, { proposalId: "proposal:three",
        operationId: "operation:route", idempotencyKey: "coordination-adopt-route",
        requestId: "request:adopt:route", workflowId: "workflow:adopt:route" }) }), /policy_route_mismatch/);

    // Expiry, pause and revocation.
    const expired = await insertPolicy(f, { id: "policy:expired", validUntil: at(4_000) });
    await assert.rejects(new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, knownCost(1))
      .adopt({ proposal, request: policyRequest(expired, { proposalId: "proposal:three",
        operationId: "operation:expired", idempotencyKey: "coordination-adopt-expired",
        requestId: "request:adopt:expired", workflowId: "workflow:adopt:expired" }) }), /policy_expired/);

    const pausable = await insertPolicy(f, { id: "policy:pausable" });
    await coordinators.pauseDelegation({ tenantId: "tenant:test", projectId: "project:test",
      policyId: pausable, ownerIdentityId: "identity:owner", occurredAt: at(5_000) });
    await assert.rejects(new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, knownCost(1))
      .adopt({ proposal, request: policyRequest(pausable, { proposalId: "proposal:three",
        operationId: "operation:paused", idempotencyKey: "coordination-adopt-paused",
        requestId: "request:adopt:paused", workflowId: "workflow:adopt:paused" }) }), /policy_inactive/);
    await coordinators.revokeDelegation({ tenantId: "tenant:test", projectId: "project:test",
      policyId: pausable, ownerIdentityId: "identity:owner", occurredAt: at(6_000) });
    await assert.rejects(new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, knownCost(1))
      .adopt({ proposal, request: policyRequest(pausable, { proposalId: "proposal:three",
        operationId: "operation:revoked", idempotencyKey: "coordination-adopt-revoked",
        requestId: "request:adopt:revoked", workflowId: "workflow:adopt:revoked" }) }), /policy_revoked/);

    // Replacing the coordinator invalidates its outstanding policies.
    const stalePolicy = await insertPolicy(f, { id: "policy:stale", coordinatorVersion: 1 });
    await coordinators.replace(appointment({ coordinatorIdentityId: "identity:agent-two" }));
    await assert.rejects(new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, knownCost(1))
      .adopt({ proposal, request: policyRequest(stalePolicy, { proposalId: "proposal:three",
        operationId: "operation:stale", idempotencyKey: "coordination-adopt-stale",
        requestId: "request:adopt:stale", workflowId: "workflow:adopt:stale" }) }), /coordinator_version_stale/);

    // A revoked coordinator blocks owner adoption of its proposals too.
    await coordinators.revoke(appointment({ coordinatorIdentityId: "identity:agent-two" }));
    await assert.rejects(new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, knownCost(1))
      .adopt({ proposal, request: operationRequest({ proposalId: "proposal:four",
        operationId: "operation:after-revoke", idempotencyKey: "coordination-adopt-after",
        requestId: "request:adopt:after", workflowId: "workflow:adopt:after" }) }), /coordinator_revoked/);
  } finally { await f.close(); }
});

test("hostile cost evidence is never summed into an admissible ceiling value", async () => {
  const f = await fixture();
  try {
    const proposal = await acceptedProposals(f, ["one"]);
    const policyId = await insertPolicy(f, { maxCost: 1_000 });
    const policyAuth = { kind: "policy" as const, policyId, ownerIdentityId: "identity:owner" };
    // Each entry must be exact micro-USD on its own. Two halves must not round
    // into one admissible integer, and a non-finite or non-numeric value must not
    // escape as an unbounded canonicalisation error.
    const hostile: unknown[] = [0.5, -1_000_000, Number.NaN, Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER, "0", null, undefined];
    let key = 1_000;
    for (const micro of hostile) {
      const port = { currentCost: () => ({ kind: "known", admittedCostMicroUsd: micro,
        evidenceDigest: hex("b") }) as CoordinationCostEvidenceV1 };
      await assert.rejects(new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, port).adopt({
        request: operationRequest({ authorization: policyAuth,
          idempotencyKey: `coordination-adopt-${key += 1}`, operationId: `operation:c${key}`,
          requestId: `request:c${key}`, workflowId: `workflow:c${key}` }), proposal }),
      /policy_cost_unknown/, String(micro));
    }
    // Exact integer evidence still admits, and the ceiling comparison stays exact.
    const admitted = await new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, knownCost(400))
      .adopt({ request: operationRequest({ authorization: policyAuth,
        idempotencyKey: "coordination-adopt-2001", operationId: "operation:c2001",
        requestId: "request:c2001", workflowId: "workflow:c2001" }), proposal });
    assert.equal(admitted.replayed, false);
    const receipts = await f.raw.query<{ count: string; cost: string | null }>(
      `SELECT count(*)::text AS count, max(admitted_cost_microusd)::text AS cost
       FROM control_project_coordination_operation_receipts`);
    assert.deepEqual(receipts.rows[0], { count: "1", cost: "800" });
  } finally { await f.close(); }
});

test("adoption routes and prices the canonical proposal, never a caller-supplied copy", async () => {
  const f = await fixture();
  try {
    const persisted = await acceptedProposals(f, ["one", "two", "three"]);
    // The persisted tasks require `capability.build`, which routes to the
    // expensive executor. A caller presents an object with the same task ids but a
    // cheaper capability and a cheaper recommended route.
    const substituted = { ...persisted, tasks: persisted.tasks.map((task) => ({ ...task,
      requiredCapability: "capability.cheap", recommendedRouteId: "executor:cheap" })) };

    const asked: string[] = [];
    const recordingRoutes = { resolveRoute: (request: { requiredCapability: string }) => {
      asked.push(request.requiredCapability);
      return request.requiredCapability === "capability.build" ? "executor:agent" : "executor:cheap";
    } };
    const pricedByCapability = { currentCost: (request: { requiredCapability: string }):
    CoordinationCostEvidenceV1 => ({ kind: "known",
      admittedCostMicroUsd: request.requiredCapability === "capability.build" ? 1_000 : 1,
      evidenceDigest: hex("b") }) };
    const adoption = new ProjectCoordinationAdoptionServiceV1(f.canonical, recordingRoutes,
      pricedByCapability);

    // Supplying content that is not the stored proposal is refused outright: the
    // supplied value is bound to the exact stored digest before it is used at all.
    await assert.rejects(adoption.adopt({ request: operationRequest(),
      proposal: substituted as ProjectCoordinationProposalV1 }), /proposal_evidence_mismatch/);
    assert.deepEqual(asked, []);
    const untouched = await f.raw.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM control_project_coordination_operation_receipts");
    assert.equal(untouched.rows[0]?.count, "0");

    // With no caller copy at all, routing and pricing still happen - from the
    // canonical row - so the cheap substitution has no path into the decision.
    const adopted = await adoption.adopt({ request: operationRequest() });
    assert.deepEqual(asked, ["capability.build", "capability.build"]);
    const receipt = await f.raw.query<{ cost: string | null }>(
      `SELECT admitted_cost_microusd::text AS cost
       FROM control_project_coordination_operation_receipts WHERE id='operation:one'`);
    assert.equal(receipt.rows[0]?.cost, "2000", "the persisted capability's price, not the cheap one");
    const created = await f.raw.query<{ capability: string; executor: string }>(
      `SELECT required_capability AS capability, payload->'authority'->>'allowedExecutor' AS executor
       FROM control_jobs WHERE id = ANY($1::text[]) ORDER BY id`, [adopted.jobIds]);
    assert.deepEqual(created.rows, [
      { capability: "capability.build", executor: "executor:agent" },
      { capability: "capability.build", executor: "executor:agent" }]);

    // The exact stored proposal is still accepted as a cross-check.
    assert.equal((await adoption.adopt({ proposal: persisted, request: operationRequest({
      proposalId: "proposal:two", idempotencyKey: "coordination-adopt-0002",
      operationId: "operation:two", requestId: "request:adopt:two",
      workflowId: "workflow:adopt:two" }) })).replayed, false);

    // Persistence refuses the pairing directly too: a route/price set resolved
    // from one proposal cannot commit against a different canonical proposal.
    await assert.rejects(f.canonical.adoptProjectCoordinationProposalV1({
      request: operationRequest({ proposalId: "proposal:three",
        idempotencyKey: "coordination-adopt-0003", operationId: "operation:three",
        requestId: "request:adopt:three", workflowId: "workflow:adopt:three" }),
      requestDigest: hex("a"), proposalDigest: hex("d"),
      routes: { "task-1": "executor:agent", "task-2": "executor:agent" },
      cost: { kind: "known", admittedCostMicroUsd: 1, evidenceDigest: hex("b") } }),
    /proposal_evidence_mismatch/);
  } finally { await f.close(); }
});

test("an exact adoption retry is answered before any route or price is consulted", async () => {
  const f = await fixture();
  try {
    const proposal = await acceptedProposals(f, ["one"]);
    let routeCalls = 0;
    let costCalls = 0;
    let routeAvailable = true;
    let micro = 1_000;
    const countingRoutes = { resolveRoute: () => {
      routeCalls += 1;
      return routeAvailable ? "executor:agent" : undefined;
    } };
    const countingCosts = { currentCost: (): CoordinationCostEvidenceV1 => {
      costCalls += 1;
      return { kind: "known", admittedCostMicroUsd: micro, evidenceDigest: hex("b") };
    } };
    const adoption = new ProjectCoordinationAdoptionServiceV1(f.canonical, countingRoutes, countingCosts);
    const adopted = await adoption.adopt({ request: operationRequest(), proposal });
    assert.equal(adopted.replayed, false);
    assert.deepEqual([routeCalls, costCalls], [2, 2], "new work is routed and priced");

    // The world moves on: the route this operation used is no longer available
    // and trusted cost evidence has changed. Neither event may retroactively
    // break the receipt for work that legitimately committed under the old
    // answer, so the identical committed request must still return it.
    routeAvailable = false;
    micro = 999_999;
    routeCalls = 0;
    costCalls = 0;
    const replayed = await adoption.adopt({ request: operationRequest(), proposal });
    assert.deepEqual({ receiptId: replayed.receiptId, receiptDigest: replayed.receiptDigest,
      jobIds: replayed.jobIds, taskUnits: replayed.taskUnits,
      concurrencyUnits: replayed.concurrencyUnits, replayed: replayed.replayed },
    { receiptId: adopted.receiptId, receiptDigest: adopted.receiptDigest, jobIds: adopted.jobIds,
      taskUnits: adopted.taskUnits, concurrencyUnits: adopted.concurrencyUnits, replayed: true });
    // The committed request was found and verified first, so neither mutable
    // port was consulted at all on the retry.
    assert.deepEqual([routeCalls, costCalls], [0, 0], "a retry consults no mutable port");

    // Ports that are outright unavailable are equally irrelevant to a retry.
    const unavailable = new ProjectCoordinationAdoptionServiceV1(f.canonical,
      { resolveRoute: () => { throw new Error("route resolution unavailable"); } },
      { currentCost: (): CoordinationCostEvidenceV1 => { throw new Error("pricing unavailable"); } });
    assert.equal((await unavailable.adopt({ request: operationRequest() })).receiptId, adopted.receiptId);
    assert.equal((await unavailable.adopt({ request: operationRequest(), proposal })).replayed, true);

    // Nothing was adopted again and no allowance was consumed a second time.
    const receipts = await f.raw.query<{ count: string; cost: string | null }>(
      `SELECT count(*)::text AS count,max(admitted_cost_microusd)::text AS cost
       FROM control_project_coordination_operation_receipts`);
    assert.deepEqual(receipts.rows[0], { count: "1", cost: "2000" });

    // Changed request content under the same idempotency key is still a
    // conflict, and it is refused as a conflict before anything is priced.
    routeCalls = 0;
    costCalls = 0;
    await assert.rejects(adoption.adopt({ request: operationRequest({ selectedLocalIds: ["task-1"] }),
      proposal }), /adoption_replay_conflict/);
    await assert.rejects(adoption.adopt({ request: operationRequest({ approvedRouteIds: ["executor:other"] }),
      proposal }), /adoption_replay_conflict/);
    assert.deepEqual([routeCalls, costCalls], [0, 0]);

    // Genuinely new work is not swallowed by the replay path: it still consults
    // both ports and still fails closed on the unavailable route.
    await assert.rejects(adoption.adopt({ proposal, request: operationRequest({
      idempotencyKey: "coordination-adopt-fresh", operationId: "operation:fresh",
      requestId: "request:adopt:fresh", workflowId: "workflow:adopt:fresh" }) }),
    /policy_route_mismatch/);
    assert.equal(routeCalls, 1, "new work is routed");
    const stillOne = await f.raw.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM control_project_coordination_operation_receipts");
    assert.equal(stillOne.rows[0]?.count, "1");

    // A caller copy is still cross-checked on a retry: a substituted proposal
    // object is refused rather than answered with the committed receipt.
    await assert.rejects(adoption.adopt({ request: operationRequest(),
      proposal: { ...proposal, tasks: proposal.tasks.map((task) => ({ ...task,
        requiredCapability: "capability.cheap" })) } }), /proposal_evidence_mismatch/);
  } finally { await f.close(); }
});

test("exact replay returns the original receipt even after the coordinator is revoked", async () => {
  const f = await fixture();
  try {
    const proposal = await acceptedProposals(f, ["one", "two"]);
    const coordinators = new ProjectCoordinatorServiceV1(f.canonical);
    const adoption = new ProjectCoordinationAdoptionServiceV1(f.canonical, routes, knownCost(1_000));
    const adopted = await adoption.adopt({ request: operationRequest(), proposal });
    assert.equal(adopted.replayed, false);

    // The owner revokes the coordinator after the work was legitimately adopted.
    await coordinators.revoke(appointment());

    // Exact replay is verified before any current-authority check, so it still
    // returns the original receipt and consumes nothing again.
    const replayed = await adoption.adopt({ request: operationRequest(), proposal });
    assert.deepEqual({ receiptId: replayed.receiptId, receiptDigest: replayed.receiptDigest,
      jobIds: replayed.jobIds, taskUnits: replayed.taskUnits, replayed: replayed.replayed },
    { receiptId: adopted.receiptId, receiptDigest: adopted.receiptDigest, jobIds: adopted.jobIds,
      taskUnits: adopted.taskUnits, replayed: true });
    // Replay without the caller's proposal copy returns the same receipt.
    assert.equal((await adoption.adopt({ request: operationRequest() })).receiptId, adopted.receiptId);
    const receipts = await f.raw.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM control_project_coordination_operation_receipts");
    assert.equal(receipts.rows[0]?.count, "1");

    // Changed content under the same idempotency key still conflicts, and it
    // conflicts as a replay conflict rather than being mistaken for new work.
    await assert.rejects(adoption.adopt({ request: operationRequest({ selectedLocalIds: ["task-1"] }),
      proposal }), /adoption_replay_conflict/);
    await assert.rejects(adoption.adopt({ request: operationRequest({ approvedRouteIds: ["executor:other"] }),
      proposal }), /adoption_replay_conflict/);

    // A genuinely new operation after revocation still fails closed.
    await assert.rejects(adoption.adopt({ proposal, request: operationRequest({
      proposalId: "proposal:two", idempotencyKey: "coordination-adopt-0002",
      operationId: "operation:two", requestId: "request:adopt:two",
      workflowId: "workflow:adopt:two" }) }), /coordinator_revoked/);
  } finally { await f.close(); }
});
