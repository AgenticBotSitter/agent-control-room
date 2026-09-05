import assert from "node:assert/strict";
import test from "node:test";
import { taskFixture, taskDraft } from "./helpers/web-task";
import { now, request, trust } from "./helpers/web-foundation";
import { WebTaskService } from "../src/web/v1/task-service";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { AuditStore } from "../src/audit/audit-store";
import { seedWebIdea, webIdeaKey } from "./helpers/web-idea-project";

test("private task proposal persists the existing canonical bundle, audit and receipt in one transaction", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const saved = await f.handler(request(f.path, "POST", taskDraft)); assert.equal(saved.status, 201);
  const { receipt } = await saved.json(); assert.equal(receipt.startsWork, false);
  const again = await f.handler(request(f.path, "POST", taskDraft)); assert.equal(again.status, 200);
  assert.deepEqual((await again.json()).receipt, receipt);
  const list = await (await f.handler(request(f.path))).json(); assert.equal(list.tasks.length, 1); assert.equal(list.canPropose, true);
  assert.equal(list.tasks[0].jobId, receipt.jobId); assert.equal(list.tasks[0].state, "proposed");
  const detail = await (await f.handler(request(`${f.path}/${encodeURIComponent(receipt.jobId)}`))).json();
  assert.equal(detail.instructions, taskDraft.instructions); assert.equal(detail.review, "not_connected");
  assert.equal(detail.progressSource, "not_configured"); assert.deepEqual(detail.attempts, []);
  const canonical = new CanonicalStore(f.client);
  const job = await canonical.get("tenant:web", "job", receipt.jobId); assert.equal(job?.kind, "job");
  if (job?.kind !== "job") throw new Error();
  assert.equal(job.authority.allowedExecutor, "executor:unassigned"); assert.equal(job.authority.effectPolicy, "none");
  assert.equal(job.authority.networkPolicy, "none"); assert.deepEqual(job.authority.credentialRefs, []);
  for (const table of ["control_attempts", "control_leases", "control_effect_intents", "control_approvals", "control_outbox"])
    assert.equal((await f.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
  const audit = await new AuditStore(f.client).verify("tenant:web", "month:2026-09"); assert.equal(audit.valid, true); assert.equal(audit.checkedEvents, 2);
});

test("concurrent identical submissions produce one canonical proposal; changed and cross-project key reuse conflict", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const results = await Promise.all([1, 2, 3].map(() => f.handler(request(f.path, "POST", taskDraft))));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 200, 201]);
  assert.equal((await f.handler(request(f.path, "POST", { ...taskDraft, instructions: "Changed" }))).status, 409);
  const { project } = await f.service.create(f.identity, { title: "Other", summary: "" }, "task-project-other-001");
  assert.equal((await f.handler(request(`/api/v1/projects/${project.projectId}/tasks`, "POST", taskDraft))).status, 409);
  assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_jobs")).rows[0].n, 1);
});

test("proposal receipt survives later project closure; new proposals require an active project", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  await f.handler(request(f.path, "POST", taskDraft));
  await f.service.transition(f.identity, f.project.projectId, { lifecycle: "completed", expectedVersion: 1 }, "complete-task-project-001");
  assert.equal((await f.handler(request(f.path, "POST", taskDraft))).status, 200);
  assert.equal((await f.handler(request(f.path, "POST", taskDraft, "new-task-after-close-001"))).status, 409);
  assert.equal((await (await f.handler(request(f.path))).json()).canPropose, false);
});

test("request controls, secret-like material and unknown task actions are rejected without saving content", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  for (const value of [{ ...taskDraft, authority: {} }, { ...taskDraft, tenantId: "tenant:other" },
    { title: "", instructions: "x" }, { ...taskDraft, instructions: "x".repeat(4001) },
    { ...taskDraft, instructions: "password=synthetic-secret-only" }, { ...taskDraft, instructions: "unsafe\u0000value" }])
    assert.equal((await f.handler(request(f.path, "POST", value))).status, 400);
  assert.equal((await f.handler(request(`${f.path}?dispatch=true`, "POST", taskDraft))).status, 400);
  assert.equal((await f.handler(request(`${f.path}/job:missing/start`, "POST", {}))).status, 404);
  assert.equal((await f.handler(request(`${f.path}?after=a&after=b`))).status, 400);
  assert.equal((await f.handler(request(f.path, "POST", taskDraft, "short"))).status, 400);
  assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_requests")).rows[0].n, 0);
});

test("task grants do not widen project scope and project read alone grants neither task read nor proposal", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const { receipt } = await f.tasks.propose(f.identity, f.project.projectId, taskDraft, "scoped-task-create-001");
  await f.db.query("UPDATE control_role_grants SET allowed_actions='[\"projects.read\"]'::jsonb");
  assert.equal((await f.handler(request(f.path))).status, 403);
  await f.db.query("UPDATE control_role_grants SET allowed_actions='[\"projects.read\",\"tasks.read\"]'::jsonb,project_ids=$1::jsonb", [JSON.stringify([f.project.projectId])]);
  assert.equal((await f.handler(request(f.path))).status, 200);
  assert.equal((await f.handler(request(f.path, "POST", taskDraft))).status, 403);
  assert.equal((await f.handler(request(`/api/v1/projects/project:other/tasks/${receipt.jobId}`))).status, 403);
  await assert.rejects(new WebTaskService(f.client, { tenantId: "tenant:other", workspaceId: "workspace:web" }, () => now)
    .detail(f.identity, f.project.projectId, receipt.jobId), /access_denied/);
  await assert.rejects(new WebTaskService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:other" }, () => now)
    .detail(f.identity, f.project.projectId, receipt.jobId), /not_found/);
  await f.service.logout(f.identity);
  assert.equal((await f.handler(request(f.path))).status, 401);
});

test("expiry and audit failure roll back the canonical bundle and task receipt together", async t => {
  for (const mode of ["expiry", "audit"] as const) await t.test(mode, async t => {
    let clock = now; const f = await taskFixture(() => clock); t.after(() => f.db.close());
    const client = { ...f.client, transactionWithPreCommitCheck: <T>(run: Parameters<typeof f.client.transaction<T>>[0], check: () => void) =>
      f.client.transactionWithPreCommitCheck(tx => run({ query: async <U>(sql: string, args?: unknown[]) => {
        if (mode === "audit" && sql.startsWith("INSERT INTO audit_events")) throw new Error("injected rollback");
        return tx.query<U>(sql, args);
      } }), () => { if (mode === "expiry") clock = now + 301_000; check(); }) };
    await assert.rejects(new WebTaskService(client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, () => clock)
      .propose(f.identity, f.project.projectId, taskDraft, "rolled-back-task-0001"));
    for (const table of ["control_requests", "control_workflows", "control_jobs", "control_web_task_commands"])
      assert.equal((await f.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
  });
});

test("an uncertain committed response can be reconciled by the exact owner retry without another job", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const client = { ...f.client, transactionWithPreCommitCheck: async <T>(run: Parameters<typeof f.client.transaction<T>>[0], check: () => void) => {
    await f.client.transactionWithPreCommitCheck(run, check); throw new Error("injected lost response");
  } };
  await assert.rejects(new WebTaskService(client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, () => now)
    .propose(f.identity, f.project.projectId, taskDraft, "uncertain-task-save-001"));
  const replay = await f.tasks.propose(f.identity, f.project.projectId, taskDraft, "uncertain-task-save-001");
  assert.equal(replay.replayed, true);
  assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_jobs")).rows[0].n, 1);
});

test("Idea tasks use the existing owner-only project integrity gate", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const { project } = await seedWebIdea(f.client);
  const tasks = new WebTaskService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, () => now, { ideaIntegrityKey: webIdeaKey });
  const saved = await tasks.propose(f.identity, project.projectId, taskDraft, "idea-project-task-001");
  const detail = await tasks.detail(f.identity, project.projectId, saved.receipt.jobId); assert.equal(detail.project.origin, "idea_lab");
  await assert.rejects(f.tasks.list(f.identity, project.projectId), /not_configured/);
  await f.db.query("UPDATE control_role_grants SET role_key='operator'");
  await assert.rejects(tasks.list(f.identity, project.projectId), /not_found|access_denied/);
});

test("task receipts are append-only and the signed-in principal is never accepted from the request body", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  await f.tasks.propose(f.identity, f.project.projectId, taskDraft, "append-only-task-001");
  await assert.rejects(f.db.query("UPDATE control_web_task_commands SET request_digest=request_digest"));
  await assert.rejects(f.db.query("DELETE FROM control_web_task_commands"));
  await assert.rejects(f.db.query("TRUNCATE control_web_task_commands"));
  assert.equal((await f.handler(new Request(`${trust.issuer}/api/v1/projects`))).status, 403);
});
