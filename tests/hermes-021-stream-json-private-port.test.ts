import assert from "node:assert/strict";
import test from "node:test";
import { createHermes021MacosStreamJsonPrivatePortV1 } from "../src/harness/hermes-021-v1";

const binding = { localServiceId: "service:hermes", workerId: "worker:hermes", expectedVersion: "0.21.3" as const, sourceRevision: "00570550" };
const task = { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test", attemptId: "attempt:test", runId: "run:test", nodeId: "node:test",
  prompt: "Return a result", instructions: "No tools", deadline: 99_999 };
const result = { type: "result", session_id: "session:test", exit_code: 0, text: "finished", tokens: { input: 2, output: 3, total: 5, cache_read: 0, cache_write: 0 }, duration_ms: 4, timestamp: 5 };

test("stream-json private port stages its only completed terminal result before returning lines", async () => {
  let staged: unknown;
  const port = createHermes021MacosStreamJsonPrivatePortV1(binding, { async execute(input) {
    await input.onLine(JSON.stringify({ type: "progress", message: "safe non-terminal fixture" }));
    await input.onLine(JSON.stringify(result));
  } });
  const lines = await port.run({ localServiceId: binding.localServiceId, task, terminalStage: { async capture(value) { staged = value; } } });
  assert.equal(lines.length, 2);
  assert.deepEqual(staged, result);
});

test("stream-json private port does not stage an ambiguous two-result stream", async () => {
  let staged = 0;
  const port = createHermes021MacosStreamJsonPrivatePortV1(binding, { async execute(input) {
    await input.onLine(JSON.stringify(result));
    await input.onLine(JSON.stringify({ ...result, session_id: "session:second" }));
  } });
  const lines = await port.run({ localServiceId: binding.localServiceId, task, terminalStage: { async capture() { staged++; } } });
  assert.equal(lines.length, 2);
  assert.equal(staged, 0);
});
