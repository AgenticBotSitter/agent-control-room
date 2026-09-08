import assert from "node:assert/strict";
import test from "node:test";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { taskStartupFixture } from "./helpers/task-startup";
import { taskDraft } from "./helpers/web-task";
import { request } from "./helpers/web-foundation";
import { instant } from "./hermes-native-fixture";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { TaskExecutionPlanner, captureNativeTaskTemplates, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { WebProjectService } from "../src/web/v1/project-service";
import { createPrivateTaskBootstrap } from "../src/web/v1/private-task-startup";
import type { PrivateApplication } from "../src/web/v1/private-process";
import { taskQualityCoordinatorFixture } from "./helpers/task-quality-coordinator";
import { TaskResultCoordinator } from "../src/web/v1/task-result-coordinator";
import type { DatabaseClient } from "../src/persistence/database";
import { createTaskHttpHandler } from "../src/web/v1/task-http";

test("one restricted coordinator selects exact configured projects without fallback or automatic authority", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const projects = new WebProjectService(f.db, f.scope, () => instant + 7000);
  const second = (await projects.create(f.identity, { title: "Second project", summary: "Synthetic configuration" }, "multi-project-second")).project;
  const unknown = (await projects.create(f.identity, { title: "Unconfigured project", summary: "No execution template" }, "multi-project-unknown")).project;
  // Test-only explicit provisioning. Product promotion must never clone authority this way.
  const profile = { ...f.profile, id: "profile:second-project", projectId: second.projectId };
  await f.reviewStore.registerProfile(profile);
  const authority = { ...f.plannerConfig.template.authority, projectId: second.projectId };
  authority.digest = computeAuthorityDigest(authority);
  const additional: NativeTaskTemplate = { ...f.plannerConfig.template, id: "template:second-project", authority,
    instructions: "Use this second project's instructions only.", acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile) };
  const expected = structuredClone(additional);
  const secondSource = await f.tasks.propose(f.identity, second.projectId, taskDraft, "multi-project-source-two");
  const unknownSource = await f.tasks.propose(f.identity, unknown.projectId, taskDraft, "multi-project-source-three");
  const expiringSource = await f.tasks.propose(f.identity, second.projectId, taskDraft, "multi-project-expiring-source");
  const s = await taskStartupFixture(f);
  s.config.coordinator.planning = { ...f.plannerConfig, additionalTemplates: [additional] };
  let app!: PrivateApplication, opens = 0, installs = 0;
  const bootstrap = createPrivateTaskBootstrap({ clock: () => instant + 8000,
    openDatabase: config => { opens++; return s.openDatabase(config); }, install: value => { app = value; installs++; } });
  const starting = bootstrap.start(s.config);
  additional.instructions = "Caller mutation after startup began";
  const runtime = await starting; t.after(() => runtime.close());
  assert.equal(opens, 2); assert.equal(installs, 1);
  const path = (projectId: string, sourceJobId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(sourceJobId)}/plan`;
  const handle = (projectId: string, sourceJobId: string, method = "POST", body: unknown = { expectedInputDigest: sha256Digest(taskDraft) }) =>
    app.handle(request(path(projectId, sourceJobId), method, method === "GET" ? undefined : body, undefined, f.jwt), () => new Response("shell"));
  const saved = await handle(second.projectId, secondSource.receipt.jobId);
  assert.equal(saved.status, 201, await saved.clone().text());
  const receipt = (await saved.json()).receipt;
  assert.equal(receipt.startsWork, false); assert.equal(receipt.grantsExecutionAuthority, false);
  const stored = (await f.db.query<{ plan: { templateDigest: string; input: { instructions: string }; job: { authority: unknown } } }>(
    "SELECT plan FROM control_task_execution_plans WHERE job_id=$1", [receipt.jobId])).rows[0].plan;
  assert.equal(stored.templateDigest, sha256Digest(expected)); assert.equal(stored.input.instructions, expected.instructions);
  assert.deepEqual(stored.job.authority, expected.authority);
  const replay = await handle(second.projectId, secondSource.receipt.jobId);
  assert.equal(replay.status, 200); assert.deepEqual((await replay.json()).receipt, receipt);
  assert.equal((await handle(f.plannerConfig.template.authority.projectId, f.source.receipt.jobId)).status, 200);
  assert.equal((await handle(unknown.projectId, unknownSource.receipt.jobId)).status, 409);
  const availability = await handle(unknown.projectId, unknownSource.receipt.jobId, "GET");
  assert.equal(availability.status, 200); assert.equal((await availability.json()).availability, "not_configured");
  assert.equal((await handle(second.projectId, secondSource.receipt.jobId, "POST", {
    expectedInputDigest: sha256Digest(taskDraft), template: expected })).status, 400);
  const anonymous = request(path(second.projectId, secondSource.receipt.jobId)); anonymous.headers.delete("cf-access-jwt-assertion");
  assert.equal((await app.handle(anonymous, () => new Response("shell"))).status, 401);
  assert.equal((await handle(unknown.projectId, secondSource.receipt.jobId)).status, 404);
  let configurationReads = 0;
  const protectedOptions = createTaskHttpHandler({ origin: s.config.web.origin, trust: f.accessTrust, service: f.tasks,
    clock: () => instant + 8000, planning: { plan: f.planner.plan.bind(f.planner),
      supportsProject: () => { configurationReads++; return true; } } });
  assert.equal((await protectedOptions(request(path("project:not-visible", secondSource.receipt.jobId), "GET", undefined,
    undefined, f.jwt))).status, 404);
  assert.equal(configurationReads, 0);
  assert.equal((await f.tasks.detail(f.identity, second.projectId, receipt.jobId)).attempts.length, 0);

  // Existing saved evidence remains readable after removing the additional template.
  const removed = new TaskExecutionPlanner(s.coordinator.client, f.scope, f.plannerConfig, () => instant + 8000);
  assert.equal(removed.supportsProject(second.projectId), false);
  assert.deepEqual(await removed.readSaved(f.identity, second.projectId, secondSource.receipt.jobId), receipt);
  await assert.rejects(removed.plan(f.identity, second.projectId, secondSource.receipt.jobId, sha256Digest(taskDraft)), /conflict/);
  const changed = new TaskExecutionPlanner(s.coordinator.client, f.scope, { ...f.plannerConfig, additionalTemplates: [additional] }, () => instant + 8000);
  await assert.rejects(changed.plan(f.identity, second.projectId, secondSource.receipt.jobId, sha256Digest(taskDraft)), /conflict/);
  const badAuthority = { ...expected.authority, projectId: unknown.projectId }; badAuthority.digest = computeAuthorityDigest(badAuthority);
  const wrongProfile = new TaskExecutionPlanner(s.coordinator.client, f.scope, { ...f.plannerConfig,
    additionalTemplates: [{ ...expected, authority: badAuthority }] }, () => instant + 8000);
  await assert.rejects(wrongProfile.plan(f.identity, unknown.projectId, unknownSource.receipt.jobId, sha256Digest(taskDraft)));
  assert.equal(await removed.readSaved(f.identity, unknown.projectId, unknownSource.receipt.jobId), null);

  await t.test("additional project expiry is checked again at commit and rolls back the whole plan", async () => {
    const source = expiringSource;
    let now = instant + 8000;
    const db: DatabaseClient = { ...s.coordinator.client, transactionWithPreCommitCheck: (work, check) =>
      s.coordinator.client.transactionWithPreCommitCheck(work, async () => { now = instant + 250_000; await check(); }) };
    const planner = new TaskExecutionPlanner(db, f.scope, { ...f.plannerConfig, additionalTemplates: [expected] }, () => now);
    await assert.rejects(planner.plan(f.identity, second.projectId, source.receipt.jobId, sha256Digest(taskDraft)), /conflict/);
    assert.equal(await removed.readSaved(f.identity, second.projectId, source.receipt.jobId), null);
  });

  await t.test("ambiguous, malformed and over-limit templates reject before resource acquisition", async () => {
    const invalid = [ [expected, expected], [{ ...expected, id: f.plannerConfig.template.id }],
      [{ ...expected, authority: f.plannerConfig.template.authority }], Array.from({ length: 16 }, () => expected),
      [{ ...expected, authority: { ...expected.authority, projectId: unknown.projectId } }] ];
    for (const additionalTemplates of invalid) {
      assert.throws(() => captureNativeTaskTemplates({ template: f.plannerConfig.template, additionalTemplates }));
      let touched = 0;
      const invalidStartup = createPrivateTaskBootstrap({ openDatabase: () => { touched++; throw new Error(); }, install: () => { touched++; } });
      await assert.rejects(invalidStartup.start({ ...s.config, coordinator: { ...s.config.coordinator,
        planning: { ...f.plannerConfig, additionalTemplates } } }), /config_invalid/);
      assert.equal(touched, 0);
    }
  });
});

test("additional-project revision and result reconstruction retain exact project configuration", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  const original = structuredClone(x.f.plannerConfig.template);
  const primaryAuthority = { ...original.authority, projectId: "project:other-configured" };
  primaryAuthority.digest = computeAuthorityDigest(primaryAuthority);
  const planning = { ...x.f.plannerConfig, template: { ...original, id: "template:other-configured", authority: primaryAuthority },
    additionalTemplates: [original] };
  const owner = x.createOwner({ planning, revisionPlanning: true }); t.after(() => owner.close());
  const results = new TaskResultCoordinator(x.f.db, x.f.scope, planning, x.config.quality!, x.f.clock);
  // Caller mutation must not corrupt either already-constructed object or its later planner reconstructions.
  planning.additionalTemplates[0].authority.digest = "sha256:" + "0".repeat(64);
  planning.additionalTemplates.push(original);
  const review = await x.ownerReview("changes_requested");
  const value = { runId: x.request.runId, targetId: x.target.id, targetDigest: x.request.targetDigest,
    contentHash: x.request.contentHash, reviewId: review.receipt.reviewId, feedback: "Please improve the evidence." };
  const revised = await owner.revisions!.plan(x.f.identity, x.request.projectId, x.request.jobId, value, new AbortController().signal);
  assert.equal(revised.receipt.startsWork, false); assert.equal(revised.receipt.projectId, x.request.projectId);
  const saved = await x.f.planner.read(revised.receipt.jobId);
  assert.ok(saved); assert.equal(saved.templateDigest, sha256Digest(x.f.plannerConfig.template));
  assert.deepEqual(saved.job.authority, x.f.plannerConfig.template.authority);
  assert.deepEqual((await owner.revisions!.plan(x.f.identity, x.request.projectId, x.request.jobId, value,
    new AbortController().signal)).receipt, revised.receipt);
  const registered = await x.asMigrator(() => results.register({ projectId: x.request.projectId, jobId: x.request.jobId,
    runId: x.request.runId }, new AbortController().signal));
  assert.equal(registered.receipt.projectId, x.request.projectId); assert.equal(registered.replayed, true);
  const removed = new TaskResultCoordinator(x.f.db, x.f.scope, { ...planning, additionalTemplates: [] }, x.config.quality!, x.f.clock);
  assert.deepEqual((await x.asMigrator(() => removed.register({ projectId: x.request.projectId, jobId: x.request.jobId,
    runId: x.request.runId }, new AbortController().signal))).receipt, registered.receipt);
});
