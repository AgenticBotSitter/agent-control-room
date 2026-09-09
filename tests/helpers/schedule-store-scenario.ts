import assert from "node:assert/strict";
import type { DatabaseClient } from "../../src/persistence/database";
import { ScheduleOccurrenceStore, ScheduleOccurrenceError } from "../../src/services/v1/occurrence-store";
import { calculateScheduleOccurrencesV1 } from "../../src/services/v1/recurrence";

/** Synthetic storage scenario; delivered status is seeded, not evidence of execution. */
export async function exerciseScheduleStore(db: DatabaseClient, reopen: () => Promise<DatabaseClient>) {
  await db.query("INSERT INTO tenants(id,display_name) VALUES ('tenant:calendar','Synthetic'),('tenant:calendar-other','Synthetic')");
  const definition = { id: "schedule:calendar", kind: "cron" as const, state: "active" as const,
    expression: "30 1 * * *", timezone: "America/Denver" };
  const calculated = calculateScheduleOccurrencesV1(definition,
    { startsAt: "2026-11-01T07:00:00.000Z", endsAt: "2026-11-01T10:00:00.000Z" });
  assert.equal(calculated.occurrences.length, 1);
  const proposal = { ...calculated.occurrences[0], tenantId: "tenant:calendar", targetType: "job" as const,
    targetId: "job:calendar", definitionDigest: `sha256:${"d".repeat(64)}`, createdAt: "2026-11-01T07:00:00.000Z" };
  const store = new ScheduleOccurrenceStore(db);
  assert.equal((await store.materialize(proposal)).replayed, false);
  assert.equal((await store.materialize(proposal)).replayed, true);
  await assert.rejects(store.materialize({ ...proposal, targetId: "job:changed" }),
    (error: unknown) => error instanceof ScheduleOccurrenceError && error.safeCode === "occurrence_conflict");
  assert.equal((await store.materialize({ ...proposal, tenantId: "tenant:calendar-other" })).replayed, false);
  const ack = { tenantId: proposal.tenantId, scheduleId: proposal.scheduleId,
    occurrenceKey: proposal.occurrenceKey, deliveredAt: "2026-11-01T08:00:00.000Z" };
  await assert.rejects(store.acknowledgeDelivery(ack),
    (error: unknown) => error instanceof ScheduleOccurrenceError && error.safeCode === "outbox_not_delivered");
  const restored = await reopen(), fresh = new ScheduleOccurrenceStore(restored);
  assert.equal((await fresh.materialize(proposal)).replayed, true);
  assert.equal(await fresh.reconcileDelivered(ack), 0);
  // Fixture-owned marker simulates an already acknowledged outbox delivery only.
  await restored.query("UPDATE control_outbox SET status='delivered' WHERE tenant_id=$1", [proposal.tenantId]);
  assert.equal(await fresh.reconcileDelivered(ack), 1);
  assert.equal(await fresh.reconcileDelivered(ack), 0);
  const replay = await fresh.acknowledgeDelivery(ack);
  assert.equal(replay.replayed, true); assert.equal(replay.occurrence.state, "dispatched");
  assert.equal((await restored.query<{ n: number }>("SELECT count(*)::int AS n FROM control_outbox WHERE tenant_id=$1", [proposal.tenantId])).rows[0].n, 1);
  const other = { ...ack, tenantId: "tenant:calendar-other" };
  await restored.query("UPDATE control_schedule_occurrences SET state='cancelled' WHERE tenant_id=$1", [other.tenantId]);
  await restored.query("UPDATE control_outbox SET status='delivered' WHERE tenant_id=$1", [other.tenantId]);
  assert.equal(await fresh.reconcileDelivered(other), 0);
  await assert.rejects(fresh.acknowledgeDelivery(other),
    (error: unknown) => error instanceof ScheduleOccurrenceError && error.safeCode === "occurrence_cancelled");
}
