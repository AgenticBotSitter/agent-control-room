import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import handler from "../dist-vps/server/index.js";
import { createPrivateTaskBootstrap } from "../dist-vps/server/taskBootstrap.js";
import { installPrivateApplication } from "../dist-vps/server/runtime.js";
import { nativeResultId } from "../src/artifacts/v1/native-results.ts";
import { sha256Digest } from "../src/security/index.ts";
import { nativeTaskLifecycleFixture } from "./helpers/native-task-lifecycle.ts";
import { taskStartupFixture } from "./helpers/task-startup.ts";
import { request } from "./helpers/web-foundation.ts";

function restrictedPool(startup, login) {
  let closes = 0, available = true;
  const client = {
    query: (sql, params) => client.transaction(tx => tx.query(sql, params)),
    transaction: work => client.transactionWithPreCommitCheck(work, () => {}),
    transactionWithPreCommitCheck: (work, check) => startup.db.transactionWithPreCommitCheck(async tx => {
      await tx.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
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

async function installRestrictedPools(startup) {
  await startup.raw.exec(readFileSync("db/roles/native_results_roles.sql", "utf8"));
  await startup.raw.exec(readFileSync("db/roles/native_evidence_roles.sql", "utf8"));
  await startup.raw.exec(`CREATE ROLE result_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE evidence_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_native_results TO result_test; GRANT control_room_native_evidence TO evidence_test`);
  return { result: restrictedPool(startup, "result_test"), evidence: restrictedPool(startup, "evidence_test") };
}

test("compiled four-role startup receives signed native evidence and submits separately captured bytes", async t => {
  const x = await nativeTaskLifecycleFixture(); t.after(x.close);
  // The authenticated delivery exists, but neither a caller-authored harness run nor a review plan does.
  assert.equal((await x.f.db.query("SELECT 1 AS present FROM control_harness_runs WHERE tenant_id=$1 AND id=$2",
    [x.registration.tenantId, x.registration.id])).rows.length, 0);
  assert.equal((await x.f.reviewStore.inspectSubject(x.registration.tenantId,
    x.registration.projectId, x.registration.jobId)).targets.length, 0);

  const startup = await taskStartupFixture(x.f.assignmentFixture);
  const { result, evidence } = await installRestrictedPools(startup);
  const resultDatabase = { ...startup.config.coordinator.database, username: "result_test" };
  const evidenceDatabase = { ...startup.config.coordinator.database, username: "evidence_test" };
  const evidenceSettings = { database: evidenceDatabase, integrityKey: new Uint8Array(32).fill(75),
    storage: { ...x.f.config, integrityKey: Uint8Array.from(x.f.config.integrityKey) },
    enrollments: [{ ...x.f.prepared.enrollment }] };
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
      : config.username === "evidence_test" ? evidence
      : (() => { throw new Error("unexpected_test_database"); })();
    const db = pool.client;
    const observe = work => async tx => work({ async query(sql, params) {
      const value = await tx.query(sql, params);
      if (sql.includes("AS database_temp"))
        preflights.push((await tx.query("SELECT current_user,session_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0]);
      const match = /INSERT INTO (control_[a-z_]+)/.exec(sql);
      if (match && ["control_harness_runs", "control_harness_run_events", "control_artifact_manifests",
        "control_native_artifact_receipts", "control_native_review_plans", "control_completion_gate_records"].includes(match[1])) {
        const identity = (await tx.query("SELECT current_user,session_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
        writes.push({ table: match[1], ...identity });
      }
      return value;
    } });
    return { ...pool, client: { ...db, transaction: work => db.transaction(observe(work)),
      transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(observe(work), check) } };
  };
  const starting = createPrivateTaskBootstrap({ clock: x.f.clock, openDatabase,
    install: value => { assert.equal(preflights.length, 4); installPrivateApplication(value); } }).start({
    ...startup.config, coordinator: { ...startup.config.coordinator,
      quality: { ...x.f.ownerConfig, scenarios: [scenario] }, resultDatabase,
      evidence: evidenceSettings },
  });
  // Startup synchronously captures all caller-owned evidence settings before its first preflight.
  evidenceSettings.database.username = "mutated_evidence_login";
  evidenceSettings.integrityKey.fill(0); evidenceSettings.enrollments[0].nodeId = "node:mutated";
  evidenceSettings.storage.integrityKey.fill(0);
  evidenceSettings.storage.storage = { put: async () => { throw new Error("mutated_put"); }, read: async () => undefined };
  const runtime = await starting;
  t.after(() => runtime.close());
  assert.equal(runtime.isReady(), true); assert.ok(runtime.evidence); assert.ok(runtime.results);
  assert.deepEqual(opened, ["web_test", "coordinator_test", "result_test", "evidence_test"]);
  assert.deepEqual(preflights, [
    { current_user: "web_test", session_user: "web_test", rolsuper: false },
    { current_user: "coordinator_test", session_user: "coordinator_test", rolsuper: false },
    { current_user: "result_test", session_user: "result_test", rolsuper: false },
    { current_user: "evidence_test", session_user: "evidence_test", rolsuper: false },
  ]);
  assert.deepEqual(Object.keys(runtime).sort(), ["close", "evidence", "isReady", "quality", "results"]);
  assert.deepEqual(Object.keys(runtime.evidence).sort(), ["receive", "register", "tenantId", "workspaceId"]);
  assert.equal(JSON.stringify(runtime).includes("evidence_test"), false);

  const input = { projectId: x.registration.projectId, jobId: x.registration.jobId,
    attemptId: x.registration.attemptId, inputDigest: x.f.assignmentFixture.prepared.receipt.inputDigest };
  const callsBeforeRegister = [...x.local.calls], effectsBeforeRegister = x.local.effects.countFull();
  const registered = await runtime.evidence.register(input, new AbortController().signal);
  assert.equal(registered.replayed, false); assert.equal(registered.receipt.projectId, input.projectId);
  assert.equal(registered.receipt.jobId, input.jobId); assert.equal(registered.receipt.runId, x.registration.id);
  assert.equal(registered.receipt.inputDigest, input.inputDigest); assert.equal(registered.receipt.startsWork, false);
  assert.equal(registered.receipt.grantsExecutionAuthority, false);
  assert.deepEqual(x.local.calls, callsBeforeRegister); assert.equal(x.local.effects.countFull(), effectsBeforeRegister);
  assert.equal((await startup.raw.query("SELECT 1 AS present FROM control_harness_runs WHERE tenant_id=$1 AND id=$2",
    [x.registration.tenantId, x.registration.id])).rows.length, 1);

  // PGlite retains SET LOCAL SESSION AUTHORIZATION after commit. Reset only at labelled
  // privileged fake-producer boundaries; each receiver/writer operation re-enters its role.
  await startup.raw.exec("SET SESSION AUTHORIZATION postgres");
  await x.handoff.start();
  let queued = await x.queueSnapshot();
  let received = await runtime.evidence.receive(x.session, queued.raw, undefined, new AbortController().signal);
  assert.equal(received.runId, x.registration.id); assert.equal(received.state, "starting");
  assert.equal(received.replayed, false); assert.equal(received.executionAuthorized, false);
  assert.equal("submission" in received, false);
  await startup.raw.exec("SET SESSION AUTHORIZATION postgres"); await x.acknowledgeSnapshot();

  x.advance(); await x.handoff.poll(); queued = await x.queueSnapshot();
  received = await runtime.evidence.receive(x.session, queued.raw, undefined, new AbortController().signal);
  assert.equal(received.state, "running"); assert.equal(received.executionAuthorized, false);
  await startup.raw.exec("SET SESSION AUTHORIZATION postgres"); await x.acknowledgeSnapshot();

  const text = "# Result\nA separately captured synthetic native result.\n# Evidence\nSigned fixture evidence.\n";
  const bytes = new TextEncoder().encode(text);
  x.advance(); x.setResult(text); await x.handoff.poll(); queued = await x.queueSnapshot();
  received = await runtime.evidence.receive(x.session, queued.raw, bytes, new AbortController().signal);
  assert.equal(received.state, "succeeded"); assert.equal(received.replayed, false);
  assert.equal(received.executionAuthorized, false); assert.ok(received.submission);
  assert.equal(received.submission.projectId, input.projectId); assert.equal(received.submission.jobId, input.jobId);
  assert.equal(received.submission.runId, x.registration.id); assert.equal(received.submission.rootSubjectId, input.jobId);
  assert.equal(received.submission.rootTargetId, received.submission.targetId);
  assert.equal(received.submission.revisionNumber, 0); assert.equal(received.submission.qualityAccepted, false);
  assert.equal(received.submission.grantsExecutionAuthority, false);
  await startup.raw.exec("SET SESSION AUTHORIZATION postgres"); await x.acknowledgeSnapshot();

  const artifactId = nativeResultId(x.registration.tenantId, x.registration.id);
  assert.deepEqual(await x.f.config.storage.read(artifactId), bytes);
  const subject = await x.f.reviewStore.inspectSubject(x.registration.tenantId, input.projectId, input.jobId);
  assert.equal(subject.targets.length, 1); assert.equal(subject.targets[0].snapshot.target.id, received.submission.targetId);
  assert.equal((await startup.raw.query(
    "SELECT 1 AS present FROM control_native_review_plans WHERE tenant_id=$1 AND run_id=$2",
    [x.registration.tenantId, x.registration.id])).rows.length, 1);
  assert.equal((await startup.raw.query(
    "SELECT 1 AS present FROM control_native_artifact_receipts WHERE tenant_id=$1 AND artifact_id=$2",
    [x.registration.tenantId, artifactId])).rows.length, 1);

  const nativeCalls = [...x.local.calls], nativeEffects = x.local.effects.countFull();
  const replay = await runtime.evidence.register(input, new AbortController().signal);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, registered.receipt);
  assert.deepEqual(x.local.calls, nativeCalls); assert.equal(x.local.effects.countFull(), nativeEffects);
  const evidenceTables = new Set(writes.filter(row => row.current_user === "evidence_test").map(row => row.table));
  const resultTables = new Set(writes.filter(row => row.current_user === "result_test").map(row => row.table));
  for (const table of ["control_harness_runs", "control_harness_run_events", "control_artifact_manifests", "control_native_artifact_receipts"])
    assert.equal(evidenceTables.has(table), true, table);
  for (const table of ["control_native_review_plans", "control_completion_gate_records"])
    assert.equal(resultTables.has(table), true, table);
  assert.ok(writes.every(row => row.session_user === row.current_user && row.rolsuper === false));

  const hiddenPath = `/api/v1/projects/${input.projectId}/tasks/${input.jobId}/evidence`;
  assert.equal((await handler(request(hiddenPath, "POST", input, undefined, x.f.jwt))).status, 404);
  const retained = runtime.evidence; await runtime.close(); assert.equal(runtime.isReady(), false);
  assert.equal(startup.web.closes(), 1); assert.equal(startup.coordinator.closes(), 1);
  assert.equal(result.closes(), 1); assert.equal(evidence.closes(), 1);
  await assert.rejects(retained.register(input, new AbortController().signal), { message: "task_coordinator_unavailable" });
  assert.deepEqual(x.local.calls, nativeCalls); assert.equal(x.local.effects.countFull(), nativeEffects);
});

test("compiled browser assets exclude trusted evidence receiver implementation and role material", () => {
  const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  const javascript = files("dist-vps/client").filter(file => file.endsWith(".js"));
  assert.ok(javascript.length > 0);
  for (const file of javascript) assert.doesNotMatch(readFileSync(file, "utf8"),
    /NativeEvidenceReceiver|control_room_native_evidence|native_evidence_uncertain|control_native_delivery_envelopes|control_native_transmission_intents/);
});
