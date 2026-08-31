import assert from "node:assert/strict";
import test from "node:test";
import { chooseAllocationV1, evaluateResourceAvailabilityV1, evaluateSchedulingConstraintsV1, placementRejectionV1, STARVATION_BOUND_MINUTES_V1 } from "../src/scheduler/v1";

test("CR6C chooses a deprived eligible project but never scores through a hard exclusion", () => {
  const result = chooseAllocationV1([
    { projectId: "project.a", workItemId: "work.a", routeId: "route.a", targetShare: 60, recentShareUsed: 10, priority: 20, queueAgeMinutes: 5, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0, exclusions: ["resource_unavailable"] },
    { projectId: "project.b", workItemId: "work.b", routeId: "route.b", targetShare: 25, recentShareUsed: 0, priority: 10, queueAgeMinutes: 5, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0 },
  ]);
  assert.deepEqual(result.selected, { projectId: "project.b", workItemId: "work.b", routeId: "route.b" });
  assert.deepEqual(result.rejected, [{ projectId: "project.a", workItemId: "work.a", routeId: "route.a", reasons: ["resource_unavailable"] }]);
});

test("CR6C produces a stable order and an honest no-eligible explanation", () => {
  const tied = [{ projectId: "project.b", workItemId: "work.b", routeId: "route.b", targetShare: 0, recentShareUsed: 0, priority: 1, queueAgeMinutes: 0, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0 }, { projectId: "project.a", workItemId: "work.a", routeId: "route.a", targetShare: 0, recentShareUsed: 0, priority: 1, queueAgeMinutes: 0, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0 }];
  assert.equal(chooseAllocationV1(tied).selected?.projectId, "project.a");
  assert.deepEqual(chooseAllocationV1([{ ...tied[0], exclusions: ["maintenance"] }]).explanation, ["No candidate satisfies the hard scheduling rules."]);
});

test("CR6C rejects malformed numeric inputs before they can distort scoring", () => {
  const candidate = { projectId: "project.a", workItemId: "work.a", routeId: "route.a", targetShare: 10, recentShareUsed: 0, priority: 1, queueAgeMinutes: 0, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0 };
  assert.deepEqual(chooseAllocationV1([{ ...candidate, estimatedCostUsd: Number.NaN }]).rejected[0]?.reasons, ["invalid_candidate"]);
  assert.deepEqual(chooseAllocationV1([{ ...candidate, queueAgeMinutes: -1 }]).rejected[0]?.reasons, ["invalid_candidate"]);
});

test("CR6C gives the oldest eligible work a hard starvation bound without bypassing exclusions", () => {
  const base = { targetShare: 0, recentShareUsed: 0, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0 };
  const result = chooseAllocationV1([
    { ...base, projectId: "project:new", workItemId: "work:new", routeId: "route:new", priority: 100, queueAgeMinutes: 1 },
    { ...base, projectId: "project:old", workItemId: "work:old", routeId: "route:old", priority: 0, queueAgeMinutes: STARVATION_BOUND_MINUTES_V1 },
    { ...base, projectId: "project:blocked", workItemId: "work:blocked", routeId: "route:blocked", priority: 0, queueAgeMinutes: STARVATION_BOUND_MINUTES_V1 * 2, exclusions: ["maintenance"] as const },
  ]);
  assert.equal(result.selected?.workItemId, "work:old");
  assert.match(result.explanation.join(" "), /starvation bound/i);
});

test("CR6C placement modes enforce ownership, preference, sharing, and draining before scoring", () => {
  const subject = { projectId: "project.borrower", workItemId: "work.1", routeId: "route.gpu" };
  assert.equal(placementRejectionV1(subject, { resourceKey: "gpu.1", mode: "exclusive", exclusiveProjectId: "project.owner" }), "exclusive_resource_owned");
  assert.equal(placementRejectionV1({ ...subject, projectId: "project.owner" }, { resourceKey: "gpu.1", mode: "exclusive", exclusiveProjectId: "project.owner" }), undefined);
  assert.equal(placementRejectionV1(subject, { resourceKey: "gpu.1", mode: "preferred", preferredProjectIds: ["project.owner"], projectsWithEligibleWaitingWork: ["project.owner"] }), "preferred_resource_reserved");
  assert.equal(placementRejectionV1(subject, { resourceKey: "gpu.1", mode: "preferred", preferredProjectIds: ["project.owner"], projectsWithEligibleWaitingWork: [] }), undefined);
  assert.equal(placementRejectionV1(subject, { resourceKey: "gpu.1", mode: "shared" }), undefined);
  assert.equal(placementRejectionV1(subject, { resourceKey: "gpu.1", mode: "shared", draining: true }), "resource_draining");
});

test("CR6C opportunistic and manual placement require explicit safe scheduling facts", () => {
  const subject = { projectId: "project.a", workItemId: "work.a", routeId: "route.a" };
  assert.equal(placementRejectionV1(subject, { resourceKey: "worker.a", mode: "opportunistic", normalEligibleWorkWaiting: true }), "opportunistic_work_deferred");
  assert.equal(placementRejectionV1(subject, { resourceKey: "worker.a", mode: "opportunistic", normalEligibleWorkWaiting: false }), undefined);
  assert.equal(placementRejectionV1(subject, { resourceKey: "worker.a", mode: "opportunistic" }), "invalid_candidate");
  assert.equal(placementRejectionV1(subject, { resourceKey: "worker.a", mode: "manual" }), "manual_assignment_required");
  assert.equal(placementRejectionV1(subject, { resourceKey: "worker.a", mode: "manual", manualAssignment: subject }), undefined);
  assert.equal(placementRejectionV1(subject, { resourceKey: "worker.a", mode: "manual", manualAssignment: { ...subject, workItemId: "work.other" } }), "manual_assignment_required");
});

test("CR6C allocation cannot score through a placement rejection", () => {
  const base = { targetShare: 100, recentShareUsed: 0, priority: 100, queueAgeMinutes: 10_000, downstreamUnlockCount: 10, deadlineRisk: 1, estimatedCostUsd: 0 };
  const result = chooseAllocationV1([
    { ...base, projectId: "project.borrower", workItemId: "work.blocked", routeId: "route.gpu", placement: { resourceKey: "gpu.1", mode: "exclusive", exclusiveProjectId: "project.owner" } },
    { ...base, targetShare: 0, priority: 0, queueAgeMinutes: 0, downstreamUnlockCount: 0, deadlineRisk: 0, projectId: "project.owner", workItemId: "work.allowed", routeId: "route.gpu", placement: { resourceKey: "gpu.1", mode: "exclusive", exclusiveProjectId: "project.owner" } },
  ]);
  assert.equal(result.selected?.workItemId, "work.allowed");
  assert.deepEqual(result.rejected, [{ projectId: "project.borrower", workItemId: "work.blocked", routeId: "route.gpu", reasons: ["exclusive_resource_owned"] }]);
});

test("CR6C evaluates cost, privacy, quality, deadlines, and resource state as hard constraints", () => {
  assert.deepEqual(evaluateSchedulingConstraintsV1({ cost: { estimatedMicrousd: 11, limitMicrousd: 10 } }), ["cost_limit_exceeded"]);
  assert.deepEqual(evaluateSchedulingConstraintsV1({ privacy: { privacyClass: "approved_provider", allowedPrivacyClasses: ["local", "private_tenant"] } }), ["privacy_denied"]);
  assert.deepEqual(evaluateSchedulingConstraintsV1({ quality: { observed: "provisional", minimum: "verified" } }), ["quality_insufficient"]);
  assert.deepEqual(evaluateSchedulingConstraintsV1({ deadline: { predictedFinishAt: "2026-08-28T00:01:00.000Z", deadlineAt: "2026-08-28T00:00:00.000Z", enforcement: "hard" } }), ["deadline_missed"]);
  assert.deepEqual(evaluateSchedulingConstraintsV1({ deadline: { predictedFinishAt: "2026-08-28T00:01:00.000Z", deadlineAt: "2026-08-28T00:00:00.000Z", enforcement: "soft" } }), []);
  assert.deepEqual(evaluateSchedulingConstraintsV1({ resourceState: "maintenance" }), ["maintenance"]);
  assert.deepEqual(evaluateSchedulingConstraintsV1({ resourceState: "draining" }), ["resource_draining"]);
});

test("CR6C constraint facts fail closed when malformed", () => {
  assert.deepEqual(evaluateSchedulingConstraintsV1({ cost: { estimatedMicrousd: -1, limitMicrousd: 10 } }), ["invalid_candidate"]);
  assert.deepEqual(evaluateSchedulingConstraintsV1({ privacy: { privacyClass: "local", allowedPrivacyClasses: [] } }), ["invalid_candidate"]);
  assert.deepEqual(evaluateSchedulingConstraintsV1({ deadline: { predictedFinishAt: "tomorrow", deadlineAt: "2026-08-28T00:00:00.000Z", enforcement: "hard" } }), ["invalid_candidate"]);
});

test("CR6C allocation cannot score through policy constraints", () => {
  const base = { targetShare: 100, recentShareUsed: 0, priority: 100, queueAgeMinutes: 10_000, downstreamUnlockCount: 10, deadlineRisk: 1, estimatedCostUsd: 0 };
  const result = chooseAllocationV1([
    { ...base, projectId: "project.denied", workItemId: "work.denied", routeId: "route.provider", constraints: { privacy: { privacyClass: "approved_provider", allowedPrivacyClasses: ["local"] } } },
    { ...base, targetShare: 0, priority: 0, queueAgeMinutes: 0, downstreamUnlockCount: 0, deadlineRisk: 0, projectId: "project.allowed", workItemId: "work.allowed", routeId: "route.local", constraints: { privacy: { privacyClass: "local", allowedPrivacyClasses: ["local"] } } },
  ]);
  assert.equal(result.selected?.workItemId, "work.allowed");
  assert.deepEqual(result.rejected, [{ projectId: "project.denied", workItemId: "work.denied", routeId: "route.provider", reasons: ["privacy_denied"] }]);
});

test("CR6C availability windows require complete interval coverage and enough declared capacity", () => {
  const base = { resourceKey: "gpu.zero", requestedFrom: "2026-08-27T01:00:00.000Z", requestedUntil: "2026-08-27T02:00:00.000Z", units: 1, windows: [{ startsAt: "2026-08-27T00:00:00.000Z", endsAt: "2026-08-27T03:00:00.000Z", capacityUnits: 1 }] };
  assert.equal(evaluateResourceAvailabilityV1(base).eligible, true);
  assert.equal(evaluateResourceAvailabilityV1({ ...base, requestedUntil: "2026-08-27T04:00:00.000Z" }).reason, "outside_availability_window");
  assert.equal(evaluateResourceAvailabilityV1({ ...base, units: 2 }).reason, "insufficient_window_capacity");
  assert.equal(evaluateResourceAvailabilityV1({ ...base, windows: [...base.windows, { ...base.windows[0], startsAt: "2026-08-27T02:00:00.000Z", endsAt: "2026-08-27T04:00:00.000Z" }] }).reason, "invalid_candidate");
});

test("CR6C allocation cannot score work outside a resource availability window", () => {
  const common = { targetShare: 0, recentShareUsed: 0, priority: 0, queueAgeMinutes: 0, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0 };
  const result = chooseAllocationV1([
    { ...common, priority: 100, projectId: "project.outside", workItemId: "work.outside", routeId: "route.gpu", availability: { resourceKey: "gpu.zero", requestedFrom: "2026-08-27T04:00:00.000Z", requestedUntil: "2026-08-27T05:00:00.000Z", units: 1, windows: [{ startsAt: "2026-08-27T00:00:00.000Z", endsAt: "2026-08-27T03:00:00.000Z", capacityUnits: 1 }] } },
    { ...common, projectId: "project.safe", workItemId: "work.safe", routeId: "route.cpu" },
  ]);
  assert.equal(result.selected?.workItemId, "work.safe");
  assert.deepEqual(result.rejected[0]?.reasons, ["outside_availability_window"]);
});

test("CR6C availability and placement facts must bind the same resource", () => {
  const result = chooseAllocationV1([{ projectId: "project.a", workItemId: "work.a", routeId: "route.a", targetShare: 0, recentShareUsed: 0, priority: 0, queueAgeMinutes: 0, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0,
    availability: { resourceKey: "gpu.one", requestedFrom: "2026-08-27T01:00:00.000Z", requestedUntil: "2026-08-27T02:00:00.000Z", units: 1, windows: [{ startsAt: "2026-08-27T00:00:00.000Z", endsAt: "2026-08-27T03:00:00.000Z", capacityUnits: 1 }] },
    placement: { resourceKey: "gpu.two", mode: "shared" } }]);
  assert.deepEqual(result.rejected[0]?.reasons, ["invalid_candidate"]);
});
