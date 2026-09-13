import { z } from "zod";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
export const scheduleStatusSchema = z.object({
  scheduleId: id, state: z.enum(["active", "paused", "disabled"]),
  scheduleType: z.enum(["cron", "interval", "once"]), timezone: z.string().min(1).max(100),
  nextOccurrenceAt: instant.nullable(),
  nextReason: z.enum(["calculated", "paused", "disabled", "anchor_unavailable", "invalid_schedule", "range_too_large", "none_in_window"]),
  occurrences: z.array(z.object({ occurrenceKey: z.string().min(3).max(240), scheduledFor: instant,
    state: z.enum(["pending", "dispatched", "cancelled"]), pastDue: z.boolean() }).strict()).max(20),
  additionalOccurrencesOmitted: z.boolean(),
}).strict();
export const projectScheduleStatusSchema = z.object({ projectId: id, observedAt: instant,
  windowEndsAt: instant, schedules: z.array(scheduleStatusSchema).max(10),
  additionalSchedulesOmitted: z.boolean(), automaticExecutionEnabled: z.literal(false),
}).strict();
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;
export type ProjectScheduleStatus = z.infer<typeof projectScheduleStatusSchema>;
