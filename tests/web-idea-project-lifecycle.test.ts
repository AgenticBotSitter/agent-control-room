import assert from "node:assert/strict";
import test from "node:test";
import { createAccessVerifier } from "../src/web/v1/access-verifier.ts";
import { WebIdeaProjectLifecycleOperation } from "../src/web/v1/idea-project-lifecycle-operation.ts";
import { fixture, now, trust, request } from "./helpers/web-foundation.ts";
import { seedWebIdea, webIdeaKey } from "./helpers/web-idea-project.ts";

test("private Idea lifecycle reuses owner policy and signed history with durable web receipts", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
  const { project: initial, store } = await seedWebIdea(f.client);
  const identity = createAccessVerifier(trust)(request(), now);
  let clock = now;
  const operation = new WebIdeaProjectLifecycleOperation(f.client, scope, webIdeaKey, () => clock);
  const call = (action: string, expectedVersion: number, key: string) => operation.transition(identity,
    initial.projectId, { action, expectedVersion }, key);

  await t.test("illegal direct archive rolls back policy and leaves provenance unchanged", async () => {
    const before = await f.db.query("SELECT * FROM control_policy_decisions ORDER BY id");
    await assert.rejects(call("archive", 1, "lifecycle-illegal-0001"), /conflict/);
    assert.deepEqual(await store.getProject(scope.tenantId, initial.projectId), initial);
    assert.deepEqual(await f.db.query("SELECT * FROM control_policy_decisions ORDER BY id"), before);
  });
  await t.test("complete, archive, reopen preserve receipts even after later commands", async () => {
    const first = await call("complete", 1, "lifecycle-complete-0001");
    assert.equal(first.project.lifecycle, "completed"); assert.equal(first.replayed, false);
    assert.equal((await call("archive", 2, "lifecycle-archive-0001")).project.lifecycle, "archived");
    await f.db.query(`UPDATE control_role_grants SET allowed_actions='["idea_lab.project_read","idea_lab.project_resume"]'::jsonb WHERE id='grant:web'`);
    await assert.rejects(call("resume", 3, "lifecycle-wrong-resume"), /conflict/);
    await f.db.query(`UPDATE control_role_grants SET allowed_actions='["*"]'::jsonb WHERE id='grant:web'`);
    assert.equal((await call("reopen", 3, "lifecycle-reopen-0001")).project.lifecycle, "active");
    assert.deepEqual(await call("complete", 1, "lifecycle-complete-0001"), { ...first, replayed: true });
    await assert.rejects(call("pause", 4, "lifecycle-complete-0001"), /conflict/);
    const current = (await store.getProject(scope.tenantId, initial.projectId))!;
    assert.equal(current.version, 4);
    assert.equal(current.sourceIdeaSessionId, initial.sourceIdeaSessionId);
    assert.equal(current.sourceDecisionDigest, initial.sourceDecisionDigest);
    assert.equal((await store.listProjectLifecycleEvents(scope.tenantId, initial.projectId)).length, 4);
  });
  await t.test("ordinary project authority and operator role cannot change Ideas or replay receipts", async () => {
    await f.db.query("UPDATE control_role_grants SET role_key='operator' WHERE id='grant:web'");
    await assert.rejects(call("pause", 4, "lifecycle-operator-0001"), /access_denied/);
    await f.db.query(`UPDATE control_role_grants SET role_key='owner',allowed_actions='["projects.lifecycle","idea_lab.project_read"]'::jsonb WHERE id='grant:web'`);
    await assert.rejects(call("pause", 4, "lifecycle-limited-0001"), /access_denied/);
    await assert.rejects(call("complete", 1, "lifecycle-complete-0001"), /access_denied/);
    await f.db.query(`UPDATE control_role_grants SET allowed_actions='["*"]'::jsonb WHERE id='grant:web'`);
  });
  await t.test("scope, schema and stale-version checks reject without writes", async () => {
    const other = new WebIdeaProjectLifecycleOperation(f.client, { ...scope, workspaceId: "workspace:absent" }, webIdeaKey, () => now);
    await assert.rejects(other.transition(identity, initial.projectId, { action: "pause", expectedVersion: 4 }, "lifecycle-other-0001"), /not_found/);
    await assert.rejects(call("pause", 1, "lifecycle-stale-0001"), /conflict/);
    await assert.rejects(operation.transition(identity, initial.projectId, { action: "pause", expectedVersion: 4, tenantId: "other" }, "lifecycle-extra-0001"), /invalid_request/);
    assert.equal((await store.getProject(scope.tenantId, initial.projectId))!.version, 4);
  });
  await t.test("session expiry at commit rolls back registry, events and command receipt", async () => {
    const client = { ...f.client, transactionWithPreCommitCheck: <T>(run: Parameters<typeof f.client.transaction<T>>[0], check: () => void) =>
      f.client.transactionWithPreCommitCheck(run, async () => { clock = now + 3600_000; await check(); }) };
    const expiring = new WebIdeaProjectLifecycleOperation(client, scope, webIdeaKey, () => clock);
    await assert.rejects(expiring.transition(identity, initial.projectId,
      { action: "pause", expectedVersion: 4 }, "lifecycle-expired-0001"), /authentication_required/);
    clock = now;
    assert.equal((await store.getProject(scope.tenantId, initial.projectId))!.version, 4);
    assert.equal((await store.listProjectLifecycleEvents(scope.tenantId, initial.projectId)).length, 4);
    assert.equal((await f.db.query("SELECT * FROM control_web_project_commands WHERE idempotency_key='lifecycle-expired-0001'")).rows.length, 0);
  });
  await t.test("overlapping same-key commands produce one lifecycle event", async () => {
    const results = await Promise.all([call("pause", 4, "lifecycle-parallel-0001"), call("pause", 4, "lifecycle-parallel-0001")]);
    assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
    assert.equal((await store.listProjectLifecycleEvents(scope.tenantId, initial.projectId)).length, 5);
    await f.db.query(`UPDATE control_role_grants SET allowed_actions='["idea_lab.project_read","idea_lab.project_reopen"]'::jsonb WHERE id='grant:web'`);
    await assert.rejects(call("reopen", 5, "lifecycle-wrong-reopen"), /conflict/);
    await f.db.query(`UPDATE control_role_grants SET allowed_actions='["*"]'::jsonb WHERE id='grant:web'`);
  });
  await t.test("logout denies receipt replay as well as new commands", async () => {
    await assert.rejects(f.service.create(identity, { title: "Key collision", summary: "" }, "lifecycle-complete-0001"), /conflict/);
    const ordinary = await f.service.create(identity, { title: "Ordinary", summary: "" }, "ordinary-lifecycle-key-001");
    await assert.rejects(call("resume", 5, "ordinary-lifecycle-key-001"), /conflict/);
    await assert.rejects(operation.transition(identity, ordinary.project.projectId,
      { action: "complete", expectedVersion: 1 }, "ordinary-adapter-reject-001"), /not_found/);
    await f.service.logout(identity);
    await assert.rejects(call("complete", 1, "lifecycle-complete-0001"), /authentication_required/);
  });
});
