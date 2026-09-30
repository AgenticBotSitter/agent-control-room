import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createRepositorySimulationDatabaseV1 } from "../src/persistence/database";
import { createRecordingNightEffectPortV1, mutableNightOperationsModeV1, runNightKitV1,
  type NightKitWorkerPortV1 } from "../src/night-kit/v1";

const shadowCatalog = [
  { workerId: "worker:night-codex", workerKind: "codex" as const, nodeId: "node:night-codex",
    modelPolicy: { models: ["codex.standard"], defaultModel: "codex.standard", efforts: ["high" as const], defaultEffort: "high" as const } },
  { workerId: "worker:night-claude", workerKind: "claude-code" as const, nodeId: "node:night-claude",
    modelPolicy: { models: ["claude.standard"], defaultModel: "claude.standard", efforts: ["high" as const], defaultEffort: "high" as const } },
  { workerId: "worker:night-hermes", workerKind: "hermes" as const, nodeId: "node:night-hermes",
    modelPolicy: { profiles: [{ name: "hermes.default", provider: "local", model: "hermes.default" }],
      defaultProfile: "hermes.default", efforts: ["default" as const], defaultEffort: "default" as const } },
] as const;
const shadow = <T extends object>(value: T) => ({ workerCatalog: shadowCatalog, ...value });

test("the shadow command refuses to start without protected worker configuration", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/night-kit.ts", "shadow"],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, CONTROL_ROOM_PROTECTED_ROOT: "" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Night kit did not start: night:shadow requires --protected-root ABSOLUTE_PATH/u);
});

test("practice runs the proposed, approved, queued pipeline and closes its throwaway database", async () => {
  let closed = 0;
  const result = await runNightKitV1("practice", { createDatabase: async () => {
    const database = await createRepositorySimulationDatabaseV1({ testOnly: true });
    return Object.freeze({ ...database, async close() { closed += 1; await database.close(); } });
  } });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.completedStages, ["build", "check", "signoff"]);
  assert.deepEqual(result.effects.map(effect => effect.kind), ["commit", "push", "pull_request_draft"]);
  assert.equal(result.effects.every(effect => effect.disposition === "would_have_done"), true);
  assert.equal(result.databaseKind, "throwaway_local");
  assert.equal(result.databaseClosed, true);
  assert.equal(closed, 1);
  assert.ok(result.migrationsApplied > 0);
  assert.equal(result.loopLimit, 2);
  assert.deepEqual(result.caps, { maxTotalTasks: 3, maxConcurrentTasks: 1,
    maxTotalCostMicroUsd: 0, maxDurationSeconds: 900 });
});

test("the practice worker produces the same bounded trivial change every time", async () => {
  const { deterministicPracticeWorkerV1 } = await import("../src/night-kit/v1");
  const input = { mode: "practice" as const, runId: "pipeline-run:test", stage: "build" as const,
    workerId: "worker:test", model: "model:test", attempt: 1 };
  const first = await deterministicPracticeWorkerV1.run(input), second = await deterministicPracticeWorkerV1.run(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first.change, { path: "practice/night-kit.txt", content: "night-kit-practice-v1\n" });
});

test("shadow uses the protected catalog path and performs zero repository effects", async () => {
  const calls: string[] = [], effects = createRecordingNightEffectPortV1();
  const worker: NightKitWorkerPortV1 = { async run(input) {
    calls.push(`${input.stage}:${input.workerId}:${input.model}`);
    return { state: "passed", summary: "shadow selection recorded" };
  } };
  const result = await runNightKitV1("shadow", shadow({ effects, worker }));
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, [
    "build:worker:night-codex:codex.standard",
    "check:worker:night-claude:claude.standard",
    "signoff:worker:night-hermes:hermes.default",
  ]);
  assert.deepEqual(effects.entries(), result.effects);
  assert.deepEqual(effects.entries().map(effect => effect.disposition),
    ["would_have_done", "would_have_done", "would_have_done"]);
  assert.match(result.message, /no commit, push, or pull request was performed/u);
});

test("Stop halts a shadow night between stages and records no later effect", async () => {
  const operations = mutableNightOperationsModeV1(), stages: string[] = [];
  const worker: NightKitWorkerPortV1 = { async run(input) {
    stages.push(input.stage); operations.set("stopped");
    return { state: "passed", summary: "first stage completed before Stop" };
  } };
  const result = await runNightKitV1("shadow", shadow({ operations, worker }));
  assert.equal(result.status, "stopped");
  assert.deepEqual(stages, ["build"]);
  assert.deepEqual(result.completedStages, ["build"]);
  assert.deepEqual(result.effects, []);
  assert.equal(result.databaseClosed, true);
});

test("Stop after sign-off prevents every repository-effect record", async () => {
  const operations = mutableNightOperationsModeV1();
  const worker: NightKitWorkerPortV1 = { async run(input) {
    if (input.stage === "signoff") operations.set("stopped");
    return { state: "passed", summary: "stage passed" };
  } };
  const result = await runNightKitV1("shadow", shadow({ operations, worker }));
  assert.equal(result.status, "stopped");
  assert.deepEqual(result.completedStages, ["build", "check", "signoff"]);
  assert.deepEqual(result.effects, []);
});

test("Pause and Drain refuse a new stage at the same supervisor boundary", async () => {
  for (const [mode, expected] of [["paused", "paused"], ["draining", "drained"]] as const) {
    let calls = 0;
    const result = await runNightKitV1("practice", { operations: mutableNightOperationsModeV1(mode),
      worker: { async run() { calls += 1; return { state: "passed", summary: "unexpected" }; } } });
    assert.equal(result.status, expected);
    assert.equal(calls, 0);
    assert.deepEqual(result.completedStages, []);
    assert.deepEqual(result.effects, []);
  }
});

test("a retry is bounded at two and a later retry begins from a fresh throwaway run", async () => {
  let firstCalls = 0;
  const capped = await runNightKitV1("practice", { worker: { async run() {
    firstCalls += 1; return { state: "retry", summary: "try again" };
  } } });
  assert.equal(capped.status, "capped");
  assert.equal(firstCalls, 2);
  assert.deepEqual(capped.effects, []);

  let secondCalls = 0;
  const recovered = await runNightKitV1("practice", { worker: { async run() {
    secondCalls += 1; return { state: "passed", summary: "fresh run passed" };
  } } });
  assert.equal(recovered.status, "completed");
  assert.equal(secondCalls, 3);
});

test("a terminal worker failure stops immediately without repository effects", async () => {
  let calls = 0;
  const result = await runNightKitV1("practice", { worker: { async run() {
    calls += 1; return { state: "failed", summary: "bounded failure" };
  } } });
  assert.equal(result.status, "failed");
  assert.equal(calls, 1);
  assert.deepEqual(result.completedStages, []);
  assert.deepEqual(result.effects, []);
});

test("bad mode, missing real worker selection and worker failure stay fail-closed", async () => {
  await assert.rejects(runNightKitV1("bad" as "practice"), /night_mode_invalid/u);
  await assert.rejects(runNightKitV1("shadow"), /night_shadow_worker_catalog_required/u);
  await assert.rejects(runNightKitV1("shadow", { workerCatalog: [] }), /night_shadow_three_worker_selection_required/u);
  await assert.rejects(runNightKitV1("shadow", shadow({ readyWorkerIds: ["worker:night-codex", "worker:night-claude"] })), /conflict/u);
  await assert.rejects(runNightKitV1("practice", { workerCatalog: [{ workerId: "worker:no-policy",
    workerKind: "codex", nodeId: "node:no-policy" }] }), /night_worker_model_policy_required/u);
  let closed = 0;
  await assert.rejects(runNightKitV1("practice", { createDatabase: async () => {
    const database = await createRepositorySimulationDatabaseV1({ testOnly: true });
    return Object.freeze({ ...database, async close() { closed += 1; await database.close(); } });
  }, worker: { async run() { throw new Error("synthetic_worker_failure"); } } }), /synthetic_worker_failure/u);
  assert.equal(closed, 1);
});

test("two concurrent callers receive isolated throwaway databases", async () => {
  const [first, second] = await Promise.all([runNightKitV1("practice"), runNightKitV1("practice")]);
  assert.equal(first.status, "completed"); assert.equal(second.status, "completed");
  assert.notEqual(first.batchId, second.batchId); assert.notEqual(first.pipelineRunId, second.pipelineRunId);
  assert.equal(first.databaseClosed && second.databaseClosed, true);
});
