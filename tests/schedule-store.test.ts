import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database";
import { exerciseScheduleStore } from "./helpers/schedule-store-scenario";
import { ScheduleOccurrenceStore } from "../src/services/v1/occurrence-store";
import { ServiceIncidentStore, ServiceIncidentError } from "../src/services/v1/incident-store";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

test("calendar occurrence persistence, replay, reconciliation and cancelled refusal", async () => {
  const raw = new PGlite();
  try {
    for (const file of (await readdir("db/migrations")).filter(file => file.endsWith(".sql")).sort())
      await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
    await exerciseScheduleStore(adaptPglite(raw), async () => adaptPglite(raw));
    const db = adaptPglite(raw);
    const failOutbox = (session: DatabaseSession): DatabaseSession => ({
      query: (sql, params) => {
        if (sql.startsWith("INSERT INTO control_outbox")) throw new Error("synthetic_outbox_failure");
        return session.query(sql, params);
      },
    });
    const failing: DatabaseClient = { ...db,
      transaction: callback => db.transaction(session => callback(failOutbox(session))),
      transactionWithPreCommitCheck: (callback, check) => db.transactionWithPreCommitCheck(session => callback(failOutbox(session)), check),
    };
    const proposal = { tenantId: "tenant:calendar", scheduleId: "schedule:rollback",
      occurrenceKey: "schedule:rollback:2026-11-01T09:00", scheduledFor: "2026-11-01T09:00:00.000Z",
      localTime: "2026-11-01T09:00", targetType: "job" as const, targetId: "job:rollback",
      definitionDigest: `sha256:${"a".repeat(64)}`, createdAt: "2026-11-01T08:00:00.000Z" };
    await assert.rejects(new ScheduleOccurrenceStore(failing).materialize(proposal), /synthetic_outbox_failure/);
    assert.equal((await raw.query("SELECT * FROM control_schedule_occurrences WHERE schedule_id='schedule:rollback'")).rows.length, 0);
    assert.equal((await new ScheduleOccurrenceStore(db).materialize(proposal)).replayed, false);
  } finally { await raw.close(); }
});

const MIGRATIONS = (await readdir("db/migrations")).filter(file => file.endsWith(".sql")).sort();

async function openIncidentDatabase(): Promise<{ raw: PGlite; db: DatabaseClient }> {
  const raw = new PGlite();
  try {
    for (const file of MIGRATIONS)
      await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
    await raw.query("INSERT INTO tenants(id,display_name) VALUES ('tenant:incidents','Synthetic'),('tenant:other','Synthetic')");
    return { raw, db: adaptPglite(raw) };
  } catch (error) { await raw.close(); throw error; }
}

/** Reduced ServiceIncidentInputV1 literals; every observed instant is an exact ISO-millisecond string. */
function openInput(overrides: Partial<Parameters<ServiceIncidentStore["apply"]>[0]> = {}) {
  return {
    tenantId: "tenant:incidents", serviceId: "service:ingest", correlationKey: "corr:disk-full",
    observedAt: "2026-11-01T09:00:00.000Z",
    action: "open_or_update" as const, severity: "warning" as const,
    safeReasonCode: "reason:disk-full", safeRemedyCode: "remedy:inspect-service",
    ...overrides,
  };
}

function rejectsInvalidIncident(error: unknown): boolean {
  return error instanceof ServiceIncidentError && error.safeCode === "invalid_incident";
}

test("service incident persistence: generations, outbox, severity floor, resolve, reopen and bounds", async () => {
  const { raw, db } = await openIncidentDatabase();
  try {
    const store = new ServiceIncidentStore(db);
    const incidentCount = async (where: string) =>
      (await raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM control_service_incidents WHERE ${where}`)).rows[0].n;
    const outboxCount = async (where: string) =>
      (await raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM control_outbox WHERE ${where}`)).rows[0].n;

    // First open: generation 1, one open incident row, one opened outbox proposal, one head.
    const first = await store.apply(openInput());
    assert.equal(first.replayed, false);
    assert.equal(first.incident?.generation, 1);
    assert.equal(first.incident?.state, "open");
    assert.equal(first.incident?.id, "incident:tenant:incidents:corr:disk-full:1");
    assert.equal(await incidentCount("tenant_id='tenant:incidents'"), 1);
    assert.equal(await outboxCount("tenant_id='tenant:incidents'"), 1);
    assert.equal(
      (await raw.query<{ n: number }>("SELECT count(*)::int AS n FROM control_service_incident_heads WHERE tenant_id='tenant:incidents' AND next_generation=1")).rows[0].n,
      1);

    // Second open/update reuses generation 1, writes no second incident row, adds no outbox row.
    const update = await store.apply(openInput({ observedAt: "2026-11-01T09:05:00.000Z", safeReasonCode: "reason:disk-still-full" }));
    assert.equal(update.replayed, true);
    assert.equal(update.incident?.generation, 1);
    const persistedUpdate = (await new ServiceIncidentStore(adaptPglite(raw)).list({ tenantId: "tenant:incidents", limit: 10 }))[0];
    assert.equal(persistedUpdate.safeReasonCode, "reason:disk-still-full");
    assert.equal(persistedUpdate.lastObservedAt, "2026-11-01T09:05:00.000Z");
    assert.equal(await incidentCount("tenant_id='tenant:incidents'"), 1);
    assert.equal(await outboxCount("tenant_id='tenant:incidents'"), 1);

    // Severity escalates warning -> critical and cannot downgrade while the record stays open.
    const escalated = await store.apply(openInput({ observedAt: "2026-11-01T09:10:00.000Z", severity: "critical" }));
    assert.equal(escalated.replayed, true);
    assert.equal(escalated.incident?.severity, "critical");
    const downgraded = await store.apply(openInput({ observedAt: "2026-11-01T09:15:00.000Z", severity: "warning" }));
    assert.equal(downgraded.replayed, true);
    assert.equal(downgraded.incident?.severity, "critical");

    // Resolve records one resolved row and one resolved outbox proposal.
    const resolved = await store.apply(openInput({ action: "resolve", observedAt: "2026-11-01T09:20:00.000Z" }));
    assert.equal(resolved.replayed, false);
    assert.equal(resolved.incident?.state, "resolved");
    assert.equal(resolved.incident?.resolvedAt, "2026-11-01T09:20:00.000Z");
    assert.equal(resolved.incident?.lastObservedAt, "2026-11-01T09:20:00.000Z");
    assert.equal(await incidentCount("state='resolved'"), 1);
    assert.equal(await outboxCount("topic='service.incident.resolved'"), 1);

    // Resolving a missing open record is an empty replay (replayed, no incident).
    const resolvedAgain = await store.apply(openInput({ action: "resolve", observedAt: "2026-12-01T09:00:00.000Z" }));
    assert.deepEqual(resolvedAgain, { replayed: true });
    assert.deepEqual(await store.apply(openInput({ action: "resolve", correlationKey: "corr:never-opened" })), { replayed: true });
    assert.equal(await outboxCount("tenant_id='tenant:incidents'"), 2);

    // Reopening starts generation 2 and proposes a new opened outbox row.
    const reopened = await store.apply(openInput({ observedAt: "2026-11-01T10:00:00.000Z", severity: "warning" }));
    assert.equal(reopened.replayed, false);
    assert.equal(reopened.incident?.generation, 2);
    assert.equal(reopened.incident?.state, "open");
    assert.equal(await outboxCount("topic='service.incident.opened'"), 2);

    // list filters by state and enforces its documented bounds.
    await store.apply(openInput({ correlationKey: "corr:memory-pressure", observedAt: "2026-11-01T10:05:00.000Z" }));
    await store.apply(openInput({ tenantId: "tenant:other" }));
    const all = await store.list({ tenantId: "tenant:incidents", limit: 500 });
    assert.equal(all.length, 3);
    assert.ok(all.every(incident => incident.tenantId === "tenant:incidents"));
    assert.deepEqual(all.map(incident => incident.state), ["open", "open", "resolved"]);
    const allOpen = await store.list({ tenantId: "tenant:incidents", state: "open", limit: 10 });
    const durable = new ServiceIncidentStore(adaptPglite(raw));
    assert.deepEqual(await durable.list({ tenantId: "tenant:incidents", limit: 500 }), all);
    assert.equal(allOpen.length, 2);
    assert.ok(allOpen.every(incident => incident.state === "open"));
    assert.ok(allOpen[0].lastObservedAt >= allOpen[1].lastObservedAt);
    const limited = await store.list({ tenantId: "tenant:incidents", state: "open", limit: 1 });
    assert.equal(limited.length, 1);
    assert.equal(limited[0].correlationKey, "corr:memory-pressure");
    const resolvedList = await store.list({ tenantId: "tenant:incidents", state: "resolved", limit: 10 });
    assert.equal(resolvedList.length, 1);
    assert.equal(resolvedList[0].generation, 1);
    for (const badLimit of [0, 501, 1.5, Number.NaN])
      await assert.rejects(store.list({ tenantId: "tenant:incidents", limit: badLimit }), rejectsInvalidIncident);

    // Malformed inputs use the store's safe error before any row is written.
    await assert.rejects(store.apply(openInput({ tenantId: "bad id" })), rejectsInvalidIncident);
    await assert.rejects(store.apply(openInput({ observedAt: "2026-11-01T09:00:00Z" })), rejectsInvalidIncident);
    await assert.rejects(store.apply(openInput({ safeReasonCode: "reason;drop" })), rejectsInvalidIncident);
    await assert.rejects(store.apply(openInput({ severity: "severe" as never })), rejectsInvalidIncident);
    assert.equal(await incidentCount("correlation_key='corr:memory-pressure'"), 1);

    // PGlite serializes transactions: concurrent callers, not multi-connection PG lock proof.
    // One critical observation must survive regardless of the callers' commit order.
    const concurrentKey = "corr:concurrent-check";
    const racing = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      store.apply(openInput({ correlationKey: concurrentKey, safeReasonCode: `reason:race-${index}`,
        safeRemedyCode: `remedy:race-${index}`, severity: index === 1 ? "critical" : "warning" }))));
    assert.equal(racing.filter(result => !result.replayed).length, 1);
    assert.equal(racing.filter(result => result.replayed).length, 3);
    assert.ok(racing.every(result => result.incident?.generation === 1));
    assert.ok(racing.every(result => result.incident?.id === `incident:tenant:incidents:${concurrentKey}:1`));
    assert.equal(await incidentCount(`correlation_key='${concurrentKey}'`), 1);
    assert.equal(await incidentCount(`correlation_key='${concurrentKey}' AND state='open'`), 1);
    assert.equal(
      (await raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM control_service_incident_heads WHERE correlation_key='${concurrentKey}'`)).rows[0].n,
      1);
    assert.equal(await outboxCount(`payload->>'correlationKey'='${concurrentKey}'`), 1);
    const persistedRace = (await new ServiceIncidentStore(adaptPglite(raw)).list({ tenantId: "tenant:incidents", limit: 500 }))
      .find(incident => incident.correlationKey === concurrentKey)!;
    assert.equal(persistedRace.severity, "critical");
    assert.ok(racing.some(result => result.incident?.safeReasonCode === persistedRace.safeReasonCode));
    assert.equal(persistedRace.safeRemedyCode, persistedRace.safeReasonCode.replace("reason:", "remedy:"));
  } finally { await raw.close(); }
});
