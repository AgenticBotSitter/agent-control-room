import assert from "node:assert/strict";
import test from "node:test";
import { nativeQualityCompletionFixture, qualityText, interceptNativeQualityDatabase } from "./helpers/native-quality-completion";
import { nativeRevisedResultFixture } from "./helpers/native-revised-result";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { sha256Digest } from "../src/security";

type Fixture = Awaited<ReturnType<typeof nativeQualityCompletionFixture>>;
const release = (x: Fixture) => x.createCompletion().releaseCapacity(x.request, () => {});
const capacityEvents = async (x: Fixture) => (await x.f.db.query(
  "SELECT * FROM control_transition_events WHERE tenant_id=$1 AND actor_id='service:native-capacity-release' ORDER BY id", [x.request.tenantId])).rows;
const evidence = async (x: Fixture) => ({
  gate: await x.f.reviewStore.snapshot(x.request.tenantId, x.target.id),
  records: (await x.f.db.query("SELECT * FROM control_completion_gate_records ORDER BY id")).rows,
  checkpoint: x.f.checkpoints.read(`completion-gate:${x.request.tenantId}`),
  run: await x.f.runs.get(x.request.tenantId, x.request.runId),
  artifacts: (await x.f.db.query("SELECT * FROM control_artifact_manifests WHERE job_id=$1", [x.registration.jobId])).rows,
  calls: [...x.local.calls], effects: x.local.effects.countFull(),
});

// Alter only a disposable transaction's returned proof, not the append-only event store.
function proofView(db: DatabaseClient, mode: "missing" | "tampered"): DatabaseClient {
  const session = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
    const result = await tx.query<T>(sql, params);
    if (sql.includes("FROM control_transition_events") && typeof params?.[1] === "string" && params[1].startsWith("native-capacity:")) {
      if (mode === "missing") return { rows: [] };
      return { rows: result.rows.map(row => {
        const value = structuredClone(row) as T & { safe_metadata: { authTag: string } };
        value.safe_metadata.authTag = "hmac-sha256:" + "0".repeat(64); return value;
      }) };
    }
    return result;
  } });
  return { query: db.query.bind(db), transaction: work => db.transaction(tx => work(session(tx))),
    transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(tx => work(session(tx)), check) };
}

test("completed fake-native work releases capacity without changing pending, changes-requested or failed quality truth", async t => {
  for (const mode of ["pending", "changes_requested", "verification_blocked"] as const) await t.test(mode, async t => {
    const x = await nativeQualityCompletionFixture(mode === "verification_blocked" ? "# Result\nMissing evidence heading." : qualityText); t.after(x.close);
    if (mode !== "pending") await x.verify();
    if (mode === "changes_requested") await x.review("changes_requested");
    if (mode === "verification_blocked") await x.review();
    const before = await x.states(), prior = await evidence(x);
    assert.equal(prior.gate.status, mode);
    const saved = await release(x), after = await x.states();
    assert.equal(saved.replayed, false); assert.equal(saved.receipt.qualityAccepted, false);
    assert.equal(saved.receipt.grantsApproval, false); assert.equal(saved.receipt.grantsExecutionAuthority, false);
    assert.equal(saved.receipt.jobId, before.job.id); assert.equal(saved.receipt.attemptId, before.attempt.id);
    assert.equal(saved.receipt.leaseEpoch, before.lease.epoch); assert.equal(saved.receipt.completedAt, prior.run!.finishedAt);
    assert.equal(saved.receipt.releasedAt, new Date(x.f.clock()).toISOString());
    assert.deepEqual(after.job, before.job); assert.deepEqual(after.attempt, before.attempt);
    assert.deepEqual(after.lease, { ...before.lease, state: "released", version: before.lease.version + 1, updatedAt: saved.receipt.releasedAt });
    assert.deepEqual(await evidence(x), prior); await assert.rejects(x.complete());
    assert.equal((await capacityEvents(x)).length, 1);
    assert.equal((await x.f.db.query("SELECT id FROM control_outbox WHERE id LIKE 'outbox:transition:native-capacity:%'")).rows.length, 1);
    assert.equal((await x.f.db.query("SELECT id FROM audit_events WHERE action='task.native.capacity_released' AND target_id=$1", [before.job.id])).rows.length, 1);
  });
});

test("concurrent releases and later exact replay share one immutable receipt and one lease transition", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close); const prior = await evidence(x);
  const values = await Promise.all(Array.from({ length: 3 }, () => release(x)));
  assert.equal(values.filter(value => !value.replayed).length, 1);
  for (const value of values) assert.deepEqual(value.receipt, values[0].receipt);
  const state = await x.states(); x.advance();
  assert.deepEqual(await release(x), { receipt: values[0].receipt, replayed: true });
  assert.deepEqual(await x.states(), state); assert.deepEqual(await evidence(x), prior);
  assert.equal((await capacityEvents(x)).length, 1);
});

test("a real synthetic revised child can supersede the source target while source capacity releases without quality success", async t => {
  const x = await nativeRevisedResultFixture(); t.after(x.close);
  const original = x.original, before = await original.states(), childBefore = await x.childStates();
  const prior = await evidence(original), counters = x.counters();
  assert.equal(prior.gate.status, "superseded");
  const childGate = await x.f.reviewStore.snapshot(x.request.tenantId, x.child.target.id);
  const saved = await release(original), after = await original.states();
  assert.equal(saved.replayed, false); assert.equal(saved.receipt.qualityAccepted, false);
  assert.equal(after.lease.state, "released"); assert.equal(after.lease.version, before.lease.version + 1);
  assert.deepEqual(after.job, before.job); assert.deepEqual(after.attempt, before.attempt);
  await assert.rejects(original.complete());
  assert.deepEqual(await evidence(original), prior); assert.deepEqual(await x.childStates(), childBefore);
  assert.deepEqual(await x.f.reviewStore.snapshot(x.request.tenantId, x.child.target.id), childGate);
  assert.deepEqual(x.counters(), counters); assert.equal((await capacityEvents(original)).length, 1);
});

test("later acceptance completes job and attempt without rewriting the earlier released lease", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close);
  const released = await release(x), before = await x.states(); x.advance(); await x.ready();
  const prior = await evidence(x), completed = await x.complete(), after = await x.states();
  assert.equal(after.job.state, "succeeded"); assert.equal(after.attempt.state, "succeeded");
  assert.deepEqual(after.lease, before.lease); assert.equal(completed.receipt.leaseVersion, released.receipt.leaseVersion);
  assert.equal(completed.receipt.capacityReleaseDigest, sha256Digest(released.receipt));
  assert.ok(Date.parse(completed.receipt.recordedAt) > Date.parse(released.receipt.releasedAt));
  x.advance(); assert.deepEqual(await x.complete(), { receipt: completed.receipt, replayed: true });
  await assert.rejects(release(x)); assert.deepEqual(await x.states(), after); assert.deepEqual(await evidence(x), prior);
  assert.equal((await x.f.db.query("SELECT id FROM control_transition_events WHERE actor_id='service:native-task-completion' AND tenant_id=$1", [x.request.tenantId])).rows.length, 4);
});

test("missing or tampered capacity proof cannot authorize release replay, completion or same-timestamp completion replay", async t => {
  for (const mode of ["missing", "tampered"] as const) await t.test(mode, async t => {
    const x = await nativeQualityCompletionFixture(); t.after(x.close); const saved = await release(x); await x.ready();
    const service = x.createCompletion(proofView(x.f.db, mode)), before = await x.states(), prior = await evidence(x);
    await assert.rejects(service.releaseCapacity(x.request, () => {}));
    await assert.rejects(service.complete(x.request, () => {}));
    assert.deepEqual(await x.states(), before); assert.deepEqual(await evidence(x), prior);
    const completed = await x.complete();
    assert.equal(completed.receipt.recordedAt, saved.receipt.releasedAt, "intentional same-clock regression");
    assert.equal(completed.receipt.capacityReleaseDigest, sha256Digest(saved.receipt));
    const finished = await x.states(); await assert.rejects(service.complete(x.request, () => {}));
    assert.deepEqual(await x.states(), finished); assert.equal((await x.complete()).replayed, true);
  });
});

test("an arbitrary released lease with no signed capacity transition is not adopted", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close); await x.ready();
  // Synthetic competing projection only: no production transition or role is altered.
  await x.f.db.query("UPDATE control_leases SET state='released',version=version+1,payload=payload || jsonb_build_object('state','released','version',version+1) WHERE id=$1", [x.registration.nativeTask!.leaseId]);
  const before = await x.states(); await assert.rejects(release(x)); await assert.rejects(x.complete());
  assert.deepEqual(await x.states(), before); assert.deepEqual(await capacityEvents(x), []);
});

test("same-version mirror-consistent job or attempt state changes invalidate the full-record release proof", async t => {
  for (const kind of ["job", "attempt"] as const) await t.test(kind, async t => {
    const x = await nativeQualityCompletionFixture(); t.after(x.close);
    const saved = await release(x); await x.ready();
    const before = await x.states(), prior = await evidence(x), events = await capacityEvents(x);
    assert.equal(saved.receipt.jobRecordDigest, sha256Digest(before.job));
    assert.equal(saved.receipt.attemptRecordDigest, sha256Digest(before.attempt));
    assert.equal(before[kind].state, "leased");
    // Disposable, mirror-consistent corruption: versions and timestamps deliberately remain unchanged.
    // Both states are otherwise eligible, so the new full-record binding must refuse adoption.
    const table = kind === "job" ? "control_jobs" : "control_attempts";
    const started = kind === "attempt" ? { startedAt: prior.run!.startedAt } : {};
    await x.f.db.query(`UPDATE ${table} SET state='running',payload=jsonb_set(payload,'{state}','"running"'::jsonb) || $2::jsonb WHERE id=$1`,
      [before[kind].id, JSON.stringify(started)]);
    const changed = await x.states();
    assert.deepEqual(changed[kind], { ...before[kind], state: "running", ...started });
    assert.equal(changed[kind].version, before[kind].version);
    assert.notEqual(sha256Digest(changed[kind]), kind === "job" ? saved.receipt.jobRecordDigest : saved.receipt.attemptRecordDigest);
    await assert.rejects(release(x)); await assert.rejects(x.complete());
    assert.deepEqual(await x.states(), changed); assert.deepEqual(await evidence(x), prior);
    assert.deepEqual(await capacityEvents(x), events);
    assert.equal((await x.f.db.query("SELECT id FROM control_transition_events WHERE actor_id='service:native-task-completion' AND tenant_id=$1", [x.request.tenantId])).rows.length, 0);
  });
});

test("wrong request, missing or changed bytes and mismatched attempt epoch refuse release without evidence changes", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close); const before = await x.states(), prior = await evidence(x);
  for (const patch of [{ tenantId: "tenant:other" }, { runId: "run:other" }, { targetDigest: sha256Digest("other target") }, { contentHash: sha256Digest("other bytes") }])
    await assert.rejects(x.createCompletion().releaseCapacity({ ...x.request, ...patch }, () => {}));
  for (const read of [async () => undefined, async () => new TextEncoder().encode("Changed bytes")]) {
    const config = { ...x.f.ownerConfig, results: { ...x.f.ownerConfig.results, storage: { read } } };
    await assert.rejects(x.createCompletion(x.f.db, config).releaseCapacity(x.request, () => {}));
  }
  assert.deepEqual(await x.states(), before);
  // Keep the SQL/payload mirror valid; the synthetic epoch now disagrees with the authenticated run and lease.
  await x.f.db.query("UPDATE control_attempts SET lease_epoch=lease_epoch+1,payload=jsonb_set(payload,'{leaseEpoch}',to_jsonb(lease_epoch+1)) WHERE id=$1", [before.attempt.id]);
  const mismatched = await x.states();
  await assert.rejects(release(x)); assert.deepEqual(await x.states(), mismatched);
  assert.deepEqual(await evidence(x), prior); assert.deepEqual(await capacityEvents(x), []);
});

test("cancelled canonical jobs and actually expired reservations cannot be released by late successful evidence", async t => {
  for (const mode of ["cancelled", "expired"] as const) await t.test(mode, async t => {
    const x = await nativeQualityCompletionFixture(); t.after(x.close); const before = await x.states();
    if (mode === "cancelled") {
      await x.f.db.query("UPDATE control_jobs SET state='cancelled',version=version+1,payload=payload || jsonb_build_object('state','cancelled','version',version+1) WHERE id=$1", [before.job.id]);
    } else {
      x.f.setNow(Date.parse(before.lease.expiresAt) + 1);
      await x.f.canonical.expireLease({ tenantId: x.request.tenantId, jobId: before.job.id, attemptId: before.attempt.id,
        leaseId: before.lease.id, expectedJobVersion: before.job.version, expectedAttemptVersion: before.attempt.version,
        expectedLeaseVersion: before.lease.version, epoch: before.lease.epoch, transitionId: "transition:capacity-expiry",
        idempotencyKey: "native-capacity-expiry-001", actor: { actorId: "identity:test", actorType: "human" }, occurredAt: new Date(x.f.clock()).toISOString() });
    }
    const changed = await x.states(), prior = await evidence(x); await assert.rejects(release(x));
    assert.deepEqual(await x.states(), changed); assert.deepEqual(await evidence(x), prior); assert.deepEqual(await capacityEvents(x), []);
  });
});

test("authenticated on-time completion can release an active unreplaced reservation after its deadline", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close); const before = await x.states();
  x.f.setNow(Date.parse(before.lease.expiresAt) + 1); const saved = await release(x);
  assert.ok(Date.parse(saved.receipt.completedAt) < Date.parse(before.lease.expiresAt));
  assert.ok(Date.parse(saved.receipt.releasedAt) > Date.parse(before.lease.expiresAt));
  assert.deepEqual((await x.states()).job, before.job); assert.equal((await x.states()).lease.state, "released");
});

test("SQL failure, precommit cancellation and clock rollback roll back the lease and its evidence", async t => {
  for (const mode of ["sql", "cancel", "clock"] as const) await t.test(mode, async t => {
    const x = await nativeQualityCompletionFixture(); t.after(x.close); const before = await x.states(), prior = await evidence(x);
    const started = x.f.clock(); let now = started, reached = false, cancelled = false;
    const observed = interceptNativeQualityDatabase(x.f.db, sql => {
      if (sql.includes("INSERT INTO audit_events")) {
        reached = true; if (mode === "sql") throw new Error("synthetic_capacity_sql_failure");
        if (mode === "clock") now = started + 100;
      }
    });
    const db: DatabaseClient = { ...observed, transactionWithPreCommitCheck: (work, check) => observed.transactionWithPreCommitCheck(work, () => {
      if (mode === "clock") now = started + 50;
      if (mode === "cancel") cancelled = true;
      return check();
    }) };
    await assert.rejects(x.createCompletion(db, x.f.ownerConfig, () => now).releaseCapacity(x.request, () => {
      if (cancelled) throw new Error("synthetic_capacity_cancelled");
    }));
    assert.equal(reached, true); assert.deepEqual(await x.states(), before); assert.deepEqual(await evidence(x), prior);
    assert.deepEqual(await capacityEvents(x), []);
    assert.equal((await x.f.db.query("SELECT id FROM control_outbox WHERE id LIKE 'outbox:transition:native-capacity:%'")).rows.length, 0);
    assert.equal((await x.f.db.query("SELECT id FROM audit_events WHERE action='task.native.capacity_released'")).rows.length, 0);
  });
});

test("lost acknowledgement or postcommit currentness failure preserves one durable release for fresh exact replay", async t => {
  for (const mode of ["lost_ack", "cancel", "deadline"] as const) await t.test(mode, async t => {
    const x = await nativeQualityCompletionFixture(); t.after(x.close); const before = await x.states(), prior = await evidence(x);
    let committed = false, now = x.f.clock();
    const db: DatabaseClient = { ...x.f.db, async transactionWithPreCommitCheck(work, check) {
      const result = await x.f.db.transactionWithPreCommitCheck(work, check); committed = true;
      if (mode === "lost_ack") throw new Error("synthetic_capacity_ack_lost");
      if (mode === "deadline") now += 10001;
      return result;
    } };
    await assert.rejects(x.createCompletion(db, x.f.ownerConfig, () => now).releaseCapacity(x.request, () => {
      if (mode === "cancel" && committed) throw new Error("synthetic_capacity_cancelled");
    }));
    assert.equal(committed, true); const durable = await x.states();
    assert.equal(durable.lease.state, "released"); assert.deepEqual(durable.job, before.job); assert.deepEqual(durable.attempt, before.attempt);
    assert.equal((await release(x)).replayed, true); assert.deepEqual(await x.states(), durable);
    assert.deepEqual(await evidence(x), prior); assert.equal((await capacityEvents(x)).length, 1);
  });
});
