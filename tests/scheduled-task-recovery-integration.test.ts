import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { DOMAIN_CONTRACT_VERSION, type AuthorityEnvelope, type ScheduleRecord } from "../src/domain/v1";
import { CanonicalStore, type ProposedWorkBundle } from "../src/persistence/canonical-store";
import { adaptPglite, type DatabaseClient } from "../src/persistence/database";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { ScheduleOccurrenceStore } from "../src/services/v1/occurrence-store";
import { computeScheduledTaskDefinitionDigestV1 } from "../src/services/v1/scheduled-task-admission";
import { ScheduledTaskDispatchServiceV1 } from "../src/services/v1/scheduled-task-dispatch";
import { ScheduledTaskRecoveryServiceV1 } from "../src/services/v1/scheduled-task-recovery";

const tenantId = "tenant:schedule-recovery";
const workspaceId = "workspace:schedule-recovery";
const projectId = "project:schedule-recovery";
const scheduleId = "schedule:recovery-daily";
const sourceRequestId = "request:recovery-template";
const sourceWorkflowId = "workflow:recovery-template";
const sourceJobId = "job:recovery-template";
const occurrenceKey = `${scheduleId}:2026-09-13T12:00`;
const scheduledFor = "2026-09-13T12:00:00.000Z";
const createdAt = "2026-09-13T11:55:00.000Z";

async function migrate(raw: PGlite) {
  for (const file of (await readdir("db/migrations")).filter(file => file.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
  }
}

function sourceBundle(): ProposedWorkBundle {
  const base = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId, version: 0,
    createdAt: "2026-09-13T10:00:00.000Z", updatedAt: "2026-09-13T10:00:00.000Z" };
  const authority: AuthorityEnvelope = {
    projectId, allowedExecutor: "executor:unassigned", allowedOperations: ["task.propose"],
    credentialRefs: [], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [],
    effectPolicy: "none", maxRisk: "low", maxDurationSeconds: 300, maxConcurrentEffects: 0,
    maxCostUsd: 0, expiresAt: "2026-09-14T12:00:00.000Z", digest: "",
  };
  authority.digest = computeAuthorityDigest(authority);
  return {
    request: { ...base, id: sourceRequestId, kind: "request", projectId, title: "Recovery research",
      objective: "Prepare the reviewed recovery research proposal.", state: "draft", priority: 60,
      requestedBy: { actorId: "identity:synthetic-owner", actorType: "human" },
      idempotencyKey: "source:recovery-template" },
    workflow: { ...base, id: sourceWorkflowId, kind: "workflow", requestId: sourceRequestId, projectId,
      definitionVersion: "synthetic-template/v1", definitionDigest: sha256Digest("recovery-template"),
      authorityMode: "control_room_native", state: "proposed", jobIds: [sourceJobId] },
    job: { ...base, id: sourceJobId, kind: "job", workflowId: sourceWorkflowId, projectId,
      jobType: "research.daily", specVersion: "1.0.0", inputDigest: sha256Digest("recovery-input"),
      state: "proposed", priority: 60, requiredCapability: "research.daily", dependsOnJobIds: [], authority,
      retryPolicy: { maxAttempts: 3, backoffSeconds: 30, retryableFailureCodes: ["provider_timeout"],
        retryAfterOrphan: true, ambiguousEffectPolicy: "attention" } },
  };
}

async function fixture(options: { windowSeconds?: number; now?: number } = {}) {
  const raw = new PGlite();
  await migrate(raw);
  const db = adaptPglite(raw);
  await db.query("INSERT INTO tenants(id,display_name) VALUES($1,'Synthetic')", [tenantId]);
  await db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Synthetic')", [workspaceId, tenantId]);
  await db.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days) VALUES('adapter:schedule-recovery',$1,'synthetic','1.0.0',
    'control_room_native','disabled','v1',30)`, [tenantId]);
  await db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
    normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES($1,$2,$3,'adapter:schedule-recovery',$1,'1','Synthetic','planned','synthetic','healthy',
    'control_room_native',$4,'{}'::jsonb)`, [projectId, tenantId, workspaceId, createdAt]);
  await new CanonicalStore(db).createProposedWorkBundle(sourceBundle());
  const schedule: ScheduleRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, id: scheduleId, tenantId,
    version: 0, createdAt, updatedAt: createdAt, kind: "schedule", projectId, state: "active",
    scheduleType: "cron", expression: "0 12 * * *", timezone: "UTC", targetType: "job", targetId: sourceJobId,
    idempotencyWindowSeconds: options.windowSeconds ?? 3600 };
  await new CanonicalStore(db).create(schedule);
  const scheduleDefinitionDigest = computeScheduledTaskDefinitionDigestV1(schedule);
  await new ScheduleOccurrenceStore(db).materialize({ tenantId, scheduleId, occurrenceKey, targetType: "job",
    targetId: sourceJobId, definitionDigest: scheduleDefinitionDigest, scheduledFor,
    localTime: "2026-09-13T12:00", createdAt });
  let current = options.now ?? Date.parse("2026-09-13T12:00:10.000Z");
  return { raw, db, recovery: new ScheduledTaskRecoveryServiceV1(db, () => current),
    setNow: (value: number) => { current = value; } };
}

async function count(db: DatabaseClient, table: string, where = "") {
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} ${where}`)).rows[0].n;
}

test("restart reconciles the delivered-but-unadmitted window exactly once", async () => {
  const f = await fixture();
  try {
    // Crash window: the outbox row was delivered, admission never committed.
    await f.db.query("UPDATE control_outbox SET status='delivered',delivered_at=$2 WHERE tenant_id=$1", [tenantId, createdAt]);

    const first = await f.recovery.reconcileOnRestart({ tenantId, scheduleId });
    assert.equal(first.contractVersion, "control-room-scheduled-task-recovery/v1");
    assert.equal(first.scanned, 1);
    assert.deepEqual(first.recovered.map(item => item.occurrenceKey), [occurrenceKey]);
    assert.equal(first.recovered[0].replayed, false);
    assert.equal(first.recovered[0].receipt.startsWork, false);
    assert.deepEqual(first.refused, []);
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 1);

    // A second restart over the same window adds nothing and invents nothing.
    const second = await f.recovery.reconcileOnRestart({ tenantId, scheduleId });
    assert.deepEqual(second.recovered, []);
    assert.deepEqual(second.settled, [occurrenceKey]);
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 1);
    assert.equal(await count(f.db, "control_jobs", "WHERE id LIKE 'job:schedule:%'"), 1);
    assert.equal(await count(f.db, "control_attempts"), 0);
    assert.equal(await count(f.db, "control_leases"), 0);
  } finally { await f.raw.close(); }
});

test("an expired recovery window refuses instead of inventing an admission", async () => {
  const f = await fixture({ windowSeconds: 300 });
  try {
    await f.db.query("UPDATE control_outbox SET status='delivered',delivered_at=$2 WHERE tenant_id=$1", [tenantId, createdAt]);
    // Recovery ends 300s after the occurrence was scheduled for.
    f.setNow(Date.parse("2026-09-13T12:10:00.000Z"));

    const report = await f.recovery.reconcileOnRestart({ tenantId, scheduleId });
    assert.deepEqual(report.recovered, []);
    assert.deepEqual(report.refused, [{ occurrenceKey, safeCode: "recovery_window_expired" }]);
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 0);
    assert.equal((await f.db.query<{ state: string }>(
      "SELECT state FROM control_schedule_occurrences WHERE occurrence_key=$1", [occurrenceKey])).rows[0].state, "pending");
  } finally { await f.raw.close(); }
});

test("undelivered occurrences await delivery and a late definition change refuses as stale", async () => {
  const f = await fixture();
  try {
    const undelivered = await f.recovery.reconcileOnRestart({ tenantId, scheduleId });
    assert.deepEqual(undelivered.awaitingDelivery, [occurrenceKey]);
    assert.deepEqual(undelivered.recovered, []);
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 0);

    await f.db.query("UPDATE control_outbox SET status='delivered',delivered_at=$2 WHERE tenant_id=$1", [tenantId, createdAt]);
    await f.db.query(`UPDATE control_schedules SET version=1,updated_at=$3,
      payload=payload || $2::jsonb WHERE id=$1`, [scheduleId,
      JSON.stringify({ expression: "30 12 * * *", version: 1, updatedAt: "2026-09-13T11:59:00.000Z" }),
      "2026-09-13T11:59:00.000Z"]);
    const stale = await f.recovery.reconcileOnRestart({ tenantId, scheduleId });
    assert.deepEqual(stale.refused, [{ occurrenceKey, safeCode: "definition_changed" }]);
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 0);
  } finally { await f.raw.close(); }
});

test("a dispatched occurrence with no admission is reported orphaned and never repaired", async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE control_outbox SET status='delivered',delivered_at=$2 WHERE tenant_id=$1", [tenantId, createdAt]);
    // A contradiction: the occurrence claims dispatch but no admission exists for it.
    await f.db.query("UPDATE control_schedule_occurrences SET state='dispatched',dispatched_at=$2 WHERE occurrence_key=$1",
      [occurrenceKey, createdAt]);

    const report = await f.recovery.reconcileOnRestart({ tenantId, scheduleId });
    assert.deepEqual(report.orphaned, [occurrenceKey]);
    assert.deepEqual(report.recovered, []);
    assert.deepEqual(report.settled, []);
    // Reported, not silently fixed: reconciliation writes no admission for it.
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 0);
    assert.equal((await f.db.query<{ state: string }>(
      "SELECT state FROM control_schedule_occurrences WHERE occurrence_key=$1", [occurrenceKey])).rows[0].state, "dispatched");
  } finally { await f.raw.close(); }
});



test("restart after receipt commit but before acknowledgement replays without a second task", async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE control_outbox SET status='delivered',delivered_at=$2 WHERE tenant_id=$1", [tenantId, createdAt]);
    let crashed = false;
    const db: DatabaseClient = {
      ...f.db,
      transaction: async (run) => {
        if (!crashed) { crashed = true; throw new Error("simulated acknowledgement crash"); }
        return f.db.transaction(run);
      },
    };
    await assert.rejects(new ScheduledTaskDispatchServiceV1(db, () => Date.parse("2026-09-13T12:00:10Z"))
      .dispatchOne({ tenantId, scheduleId, occurrenceKey }), /simulated acknowledgement crash/);
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 1);
    assert.equal((await f.db.query<{ state: string }>("SELECT state FROM control_schedule_occurrences WHERE occurrence_key=$1", [occurrenceKey])).rows[0].state, "pending");
    const report = await f.recovery.reconcileOnRestart({ tenantId, scheduleId });
    assert.equal(report.recovered.length, 1);
    assert.equal(report.recovered[0].replayed, true);
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 1);
    assert.equal(await count(f.db, "control_jobs", "WHERE id LIKE 'job:schedule:%'"), 1);
  } finally { await f.raw.close(); }
});

test("restart pagination reaches pending work beyond settled history", async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE control_schedule_occurrences SET state='cancelled' WHERE occurrence_key=$1", [occurrenceKey]);
    const nextKey = `${scheduleId}:2026-09-13T12:01`;
    const digest = (await f.db.query<{ definition_digest: string }>("SELECT definition_digest FROM control_schedule_occurrences WHERE occurrence_key=$1", [occurrenceKey])).rows[0].definition_digest;
    await new ScheduleOccurrenceStore(f.db).materialize({ tenantId, scheduleId, occurrenceKey: nextKey,
      targetType: "job", targetId: sourceJobId, definitionDigest: digest,
      scheduledFor: "2026-09-13T12:01:00.000Z", localTime: "2026-09-13T12:01", createdAt });
    await f.db.query("UPDATE control_outbox SET status='delivered',delivered_at=$2 WHERE tenant_id=$1", [tenantId, createdAt]);
    f.setNow(Date.parse("2026-09-13T12:01:10.000Z"));
    const first = await f.recovery.reconcileOnRestart({ tenantId, scheduleId, limit: 1 });
    assert.ok(first.nextCursor);
    const second = await f.recovery.reconcileOnRestart({ tenantId, scheduleId, limit: 1, after: first.nextCursor });
    assert.deepEqual(second.recovered.map(item => item.occurrenceKey), [nextKey]);
  } finally { await f.raw.close(); }
});


test("a cancelled occurrence is settled rather than dispatched", async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE control_outbox SET status='delivered',delivered_at=$2 WHERE tenant_id=$1", [tenantId, createdAt]);
    await f.db.query("UPDATE control_schedule_occurrences SET state='cancelled' WHERE occurrence_key=$1", [occurrenceKey]);
    const report = await f.recovery.reconcileOnRestart({ tenantId, scheduleId });
    assert.deepEqual(report.settled, [occurrenceKey]);
    assert.deepEqual(report.recovered, []);
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 0);
  } finally { await f.raw.close(); }
});