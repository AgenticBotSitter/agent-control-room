// Proof tests for the #200 correction round: the production adapter reads
// real saved rows per project (no fakes, no empty hooks), the page carries
// the exact saved versions, navigation links the route, the lifecycle form
// requires an explicit identity, and policy controls stay hidden until #220.
import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PGlite } from "@electric-sql/pglite";

import { adaptPglite, type DatabaseClient } from "../src/persistence/database";
import { SecurityStore } from "../src/security/security-store";
import { createAccessVerifier, type AccessTrust } from "../src/web/v1/access-verifier";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import {
  ProjectCoordinationHttpService,
  createProjectCoordinationCanonicalStoreAdapterV1,
  type ProjectCoordinationCanonicalStoreAdapter,
} from "../src/web/v1/project-coordination-http";
import { ProjectNavigation } from "../private-app/app/project-navigation";
import {
  LifecycleControls,
  parseCoordinatorSelection,
} from "../private-app/app/project-coordination-workspace";
import type { ProjectCoordinationPage } from "../src/web/v1/project-coordination-wire";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const ORIGIN = "https://private.example.invalid";
const TENANT = "tenant:test";
const D = `sha256:${"a".repeat(64)}`;
const KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });

function makeToken(now: number, audience: string, subject: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-public-key" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: "https://access.example.invalid", aud: [audience], sub: subject, type: "app",
    iat: now / 1000 - 60, exp: now / 1000 + 300,
  })).toString("base64url");
  return `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), KEYS.privateKey).toString("base64url")}`;
}

const iso = (ms: number): string => new Date(ms).toISOString();

interface Seed {
  identity: VerifiedWebIdentity;
  service: ProjectCoordinationHttpService;
  store: ProjectCoordinationCanonicalStoreAdapter;
  client: DatabaseClient;
  handle: (request: Request) => Promise<Response>;
  dispose: () => Promise<void>;
}

async function seed(): Promise<Seed> {
  const db = new PGlite();
  for (const file of (await readdir("db/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(await readFile(`db/migrations/${file}`, "utf8"));
  }
  await db.query("INSERT INTO tenants(id,display_name) VALUES('tenant:test','Test tenant')");
  await db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','Test workspace')");
  await db.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES('adapter:test','tenant:test','control-room-manual','1.0.0','control_room_native','disabled','v1',30)`);

  const trust: AccessTrust = {
    issuer: "https://access.example.invalid",
    audience: "test-app",
    keys: [{ kid: "test-public-key", jwk: KEYS.publicKey.export({ format: "jwk" }) }],
    validUntilMs: NOW + 3600_000,
    maxSessionSeconds: 604800,
  };
  const client = adaptPglite(db);
  await new SecurityStore(client).bootstrapOwner({
    tenantId: TENANT,
    provider: trust.issuer,
    subject: "test-owner",
    identityId: "identity:owner",
    grantId: "grant:test",
    displayName: "Test owner",
    verifiedAt: iso(NOW - 60_000),
    expiresAt: iso(NOW + 300_000),
    now: iso(NOW),
  });
  const identity: VerifiedWebIdentity = createAccessVerifier(trust)(
    new Request(`${ORIGIN}/api/v1/projects/project:alpha`, {
      method: "GET",
      headers: { "cf-access-jwt-assertion": makeToken(NOW, "test-app", "test-owner"), origin: ORIGIN },
    }),
    NOW,
  );

  for (const [id, digest] of [
    ["identity:coord-a", `sha256:${"a".repeat(64)}`],
    ["identity:coord-b", `sha256:${"b".repeat(64)}`],
  ] as const) {
    await db.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES($1,'tenant:test','human',$2,'test',$3,'active',$4,$4)`,
      [id, id, digest, iso(NOW - 120_000)]);
  }
  for (const [projectId, title] of [["project:alpha", "Alpha"], ["project:beta", "Beta"]] as const) {
    await db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
      normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      VALUES($1,'tenant:test','workspace:test','adapter:test',$1,'1',$2,'Seed','running','seed','healthy','control_room_native',$3,'{}',$3)`,
      [projectId, title, iso(NOW - 100_000)]);
    await db.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
      VALUES('tenant:test',$1,'active',1,$2,$2)`, [projectId, iso(NOW - 100_000)]);
  }
  // Coordinator heads: alpha v3, beta v1 — distinct identities, distinct versions.
  await db.query(`INSERT INTO control_project_coordinator_heads(tenant_id,project_id,state,coordinator_identity_id,
    coordinator_actor_type,assigned_by_owner_identity_id,version,assigned_at,updated_at,payload)
    VALUES('tenant:test','project:alpha','active','identity:coord-a','human','identity:owner',3,$1,$1,'{}')`, [iso(NOW - 90_000)]);
  await db.query(`INSERT INTO control_project_coordinator_heads(tenant_id,project_id,state,coordinator_identity_id,
    coordinator_actor_type,assigned_by_owner_identity_id,version,assigned_at,updated_at,payload)
    VALUES('tenant:test','project:beta','active','identity:coord-b','human','identity:owner',1,$1,$1,'{}')`, [iso(NOW - 80_000)]);
  // Policy on alpha only, version 2.
  await db.query(`INSERT INTO control_project_delegation_policies(tenant_id,id,project_id,coordinator_identity_id,
    coordinator_version,state,version,policy_digest,owner_identity_id,owner_identity_digest,allowed_actions,eligible_routes,
    risk_ceiling,effect_ceiling,max_total_tasks,max_total_cost_microusd,max_concurrent_tasks,valid_from,valid_until,payload,created_at,updated_at)
    VALUES('tenant:test','policy:alpha-1','project:alpha','identity:coord-a',3,'active',2,'${D}','identity:owner','${D}',
    '["maintain.active-work"]','[]','low','none',10,1000000,4,$1,$2,'{}',$1,$1)`,
    [iso(NOW - 70_000), iso(NOW + 7 * 86_400_000)]);

  await db.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
    VALUES('node:test','tenant:test','active',0,'key:test',
    '{"id":"node:test","tenantId":"tenant:test","state":"active","version":0,"identityKeyId":"key:test"}',$1,$1)`, [iso(NOW - 110_000)]);

  // Requests / workflows / jobs. Alpha: two adopted + one plain. Beta: one adopted.
  const chains: Array<{ project: string; tag: string; jobState: string; title: string; adopted: boolean }> = [
    { project: "project:alpha", tag: "a1", jobState: "running", title: "Alpha first", adopted: true },
    { project: "project:alpha", tag: "a2", jobState: "leased", title: "Alpha second", adopted: true },
    { project: "project:alpha", tag: "a3", jobState: "running", title: "Alpha plain", adopted: false },
    { project: "project:beta", tag: "b1", jobState: "leased", title: "Beta only", adopted: true },
  ];
  for (const [index, chain] of chains.entries()) {
    const sessionDigest = `sha256:${String(index).repeat(64)}`;
    await db.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
      VALUES('request:${chain.tag}','tenant:test','${chain.project}','accepted',1,'req-${chain.tag}',
      '{"id":"request:${chain.tag}","tenantId":"tenant:test","state":"accepted","version":1,"projectId":"${chain.project}","idempotencyKey":"req-${chain.tag}","title":"${chain.title}","objective":"seed"}',$1,$1)`, [iso(NOW - 60_000)]);
    await db.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
      VALUES('workflow:${chain.tag}','tenant:test','request:${chain.tag}','${chain.project}','${D}','active',0,
      '{"id":"workflow:${chain.tag}","tenantId":"tenant:test","state":"active","version":0,"requestId":"request:${chain.tag}","projectId":"${chain.project}","definitionDigest":"${D}"}',$1,$1)`, [iso(NOW - 60_000)]);
    await db.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,created_at,updated_at)
      VALUES('job:${chain.tag}','tenant:test','workflow:${chain.tag}','${chain.project}','${chain.jobState}',0,50,'seed','${D}',
      '{"id":"job:${chain.tag}","tenantId":"tenant:test","state":"${chain.jobState}","version":0,"priority":50,"workflowId":"workflow:${chain.tag}","projectId":"${chain.project}","requiredCapability":"seed","authority":{"digest":"${D}"}}',$1,$1)`,
      [iso(NOW - 50_000)]);
    if (!chain.adopted) continue;
    await db.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,node_id,payload,created_at,updated_at)
      VALUES('attempt:${chain.tag}','tenant:test','job:${chain.tag}',1,'running',0,'node:test',
      '{"id":"attempt:${chain.tag}","tenantId":"tenant:test","state":"running","version":0,"attemptNumber":1,"jobId":"job:${chain.tag}","nodeId":"node:test"}',$1,$1)`, [iso(NOW - 40_000)]);
    await db.query(`INSERT INTO control_harness_runs(id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,
      native_session_key_digest,state,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
      VALUES('run:${chain.tag}','tenant:test','${chain.project}','job:${chain.tag}','attempt:${chain.tag}','node:test','adapter:test',
      'hermes','${sessionDigest}','succeeded','${D}','hmac-sha256:${"b".repeat(64)}','{}',$1,$1,$1)`, [iso(NOW - 40_000)]);
    await db.query(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,job_id,attempt_id,content_hash,state,version,payload,created_at,updated_at)
      VALUES('artifact:${chain.tag}','tenant:test','${chain.project}','job:${chain.tag}','attempt:${chain.tag}','${D}','verified',1,
      '{"id":"artifact:${chain.tag}","tenantId":"tenant:test","state":"verified","version":1,"projectId":"${chain.project}","jobId":"job:${chain.tag}","attemptId":"attempt:${chain.tag}","contentHash":"${D}"}',$1,$1)`,
      [iso(NOW - 40_000)]);
    await db.query(`INSERT INTO control_native_artifact_receipts(tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,receipt,auth_tag)
      VALUES('tenant:test','${chain.project}','job:${chain.tag}','attempt:${chain.tag}','run:${chain.tag}','artifact:${chain.tag}','{}','x')`);
    await db.query(`INSERT INTO control_project_coordination_proposals(tenant_id,id,project_id,coordinator_identity_id,coordinator_version,
      source_run_id,source_artifact_id,source_content_hash,source_receipt_digest,source_execution_binding_digest,
      validation_state,proposal_schema,proposal_digest,proposal,action_set,task_count,edge_count,ingested_at)
      VALUES('tenant:test','proposal:${chain.tag}','${chain.project}','identity:owner',1,'run:${chain.tag}','artifact:${chain.tag}',
      '${D}','${D}','${D}','accepted','control-room.project-coordination-proposal/v1','${D}','{}','[]',1,0,$1)`, [iso(NOW - 30_000)]);
    await db.query(`INSERT INTO control_project_coordination_operation_receipts(tenant_id,id,project_id,proposal_id,operation,
      authorization_kind,initiating_identity_id,coordinator_version,idempotency_key,request_digest,task_units,concurrency_units,
      receipt_digest,payload,committed_at)
      VALUES('tenant:test','receipt:${chain.tag}','${chain.project}','proposal:${chain.tag}','proposal.adopt','owner','identity:owner',
      1,'op-${chain.tag}','${D}',1,1,'${D}','{}',$1)`, [iso(NOW - 20_000)]);
    await db.query(`INSERT INTO control_project_coordination_operation_jobs(tenant_id,operation_receipt_id,proposal_local_id,project_id,canonical_job_id)
      VALUES('tenant:test','receipt:${chain.tag}','local-${chain.tag}','${chain.project}','job:${chain.tag}')`);
  }
  // Alpha dependency: a2 depends on a1.
  await db.query(`INSERT INTO control_job_dependencies(tenant_id,job_id,depends_on_job_id)
    VALUES('tenant:test','job:a2','job:a1')`);
  // Alpha conflict: two held writers overlapping on one repository.
  await db.query(`INSERT INTO control_work_resources(tenant_id,id,kind,canonical_key,comparison_key,configuration_digest,payload,created_at)
    VALUES('tenant:test','resource:alpha-1','repository','example-repo','example-repo','${D}','{}',$1)`, [iso(NOW - 45_000)]);
  const acquired1 = iso(NOW - 25_000), acquired2 = iso(NOW - 15_000);
  for (const [tag, job, attempt, lease, acquired] of [
    ["a1", "job:a1", "attempt:a1", "lease:a1", acquired1],
    ["a2", "job:a2", "attempt:a2", "lease:a2", acquired2],
  ] as const) {
    const expires = iso(NOW + 300_000);
    const leasePayload = JSON.stringify({ id: lease, tenantId: "tenant:test", state: "active", version: 0,
      epoch: 1, jobId: job, attemptId: attempt, nodeId: "node:test", acquiredAt: acquired, expiresAt: expires });
    await db.query(`INSERT INTO control_leases(id,tenant_id,job_id,attempt_id,node_id,epoch,state,version,acquired_at,expires_at,payload,created_at,updated_at)
      VALUES('${lease}','tenant:test','${job}','${attempt}','node:test',1,'active',0,$1,$2,$3,$1,$1)`, [acquired, expires, leasePayload]);
    await db.query(`INSERT INTO control_attempt_resource_admissions(tenant_id,id,project_id,job_id,attempt_id,lease_id,node_id,
      repository_resource_id,base_revision,workspace_intent_digest,declaration_digest,state,version,acquired_at,payload)
      VALUES('tenant:test','admission:${tag}','project:alpha','${job}','${attempt}','${lease}','node:test',
      'resource:alpha-1','r1','${D}','${D}','held',1,$1,'{}')`, [acquired]);
  }
  await db.query(`INSERT INTO control_attempt_resource_scopes(tenant_id,admission_id,resource_id,access_mode,scope_kind,path,path_fold)
    VALUES('tenant:test','admission:a1','resource:alpha-1','write','tree','','')`);
  await db.query(`INSERT INTO control_attempt_resource_scopes(tenant_id,admission_id,resource_id,access_mode,scope_kind,path,path_fold)
    VALUES('tenant:test','admission:a2','resource:alpha-1','write','file','src/plan','src/plan')`);
  // Attention rows: alpha has two (one overdue), beta has one without a due date.
  await db.query(`INSERT INTO attention_items(id,tenant_id,workspace_id,project_id,work_item_id,adapter_id,source_record_id,
    source_version,attention_type,title,summary,due_at,created_at_source,observed_at,payload,updated_at)
    VALUES('attn-1','tenant:test','workspace:test','project:alpha',NULL,'adapter:test','src-1','1','approval',
    'Approve the plan','Approve the Alpha plan',$1,$2,$2,'{}',$2)`, [iso(NOW - 5_000), iso(NOW - 10_000)]);
  await db.query(`INSERT INTO attention_items(id,tenant_id,workspace_id,project_id,work_item_id,adapter_id,source_record_id,
    source_version,attention_type,title,summary,due_at,created_at_source,observed_at,payload,updated_at)
    VALUES('attn-2','tenant:test','workspace:test','project:alpha',NULL,'adapter:test','src-2','1','question',
    'Alpha question','What blocks Alpha?',$1,$2,$2,'{}',$2)`, [iso(NOW + 2 * 86_400_000), iso(NOW - 9_000)]);
  await db.query(`INSERT INTO attention_items(id,tenant_id,workspace_id,project_id,work_item_id,adapter_id,source_record_id,
    source_version,attention_type,title,summary,due_at,created_at_source,observed_at,payload,updated_at)
    VALUES('attn-3','tenant:test','workspace:test','project:beta',NULL,'adapter:test','src-3','1','review',
    'Beta review','Review the Beta result',NULL,$1,$1,'{}',$1)`, [iso(NOW - 8_000)]);

  const store = createProjectCoordinationCanonicalStoreAdapterV1({
    database: client, tenantId: TENANT, now: () => NOW,
  });
  const service = new ProjectCoordinationHttpService({
    database: client,
    scope: { tenantId: TENANT, workspaceId: "workspace:test" },
    clock: () => NOW,
    store,
  });
  const application = createPrivateWebProcess({
    origin: ORIGIN,
    issuer: trust.issuer,
    audience: trust.audience,
    tenantId: TENANT,
    workspaceId: "workspace:test",
    maxSessionSeconds: 604800,
    clock: () => NOW,
    loadKeys: async () => trust.keys,
    database: { client, close: async () => { await db.close(); } },
    coordination: { store },
  });
  return {
    identity,
    service,
    store,
    client,
    handle: async (request: Request) => application.handle(request, () => new Response(null, { status: 404 })),
    dispose: async () => { void db.close(); },
  };
}

test("two isolated projects return their own saved coordination data", async (t) => {
  const f = await seed(); t.after(() => f.dispose());
  const alpha = await f.service.read(f.identity, "project:alpha");
  assert.equal(alpha.project.projectId, "project:alpha");
  assert.equal(alpha.coordinatorHead.state, "active");
  assert.equal(alpha.coordinatorHead.version, 3);
  if (alpha.coordinatorHead.state !== "active") throw new Error("alpha head must be active");
  assert.equal(alpha.coordinatorHead.coordinatorIdentityId, "identity:coord-a");
  assert.equal(alpha.delegationPolicy?.policyId, "policy:alpha-1");
  assert.equal(alpha.delegationPolicy?.state, "active");
  assert.deepEqual(alpha.activeWork.map((item) => item.jobId).sort(), ["job:a1", "job:a2"]);
  assert.equal(alpha.activeWork.find((item) => item.jobId === "job:a1")?.title, "Alpha first");
  assert.deepEqual(alpha.dependencies, [{ fromJobId: "job:a2", toJobId: "job:a1", required: true }]);
  assert.equal(alpha.conflicts.length, 1);
  assert.equal(alpha.conflicts[0]?.ledgerId, "conflict:admission:a2");
  assert.equal(alpha.conflicts[0]?.conflictingJobId, "job:a2");
  assert.equal(alpha.attention.length, 2);
  // Exact saved revisions, not array lengths: the page versions must equal
  // what the guards enforce, and the ledger revisions must be nonzero for
  // nonempty ledgers (content digests, not counts).
  assert.equal(alpha.versions.coordinatorVersion, 3);
  assert.equal(alpha.versions.policyVersion, 2);
  assert.ok(alpha.versions.conflictsVersion > 0);
  assert.ok(alpha.versions.attentionVersion > 0);
  assert.equal(alpha.viewerOwnerIdentityId, "identity:owner");

  const beta = await f.service.read(f.identity, "project:beta");
  assert.equal(beta.coordinatorHead.version, 1);
  if (beta.coordinatorHead.state !== "active") throw new Error("beta head must be active");
  assert.equal(beta.coordinatorHead.coordinatorIdentityId, "identity:coord-b");
  assert.equal(beta.delegationPolicy, null);
  assert.deepEqual(beta.activeWork.map((item) => item.jobId), ["job:b1"]);
  assert.deepEqual(beta.dependencies, []);
  assert.deepEqual(beta.conflicts, []);
  assert.equal(beta.attention.length, 1);
  assert.equal(beta.attention[0]?.category, "review");
  assert.equal(beta.versions.coordinatorVersion, 1);
  assert.equal(beta.versions.policyVersion, 0);
  assert.equal(beta.versions.conflictsVersion, 0);
  assert.ok(beta.versions.attentionVersion > 0);
  // Isolation extends to revisions: identical ledger shapes on different
  // projects still carry their own content (beta's single attention row
  // cannot share alpha's two-row revision).
  assert.notEqual(beta.versions.attentionVersion, alpha.versions.attentionVersion);
});

test("a same-count ledger mutation changes the revision and stales the old one", async (t) => {
  const f = await seed(); t.after(() => f.dispose());
  const before = await f.service.read(f.identity, "project:alpha");
  // Swap one attention row for another: the count stays 2, so a
  // length-derived version would miss this change entirely.
  await f.client.query(`DELETE FROM attention_items WHERE id='attn-2'`);
  await f.client.query(`INSERT INTO attention_items(id,tenant_id,workspace_id,project_id,work_item_id,adapter_id,source_record_id,
    source_version,attention_type,title,summary,due_at,created_at_source,observed_at,payload,updated_at)
    VALUES('attn-4','tenant:test','workspace:test','project:alpha',NULL,'adapter:test','src-4','1','approval',
    'Alpha approval replacement','Approve the replacement scope',NULL,$1,$1,'{}',$1)`, [new Date(NOW - 7_000).toISOString()]);
  const after = await f.service.read(f.identity, "project:alpha");
  assert.equal(after.attention.length, 2);
  assert.notEqual(after.versions.attentionVersion, before.versions.attentionVersion);
  // The pre-swap revision is now stale: a write naming it is refused with
  // the exact saved revisions.
  const outcome = await f.service.appointCoordinator(f.identity, {
    projectId: "project:alpha",
    revision: {
      projectId: "project:alpha",
      expectedCoordinatorVersion: before.versions.coordinatorVersion,
      expectedPolicyVersion: before.versions.policyVersion,
      expectedConflictsVersion: before.versions.conflictsVersion,
      expectedAttentionVersion: before.versions.attentionVersion,
      observedAt: before.observedAt,
    },
    idempotencyKey: `stale-attention-${NOW}`,
    coordinatorActorType: "human",
    coordinatorIdentityId: "identity:coord-a",
  });
  assert.equal(outcome.status, "refused");
  if (outcome.status !== "refused") throw new Error("expected refusal");
  assert.equal(outcome.reasonCode, "stale_revision");
  assert.deepEqual(outcome.revision, {
    projectId: "project:alpha",
    observedAt: outcome.revision.observedAt,
    expectedCoordinatorVersion: after.versions.coordinatorVersion,
    expectedPolicyVersion: after.versions.policyVersion,
    expectedConflictsVersion: after.versions.conflictsVersion,
    expectedAttentionVersion: after.versions.attentionVersion,
  });
});

test("the production HTTP composition serves each project's own saved page", async (t) => {
  const f = await seed(); t.after(() => f.dispose());
  for (const [projectId, coordinator] of [["project:alpha", "identity:coord-a"], ["project:beta", "identity:coord-b"]] as const) {
    const response = await f.handle(new Request(`${ORIGIN}/api/v1/projects/${projectId}/coordination`, {
      method: "GET",
      headers: { "cf-access-jwt-assertion": makeToken(NOW, "test-app", "test-owner") },
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as ProjectCoordinationPage;
    assert.equal(body.project.projectId, projectId);
    if (body.coordinatorHead.state !== "active") throw new Error(`${projectId} head must be active`);
    assert.equal(body.coordinatorHead.coordinatorIdentityId, coordinator);
  }
});

test("a stale policy version refuses with the exact saved versions", async (t) => {
  const f = await seed(); t.after(() => f.dispose());
  const page = await f.service.read(f.identity, "project:alpha");
  const outcome = await f.service.appointCoordinator(f.identity, {
    projectId: "project:alpha",
    revision: {
      projectId: "project:alpha",
      expectedCoordinatorVersion: page.versions.coordinatorVersion,
      expectedPolicyVersion: 999,
      expectedConflictsVersion: page.versions.conflictsVersion,
      expectedAttentionVersion: page.versions.attentionVersion,
      observedAt: page.observedAt,
    },
    coordinatorActorType: "human",
    coordinatorIdentityId: "identity:coord-a",
    idempotencyKey: "key:stale-proof",
  });
  assert.equal(outcome.status, "refused");
  assert.equal(outcome.reasonCode, "stale_revision");
  const fresh = await f.service.read(f.identity, "project:alpha");
  assert.deepEqual(
    [outcome.revision.expectedCoordinatorVersion, outcome.revision.expectedPolicyVersion,
      outcome.revision.expectedConflictsVersion, outcome.revision.expectedAttentionVersion],
    [fresh.versions.coordinatorVersion, fresh.versions.policyVersion,
      fresh.versions.conflictsVersion, fresh.versions.attentionVersion],
  );
});

test("naming your own owner identity as coordinator is refused", async (t) => {
  const f = await seed(); t.after(() => f.dispose());
  const page = await f.service.read(f.identity, "project:alpha");
  const outcome = await f.service.appointCoordinator(f.identity, {
    projectId: "project:alpha",
    revision: {
      projectId: "project:alpha",
      expectedCoordinatorVersion: page.versions.coordinatorVersion,
      expectedPolicyVersion: page.versions.policyVersion,
      expectedConflictsVersion: page.versions.conflictsVersion,
      expectedAttentionVersion: page.versions.attentionVersion,
      observedAt: page.observedAt,
    },
    coordinatorActorType: "human",
    coordinatorIdentityId: "identity:owner",
    idempotencyKey: "key:self-proof",
  });
  assert.equal(outcome.status, "refused");
  assert.equal(outcome.reasonCode, "coordinator_self_approval");
});

test("navigation links the coordination route", () => {
  const html = renderToStaticMarkup(createElement(ProjectNavigation, {
    projectId: "project:alpha", current: "coordination",
  }));
  assert.match(html, /href="\/projects\/project%3Aalpha\/coordination"/);
  assert.match(html, /aria-current="page"/);
});

test("coordinator selection requires an explicit, well-bound choice", () => {
  assert.equal(parseCoordinatorSelection({
    coordinatorActorType: "human", coordinatorIdentityId: "  ",
    executorId: "", adapterId: "", connectorProfileDigest: "",
  }).ok, false);
  const human = parseCoordinatorSelection({
    coordinatorActorType: "human", coordinatorIdentityId: "identity:coord-a",
    executorId: "", adapterId: "", connectorProfileDigest: "",
  });
  assert.equal(human.ok, true);
  assert.equal(parseCoordinatorSelection({
    coordinatorActorType: "agent", coordinatorIdentityId: "identity:coord-x",
    executorId: "", adapterId: "", connectorProfileDigest: "",
  }).ok, false);
  assert.equal(parseCoordinatorSelection({
    coordinatorActorType: "agent", coordinatorIdentityId: "exec-1",
    executorId: "exec-1", adapterId: "ad", connectorProfileDigest: D,
  }).ok, false);
  const agent = parseCoordinatorSelection({
    coordinatorActorType: "agent", coordinatorIdentityId: "identity:coord-x",
    executorId: "exec-1", adapterId: "ad", connectorProfileDigest: D,
  });
  assert.equal(agent.ok, true);
});

function makeControlPage(): ProjectCoordinationPage {
  const observedAt = iso(NOW);
  return {
    project: {
      projectId: "project:alpha", title: "Alpha", summary: "Seed", lifecycle: "active",
      version: 1, createdAt: observedAt, updatedAt: observedAt, presentation: undefined,
    },
    coordinationEnabled: true,
    coordinatorHead: {
      tenantId: TENANT, projectId: "project:alpha", version: 3, state: "active",
      coordinatorActorType: "human", coordinatorIdentityId: "identity:coord-a",
      executorId: null, adapterId: null, connectorProfileDigest: null,
      executionBindingDigest: null, appointedAt: observedAt,
      appointedByOwnerIdentityId: "identity:owner",
    },
    delegationPolicy: {
      tenantId: TENANT, projectId: "project:alpha", policyId: "policy:alpha-1",
      coordinatorVersion: 3, state: "active", allowedActions: ["maintain.active-work"],
      validFrom: observedAt, validUntil: iso(NOW + 86_400_000),
      taskAllowance: 10, taskUnitsUsed: 1, microUsdCeiling: "1000000", microUsdUsed: "0",
      concurrencyAllowance: 4, concurrencyUnitsUsed: 1,
    },
    activeWork: [],
    dependencies: [],
    conflicts: [],
    attention: [],
    nextAction: "view-active-work",
    observedAt,
    versions: { coordinatorVersion: 3, policyVersion: 2, conflictsVersion: 0, attentionVersion: 0 },
    viewerOwnerIdentityId: "identity:owner",
  };
}

test("policy pause, resume, and revoke are not offered before #220", () => {
  const page = makeControlPage();
  const html = renderToStaticMarkup(createElement(LifecycleControls, {
    projectId: "project:alpha",
    page,
    revision: {
      projectId: "project:alpha",
      expectedCoordinatorVersion: 3, expectedPolicyVersion: 2,
      expectedConflictsVersion: 0, expectedAttentionVersion: 0,
      observedAt: page.observedAt,
    },
    busy: false,
    disabled: false,
    onAction: async () => ({ ok: true as const }),
  }));
  assert.doesNotMatch(html, /Pause delegation policy/);
  assert.doesNotMatch(html, /Resume delegation policy/);
  assert.doesNotMatch(html, /Revoke delegation policy/);
  assert.match(html, /not offered here/);
  assert.match(html, /policy:alpha-1/);
  assert.match(html, /Coordinator identity/);
});

test("page content and versions come from one repeatable-read snapshot", async (t) => {
  const f = await seed(); t.after(() => f.dispose());
  // Wrap the database handle: count top-level transactions and record the
  // first statement of each, so the test observes the snapshot boundary
  // instead of trusting the implementation.
  const txFirstStatements: string[] = [];
  let plainTxCount = 0;
  const wrappedClient: DatabaseClient = {
    query: (statement, params) => f.client.query(statement, params),
    transactionWithPreCommitCheck: (callback, check) =>
      f.client.transactionWithPreCommitCheck(callback, check),
    transaction: (callback) => f.client.transaction(async (session) => {
      plainTxCount += 1;
      let first: string | null = null;
      const wrappedSession = {
        query: <T = Record<string, unknown>>(statement: string, params?: unknown[]) => {
          if (first === null) first = statement;
          return session.query<T>(statement, params);
        },
      };
      try {
        return await callback(wrappedSession);
      } finally {
        txFirstStatements.push(first ?? "<no statements>");
      }
    }),
  };
  const service = new ProjectCoordinationHttpService({
    database: wrappedClient,
    scope: { tenantId: "tenant:test", workspaceId: "workspace:test" },
    clock: () => NOW,
    store: f.store,
  });
  const page = await service.read(f.identity, "project:alpha");
  // Authorization runs through transactionWithPreCommitCheck; exactly one
  // plain transaction — the page snapshot — must compose the whole page.
  assert.equal(plainTxCount, 1);
  assert.match(txFirstStatements[0] ?? "", /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ/);
  // The snapshot still serves the real saved content and versions.
  assert.equal(page.attention.length, 2);
  assert.ok(page.versions.attentionVersion > 0);
  assert.equal(page.conflicts.length, 1);
});

test("a concurrent attention insert cannot pair old content with a new accepting version", async (t) => {
  const f = await seed(); t.after(() => f.dispose());
  const before = await f.service.read(f.identity, "project:alpha");
  assert.equal(before.attention.length, 2);
  // Concurrent change lands between the page read and the write attempt.
  await f.client.query(`INSERT INTO attention_items(id,tenant_id,workspace_id,project_id,work_item_id,adapter_id,source_record_id,
    source_version,attention_type,title,summary,due_at,created_at_source,observed_at,payload,updated_at)
    VALUES('attn-9','tenant:test','workspace:test','project:alpha',NULL,'adapter:test','src-9','1','approval',
    'Late approval','Arrived after the page read',$1,$2,$2,'{}',$2)`,
    [new Date(NOW + 86_400_000).toISOString(), new Date(NOW).toISOString()]);
  const revisionOf = (versions: typeof before.versions) => ({
    projectId: "project:alpha",
    expectedCoordinatorVersion: versions.coordinatorVersion,
    expectedPolicyVersion: versions.policyVersion,
    expectedConflictsVersion: versions.conflictsVersion,
    expectedAttentionVersion: versions.attentionVersion,
    observedAt: new Date(NOW).toISOString(),
  });
  // The old versions no longer accept: the guard refuses with the exact new
  // versions, so the caller can never write against content it did not see.
  const stale = await f.service.appointCoordinator(f.identity, {
    projectId: "project:alpha",
    revision: revisionOf(before.versions),
    coordinatorActorType: "human",
    coordinatorIdentityId: "identity:coord-b",
    idempotencyKey: `snapshot-stale-${NOW}`,
  });
  assert.equal(stale.status, "refused");
  if (stale.status !== "refused") throw new Error("expected a refusal");
  assert.equal(stale.reasonCode, "stale_revision");
  // A fresh read pairs the new row with the new versions, and that pair accepts.
  const after = await f.service.read(f.identity, "project:alpha");
  assert.equal(after.attention.length, 3);
  assert.notEqual(after.versions.attentionVersion, before.versions.attentionVersion);
  assert.deepEqual(stale.revision, {
    projectId: "project:alpha",
    observedAt: stale.revision.observedAt,
    expectedCoordinatorVersion: after.versions.coordinatorVersion,
    expectedPolicyVersion: after.versions.policyVersion,
    expectedConflictsVersion: after.versions.conflictsVersion,
    expectedAttentionVersion: after.versions.attentionVersion,
  });
  const fresh = await f.service.appointCoordinator(f.identity, {
    projectId: "project:alpha",
    revision: revisionOf(after.versions),
    coordinatorActorType: "human",
    coordinatorIdentityId: "identity:coord-b",
    idempotencyKey: `snapshot-fresh-${NOW}`,
  });
  assert.equal(fresh.status, "accepted");
});
