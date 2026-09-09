import { compileCronCalendar } from "./cron-calendar";

export type ScheduleKindV1 = "cron" | "interval" | "once";

export interface ScheduleDefinitionV1 {
  id: string;
  kind: ScheduleKindV1;
  state: "active" | "paused" | "disabled";
  expression: string;
  timezone: string;
  anchorAt?: string;
}

export interface ScheduleOccurrenceV1 {
  scheduleId: string;
  occurrenceKey: string;
  scheduledFor: string;
  localTime: string;
}

export interface ScheduleCalculationV1 {
  occurrences: ScheduleOccurrenceV1[];
  safeReason?: "invalid_schedule" | "range_too_large";
}

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const maximumWindowMinutes = 44_640;

function instant(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function parseNumber(value: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function formatter(timezone: string): Intl.DateTimeFormat | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch { return undefined; }
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; dayOfWeek: number; key: string; }
function localParts(format: Intl.DateTimeFormat, date: Date): LocalParts {
  const parts = Object.fromEntries(format.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const year = Number(parts.year); const month = Number(parts.month); const day = Number(parts.day); const hour = Number(parts.hour); const minute = Number(parts.minute);
  return { year, month, day, hour, minute, dayOfWeek: weekdays[parts.weekday], key: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` };
}

function occurrence(definition: ScheduleDefinitionV1, scheduledFor: string, localTime: string): ScheduleOccurrenceV1 {
  return { scheduleId: definition.id, occurrenceKey: `${definition.id}:${localTime}`, scheduledFor, localTime };
}

function calculateInterval(definition: ScheduleDefinitionV1, start: number, end: number): ScheduleOccurrenceV1[] | undefined {
  const seconds = parseNumber(definition.expression);
  if (!seconds || seconds > 31_536_000 || !definition.anchorAt || !instant(definition.anchorAt)) return undefined;
  const interval = seconds * 1_000;
  const anchor = Date.parse(definition.anchorAt);
  const first = anchor + Math.max(0, Math.ceil((start - anchor) / interval)) * interval;
  const result: ScheduleOccurrenceV1[] = [];
  for (let current = first; current < end; current += interval) {
    const scheduledFor = new Date(current).toISOString();
    result.push(occurrence(definition, scheduledFor, scheduledFor));
  }
  return result;
}

function calculateCron(definition: ScheduleDefinitionV1, start: number, end: number): ScheduleOccurrenceV1[] | undefined {
  const cron = compileCronCalendar(definition.expression, definition.timezone);
  const format = formatter(definition.timezone);
  if (!cron || !format) return undefined;
  const firstMinute = Math.ceil(start / 60_000) * 60_000;
  const seenLocalTimes = new Set<string>();
  const result: ScheduleOccurrenceV1[] = [];
  for (let current = firstMinute; current < end; current += 60_000) {
    const local = localParts(format, new Date(current));
    if (cron.includesDate(new Date(current)) && !seenLocalTimes.has(local.key)) {
      seenLocalTimes.add(local.key);
      result.push(occurrence(definition, new Date(current).toISOString(), local.key));
    }
  }
  return result;
}

/** Produces idempotent, effect-free schedule occurrences for a bounded UTC interval. */
export function calculateScheduleOccurrencesV1(definition: ScheduleDefinitionV1, range: { startsAt: string; endsAt: string }): ScheduleCalculationV1 {
  if (!safeId.test(definition.id) || !["cron", "interval", "once"].includes(definition.kind) || !["active", "paused", "disabled"].includes(definition.state)
    || !instant(range.startsAt) || !instant(range.endsAt) || Date.parse(range.endsAt) <= Date.parse(range.startsAt)) return { occurrences: [], safeReason: "invalid_schedule" };
  const start = Date.parse(range.startsAt); const end = Date.parse(range.endsAt);
  if (end - start > maximumWindowMinutes * 60_000) return { occurrences: [], safeReason: "range_too_large" };
  if (definition.state !== "active") return { occurrences: [] };
  if (!formatter(definition.timezone)) return { occurrences: [], safeReason: "invalid_schedule" };
  if (definition.kind === "once") {
    if (!instant(definition.expression)) return { occurrences: [], safeReason: "invalid_schedule" };
    const scheduledFor = Date.parse(definition.expression);
    return scheduledFor >= start && scheduledFor < end ? { occurrences: [occurrence(definition, definition.expression, definition.expression)] } : { occurrences: [] };
  }
  const occurrences = definition.kind === "interval" ? calculateInterval(definition, start, end) : calculateCron(definition, start, end);
  return occurrences ? { occurrences } : { occurrences: [], safeReason: "invalid_schedule" };
}
