import assert from "node:assert/strict";
import test from "node:test";
import { collectProjectedTasksV1, projectTaskDisplayStateV1,
  type TaskDisplayEvidenceV1 } from "../src/web/v1/task-display-state";
import type { TaskSummary } from "../src/web/v1/task-wire";

const at = "2026-09-27T12:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;
const task = (state: TaskSummary["state"]): TaskSummary => ({ jobId: "job:test", projectId: "project:test",
  requestId: "request:test", title: "Test task", state, version: 2, createdAt: at, updatedAt: at });
const evidence = (patch: Partial<TaskDisplayEvidenceV1> = {}): TaskDisplayEvidenceV1 => ({
  latestAttemptOutcome: { attemptId: "attempt:2", attemptState: "leased", runId: "run:2", runState: "succeeded" },
  results: [{ artifactId: "artifact:result", attemptId: "attempt:2", runId: "run:2", contentHash: hash }],
  reviews: [], additionalResultsOmitted: false, additionalTargetsOmitted: false, ...patch,
});

test("a canonical leased attempt with a succeeded latest run and matching result is displayed as completed", () => {
  const projected = projectTaskDisplayStateV1(task("leased"), evidence());
  assert.equal(projected.state, "succeeded");
  assert.equal(projected.qualityStatus, undefined);
});

test("ready review evidence displays accepted only for the same received artifact and digest", () => {
  const accepted = evidence({ reviews: [{ status: "ready", contentHash: hash, matchingArtifactIds: ["artifact:result"] }] });
  assert.equal(projectTaskDisplayStateV1(task("leased"), accepted).qualityStatus, "accepted");
  assert.equal(projectTaskDisplayStateV1(task("leased"), evidence({ reviews: [{ ...accepted.reviews[0]!,
    contentHash: `sha256:${"b".repeat(64)}` }] })).qualityStatus, undefined);
});

test("changes-requested review stays separate from the completed execution display", () => {
  const projected = projectTaskDisplayStateV1(task("leased"), evidence({ reviews: [{ status: "changes_requested",
    contentHash: hash, matchingArtifactIds: ["artifact:result"] }] }));
  assert.equal(projected.state, "succeeded");
  assert.equal(projected.qualityStatus, undefined);
});

test("missing, stale-attempt, nonterminal, and partial evidence fail closed", () => {
  const cases: TaskDisplayEvidenceV1[] = [
    evidence({ latestAttemptOutcome: undefined }),
    evidence({ latestAttemptOutcome: { attemptId: "attempt:2", attemptState: "leased", runId: "run:2", runState: "running" } }),
    evidence({ latestAttemptOutcome: { attemptId: "attempt:2", attemptState: "failed", runId: "run:2", runState: "succeeded" } }),
    evidence({ results: [] }),
    evidence({ results: [{ ...evidence().results[0]!, attemptId: "attempt:1" }] }),
    evidence({ results: [{ ...evidence().results[0]!, runId: "run:1" }] }),
  ];
  for (const value of cases) assert.deepEqual(projectTaskDisplayStateV1(task("leased"), value), task("leased"));
  const partial = evidence({ reviews: [{ status: "ready", contentHash: hash, matchingArtifactIds: ["artifact:result"] }],
    additionalTargetsOmitted: true });
  assert.equal(projectTaskDisplayStateV1(task("leased"), partial).state, "succeeded");
  assert.equal(projectTaskDisplayStateV1(task("leased"), partial).qualityStatus, undefined);
});

test("a canonical terminal state is never moved backward by display evidence", () => {
  assert.equal(projectTaskDisplayStateV1(task("failed"), evidence()).state, "failed");
  assert.equal(projectTaskDisplayStateV1(task("cancelled"), evidence()).state, "cancelled");
  assert.equal(projectTaskDisplayStateV1(task("succeeded"), evidence()).state, "succeeded");
});

test("bounded projection pages past newer completed rows to find older active work", async () => {
  const candidates = [...Array.from({ length: 11 }, (_, index) => ({ id: `completed:${index}`, active: false })),
    { id: "active:older", active: true }];
  const reads: number[] = [];
  const result = await collectProjectedTasksV1({ limit: 10, batchSize: 5, maximumCandidates: 25,
    async read(offset, limit) { reads.push(offset); return candidates.slice(offset, offset + limit); },
    async project(value) { return value; }, keep: value => value.active });
  assert.deepEqual(result.items.map(value => value.id), ["active:older"]);
  assert.equal(result.omitted, false);
  assert.deepEqual(reads, [0, 5, 10]);
});

test("bounded projection reports omission when candidate safety limit prevents a complete answer", async () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({ id: `completed:${index}`, active: false }));
  const result = await collectProjectedTasksV1({ limit: 10, batchSize: 5, maximumCandidates: 10,
    async read(offset, limit) { return candidates.slice(offset, offset + limit); },
    async project(value) { return value; }, keep: value => value.active });
  assert.deepEqual(result.items, []);
  assert.equal(result.omitted, true);
});
