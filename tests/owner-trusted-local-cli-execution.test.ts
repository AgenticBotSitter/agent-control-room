import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerTrustedLocalClaudeExecutionAdapterV1, createOwnerTrustedLocalCodexExecutionAdapterV1,
  ownerTrustedLocalCliPromptV1 } from "../src/harness/v1/owner-trusted-local-cli-execution";
import { createOwnerTrustedLocalHermesDeliveryV1 } from "../src/harness/v1/owner-trusted-local-cli-composition";
import { createOwnerTrustedLocalHermesExecutionAdapterV1 } from "../src/harness/hermes-local-v1";

const configuration = { executablePath: "/Applications/Control Room/bin/agent", workingDirectory: "/private/tmp/acr-empty-task", deadlineMs: 60_000 };
const delivery = { identity: { jobId: "job:test" }, input: { instructions: "Read the supplied task only.", prompt: "Summarize the approved evidence." } };

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
  } }, { ...configuration, model: "gpt-test", effort: "high" });
  const result = await adapter.execute({ delivery, signal: new AbortController().signal });
  assert.equal(result.kind, "completed");
  assert.equal(result.kind === "completed" && result.text, "codex text");
  assert.equal(result.usage, null); assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
  assert.deepEqual(observed, { ...configuration, model: "gpt-test", effort: "high",
    prompt: ownerTrustedLocalCliPromptV1(delivery.input), signal: (observed as { signal: AbortSignal }).signal });
});

test("the Codex and Claude adapters preserve their exact cached input token counts", async () => {
  const codex = createOwnerTrustedLocalCodexExecutionAdapterV1({ async execute() {
    return { status: "completed" as const, text: "codex text", usage: { inputTokens: 100_000, outputTokens: 30,
      totalTokens: 100_030, cachedInputTokens: 90_000 } };
  } }, { ...configuration, model: "gpt-test", effort: "high" });
  const claude = createOwnerTrustedLocalClaudeExecutionAdapterV1({ async execute() {
    return { status: "completed" as const, text: "claude text", usageReported: true, usage: { inputTokens: 80, outputTokens: 20,
      totalTokens: 100, cachedInputTokens: 200_000 } };
  } }, { ...configuration, model: "sonnet", effort: "high", supportsEffort: true });

  const [codexResult, claudeResult] = await Promise.all([
    codex.execute({ delivery, signal: new AbortController().signal }),
    claude.execute({ delivery, signal: new AbortController().signal }),
  ]);
  assert.equal(codexResult.kind, "completed");
  assert.equal(claudeResult.kind, "completed");
  assert.equal(codexResult.usage?.cachedInputTokens, 90_000);
  assert.equal(claudeResult.usage?.cachedInputTokens, 200_000);
});

test("an unconfigured Codex worker reaches the direct runner without a model override", async () => {
  let observed: Record<string, unknown> | undefined;
  const adapter = createOwnerTrustedLocalCodexExecutionAdapterV1({ async execute(input) {
    observed = input; return { status: "completed" as const, text: "default text" };
  } }, configuration);
  await adapter.execute({ delivery, signal: new AbortController().signal });
  assert.equal(Object.hasOwn(observed!, "model"), false);
  assert.equal(Object.hasOwn(observed!, "effort"), false);
});

test("the Claude adapter maps an unsafe direct outcome to a non-publishable failure", async () => {
  const adapter = createOwnerTrustedLocalClaudeExecutionAdapterV1({ async execute() {
    return { status: "cleanup_uncertain" as const, reason: "process_group_still_running" };
  } }, { ...configuration, model: "sonnet", effort: "high", supportsEffort: true });
  const result = await adapter.execute({ delivery, signal: new AbortController().signal });
  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" && result.reason, "cleanup_uncertain:process_group_still_running");
  assert.equal(result.usage, null); assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
});

test("the Hermes adapter keeps the selected model/provider in protected configuration", async () => {
  let observed: unknown;
  const adapter = createOwnerTrustedLocalHermesExecutionAdapterV1({ async execute(input) {
    observed = input; return { status: "completed" as const, text: "hermes text", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
  } }, { ...configuration, profile: "cr", model: "space-bunny-free", provider: "opencode-go" });
  const result = await adapter.execute({ delivery, signal: new AbortController().signal });
  assert.equal(result.kind, "completed"); assert.equal(result.kind === "completed" && result.text, "hermes text");
  assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
  assert.deepEqual(observed, { ...configuration, profile: "cr", model: "space-bunny-free", provider: "opencode-go",
    prompt: [
      "You are completing one approved Agent Control Room task in its assigned local workspace.",
      "Use only the tools needed for this task, stay inside the current working directory, and do not retry, resume, use the network, or widen authority.",
      "Return the requested bounded result after the work is complete.",
      "", "Instructions:", delivery.input.instructions, "", "Task:", delivery.input.prompt, "",
    ].join("\n"), signal: (observed as { signal: AbortSignal }).signal });
});

test("the shared composition exposes Hermes through the same durable delivery shape", async () => {
  const base = { db: { transaction() { throw new Error("not_called"); } }, integrityKey: new Uint8Array(32),
    binding: { workerId: "worker:hermes-worker", adapterId: "connector:hermes.macos-local.v1", adapterRevision: "b50bb77e" },
    receiptPort: { async receive() { throw new Error("not_called"); } }, async assertCurrent() {},
    async publish() {}, async recordFailure() {} };
  const composed = createOwnerTrustedLocalHermesDeliveryV1(base as never, { async execute() {
    return { status: "completed" as const, text: "ok", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  } }, { ...configuration, profile: "cr", model: "space-bunny-free", provider: "opencode-go" });
  assert.equal(typeof composed.deliver, "function");
});

test("the execution adapters refuse a canceled call without contacting a CLI", async () => {
  let calls = 0;
  const adapter = createOwnerTrustedLocalCodexExecutionAdapterV1({ async execute() { calls++; return { status: "completed" as const, text: "no" }; } },
    { ...configuration, model: "gpt-test", effort: "high" });
  const aborter = new AbortController(); aborter.abort();
  await assert.rejects(adapter.execute({ delivery, signal: aborter.signal }), /owner_trusted_local_cli_execution_unavailable/);
  assert.equal(calls, 0);
});
