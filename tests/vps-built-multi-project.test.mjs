import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateTaskBootstrap } from "../dist-vps/server/taskBootstrap.js";
import { taskAssignmentFixture } from "./helpers/task-assignment.ts";
import { taskStartupFixture } from "./helpers/task-startup.ts";
import { taskDraft } from "./helpers/web-task.ts";
import { request } from "./helpers/web-foundation.ts";
import { instant } from "./hermes-native-fixture.ts";
import { WebProjectService } from "../src/web/v1/project-service.ts";
import { computeAuthorityDigest, sha256Digest } from "../src/security/index.ts";

test("compiled bootstrap retains several explicit project templates in one restricted application", async t => {
  const base = await taskAssignmentFixture(); t.after(base.close);
  const project = (await new WebProjectService(base.db, base.scope, () => instant + 7000)
    .create(base.identity, { title: "Compiled second project", summary: "Disposable validation" }, "compiled-multi-project")).project;
  const profile = { ...base.profile, projectId: project.projectId, id: "profile:compiled-second" };
  await base.reviewStore.registerProfile(profile);
  // Synthetic operator preparation only; this is never automatic product provisioning.
  const authority = { ...base.plannerConfig.template.authority, projectId: project.projectId };
  authority.digest = computeAuthorityDigest(authority);
  const second = { ...base.plannerConfig.template, id: "template:compiled-second", authority,
    instructions: "Exact second-project instructions.", acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile) };
  const source = await base.tasks.propose(base.identity, project.projectId, taskDraft, "compiled-multi-source");
  const f = await taskStartupFixture(base);
  f.config.coordinator.planning = { ...base.plannerConfig, additionalTemplates: [second] };
  let app, opens = 0, installs = 0;
  const bootstrap = createPrivateTaskBootstrap({ clock: () => instant + 8000,
    openDatabase: config => { opens++; return f.openDatabase(config); }, install: value => { installs++; app = value; } });
  const starting = bootstrap.start(f.config);
  const expected = structuredClone(second);
  second.instructions = "Untrusted caller mutation after capture";
  const runtime = await starting; t.after(() => runtime.close());
  const planPath = (projectId, jobId) => `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}/plan`;
  const call = (projectId, jobId, method = "POST") => app.handle(request(planPath(projectId, jobId), method,
    method === "GET" ? undefined : { expectedInputDigest: sha256Digest(taskDraft) }, undefined, base.jwt), () => new Response("shell"));
  const [primary, additional] = await Promise.all([
    call(base.prepared.receipt.projectId, base.source.receipt.jobId), call(project.projectId, source.receipt.jobId),
  ]);
  assert.equal(primary.status, 200); assert.equal(additional.status, 201, await additional.clone().text());
  const receipt = (await additional.json()).receipt;
  assert.equal(receipt.startsWork, false); assert.equal(receipt.grantsExecutionAuthority, false);
  const row = (await f.coordinator.client.query("SELECT plan FROM control_task_execution_plans WHERE job_id=$1", [receipt.jobId])).rows[0];
  assert.equal(row.plan.templateDigest, sha256Digest(expected)); assert.deepEqual(row.plan.job.authority, expected.authority);
  assert.equal(row.plan.acceptanceProfileId, profile.id);
  assert.equal((await call(project.projectId, source.receipt.jobId, "GET")).status, 200);
  assert.deepEqual((await (await call(project.projectId, source.receipt.jobId)).json()).receipt, receipt);
  assert.equal((await f.coordinator.client.query("SELECT id FROM control_attempts WHERE job_id=$1", [receipt.jobId])).rows.length, 0);
  assert.equal(opens, 2); assert.equal(installs, 1);
  await runtime.close(); assert.equal(f.web.closes(), 1); assert.equal(f.coordinator.closes(), 1);
  assert.equal((await call(project.projectId, source.receipt.jobId)).status, 503);
});
