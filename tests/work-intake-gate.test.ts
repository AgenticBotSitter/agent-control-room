import assert from "node:assert/strict";
import test from "node:test";
import { applySuggestedSplitV1, computeIntakeFlagsV1, computeSuggestedSplitV1 } from "../src/work-intake/v1/intake-gate";
import type { WorkBatchProposalV1 } from "../src/work-intake/v1/schemas";

function task(overrides: Partial<{ instructions: string; acceptanceCriteria: string; acceptanceTests: string }> = {}) {
  return { instructions: "Implement the bounded change.", acceptanceCriteria: "The behavior matches the spec exactly.",
    acceptanceTests: "Run the focused unit tests.", ...overrides };
}

test("a single-deliverable task with concrete acceptance criteria is not flagged", () => {
  assert.deepEqual(computeIntakeFlagsV1(task()), []);
});

test("multiple bulleted deliverables in the instructions trigger needs_breakdown", () => {
  const flags = computeIntakeFlagsV1(task({ instructions: "- Build the API\n- Build the UI\n- Write the docs" }));
  assert.deepEqual(flags, [{ kind: "needs_breakdown", reasonCode: "multiple_listed_deliverables" }]);
});

test("multiple bulleted acceptance criteria alone also trigger needs_breakdown", () => {
  const flags = computeIntakeFlagsV1(task({ acceptanceCriteria: "1. Fast\n2. Correct\n3. Documented" }));
  assert.deepEqual(flags, [{ kind: "needs_breakdown", reasonCode: "multiple_listed_deliverables" }]);
});

test("two or more 'and then' sequential joins trigger needs_breakdown without bullets", () => {
  const flags = computeIntakeFlagsV1(task({
    instructions: "Write the migration, and then run it locally, and then after that update the docs." }));
  assert.deepEqual(flags, [{ kind: "needs_breakdown", reasonCode: "multiple_sequential_steps" }]);
});

test("a single 'and then' does not trigger needs_breakdown by itself", () => {
  assert.deepEqual(computeIntakeFlagsV1(task({ instructions: "Build it, and then verify it locally." })), []);
});

test("vague acceptance language triggers needs_more_info even when not short", () => {
  const flags = computeIntakeFlagsV1(task({ acceptanceCriteria: "Handle edge cases and make it better as needed for the reviewer." }));
  assert.deepEqual(flags, [{ kind: "needs_more_info", reasonCode: "vague_language_used" }]);
});

test("only the emptiest acceptance criteria or tests trigger needs_more_info on length alone", () => {
  assert.deepEqual(computeIntakeFlagsV1(task({ acceptanceCriteria: "Fine." })),
    [{ kind: "needs_more_info", reasonCode: "acceptance_detail_too_short" }]);
  assert.deepEqual(computeIntakeFlagsV1(task({ acceptanceTests: "Test." })),
    [{ kind: "needs_more_info", reasonCode: "acceptance_detail_too_short" }]);
  // A short but complete sentence is not flagged by length alone.
  assert.deepEqual(computeIntakeFlagsV1(task({ acceptanceCriteria: "It compiles cleanly." })), []);
});

test("R7L-10: a task can carry breakdown, vague and short concerns together", () => {
  const flags = computeIntakeFlagsV1(task({ instructions: "- Do A\n- Do B\n- Do C", acceptanceCriteria: "tbd" }));
  assert.deepEqual(flags, [{ kind: "needs_breakdown", reasonCode: "multiple_listed_deliverables" },
    { kind: "needs_more_info", reasonCode: "vague_language_used" },
    { kind: "needs_more_info", reasonCode: "acceptance_detail_too_short" }]);
});

test("suggested split requires matching bullet counts in instructions and acceptance criteria", () => {
  const mismatched = { localId: "build", title: "Build", instructions: "- A\n- B\n- C",
    acceptanceCriteria: "- one\n- two", acceptanceTests: "Run the tests." };
  assert.equal(computeSuggestedSplitV1(mismatched), null);
  const single = { ...mismatched, instructions: "- only one thing" };
  assert.equal(computeSuggestedSplitV1(single), null);
});

test("suggested split pairs each instruction bullet with its matching criterion", () => {
  const flagged = { localId: "build", title: "Build the feature", instructions: "- Build the API\n- Build the UI",
    acceptanceCriteria: "- The API responds correctly\n- The UI renders correctly", acceptanceTests: "Run the suite." };
  const split = computeSuggestedSplitV1(flagged);
  assert.equal(split?.length, 2);
  assert.equal(split?.[0]!.localId, "build-1");
  assert.equal(split?.[0]!.instructions, "Build the API");
  assert.equal(split?.[0]!.acceptanceCriteria, "The API responds correctly");
  assert.equal(split?.[0]!.acceptanceTests, "Run the suite.");
  assert.equal(split?.[1]!.localId, "build-2");
  assert.equal(split?.[1]!.title, "Build the feature (part 2 of 2)");
});

function proposal(): WorkBatchProposalV1 {
  return { schema: "control-room.work-batch-proposal/v1", projectId: "project:alpha", tasks: [
    { localId: "plan", title: "Plan", instructions: "Write the plan.", requiredCapability: "planning",
      role: "builder", acceptanceCriteria: "The plan names every affected file.", acceptanceTests: "Read it back." },
    { localId: "build", title: "Build the feature", instructions: "- Build the API\n- Build the UI",
      requiredCapability: "code.change", role: "builder",
      acceptanceCriteria: "- The API responds correctly\n- The UI renders correctly",
      acceptanceTests: "Run the focused suite." },
    { localId: "check", title: "Check the result", instructions: "Review the retained implementation evidence.",
      requiredCapability: "code.review", role: "checker", acceptanceCriteria: "The review is independent and specific.",
      acceptanceTests: "Run the focused review checklist." },
  ], edges: [{ fromLocalId: "plan", toLocalId: "build" }, { fromLocalId: "build", toLocalId: "check" }] };
}

test("applying a suggested split reroutes the flagged task's edges through the new chain", () => {
  const revised = applySuggestedSplitV1(proposal(), "build");
  assert.ok(revised);
  assert.deepEqual(revised!.tasks.map(t => t.localId), ["plan", "build-1", "build-2", "check"]);
  assert.deepEqual(new Set(revised!.edges.map(e => `${e.fromLocalId}->${e.toLocalId}`)),
    new Set(["plan->build-1", "build-1->build-2", "build-2->check"]));
  // Content came from the split, not a stale copy of the original task.
  const first = revised!.tasks.find(t => t.localId === "build-1")!;
  assert.equal(first.instructions, "Build the API");
});

test("applying a suggested split returns null when no split is available", () => {
  assert.equal(applySuggestedSplitV1(proposal(), "plan"), null);
  assert.equal(applySuggestedSplitV1(proposal(), "no-such-task"), null);
});
