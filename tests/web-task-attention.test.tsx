import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { taskFixture, taskDraft } from "./helpers/web-task";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding } from "./hermes-native-fixture";
import { taskAttentionPageSchema } from "../src/web/v1/task-attention-wire";
import { readTaskAttention } from "../src/web/v1/queue-attention-browser-client";
import { TaskAttentionPanel } from "../private-app/app/needs-me/task-attention";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { origin, trust, now, request } from "./helpers/web-foundation";
import { sha256Digest } from "../src/security";
import { at } from "./native-task-fixture";

test("saved task attention paginates without mutations and enforces wildcard owner access", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  for (let i = 0; i < 26; i++) await f.tasks.propose(f.identity, f.project.projectId, taskDraft, `attention-task-key-${i}`);
  const first = await f.tasks.attention(f.identity);
  assert.equal(first.items.length, 25); assert.equal(first.examined, 25); assert.ok(first.nextCursor);
  assert.ok(first.items.every(item => item.reasons.join() === "proposal"));
  const second = await f.tasks.attention(f.identity, first.nextCursor);
  assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null);
  assert.ok(second.items[0].task.jobId > first.nextCursor);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*) AS count FROM control_jobs")).rows[0].count, 26);
  await f.db.query("UPDATE control_role_grants SET project_ids=$1 WHERE id='grant:web'", [[f.project.projectId]]);
  await assert.rejects(f.tasks.attention(f.identity), /access_denied/);
  await f.db.query("UPDATE control_role_grants SET project_ids=$1,role_key='operator' WHERE id='grant:web'", [["*"]]);
  await assert.rejects(f.tasks.attention(f.identity), /access_denied/);
});

test("verified review stays visible until review and required verification are both complete", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const before = await f.tasks.attention(f.identity);
  assert.ok(before.items.some(item => item.task.jobId === binding.jobId && item.reasons.includes("review")));
  await f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, "attention-review-key");
  const after = await f.tasks.attention(f.identity);
  assert.equal(after.items.some(item => item.reasons.includes("review")), true);
  await f.reviewStore.recordVerification({ schemaVersion: "control-room-completion-gate/v1", id: "verification:attention",
    tenantId: binding.tenantId, projectId: binding.projectId, targetId: f.target.id, targetDigest: sha256Digest(f.target),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile), scenarioId: "scenario:content", outcome: "passed",
    verifier: { actorId: "identity:verifier", actorType: "human" }, evidenceDigests: [f.artifact.contentHash], verifiedAt: at(6000),
    grantsApproval: false, grantsExecutionAuthority: false });
  assert.equal((await f.tasks.attention(f.identity)).items.some(item => item.reasons.includes("review")), false);
});

test("task attention client validates cursors and panel links only to the ordinary task view", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  await f.tasks.propose(f.identity, f.project.projectId, taskDraft, "attention-client-key");
  const page = await f.tasks.attention(f.identity);
  const parsed = await readTaskAttention(undefined, async (url, options) => {
    assert.equal(url, "/api/v1/needs-me/tasks"); assert.equal(options?.method, "GET");
    return Response.json(page);
  });
  assert.deepEqual(parsed, page);
  const html = renderToStaticMarkup(<TaskAttentionPanel page={parsed} />);
  assert.ok(html.includes(`/projects/${encodeURIComponent(f.project.projectId)}/tasks/`));
  assert.ok(html.includes("Check proposal and planning status")); assert.ok(!html.includes("<button"));
  assert.equal(taskAttentionPageSchema.safeParse({ ...page, startsWork: true }).success, false);
  await assert.rejects(readTaskAttention(page.items[0].task.jobId, async () => Response.json(page)), /unavailable/);
});

test("task attention endpoint rejects scope selectors, writes and revoked sessions", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  await f.tasks.propose(f.identity, f.project.projectId, taskDraft, "attention-endpoint-key");
  const app = createPrivateWebProcess({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    clock: () => now, database: { client: f.client, close: async () => {} }, loadKeys: async () => trust.keys });
  t.after(() => app.close()); const render = () => new Response("shell");
  const response = await app.handle(request("/api/v1/needs-me/tasks"), render);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).items.length, 1);
  await f.db.query(`UPDATE control_role_grants SET allowed_actions='["tasks.read","projects.read"]'::jsonb WHERE id='grant:web'`);
  assert.equal((await app.handle(request("/needs-me"), render)).status, 200);
  assert.equal((await app.handle(request("/api/v1/needs-me/tasks"), render)).status, 200);
  assert.equal((await app.handle(request("/api/v1/needs-me"), render)).status, 403);
  assert.equal((await app.handle(request("/connections"), render)).status, 403);
  assert.equal((await app.handle(request("/needs-me?project=other"), render)).status, 400);
  for (const actions of [["tasks.read"], ["projects.read"], []]) {
    await f.db.query("UPDATE control_role_grants SET allowed_actions=$1 WHERE id='grant:web'", [actions]);
    assert.equal((await app.handle(request("/needs-me"), render)).status, 403);
  }
  await f.db.query(`UPDATE control_role_grants SET allowed_actions='["tasks.read","projects.read"]'::jsonb,project_ids=$1 WHERE id='grant:web'`, [[f.project.projectId]]);
  assert.equal((await app.handle(request("/needs-me"), render)).status, 403);
  await f.db.query(`UPDATE control_role_grants SET allowed_actions='["tasks.read","idea_lab.project_read"]'::jsonb,project_ids='["*"]'::jsonb WHERE id='grant:web'`);
  assert.equal((await app.handle(request("/needs-me"), render)).status, 200);
  await f.db.query(`UPDATE control_role_grants SET allowed_actions='["*"]'::jsonb WHERE id='grant:web'`);
  for (const path of ["/api/v1/needs-me/tasks?tenant=other", "/api/v1/needs-me/tasks?after=a&after=b", "/api/v1/needs-me/tasks?after="])
    assert.equal((await app.handle(request(path), render)).status, 400);
  assert.equal((await app.handle(request("/api/v1/needs-me/tasks", "POST"), render)).status, 400);
  await app.handle(request("/api/v1/session/logout", "POST"), render);
  assert.equal((await app.handle(request("/api/v1/needs-me/tasks"), render)).status, 401);
  assert.equal((await app.handle(request("/needs-me"), render)).status, 401);
});
