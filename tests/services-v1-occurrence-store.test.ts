import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database";
import { ScheduleOccurrenceError, ScheduleOccurrenceStore } from "../src/services/v1";

const proposal = { tenantId: "tenant:schedule", scheduleId: "schedule.daily", occurrenceKey: "schedule.daily:2026-08-27T09:00", scheduledFor: "2026-08-27T15:00:00.000Z", localTime: "2026-08-27T09:00", targetType: "service_check" as const, targetId: "service.worker", definitionDigest: `sha256:${"d".repeat(64)}`, createdAt: "2026-08-27T15:00:00.000Z" };

async function database(): Promise<PGlite> {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort()) await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:schedule','Schedule'),('tenant:other','Other')`);
  return raw;
}

test("CR6D atomically materializes one occurrence and one idempotent outbox proposal", async () => {
  const raw = await database();
  try {
    const store = new ScheduleOccurrenceStore(adaptPglite(raw));
    const first = await store.materialize(proposal);
    assert.equal(first.replayed, false);
    assert.equal(first.occurrence.state, "pending");
    assert.equal((await raw.query<{ topic: string; idempotency_key: string; payload: { targetId: string } }>(`SELECT topic,idempotency_key,payload FROM control_outbox WHERE tenant_id='tenant:schedule'`)).rows[0]?.topic, "schedule.occurrence.created");
    assert.equal((await store.materialize(proposal)).replayed, true);
    assert.equal((await raw.query(`SELECT * FROM control_outbox WHERE tenant_id='tenant:schedule'`)).rows.length, 1);
  } finally { await raw.close(); }
});

test("CR6D occurrence replay is exact and tenant scoped", async () => {
  const raw = await database();
  try {
    const store = new ScheduleOccurrenceStore(adaptPglite(raw));
    await store.materialize(proposal);
    await assert.rejects(store.materialize({ ...proposal, targetId: "service.changed" }), (error: unknown) => error instanceof ScheduleOccurrenceError && error.safeCode === "occurrence_conflict");
    assert.equal((await store.materialize({ ...proposal, tenantId: "tenant:other" })).replayed, false);
  } finally { await raw.close(); }
});
