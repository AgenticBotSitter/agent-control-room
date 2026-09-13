import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  DOMAIN_CONTRACT_VERSION,
  type AuthorityEnvelope,
  type ScheduleRecord,
} from "../src/domain/v1";
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

const tenantId = "tenant:schedule-admission";
const workspaceId = "workspace:schedule-admission";
const projectId = "project:schedule-admission";
const scheduleId = "schedule:daily-research";
const sourceRequestId = "request:daily-research-template";
const sourceWorkflowId = "workflow:daily-research-template";
const sourceJobId = "job:daily-research-template";
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
    request: { ...base, id: sourceRequestId, kind: "request", projectId, title: "Daily research",
      objective: "Prepare the reviewed daily research proposal.", state: "draft", priority: 60,
      requestedBy: { actorId: "identity:synthetic-owner", actorType: "human" },
      idempotencyKey: "source:daily-research-template" },
    workflow: { ...base, id: sourceWorkflowId, kind: "workflow", requestId: sourceRequestId, projectId,
      definitionVersion: "synthetic-template/v1", definitionDigest: sha256Digest("synthetic-template"),
      authorityMode: "control_room_native", state: "proposed", jobIds: [sourceJobId] },
    job: { ...base, id: sourceJobId, kind: "job", workflowId: sourceWorkflowId, projectId,
      jobType: "research.daily", specVersion: "1.0.0", inputDigest: sha256Digest("daily-input"),
      state: "proposed", priority: 60, requiredCapability: "research.daily", dependsOnJobIds: [], authority,
      retryPolicy: { maxAttempts: 3, backoffSeconds: 30, retryableFailureCodes: ["provider_timeout"],
        retryAfterOrphan: true, ambiguousEffectPolicy: "attention" } },
  };
}

async function fixture(now = Date.parse("2026-09-13T12:00:10.000Z")) {
  const raw = new PGlite();
  await migrate(raw);
  const db = adaptPglite(raw);
  await db.query("INSERT INTO tenants(id,display_name) VALUES($1,'Synthetic')", [tenantId]);
  await db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Synthetic')", [workspaceId, tenantId]);
  await db.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days) VALUES('adapter:schedule-admission',$1,'synthetic','1.0.0',
    'control_room_native','disabled','v1',30)`, [tenantId]);
  await db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
    normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES($1,$2,$3,'adapter:schedule-admission',$1,'1','Synthetic','planned','synthetic','healthy',
    'control_room_native',$4,'{}'::jsonb)`, [projectId, tenantId, workspaceId, createdAt]);
  const source = sourceBundle();
  await new CanonicalStore(db).createProposedWorkBundle(source);
  const schedule: ScheduleRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, id: scheduleId, tenantId,
    version: 0, createdAt, updatedAt: createdAt, kind: "schedule", projectId, state: "active",
    scheduleType: "cron", expression: "0 12 * * *", timezone: "UTC", targetType: "job", targetId: sourceJobId,
    idempotencyWindowSeconds: 300 };
  await new CanonicalStore(db).create(schedule);
  const scheduleDefinitionDigest = computeScheduledTaskDefinitionDigestV1(schedule);
  const occurrenceKey = `${scheduleId}:2026-09-13T12:00`;
  await new ScheduleOccurrenceStore(db).materialize({ tenantId, scheduleId, occurrenceKey, targetType: "job",
    targetId: sourceJobId, definitionDigest: scheduleDefinitionDigest, scheduledFor,
    localTime: "2026-09-13T12:00", createdAt });
  await db.query("UPDATE control_outbox SET status='delivered',delivered_at=$2 WHERE tenant_id=$1", [tenantId, createdAt]);
  const input: ScheduledTaskAdmissionInputV1 = { tenantId, workspaceId, projectId, scheduleId, occurrenceKey,
    scheduleDefinitionDigest, source: { requestId: sourceRequestId, workflowId: sourceWorkflowId, jobId: sourceJobId,
      bundleDigest: computeScheduledTaskSourceBundleDigestV1(source) },
    contextBinding: { reusableContexts: [], bindingDigest: EMPTY_SCHEDULE_REUSABLE_CONTEXT_BINDING_DIGEST_V1 } };
  let current = now;
  const service = new ScheduledTaskAdmissionServiceV1(db, () => current);
  return { raw, db, input, service, setNow(value: number) { current = value; } };
}

function hasCode(code: ScheduledTaskAdmissionError["safeCode"]) {
  return (error: unknown) => error instanceof ScheduledTaskAdmissionError && error.safeCode === code;
}

async function count(db: DatabaseClient, table: string, where = "") {
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} ${where}`)).rows[0].n;
}

test("one exact occurrence creates one inert canonical proposal and immutable replay receipt", async () => {
  const f = await fixture();
  try {
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => f.service.admit(f.input)));
    assert.equal(concurrent.filter(result => !result.replayed).length, 1);
    assert.equal(concurrent.filter(result => result.replayed).length, 3);
    for (const result of concurrent) assert.deepEqual(result.receipt, concurrent[0].receipt);
    const { receipt } = concurrent[0];
    assert.equal(receipt.startsWork, false);
    assert.equal(receipt.grantsExecutionAuthority, false);
    assert.equal(receipt.permitsAssignment, false);
    assert.equal(receipt.permitsRetry, false);
    assert.equal(receipt.permitsCancellation, false);
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 1);
    assert.equal(await count(f.db, "control_requests", "WHERE id LIKE 'request:schedule:%'"), 1);
    assert.equal(await count(f.db, "control_workflows", "WHERE id LIKE 'workflow:schedule:%'"), 1);
    assert.equal(await count(f.db, "control_jobs", "WHERE id LIKE 'job:schedule:%'"), 1);
    assert.equal(await count(f.db, "control_attempts"), 0);
    assert.equal(await count(f.db, "control_leases"), 0);
    assert.equal(await count(f.db, "control_effect_intents"), 0);
    const destination = (await f.db.query<{ payload: { state: string; dependsOnJobIds: string[];
      retryPolicy: { maxAttempts: number }; authority: AuthorityEnvelope } }>(
      "SELECT payload FROM control_jobs WHERE id=$1", [receipt.destination.jobId])).rows[0].payload;
    assert.equal(destination.state, "proposed");
    assert.deepEqual(destination.dependsOnJobIds, []);
    assert.equal(destination.retryPolicy.maxAttempts, 1);
    assert.equal(destination.authority.allowedExecutor, "executor:unassigned");
    assert.equal(destination.authority.networkPolicy, "none");
    assert.equal(destination.authority.effectPolicy, "none");
    assert.deepEqual(destination.authority.credentialRefs, []);
    assert.deepEqual(destination.authority.filesystemRoots, []);
    assert.deepEqual(destination.authority.allowedNetworkDestinations, []);
    assert.equal((await f.db.query<{ state: string }>("SELECT state FROM control_schedule_occurrences")).rows[0].state, "dispatched");
  } finally { await f.raw.close(); }
});

test("changed definition, source, context, locator, and unknown input refuse before publication", async () => {
  const cases: Array<[unknown, ScheduledTaskAdmissionError["safeCode"]]> = [];
  const f = await fixture();
  try {
    cases.push(
      [{ ...f.input, scheduleDefinitionDigest: sha256Digest("changed-definition") }, "occurrence_conflict"],
      [{ ...f.input, source: { ...f.input.source, bundleDigest: sha256Digest("changed-source") } }, "source_bundle_conflict"],
      [{ ...f.input, contextBinding: { reusableContexts: [], bindingDigest: sha256Digest("changed-context") } }, "context_binding_conflict"],
      [{ ...f.input, tenantId: "tenant:wrong" }, "binding_mismatch"],
      [{ ...f.input, workspaceId: "workspace:wrong" }, "binding_mismatch"],
      [{ ...f.input, projectId: "project:wrong" }, "binding_mismatch"],
      [{ ...f.input, scheduleId: "schedule:wrong" }, "binding_mismatch"],
      [{ ...f.input, occurrenceKey: "schedule:daily-research:wrong" }, "binding_mismatch"],
      [{ ...f.input, unknown: true }, "invalid_admission"],
    );
    for (const [input, code] of cases) await assert.rejects(f.service.admit(input), hasCode(code));
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 0);
    assert.equal(await count(f.db, "control_jobs", "WHERE id LIKE 'job:schedule:%'"), 0);
  } finally { await f.raw.close(); }

  const changedSchedule = await fixture();
  try {
    await changedSchedule.db.query(`UPDATE control_schedules SET version=1,updated_at='2026-09-13T11:59:00.000Z',
      payload=jsonb_set(jsonb_set(jsonb_set(payload,'{expression}','\"30 12 * * *\"'::jsonb),'{version}','1'::jsonb),
        '{updatedAt}','\"2026-09-13T11:59:00.000Z\"'::jsonb) WHERE id=$1`, [scheduleId]);
    await assert.rejects(changedSchedule.service.admit(changedSchedule.input), hasCode("occurrence_conflict"));
    assert.equal(await count(changedSchedule.db, "control_scheduled_task_admissions"), 0);
  } finally { await changedSchedule.raw.close(); }

  const changedSource = await fixture();
  try {
    await changedSource.db.query("UPDATE control_requests SET payload=jsonb_set(payload,'{objective}','\"Changed template\"'::jsonb) WHERE id=$1",
      [sourceRequestId]);
    await assert.rejects(changedSource.service.admit(changedSource.input), hasCode("source_bundle_conflict"));
    assert.equal(await count(changedSource.db, "control_scheduled_task_admissions"), 0);
  } finally { await changedSource.raw.close(); }
});

test("expired recovery and mid-transaction failure leave no proposal or receipt", async () => {
  const expired = await fixture(Date.parse("2026-09-13T12:05:00.000Z"));
  try {
    await assert.rejects(expired.service.admit(expired.input), hasCode("recovery_window_expired"));
    assert.equal(await count(expired.db, "control_scheduled_task_admissions"), 0);
    assert.equal(await count(expired.db, "control_jobs", "WHERE id LIKE 'job:schedule:%'"), 0);
  } finally { await expired.raw.close(); }

  const crossedDeadline = await fixture();
  try {
    const deadline = Date.parse("2026-09-13T12:05:00.000Z");
    const instants = [Date.parse("2026-09-13T12:04:59.000Z"), deadline];
    const service = new ScheduledTaskAdmissionServiceV1(crossedDeadline.db, () => instants.shift() ?? deadline);
    await assert.rejects(service.admit(crossedDeadline.input), hasCode("recovery_window_expired"));
    assert.equal(await count(crossedDeadline.db, "control_scheduled_task_admissions"), 0);
    assert.equal(await count(crossedDeadline.db, "control_jobs", "WHERE id LIKE 'job:schedule:%'"), 0);
  } finally { await crossedDeadline.raw.close(); }

  const f = await fixture();
  try {
    const breakReceipt = (tx: DatabaseSession): DatabaseSession => ({ query(sql, params) {
      if (sql.includes("INSERT INTO control_scheduled_task_admissions")) throw new Error("synthetic_receipt_failure");
      return tx.query(sql, params);
    } });
    const failing: DatabaseClient = {
      query: f.db.query.bind(f.db),
      transaction: run => f.db.transaction(tx => run(breakReceipt(tx))),
      transactionWithPreCommitCheck: (run, check) => f.db.transactionWithPreCommitCheck(tx => run(breakReceipt(tx)), check),
    };
    await assert.rejects(new ScheduledTaskAdmissionServiceV1(failing, () => Date.parse("2026-09-13T12:00:10.000Z")).admit(f.input),
      /synthetic_receipt_failure/);
    assert.equal(await count(f.db, "control_scheduled_task_admissions"), 0);
    assert.equal(await count(f.db, "control_jobs", "WHERE id LIKE 'job:schedule:%'"), 0);
  } finally { await f.raw.close(); }
});

test("pause/resume and cancellation serialize without cancelling an admitted task", async () => {
  const paused = await fixture();
  try {
    await paused.db.query("UPDATE control_schedules SET state='paused',payload=jsonb_set(payload,'{state}','\"paused\"'::jsonb) WHERE id=$1", [scheduleId]);
    await assert.rejects(paused.service.admit(paused.input), hasCode("schedule_not_active"));
    await paused.db.query("UPDATE control_schedules SET state='active',payload=jsonb_set(payload,'{state}','\"active\"'::jsonb) WHERE id=$1", [scheduleId]);
    const admitted = await paused.service.admit(paused.input);
    await paused.db.query("UPDATE control_schedules SET state='paused',payload=jsonb_set(payload,'{state}','\"paused\"'::jsonb) WHERE id=$1", [scheduleId]);
    assert.deepEqual((await paused.service.admit(paused.input)).receipt, admitted.receipt);
  } finally { await paused.raw.close(); }

  const cancelled = await fixture();
  try {
    const cancellation = { tenantId, workspaceId, projectId, scheduleId, occurrenceKey: cancelled.input.occurrenceKey,
      scheduleDefinitionDigest: cancelled.input.scheduleDefinitionDigest, sourceJobId };
    assert.deepEqual(await cancelled.service.cancelPending(cancellation), { cancelled: true, replayed: false, cancelsTask: false });
    assert.deepEqual(await cancelled.service.cancelPending(cancellation), { cancelled: true, replayed: true, cancelsTask: false });
    await assert.rejects(cancelled.service.admit(cancelled.input), hasCode("occurrence_cancelled"));
    assert.equal(await count(cancelled.db, "control_scheduled_task_admissions"), 0);
  } finally { await cancelled.raw.close(); }

  const admitted = await fixture();
  try {
    await admitted.service.admit(admitted.input);
    await assert.rejects(admitted.service.cancelPending({ tenantId, workspaceId, projectId, scheduleId,
      occurrenceKey: admitted.input.occurrenceKey, scheduleDefinitionDigest: admitted.input.scheduleDefinitionDigest,
      sourceJobId }), hasCode("admission_already_committed"));
    assert.equal(await count(admitted.db, "control_jobs", "WHERE id LIKE 'job:schedule:%'"), 1);
  } finally { await admitted.raw.close(); }

  const raced = await fixture();
  try {
    const cancellation = { tenantId, workspaceId, projectId, scheduleId, occurrenceKey: raced.input.occurrenceKey,
      scheduleDefinitionDigest: raced.input.scheduleDefinitionDigest, sourceJobId };
    const [admission, cancellationResult] = await Promise.allSettled([
      raced.service.admit(raced.input), raced.service.cancelPending(cancellation),
    ]);
    assert.notEqual(admission.status, cancellationResult.status);
    const destinationCount = await count(raced.db, "control_jobs", "WHERE id LIKE 'job:schedule:%'");
    if (admission.status === "fulfilled") {
      assert.equal(destinationCount, 1);
      assert.equal(cancellationResult.status, "rejected");
      assert.ok(cancellationResult.status === "rejected" && hasCode("admission_already_committed")(cancellationResult.reason));
    } else {
      assert.equal(destinationCount, 0);
      assert.equal(cancellationResult.status, "fulfilled");
      assert.ok(hasCode("occurrence_cancelled")(admission.reason));
    }
  } finally { await raced.raw.close(); }
});
