import assert from "node:assert/strict";
import test from "node:test";
import { claudeCodeAdapterManifestV1, claudeCodeHarnessAdapterV1, CLAUDE_CODE_PINNED_BUILD_COMMIT_V1, CLAUDE_CODE_PINNED_VERSION_V1 } from "../src/harness/claude-code-v1";
import { HARNESS_ADAPTER_SDK_VERSION_V1, runHarnessAdapterConformanceV1 } from "../src/harness/sdk-v1";

const at = "2026-09-13T01:25:05.000Z";
const context = (sequence: number) => ({ tenantId: "tenant:cc", nodeId: "node:cc", runId: "run:cc", sequence, occurredAt: at });

const goodEvidence = { version: CLAUDE_CODE_PINNED_VERSION_V1, buildCommit: CLAUDE_CODE_PINNED_BUILD_COMMIT_V1,
  printMode: true, streamJsonOutputFormat: true, jsonOutputFormat: true, resumeSupported: true };

// The system/init and assistant/result lines below are the exact frames captured live and
// unauthenticated in Stage A0 (docs/claude/CLAUDE_CODE_A0_VERIFICATION.md), with the working
// directory, tool list, and free-text fields trimmed for fixture size. Real session/uuid
// values are kept because the whole point of this test is proving they never leak past
// normalizeEvent as anything but a digest.
const realSystemInit = JSON.stringify({ type: "system", subtype: "init", session_id: "fda4ecfd-068a-4e0a-8227-109b9d5212d0", claude_code_version: "2.1.270", apiKeySource: "none" });
const realAssistantError = JSON.stringify({ type: "assistant", session_id: "fda4ecfd-068a-4e0a-8227-109b9d5212d0", error: "authentication_failed", is_api_error_message: true, message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] } });
const realResultFailed = JSON.stringify({ type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", total_cost_usd: 0, num_turns: 1, session_id: "fda4ecfd-068a-4e0a-8227-109b9d5212d0", result: "Not logged in · Please run /login", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });

// Not captured live — no authenticated run has been performed (see the plan's open item on
// who owns that account/billing decision). This exercises the decoder's success branch
// against the documented shape only; it is not evidence the shape is correct in production.
const syntheticResultSucceeded = JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.0123, num_turns: 2, session_id: "11111111-1111-4111-8111-111111111111", result: "4", usage: { input_tokens: 120, output_tokens: 4, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 } });

test("CR7D-CC public SDK represents the Claude Code adapter as observation-only", () => {
  assert.equal(claudeCodeHarnessAdapterV1.sdkVersion, HARNESS_ADAPTER_SDK_VERSION_V1);
  assert.deepEqual(Object.keys(claudeCodeHarnessAdapterV1).sort(), ["evaluateCompatibility", "manifest", "normalizeEvent", "sdkVersion"]);
  for (const method of ["start", "approve", "dispatch", "credential", "execute", "steer"]) assert.equal(method in claudeCodeHarnessAdapterV1, false);
});

test("CR7D-CC Phase A manifest declares no steer verb and no request_response approval", () => {
  assert.equal(claudeCodeAdapterManifestV1.supportedVerbs.includes("steer"), false);
  assert.equal(claudeCodeAdapterManifestV1.approvalMode, "unsupported");
  assert.equal(claudeCodeAdapterManifestV1.harness, "claude");
});

test("CR7D-CC conformance accepts the real captured init/assistant-error/result-failed sequence", () => {
  const result = runHarnessAdapterConformanceV1({
    adapter: claudeCodeHarnessAdapterV1, compatibilityEvidence: goodEvidence,
    fixtures: [
      { name: "system init", frame: realSystemInit, context: context(1), expectedEventCount: 1 },
      { name: "assistant error", frame: realAssistantError, context: context(2), expectedEventCount: 1 },
      { name: "result failed", frame: realResultFailed, context: context(3), expectedEventCount: 2 },
    ],
  });
  assert.deepEqual(result, { adapterId: "adapter.claude-code.cli.v1", compatible: true, normalizedEventCount: 4, reasons: [] });
});

test("CR7D-CC decoder classifies a failed result by is_error/terminal_reason, not the misleading subtype", () => {
  const normalized = claudeCodeHarnessAdapterV1.normalizeEvent(realResultFailed, context(1));
  const lifecycleEvent = normalized.events.find((event) => event.payload.category === "lifecycle");
  assert.equal(lifecycleEvent?.payload.category, "lifecycle");
  assert.equal((lifecycleEvent?.payload as { state?: string }).state, "failed");
  assert.equal((lifecycleEvent?.payload as { reasonCode?: string }).reasonCode, "claude_code_api_error");
});

test("CR7D-CC decoder handles the documented (unverified) success shape without claiming it as production-checked", () => {
  const normalized = claudeCodeHarnessAdapterV1.normalizeEvent(syntheticResultSucceeded, context(1));
  const lifecycleEvent = normalized.events.find((event) => event.payload.category === "lifecycle");
  assert.equal((lifecycleEvent?.payload as { state?: string }).state, "succeeded");
  assert.match(normalized.finalTextDigest ?? "", /^sha256:[a-f0-9]{64}$/);
  const usageEvent = normalized.events.find((event) => event.payload.category === "usage");
  assert.deepEqual(usageEvent?.payload, { category: "usage", inputTokens: 120, outputTokens: 4, cachedInputTokens: 15, reasoningTokens: 0, estimatedCostUsd: "0.0123" });
});

test("CR7D-CC normalizes the native session id into a digest and never exposes it in output", () => {
  const normalized = claudeCodeHarnessAdapterV1.normalizeEvent(realSystemInit, context(1));
  assert.match(normalized.nativeSessionKeyDigest ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(normalized).includes("fda4ecfd-068a-4e0a-8227-109b9d5212d0"), false);
});

test("CR7D-CC conformance rejects compatibility drift and an unrecognized frame shape", () => {
  const drift = runHarnessAdapterConformanceV1({ adapter: claudeCodeHarnessAdapterV1, compatibilityEvidence: { ...goodEvidence, version: "9.9.9" }, fixtures: [] });
  assert.deepEqual(drift, { adapterId: "adapter.claude-code.cli.v1", compatible: false, normalizedEventCount: 0, reasons: ["compatibility_rejected"] });

  const unknownFrame = JSON.stringify({ type: "unrecognized_future_event", session_id: "22222222-2222-2222-2222-222222222222" });
  const normalized = claudeCodeHarnessAdapterV1.normalizeEvent(unknownFrame, context(1));
  assert.equal(normalized.events.length, 1);
  assert.equal(normalized.events[0]?.payload.category, "transport");
  assert.equal((normalized.events[0]?.payload as { state?: string }).state, "drift");
});
