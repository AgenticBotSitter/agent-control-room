# Controllable test clock

Timing-sensitive product code should receive a `clock` parameter and call
`clock.now()` where it computes a deadline or checks expiry. If it schedules
work, inject `clock.setTimeout` and `clock.clearTimeout` as well. Production
composition supplies an adapter around `Date.now()` and the platform timers;
tests use `TestClock` from `tests/support/clock.ts`.

Advance the test clock to the boundary instead of sleeping or polling:

```ts
const clock = new TestClock(Date.parse("2026-09-28T12:00:00Z"));
clock.setTimeout(onDeadline, 1_000);
clock.advance(1_000);
```

`advance()` runs due timers in deadline order and uses registration order to
break ties. Timers scheduled by a callback also run during the same advance if
their deadline is within the target instant. This makes boundary behavior
repeatable and keeps tests independent of machine load.
