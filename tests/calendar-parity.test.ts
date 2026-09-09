import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateScheduleOccurrencesV1, type ScheduleDefinitionV1 } from "../src/services/v1/recurrence";

// Frozen outputs from the pre-adoption calculator, not regenerated from the new one.
// Digests cover all occurrence keys, exact UTC times, local times and refusal fields.
const fixture = JSON.parse(await readFile(new URL("./fixtures/calendar-parity.json", import.meta.url), "utf8")) as {
  baselineSha256: string; cases: { name: string; definition: ScheduleDefinitionV1;
    range: { startsAt: string; endsAt: string }; count: number; reason?: string; sha256: string }[];
};
assert.equal(fixture.baselineSha256, "7ddc7925c7e7ba5c3f80eeeedd52c827a0cfaa69572f6370ff259b68baa9099c");
assert.equal(fixture.cases.length, 42);
for (const item of fixture.cases) test(`calendar compatibility: ${item.name}`, () => {
  const actual = calculateScheduleOccurrencesV1(item.definition, item.range);
  assert.equal(actual.occurrences.length, item.count);
  assert.equal(actual.safeReason, item.reason);
  assert.equal(createHash("sha256").update(JSON.stringify(actual)).digest("hex"), item.sha256);
});
