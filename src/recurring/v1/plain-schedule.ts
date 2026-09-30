const weekdays = new Map([
  ["sunday", 0], ["monday", 1], ["tuesday", 2], ["wednesday", 3],
  ["thursday", 4], ["friday", 5], ["saturday", 6],
]);

export type PlainRecurringScheduleV1 = Readonly<{ expression: string; normalized: string }>;

/** Deliberately small owner vocabulary. It is a parser, not an LLM guesser. */
export function parsePlainRecurringScheduleV1(value: string): PlainRecurringScheduleV1 | undefined {
  const normalized = value.trim().replace(/\s+/g, " ").toLowerCase();
  const match = /^every (day|weekday|sunday|monday|tuesday|wednesday|thursday|friday|saturday) at (1[0-2]|[1-9])(?::([0-5][0-9]))?(?: (am|pm))?$/.exec(normalized);
  if (!match) return undefined;
  let hour = Number(match[2]), minute = Number(match[3] ?? 0);
  const meridiem = match[4];
  if (meridiem === "am" && hour === 12) hour = 0;
  if (meridiem === "pm" && hour !== 12) hour += 12;
  const day = match[1]!;
  const dayField = day === "day" ? "*" : day === "weekday" ? "1-5" : String(weekdays.get(day));
  return Object.freeze({ expression: `${minute} ${hour} * * ${dayField}`,
    normalized: `every ${day} at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` });
}

