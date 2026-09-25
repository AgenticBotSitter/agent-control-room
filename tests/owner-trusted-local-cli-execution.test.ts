import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerTrustedLocalClaudeExecutionAdapterV1, createOwnerTrustedLocalCodexExecutionAdapterV1,
  ownerTrustedLocalCliPromptV1 } from "../src/harness/v1/owner-trusted-local-cli-execution";
import { createOwnerTrustedLocalHermesExecutionAdapterV1 } from "../src/harness/hermes-local-v1";

const configuration = { executablePath: "/Applications/Control Room/bin/agent", workingDirectory: "/private/tmp/acr-empty-task", deadlineMs: 60_000 };
const delivery = { input: { instructions: "Read the supplied task only.", prompt: "Summarize the approved evidence." } };

test("the shared local CLI prompt is bounded and contains only the approved task material", () => {
  const prompt = ownerTrustedLocalCliPromptV1(delivery.input);
  assert.match(prompt, /Instructions:\nRead the supplied task only\./);
  assert.match(prompt, /Task:\nSummarize the approved evidence\./);
  assert.throws(() => ownerTrustedLocalCliPromptV1({ instructions: "x", prompt: "x".repeat(50_000) }));
});

test("the Codex adapter pins its executable, empty task directory, and deadline while mapping a direct result", async () => {
  let observed: unknown;
  const adapter = createOwnerTrustedLocalCodexExecutionAdapterV1({ async execute(input) {
    observed = input; return { status: "completed" as const, text: "codex text" };
  } }, configuration);
  const result = await adapter.execute({ delivery, signal: new AbortController().signal });
  assert.deepEqual(result, { kind: "completed", text: "codex text" });
  assert.deepEqual(observed, { ...configuration, prompt: ownerTrustedLocalCliPromptV1(delivery.input), signal: (observed as { signal: AbortSignal }).signal });
});

test("the Claude adapter maps an unsafe direct outcome to a non-publishable failure", async () => {
  const adapter = createOwnerTrustedLocalClaudeExecutionAdapterV1({ async execute() {
    return { status: "cleanup_uncertain" as const, reason: "process_group_still_running" };
  } }, configuration);
  const result = await adapter.execute({ delivery, signal: new AbortController().signal });
  assert.deepEqual(result, { kind: "failed", reason: "cleanup_uncertain:process_group_still_running" });
});

test("the Hermes adapter keeps the selected model/provider in protected configuration", async () => {
  let observed: unknown;
  const adapter = createOwnerTrustedLocalHermesExecutionAdapterV1({ async execute(input) {
    observed = input; return { status: "completed" as const, text: "hermes text", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
  } }, { ...configuration, profile: "cr", model: "space-bunny-free", provider: "opencode-go" });
  const result = await adapter.execute({ delivery, signal: new AbortController().signal });
  assert.deepEqual(result, { kind: "completed", text: "hermes text" });
  assert.deepEqual(observed, { ...configuration, profile: "cr", model: "space-bunny-free", provider: "opencode-go",
    prompt: ownerTrustedLocalCliPromptV1(delivery.input), signal: (observed as { signal: AbortSignal }).signal });
});

test("the execution adapters refuse a canceled call without contacting a CLI", async () => {
  let calls = 0;
  const adapter = createOwnerTrustedLocalCodexExecutionAdapterV1({ async execute() { calls++; return { status: "completed" as const, text: "no" }; } }, configuration);
  const aborter = new AbortController(); aborter.abort();
  await assert.rejects(adapter.execute({ delivery, signal: aborter.signal }), /owner_trusted_local_cli_execution_unavailable/);
  assert.equal(calls, 0);
});
