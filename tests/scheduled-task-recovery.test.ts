import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { DOMAIN_CONTRACT_VERSION, type AuthorityEnvelope, type ScheduleRecord } from "../src/domain/v1";
import { CanonicalStore, type ProposedWorkBundle } from "../src/persistence/canonical-store";
import { adaptPglite, type DatabaseClient, type DatabaseSession } from "../src/persistence/database";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { ScheduleOccurrenceStore } from "../src/services/v1/occurrence-store";
import {
  EMPTY_SCHEDULE_REUSABLE_CONTEXT_BINDING_DIGEST_V1,
  ScheduledTaskAdmissionError,
  ScheduledTaskAdmissionServiceV1,
  computeScheduledTaskDefinitionDigestV1,
  computeScheduledTaskSourceBundleDigestV1,
  type ScheduledTaskAdmissionInputV1,
} from "../src/services/v1/scheduled-task-admission";

async function setup() {
  const raw = new PGlite();
  for (const file of (await readdir("db/migrations")).filter(file => file.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
  }
  const db = adaptPglite(raw), tenantId = "tenant:schedule-recovery", workspaceId = "workspace:schedule-recovery";
  const projectId = "project:schedule-recovery", scheduleId = "schedule:recovery", sourceRequestId = "request:recovery-template";
  const sourceWorkflowId = "workflow:recovery-template", sourceJobId = "job:recovery-template";
  const createdAt = "2026-09-13T11:55:00.000Z", scheduledFor = "2026-09-13T12:00:00.000Z";
  await db.query("INSERT INTO tenants(id,display_name) VALUES($1,'Synthetic')", [tenantId]);
  await db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Synthetic')", [workspaceId, tenantId]);
  await db.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days) VALUES('adapter:schedule-recovery',$1,'synthetic','1.0.0',
    'control_room_native','disabled','v1',30)`, [tenantId]);
  await db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
    normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES($1,$2,$3,'adapter:schedule-recovery',$1,'1','Synthetic','planned','synthetic','healthy',
    'control_room_native',$4,'{}'::jsonb)`, [projectId, tenantId, workspaceId, createdAt]);
  const base = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId, version: 0,
    createdAt: "2026-09-13T10:00:00.000Z", updatedAt: "2026-09-13T10:00:00.000Z" };
  const authority: AuthorityEnvelope = { projectId, allowedExecutor: "executor:unassigned", allowedOperations: ["task.propose"],
    credentialRefs: [], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "none",
    maxRisk: "low", maxDurationSeconds: 300, maxConcurrentEffects: 0, maxCostUsd: 0,
    expiresAt: "2026-09-14T12:00:00.000Z", digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const source: ProposedWorkBundle = {
    request: { ...base, id: sourceRequestId, kind: "request", projectId, title: "Recovery template", objective: "Synthetic",
      state: "draft", priority: 50, requestedBy: { actorId: "identity:synthetic", actorType: "human" },
      idempotencyKey: "source:recovery-template" },
    workflow: { ...base, id: sourceWorkflowId, kind: "workflow", requestId: sourceRequestId, projectId,
      definitionVersion: "synthetic/v1", definitionDigest: sha256Digest("recovery-template"),
      authorityMode: "control_room_native", state: "proposed", jobIds: [sourceJobId] },
    job: { ...base, id: sourceJobId, kind: "job", workflowId: sourceWorkflowId, projectId, jobType: "recovery.template",
      specVersion: "1.0.0", inputDigest: sha256Digest("recovery-input"), state: "proposed", priority: 50,
      requiredCapability: "recovery.template", dependsOnJobIds: [], authority,
      retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false,
        ambiguousEffectPolicy: "attention" } },
  };
  await new CanonicalStore(db).createProposedWorkBundle(source);
  const schedule: ScheduleRecord = { ...base, id: scheduleId, kind: "schedule", projectId, state: "active",
    scheduleType: "cron", expression: "0 12 * * *", timezone: "UTC", targetType: "job", targetId: sourceJobId,
    idempotencyWindowSeconds: 300 };
  await new CanonicalStore(db).create(schedule);
  const scheduleDefinitionDigest = computeScheduledTaskDefinitionDigestV1(schedule);
  const occurrenceKey = `${scheduleId}:2026-09-13T12:00`;
  await new ScheduleOccurrenceStore(db).materialize({ tenantId, scheduleId, occurrenceKey, targetType: "job", targetId: sourceJobId,
    definitionDigest: scheduleDefinitionDigest, scheduledFor, localTime: "2026-09-13T12:00", createdAt });
  await db.query("UPDATE control_outbox SET status='delivered',delivered_at=$2 WHERE tenant_id=$1", [tenantId, createdAt]);
  const input: ScheduledTaskAdmissionInputV1 = { tenantId, workspaceId, projectId, scheduleId, occurrenceKey,
    scheduleDefinitionDigest, source: { requestId: sourceRequestId, workflowId: sourceWorkflowId, jobId: sourceJobId,
      bundleDigest: computeScheduledTaskSourceBundleDigestV1(source) }, contextBinding: { reusableContexts: [],
      bindingDigest: EMPTY_SCHEDULE_REUSABLE_CONTEXT_BINDING_DIGEST_V1 } };
  return { raw, db, input, tenantId, scheduleId, occurrenceKey };
}

function failAcknowledgement(base: DatabaseClient): DatabaseClient {
  return {
    query: base.query.bind(base),
    transaction<T>(run: (session: DatabaseSession) => Promise<T>): Promise<T> {
      return base.transaction(tx => run({ query(sql, params) {
        if (sql.startsWith("UPDATE control_schedule_occurrences SET state='dispatched'")) throw new Error("synthetic_lost_ack");
        return tx.query(sql, params);
      } }));
    },
    transactionWithPreCommitCheck: base.transactionWithPreCommitCheck.bind(base),
  };
}

test("restart after proposal commit but before delivery acknowledgement replays one receipt", async () => {
  const f = await setup();
  try {
    const first = new ScheduledTaskAdmissionServiceV1(failAcknowledgement(f.db), () => Date.parse("2026-09-13T12:00:10.000Z"));
    await assert.rejects(first.admit(f.input), /synthetic_lost_ack/);
    assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_scheduled_task_admissions")).rows[0].n, 1);
    assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_jobs WHERE id LIKE 'job:schedule:%'")).rows[0].n, 1);
    assert.equal((await f.db.query<{ state: string }>("SELECT state FROM control_schedule_occurrences")).rows[0].state, "pending");
    const restored = new ScheduledTaskAdmissionServiceV1(f.db, () => Date.parse("2026-09-13T12:00:20.000Z"));
    const replay = await restored.admit(f.input);
    assert.equal(replay.replayed, true);
    assert.equal((await f.db.query<{ state: string }>("SELECT state FROM control_schedule_occurrences")).rows[0].state, "dispatched");
    assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_jobs WHERE id LIKE 'job:schedule:%'")).rows[0].n, 1);
  } finally { await f.raw.close(); }
});

test("delivered reconciliation and late receipt replay never create a fresh occurrence or task", async () => {
  const f = await setup();
  try {
    const first = new ScheduledTaskAdmissionServiceV1(failAcknowledgement(f.db), () => Date.parse("2026-09-13T12:00:10.000Z"));
    await assert.rejects(first.admit(f.input), /synthetic_lost_ack/);
    assert.equal(await new ScheduleOccurrenceStore(f.db).reconcileDelivered({ tenantId: f.tenantId,
      deliveredAt: "2026-09-13T12:00:15.000Z" }), 1);
    const late = new ScheduledTaskAdmissionServiceV1(f.db, () => Date.parse("2026-09-13T13:00:00.000Z"));
    assert.equal((await late.admit(f.input)).replayed, true);
    assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_schedule_occurrences")).rows[0].n, 1);
    assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_scheduled_task_admissions")).rows[0].n, 1);
    await assert.rejects(late.admit({ ...f.input, source: { ...f.input.source, bundleDigest: sha256Digest("changed") } }),
      (error: unknown) => error instanceof ScheduledTaskAdmissionError && error.safeCode === "admission_conflict");
    assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_jobs WHERE id LIKE 'job:schedule:%'")).rows[0].n, 1);
  } finally { await f.raw.close(); }
});

test("missing admission retries only inside the window and pending outbox delivery has no write", async () => {
  const expired = await setup();
  try {
    const service = new ScheduledTaskAdmissionServiceV1(expired.db, () => Date.parse("2026-09-13T12:05:00.000Z"));
    await assert.rejects(service.admit(expired.input),
      (error: unknown) => error instanceof ScheduledTaskAdmissionError && error.safeCode === "recovery_window_expired");
    assert.equal((await expired.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_scheduled_task_admissions")).rows[0].n, 0);
  } finally { await expired.raw.close(); }

  const pending = await setup();
  try {
    await pending.db.query("UPDATE control_outbox SET status='pending',delivered_at=NULL WHERE tenant_id=$1", [pending.tenantId]);
    const service = new ScheduledTaskAdmissionServiceV1(pending.db, () => Date.parse("2026-09-13T12:00:10.000Z"));
    await assert.rejects(service.admit(pending.input),
      (error: unknown) => error instanceof ScheduledTaskAdmissionError && error.safeCode === "outbox_not_delivered");
    assert.equal((await pending.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_scheduled_task_admissions")).rows[0].n, 0);
    assert.equal((await pending.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_jobs WHERE id LIKE 'job:schedule:%'")).rows[0].n, 0);
  } finally { await pending.raw.close(); }
});
