import assert from "node:assert/strict";
import test from "node:test";
import { fixture, now } from "./helpers/web-foundation";
import { nativeTaskLifecycleFixture } from "./helpers/native-task-lifecycle";
import { nativeQualityCompletionFixture } from "./helpers/native-quality-completion";
import type { JobRecord, AttemptRecord, LeaseRecord } from "../src/domain/v1";
import {
  canonicalProjectWorkResourceDeclarationV1, currentResourceHolderProofDigestV2,
  noWorkspaceAnchorConfigurationDigestV1, noWorkspaceIntentDigestV1,
  processRetirementProofDigestV1, projectCoordinatorExecutionBindingDigestV1,
  projectCoordinatorPlanningMarkerDigestV1, projectWorkResourceAdmissionDigestV1,
  projectWorkResourceDeclarationDigestV1, verifyCurrentResourceHolderProofV2,
} from "../src/contracts/v1";

const at = new Date(now).toISOString();
const digest = `sha256:${"a".repeat(64)}`;

test("coordinator heads retain versions and delegation policy limits cannot be widened", async () => {
  const f = await fixture();
  try {
    await f.db.query(`INSERT INTO adapter_registry
      (id,tenant_id,source_system,contract_version,authority_mode,status,project_types,supported_read_operations,
       supported_commands,redaction_policy_version,cursor_retention_days)
      VALUES('adapter:coordination','tenant:web','coordination-test','v1','control_room_native','fixture','[]','[]','[]','v1',1)`);
    await f.db.query(`INSERT INTO projects
      (id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
       health,authority_mode,observed_at,payload)
      VALUES('project:coordination','tenant:web','workspace:web','adapter:coordination','project:coordination','1',
       'Coordination project','ready','ready','healthy','control_room_native',$1,'{}')`, [at]);
    await f.db.query(`INSERT INTO control_identities
      (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES('identity:coordinator','tenant:web','agent','Coordinator','internal',$1,'active',$2,$2)`, [digest, at]);

    await f.db.query(`INSERT INTO control_project_coordinator_heads
      (tenant_id,project_id,state,coordinator_identity_id,coordinator_actor_type,executor_id,adapter_id,
       execution_binding_digest,assigned_by_owner_identity_id,version,assigned_at,updated_at,payload)
      VALUES('tenant:web','project:coordination','active','identity:coordinator','agent','executor:test','adapter:test',
       $1,'identity:web',1,$2,$2,'{}')`, [digest, at]);
    await assert.rejects(f.db.query(`UPDATE control_project_coordinator_heads SET version=1 WHERE tenant_id='tenant:web'
      AND project_id='project:coordination'`), /project coordinator head update rejected/);
    await f.db.query(`UPDATE control_project_coordinator_heads SET state='revoked',version=2,revoked_at=$1,updated_at=$1
      WHERE tenant_id='tenant:web' AND project_id='project:coordination'`, [at]);
    await f.db.query(`UPDATE control_project_coordinator_heads SET state='active',version=3,revoked_at=NULL,updated_at=$1
      WHERE tenant_id='tenant:web' AND project_id='project:coordination'`, [at]);
    const head = await f.db.query<{state:string;version:number}>(`SELECT state,version FROM control_project_coordinator_heads`);
    assert.deepEqual(head.rows, [{ state: "active", version: 3 }]);

    await f.db.query(`INSERT INTO control_project_delegation_policies
      (tenant_id,id,project_id,coordinator_identity_id,coordinator_version,state,version,policy_digest,
       owner_identity_id,owner_identity_digest,allowed_actions,eligible_routes,risk_ceiling,effect_ceiling,
       max_total_tasks,max_total_cost_microusd,max_concurrent_tasks,valid_from,valid_until,payload,created_at,updated_at)
      VALUES('tenant:web','policy:one','project:coordination','identity:coordinator',3,'active',1,$1,
       'identity:web',$1,'["tasks.propose"]','[]','low','none',8,0,2,$2,$3,'{}',$2,$2)`,
      [digest, at, new Date(now + 60_000).toISOString()]);
    await assert.rejects(f.db.query(`UPDATE control_project_delegation_policies SET max_total_tasks=9,version=2
      WHERE tenant_id='tenant:web' AND id='policy:one'`), /project delegation policy update rejected/);
    await f.db.query(`UPDATE control_project_delegation_policies SET state='paused',version=2,updated_at=$1
      WHERE tenant_id='tenant:web' AND id='policy:one'`, [at]);
    await assert.rejects(f.db.query(`DELETE FROM control_project_delegation_policies
      WHERE tenant_id='tenant:web' AND id='policy:one'`));
  } finally { await f.db.close(); }
});

test("agent bindings and policy authorization evidence fail closed", async () => {
  const f = await fixture();
  try {
    const tables = (await f.db.query<{table_name:string}>(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'control_project_coordination_%' ORDER BY table_name`)).rows;
    assert.deepEqual(tables.map(row => row.table_name), [
      "control_project_coordination_operation_jobs",
      "control_project_coordination_operation_receipts",
      "control_project_coordination_proposals",
    ]);
    const constraints = (await f.db.query<{constraint_name:string}>(`SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name IN ('control_native_artifact_receipts','control_project_coordination_proposals',
        'control_project_coordination_operation_receipts')`)).rows;
    assert.ok(constraints.some(row => row.constraint_name === "uq_control_native_artifact_run_artifact"));
    assert.ok(constraints.length > 8);
    const proposalChecks = await f.db.query<{definition:string}>(`SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='control_project_coordination_proposals'::regclass AND contype='c'`);
    assert.ok(proposalChecks.rows.some(row => row.definition.includes("proposal_schema IS NOT NULL")
      && row.definition.includes("control-room.project-coordination-proposal/v1")));
  } finally { await f.db.close(); }
});

test("workspace holders survive lease time and retire only with trusted evidence", async () => {
  const x = await nativeTaskLifecycleFixture();
  try {
    const p = x.f.prepared.request;
    await x.f.db.query(`INSERT INTO control_work_resources
      (tenant_id,id,kind,canonical_key,comparison_key,configuration_digest,payload,created_at)
      VALUES('tenant:test','resource:repository:test','repository','repo:test','repo:test',$1,'{}',$2)`, [digest, at]);
    await x.f.db.query(`INSERT INTO control_attempt_resource_admissions
      (tenant_id,id,project_id,job_id,attempt_id,lease_id,node_id,repository_resource_id,base_revision,
       workspace_intent_digest,declaration_digest,state,version,acquired_at,payload)
      VALUES('tenant:test','admission:resource:test',$1,$2,$3,$4,$5,'resource:repository:test',
       '0123456789abcdef',$6,$6,'held',1,$7,'{}')`,
      [x.f.prepared.binding.projectId, p.jobId, p.attemptId, p.leaseId, p.nodeId, digest, at]);
    await x.f.db.query(`INSERT INTO control_attempt_resource_scopes
      (tenant_id,admission_id,resource_id,access_mode,scope_kind,path,path_fold)
      VALUES('tenant:test','admission:resource:test','resource:repository:test','write','tree','src','src')`);

    const job = await x.f.canonical.get("tenant:test", "job", p.jobId) as JobRecord;
    const attempt = await x.f.canonical.get("tenant:test", "attempt", p.attemptId) as AttemptRecord;
    const lease = await x.f.canonical.get("tenant:test", "lease", p.leaseId) as LeaseRecord;
    await x.f.canonical.expireLease({ tenantId: "tenant:test", leaseId: lease.id, jobId: job.id,
      attemptId: attempt.id, expectedLeaseVersion: lease.version, expectedJobVersion: job.version,
      expectedAttemptVersion: attempt.version, epoch: lease.epoch,
      transitionId: "transition:test:expire-holder", idempotencyKey: "idempotency:test:expire-holder",
      actor: { actorId: "service:test", actorType: "service" }, occurredAt: lease.expiresAt });
    const stillHeld = await x.f.db.query<{state:string}>(`SELECT state FROM control_attempt_resource_admissions
      WHERE tenant_id='tenant:test' AND id='admission:resource:test'`);
    assert.equal(stillHeld.rows[0]?.state, "held");

    await assert.rejects(x.f.db.query(`UPDATE control_attempt_resource_admissions
      SET state='retired',version=2,retired_at=$1 WHERE tenant_id='tenant:test'`, [at]));
    await x.f.db.query(`UPDATE control_attempt_resource_admissions
      SET state='retired',version=2,retired_at=$1,retirement_kind='trusted_process_retired',
        retirement_proof_digest=$2 WHERE tenant_id='tenant:test'`, [at, digest]);
    await assert.rejects(x.f.db.query(`UPDATE control_attempt_resource_admissions
      SET state='held',version=3,retired_at=NULL,retirement_kind=NULL,retirement_proof_digest=NULL
      WHERE tenant_id='tenant:test'`), /attempt resource admission update rejected/);
    await assert.rejects(x.f.db.query(`INSERT INTO control_attempt_resource_scopes
      (tenant_id,admission_id,resource_id,access_mode,scope_kind,path,path_fold)
      VALUES('tenant:test','admission:resource:test','resource:repository:test','write','file','../escape','../escape')`));
  } finally { await x.close(); }
});

test("accepted proposals require their schema and cannot authorize another project", async () => {
  const x = await nativeQualityCompletionFixture();
  try {
    const agentDigest = `sha256:${"b".repeat(64)}`;
    await x.f.db.query(`INSERT INTO control_identities
      (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES('identity:coordination-agent','tenant:test','agent','Coordinator','internal',$1,'active',$2,$2)`,
      [agentDigest, at]);
    const values = [x.registration.projectId, x.registration.id, x.artifact.artifactId,
      x.artifact.contentHash, digest, agentDigest, at];
    const insert = (id: string, schema: string | null) => x.f.db.query(`INSERT INTO control_project_coordination_proposals
      (tenant_id,id,project_id,coordinator_identity_id,coordinator_version,source_run_id,source_artifact_id,
       source_content_hash,source_receipt_digest,source_execution_binding_digest,validation_state,proposal_schema,
       proposal_digest,proposal,action_set,task_count,edge_count,ingested_at)
      VALUES('tenant:test',$1,$2,'identity:coordination-agent',1,$3,$4,$5,$6,$7,'accepted',$8,$6,'{}','[]',0,0,$9)`,
      [id, ...values.slice(0, 6), schema, values[6]]);
    await assert.rejects(insert("proposal:null-schema", null));
    await insert("proposal:valid", "control-room.project-coordination-proposal/v1");

    await x.f.db.query(`INSERT INTO projects
      SELECT 'project:coordination-other',tenant_id,workspace_id,adapter_id,source_record_id||':other',source_version,
        source_checksum,'Other project',description,deep_link,normalized_state,domain_state,health,progress_percent,
        forecast_at,attention_count,blocker_count,priority,authority_mode,observed_at,payload,updated_at,coordinator_lock
      FROM projects WHERE tenant_id='tenant:test' AND id=$1`, [x.registration.projectId]);
    await assert.rejects(x.f.db.query(`INSERT INTO control_project_coordination_operation_receipts
      (tenant_id,id,project_id,proposal_id,operation,authorization_kind,initiating_identity_id,
       coordinator_version,idempotency_key,request_digest,task_units,concurrency_units,receipt_digest,payload,committed_at)
      VALUES('tenant:test','operation:cross-project','project:coordination-other','proposal:valid',
       'proposal.adopt','owner','identity:test',1,'operation-cross-project',$1,0,0,$1,'{}',$2)`, [digest, at]));
  } finally { await x.close(); }
});

const boundaryDigest = (character: string) => `sha256:${character.repeat(64)}`;
const boundaryBase = { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test" };

test("coordination boundary binds exact planner identity, job, attempt and run", () => {
  const binding = { schema: "control-room.project-coordinator-execution-binding/v1" as const,
    tenantId: boundaryBase.tenantId, projectId: boundaryBase.projectId, coordinatorIdentityId: "identity:agent",
    executorId: "executor:agent", adapterId: "adapter:agent", connectorProfileDigest: boundaryDigest("a") };
  const bindingDigest = projectCoordinatorExecutionBindingDigestV1(binding);
  const marker = { schema: "control-room.project-coordinator-planning-marker/v1" as const,
    tenantId: boundaryBase.tenantId, projectId: boundaryBase.projectId, planningJobId: boundaryBase.jobId,
    planningJobDigest: boundaryDigest("2"), planningInputDigest: boundaryDigest("3"), attemptId: "attempt:plan",
    runId: "run:plan", nodeId: "node:plan", coordinatorIdentityId: "identity:agent", coordinatorVersion: 3,
    adapterId: binding.adapterId, connectorProfileDigest: binding.connectorProfileDigest,
    executionBindingDigest: bindingDigest, executionRequestDigest: boundaryDigest("4"),
    ownerIdentityId: "identity:owner", ownerRequestId: "request:owner", ownerRequestDigest: boundaryDigest("b"),
    expectedProposalSchema: "control-room.project-coordination-proposal/v1" as const,
    createdAt: "2026-09-14T00:00:00.000Z" };
  const markerDigest = projectCoordinatorPlanningMarkerDigestV1(marker);
  assert.notEqual(markerDigest, projectCoordinatorPlanningMarkerDigestV1({ ...marker, runId: "run:other" }));
  assert.notEqual(markerDigest, projectCoordinatorPlanningMarkerDigestV1({ ...marker, planningJobDigest: boundaryDigest("5") }));
  assert.notEqual(bindingDigest, projectCoordinatorExecutionBindingDigestV1({ ...binding, adapterId: "adapter:other" }));
  assert.throws(() => projectCoordinatorPlanningMarkerDigestV1({ ...marker, suppliedAgentIdentity: "identity:other" }));
});

test("coordination resource declaration is deterministic and rejects ambiguous scopes", () => {
  const declaration = { schema: "control-room.project-work-resource-declaration/v1" as const, ...boundaryBase,
    workspace: { kind: "repository" as const, resourceId: "resource:repo",
      resourceConfigurationDigest: boundaryDigest("c"), baseRevision: "abc123",
      workspaceIntentDigest: boundaryDigest("d") },
    scopes: [
      { resourceId: "resource:logical", resourceKind: "logical" as const,
        resourceConfigurationDigest: boundaryDigest("e"), accessMode: "read" as const,
        scopeKind: "logical" as const, path: "" },
      { resourceId: "resource:repo", resourceKind: "repository" as const,
        resourceConfigurationDigest: boundaryDigest("c"), accessMode: "write" as const,
        scopeKind: "tree" as const, path: "Src/Feature" },
    ] };
  assert.equal(canonicalProjectWorkResourceDeclarationV1(declaration).scopes[1]?.path, "src/feature");
  assert.equal(projectWorkResourceDeclarationDigestV1(declaration),
    projectWorkResourceDeclarationDigestV1({ ...declaration, scopes: [...declaration.scopes].reverse() }));
  assert.throws(() => projectWorkResourceDeclarationDigestV1({ ...declaration, scopes: [
    declaration.scopes[1], { ...declaration.scopes[1], path: "src/feature", accessMode: "read" },
  ] }), /duplicate_scope/);
  assert.throws(() => projectWorkResourceDeclarationDigestV1({ ...declaration, scopes: [{
    resourceId: declaration.workspace.resourceId, resourceKind: "logical",
    resourceConfigurationDigest: declaration.workspace.resourceConfigurationDigest,
    accessMode: "write", scopeKind: "logical", path: "",
  }] }), /workspace_scope_missing/);
  assert.throws(() => projectWorkResourceDeclarationDigestV1({ ...declaration, scopes: [
    declaration.scopes[1], { resourceId: "resource:logical:no-workspace:v1", resourceKind: "logical",
      resourceConfigurationDigest: noWorkspaceAnchorConfigurationDigestV1(boundaryBase.tenantId),
      accessMode: "write", scopeKind: "logical", path: "" },
  ] }), /reserved_anchor_scope/);
});

test("coordination logical-only work and exact admission cannot borrow a workspace or attempt", () => {
  const lineage = { ...boundaryBase, attemptId: "attempt:test", leaseId: "lease:test", nodeId: "node:test" };
  const declaration = { schema: "control-room.project-work-resource-declaration/v1" as const, ...boundaryBase,
    workspace: { kind: "none" as const, anchorResourceId: "resource:logical:no-workspace:v1" as const,
      anchorConfigurationDigest: noWorkspaceAnchorConfigurationDigestV1(boundaryBase.tenantId),
      baseRevision: "no-workspace:v1" as const, workspaceIntentDigest: noWorkspaceIntentDigestV1(boundaryBase) },
    scopes: [{ resourceId: "resource:news-source", resourceKind: "logical" as const,
      resourceConfigurationDigest: boundaryDigest("1"), accessMode: "write" as const,
      scopeKind: "logical" as const, path: "" }] };
  const declarationDigest = projectWorkResourceDeclarationDigestV1(declaration);
  const admission = { schema: "control-room.project-work-resource-admission/v1" as const, ...lineage,
    admissionId: "admission:test", declarationDigest };
  const admissionDigest = projectWorkResourceAdmissionDigestV1(admission);
  assert.notEqual(admissionDigest, projectWorkResourceAdmissionDigestV1({ ...admission, attemptId: "attempt:other" }));
  assert.throws(() => projectWorkResourceDeclarationDigestV1({ ...declaration, scopes: [{
    resourceId: "resource:logical:no-workspace:v1", resourceKind: "logical",
    resourceConfigurationDigest: noWorkspaceAnchorConfigurationDigestV1(boundaryBase.tenantId),
    accessMode: "write", scopeKind: "logical", path: "",
  }] }), /reserved_anchor_scope/);
});

test("current holder and process-retirement evidence bind exact run and expire quickly", () => {
  const proof = { schema: "control-room.current-resource-holder/v2" as const, ...boundaryBase,
    attemptId: "attempt:test", leaseId: "lease:test", nodeId: "node:test", runId: "run:test",
    admissionId: "admission:test", resourceAdmissionDigest: boundaryDigest("3"),
    startAuthorizationDigest: boundaryDigest("4"), admissionVersion: 1, state: "held" as const,
    checkedAt: "2026-09-14T00:00:00.000Z", expiresAt: "2026-09-14T00:00:10.000Z" };
  const proofDigest = currentResourceHolderProofDigestV2(proof);
  assert.notEqual(proofDigest, currentResourceHolderProofDigestV2({ ...proof, admissionVersion: 2 }));
  assert.throws(() => currentResourceHolderProofDigestV2({ ...proof, state: "retired" }));
  assert.throws(() => verifyCurrentResourceHolderProofV2({ ...proof, expiresAt: "2026-09-14T00:00:11.000Z" }, proof,
    Date.parse("2026-09-14T00:00:01.000Z")), /current_resource_holder_proof_invalid/);
  assert.throws(() => verifyCurrentResourceHolderProofV2(proof, { ...proof, runId: "run:other" },
    Date.parse("2026-09-14T00:00:01.000Z")), /current_resource_holder_proof_invalid/);
  const retirement = { schema: "control-room.process-retirement-proof/v1" as const, ...boundaryBase,
    attemptId: proof.attemptId, leaseId: proof.leaseId, nodeId: proof.nodeId, admissionId: proof.admissionId,
    resourceAdmissionDigest: proof.resourceAdmissionDigest, runId: proof.runId,
    processIdentityDigest: boundaryDigest("7"), sourceKind: "native_recovery" as const,
    sourceEvidenceDigest: boundaryDigest("8"), observedAt: proof.checkedAt };
  assert.notEqual(processRetirementProofDigestV1(retirement),
    processRetirementProofDigestV1({ ...retirement, runId: "run:other" }));
  assert.throws(() => processRetirementProofDigestV1({ ...retirement, sourceKind: "lease_expired" }));
});
