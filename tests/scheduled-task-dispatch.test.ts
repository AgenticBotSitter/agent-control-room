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
import { ScheduledTaskDispatchErrorV1, ScheduledTaskDispatchServiceV1 } from "../src/services/v1/scheduled-task-dispatch";

const tenantId = "tenant:schedule-dispatch";
const workspaceId = "workspace:schedule-dispatch";
const projectId = "project:schedule-dispatch";
const scheduleId = "schedule:dispatch-daily";
const sourceRequestId = "request:dispatch-template";
const sourceWorkflowId = "workflow:dispatch-template";
const sourceJobId = "job:dispatch-template";
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
    request: { ...base, id: sourceRequestId, kind: "request", projectId, title: "Dispatch research",
      objective: "Prepare the reviewed dispatch research proposal.", state: "draft", priority: 60,
      requestedBy: { actorId: "identity:synthetic-owner", actorType: "human" },
      idempotencyKey: "source:dispatch-template" },
    workflow: { ...base, id: sourceWorkflowId, kind: "workflow", requestId: sourceRequestId, projectId,
      definitionVersion: "synthetic-template/v1", definitionDigest: sha256Digest("dispatch-template"),
      authorityMode: "control_room_native", state: "proposed", jobIds: [sourceJobId] },
    job: { ...base, id: sourceJobId, kind: "job", workflowId: sourceWorkflowId, projectId,
      jobType: "research.daily", specVersion: "1.0.0", inputDigest: sha256Digest("dispatch-input"),
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
    redaction_policy_version,cursor_retention_days) VALUES('adapter:schedule-dispatch',$1,'synthetic','1.0.0',
    'control_room_native','disabled','v1',30)`, [tenantId]);
  await db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
    normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES($1,$2,$3,'adapter:schedule-dispatch',$1,'1','Synthetic','planned','synthetic','healthy',
    'control_room_native',$4,'{}'::jsonb)`, [projectId, tenantId, workspaceId, createdAt]);
  const source = sourceBundle();
  await new CanonicalStore(db).createProposedWorkBundle(source);
  const schedule: ScheduleRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, id: scheduleId, tenantId,
    version: 0, createdAt, updatedAt: createdAt, kind: "schedule", projectId, state: "active",
    scheduleType: "cron", expression: "0 12 * * *", timezone: "UTC", targetType: "job", targetId: sourceJobId,
    idempotencyWindowSeconds: options.windowSeconds ?? 3600 };
  await new CanonicalStore(db).create(schedule);
  const scheduleDefinitionDigest = computeScheduledTaskDefinitionDigestV1(schedule);
  let current = options.now ?? Date.parse("2026-09-13T12:00:10.000Z");
  return {
    raw, db, scheduleDefinitionDigest,
    occurrences: new ScheduleOccurrenceStore(db),
    service: new ScheduledTaskDispatchServiceV1(db, () => current),
    setNow: (value: number) => { current = value; },
  };
}

function hasCode(code: ScheduledTaskDispatchErrorV1["safeCode"]) {
  return (error: unknown) => error instanceof ScheduledTaskDispatchErrorV1 && error.safeCode === code;
}

async function count(db: DatabaseClient, table: string, where = "") {
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} ${where}`)).rows[0].n;
}

async function deliver(db: DatabaseClient) {
  await db.query("UPDATE control_outbox SET status='delivered',delivered_at=$2 WHERE tenant_id=$1", [tenantId, createdAt]);
}

test("dispatch drives one pending delivered occurrence into exactly one inert canonical admission", async () => {
  const f = await fixture();
  try {
    const occurrenceKey = `${scheduleId}:2026-09-13T12:00`;
    await f.occurrences.materialize({ tenantId, scheduleId, occurrenceKey, targetType: "job",
      targetId: sourceJobId, definitionDigest: f.scheduleDefinitionDigest, scheduledFor,
      localTime: "2026-09-13T12:00", createdAt });
    await deliver(f.db);

    const concurrent = await Promise.allSettled(Array.from({ length: 4 },
      () => f.service.dispatchOne({ tenantId, scheduleId, occurrenceKey })));
    const fulfilled = concurrent.filter(outcome => outcome.status === "fulfilled");
    const rejected = concurrent.filter(outcome => outcome.status === "rejected");

    // Admission owns the transactional replay boundary: one creates, three replay.
    assert.equal(fulfilled.length, 4);
    assert.equal(rejected.length, 0);
    const outcomes = fulfilled.map(item => (item as PromiseFulfilledResult<Awaited<ReturnType<typeof f.service.dispatchOne>>>).value);
    assert.equal(outcomes.filter(item => !item.replayed).length, 1);
    assert.equal(outcomes.filter(item => item.replayed).length, 3);
    assert.equal(new Set(outcomes.map(item => item.receipt.receiptDigest)).size, 1);
    const replay = await f.service.dispatchOne({ tenantId, scheduleId, occurrenceKey });
    assert.equal(replay.replayed, true);

    const outcome = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof f.service.dispatchOne>>>).value;
    assert.equal(outcome.contractVersion, "control-room-scheduled-task-dispatch/v1");
    assert.equal(outcome.state, "dispatched");
    assert.equal(outcome.replayed, false);
    assert.equal(outcome.occurrenceKey, occurrenceKey);

    // The admission dispatch produces is inert: it records work, it does not start it.
    assert.equal(outcome.receipt.startsWork, false);
    assert.equal(outcome.receipt.grantsExecutionAuthority, false);
    assert.equal(outcome.receipt.permitsAssignment, false);
    assert.equal(outcome.receipt.permitsRetry, false);
    await f.db.query(`UPDATE control_jobs SET payload=jsonb_set(payload,'{inputDigest}',$2::jsonb)
      WHERE tenant_id=$1 AND id=$3`, [tenantId, JSON.stringify(sha256Digest("changed-source")), sourceJobId]);
    await assert.rejects(f.service.dispatchOne({ tenantId, scheduleId, occurrenceKey }), hasCode("admission_refused"));
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 1);
    assert.equal(await count(f.db, "control_requests", "WHERE id LIKE 'request:schedule:%'"), 1);
    assert.equal(await count(f.db, "control_jobs", "WHERE id LIKE 'job:schedule:%'"), 1);
    assert.equal(await count(f.db, "control_attempts"), 0);
    assert.equal(await count(f.db, "control_leases"), 0);
    assert.equal(await count(f.db, "control_effect_intents"), 0);
    assert.equal((await f.db.query<{ state: string }>(
      "SELECT state FROM control_schedule_occurrences WHERE occurrence_key=$1", [occurrenceKey])).rows[0].state, "dispatched");
  } finally { await f.raw.close(); }
});

test("a stale occurrence refuses as definition_changed and admits nothing", async () => {
  const f = await fixture();
  try {
    const occurrenceKey = `${scheduleId}:2026-09-13T12:00`;
    await f.occurrences.materialize({ tenantId, scheduleId, occurrenceKey, targetType: "job",
      targetId: sourceJobId, definitionDigest: f.scheduleDefinitionDigest, scheduledFor,
      localTime: "2026-09-13T12:00", createdAt });
    await deliver(f.db);
    // The schedule definition moves on after the occurrence was materialised.
    await f.db.query(`UPDATE control_schedules SET version=1,updated_at=$3,
      payload=payload || $2::jsonb WHERE id=$1`, [scheduleId,
      JSON.stringify({ expression: "30 12 * * *", version: 1, updatedAt: "2026-09-13T11:59:00.000Z" }),
      "2026-09-13T11:59:00.000Z"]);

    await assert.rejects(f.service.dispatchOne({ tenantId, scheduleId, occurrenceKey }), hasCode("definition_changed"));
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 0);
    assert.equal(await count(f.db, "control_jobs", "WHERE id LIKE 'job:schedule:%'"), 0);
    assert.equal((await f.db.query<{ state: string }>(
      "SELECT state FROM control_schedule_occurrences WHERE occurrence_key=$1", [occurrenceKey])).rows[0].state, "pending");
  } finally { await f.raw.close(); }
});

test("dispatch refuses unknown, cancelled, undelivered, inactive and malformed requests", async () => {
  const f = await fixture();
  try {
    const occurrenceKey = `${scheduleId}:2026-09-13T12:00`;
    await f.occurrences.materialize({ tenantId, scheduleId, occurrenceKey, targetType: "job",
      targetId: sourceJobId, definitionDigest: f.scheduleDefinitionDigest, scheduledFor,
      localTime: "2026-09-13T12:00", createdAt });

    // outbox not yet delivered
    await assert.rejects(f.service.dispatchOne({ tenantId, scheduleId, occurrenceKey }), hasCode("outbox_not_delivered"));
    await assert.rejects(f.service.dispatchOne({ tenantId, scheduleId, occurrenceKey: `${scheduleId}:missing` }),
      hasCode("occurrence_unknown"));
    await assert.rejects(f.service.dispatchOne({ tenantId: "tenant:x", scheduleId, occurrenceKey }), hasCode("occurrence_unknown"));
    await assert.rejects(f.service.dispatchOne({ tenantId: "invalid tenant", scheduleId, occurrenceKey }), hasCode("invalid_dispatch"));

    await deliver(f.db);
    await f.db.query("UPDATE control_schedule_occurrences SET state='cancelled' WHERE occurrence_key=$1", [occurrenceKey]);
    await assert.rejects(f.service.dispatchOne({ tenantId, scheduleId, occurrenceKey }), hasCode("occurrence_cancelled"));

    await f.db.query("UPDATE control_schedule_occurrences SET state='pending' WHERE occurrence_key=$1", [occurrenceKey]);
    await f.db.query(`UPDATE control_schedules SET state='paused',
      payload=jsonb_set(payload,'{state}','"paused"'::jsonb) WHERE id=$1`, [scheduleId]);
    await assert.rejects(f.service.dispatchOne({ tenantId, scheduleId, occurrenceKey }), hasCode("schedule_not_active"));

    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 0);
  } finally { await f.raw.close(); }
});

test("dispatch batch dispatches in scheduled-for order and reports refusals without aborting", async () => {
  const f = await fixture();
  try {
    const keys = [`${scheduleId}:2026-09-13T12:00`, `${scheduleId}:2026-09-13T13:00`, `${scheduleId}:2026-09-13T14:00`];
    await f.occurrences.materialize({ tenantId, scheduleId, occurrenceKey: keys[1], targetType: "job",
      targetId: sourceJobId, definitionDigest: sha256Digest("stale-definition"), scheduledFor: "2026-09-13T13:00:00.000Z",
      localTime: "2026-09-13T13:00", createdAt });
    await f.occurrences.materialize({ tenantId, scheduleId, occurrenceKey: keys[0], targetType: "job",
      targetId: sourceJobId, definitionDigest: f.scheduleDefinitionDigest, scheduledFor,
      localTime: "2026-09-13T12:00", createdAt });
    await f.occurrences.materialize({ tenantId, scheduleId, occurrenceKey: keys[2], targetType: "job",
      targetId: sourceJobId, definitionDigest: f.scheduleDefinitionDigest, scheduledFor: "2026-09-13T14:00:00.000Z",
      localTime: "2026-09-13T14:00", createdAt });
    await deliver(f.db);

    // Neither batch nor direct dispatch may admit future occurrences.
    await assert.rejects(f.service.dispatchOne({ tenantId, scheduleId, occurrenceKey: keys[2] }), hasCode("occurrence_not_due"));
    const batch = await f.service.dispatchDue({ tenantId, scheduleId });
    assert.equal(batch.contractVersion, "control-room-scheduled-task-dispatch-batch/v1");
    assert.deepEqual(batch.dispatched.map(item => item.occurrenceKey), [keys[0]]);
    assert.deepEqual(batch.refused, []);
    f.setNow(Date.parse("2026-09-13T14:00:10.000Z"));
    const later = await f.service.dispatchDue({ tenantId, scheduleId });
    assert.deepEqual(later.dispatched.map(item => item.occurrenceKey), [keys[2]]);
    assert.deepEqual(later.refused, [{ occurrenceKey: keys[1], safeCode: "definition_changed" }]);
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 2);
    // The stale occurrence is left pending and visible, never re-materialised or repaired.
    assert.equal((await f.db.query<{ state: string }>(
      "SELECT state FROM control_schedule_occurrences WHERE occurrence_key=$1", [keys[1]])).rows[0].state, "pending");
  } finally { await f.raw.close(); }
});