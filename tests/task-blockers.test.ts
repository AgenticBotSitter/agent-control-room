import assert from "node:assert/strict";
import test from "node:test";
import { DOMAIN_CONTRACT_VERSION, type NodeRecord } from "../src/domain/v1";
import { TaskBlockerServiceV1 } from "../src/web/v1/task-blocker-service";
import { taskBlockerKinds, taskBlockerRecordSchema, taskBlockerReportSchema } from "../src/web/v1/task-blocker-wire";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { at } from "./native-task-fixture";
import { binding, instant } from "./hermes-native-fixture";
import { sha256Digest } from "../src/security";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskAttentionPanel } from "../private-app/app/needs-me/task-attention";

const blockerKey = new Uint8Array(32).fill(71);

async function activeFixture() {
  const f = await taskAssignmentFixture();
  await f.db.query("UPDATE control_role_grants SET project_ids='[\"*\"]'::jsonb WHERE tenant_id=$1 AND identity_id='identity:test'",
    [binding.tenantId]);
  const assigned = await f.assign();
  const job = await f.canonical.get(binding.tenantId, "job", f.prepared.receipt.jobId);
  const attempt = await f.canonical.get(binding.tenantId, "attempt", assigned.receipt.attemptId);
  assert.equal(job?.kind, "job"); assert.equal(attempt?.kind, "attempt");
  const report = { blockerId: "blocker:test", projectId: binding.projectId, jobId: assigned.receipt.jobId,
    attemptId: assigned.receipt.attemptId, workerId: binding.nodeId, kind: "owner_decision" as const,
    summary: "A decision is needed before the task can continue.", unblock: "Choose the approved interpretation.",
    evidence: [{ label: "Observed state", detail: "Two valid interpretations lead to different outputs." }],
    expectedJobVersion: job.version, expectedAttemptVersion: attempt.version, reportedAt: at(9_000) };
  return { ...f, assigned, report };
}

function service(f: Awaited<ReturnType<typeof activeFixture>>, clock = () => instant + 10_000,
  assign?: ConstructorParameters<typeof TaskBlockerServiceV1>[4]) {
  const coordinator = f.create(f.db, clock);
  return new TaskBlockerServiceV1(f.db, f.scope, blockerKey, clock, assign ?? coordinator.assign.bind(coordinator));
}

test("all structured blocker kinds round-trip through the strict secret-safe contract", () => {
  for (const kind of taskBlockerKinds) {
    const report = taskBlockerReportSchema.parse({ blockerId: `blocker:${kind}`, projectId: "project:test", jobId: "job:test",
      attemptId: "attempt:test", workerId: "worker:test", kind, summary: "Work cannot safely continue.",
      unblock: "Provide the missing safe direction.", evidence: [{ label: "Check", detail: "The required fact is absent." }],
      expectedJobVersion: 2, expectedAttemptVersion: 2, reportedAt: at() });
    const { expectedJobVersion: _jobVersion, expectedAttemptVersion: _attemptVersion, ...reportRecord } = report;
    const record = taskBlockerRecordSchema.parse({ ...reportRecord, schema: "control-room.task-blocker/v1", state: "open",
      resumeJobState: "running", resumeAttemptState: "running", taskOwnerId: "identity:test",
      startsWork: false, grantsExecutionAuthority: false });
    assert.equal(JSON.parse(JSON.stringify(record)).kind, kind);
  }
});

test("blocker event identities are tenant-scoped", async t => {
  const f = await activeFixture(); t.after(f.close);
  const result = await f.db.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='control_task_blocker_events'::regclass AND contype='p'`);
  assert.equal(result.rows[0]?.definition, "PRIMARY KEY (tenant_id, event_id)");
});

test("worker blocker persists across restart, appears only for its owner, and owner unblock resumes the same task", async t => {
  const f = await activeFixture(); t.after(f.close);
  const first = service(f);
  const saved = await first.report(f.report, () => {});
  assert.equal(saved.blocker.state, "open");
  const blockedJob = await f.canonical.get(binding.tenantId, "job", f.report.jobId);
  const blockedAttempt = await f.canonical.get(binding.tenantId, "attempt", f.report.attemptId);
  assert.equal(blockedJob?.state, "blocked"); assert.equal(blockedAttempt?.state, "blocked");
  const pausedLease = await f.db.query<{ state: string }>("SELECT state FROM control_leases WHERE tenant_id=$1 AND attempt_id=$2",
    [binding.tenantId, f.report.attemptId]);
  assert.equal(pausedLease.rows[0]?.state, "revoked");
  const attention = await f.tasks.attention(f.identity);
  assert.equal(attention.items.some(item => item.task.jobId === f.report.jobId && item.reasons.includes("blocked")), true);
  const actionItem = await f.db.query<{ payload: { ownerIdentityId?: string } }>(
    "SELECT payload FROM control_action_inbox WHERE tenant_id=$1 AND work_item_id=$2", [binding.tenantId, f.report.jobId]);
  assert.equal(actionItem.rows[0]?.payload.ownerIdentityId, "identity:test");
  assert.equal((await first.listOpenForOwner(f.identity, [f.report.jobId])).length, 1);
  assert.equal((await first.readForWorker(f.report.blockerId, binding.nodeId, () => {})).state, "open");

  const other = await addOwner(f, "identity:other", "other-owner");
  assert.equal((await f.tasks.attention(other)).items.some(item => item.task.jobId === f.report.jobId), false);
  assert.deepEqual(await first.listOpenForOwner(other, [f.report.jobId]), []);
  await assert.rejects(service(f).act(other, binding.projectId, f.report.jobId, f.report.blockerId,
    { action: "unblock", answer: "Continue." }), /access_denied/);

  const restarted = service(f, () => instant + 80_000);
  const resumed = await restarted.act(f.identity, binding.projectId, f.report.jobId, f.report.blockerId,
    { action: "unblock", answer: "Use the first interpretation." });
  assert.equal(resumed.blocker.state, "resolved");
  const job = await f.canonical.get(binding.tenantId, "job", f.report.jobId);
  const attempt = await f.canonical.get(binding.tenantId, "attempt", f.report.attemptId);
  assert.equal(job?.state, "leased"); assert.equal(attempt?.state, "cancelled");
  assert.notEqual(resumed.blocker.nextAttemptId, f.report.attemptId);
  const resumedLease = await f.db.query<{ state: string; node_id: string }>(
    "SELECT state,node_id FROM control_leases WHERE tenant_id=$1 AND job_id=$2 ORDER BY epoch", [binding.tenantId, f.report.jobId]);
  assert.deepEqual(resumedLease.rows.map(row => row.state), ["revoked", "active"]);
  assert.equal(resumedLease.rows[1]?.node_id, binding.nodeId);
  const delivered = await restarted.readForWorker(f.report.blockerId, binding.nodeId, () => {});
  assert.equal(delivered.ownerAnswer, "Use the first interpretation.");
});

test("self-unblock and secret-bearing blocker reports are refused", async t => {
  const f = await activeFixture(); t.after(f.close);
  const blockers = service(f);
  await assert.rejects(blockers.report({ ...f.report, reportedAt: at(-1_000) }, () => {}), /conflict/);
  await assert.rejects(blockers.report({ ...f.report, summary: "api_key=sk_test_abcdefghijklmnopqrstuvwxyz" }, () => {}), /secret material/);
  const workerAsHuman = await addOwner(f, binding.nodeId, "worker-owner");
  const job = await f.canonical.get(binding.tenantId, "job", f.report.jobId); assert.equal(job?.kind, "job");
  const workflow = await f.canonical.get(binding.tenantId, "workflow", job.workflowId); assert.equal(workflow?.kind, "workflow");
  await f.db.query(`UPDATE control_requests SET payload=jsonb_set(payload,'{requestedBy}',$1::jsonb)
    WHERE tenant_id=$2 AND id=$3`, [JSON.stringify({ actorId: binding.nodeId, actorType: "human" }), binding.tenantId, workflow.requestId]);
  await blockers.report(f.report, () => {});
  await assert.rejects(blockers.act(workerAsHuman, binding.projectId, f.report.jobId, f.report.blockerId,
    { action: "unblock", answer: "Resume." }), /access_denied/);
});

test("handoff fences the old lease, links a new attempt on the same task, and leaves only one active execution", async t => {
  const f = await activeFixture(); t.after(f.close);
  const nodeId = "node:handoff";
  const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: binding.tenantId, version: 0,
    createdAt: at(), updatedAt: at() } as const;
  const node: NodeRecord = { ...common, kind: "node", id: nodeId, displayName: "Handoff worker", state: "pending_enrollment",
    platform: "linux", architecture: "x64", identityKeyId: "key:handoff",
    hardwareFingerprint: sha256Digest("handoff-hardware"), softwareFingerprint: sha256Digest("handoff-software"),
    policyVersion: "1.0.0", minimumProtocolVersion: "control-room-node/v1" };
  await f.canonical.create(node);
  await f.canonical.transition({ tenantId: binding.tenantId, kind: "node", entityId: nodeId, expectedVersion: 0,
    toState: "active", transitionId: "transition:handoff-node", idempotencyKey: "handoff-node-active",
    actor: { actorId: "identity:test", actorType: "human" }, occurredAt: at(8_500), recordPatch: { enrolledAt: at(8_500) } });
  let assignedReceipt: Awaited<ReturnType<NonNullable<ConstructorParameters<typeof TaskBlockerServiceV1>[4]>>>["receipt"] | undefined;
  let failAfterAssignment = false;
  const handoffAssign = async (_identity: VerifiedWebIdentity, _projectId: string, jobId: string, targetNodeId: string) => {
    if (assignedReceipt) return { receipt: assignedReceipt, replayed: true };
    const job = await f.canonical.get(binding.tenantId, "job", jobId); assert.equal(job?.kind, "job");
    const claimed = await f.canonical.claimReadyJob({ tenantId: binding.tenantId, jobId, expectedJobVersion: job.version,
      nodeId: targetNodeId, attemptId: "attempt:handoff:2", leaseId: "lease:handoff:2",
      transitionId: "transition:handoff:claim", idempotencyKey: "handoff:claim", actor: { actorId: "identity:test", actorType: "human" },
      acquiredAt: at(10_500), expiresAt: at(50_000) });
    assignedReceipt = { projectId: binding.projectId, jobId, inputDigest: claimed.job.inputDigest, nodeId: targetNodeId,
      attemptId: claimed.attempt.id, leaseId: claimed.lease.id, leaseEpoch: claimed.lease.epoch,
      acquiredAt: claimed.lease.acquiredAt, expiresAt: claimed.lease.expiresAt, leaseState: claimed.lease.state,
      leaseCurrent: true, startsWork: false as const, grantsExecutionAuthority: false as const };
    if (failAfterAssignment) { failAfterAssignment = false; throw new Error("simulated completion crash"); }
    return { receipt: assignedReceipt, replayed: claimed.replayed };
  };
  const blockers = service(f, () => instant + 10_000, handoffAssign);
  await blockers.report(f.report, () => {});
  await assert.rejects(blockers.act(f.identity, binding.projectId, f.report.jobId, f.report.blockerId,
    { action: "handoff", targetNodeId: binding.nodeId }), /conflict/);
  failAfterAssignment = true;
  await assert.rejects(blockers.act(f.identity, binding.projectId, f.report.jobId, f.report.blockerId,
    { action: "handoff", targetNodeId: nodeId }), /simulated completion crash/);
  const result = await blockers.act(f.identity, binding.projectId, f.report.jobId, f.report.blockerId,
    { action: "handoff", targetNodeId: nodeId });
  assert.equal(result.blocker.state, "handed_off");
  assert.equal(result.blocker.priorAttemptId, f.report.attemptId); assert.equal(result.blocker.nextAttemptId, "attempt:handoff:2");
  const leases = await f.db.query<{ id: string; state: string }>(
    "SELECT id,state FROM control_leases WHERE tenant_id=$1 AND job_id=$2 ORDER BY epoch", [binding.tenantId, f.report.jobId]);
  assert.deepEqual(leases.rows.map(row => row.state), ["revoked", "active"]);
  assert.equal(leases.rows.filter(row => row.state === "active").length, 1);
  const link = await f.db.query<{ prior_attempt_id: string; next_attempt_id: string }>(`SELECT h.prior_attempt_id,c.next_attempt_id
    FROM control_task_blocker_handoffs h JOIN control_task_blocker_handoff_completions c
    ON c.tenant_id=h.tenant_id AND c.blocker_id=h.blocker_id WHERE h.tenant_id=$1 AND h.blocker_id=$2`,
  [binding.tenantId, f.report.blockerId]);
  assert.deepEqual(link.rows[0], { prior_attempt_id: f.report.attemptId, next_attempt_id: "attempt:handoff:2" });
});

test("owner attention renders structured blocker evidence and all recovery actions", async t => {
  const f = await activeFixture(); t.after(f.close);
  const blockers = service(f); const saved = await blockers.report(f.report, () => {});
  const page = await f.tasks.attention(f.identity);
  const enriched = { ...page, items: page.items.map(item => item.task.jobId === f.report.jobId
    ? { ...item, blocker: saved.blocker } : item) };
  const html = renderToStaticMarkup(React.createElement(TaskAttentionPanel, { page: enriched }));
  assert.match(html, /A decision is needed/); assert.match(html, /Two valid interpretations/);
  assert.match(html, /Answer and resume/); assert.match(html, /Hand off task/); assert.match(html, /Cancel task/);
});

test("owner cancellation closes the blocker and terminally fences its attempt", async t => {
  const f = await activeFixture(); t.after(f.close);
  const blockers = service(f);
  await blockers.report(f.report, () => {});
  const cancelled = await blockers.act(f.identity, binding.projectId, f.report.jobId, f.report.blockerId,
    { action: "cancel", reason: "The task is no longer needed." });
  assert.equal(cancelled.blocker.state, "cancelled");
  assert.equal((await f.canonical.get(binding.tenantId, "job", f.report.jobId))?.state, "cancelled");
  assert.equal((await f.canonical.get(binding.tenantId, "attempt", f.report.attemptId))?.state, "cancelled");
  const lease = await f.db.query<{ state: string }>("SELECT state FROM control_leases WHERE tenant_id=$1 AND attempt_id=$2",
    [binding.tenantId, f.report.attemptId]);
  assert.equal(lease.rows[0]?.state, "revoked");
});

test("failed reassignment remains visible and the owner can cancel the pending recovery", async t => {
  const f = await activeFixture(); t.after(f.close);
  const blockers = service(f, () => instant + 10_000, async () => { throw new Error("target unavailable"); });
  await blockers.report(f.report, () => {});
  await assert.rejects(blockers.act(f.identity, binding.projectId, f.report.jobId, f.report.blockerId,
    { action: "unblock", answer: "Continue when capacity is available." }), /target unavailable/);
  assert.equal((await f.canonical.get(binding.tenantId, "job", f.report.jobId))?.state, "ready");
  const other = await addOwner(f, "identity:pending-other", "pending-other-owner");
  const coordinator = f.create(f.db, () => instant + 10_000);
  await assert.rejects(coordinator.assign(other, binding.projectId, f.report.jobId, binding.nodeId,
    f.prepared.receipt.inputDigest), /conflict/);
  const attention = await f.tasks.attention(f.identity);
  assert.equal(attention.items.some(item => item.task.jobId === f.report.jobId && item.reasons.includes("blocked")), true);
  assert.equal((await blockers.listOpenForOwner(f.identity, [f.report.jobId]))[0]?.state, "handoff_pending");
  const cancelled = await blockers.act(f.identity, binding.projectId, f.report.jobId, f.report.blockerId,
    { action: "cancel", reason: "No replacement capacity is available." });
  assert.equal(cancelled.blocker.state, "cancelled");
  assert.equal((await f.canonical.get(binding.tenantId, "job", f.report.jobId))?.state, "cancelled");
});

async function addOwner(f: Awaited<ReturnType<typeof activeFixture>>, identityId: string, subject: string): Promise<VerifiedWebIdentity> {
  const identity: VerifiedWebIdentity = { provider: f.identity.provider, subject,
    tokenDigest: sha256Digest({ subject, token: "synthetic" }), issuedAt: at(-1_000), expiresAt: at(100_000),
    verificationExpiresAt: at(100_000) };
  await f.db.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Other owner',$3,$4,'active',$5,$5)`, [identityId, binding.tenantId, identity.provider,
    sha256Digest({ provider: identity.provider, subject }), at(-2_000)]);
  await f.db.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,created_at,updated_at)
    VALUES($1,$2,$3,'owner',$4::jsonb,$5::jsonb,'critical',$6,$6)`, [`grant:${identityId}`, binding.tenantId, identityId,
    JSON.stringify(["tasks.read", "tasks.assign", "projects.read"]), JSON.stringify(["*"]), at(-2_000)]);
  return identity;
}
