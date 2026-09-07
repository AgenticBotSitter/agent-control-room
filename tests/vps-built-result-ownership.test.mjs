import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import handler from "../dist-vps/server/index.js";
import { createPrivateTaskBootstrap } from "../dist-vps/server/taskBootstrap.js";
import { installPrivateApplication } from "../dist-vps/server/runtime.js";
import { NativeTaskResultService } from "../src/node-control/native-task-result-service.ts";
import { sha256Digest } from "../src/security/index.ts";
import { nativeTaskLifecycleFixture } from "./helpers/native-task-lifecycle.ts";
import { taskStartupFixture } from "./helpers/task-startup.ts";
import { request } from "./helpers/web-foundation.ts";

async function resultPool(startup) {
  await startup.raw.exec(readFileSync("db/roles/native_results_roles.sql", "utf8"));
  await startup.raw.exec(`CREATE ROLE result_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_native_results TO result_test`);
  let closes = 0, available = true;
  const client = {
    query: (sql, params) => client.transaction(tx => tx.query(sql, params)),
    transaction: work => client.transactionWithPreCommitCheck(work, () => {}),
    transactionWithPreCommitCheck: (work, check) => startup.db.transactionWithPreCommitCheck(async tx => {
      await tx.query("SET LOCAL SESSION AUTHORIZATION result_test");
      const session = { async query(sql, params) {
        const value = await tx.query(sql, params);
        if (sql.includes("AS database_temp")) value.rows = value.rows.map(row => ({ ...row, database_temp: false }));
        return value;
      } };
      return work(session);
    }, check),
  };
  return { client, close: async () => { closes++; available = false; }, isAvailable: () => available,
    closes: () => closes, quarantine: () => { available = false; } };
}

test("compiled three-role startup registers and submits separately captured synthetic native bytes through the restricted writer", async t => {
  const x = await nativeTaskLifecycleFixture(); t.after(x.close);
  // Discovery records only the authenticated run. The restricted runtime must bind its
  // review plan before the existing fake transport starts or reports any native progress.
  await x.f.runs.create(x.registration);
  assert.equal((await x.f.reviewStore.inspectSubject(x.registration.tenantId,
    x.registration.projectId, x.registration.jobId)).targets.length, 0);

  const startup = await taskStartupFixture(x.f.assignmentFixture);
  const result = await resultPool(startup);
  const resultDatabase = { ...startup.config.coordinator.database, username: "result_test" };
  const profile = x.f.profile;
  const scenario = { scenarioId: "scenario:content", acceptanceProfileId: profile.id,
    acceptanceProfileDigest: sha256Digest(profile), rules: { version: "document-structure/v1",
      minUtf8Bytes: 20, maxUtf8Bytes: 4096, requiredHeadings: ["Result", "Evidence"], forbiddenTerms: [] } };
  const opened = [], preflights = [], writes = [];
  const openDatabase = config => {
    opened.push(config.username);
    const pool = config.username === "web_test" ? startup.web
      : config.username === "coordinator_test" ? startup.coordinator
      : config.username === "result_test" ? result
      : (() => { throw new Error("unexpected_test_database"); })();
    const db = pool.client;
    const observe = work => async tx => work({ async query(sql, params) {
      const value = await tx.query(sql, params);
      if (sql.includes("AS database_temp"))
        preflights.push((await tx.query("SELECT current_user,session_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0]);
      if (sql.includes("INSERT INTO control_native_review_plans") || sql.includes("INSERT INTO control_completion_gate_records"))
        writes.push((await tx.query("SELECT current_user,session_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0]);
      return value;
    } });
    return { ...pool, client: { ...db, transaction: work => db.transaction(observe(work)),
      transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(observe(work), check) } };
  };
  const runtime = await createPrivateTaskBootstrap({ clock: x.f.clock, openDatabase,
    install: value => { assert.equal(preflights.length, 3); installPrivateApplication(value); } }).start({
    ...startup.config, coordinator: { ...startup.config.coordinator,
      quality: { ...x.f.ownerConfig, scenarios: [scenario] }, resultDatabase },
  });
  t.after(() => runtime.close());
  assert.equal(runtime.isReady(), true); assert.ok(runtime.results);
  assert.deepEqual(opened, ["web_test", "coordinator_test", "result_test"]);
  assert.deepEqual(preflights, [
    { current_user: "web_test", session_user: "web_test", rolsuper: false },
    { current_user: "coordinator_test", session_user: "coordinator_test", rolsuper: false },
    { current_user: "result_test", session_user: "result_test", rolsuper: false },
  ]);
  assert.deepEqual(Object.keys(runtime).sort(), ["close", "isReady", "quality", "results"]);
  assert.deepEqual(Object.keys(runtime.results).sort(), ["register", "submit", "tenantId", "workspaceId"]);
  assert.equal(JSON.stringify(runtime).includes("result_test"), false);

  const input = { projectId: x.registration.projectId, jobId: x.registration.jobId, runId: x.registration.id };
  const callsBeforeRegister = [...x.local.calls], effectsBeforeRegister = x.local.effects.countFull();
  const registered = await runtime.results.register(input, new AbortController().signal);
  assert.equal(registered.replayed, false); assert.equal(registered.receipt.projectId, input.projectId);
  assert.equal(registered.receipt.jobId, input.jobId); assert.equal(registered.receipt.runId, input.runId);
  assert.equal(registered.receipt.inputDigest, x.f.assignmentFixture.prepared.receipt.inputDigest);
  assert.equal(registered.receipt.startsWork, false); assert.equal(registered.receipt.grantsExecutionAuthority, false);
  assert.deepEqual(x.local.calls, callsBeforeRegister); assert.equal(x.local.effects.countFull(), effectsBeforeRegister);
  // PGlite does not restore current_user after SET LOCAL SESSION AUTHORIZATION.
  // Reset only at this labelled privileged fixture boundary; writer calls above and below
  // still establish and observe result_test independently inside their own transactions.
  await startup.raw.exec("SET SESSION AUTHORIZATION postgres");
  assert.equal((await x.f.reviewStore.inspectSubject(x.registration.tenantId,
    x.registration.projectId, x.registration.jobId)).targets.length, 0);

  // Existing fake transport now produces one result whose bytes are captured without an
  // implicit submission callback; only the mounted result writer may submit it below.
  await x.handoff.start(); await x.publish();
  x.advance(); await x.handoff.poll(); await x.publish();
  const text = "# Result\nA separately captured synthetic native result.\n# Evidence\nSigned fixture evidence.\n";
  x.advance(); x.setResult(text); await x.handoff.poll(); const completed = await x.publish();
  const bytes = new TextEncoder().encode(text);
  const capture = new NativeTaskResultService(x.f.auth, x.f.runs, x.f.results);
  const { receipt: artifact } = await capture.ingest(completed.raw, bytes, x.options());
  const nativeCalls = [...x.local.calls], nativeEffects = x.local.effects.countFull();
  const submitted = await runtime.results.submit(input, new AbortController().signal);
  assert.equal(submitted.replayed, false); assert.equal(submitted.receipt.targetId, registered.receipt.targetId);
  assert.equal(submitted.receipt.contentHash, artifact.contentHash); assert.equal(submitted.receipt.rootSubjectId, input.jobId);
  assert.equal(submitted.receipt.rootTargetId, submitted.receipt.targetId); assert.equal(submitted.receipt.revisionNumber, 0);
  assert.equal(submitted.receipt.qualityAccepted, false); assert.equal(submitted.receipt.grantsExecutionAuthority, false);
  assert.ok(writes.length >= 2); assert.ok(writes.every(row => row.current_user === "result_test"
    && row.session_user === "result_test" && row.rolsuper === false));

  const registrationReplay = await runtime.results.register(input, new AbortController().signal);
  const submissionReplay = await runtime.results.submit(input, new AbortController().signal);
  assert.equal(registrationReplay.replayed, true); assert.deepEqual(registrationReplay.receipt, registered.receipt);
  assert.equal(submissionReplay.replayed, true); assert.deepEqual(submissionReplay.receipt, submitted.receipt);
  await startup.raw.exec("SET SESSION AUTHORIZATION postgres");
  const subject = await x.f.reviewStore.inspectSubject(x.registration.tenantId, input.projectId, input.jobId);
  assert.equal(subject.targets.length, 1); assert.equal(subject.targets[0].snapshot.target.id, submitted.receipt.targetId);
  assert.equal((await startup.coordinator.client.query(
    "SELECT 1 AS present FROM control_native_review_plans WHERE tenant_id=$1 AND run_id=$2", [x.registration.tenantId, input.runId])).rows.length, 1);
  assert.equal((await startup.coordinator.client.query(
    "SELECT 1 AS present FROM control_native_artifact_receipts WHERE tenant_id=$1 AND artifact_id=$2", [x.registration.tenantId, artifact.artifactId])).rows.length, 1);
  assert.deepEqual(x.local.calls, nativeCalls); assert.equal(x.local.effects.countFull(), nativeEffects);

  const hiddenPath = `/api/v1/projects/${input.projectId}/tasks/${input.jobId}/results/register`;
  assert.equal((await handler(request(hiddenPath, "POST", input, undefined, x.f.jwt))).status, 404);
  const retained = runtime.results; await runtime.close(); assert.equal(runtime.isReady(), false);
  assert.equal(startup.web.closes(), 1); assert.equal(startup.coordinator.closes(), 1); assert.equal(result.closes(), 1);
  await assert.rejects(retained.register(input, new AbortController().signal), { message: "task_coordinator_unavailable" });
  await assert.rejects(retained.submit(input, new AbortController().signal), { message: "task_coordinator_unavailable" });
  assert.deepEqual(x.local.calls, nativeCalls); assert.equal(x.local.effects.countFull(), nativeEffects);
});

test("compiled browser assets exclude trusted result-writer implementation and role material", () => {
  const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  const javascript = files("dist-vps/client").filter(file => file.endsWith(".js"));
  assert.ok(javascript.length > 0);
  for (const file of javascript) assert.doesNotMatch(readFileSync(file, "utf8"),
    /TaskResultCoordinator|NativeResultSubmissionService|control_room_native_results|task_result_operation_uncertain|control_native_review_plans/);
});
