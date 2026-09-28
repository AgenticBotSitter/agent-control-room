import assert from "node:assert/strict";
import test from "node:test";
import { hmacSha256Tag, sha256Digest, type AuthenticatedPrincipal } from "../src/security";
import { WorkBatchOwnerServiceV1, WorkBatchStoreV1, workBatchProposalDigestV1,
  workBatchOwnerNotificationV1, type WorkBatchProposalV1 } from "../src/work-intake/v1";
import { taskFixture } from "./helpers/web-task";
import { now, origin, request, trust } from "./helpers/web-foundation";
import { createWorkBatchOwnerHttpHandlerV1 } from "../src/web/v1/work-batch-owner-http";

const key = new Uint8Array(32).fill(7);
const agent = (): AuthenticatedPrincipal => ({ tenantId: "tenant:web", identityId: "identity:batch-agent",
  actorType: "agent", authenticatedAt: "2026-09-04T11:59:00.000Z", expiresAt: "2026-09-04T13:00:00.000Z" });
function proposal(projectId: string): WorkBatchProposalV1 {
  return { schema: "control-room.work-batch-proposal/v1", projectId, tasks: [
    { localId: "build", title: "Build the change", instructions: "Implement the bounded change.",
      requiredCapability: "code.change", role: "builder", acceptanceCriteria: "The implementation is bounded.",
      acceptanceTests: "Run the focused build tests." },
    { localId: "check", title: "Check the change", instructions: "Review the retained implementation evidence.",
      requiredCapability: "code.review", role: "checker", acceptanceCriteria: "The review is independent.",
      acceptanceTests: "Run the focused review tests." },
  ], edges: [{ fromLocalId: "build", toLocalId: "check" }] };
}

async function ownerFixture() {
  const f = await taskFixture();
  await f.db.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES('identity:batch-agent','tenant:web','agent','Batch agent',
    'work-intake',$1,'active',$2,$2)`, [sha256Digest("batch-agent"), new Date(now).toISOString()]);
  await f.db.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at) VALUES('grant:batch-agent','tenant:web',
    'identity:batch-agent','work_batch_proposer','["work_batches.propose"]',$1::jsonb,'low',false,false,$2,$2)`,
  [JSON.stringify([f.project.projectId]), new Date(now).toISOString()]);
  const store = new WorkBatchStoreV1(f.client, key);
  const owner = new WorkBatchOwnerServiceV1(f.client, f.tasks,
    { tenantId: "tenant:web", workspaceId: "workspace:web" }, key, () => now);
  let submission = 0;
  async function submit(value = proposal(f.project.projectId)) {
    return store.create({ principal: agent(), proposal: value, proposalDigest: workBatchProposalDigestV1(value),
      idempotencyKey: `owner-test-submit-${String(++submission).padStart(4, "0")}`, now: new Date(now).toISOString(),
      queueDepthLimit: 10 });
  }
  return { ...f, owner, store, submit };
}

test("owner approval atomically materializes ordinary proposed tasks and exact replay is inert", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit(), command = { operation: "decide" as const, batchId: batch.batchId, expectedRevision: 1,
    items: [{ localId: "build", decision: "approve" as const }, { localId: "check", decision: "approve" as const }] };
  const attention = await f.owner.attention(f.identity);
  assert.equal(attention.batches.length, 1); assert.equal(attention.batches[0]!.batchId, batch.batchId);
  const first = await f.owner.command(f.identity, f.project.projectId, command, "owner-batch-decision-0001");
  assert.equal(first.state, "approved"); assert.equal(first.startsWork, false); assert.equal(first.jobIds.length, 2);
  const replay = await f.owner.command(f.identity, f.project.projectId, command, "owner-batch-decision-0001");
  assert.equal(replay.replayed, true); assert.deepEqual(replay.jobIds, first.jobIds);
  const jobs = await f.db.query<{ state: string }>("SELECT state FROM control_jobs WHERE tenant_id='tenant:web'");
  assert.equal(jobs.rows.length, 2); assert.ok(jobs.rows.every(row => row.state === "proposed"));
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_attempts")).rows[0]!.count, 0);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batch_items")).rows[0]!.count, 2);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_action_inbox")).rows[0]!.count, 1);
  assert.equal((await f.db.query<{ state: string }>("SELECT state FROM control_action_inbox")).rows[0]!.state, "resolved");
  assert.equal((await f.owner.attention(f.identity)).batches.length, 0);
  const notification = workBatchOwnerNotificationV1({ tenantId: "tenant:web", projectId: f.project.projectId,
    batchId: batch.batchId, createdAt: new Date(now).toISOString() });
  assert.equal(notification.envelope.authority, "none"); assert.deepEqual(notification.envelope.actions, []);
  assert.equal("command" in notification.envelope, false); assert.equal("legalResponses" in notification.envelope, false);
  const view = await f.owner.view(f.identity, f.project.projectId, batch.batchId);
  assert.equal(view.state, "approved"); assert.equal(view.items[1]!.dependsOnLocalIds[0], "build");
});

test("saved item and final-decision integrity failures refuse owner reads", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit();
  await f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" }, { localId: "check", decision: "approve" }] },
    "owner-batch-integrity-0001");
  assert.equal((await f.store.status(agent(), f.project.projectId, batch.batchId,
    new Date(now).toISOString())).state, "approved");
  await f.db.query("DROP TRIGGER work_batch_items_append_only ON work_batch_items");
  await f.db.query("UPDATE work_batch_items SET acceptance_criteria='tampered' WHERE local_id='build'");
  await assert.rejects(f.owner.view(f.identity, f.project.projectId, batch.batchId), /work_batch_integrity_failed/u);
  await assert.rejects(f.store.status(agent(), f.project.projectId, batch.batchId,
    new Date(now).toISOString()), /integrity_failed/u);

  const second = await ownerFixture(); t.after(() => void second.db.close());
  const secondBatch = await second.submit();
  await second.owner.command(second.identity, second.project.projectId,
    { operation: "decide", batchId: secondBatch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "reject", reasonCode: "not_selected" },
        { localId: "check", decision: "reject", reasonCode: "not_selected" }] }, "owner-batch-integrity-0002");
  await second.db.query("DROP TRIGGER work_batches_owner_update ON work_batches");
  await second.db.query("UPDATE work_batches SET decision_auth_tag=$1 WHERE id=$2",
    [`hmac-sha256:${"0".repeat(64)}`, secondBatch.batchId]);
  await assert.rejects(second.owner.list(second.identity, second.project.projectId), /work_batch_integrity_failed/u);
  await assert.rejects(second.store.list(agent(), second.project.projectId,
    new Date(now).toISOString()), /integrity_failed/u);
});

test("revision history and rejected items remain visible", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit(), changed = proposal(f.project.projectId);
  changed.tasks[0] = { ...changed.tasks[0]!, title: "Build the revised change" };
  const revised = await f.owner.command(f.identity, f.project.projectId,
    { operation: "revise", batchId: batch.batchId, expectedRevision: 1, reasonCode: "owner_edit", proposal: changed },
    "owner-batch-revision-0001");
  assert.equal(revised.revision, 2); assert.equal(revised.state, "proposed");
  const decided = await f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 2,
      items: [{ localId: "build", decision: "approve" },
        { localId: "check", decision: "reject", reasonCode: "needs_different_check" }] },
    "owner-batch-decision-0002");
  assert.equal(decided.state, "partially_approved"); assert.equal(decided.jobIds.length, 1);
  const view = await f.owner.view(f.identity, f.project.projectId, batch.batchId);
  assert.equal(view.revisions.length, 2); assert.equal(view.revisions[0]!.proposal.tasks[0]!.title, "Build the change");
  assert.equal(view.proposal.tasks[0]!.title, "Build the revised change");
  assert.equal(view.items[1]!.decisionReasonCode, "needs_different_check");
});

test("an S1-authenticated batch remains readable after the S2 migration and first revision", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit();
  const before = (await f.db.query<{ id: string; project_id: string; proposed_by_identity_id: string;
    proposed_at: string | Date; proposal: WorkBatchProposalV1; queue_depth_limit: number; batch_digest: string;
    auth_tag: string; auth_material_version: number; created_at: string | Date }>(`SELECT id,project_id,
      proposed_by_identity_id,proposed_at,proposal,queue_depth_limit,batch_digest,auth_tag,
      auth_material_version,created_at FROM work_batches WHERE id=$1`, [batch.batchId])).rows[0]!;
  const createdAt = new Date(before.created_at).toISOString();
  assert.equal(before.auth_material_version, 1, "0094 backfills the S1 auth-material version");
  assert.equal(before.auth_tag, hmacSha256Tag(key, { purpose: "work-batch/v1", record: {
    id: before.id, tenantId: "tenant:web", projectId: before.project_id,
    proposedByIdentityId: before.proposed_by_identity_id, proposedAt: new Date(before.proposed_at).toISOString(),
    state: "proposed", proposal: before.proposal, queueDepthLimit: Number(before.queue_depth_limit),
    batchDigest: before.batch_digest, version: 1, createdAt, updatedAt: createdAt } }));
  const changed = proposal(f.project.projectId);
  changed.tasks[0] = { ...changed.tasks[0]!, title: "Build after the S2 upgrade" };
  await f.owner.command(f.identity, f.project.projectId,
    { operation: "revise", batchId: batch.batchId, expectedRevision: 1, reasonCode: "owner_edit", proposal: changed },
    "owner-cross-version-revision-0001");
  assert.equal((await f.store.status(agent(), f.project.projectId, batch.batchId,
    new Date(now).toISOString())).state, "proposed");
  assert.equal((await f.store.list(agent(), f.project.projectId, new Date(now).toISOString())).length, 1);
  assert.equal((await f.owner.view(f.identity, f.project.projectId, batch.batchId)).revision, 2);
});

test("a missing durable notification rolls the whole owner decision back", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit();
  await f.db.query("DELETE FROM control_action_inbox WHERE work_item_id=$1", [batch.batchId]);
  await assert.rejects(f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" }, { localId: "check", decision: "approve" }] },
    "owner-batch-missing-notification-0001"), /work_batch_integrity_failed/u);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_jobs")).rows[0]!.count, 0);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batch_items")).rows[0]!.count, 0);
  assert.equal((await f.db.query<{ state: string }>("SELECT state FROM work_batches WHERE id=$1",
    [batch.batchId])).rows[0]!.state, "proposed");
});

test("owner commands refuse proposed-state decision residue before materialization", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit();
  await f.db.query("DROP TRIGGER work_batches_owner_update ON work_batches");
  await f.db.query("UPDATE work_batches SET decision_digest=$1,decision_auth_tag=$2 WHERE id=$3",
    [sha256Digest("tampered decision"), `hmac-sha256:${"0".repeat(64)}`, batch.batchId]);
  await assert.rejects(f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "approve" }, { localId: "check", decision: "approve" }] },
    "owner-batch-residue-0001"), /work_batch_integrity_failed/u);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_jobs")).rows[0]!.count, 0);
});

test("dependency-open partial approval and non-owner decisions leave no owner-command record", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit();
  await assert.rejects(f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "reject", reasonCode: "not_selected" },
        { localId: "check", decision: "approve" }] }, "owner-batch-invalid-0001"), /conflict/u);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_jobs")).rows[0]!.count, 0);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_idempotency WHERE operation_scope LIKE 'work-batches.owner%'")).rows[0]!.count, 0);
  await f.db.query("UPDATE control_role_grants SET role_key='operator' WHERE id='grant:web'");
  await assert.rejects(f.owner.command(f.identity, f.project.projectId,
    { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
      items: [{ localId: "build", decision: "reject", reasonCode: "not_selected" },
        { localId: "check", decision: "reject", reasonCode: "not_selected" }] },
    "owner-batch-non-owner-0001"), /access_denied/u);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batch_items")).rows[0]!.count, 0);
});

test("owner batch HTTP routes are same-origin, bounded and path-bound", async t => {
  const f = await ownerFixture(); t.after(() => void f.db.close());
  const batch = await f.submit(), handler = createWorkBatchOwnerHttpHandlerV1({ origin, trust, service: f.owner, clock: () => now });
  const list = await handler(request(`/api/v1/projects/${encodeURIComponent(f.project.projectId)}/pipelines`));
  assert.equal(list.status, 200); assert.equal((await list.json()).batches.length, 1);
  const path = `/api/v1/projects/${encodeURIComponent(f.project.projectId)}/pipelines/${encodeURIComponent(batch.batchId)}`;
  const mismatch = await handler(request(path, "POST", { operation: "decide", batchId: "batch:other", expectedRevision: 1,
    items: [{ localId: "build", decision: "reject", reasonCode: "not_selected" },
      { localId: "check", decision: "reject", reasonCode: "not_selected" }] }, "owner-http-decision-0001"));
  assert.equal(mismatch.status, 400);
  const decided = await handler(request(path, "POST", { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
    items: [{ localId: "build", decision: "reject", reasonCode: "not_selected" },
      { localId: "check", decision: "reject", reasonCode: "not_selected" }] }, "owner-http-decision-0002"));
  assert.equal(decided.status, 201); assert.equal((await decided.json()).state, "rejected");
});
