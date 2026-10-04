// Tango R3 / owner decision (research/tango/03-recommendations.md §6): widen the
// owner review decision to Accept / Accept with exceptions / Send back. This
// covers two layers:
//  (a) the real PostgreSQL guard (migration 0115, CREATE OR REPLACE over
//      0043/0053/0086/0092) as the restricted control_room_private_web login,
//      using the same disposable-PGlite/web-login pattern as
//      mac-local-owner-review-profile-guard.test.ts;
//  (b) the web review service, which requires at least one named exception,
//      opens one linked follow-up task per exception through the ordinary
//      proposed-task path (startsWork: false), and counts the decision as
//      "ready" for pipeline hand-off exactly like a plain accept.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { taskReviewDraftSchema } from "../src/web/v1/task-review-wire";
import { sha256Digest } from "../src/security";

const NOW = "2026-09-25T12:00:00.000Z";
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const tag = (c: string) => `hmac-sha256:${c.repeat(64)}`;

async function seed() {
  const pg = new PGlite();
  for (const file of (await readdir("db/migrations")).filter(f => f.endsWith(".sql")).sort())
    await pg.exec(await readFile(`db/migrations/${file}`, "utf8"));
  await pg.exec(`
    INSERT INTO tenants(id,display_name) VALUES('tenant:a','A');
    INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:a','tenant:a','A');
    INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
      VALUES('adapter:test','tenant:a','control-room-manual','1.0.0','control_room_native','disabled','v1',30);
    INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
      normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      VALUES('project:alpha','tenant:a','workspace:a','adapter:test','project:alpha','1','Alpha','Seed','running','seed','healthy','control_room_native','${NOW}','{}','${NOW}');`);
  await pg.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await pg.exec(`CREATE ROLE web_login_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_private_web TO web_login_test;
    SET SESSION AUTHORIZATION web_login_test;
    SET search_path = pg_catalog, public;`);
  return { pg, db: adaptPglite(pg) };
}

const reviewRow = (id = "review:g1", overrides: Record<string, unknown> = {}) => ({
  id, record_key: `k:${id}`, subject_id: "target:g1", parent_id: "target:g1",
  payload: { id, tenantId: "tenant:a", projectId: "project:alpha", authority: "completion_gate",
    decision: "accepted_with_exceptions", reviewer: { actorType: "human" },
    grantsApproval: "false", grantsExecutionAuthority: "false",
    exceptions: [{ id: "exception:1", statementDigest: digest("e"), followUpJobId: "job:follow-up" }],
    ...overrides },
});

async function insertReview(pg: PGlite, row: ReturnType<typeof reviewRow>) {
  return pg.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,parent_id,
    record_digest,record_auth_tag,payload,occurred_at) VALUES($1,'tenant:a','project:alpha','review',$2,$3,$4,$5,$6,$7::jsonb,$8)`,
  [row.id, row.record_key, row.subject_id, row.parent_id, digest("f"), tag("e"), JSON.stringify(row.payload), NOW]);
}

test("the web login admits an accepted-with-exceptions review naming at least one exception", async t => {
  const { pg } = await seed(); t.after(() => pg.close());
  await insertReview(pg, reviewRow());
  const rows = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM control_completion_gate_records WHERE kind='review'");
  assert.equal(rows.rows[0]?.n, 1);
});

test("the web login still admits a plain accepted or changes-requested review", async t => {
  const { pg } = await seed(); t.after(() => pg.close());
  await insertReview(pg, reviewRow("review:g2", { decision: "accepted", exceptions: undefined }));
  await insertReview(pg, reviewRow("review:g3", { decision: "changes_requested", exceptions: undefined }));
  const rows = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM control_completion_gate_records WHERE kind='review'");
  assert.equal(rows.rows[0]?.n, 2);
});

for (const [name, overrides] of [
  ["an unknown decision value", { decision: "definitely_not_a_decision" }],
  ["accepted-with-exceptions naming zero exceptions", { exceptions: [] }],
  ["accepted-with-exceptions naming no exceptions field at all", { exceptions: undefined }],
  ["accepted-with-exceptions naming more than ten exceptions", { exceptions: Array.from({ length: 11 },
    (_, i) => ({ id: `exception:${i}`, statementDigest: digest("e"), followUpJobId: `job:${i}` })) }],
  ["a plain accepted review that still carries an exceptions list", { decision: "accepted" }],
  ["a changes-requested review that carries an exceptions list", { decision: "changes_requested" }],
] as const) test(`the web login rejects ${name}`, async t => {
  const { pg } = await seed(); t.after(() => pg.close());
  await assert.rejects(insertReview(pg, reviewRow("review:g1", overrides as Record<string, unknown>)), /private quality insert rejected/);
  const rows = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM control_completion_gate_records WHERE kind='review'");
  assert.equal(rows.rows[0]?.n, 0);
});

test("recording accepted-with-exceptions opens one linked follow-up task per exception and reaches ready", async t => {
  const f = await ownerReviewFixture(); t.after(() => f.close());
  // The fixture's profile still requires one passing "scenario:content" verification
  // before any decision reaches "ready" — that requirement is independent of, and
  // unaffected by, accepted-with-exceptions.
  await f.reviewStore.recordVerification({ schemaVersion: "control-room-completion-gate/v1",
    id: "verification:owner:content", tenantId: binding.tenantId, projectId: binding.projectId, targetId: f.target.id,
    targetDigest: sha256Digest(f.target), acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile),
    scenarioId: "scenario:content", outcome: "passed", verifier: { actorId: "identity:test", actorType: "human" },
    evidenceDigests: [f.artifact.contentHash], verifiedAt: at(6000), grantsApproval: false, grantsExecutionAuthority: false });
  const draft = { ...f.draft, decision: "accepted_with_exceptions" as const, feedback: "",
    exceptions: ["Missing a retry test for the timeout path", "Docs need a worked example"] };
  const result = await f.reviews.record(f.identity, binding.projectId, binding.jobId, draft, "review-exceptions-001");
  assert.equal(result.replayed, false);
  assert.equal(result.receipt.decision, "accepted_with_exceptions");
  assert.equal(result.receipt.exceptions?.length, 2);
  assert.equal(result.receipt.exceptions?.[0]?.statement, draft.exceptions[0]);
  assert.equal(result.receipt.exceptions?.[1]?.statement, draft.exceptions[1]);
  const jobIds = result.receipt.exceptions!.map(value => value.followUpJobId);
  assert.equal(new Set(jobIds).size, 2, "each exception opens its own distinct follow-up task");
  for (const jobId of jobIds) {
    const row = (await f.db.query<{ state: string; project_id: string }>(
      "SELECT state,project_id FROM control_jobs WHERE tenant_id=$1 AND id=$2", [binding.tenantId, jobId])).rows[0];
    assert.equal(row?.state, "proposed", "a follow-up never starts work on its own");
    assert.equal(row?.project_id, binding.projectId);
  }
  const snapshot = await f.reviewStore.snapshot(binding.tenantId, f.target.id);
  assert.equal(snapshot.status, "ready", "accepted with exceptions counts as done for pipeline hand-off");
  assert.equal(snapshot.grantsApproval, false, "accepting a result never approves an action");

  // Replaying the identical idempotency key must not open a second batch of follow-ups.
  const replay = await f.reviews.record(f.identity, binding.projectId, binding.jobId, draft, "review-exceptions-001");
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt.exceptions?.map(value => value.followUpJobId), jobIds);
});

test("accepted-with-exceptions is refused without a linked follow-up task port", async t => {
  const f = await ownerReviewFixture(); t.after(() => f.close());
  const noFollowUps = f.createReviews(f.db, undefined, { followUps: undefined });
  const draft = { ...f.draft, decision: "accepted_with_exceptions" as const, feedback: "", exceptions: ["Missing a test"] };
  await assert.rejects(noFollowUps.record(f.identity, binding.projectId, binding.jobId, draft, "review-exceptions-002"),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "invalid_request");
});

test("a named exception must not be empty and does not accept more than ten", () => {
  const base = { artifactId: "artifact:a", targetId: "target:a", targetDigest: digest("a"), contentHash: digest("b"), feedback: "" };
  assert.equal(taskReviewDraftSchema.safeParse({ ...base, decision: "accepted_with_exceptions" }).success, false);
  assert.equal(taskReviewDraftSchema.safeParse({ ...base, decision: "accepted_with_exceptions", exceptions: [] }).success, false);
  assert.equal(taskReviewDraftSchema.safeParse({ ...base, decision: "accepted_with_exceptions",
    exceptions: Array.from({ length: 11 }, (_, i) => `exception ${i}`) }).success, false);
  assert.equal(taskReviewDraftSchema.safeParse({ ...base, decision: "accepted_with_exceptions", exceptions: ["one named gap"] }).success, true);
  assert.equal(taskReviewDraftSchema.safeParse({ ...base, decision: "accepted", exceptions: ["not allowed here"] }).success, false);
});
