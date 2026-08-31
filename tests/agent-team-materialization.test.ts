import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  AgentTeamContractErrorV1,
  AgentTeamDurableStoreV1,
  buildAgentTeamFixtureV1,
  buildAgentTeamHandoffMaterializationV1,
  buildAgentTeamHandoffReviewV1,
  persistAgentTeamHandoffMaterializationV1,
  projectAgentTeamHandoffReviewV1,
} from "../src/agent-team/v1/index.ts";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";
import { adaptPglite } from "../src/persistence/database.ts";
import { InMemoryRollbackCheckpointStoreV1, sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const projectId = "project.test.team-materialization";
const scope = { tenantId: "tenant.owner", workspaceId: "workspace.control-room", projectId };
const workspace = buildAgentTeamFixtureV1(projectId);
const room = workspace.rooms[0]!;
const proposal = workspace.handoffProposals[0]!;
const t0 = "2026-08-30T12:40:00.000Z";
const t1 = "2026-08-30T12:41:00.000Z";
const t2 = "2026-08-31T12:41:00.000Z";
const key = new Uint8Array(32).fill(0x3c);

function review(decision: "accepted" | "rejected" | "withdrawn" = "accepted", overrides: Record<string, unknown> = {}) {
  return buildAgentTeamHandoffReviewV1({ ...scope, reviewId: `review.team.${decision}.1`, proposal, decision,
    safeReasonCode: decision === "accepted" ? "owner_accepts_exact_handoff" : "owner_declines_exact_handoff",
    reviewerActorDigest: sha256Digest({ actor: "owner" }), ownerAuthenticationEvidenceDigest: sha256Digest({ session: "synthetic-owner-auth" }),
    reviewedAt: t0, ...overrides });
}

function receipt() {
  return buildAgentTeamHandoffMaterializationV1({ ...scope, proposal, acceptedReview: review(), materializedAt: t1, authorityExpiresAt: t2 });
}

function expectCode(operation: () => unknown, code: AgentTeamContractErrorV1["safeCode"]): void {
  assert.throws(operation, (error) => error instanceof AgentTeamContractErrorV1 && error.safeCode === code);
}

async function database() {
  const db = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(await readFile(resolve("db/migrations", file), "utf8"));
  }
  await db.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)", [scope.tenantId, "Owner"]);
  return db;
}

function seedDurable(store: AgentTeamDurableStoreV1): void {
  store.recordRoomPolicy({ ...scope, policyEventId: "policy.team.materialize.1", roomId: room.roomId, roomLabel: room.label,
    memberAgentIds: room.memberAgentIds, revision: 1, legalHoldState: "none", occurredAt: "2026-08-30T11:59:00.000Z" });
  for (const message of room.messages) store.appendRoomEvent({ ...scope, eventId: `event.${message.messageId}`,
    roomId: room.roomId, roomLabel: room.label, messageId: message.messageId, roomSequence: message.sequence, round: message.round,
    authorKind: message.authorKind, authorId: message.authorId, safeSummary: message.safeSummary,
    mentionedAgentIds: message.mentionedAgentIds, mentionsOwner: message.mentionsOwner, needsOwner: message.needsOwner,
    occurredAt: message.occurredAt });
  store.saveHandoffDraft(proposal);
}

test("CR11A TEAM-030 owner review is exact, authenticated evidence and never approval or dispatch", () => {
  const accepted = review(), rejected = review("rejected"), withdrawn = review("withdrawn");
  assert.deepEqual({ owner: accepted.isOwnerReview, approval: accepted.grantsApproval, dispatch: accepted.grantsDispatchAuthority,
    lease: accepted.grantsLeaseAuthority, execution: accepted.grantsExecutionAuthority },
  { owner: true, approval: false, dispatch: false, lease: false, execution: false });
  const pending = projectAgentTeamHandoffReviewV1({ tenantId: scope.tenantId, projectId, proposal });
  assert.deepEqual({ state: pending.reviewState, inbox: pending.actionInbox.state, responses: pending.actionInbox.legalResponses.map((item) => item.kind) },
    { state: "awaiting_owner", inbox: "open", responses: ["record_decision", "decline", "decline"] });
  const declined = projectAgentTeamHandoffReviewV1({ tenantId: scope.tenantId, projectId, proposal, review: rejected });
  assert.deepEqual({ state: declined.reviewState, inbox: declined.actionInbox.state, work: declined.createsWorkItem },
    { state: "rejected", inbox: "resolved", work: false });
  const withdrawnView = projectAgentTeamHandoffReviewV1({ tenantId: scope.tenantId, projectId, proposal, review: withdrawn });
  assert.deepEqual({ state: withdrawnView.reviewState, inbox: withdrawnView.actionInbox.state, reason: withdrawnView.actionInbox.reasonCode,
    work: withdrawnView.createsWorkItem }, { state: "withdrawn", inbox: "resolved", reason: "agent_team_handoff_withdrawn", work: false });
  expectCode(() => buildAgentTeamHandoffMaterializationV1({ ...scope, proposal, acceptedReview: rejected,
    materializedAt: t1, authorityExpiresAt: t2 }), "invalid_input");
});

test("CR11A TEAM-030 materializes one non-runnable canonical bundle and Action Inbox item atomically", async () => {
  const value = receipt();
  assert.deepEqual({ request: value.request.state, workflow: value.workflow.state, job: value.job.state,
    attempt: value.createsAttempt, lease: value.createsLease, dispatch: value.dispatchState, approval: value.grantsApproval,
    network: value.job.authority.networkPolicy, effects: value.job.authority.effectPolicy, concurrency: value.job.authority.maxConcurrentEffects },
  { request: "draft", workflow: "proposed", job: "proposed", attempt: false, lease: false, dispatch: "not_requested",
    approval: false, network: "none", effects: "none", concurrency: 0 });
  const materializedView = projectAgentTeamHandoffReviewV1({ tenantId: scope.tenantId, projectId, proposal, review: review(), receipt: value });
  assert.deepEqual({ state: materializedView.reviewState, inbox: materializedView.actionInbox.state, work: materializedView.createsWorkItem,
    dispatch: materializedView.dispatchState, canonical: materializedView.materializedWork },
  { state: "materialized_proposed", inbox: "resolved", work: true, dispatch: "not_requested",
    canonical: { requestId: value.request.id, workflowId: value.workflow.id, jobId: value.job.id, state: "proposed" } });
  const db = await database();
  try {
    const canonical = new CanonicalStore(adaptPglite(db));
    assert.equal((await persistAgentTeamHandoffMaterializationV1({ canonicalStore: canonical, receipt: value })).replayed, false);
    assert.equal((await persistAgentTeamHandoffMaterializationV1({ canonicalStore: new CanonicalStore(adaptPglite(db)), receipt: value })).replayed, true);
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_requests)::text requests,
      (SELECT count(*) FROM control_workflows)::text workflows,
      (SELECT count(*) FROM control_jobs)::text jobs,
      (SELECT count(*) FROM control_action_inbox)::text inbox,
      (SELECT count(*) FROM control_attempts)::text attempts,
      (SELECT count(*) FROM control_leases)::text leases,
      (SELECT count(*) FROM control_effect_intents)::text effects,
      (SELECT count(*) FROM control_approvals)::text approvals,
      (SELECT count(*) FROM control_outbox)::text outbox`);
    assert.deepEqual(counts.rows[0], { requests: "1", workflows: "1", jobs: "1", inbox: "1", attempts: "0", leases: "0",
      effects: "0", approvals: "0", outbox: "0" });
    await assert.rejects(canonical.createProposedWorkBundleWithActionInbox({ request: { ...value.request, title: "Changed replay" },
      workflow: value.workflow, job: value.job, actionInbox: value.actionInbox }), /replay conflict/);
    await assert.rejects(canonical.createProposedWorkBundleWithActionInbox({ request: value.request, workflow: value.workflow,
      job: value.job, actionInbox: { ...value.actionInbox, createdAt: t2 } }), /attention conflict/);
    await assert.rejects(canonical.createProposedWorkBundleWithActionInbox({ request: value.request, workflow: value.workflow,
      job: value.job, actionInbox: { ...value.actionInbox, requestedAction: "Changed attention" } }), /attention contract mismatch/);
  } finally { await db.close(); }
  const collisionDb = await database();
  try {
    const changedAttention = { ...value.actionInbox, createdAt: t2 };
    await collisionDb.query(`INSERT INTO control_action_inbox(id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [changedAttention.id, changedAttention.tenantId,
      changedAttention.projectId, changedAttention.workItemId, changedAttention.kind, changedAttention.state,
      changedAttention.deliveryState, changedAttention.createdAt, null, JSON.stringify(changedAttention)]);
    const canonical = new CanonicalStore(adaptPglite(collisionDb));
    await assert.rejects(persistAgentTeamHandoffMaterializationV1({ canonicalStore: canonical, receipt: value }), /attention conflict/);
    const rolledBack = await collisionDb.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_requests)::text requests,
      (SELECT count(*) FROM control_workflows)::text workflows,
      (SELECT count(*) FROM control_jobs)::text jobs,
      (SELECT count(*) FROM control_action_inbox)::text inbox`);
    assert.deepEqual(rolledBack.rows[0], { requests: "0", workflows: "0", jobs: "0", inbox: "1" });
  } finally { await collisionDb.close(); }
});

test("CR11A TEAM-030 authenticated reviews survive restart and changed or second decisions fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-room-team-review-")); await chmod(directory, 0o700);
  const path = join(directory, "team.sqlite"), checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  try {
    let store = new AgentTeamDurableStoreV1(path, scope, key, checkpoints); seedDurable(store);
    const accepted = review();
    assert.equal(store.recordHandoffReview(accepted).replayed, false);
    assert.equal(store.recordHandoffReview(accepted).replayed, true);
    expectCode(() => store.recordHandoffReview(review("rejected")), "replay_drift");
    store.closeDatabase();
    store = new AgentTeamDurableStoreV1(path, scope, key, checkpoints);
    assert.deepEqual(store.listHandoffReviews(), [accepted]);
    assert.equal(store.recordHandoffReview(accepted).replayed, true);
    store.closeDatabase();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CR11A TEAM-030 strictly upgrades an authenticated TEAM-020 ledger before accepting reviews", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-room-team-upgrade-")); await chmod(directory, 0o700);
  const path = join(directory, "team.sqlite"), checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  try {
    const current = new AgentTeamDurableStoreV1(path, scope, key, checkpoints); seedDurable(current); current.closeDatabase();
    const db = new DatabaseSync(path);
    db.exec(`BEGIN IMMEDIATE;
      DROP INDEX idx_agent_team_ledger_room_sequence;
      DROP INDEX idx_agent_team_ledger_kind_subject;
      ALTER TABLE agent_team_ledger_record RENAME TO agent_team_ledger_record_v2;
      CREATE TABLE agent_team_ledger_record (
        ledger_sequence INTEGER PRIMARY KEY CHECK(ledger_sequence>=1), record_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('room_event','read_receipt','handoff_draft','room_policy')),
        room_id TEXT NOT NULL, subject_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
        record_digest TEXT NOT NULL CHECK(length(record_digest)=71), record_json TEXT NOT NULL,
        record_auth_tag TEXT NOT NULL CHECK(length(record_auth_tag)=76)
      );
      INSERT INTO agent_team_ledger_record SELECT * FROM agent_team_ledger_record_v2 ORDER BY ledger_sequence;
      DROP TABLE agent_team_ledger_record_v2;
      CREATE INDEX idx_agent_team_ledger_room_sequence ON agent_team_ledger_record(room_id,ledger_sequence);
      CREATE INDEX idx_agent_team_ledger_kind_subject ON agent_team_ledger_record(kind,subject_id,ledger_sequence);
      PRAGMA user_version=1;
      COMMIT;`);
    db.close();
    const upgraded = new AgentTeamDurableStoreV1(path, scope, key, checkpoints);
    assert.equal(upgraded.recordHandoffReview(review()).replayed, false);
    assert.deepEqual(upgraded.listHandoffReviews(), [review()]);
    upgraded.closeDatabase();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CR11A TEAM-030 rejects stale lineage, scope drift, unsafe input, accessors, and proxies", () => {
  const accepted = review();
  const stale = { ...proposal, proposalDigest: sha256Digest({ stale: true }) };
  expectCode(() => buildAgentTeamHandoffMaterializationV1({ ...scope, proposal: stale, acceptedReview: accepted,
    materializedAt: t1, authorityExpiresAt: t2 }), "digest_mismatch");
  expectCode(() => buildAgentTeamHandoffReviewV1({ ...scope, projectId: "project.foreign", reviewId: "review.foreign", proposal,
    decision: "accepted", safeReasonCode: "owner_accepts_exact_handoff", reviewerActorDigest: sha256Digest({ actor: "owner" }),
    ownerAuthenticationEvidenceDigest: sha256Digest({ session: "synthetic-owner-auth" }), reviewedAt: t0 }), "scope_mismatch");
  expectCode(() => buildAgentTeamHandoffReviewV1({ ...scope, reviewId: "review.unsafe", proposal, decision: "accepted",
    safeReasonCode: "owner_accepts_exact_handoff", reviewerActorDigest: sha256Digest({ actor: "owner" }),
    ownerAuthenticationEvidenceDigest: sha256Digest({ session: "synthetic-owner-auth" }), reviewedAt: t0, rawCredential: "forbidden" }), "invalid_input");
  let getters = 0; const accessor = { ...proposal };
  Object.defineProperty(accessor, "goal", { enumerable: true, get() { getters += 1; return proposal.goal; } });
  expectCode(() => buildAgentTeamHandoffReviewV1({ ...scope, reviewId: "review.accessor", proposal: accessor, decision: "accepted",
    safeReasonCode: "owner_accepts_exact_handoff", reviewerActorDigest: sha256Digest({ actor: "owner" }),
    ownerAuthenticationEvidenceDigest: sha256Digest({ session: "synthetic-owner-auth" }), reviewedAt: t0 }), "invalid_input");
  assert.equal(getters, 0);
  const proxied = observedProxy(proposal, "transparent");
  expectCode(() => buildAgentTeamHandoffReviewV1({ ...scope, reviewId: "review.proxy", proposal: proxied.value, decision: "accepted",
    safeReasonCode: "owner_accepts_exact_handoff", reviewerActorDigest: sha256Digest({ actor: "owner" }),
    ownerAuthenticationEvidenceDigest: sha256Digest({ session: "synthetic-owner-auth" }), reviewedAt: t0 }), "invalid_input");
  assert.equal(proxied.trapCount(), 0);
});
