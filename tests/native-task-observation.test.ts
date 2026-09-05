import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { nativeTaskObservation, nativeTaskRegistration } from "../src/harness/hermes-native-v1/task-observation";
import { nativeTaskSnapshotBodySchema } from "../src/harness/v1/native-observation";
import { binding, digest, input, instant, nativeRunId } from "./hermes-native-fixture";
import { at, inputDigest, observation, registration, snapshot } from "./native-task-fixture";

test("native observation strips local/native identifiers and text while preserving unknown usage", () => {
  const text = "Synthetic result 😀\n", source = snapshot({ state: "completed", resultText: text,
    usage: { inputTokens: 0, outputTokens: 4, totalTokens: null, provenance: "upstream_reported", cachedInputTokens: null,
      reasoningTokens: null, calls: null, costUsd: null, hardCostLimitEnforced: false } });
  const result = nativeTaskObservation(source, registration.nativeTask!);
  assert.equal(result.result?.contentHash, `sha256:${createHash("sha256").update(text).digest("hex")}`);
  assert.equal(result.result?.sizeBytes, Buffer.byteLength(text));
  assert.equal(result.usage?.inputTokens, 0); assert.equal(result.usage?.totalTokens, null); assert.equal(result.usage?.costUsd, null);
  const wire = JSON.stringify(result);
  for (const privateValue of [nativeRunId, binding.sessionId, text, input.prompt, input.instructions, binding.effectClaimKey, binding.operationDigest]) {
    assert.equal(wire.includes(privateValue), false);
  }
});

test("registration is evidence-only, exact-bound, and cannot mark a run resumable or cleaned up", () => {
  assert.equal(registration.state, "discovered"); assert.equal(registration.resumable, false);
  assert.equal(registration.cancelState, "not_requested"); assert.equal(registration.nativeTask?.inputDigest, inputDigest);
  assert.throws(() => nativeTaskRegistration(binding, inputDigest, "lease:test", 1, at(120_000)), /expired/);
  assert.throws(() => nativeTaskObservation(snapshot(), { ...registration.nativeTask!, bindingDigest: digest("e") }), /binding/);
  assert.throws(() => nativeTaskObservation(snapshot(), { ...registration.nativeTask!, deadline: at(119_000) }), /binding/);
});

test("snapshot wire has bounded strict shapes and does not accept invented cost or result evidence", () => {
  const body = observation();
  for (const patch of [{ prompt: "not permitted" }, { nativeRunId }, { snapshotVersion: 0 }, { runId: "x".repeat(161) },
    { observedAt: "2027-01-15T08:00:01Z" }, { nativeRunKeyDigest: null }, { upstreamUpdatedAt: at(2000) },
    { result: { contentHash: digest(), sizeBytes: 1 } }, { usage: { costUsd: "0" } }]) {
    assert.equal(nativeTaskSnapshotBodySchema.safeParse({ ...body, ...patch }).success, false);
  }
  assert.equal(observation({ state: "prepared", nativeRunId: null, observedAt: instant }).state, "prepared");
});
