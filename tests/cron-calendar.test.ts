import assert from "node:assert/strict";
import test from "node:test";
import { compileCronCalendar } from "../src/services/v1/cron-calendar";

test("maintained parser preserves restricted numeric grammar", () => {
  for (const expression of ["01 * * * *", "1/61 * * * *", "1/0 * * * *", "1/ * * * *",
    "1//2 * * * *", "5-1 * * * *", "1,,2 * * * *", "60 * * * *", "* * * * MON",
    "@daily", "0 * * * * *", "* * * *", "0 0 L * *", "0 0 ? * *", "0 0 * * 1#2", "0 0 * JAN *"])
    assert.equal(compileCronCalendar(expression, "UTC"), undefined, expression);
  assert.equal(compileCronCalendar("0 0 31 2 *", "not/a-zone"), undefined);
});

test("singleton steps, unions and restricted day OR semantics are preserved", () => {
  const date = (minute: number) => new Date(Date.UTC(2026, 8, 7, 0, minute));
  const singleton = compileCronCalendar("1/2 * * * *", "UTC")!;
  assert.equal(singleton.includesDate(date(1)), true);
  assert.equal(singleton.includesDate(date(3)), false);
  const union = compileCronCalendar("1-5,3-7 * * * *", "UTC")!;
  for (let minute = 0; minute < 9; minute++) assert.equal(union.includesDate(date(minute)), minute >= 1 && minute <= 7);
  assert.equal(compileCronCalendar("0 0 1 * 1", "UTC")!.includesDate(date(0)), true);
  assert.equal(compileCronCalendar("0 0 * * 2", "UTC")!.includesDate(date(0)), false);
  assert.equal(compileCronCalendar("0 0 */1 * 2", "UTC")!.includesDate(date(0)), true);
});

test("impossible month is empty; restricted weekday still matches", () => {
  const monday = new Date("2026-02-02T00:00:00.000Z");
  assert.equal(compileCronCalendar("0 0 31 2 *", "UTC")!.includesDate(monday), false);
  assert.equal(compileCronCalendar("0 0 31 2 1", "UTC")!.includesDate(monday), true);
});

test("upstream timezone matching handles both fall-back instants and spring gap", () => {
  const fall = compileCronCalendar("30 1 * * *", "America/Denver")!;
  assert.equal(fall.includesDate(new Date("2026-11-01T07:30:00Z")), true);
  assert.equal(fall.includesDate(new Date("2026-11-01T08:30:00Z")), true);
  const spring = compileCronCalendar("30 2 * * *", "America/Denver")!;
  for (const hour of [8, 9, 10]) assert.equal(spring.includesDate(new Date(`2026-03-08T${String(hour).padStart(2, "0")}:30:00Z`)), false);
  // Occurrence policy, not the parser, must deduplicate repeated local times.
});
