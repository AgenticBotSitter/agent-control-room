import assert from "node:assert/strict";
import test from "node:test";
import { captureTaskModelCatalogV1, resolveTaskModelV1, taskModelOptionsV1,
  inheritTaskModelRequestV1, validateRequestedTaskModelV1 } from "../src/web/v1/task-model-selection";
import { taskResultMetadataSchema } from "../src/web/v1/task-result-wire";

const catalog = captureTaskModelCatalogV1([
  { kind: "codex", policy: { models: ["gpt-build", "gpt-check"], defaultModel: "gpt-build",
    efforts: ["low", "high"], defaultEffort: "low" } },
  { kind: "claude-code", policy: { models: ["sonnet", "opus"], defaultModel: "sonnet",
    efforts: ["low", "high"], defaultEffort: "low", limitedModels: ["opus"] } },
  { kind: "hermes", policy: { profiles: [{ name: "build", provider: "provider-one", model: "model-one" },
    { name: "check", provider: "provider-two", model: "model-two" }], defaultProfile: "build",
    efforts: ["default"], defaultEffort: "default" } },
]);

test("workers without an explicit protected allowlist expose no model choices", () => {
  const defaults = captureTaskModelCatalogV1([
    { kind: "codex" }, { kind: "claude-code" }, { kind: "hermes" },
  ]);
  assert.deepEqual(defaults, []);
  assert.deepEqual(taskModelOptionsV1(defaults), []);
  assert.throws(() => resolveTaskModelV1(defaults, "codex", {}), /task_model_selection_refused/);
});

test("tampered model and effort values are refused before planning", () => {
  assert.throws(() => validateRequestedTaskModelV1(catalog, { model: "not-enabled", effort: "high" }),
    /task_model_selection_refused/);
  assert.throws(() => resolveTaskModelV1(catalog, "codex", { model: "gpt-build", effort: "max" }),
    /task_model_selection_refused/);
});

test("worker defaults, Hermes named profiles, and the Claude cost guard are resolved from protected policy", () => {
  assert.deepEqual(resolveTaskModelV1(catalog, "codex", {}), {
    workerKind: "codex", selectionKey: "gpt-build", model: "gpt-build", effort: "low", usesMoreClaudeLimit: false });
  assert.deepEqual(resolveTaskModelV1(catalog, "hermes", { model: "check" }), {
    workerKind: "hermes", selectionKey: "check", model: "model-two", effort: "default",
    provider: "provider-two", profile: "check", usesMoreClaudeLimit: false });
  assert.equal(resolveTaskModelV1(catalog, "claude-code", { model: "opus", effort: "high" }).usesMoreClaudeLimit, true);
  assert.equal(taskModelOptionsV1(catalog)[1]!.choices.find(choice => choice.key === "opus")?.limited, true);
});

test("revisions inherit model and effort unless the owner replaces an exact field", () => {
  assert.deepEqual(inheritTaskModelRequestV1({ model: "gpt-build", effort: "high" }, {}),
    { model: "gpt-build", effort: "high" });
  assert.deepEqual(inheritTaskModelRequestV1({ model: "gpt-build", effort: "high" }, { effort: "low" }),
    { model: "gpt-build", effort: "low" });
});

test("result evidence retains the chosen model and effort", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const evidence = taskResultMetadataSchema.parse({ artifactId: "artifact:model-result", attemptId: "attempt:model-result",
    runId: "run:model-result", contentHash: digest, sizeBytes: 12, receivedAt: "2026-09-27T00:00:00.000Z",
    byteCheck: "matched_recorded_claim", modelSelection: { model: "gpt-check", effort: "high" }, qualityAccepted: false });
  assert.deepEqual(evidence.modelSelection, { model: "gpt-check", effort: "high" });
});
