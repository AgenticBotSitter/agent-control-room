import assert from "node:assert/strict";
import test from "node:test";
import { DOMAIN_CONTRACT_VERSION } from "../src/domain/v1";
import { projectScheduleStatus } from "../src/schedules/planning";

const schedule = { contractVersion: DOMAIN_CONTRACT_VERSION, id: "schedule:test", tenantId: "tenant:test",
  projectId: "project:test", kind: "schedule", version: 0, state: "active", scheduleType: "cron",
  expression: "30 1 * * *", timezone: "America/Denver", targetType: "job", targetId: "job:test",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", idempotencyWindowSeconds: 60 };
const input = { tenantId: "tenant:test", projectId: "project:test", schedule, occurrences: [],
  now: "2026-11-01T07:00:00.000Z", windowEndsAt: "2026-11-02T07:00:00.000Z" };
test("forecast preserves the existing timezone and first-fold occurrence semantics", () => {
  assert.equal(projectScheduleStatus(input).nextOccurrenceAt, "2026-11-01T07:30:00.000Z");
  assert.equal(projectScheduleStatus({ ...input, now: "2026-11-01T08:00:00.000Z" }).nextOccurrenceAt, null);
  const spring = projectScheduleStatus({ ...input, schedule: { ...schedule, expression: "30 2 * * *" },
    now: "2026-03-08T07:00:00.000Z", windowEndsAt: "2026-03-09T06:00:00.000Z" });
  assert.equal(spring.nextReason, "none_in_window");
});
test("paused, disabled, unanchored intervals and invalid zones never invent a next run", () => {
  for (const state of ["paused", "disabled"] as const) {
    const result = projectScheduleStatus({ ...input, schedule: { ...schedule, state } });
    assert.equal(result.nextReason, state); assert.equal(result.nextOccurrenceAt, null);
  }
  assert.equal(projectScheduleStatus({ ...input, schedule: { ...schedule, scheduleType: "interval", expression: "60" } }).nextReason, "anchor_unavailable");
  assert.equal(projectScheduleStatus({ ...input, schedule: { ...schedule, timezone: "invalid/zone" } }).nextReason, "invalid_schedule");
  assert.equal(projectScheduleStatus({ ...input, windowEndsAt: "2026-12-03T07:00:00.000Z" }).nextReason, "range_too_large");
  assert.equal(projectScheduleStatus({ ...input, windowEndsAt: input.now }).nextReason, "invalid_schedule");
  const once = { ...schedule, scheduleType: "once", expression: input.now };
  assert.equal(projectScheduleStatus({ ...input, schedule: once, windowEndsAt: "2026-12-02T07:00:00.000Z" }).nextOccurrenceAt, input.now);
});
test("retained cancellation, delivery and past-due pending are not completed execution", () => {
  const occurrence = { tenantId: "tenant:test", scheduleId: schedule.id, occurrenceKey: "schedule:test:one",
    targetType: "job", targetId: "job:old-definition", definitionDigest: `sha256:${"a".repeat(64)}`,
    scheduledFor: "2026-10-31T07:30:00.000Z", localTime: "2026-10-31T01:30", state: "pending",
    createdAt: "2026-10-31T07:00:00.000Z", dispatchedAt: null };
  const occurrences = [occurrence, { ...occurrence, occurrenceKey: "schedule:test:two", state: "cancelled" },
    { ...occurrence, occurrenceKey: "schedule:test:three", state: "dispatched", dispatchedAt: input.now }];
  const result = projectScheduleStatus({ ...input, occurrences });
  assert.deepEqual(projectScheduleStatus({ ...input, occurrences }), result);
  assert.equal(result.occurrences.find(item => item.state === "pending")?.pastDue, true);
  assert.equal(result.occurrences.find(item => item.state === "cancelled")?.pastDue, false);
  assert.throws(() => projectScheduleStatus({ ...input, occurrences: [occurrence, occurrence] }));
  assert.throws(() => projectScheduleStatus({ ...input, occurrences: [{ ...occurrence, tenantId: "tenant:other" }] }));
  assert.throws(() => projectScheduleStatus({ ...input, projectId: "project:other" }));
});
