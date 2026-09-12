import { CronExpressionParser, CronExpression, CronFieldCollection, CronSecond,
  CronMinute, CronHour, CronDayOfMonth, CronMonth, CronDayOfWeek } from "cron-parser";

export interface CronCalendar { includesDate(date: Date): boolean; }
const specifications = [
  ["minute", 0, 59], ["hour", 0, 23], ["dayOfMonth", 1, 31],
  ["month", 1, 12], ["dayOfWeek", 0, 7],
] as const;
function integer(text: string): number {
  return /^(0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : NaN;
}

/** Compatibility grammar only. Maintained upstream code expands and matches fields.
 * This has no clock, queue, persistence or execution authority.
 */
export function compileCronCalendar(expression: string, timezone: string): CronCalendar | undefined {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  try {
    // Reject invalid zones even for a calendar with no possible occurrences.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    const expanded = specifications.map(([name, minimum, maximum], index) => {
      const raw = parts[index], values = new Set<number>();
      for (const segment of raw.split(",")) {
        const pieces = segment.split("/"), [range, stepText] = pieces;
        const step = stepText === undefined ? 1 : integer(stepText);
        if (pieces.length > 2 || !range || !Number.isSafeInteger(step) || step < 1 || step > maximum - minimum + 1)
          throw new Error("invalid_cron_field");
        let normalized = segment;
        if (range !== "*") {
          const bounds = range.split("-"), start = integer(bounds[0]);
          const end = bounds.length === 1 ? start : integer(bounds[1]);
          if (bounds.length > 2 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
            || start < minimum || end > maximum || start > end) throw new Error("invalid_cron_field");
          // Existing singleton /step syntax means that singleton, not an open range.
          if (bounds.length === 1) normalized = range;
        }
        const one = ["*", "*", "*", "*", "*"]; one[index] = normalized;
        for (const value of CronExpressionParser.parse(one.join(" "), { strict: false }).fields[name].values)
          values.add(name === "dayOfWeek" && value === 7 ? 0 : Number(value));
      }
      return { values: [...values].sort((a, b) => a - b), options: { rawValue: raw, wildcard: raw === "*" } };
    });
    // Values are range-checked above and expanded by the corresponding upstream field.
    const fields = {
      second: new CronSecond([0], { rawValue: "0" }),
      minute: new CronMinute(expanded[0].values as ConstructorParameters<typeof CronMinute>[0], expanded[0].options),
      hour: new CronHour(expanded[1].values as ConstructorParameters<typeof CronHour>[0], expanded[1].options),
      dayOfMonth: new CronDayOfMonth(expanded[2].values as ConstructorParameters<typeof CronDayOfMonth>[0], expanded[2].options),
      month: new CronMonth(expanded[3].values as ConstructorParameters<typeof CronMonth>[0], expanded[3].options),
      dayOfWeek: new CronDayOfWeek(expanded[4].values as ConstructorParameters<typeof CronDayOfWeek>[0], expanded[4].options),
    };
    let collection: CronFieldCollection;
    try { collection = new CronFieldCollection(fields); }
    catch (error) {
      // Legacy policy accepts impossible month/day combinations as empty calendars.
      // This exact pinned-library condition is regression-tested; other errors refuse.
      if (error instanceof Error && error.message === "Invalid explicit day of month definition")
        return { includesDate: () => false };
      throw error;
    }
    return CronExpression.fieldsToExpression(collection, { tz: timezone });
  } catch { return undefined; }
}
