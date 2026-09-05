import assert from "node:assert/strict";
import test from "node:test";
import { bindNativeStart, enrollmentSchema, nativeLimits } from "../src/harness/hermes-native-v1/contracts.ts";
import { createNativeEventDecoder, readCapabilities, readJson, readStart, readStatus, readStop } from "../src/harness/hermes-native-v1/protocol.ts";
import { binding, capabilityBody, digest, enrollment, input, nativeRunId, response, statusBody } from "./hermes-native-fixture.ts";

test("native binding is exact, fresh per attempt and contains no prompt or credentials", () => {
  const first = bindNativeStart(enrollment, input), same = bindNativeStart(enrollment, input);
  assert.deepEqual(first, same); assert.equal(Object.isFrozen(first.binding), true);
  assert.doesNotMatch(JSON.stringify(first.binding), /Summarize|Return a short|credential:test/);
  assert.notEqual(bindNativeStart(enrollment, { ...input, attemptId: "attempt:second", effectClaimKey: digest("e") }).binding.sessionId, first.binding.sessionId);
  assert.notEqual(bindNativeStart(enrollment, { ...input, prompt: "Different approved content" }).binding.requestDigest, first.binding.requestDigest);
  assert.equal(first.body.session_id, first.binding.sessionId);
  assert.deepEqual(Object.keys(first.body).sort(), ["input", "instructions", "model", "provider", "session_id"]);
});
test("unsupported hard dollar limits and caller-controlled native context are rejected", () => {
  for (const patch of [{ maxCostUsd: "1.00" }, { nodeId: "node:other" }, { deadline: enrollment.validUntil + 1 },
    { previous_response_id: "previous" }, { toolsets: ["all"] }, { session_id: "personal" }, { prompt: "😀".repeat(9000) }]) {
    assert.throws(() => bindNativeStart(enrollment, { ...input, ...patch }));
  }
});
test("candidate enrollment accepts only the pinned adapter and canonical HTTPS profile", () => {
  for (const patch of [{ revision: "other" }, { canonicalDestination: "http://agent.example.test:80" },
    { profile: "../personal" }, { canonicalDestination: "https://agent.example.test:443/path" }, { password: "fixture" }]) {
    assert.equal(enrollmentSchema.safeParse({ ...enrollment, ...patch }).success, false);
  }
});
test("capabilities require durable retention and exact native routes without inheriting extra features", () => {
  const actual = readCapabilities(response({ ...capabilityBody, unrelated: "ignored" }), 120);
  assert.equal(actual.eventReplay, false); assert.equal(actual.hardCostLimit, false);
  assert.throws(() => readCapabilities(response(capabilityBody), 86401));
  assert.throws(() => readCapabilities(response({ ...capabilityBody, auth: { type: "bearer", required: false } }), 120));
  assert.throws(() => readCapabilities(response({ ...capabilityBody, endpoints: {} }), 120));
});
test("JSON and submission responses are bounded, typed and do not turn a replay into a fresh launch", () => {
  assert.equal(readStart(response({ run_id: nativeRunId, status: "started", replayed: false }, 202)), nativeRunId);
  for (const raw of [{ run_id: nativeRunId, status: "started", replayed: true }, { run_id: "other", status: "started", replayed: false }]) {
    assert.throws(() => readStart(response(raw, 202)));
  }
  assert.throws(() => readJson({ ...response({}), status: 302 }, 200));
  assert.throws(() => readJson({ ...response({}), contentType: "text/html" }, 200));
  assert.throws(() => readJson({ ...response({}), body: Buffer.alloc(nativeLimits.jsonBytes + 1) }, 200));
  assert.throws(() => readJson({ ...response({}), body: Uint8Array.from([0xff]) }, 200));
});
test("native status enforces run/session binding and retains only bounded final content", () => {
  assert.equal(readStatus(response(statusBody("running", { output: "not final" })), nativeRunId, binding).resultText, null);
  const result = readStatus(response(statusBody("completed", { output: "Synthetic summary", error: "not evidence", reasoning: "not evidence" })), nativeRunId, binding);
  assert.equal(result.resultText, "Synthetic summary"); assert.doesNotMatch(JSON.stringify(result), /not evidence/);
  for (const patch of [{ session_id: "personal" }, { run_id: `run_${"2".repeat(32)}` }, { updated_at: 0 },
    { output: "x".repeat(nativeLimits.resultBytes + 1) }]) assert.throws(() => readStatus(response(statusBody("completed", patch)), nativeRunId, binding));
});
test("missing usage stays unknown and reported zero does not become verified metering", () => {
  assert.equal(readStatus(response(statusBody("completed")), nativeRunId, binding).usage, null);
  const result = readStatus(response(statusBody("completed", { usage: { input_tokens: 0, output_tokens: 4 } })), nativeRunId, binding);
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 4, totalTokens: null, provenance: "upstream_reported",
    cachedInputTokens: null, reasoningTokens: null, calls: null, costUsd: null, hardCostLimitEnforced: false });
});
test("a stop acknowledgement differs from a separate reported terminal status", () => {
  assert.deepEqual(readStop(response({ run_id: nativeRunId, status: "stopping" }), nativeRunId, binding), { state: "stopping" });
  assert.equal(readStop(response(statusBody("completed", { output: "Finished before stop" })), nativeRunId, binding).state, "completed");
  assert.throws(() => readStop(response(statusBody()), nativeRunId, binding));
});
test("SSE framing handles fragmented UTF-8/CRLF and drops tool arguments and text", () => {
  const received: unknown[] = [], decoder = createNativeEventDecoder(nativeRunId, event => received.push(event));
  const bytes = Buffer.from(`: keepalive\r\n\r\ndata: ${JSON.stringify({ event: "tool.started", run_id: nativeRunId, arguments: "private 😀" })}\r\n\r\ndata: ${JSON.stringify({ event: "run.completed", run_id: nativeRunId, output: "not authoritative" })}\n\n`);
  for (const byte of bytes) decoder.push(Uint8Array.of(byte)); decoder.finish();
  assert.deepEqual(received, [{ kind: "tool_started" }, { kind: "status_resnapshot" }]);
  assert.throws(() => decoder.push(Buffer.from("")), /closed/);
});
test("SSE rejects mismatched identities, replay directives, incomplete frames and capacity excess", () => {
  for (const source of [`data: ${JSON.stringify({ event: "run.completed", run_id: `run_${"2".repeat(32)}` })}\n\n`,
    "id: 100\n\n", "data: {}", `data: ${"x".repeat(nativeLimits.eventBytes)}\n\n`, "data:\n".repeat(nativeLimits.eventBytes + 1)]) {
    const decoder = createNativeEventDecoder(nativeRunId, () => undefined);
    assert.throws(() => { decoder.push(Buffer.from(source)); decoder.finish(); });
  }
  const decoder = createNativeEventDecoder(nativeRunId, () => undefined);
  const event = Buffer.from(`data: ${JSON.stringify({ event: "message.delta", run_id: nativeRunId })}\n\n`);
  for (let i = 0; i < nativeLimits.streamEvents; i++) decoder.push(event);
  assert.throws(() => decoder.push(event), /limit/);
});
