import assert from "node:assert/strict";
import test from "node:test";
import { createHermesMacosLocalSessionPortV1 } from "../src/harness/hermes-gpt-v1/macos-local-session-port";

test("Mac-local Hermes port passes only a named local service and one supported tool", async () => {
  const calls: unknown[] = [];
  const port = createHermesMacosLocalSessionPortV1({ localServiceId: "service:local-hermes-hermes" }, {
    async invoke(input) { calls.push(input); return { success: true }; },
  });
  const params = { session_id: "local-hermes", prompt: "Summarize this." };
  assert.deepEqual(await port.call("hermes_session_continue", params), { success: true });
  assert.deepEqual(calls, [{ localServiceId: "service:local-hermes-hermes", tool: "hermes_session_continue", params, signal: undefined }]);
  assert.notEqual((calls[0] as { params: object }).params, params);
});

test("Mac-local Hermes port rejects malformed bindings, unsupported operations, and cancelled calls", async () => {
  assert.throws(() => createHermesMacosLocalSessionPortV1({ localServiceId: "http://127.0.0.1:3000" }, { async invoke() { return {}; } }));
  const port = createHermesMacosLocalSessionPortV1({ localServiceId: "service:local-hermes-hermes" }, { async invoke() { return {}; } });
  await assert.rejects((port.call as (tool: string, params: Record<string, unknown>) => Promise<unknown>)("shell.exec", {}),
    /hermes_local_session_transport_unavailable/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(port.call("hermes_session_job_status", { job_id: "a".repeat(32) }, controller.signal),
    /hermes_local_session_transport_unavailable/);
});

test("Mac-local Hermes port preserves a private-port failure as transport uncertainty", async () => {
  const port = createHermesMacosLocalSessionPortV1({ localServiceId: "service:local-hermes-hermes" }, {
    async invoke() { throw new Error("private port stopped"); },
  });
  await assert.rejects(port.call("hermes_session_job_status", { job_id: "a".repeat(32) }), /private port stopped/);
});
