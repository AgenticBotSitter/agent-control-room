import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { sha256Digest } from "../src/security";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { WebTaskService } from "../src/web/v1/task-service";
import { taskResultsPageSchema } from "../src/web/v1/task-result-wire";
import { createTaskHttpHandler } from "../src/web/v1/task-http";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { request, origin } from "./helpers/web-foundation";
const key = "owner-review-command-001";
const scope = `completion-gate:${binding.tenantId}`;

test("owner quality acceptance records one immutable review and waits for existing required verification", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  assert.equal((await f.reviews.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id)).canReview, true);
  const before = f.checkpoints.read(scope)!;
  const saved = await f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, key);
  assert.equal(saved.replayed, false); assert.equal(saved.receipt.findingId, null); assert.equal(saved.receipt.grantsExecutionAuthority, false);
  assert.equal(f.checkpoints.read(scope)!.revision, before.revision + 1);
  const snapshot = await f.reviewStore.snapshot(binding.tenantId, f.target.id);
  assert.equal(snapshot.status, "pending"); assert.deepEqual(snapshot.acceptedReviewIds, [saved.receipt.reviewId]);
  assert.deepEqual(snapshot.missingVerificationScenarioIds, ["scenario:content"]);
  await f.reviewStore.recordVerification({ schemaVersion: "control-room-completion-gate/v1", id: "verification:owner-result",
    tenantId: binding.tenantId, projectId: binding.projectId, targetId: f.target.id, targetDigest: sha256Digest(f.target),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile), scenarioId: "scenario:content", outcome: "passed",
    verifier: { actorId: "identity:verifier", actorType: "human" }, evidenceDigests: [f.artifact.contentHash], verifiedAt: at(6000),
    grantsApproval: false, grantsExecutionAuthority: false });
  assert.equal((await f.reviewStore.snapshot(binding.tenantId, f.target.id)).status, "ready");
  const options = await f.reviews.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id);
  assert.equal(options.availability, "already_reviewed"); assert.equal(options.ownReview?.decision, "accepted");
  assert.equal((await f.tasks.detail(f.identity, binding.projectId, binding.jobId)).task.state, "leased");
  for (const table of ["control_effect_intents", "control_approvals"])
    assert.equal((await f.db.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 0);
});

test("requesting changes records the existing negative review/finding and privately retains exact owner feedback", async t => {
  const f = await ownerReviewFixture(); t.after(f.close); const checkpoint = f.checkpoints.read(scope)!;
  const feedback = "Please explain the prerequisites and include a plain-text example.";
  const saved = await f.reviews.record(f.identity, binding.projectId, binding.jobId, { ...f.draft, decision: "changes_requested", feedback }, key);
  assert.ok(saved.receipt.findingId); assert.equal(saved.receipt.startsRevision, false);
  assert.equal(f.checkpoints.read(scope)!.revision, checkpoint.revision + 2);
  const snapshot = await f.reviewStore.snapshot(binding.tenantId, f.target.id);
  assert.equal(snapshot.status, "changes_requested"); assert.deepEqual(snapshot.openFindingIds, [saved.receipt.findingId]);
  const options = await f.reviews.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id);
  assert.equal(options.ownReview?.feedback, feedback);
  assert.equal(JSON.stringify((await f.db.query("SELECT * FROM audit_events")).rows).includes(feedback), false);
  assert.equal((await f.db.query("SELECT id FROM control_attempts")).rows.length, 1);
  assert.equal((await f.db.query("SELECT id FROM control_completion_gate_records WHERE kind='revision'")).rows.length, 0);
});

test("concurrent exact commands and lost acknowledgement reconcile the original quality decision without another checkpoint advance", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const values = await Promise.all(Array.from({ length: 3 }, () => f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, key)));
  assert.equal(values.filter(v => !v.replayed).length, 1); assert.equal(new Set(values.map(v => v.receipt.reviewId)).size, 1);
  const checkpoint = f.checkpoints.read(scope);
  assert.deepEqual((await f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, key)).receipt, values[0].receipt);
  assert.deepEqual(f.checkpoints.read(scope), checkpoint);
  await assert.rejects(f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, "another-review-command-001"), { code: "conflict" });
  await assert.rejects(f.reviews.record(f.identity, binding.projectId, binding.jobId, { ...f.draft, decision: "changes_requested", feedback: "Different" }, key), { code: "conflict" });
});

test("a committed but lost SQL acknowledgement is recovered through the exact receipt", async t => {
  const f = await ownerReviewFixture(); t.after(f.close); let lost = false;
  const db: DatabaseClient = { ...f.db, async transactionWithPreCommitCheck(work, check) {
    const value = await f.db.transactionWithPreCommitCheck(work, check); if (!lost) { lost = true; throw new Error("synthetic_lost_ack"); } return value;
  } };
  await assert.rejects(f.createReviews(db).record(f.identity, binding.projectId, binding.jobId, f.draft, key), /synthetic_lost_ack/);
  const checkpoint = f.checkpoints.read(scope);
  const saved = await f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, key);
  assert.equal(saved.replayed, true); assert.deepEqual(f.checkpoints.read(scope), checkpoint);
});

function intercept(db: DatabaseClient, after: (sql: string) => void): DatabaseClient {
  const session = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) { const result = await tx.query<T>(sql, params); after(sql); return result; } });
  return { query: db.query.bind(db), transaction: work => db.transaction(tx => work(session(tx))),
    transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(tx => work(session(tx)), check) };
}

test("ordinary SQL failure and expired final session checks leave both checkpoint and review history unchanged", async t => {
  for (const mode of ["sql_failure", "session_expiry", "grant_expiry"] as const) await t.test(mode, async t => {
    const f = await ownerReviewFixture(); t.after(f.close); let now = instant + 6000;
    if (mode === "grant_expiry") await f.db.query("UPDATE control_role_grants SET expires_at=$1", [at(6100)]);
    const checkpoint = f.checkpoints.read(scope), count = (await f.db.query("SELECT id FROM control_completion_gate_records")).rows.length;
    const db = intercept(f.db, sql => { if (sql.includes("INSERT INTO audit_events")) {
      if (mode === "sql_failure") throw new Error("synthetic_sql_failure");
      now = mode === "grant_expiry" ? instant + 6200 : Date.parse(f.identity.expiresAt) + 1;
    } });
    await assert.rejects(f.createReviews(db, () => now).record(f.identity, binding.projectId, binding.jobId,
      { ...f.draft, decision: "changes_requested", feedback: "Fix this detail." }, key));
    assert.deepEqual(f.checkpoints.read(scope), checkpoint);
    assert.equal((await f.db.query("SELECT id FROM control_completion_gate_records")).rows.length, count);
    assert.equal((await f.db.query("SELECT * FROM control_web_task_review_commands")).rows.length, 0);
    assert.equal((await f.reviewStore.snapshot(binding.tenantId, f.target.id)).status, "pending");
  });
});

test("a rollback after checkpoint flush fails closed and is never repaired or retried automatically", async t => {
  const f = await ownerReviewFixture(); t.after(f.close); const before = f.checkpoints.read(scope)!;
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(work, () => {
    check(); throw new Error("synthetic_commit_outcome_uncertain");
  }) };
  await assert.rejects(f.createReviews(db).record(f.identity, binding.projectId, binding.jobId, f.draft, key), /synthetic_commit_outcome_uncertain/);
  assert.equal((await f.db.query("SELECT * FROM control_web_task_review_commands")).rows.length, 0);
  assert.equal(f.checkpoints.read(scope)!.revision, before.revision + 1);
  await assert.rejects(f.reviewStore.snapshot(binding.tenantId, f.target.id), /integrity_failed/);
  await assert.rejects(f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, key), /integrity_failed/);
});

test("owner-only review grants, content grants and session revocation are enforced", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  await f.db.query("UPDATE control_role_grants SET role_key='operator'");
  assert.equal((await f.reviews.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id)).canReview, false);
  await assert.rejects(f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, key), { code: "access_denied" });
  await f.db.query(`UPDATE control_role_grants SET role_key='owner',allowed_actions='["projects.read","tasks.read","tasks.reviews.record"]'::jsonb`);
  await assert.rejects(f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, key), { code: "access_denied" });
  await f.db.query(`UPDATE control_role_grants SET allowed_actions='["*"]'::jsonb`);
  await f.db.query("UPDATE control_web_sessions SET revoked_at=$1", [at(6000)]);
  await assert.rejects(f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, key), { code: "authentication_required" });
});

test("profile independence and conservative risk floor constrain owner review availability", async t => {
  for (const mode of ["separation", "risk"] as const) await t.test(mode, async t => {
    const f = await ownerReviewFixture({ profile: mode === "risk" ? { minimumRisk: "high" }
      : { reviewerSeparation: { actor: true, worker: false, agentProfile: false, harness: true, modelFamily: false } } }); t.after(f.close);
    if (mode === "risk") await f.db.query("UPDATE control_role_grants SET risk_ceiling='low'");
    const options = await f.reviews.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id);
    assert.equal(options.availability, mode === "risk" ? "access_denied" : "independence_required");
    await assert.rejects(f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, key));
    assert.equal((await f.db.query("SELECT * FROM control_web_task_review_commands")).rows.length, 0);
  });
});

test("changed target/content, wrong scope, missing bytes and invalid feedback cannot record a review", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  for (const draft of [{ ...f.draft, contentHash: sha256Digest("other") }, { ...f.draft, targetDigest: sha256Digest("other") },
    { ...f.draft, artifactId: "artifact:other" }, { ...f.draft, targetId: "target:other" },
    { ...f.draft, decision: "changes_requested", feedback: " " }, { ...f.draft, decision: "changes_requested", feedback: "Text\0text" },
    { ...f.draft, decision: "changes_requested", feedback: "界".repeat(1400) },
    { ...f.draft, decision: "changes_requested", feedback: "Bearer synthetic_private_token_123456789012345" }, { ...f.draft, reviewer: "identity:other" }])
    await assert.rejects(f.reviews.record(f.identity, binding.projectId, binding.jobId, draft, key));
  await assert.rejects(f.reviews.record(f.identity, "project:other", binding.jobId, f.draft, key));
  const missing = f.createReviews(f.db, undefined, { results: { ...f.config, storage: { ...f.storage, read: async () => undefined } } });
  await assert.rejects(missing.record(f.identity, binding.projectId, binding.jobId, f.draft, key));
  assert.equal((await f.db.query("SELECT * FROM control_web_task_review_commands")).rows.length, 0);
});

test("authenticated HTTP records quality and restricted SQL permits only the intended review/finding path", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8")); await f.raw.exec("SET ROLE control_room_private_web");
  const app = createPrivateWebProcess({ ...f.accessTrust, origin, tenantId: binding.tenantId, workspaceId: f.scope.workspaceId,
    tasks: { ...f.ownerKeys, harnessIntegrityKey: f.harnessKey }, loadKeys: async () => f.accessTrust.keys,
    database: { client: f.db, close: async () => {} }, clock: () => instant + 6000 }); t.after(() => app.close());
  const path = `/api/v1/projects/${binding.projectId}/tasks/${binding.jobId}/results/${f.artifact.artifactId}/reviews/${f.target.id}`;
  const req = (method = "GET", body?: unknown, k?: string) => request(path, method, body, k, f.jwt);
  const handle = (request: Request) => app.handle(request, () => new Response("shell"));
  assert.equal((await handle(req())).status, 200);
  const saved = await handle(req("POST", { ...f.draft, decision: "changes_requested", feedback: "Please improve the example." }, key));
  assert.equal(saved.status, 201, await saved.clone().text());
  assert.equal((await handle(req())).status, 200);
  const denied = req("POST", f.draft, key); denied.headers.set("origin", "https://different.example.invalid");
  assert.equal((await handle(denied)).status, 403);
  for (const sql of ["INSERT INTO control_artifact_manifests DEFAULT VALUES", "INSERT INTO control_effect_intents DEFAULT VALUES",
    "UPDATE control_jobs SET state='succeeded'", "UPDATE control_completion_gate_records SET web_lock=false", "DELETE FROM control_web_task_review_commands"])
    await assert.rejects(f.db.query(sql));
  for (const kind of ["profile", "target", "verification", "revision", "preference", "approval_request", "approval_decision"]) {
    await assert.rejects(f.db.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,
      parent_id,record_digest,record_auth_tag,payload,occurred_at) SELECT 'record:forbidden:'||$1,tenant_id,project_id,$1,
      'record:forbidden:'||$1,subject_id,parent_id,record_digest,record_auth_tag,payload,occurred_at
      FROM control_completion_gate_records WHERE kind='profile' LIMIT 1`, [kind]), /private quality insert rejected/);
  }
  assert.equal((await app.handle(request("/api/v1/session/logout", "POST", undefined, undefined, f.jwt), () => new Response())).status, 204);
  assert.equal((await handle(req())).status, 401);
});

test("read-only configuration stays read-only and malformed review HTTP cannot redirect a decision", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const tasks = new WebTaskService(f.db, f.scope, () => instant + 6000, f.ownerKeys);
  assert.equal(taskResultsPageSchema.parse(await tasks.results(f.identity, binding.projectId, binding.jobId)).reviewCommands, "configured");
  const path = `/api/v1/projects/${binding.projectId}/tasks/${binding.jobId}/results/${f.artifact.artifactId}/reviews/${f.target.id}`;
  const off = createTaskHttpHandler({ origin, trust: f.accessTrust, service: f.tasks, clock: () => instant + 6000 });
  assert.equal((await off(request(path, "GET", undefined, undefined, f.jwt))).status, 503);
  const handler = createTaskHttpHandler({ origin, trust: f.accessTrust, service: tasks, ownerReviews: f.reviews, clock: () => instant + 6000 });
  for (const req of [request(`${path}?force=true`, "POST", f.draft, key, f.jwt), request(path, "DELETE", f.draft, key, f.jwt),
    request(path, "POST", { ...f.draft, artifactId: "artifact:other" }, key, f.jwt), request(path, "POST", f.draft, key, "invalid")])
    assert.ok((await handler(req)).status >= 400);
});
