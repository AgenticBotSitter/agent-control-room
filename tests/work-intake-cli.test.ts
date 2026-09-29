import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkIntakeArgumentsV1, runWorkIntakeCliV1 } from "../src/work-intake/v1";

test("work intake CLI accepts one fixed operation and no paths, flags, secrets, or extra arguments", () => {
  for (const command of ["submit-batch", "batch-status", "batches"] as const)
    assert.deepEqual(parseWorkIntakeArgumentsV1([command]), { command });
  for (const args of [[], ["submit-batch", "/tmp/batch.json"], ["batch-status", "batch:1"],
    ["batches", "--project"], ["submit-batch", "--token", "secret"], ["unknown"]])
    assert.throws(() => parseWorkIntakeArgumentsV1(args), /work_intake_cli_refused/u);
});

test("each CLI invocation loads protected state once and dispatches only its named operation", async () => {
  const calls: string[] = [], lines: string[] = [], errors: string[] = [];
  let inputNumber = 0;
  const runtime = { async loadProtectedClient() { calls.push("load"); return {
    async submit(value: unknown) { calls.push(`submit:${JSON.stringify(value)}`); return { state: "proposed" }; },
    async status(value: unknown) { calls.push(`status:${JSON.stringify(value)}`); return { state: "proposed" }; },
    async list(value: unknown) { calls.push(`list:${JSON.stringify(value)}`); return []; },
  }; }, async readInput() { calls.push("input"); inputNumber += 1; return inputNumber === 1
    ? { projectId: "project:test", idempotencyKey: "cli-submit-key-0001", proposal: { schema: "test" } }
    : { projectId: "project:test" }; },
  report(value: string) { lines.push(value); }, reportError(value: string) { errors.push(value); } };
  assert.equal(await runWorkIntakeCliV1(["submit-batch"], runtime), 0);
  assert.deepEqual(calls.sort(), ["input", "load",
    'submit:{"projectId":"project:test","idempotencyKey":"cli-submit-key-0001","proposal":{"schema":"test"}}'].sort());
  assert.equal(errors.length, 0); assert.match(lines.join(""), /"state":"proposed"/u);
  calls.length = 0; lines.length = 0;
  assert.equal(await runWorkIntakeCliV1(["batches"], runtime), 0);
  assert.equal(calls.filter(value => value === "load").length, 1);
  assert.ok(calls.some(value => value.startsWith("list:")));
});
