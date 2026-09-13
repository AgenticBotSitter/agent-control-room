import { z } from "zod";
import { scheduleRecordSchema } from "../domain/v1";
import { calculateScheduleOccurrencesV1 } from "../services/v1/recurrence";
import { scheduleStatusSchema, type ScheduleStatus } from "./status-wire";
import { assertNoSecretMaterial } from "../security";

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const id = z.string().min(3).max(240).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const occurrenceSchema = z.object({ tenantId: id, scheduleId: id, occurrenceKey: id,
  targetType: z.enum(["workflow", "job", "service_check"]), targetId: id,
  definitionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), scheduledFor: instant,
  localTime: z.string().regex(/^[0-9TZ:.+-]{16,40}$/),
  state: z.enum(["pending", "dispatched", "cancelled"]), createdAt: instant,
  dispatchedAt: instant.nullable(),
}).strict().refine(value => (value.state === "dispatched") === (value.dispatchedAt !== null));

/** Forecast and retained occurrence status only. Neither proves dispatch or execution.
 * An occurrence may describe an older definition: its original time/state are preserved. */
export function projectScheduleStatus(input: { tenantId: string; projectId: string; schedule: unknown;
  occurrences: readonly unknown[]; now: string; windowEndsAt: string; additionalOccurrencesOmitted?: boolean }): ScheduleStatus {
  const now = instant.parse(input.now), end = instant.parse(input.windowEndsAt);
  const schedule = scheduleRecordSchema.parse(input.schedule);
  if (schedule.tenantId !== input.tenantId || schedule.projectId !== input.projectId) throw new Error("schedule_status_unavailable");
  const retained = z.array(occurrenceSchema).max(20).parse(input.occurrences);
  const keys = new Set<string>();
  for (const item of retained) {
    if (item.tenantId !== input.tenantId || item.scheduleId !== schedule.id || keys.has(item.occurrenceKey))
      throw new Error("schedule_status_unavailable");
    keys.add(item.occurrenceKey);
  }
  let nextReason: ScheduleStatus["nextReason"], nextOccurrenceAt: string | null = null;
  const duration = Date.parse(end) - Date.parse(now);
  if (duration <= 0) nextReason = "invalid_schedule";
  else if (duration > 31 * 86400_000) nextReason = "range_too_large";
  else if (schedule.state !== "active") nextReason = schedule.state;
  else if (schedule.scheduleType === "interval") nextReason = "anchor_unavailable";
  else {
    const calculation = calculateScheduleOccurrencesV1({ id: schedule.id, kind: schedule.scheduleType,
      state: schedule.state, expression: schedule.expression, timezone: schedule.timezone }, { startsAt: now, endsAt: end });
    nextOccurrenceAt = calculation.occurrences[0]?.scheduledFor ?? null;
    nextReason = calculation.safeReason ?? (nextOccurrenceAt ? "calculated" : "none_in_window");
  }
  const status = scheduleStatusSchema.parse({ scheduleId: schedule.id, state: schedule.state,
    scheduleType: schedule.scheduleType, timezone: schedule.timezone, nextOccurrenceAt, nextReason,
    occurrences: retained.sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor) || a.occurrenceKey.localeCompare(b.occurrenceKey))
      .map(item => ({ occurrenceKey: item.occurrenceKey, scheduledFor: item.scheduledFor,
        state: item.state, pastDue: item.state === "pending" && item.scheduledFor < now })),
    additionalOccurrencesOmitted: input.additionalOccurrencesOmitted ?? false });
  assertNoSecretMaterial(status);
  return status;
}
