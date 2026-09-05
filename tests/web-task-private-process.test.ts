import assert from "node:assert/strict";
import test from "node:test";
import { limitedWebFixture, startupConfig } from "./helpers/web-startup";
import { request, now } from "./helpers/web-foundation";
import { taskDraft } from "./helpers/web-task";
import { createPrivateWebProcess } from "../src/web/v1/private-process";

test("restricted private process serves protected task pages, saves real proposals and shares logout revocation", async t => {
  const f = await limitedWebFixture(); const app = createPrivateWebProcess({ ...startupConfig, database: f.pool, clock: () => now });
  t.after(() => app.close()); let renders = 0;
  const handle = (req: Request) => app.handle(req, () => { renders++; return new Response("task-shell"); });
  const { project } = await (await handle(request(undefined, "POST", { title: "Restricted tasks", summary: "" }))).json();
  const path = `/api/v1/projects/${encodeURIComponent(project.projectId)}/tasks`;
  const saved = await handle(request(path, "POST", taskDraft)); assert.equal(saved.status, 201);
  const { receipt } = await saved.json();
  assert.equal((await handle(request(path))).status, 200);
  assert.equal((await handle(request(`/projects/${encodeURIComponent(project.projectId)}/tasks`))).status, 200);
  assert.equal((await handle(request(`/projects/${encodeURIComponent(project.projectId)}/tasks/${encodeURIComponent(receipt.jobId)}`))).status, 200);
  assert.equal(renders, 2);
  assert.equal((await handle(request(`${path}/job:unknown`))).status, 404);
  assert.equal((await handle(request(`/projects/${encodeURIComponent(project.projectId)}/tasks?after=one&after=two`))).status, 400);
  assert.equal((await handle(request(`/projects/${encodeURIComponent(project.projectId)}/tasks/${receipt.jobId}?after=job:one`))).status, 400);
  assert.equal((await handle(request("/api/v1/session/logout", "POST"))).status, 204);
  for (const route of [path, `${path}/${receipt.jobId}`, `/projects/${project.projectId}/tasks`, `/projects/${project.projectId}/tasks/${receipt.jobId}`])
    assert.equal((await handle(request(route))).status, 401);
  assert.equal(renders, 2);
});

test("the SQL web role can insert only initial non-running proposals and cannot transition or dispatch them", async t => {
  const f = await limitedWebFixture(); const app = createPrivateWebProcess({ ...startupConfig, database: f.pool, clock: () => now });
  t.after(() => app.close());
  const handle = (req: Request) => app.handle(req, () => new Response("shell"));
  const { project } = await (await handle(request(undefined, "POST", { title: "Proposal guard", summary: "" }))).json();
  const path = `/api/v1/projects/${project.projectId}/tasks`;
  assert.equal((await handle(request(path, "POST", taskDraft))).status, 201);
  const row = (await f.client.query<{ payload: Record<string, unknown> }>("SELECT payload FROM control_jobs")).rows[0];
  for (const state of ["ready", "running", "succeeded"]) await assert.rejects(f.client.query(`INSERT INTO control_jobs
    (id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,created_at,updated_at)
    SELECT $1,tenant_id,workflow_id,project_id,$2,0,priority,required_capability,authority_digest,$3::jsonb,created_at,updated_at
    FROM control_jobs LIMIT 1`, [`job:${state}`, state, JSON.stringify({ ...row.payload, id: `job:${state}`, state })]), /private proposal insert rejected/);
  const authority = row.payload.authority as Record<string, unknown>;
  await assert.rejects(f.client.query(`INSERT INTO control_jobs
    (id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,created_at,updated_at)
    SELECT 'job:wrong-executor',tenant_id,workflow_id,project_id,'proposed',0,priority,required_capability,authority_digest,$1::jsonb,created_at,updated_at
    FROM control_jobs LIMIT 1`, [JSON.stringify({ ...row.payload, id: "job:wrong-executor", authority: { ...authority, allowedExecutor: "executor:other" } })]), /private proposal insert rejected/);
  for (const sql of ["UPDATE control_jobs SET state='ready'", "UPDATE control_requests SET state='accepted'", "UPDATE control_workflows SET state='active'",
    "DELETE FROM control_web_task_commands", "TRUNCATE control_web_task_commands", "INSERT INTO control_attempts DEFAULT VALUES",
    "INSERT INTO control_leases DEFAULT VALUES", "INSERT INTO control_outbox DEFAULT VALUES", "INSERT INTO control_approvals DEFAULT VALUES",
    "INSERT INTO control_harness_run_events DEFAULT VALUES"]) await assert.rejects(f.client.query(sql));
  assert.equal((await f.client.query("SELECT * FROM control_jobs")).rows.length, 1);
});
