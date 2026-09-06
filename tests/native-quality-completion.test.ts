import assert from "node:assert/strict";
import test from "node:test";
import { nativeQualityCompletionFixture, nativeQualityBatchFixture, qualityText, interceptNativeQualityDatabase } from "./helpers/native-quality-completion";
import type { DatabaseClient } from "../src/persistence/database";
import { sha256Digest } from "../src/security";

type Fixture = Awaited<ReturnType<typeof nativeQualityCompletionFixture>>;
const checkpoint = (x: Fixture) => x.f.checkpoints.read(`completion-gate:${x.request.tenantId}`);
const gate = (x: Fixture) => x.f.reviewStore.snapshot(x.request.tenantId, x.target.id);
const completionEvents = async (x: Fixture) => (await x.f.db.query<{ entity_kind: string; from_state: string; to_state: string }>(
  "SELECT entity_kind,from_state,to_state FROM control_transition_events WHERE tenant_id=$1 AND actor_id='service:native-task-completion' ORDER BY id",
  [x.request.tenantId])).rows;
const verifications = async (x: Fixture) => (await x.f.db.query("SELECT * FROM control_completion_gate_records WHERE kind='verification' AND parent_id=$1", [x.target.id])).rows;

test("actual native lifecycle, checked bytes, structural evidence and independent review complete one canonical attempt/job and release its lease", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close);
  const before = await x.states(), calls = [...x.local.calls];
  const initialCheckpoint = checkpoint(x)!;
  const verified = await x.verify();
  assert.equal(verified.replayed, false); assert.equal(verified.completesJob, false);
  assert.equal(verified.verifications.length, 1); assert.equal(verified.verifications[0].outcome, "passed");
  assert.deepEqual(verified.verifications[0].verifier, { actorType: "service", actorId: "service:document-structure-verifier" });
  assert.ok(verified.verifications[0].evidenceDigests.includes(x.artifact.contentHash));
  assert.ok(verified.verifications[0].evidenceDigests.includes(sha256Digest(x.scenario)));
  assert.equal(checkpoint(x)!.revision, initialCheckpoint.revision + 1);
  assert.equal((await gate(x)).status, "pending"); await assert.rejects(x.complete());
  const reviewed = await x.review();
  assert.deepEqual((await gate(x)).acceptedReviewIds, [reviewed.receipt.reviewId]); assert.equal((await gate(x)).status, "ready");
  const saved = await x.complete(), after = await x.states();
  assert.equal(saved.replayed, false); assert.equal(saved.receipt.grantsApproval, false); assert.equal(saved.receipt.grantsExecutionAuthority, false);
  assert.equal(after.job.state, "succeeded"); assert.equal(after.attempt.state, "succeeded"); assert.equal(after.lease.state, "released");
  assert.equal(after.job.version, before.job.version + 2); assert.equal(after.attempt.version, before.attempt.version + 2);
  assert.equal(after.lease.version, before.lease.version + 1); assert.equal(after.lease.expiresAt, before.lease.expiresAt);
  const run = await x.f.runs.get(x.request.tenantId, x.request.runId);
  assert.equal(after.attempt.startedAt, run!.startedAt); assert.equal(after.attempt.finishedAt, run!.finishedAt);
  assert.equal(saved.receipt.completedAt, run!.finishedAt); assert.equal(saved.receipt.recordedAt, new Date(x.f.clock()).toISOString());
  assert.deepEqual((await completionEvents(x)).map(row => `${row.entity_kind}:${row.from_state}->${row.to_state}`).sort(),
    ["attempt:leased->running", "attempt:running->succeeded", "job:leased->running", "job:running->succeeded", "lease:active->released"]);
  assert.equal((await x.f.db.query("SELECT id FROM control_outbox WHERE id LIKE 'outbox:transition:native-completion:%'")).rows.length, 5);
  assert.equal((await x.f.db.query("SELECT id FROM audit_events WHERE action='task.native.completed' AND target_id=$1", [x.registration.jobId])).rows.length, 1);
  assert.equal((await x.f.db.query("SELECT id FROM control_artifact_manifests WHERE job_id=$1", [x.registration.jobId])).rows.length, 1);
  assert.equal((await x.f.db.query("SELECT artifact_id FROM control_artifact_lineage WHERE job_id=$1", [x.registration.jobId])).rows.length, 0);
  assert.deepEqual(x.local.calls, calls); assert.equal(x.local.effects.countFull(), 1);
  assert.equal((await x.f.canonical.get(x.request.tenantId, "workflow", after.job.workflowId))!.state, "active");
  assert.equal(JSON.stringify((await x.f.db.query("SELECT * FROM audit_events WHERE action='task.result.structure_verified'")).rows).includes(qualityText), false);
});

test("missing verification, failed structure and requested changes cannot complete the task", async t => {
  for (const mode of ["unverified", "failed_structure", "changes_requested"] as const) await t.test(mode, async t => {
    const x = await nativeQualityCompletionFixture(mode === "failed_structure" ? "# Result\nMissing evidence heading." : qualityText); t.after(x.close);
    if (mode !== "unverified") await x.verify();
    await x.review(mode === "changes_requested" ? "changes_requested" : "accepted");
    const before = await x.states(); await assert.rejects(x.complete()); assert.deepEqual(await x.states(), before);
    assert.deepEqual(await completionEvents(x), []);
    if (mode === "failed_structure") {
      assert.equal((await gate(x)).status, "verification_blocked");
      const replay = await x.verify(); assert.equal(replay.replayed, true); assert.equal(replay.verifications[0].outcome, "failed");
    }
  });
});

test("concurrent exact verification and completion replays produce one immutable result and no extra native work", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close); const before = checkpoint(x)!;
  const verified = await Promise.all(Array.from({ length: 3 }, () => x.verify()));
  assert.equal(verified.filter(value => !value.replayed).length, 1); assert.equal((await verifications(x)).length, 1);
  assert.equal(checkpoint(x)!.revision, before.revision + 1); await x.review();
  const calls = [...x.local.calls], values = await Promise.all(Array.from({ length: 3 }, () => x.complete()));
  assert.equal(values.filter(value => !value.replayed).length, 1);
  for (const value of values) assert.deepEqual(value.receipt, values[0].receipt);
  x.advance(); assert.deepEqual((await x.complete()).receipt, values[0].receipt);
  assert.equal((await completionEvents(x)).length, 5); assert.deepEqual(x.local.calls, calls);
});

test("lost acknowledgement after verification or completion is reconciled explicitly without another commit", async t => {
  for (const operation of ["verification", "completion"] as const) await t.test(operation, async t => {
    const x = await nativeQualityCompletionFixture(); t.after(x.close); if (operation === "completion") await x.ready();
    let commits = 0;
    const db: DatabaseClient = { ...x.f.db, async transactionWithPreCommitCheck(work, check) {
      await x.f.db.transactionWithPreCommitCheck(work, check); commits++; throw new Error("synthetic_quality_ack_lost");
    } };
    await assert.rejects(operation === "verification" ? x.createVerification(db).verify(x.request, () => {})
      : x.createCompletion(db).complete(x.request, () => {}), /synthetic_quality_ack_lost/);
    assert.equal(commits, 1); const prior = checkpoint(x), events = await completionEvents(x);
    const replay = operation === "verification" ? await x.verify() : await x.complete(); assert.equal(replay.replayed, true);
    assert.deepEqual(checkpoint(x), prior); assert.deepEqual(await completionEvents(x), events);
  });
});

test("no default structural scenario and changed rules, content or exact target are rejected", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close);
  await assert.rejects(x.createVerification(x.f.db, []).verify(x.request, () => {}), /not_configured/);
  await assert.rejects(x.createVerification(x.f.db, [{ ...x.scenario, acceptanceProfileDigest: sha256Digest("other profile") }])
    .verify(x.request, () => {}), /not_configured/);
  await x.ready(); const before = await x.states(), cp = checkpoint(x);
  await assert.rejects(x.createVerification(x.f.db, [{ ...x.scenario, rules: { ...x.scenario.rules, requiredHeadings: ["Different"] } }])
    .verify(x.request, () => {}), /conflict/);
  for (const patch of [{ targetDigest: sha256Digest("other target") }, { contentHash: sha256Digest("other bytes") },
    { runId: "run:other" }, { tenantId: "tenant:other" }]) {
    await assert.rejects(x.createVerification().verify({ ...x.request, ...patch }, () => {}));
    await assert.rejects(x.createCompletion().complete({ ...x.request, ...patch }, () => {}));
  }
  assert.deepEqual(await x.states(), before); assert.deepEqual(checkpoint(x), cp);
});

test("missing or changed stored bytes cannot be verified or completed even after prior checks passed", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close); await x.ready();
  const before = await x.states(), cp = checkpoint(x);
  for (const read of [async () => undefined, async () => new TextEncoder().encode("Different bytes.")]) {
    const config = { ...x.f.ownerConfig, results: { ...x.f.ownerConfig.results, storage: { read } } };
    await assert.rejects(x.createVerification(x.f.db, [x.scenario], config).verify(x.request, () => {}));
    await assert.rejects(x.createCompletion(x.f.db, config).complete(x.request, () => {}));
  }
  assert.deepEqual(await x.states(), before); assert.deepEqual(checkpoint(x), cp);
});

test("SQL failure and actual precommit cancellation roll back all completion state or staged verification evidence", async t => {
  for (const operation of ["verification", "completion"] as const) for (const mode of ["sql", "precommit"] as const)
    await t.test(`${operation}:${mode}`, async t => {
      const x = await nativeQualityCompletionFixture(); t.after(x.close); if (operation === "completion") await x.ready();
      const before = await x.states(), cp = checkpoint(x), prior = await verifications(x);
      let reached = false, cancelled = false;
      const db = mode === "sql" ? interceptNativeQualityDatabase(x.f.db, sql => {
        if (sql.includes("INSERT INTO audit_events")) { reached = true; throw new Error("synthetic_quality_sql_failure"); }
      }) : { ...x.f.db, transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(work, () => {
        reached = true; cancelled = true; check();
      }) } satisfies DatabaseClient;
      const guard = () => { if (cancelled) throw new Error("synthetic_quality_cancelled"); };
      await assert.rejects(operation === "verification" ? x.createVerification(db).verify(x.request, guard)
        : x.createCompletion(db).complete(x.request, guard));
      assert.equal(reached, true); assert.deepEqual(await x.states(), before); assert.deepEqual(checkpoint(x), cp);
      assert.deepEqual(await verifications(x), prior); assert.deepEqual(await completionEvents(x), []);
    });
});

test("completed-before-deadline work can be reviewed after expiry and release an active unreplaced lease without renewal", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close); const before = await x.states();
  x.f.setNow(Date.parse(before.lease.expiresAt) + 1); await x.ready();
  const saved = await x.complete(), after = await x.states();
  assert.ok(Date.parse(saved.receipt.completedAt) < Date.parse(before.lease.expiresAt));
  assert.ok(Date.parse(saved.receipt.recordedAt) > Date.parse(before.lease.expiresAt));
  assert.equal(after.job.state, "succeeded"); assert.equal(after.lease.state, "released");
  assert.equal(after.lease.expiresAt, before.lease.expiresAt); assert.equal(after.lease.renewedAt, before.lease.renewedAt);
});

test("canonical expiry wins and its orphaned attempt is not resurrected by late successful evidence", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close); await x.ready();
  const before = await x.states(); x.f.setNow(Date.parse(before.lease.expiresAt) + 1);
  await x.f.canonical.expireLease({ tenantId: x.request.tenantId, jobId: before.job.id, attemptId: before.attempt.id,
    leaseId: before.lease.id, expectedJobVersion: before.job.version, expectedAttemptVersion: before.attempt.version,
    expectedLeaseVersion: before.lease.version, epoch: before.lease.epoch, transitionId: "transition:quality-expiry",
    idempotencyKey: "native-quality-expiry-001", actor: { actorId: "identity:test", actorType: "human" }, occurredAt: new Date(x.f.clock()).toISOString() });
  const expired = await x.states(); assert.equal(expired.attempt.state, "orphaned"); assert.equal(expired.lease.state, "expired");
  await assert.rejects(x.complete()); assert.deepEqual(await x.states(), expired); assert.deepEqual(await completionEvents(x), []);
});

test("cancelled, failed or orphaned canonical state cannot be resurrected", async t => {
  for (const state of ["cancelled", "failed", "orphaned"] as const) await t.test(state, async t => {
    const x = await nativeQualityCompletionFixture(); t.after(x.close); await x.ready();
    // Seed the consistent persisted result of a competing canonical operation in this disposable database.
    for (const [table, entityId] of [["control_jobs", x.registration.jobId], ["control_attempts", x.registration.attemptId]])
      await x.f.db.query(`UPDATE ${table} SET state=$1,version=version+1,payload=payload || jsonb_build_object('state',$1::text,'version',version+1)
        || $3::jsonb WHERE id=$2`, [state, entityId, JSON.stringify(table === "control_attempts"
        ? { startedAt: x.completed.body.observedAt, finishedAt: x.completed.body.observedAt } : {})]);
    const before = await x.states(); await assert.rejects(x.complete()); assert.deepEqual(await x.states(), before);
    assert.deepEqual(await completionEvents(x), []);
  });
});

test("a superseded review target cannot be verified or completed", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close); await x.verify(); const review = await x.review("changes_requested");
  const target = { ...x.target, id: "target:quality:revision", subjectDigest: sha256Digest("revised content"),
    revisionNumber: 1, supersedesTargetId: x.target.id };
  await x.f.reviewStore.recordRevision({ schemaVersion: "control-room-completion-gate/v1", id: "revision:quality:test",
    tenantId: x.request.tenantId, projectId: x.registration.projectId, rootTargetId: x.target.rootTargetId,
    fromTargetId: x.target.id, fromTargetDigest: x.request.targetDigest, toTargetId: target.id, toTargetDigest: sha256Digest(target),
    revisionNumber: 1, resolvedFindingIds: [review.receipt.findingId!], revisedBy: target.producer, revisedAt: target.submittedAt,
    grantsApproval: false, grantsExecutionAuthority: false }, target);
  assert.equal((await gate(x)).status, "superseded"); await assert.rejects(x.complete()); await assert.rejects(x.verify());
  assert.deepEqual(await completionEvents(x), []);
});

test("three configured structural scenarios commit one complete checkpoint batch and replay without advancing", async t => {
  const f = await nativeQualityBatchFixture(); t.after(f.close);
  const scope = `completion-gate:${f.request.tenantId}`, before = f.checkpoints.read(scope)!;
  const saved = await f.verifier.verify(f.request, () => {});
  assert.equal(saved.replayed, false); assert.equal(saved.verifications.length, 3);
  assert.deepEqual(saved.verifications.map(value => value.scenarioId).sort(), [...f.profile.requiredVerificationScenarioIds].sort());
  assert.ok(saved.verifications.every(value => value.outcome === "passed"));
  assert.equal(f.checkpoints.read(scope)!.revision, before.revision + 3);
  const replay = await f.verifier.verify(f.request, () => {}); assert.equal(replay.replayed, true);
  assert.deepEqual(replay.verifications, saved.verifications); assert.equal(f.checkpoints.read(scope)!.revision, before.revision + 3);
  assert.equal((await f.reviewStore.snapshot(f.request.tenantId, f.target.id)).status, "pending", "independent review still required");
});

test("clock rollback after observed forward time at precommit rejects verification and canonical completion", async t => {
  for (const operation of ["verification", "completion"] as const) await t.test(operation, async t => {
    const x = await nativeQualityCompletionFixture(); t.after(x.close); if (operation === "completion") await x.ready();
    const before = await x.states(), cp = checkpoint(x), prior = await verifications(x), started = x.f.clock();
    let now = started, advanced = false, fenced = false;
    const observed = interceptNativeQualityDatabase(x.f.db, sql => { if (sql.includes("INSERT INTO audit_events")) {
      now = started + 100; advanced = true;
    } });
    const db: DatabaseClient = { ...observed, transactionWithPreCommitCheck: (work, check) => observed.transactionWithPreCommitCheck(work, () => {
      fenced = true; now = started + 50; check();
    }) };
    await assert.rejects(operation === "verification" ? x.createVerification(db, [x.scenario], x.f.ownerConfig, () => now).verify(x.request, () => {})
      : x.createCompletion(db, x.f.ownerConfig, () => now).complete(x.request, () => {}));
    assert.equal(advanced, true); assert.equal(fenced, true); assert.deepEqual(await x.states(), before);
    assert.deepEqual(checkpoint(x), cp); assert.deepEqual(await verifications(x), prior); assert.deepEqual(await completionEvents(x), []);
  });
});

test("retained and fresh verifier instances reject replay from a future verification timestamp", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close); const service = x.createVerification();
  x.advance(); await service.verify(x.request, () => {}); const prior = await verifications(x), cp = checkpoint(x);
  x.f.setNow(x.f.clock() - 500);
  await assert.rejects(service.verify(x.request, () => {}), /unavailable/);
  await assert.rejects(x.verify(), /conflict/);
  assert.deepEqual(await verifications(x), prior); assert.deepEqual(checkpoint(x), cp);
});

test("a replaced attempt remains current when completion is requested for the earlier successful run", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close); await x.ready(); const before = await x.states();
  const now = Date.parse(before.lease.expiresAt) + 1; x.f.setNow(now);
  const expired = await x.f.canonical.expireLease({ tenantId: x.request.tenantId, jobId: before.job.id, attemptId: before.attempt.id,
    leaseId: before.lease.id, expectedJobVersion: before.job.version, expectedAttemptVersion: before.attempt.version,
    expectedLeaseVersion: before.lease.version, epoch: before.lease.epoch, transitionId: "transition:quality-replaced-expiry",
    idempotencyKey: "native-quality-replaced-expiry", actor: { actorId: "identity:test", actorType: "human" }, occurredAt: new Date(now).toISOString() });
  const replacement = await x.f.canonical.claimReadyJob({ tenantId: x.request.tenantId, jobId: before.job.id, expectedJobVersion: expired.job.version,
    nodeId: x.registration.nodeId, attemptId: "attempt:quality:replacement", leaseId: "lease:quality:replacement",
    transitionId: "transition:quality:replacement", idempotencyKey: "native-quality-replacement",
    actor: { actorId: "identity:test", actorType: "human" }, acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + 1000).toISOString() });
  await assert.rejects(x.complete());
  assert.deepEqual(await x.f.canonical.get(x.request.tenantId, "job", replacement.job.id), replacement.job);
  assert.deepEqual(await x.f.canonical.get(x.request.tenantId, "attempt", replacement.attempt.id), replacement.attempt);
  assert.deepEqual(await x.f.canonical.get(x.request.tenantId, "lease", replacement.lease.id), replacement.lease);
  assert.deepEqual(await completionEvents(x), []);
});

test("already-running canonical entities complete without repeated running projections", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close); await x.ready();
  const run = await x.f.runs.get(x.request.tenantId, x.request.runId);
  for (const [table, entityId] of [["control_jobs", x.registration.jobId], ["control_attempts", x.registration.attemptId]])
    await x.f.db.query(`UPDATE ${table} SET state='running',version=version+1,payload=payload || jsonb_build_object('state','running','version',version+1)
      || $2::jsonb WHERE id=$1`, [entityId, JSON.stringify(table === "control_attempts" ? { startedAt: run!.startedAt } : {})]);
  const before = await x.states(), saved = await x.complete(), after = await x.states();
  assert.equal(after.job.version, before.job.version + 1); assert.equal(after.attempt.version, before.attempt.version + 1);
  assert.equal(after.lease.state, "released"); assert.equal(saved.receipt.attemptVersion, after.attempt.version);
  assert.equal((await completionEvents(x)).length, 3);
});

test("indexed canonical lineage mismatch and terminal evidence at the lease deadline are rejected", async t => {
  for (const mode of ["attempt_epoch", "job_authority", "terminal_at_expiry"] as const) await t.test(mode, async t => {
    const x = await nativeQualityCompletionFixture(); t.after(x.close); await x.ready();
    if (mode !== "terminal_at_expiry") {
      const table = mode === "attempt_epoch" ? "control_attempts" : "control_jobs";
      const sql = mode === "attempt_epoch" ? "UPDATE control_attempts SET lease_epoch=lease_epoch+1 WHERE id=$1"
        : "UPDATE control_jobs SET authority_digest=$2 WHERE id=$1";
      const args = mode === "attempt_epoch" ? [x.registration.attemptId] : [x.registration.jobId, sha256Digest("other authority")];
      await assert.rejects(x.f.db.query(sql, args), /payload mirror mismatch/);
      // Privileged disposable corruption must also fail at the service's indexed-lineage fence.
      await x.f.raw.exec(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_payload_mirror`); await x.f.db.query(sql, args);
    }
    if (mode === "terminal_at_expiry") await x.f.db.query("UPDATE control_leases SET expires_at=$1::text::timestamptz,payload=jsonb_set(payload,'{expiresAt}',to_jsonb($1::text)) WHERE id=$2",
      [x.completed.body.observedAt, x.registration.nativeTask!.leaseId]);
    const before = await x.states(); await assert.rejects(x.complete()); assert.deepEqual(await x.states(), before);
    assert.deepEqual(await completionEvents(x), []);
  });
});

test("corrupted persisted review-plan authentication cannot replay verification or complete canonical work", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close); await x.ready();
  const before = await x.states(), cp = checkpoint(x);
  const sql = "UPDATE control_native_review_plans SET auth_tag=$1 WHERE run_id=$2";
  const args = [`hmac-sha256:${"0".repeat(64)}`, x.request.runId];
  await assert.rejects(x.f.db.query(sql, args), /append-only/);
  await x.f.raw.exec("ALTER TABLE control_native_review_plans DISABLE TRIGGER control_native_review_plans_immutable");
  await x.f.db.query(sql, args);
  await assert.rejects(x.verify()); await assert.rejects(x.complete());
  assert.deepEqual(await x.states(), before); assert.deepEqual(checkpoint(x), cp); assert.deepEqual(await completionEvents(x), []);
});
