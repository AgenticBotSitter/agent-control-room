import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import handler from "../dist-vps/server/index.js";
import { createPrivateTaskBootstrap } from "../dist-vps/server/taskBootstrap.js";
import { installPrivateApplication } from "../dist-vps/server/runtime.js";
import { nativeQualityCompletionFixture } from "./helpers/native-quality-completion.ts";
import { taskStartupFixture } from "./helpers/task-startup.ts";
import { request } from "./helpers/web-foundation.ts";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";

test("compiled two-role startup reconciles native quality, independent HTTP owner review and exact job completion", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close);
  const startup = await taskStartupFixture(x.f.assignmentFixture);
  // PGlite shares one backend; observer reads must choose their own role instead of
  // inheriting the last HTTP transaction's session identity through the base fixture.
  const canonical = new CanonicalStore(startup.coordinator.client);
  const states = async () => ({
    job: await canonical.get(x.request.tenantId, "job", x.registration.jobId),
    attempt: await canonical.get(x.request.tenantId, "attempt", x.registration.attemptId),
    lease: await canonical.get(x.request.tenantId, "lease", x.registration.nativeTask.leaseId),
  });
  // The reused startup fixture runs real non-superuser LOGIN permissions and both real
  // preflights on one serialized PGlite backend, with only its known TEMP metadata exception.
  // This observer records actual SQL identities; it does not replace preflight results.
  const preflights = [], inserts = [], opened = [];
  const observe = work => async tx => work({ async query(sql, params) {
    const result = await tx.query(sql, params);
    if (sql.includes("AS database_temp") || sql.includes("INSERT INTO control_completion_gate_records")) {
      const identity = (await tx.query("SELECT current_user,session_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
      if (sql.includes("AS database_temp")) preflights.push(identity);
      else inserts.push(identity);
    }
    return result;
  } });
  const bootstrap = createPrivateTaskBootstrap({ clock: x.f.clock, install: installPrivateApplication,
    openDatabase(config) {
      opened.push(config.username);
      const pool = startup.openDatabase(config), db = pool.client;
      return { ...pool, client: { ...db,
        transaction: work => db.transaction(observe(work)),
        transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(observe(work), check),
      } };
    },
  });
  // scenario:content is explicitly structural in this synthetic fixture only; no default is installed.
  const runtime = await bootstrap.start({ ...startup.config, coordinator: { ...startup.config.coordinator,
    quality: { ...x.f.ownerConfig, scenarios: [x.scenario] },
  } });
  t.after(() => runtime.close());
  assert.equal(runtime.isReady(), true); assert.ok(runtime.quality);
  assert.deepEqual(opened, ["web_test", "coordinator_test"]);
  assert.deepEqual(preflights, [
    { current_user: "web_test", session_user: "web_test", rolsuper: false },
    { current_user: "coordinator_test", session_user: "coordinator_test", rolsuper: false },
  ]);
  const input = { ...x.request, projectId: x.registration.projectId, jobId: x.registration.jobId };
  const reconcile = () => runtime.quality.reconcile(input, new AbortController().signal);
  const sweep = () => runtime.quality.sweep({ projectId: input.projectId }, new AbortController().signal);
  const calls = [...x.local.calls], waiting = await reconcile();
  assert.equal(waiting.disposition, "waiting_review"); assert.equal(waiting.verification, "recorded");
  assert.equal(waiting.grantsApproval, false); assert.equal(waiting.grantsExecutionAuthority, false);
  assert.equal("completion" in waiting, false); assert.equal((await states()).job.state, "leased");
  assert.deepEqual(inserts.map(row => row.current_user), ["coordinator_test"]);
  const discovered = await sweep();
  assert.equal(discovered.tenantId, input.tenantId); assert.equal(discovered.workspaceId, startup.config.web.workspaceId);
  assert.equal(discovered.projectId, input.projectId); assert.equal(discovered.nextRunId, null);
  assert.equal(discovered.grantsApproval, false); assert.equal(discovered.grantsExecutionAuthority, false);
  assert.equal(discovered.items.length, 1);
  assert.equal(discovered.items[0].runId, input.runId); assert.equal(discovered.items[0].jobId, input.jobId);
  assert.equal(discovered.items[0].status, "reconciled"); assert.equal(discovered.items[0].result.disposition, "waiting_review");
  assert.equal(discovered.items[0].result.verification, "replayed"); assert.equal("completion" in discovered.items[0].result, false);

  const path = `/api/v1/projects/${input.projectId}/tasks/${input.jobId}/results/${x.artifact.artifactId}/reviews/${x.target.id}`;
  const req = (method = "GET", body) => request(path, method, body, "compiled-quality-review-001", x.f.jwt);
  const options = await handler(req()); assert.equal(options.status, 200, await options.clone().text());
  assert.equal((await options.json()).canReview, true);
  const draft = { artifactId: x.artifact.artifactId, targetId: x.target.id, targetDigest: input.targetDigest,
    contentHash: input.contentHash, decision: "accepted", feedback: "" };
  const reviewed = await handler(req("POST", draft)); assert.equal(reviewed.status, 201, await reviewed.clone().text());
  assert.equal((await handler(req("POST", draft))).status, 200);
  assert.deepEqual(inserts.map(row => row.current_user), ["coordinator_test", "web_test"]);
  assert.ok(inserts.every(row => row.current_user === row.session_user && row.rolsuper === false));
  assert.equal((await states()).job.state, "leased");

  const completionSweep = await sweep(); assert.equal(completionSweep.items.length, 1);
  const completedItem = completionSweep.items[0]; assert.equal(completedItem.runId, input.runId);
  assert.equal(completedItem.jobId, input.jobId); assert.equal(completedItem.status, "reconciled");
  const completed = completedItem.result; assert.equal(completed.disposition, "completed");
  assert.equal(completed.verification, "replayed"); assert.equal(completed.completion.replayed, false);
  assert.equal(completed.completion.receipt.jobId, input.jobId); assert.equal(completed.completion.receipt.runId, input.runId);
  assert.equal(completed.completion.receipt.grantsExecutionAuthority, false);
  const state = await states(); assert.equal(state.job.state, "succeeded");
  assert.equal(state.attempt.state, "succeeded"); assert.equal(state.lease.state, "released");
  const replay = await reconcile(); assert.equal(replay.disposition, "completed");
  assert.equal(replay.completion.replayed, true); assert.deepEqual(replay.completion.receipt, completed.completion.receipt);
  assert.equal((await startup.coordinator.client.query("SELECT id FROM control_completion_gate_records WHERE kind='verification' AND parent_id=$1", [x.target.id])).rows.length, 1);
  assert.equal((await startup.coordinator.client.query("SELECT id FROM control_artifact_manifests WHERE job_id=$1", [input.jobId])).rows.length, 1);
  assert.equal((await startup.coordinator.client.query("SELECT id FROM control_transition_events WHERE actor_id='service:native-task-completion' AND entity_id=$1", [input.jobId])).rows.length, 2);
  assert.deepEqual(x.local.calls, calls); assert.equal(x.local.effects.countFull(), 1);
  const empty = await sweep(); assert.deepEqual(empty.items, []); assert.equal(empty.nextRunId, null);
  assert.equal(empty.grantsApproval, false); assert.equal(empty.grantsExecutionAuthority, false);
  assert.deepEqual(x.local.calls, calls); assert.equal(x.local.effects.countFull(), 1);
  await runtime.close(); assert.equal(runtime.isReady(), false);
  assert.equal(startup.web.closes(), 1); assert.equal(startup.coordinator.closes(), 1);
  await assert.rejects(reconcile()); await assert.rejects(sweep()); assert.equal((await handler(req())).status, 503);
});

test("compiled browser assets exclude private quality coordinator and completion implementation", () => {
  const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  const javascript = files("dist-vps/client").filter(file => file.endsWith(".js"));
  assert.ok(javascript.length > 0);
  for (const file of javascript) assert.doesNotMatch(readFileSync(file, "utf8"),
    /TaskQualityCoordinator|NativeTaskCompletionService|NativeResultVerificationService|task_quality_unavailable|control_completion_gate_task_coordinator_quality/);
});
