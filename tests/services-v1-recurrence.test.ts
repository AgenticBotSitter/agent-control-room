import assert from "node:assert/strict";
import test from "node:test";
import { calculateScheduleOccurrencesV1 } from "../src/services/v1/recurrence";

test("CR6D cron creates stable local occurrence keys and honors five-field day matching", () => {
  const result = calculateScheduleOccurrencesV1({ id: "schedule.weekday", kind: "cron", state: "active", expression: "0 9 * * 1-5", timezone: "America/Denver" }, { startsAt: "2026-08-24T00:00:00.000Z", endsAt: "2026-08-25T00:00:00.000Z" });
  assert.deepEqual(result, { occurrences: [{ scheduleId: "schedule.weekday", occurrenceKey: "schedule.weekday:2026-08-24T09:00", scheduledFor: "2026-08-24T15:00:00.000Z", localTime: "2026-08-24T09:00" }] });
});

test("CR6D cron skips nonexistent spring-forward time and deduplicates fall-back repeated wall time", () => {
  const spring = calculateScheduleOccurrencesV1({ id: "schedule.dst.spring", kind: "cron", state: "active", expression: "30 2 * * *", timezone: "America/Denver" }, { startsAt: "2026-03-08T06:00:00.000Z", endsAt: "2026-03-09T06:00:00.000Z" });
  assert.deepEqual(spring.occurrences, []);
  const fall = calculateScheduleOccurrencesV1({ id: "schedule.dst.fall", kind: "cron", state: "active", expression: "30 1 * * *", timezone: "America/Denver" }, { startsAt: "2026-11-01T06:00:00.000Z", endsAt: "2026-11-02T07:00:00.000Z" });
  assert.deepEqual(fall.occurrences, [{ scheduleId: "schedule.dst.fall", occurrenceKey: "schedule.dst.fall:2026-11-01T01:30", scheduledFor: "2026-11-01T07:30:00.000Z", localTime: "2026-11-01T01:30" }]);
});

test("CR6D interval and once schedules are anchored and bounded without effects", () => {
  const interval = calculateScheduleOccurrencesV1({ id: "schedule.interval", kind: "interval", state: "active", expression: "900", timezone: "UTC", anchorAt: "2026-08-27T00:00:00.000Z" }, { startsAt: "2026-08-27T00:01:00.000Z", endsAt: "2026-08-27T00:31:00.000Z" });
  assert.deepEqual(interval.occurrences.map((value) => value.scheduledFor), ["2026-08-27T00:15:00.000Z", "2026-08-27T00:30:00.000Z"]);
  const once = calculateScheduleOccurrencesV1({ id: "schedule.once", kind: "once", state: "active", expression: "2026-08-27T00:15:00.000Z", timezone: "UTC" }, { startsAt: "2026-08-27T00:00:00.000Z", endsAt: "2026-08-27T01:00:00.000Z" });
  assert.equal(once.occurrences[0]?.occurrenceKey, "schedule.once:2026-08-27T00:15:00.000Z");
});

test("CR6D paused, malformed, and oversized schedule calculations fail closed", () => {
  assert.deepEqual(calculateScheduleOccurrencesV1({ id: "schedule.paused", kind: "cron", state: "paused", expression: "* * * * *", timezone: "UTC" }, { startsAt: "2026-08-27T00:00:00.000Z", endsAt: "2026-08-27T01:00:00.000Z" }), { occurrences: [] });
  assert.equal(calculateScheduleOccurrencesV1({ id: "schedule.bad", kind: "cron", state: "active", expression: "not cron", timezone: "UTC" }, { startsAt: "2026-08-27T00:00:00.000Z", endsAt: "2026-08-27T01:00:00.000Z" }).safeReason, "invalid_schedule");
  assert.equal(calculateScheduleOccurrencesV1({ id: "schedule.long", kind: "cron", state: "active", expression: "* * * * *", timezone: "UTC" }, { startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-03-01T00:00:00.000Z" }).safeReason, "range_too_large");
});
