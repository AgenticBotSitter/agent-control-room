import assert from "node:assert/strict";
import test from "node:test";
import { chooseAllocationV1, STARVATION_BOUND_MINUTES_V1, type AllocationCandidateV1 } from "../src/scheduler/v1";

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffle<T>(values: T[], next: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(next() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function generatedQueue(seed: number): AllocationCandidateV1[] {
  const next = random(seed);
  return Array.from({ length: 24 }, (_, index) => ({
    projectId: `project.${index % 5}`,
    workItemId: `work.${seed}.${index}`,
    routeId: `route.${index}`,
    targetShare: Math.floor(next() * 101),
    recentShareUsed: Math.floor(next() * 101),
    priority: Math.floor(next() * 101),
    queueAgeMinutes: Math.floor(next() * 1_000),
    downstreamUnlockCount: Math.floor(next() * 8),
    deadlineRisk: Math.floor(next() * 101) / 100,
    estimatedCostUsd: Math.floor(next() * 100) / 100,
    ...(index % 7 === 0 ? { exclusions: ["maintenance" as const] } : {}),
  }));
}

test("CR6C seeded queues produce the same decision regardless of candidate arrival order", () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const queue = generatedQueue(seed);
    const expected = chooseAllocationV1(queue);
    const actual = chooseAllocationV1(shuffle(queue, random(seed + 10_000)));
    assert.deepEqual(actual, expected, `seed ${seed}`);
    const selected = queue.find((candidate) => candidate.workItemId === actual.selected?.workItemId);
    assert.equal(selected?.exclusions, undefined, `seed ${seed} selected excluded work`);
    assert.ok(actual.score === undefined || Number.isFinite(actual.score), `seed ${seed} produced a non-finite score`);
  }
});

test("CR6C starvation and hard exclusions hold across seeded competing priorities", () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const next = random(seed);
    const oldestAge = STARVATION_BOUND_MINUTES_V1 + seed;
    const queue: AllocationCandidateV1[] = [
      { projectId: "project.fresh", workItemId: `work.fresh.${seed}`, routeId: "route.fast", targetShare: 100, recentShareUsed: 0, priority: 100, queueAgeMinutes: Math.floor(next() * 100), downstreamUnlockCount: 100, deadlineRisk: 1, estimatedCostUsd: 0 },
      { projectId: "project.old", workItemId: `work.old.${seed}`, routeId: "route.slow", targetShare: 0, recentShareUsed: 100, priority: 0, queueAgeMinutes: oldestAge, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 100 },
      { projectId: "project.blocked", workItemId: `work.blocked.${seed}`, routeId: "route.blocked", targetShare: 100, recentShareUsed: 0, priority: 100, queueAgeMinutes: oldestAge + 10_000, downstreamUnlockCount: 100, deadlineRisk: 1, estimatedCostUsd: 0, exclusions: ["fleet_ineligible"] },
    ];
    const decision = chooseAllocationV1(shuffle(queue, next));
    assert.equal(decision.selected?.projectId, "project.old", `seed ${seed}`);
    assert.equal(decision.rejected[0]?.reasons.includes("fleet_ineligible"), true, `seed ${seed}`);
  }
});

test("CR6C fair-share debt wins equal safe work and remains a scoring input rather than authority", () => {
  const common = { priority: 10, queueAgeMinutes: 10, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0 };
  const decision = chooseAllocationV1([
    { ...common, projectId: "project.ahead", workItemId: "work.ahead", routeId: "route.a", targetShare: 20, recentShareUsed: 60 },
    { ...common, projectId: "project.behind", workItemId: "work.behind", routeId: "route.b", targetShare: 60, recentShareUsed: 10 },
  ]);
  assert.equal(decision.selected?.projectId, "project.behind");
  assert.match(decision.explanation.join(" "), /not an execution grant or resource reservation/i);
});
