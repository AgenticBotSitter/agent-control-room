import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { DeliveryStore } from "../src/persistence/delivery-store";
import { adaptPglite } from "../src/persistence/database";
import { calculateScheduleOccurrencesV1, reconcileServiceV1, ScheduleOccurrenceStore, ServiceIncidentStore } from "../src/services/v1";

test("CR6D acceptance: DST, duplicate delivery, stale claims, restart reconciliation, and incident recovery", async () => {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((entry) => entry.endsWith(".sql")).sort()) await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  try {
    await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:acceptance','Acceptance')`);
    const db = adaptPglite(raw);
    const occurrence = calculateScheduleOccurrencesV1({ id: "schedule.dst", kind: "cron", state: "active", expression: "30 1 * * *", timezone: "America/Denver" }, { startsAt: "2026-11-01T06:00:00.000Z", endsAt: "2026-11-02T07:00:00.000Z" }).occurrences[0]!;
    assert.equal(occurrence.scheduledFor, "2026-11-01T07:30:00.000Z");
    const proposal = { ...occurrence, tenantId: "tenant:acceptance", targetType: "service_check" as const, targetId: "service.worker", definitionDigest: `sha256:${"e".repeat(64)}`, createdAt: occurrence.scheduledFor };
    const schedules = new ScheduleOccurrenceStore(db);
    const results = await Promise.all([schedules.materialize(proposal), schedules.materialize(proposal)]);
    assert.equal(results.filter((result) => !result.replayed).length, 1);
    const delivery = new DeliveryStore(db);
    const [firstClaim] = await delivery.claimOutbox({ tenantId: proposal.tenantId, claimToken: "claim-token-first", limit: 1, maxAttempts: 3, now: proposal.createdAt });
    assert.equal(await delivery.recoverStaleOutbox({ tenantId: proposal.tenantId, claimedBefore: proposal.createdAt, availableAt: "2026-11-01T07:31:00.000Z", safeFailureCode: "delivery_interrupted", maxAttempts: 3 }), 1);
    const [retry] = await delivery.claimOutbox({ tenantId: proposal.tenantId, claimToken: "claim-token-retry", limit: 1, maxAttempts: 3, now: "2026-11-01T07:31:00.000Z" });
    assert.equal(retry.id, firstClaim.id);
    await delivery.markOutboxDelivered(proposal.tenantId, retry.id, "claim-token-retry", "2026-11-01T07:32:00.000Z");
    assert.equal(await new ScheduleOccurrenceStore(db).reconcileDelivered({ tenantId: proposal.tenantId, deliveredAt: "2026-11-01T07:33:00.000Z" }), 1);
    assert.equal((await schedules.acknowledgeDelivery({ tenantId: proposal.tenantId, scheduleId: proposal.scheduleId, occurrenceKey: proposal.occurrenceKey, deliveredAt: "2026-11-01T07:33:00.000Z" })).replayed, true);

    const bad = reconcileServiceV1({ serviceId: "service.worker", desiredState: "running", observedState: "stopped", observedAt: "2026-11-01T07:33:00.000Z", freshUntil: "2026-11-01T07:38:00.000Z", now: "2026-11-01T07:34:00.000Z" })!;
    const incidents = new ServiceIncidentStore(db);
    const open = await incidents.apply({ tenantId: proposal.tenantId, serviceId: "service.worker", correlationKey: bad.correlationKey!, action: "open_or_update", severity: bad.severity!, safeReasonCode: bad.safeReasonCode!, safeRemedyCode: bad.safeRemedyCode!, observedAt: "2026-11-01T07:33:00.000Z" });
    const recovered = reconcileServiceV1({ serviceId: "service.worker", desiredState: "running", observedState: "running", observedAt: "2026-11-01T07:35:00.000Z", freshUntil: "2026-11-01T07:40:00.000Z", now: "2026-11-01T07:36:00.000Z", existingIncident: { id: open.incident!.id, correlationKey: open.incident!.correlationKey } })!;
    assert.equal(recovered.incidentAction, "resolve");
    assert.equal((await incidents.apply({ tenantId: proposal.tenantId, serviceId: "service.worker", correlationKey: recovered.correlationKey!, action: "resolve", observedAt: "2026-11-01T07:35:00.000Z" })).incident?.state, "resolved");
  } finally { await raw.close(); }
});
