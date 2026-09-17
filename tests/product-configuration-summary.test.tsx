import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PRODUCT_CONFIGURATION_SCHEMA_V1, type ProductConfigurationV1 } from "../src/config/v1/product-configuration";
import { ProductConfigurationSummary } from "../private-app/app/product-configuration-summary";
import { parseOperatorSurfaceSnapshotV1, operatorSurfaceSnapshotSchemaV1 } from "../src/operator-surfaces/v1/validators";
import { OPERATOR_SURFACES_CONTRACT_V1, type OperatorSurfaceSnapshotV1 } from "../src/operator-surfaces/v1/types";
import { COMPARABLE_MINIMUM_V1, projectOperatorCapacityViewV1, summarizeReportedModelOutcomesV1,
  type ReportedModelOutcomeRecordV1 } from "../src/web/v1/operator-capacity-browser-client";
import { OperatorCapacityWorkspace } from "../private-app/app/operator-capacity-workspace";

const configuration: ProductConfigurationV1 = {
  schema: PRODUCT_CONFIGURATION_SCHEMA_V1, displayName: "Research Room", defaultTimezone: "America/Denver",
  modules: { ideaLab: true, news: false, sessionObservations: true },
  limits: { maxProjects: 24, maxTasksPerProject: 200, maxResultsPerTask: 20, maxArticleSources: 10, maxIdeaParticipants: 8 },
  projectTemplates: [{ id: "research", displayName: "Research", enabledModules: ["ideaLab"] }],
};

test("settings configuration names supplied portable values and their non-authority boundary", () => {
  const html = renderToStaticMarkup(createElement(ProductConfigurationSummary, { configuration }));
  for (const text of ["Research Room", "America/Denver", "Idea Lab", "Session observations", "Research", "Tasks per project", "200"])
    assert.match(html, new RegExp(text));
  assert.match(html, /read-only here/);
  assert.match(html, /do not grant authority/);
  assert.doesNotMatch(html, /password|api key|secret key/i);
});

test("settings does not invent configuration when the protected read is unavailable", () => {
  const html = renderToStaticMarkup(createElement(ProductConfigurationSummary));
  assert.match(html, /No portable presentation configuration is currently available/);
  assert.match(html, /never substitutes a saved, sample, or private configuration/);
  assert.doesNotMatch(html, /Research Room/);
});

// The operator capacity view reuses the server-bound operator projection. The
// fixtures below are validated by that surface's own schema in the first test,
// so a fixture that drifts away from the canonical wire shape fails here rather
// than silently proving the projection against invented data.
function operatorSnapshot(overrides: Partial<OperatorSurfaceSnapshotV1> = {}): OperatorSurfaceSnapshotV1 {
  return {
    contractVersion: OPERATOR_SURFACES_CONTRACT_V1, tenantId: "tenant-a", generatedAt: "2026-09-17T01:00:00.000Z",
    fleet: [
      { workerId: "worker-a", platform: "windows", state: "busy", lastObservedAt: "2026-09-17T00:58:00.000Z",
        capacityState: "reported", availableSlots: 1, totalSlots: 2, capabilityState: "verified", telemetryState: "fresh" },
      { workerId: "worker-b", platform: "linux", state: "idle", lastObservedAt: "2026-09-16T22:00:00.000Z",
        capacityState: "reported", availableSlots: 3, totalSlots: 3, capabilityState: "unavailable", telemetryState: "stale" },
    ],
    bottlenecks: [{ resourceKey: "windows-worker", utilizationPercent: 75, blockedWorkItemIds: ["job-9"],
      explanation: "One worker with one free slot is the only Windows route." }],
    activeWork: [
      { jobId: "job-1", projectId: "project-a", state: "running", jobType: "agent_task", priority: 1, requiredCapability: "windows", updatedAt: "2026-09-17T00:57:00.000Z" },
      { jobId: "job-2", projectId: "project-a", state: "leased", jobType: "agent_task", priority: 1, requiredCapability: "windows", updatedAt: "2026-09-17T00:57:00.000Z" },
      { jobId: "job-3", projectId: "project-a", state: "waiting_approval", jobType: "agent_task", priority: 2, requiredCapability: "linux", updatedAt: "2026-09-17T00:56:00.000Z" },
    ],
    portfolio: [], services: [], schedules: [], serviceIncidents: [],
    actionInbox: [
      { id: "attention-1", tenantId: "tenant-a", kind: "review", state: "open", requestedAction: "review", reasonCode: "review_due",
        blockedWorkItemIds: ["job-1"], legalResponses: [{ id: "response-1", kind: "request_review", label: "Request review", requiresConfirmation: false, available: true }],
        evidence: [], createdAt: "2026-09-16T22:30:00.000Z", deliveryState: "not_requested" },
      { id: "attention-2", tenantId: "tenant-a", kind: "review", state: "resolved", requestedAction: "review", reasonCode: "review_due",
        blockedWorkItemIds: [], legalResponses: [{ id: "response-2", kind: "record_decision", label: "Record decision", requiresConfirmation: true, available: true }],
        evidence: [], createdAt: "2026-09-16T20:00:00.000Z", deliveryState: "not_requested" },
    ],
    ownerFocus: [],
    ...overrides,
  };
}

test("operator capacity fixture is a canonical operator surface snapshot", () => {
  const parsed = parseOperatorSurfaceSnapshotV1(operatorSnapshot());
  assert.equal(parsed.tenantId, "tenant-a");
  assert.equal(parsed.fleet.length, 2);
  // A reported-but-slotless worker is refused by the surface's own schema, which
  // is why the projection can treat missing slot counts as unavailable.
  assert.throws(() => operatorSurfaceSnapshotSchemaV1.parse(operatorSnapshot({
    fleet: [{ ...operatorSnapshot().fleet[0], availableSlots: undefined, totalSlots: undefined }],
  })));
});

test("operator capacity view measures only attributable observations and excludes the rest", () => {
  const view = projectOperatorCapacityViewV1({ snapshot: operatorSnapshot() });
  assert.equal(view.capacity.evidence, "measured");
  assert.deepEqual(view.capacity.evidence === "measured" ? view.capacity.value : undefined,
    { availableSlots: 1, totalSlots: 2, reportingWorkers: 1 });
  // The stale row's three free slots are never folded into the measured total.
  assert.deepEqual(view.excluded.notFresh, { count: 1, workerIds: ["worker-b"] });
  assert.deepEqual(view.excluded.unattributed, { count: 0, workerIds: [] });
  // Staleness is not an attribution failure: worker-b does report its own capacity.
  assert.equal(view.workers[1].attribution, "self_reported");
  assert.deepEqual(view.workers[1].capacity, { evidence: "unavailable", reasonCode: "observation_stale" });
  assert.deepEqual(view.workers[0].capacity, { evidence: "measured", value: { availableSlots: 1, totalSlots: 2 } });
});

test("a worker row that reports no capacity of its own is excluded and named, never folded in", () => {
  const base = operatorSnapshot();
  const snapshot = operatorSnapshot({ fleet: [
    base.fleet[0],
    { ...base.fleet[1], capacityState: "unavailable", availableSlots: undefined, totalSlots: undefined },
  ] });
  // The unattributed fixture is still a canonical snapshot, so this is a real
  // wire shape rather than a hand-built object the schema would refuse.
  assert.equal(parseOperatorSurfaceSnapshotV1(snapshot).fleet.length, 2);
  const view = projectOperatorCapacityViewV1({ snapshot });
  assert.equal(view.workers[1].attribution, "unattributed");
  assert.deepEqual(view.workers[1].capacity, { evidence: "unavailable", reasonCode: "not_reported" });
  assert.deepEqual(view.excluded.unattributed, { count: 1, workerIds: ["worker-b"] });
  assert.deepEqual(view.excluded.notFresh, { count: 0, workerIds: [] });
  // One free slot is counted, not one plus the three the unattributed row claims.
  assert.deepEqual(view.capacity.evidence === "measured" ? view.capacity.value : undefined,
    { availableSlots: 1, totalSlots: 2, reportingWorkers: 1 });
  const html = renderToStaticMarkup(createElement(OperatorCapacityWorkspace, { view }));
  assert.match(html, /excluded from every total because that row reports no capacity of its own/);
  assert.match(html, /no capacity reported by this row/);
  assert.match(html, /Every self-reported row is inside the freshness window/);
});

test("an empty fleet never claims that every row reported its capacity", () => {
  const view = projectOperatorCapacityViewV1({ snapshot: operatorSnapshot({ fleet: [] }) });
  assert.deepEqual(view.excluded, { unattributed: { count: 0, workerIds: [] }, notFresh: { count: 0, workerIds: [] } });
  const html = renderToStaticMarkup(createElement(OperatorCapacityWorkspace, { view }));
  assert.match(html, /No worker row is recorded, so no capacity total is shown/);
  assert.doesNotMatch(html, /Every worker row reports its own capacity/);
  assert.doesNotMatch(html, /Every self-reported row is inside the freshness window/);
});

test("operator capacity view keeps measured, inferred and unavailable sections apart", () => {
  const view = projectOperatorCapacityViewV1({ snapshot: operatorSnapshot() });
  assert.deepEqual(view.activeWork.evidence === "measured" ? view.activeWork.value : undefined, { leased: 1, running: 1, waitingApproval: 1 });
  assert.equal(view.reviewDelay.evidence, "measured");
  assert.deepEqual(view.reviewDelay.evidence === "measured" ? view.reviewDelay.value : undefined,
    { openReviews: 1, oldestCreatedAt: "2026-09-16T22:30:00.000Z" });
  assert.equal(view.idle.evidence, "inferred");
  assert.deepEqual(view.idle.evidence === "inferred" ? view.idle.value : undefined, { idleWorkers: 1 });
  assert.equal(view.queuePressure.evidence, "inferred");
  assert.equal(view.queuePressure.evidence === "inferred" ? view.queuePressure.value[0].resourceKey : undefined, "windows-worker");
  // No worker reports capacity in this snapshot, so the total stays unavailable
  // and names the reason instead of showing a zero.
  const empty = projectOperatorCapacityViewV1({ snapshot: operatorSnapshot({ fleet: [] }) });
  assert.deepEqual(empty.capacity, { evidence: "unavailable", reasonCode: "not_reported" });
  assert.deepEqual(empty.idle, { evidence: "unavailable", reasonCode: "observation_missing" });
});

test("the oldest open review time is reported only when every open review records one", () => {
  const base = operatorSnapshot();
  const partial = projectOperatorCapacityViewV1({ snapshot: operatorSnapshot({ actionInbox: [
    { ...base.actionInbox[0], createdAt: "" },
    { ...base.actionInbox[1], state: "open" as const },
  ] }) });
  assert.equal(partial.reviewDelay.evidence, "measured");
  assert.equal(partial.reviewDelay.evidence === "measured" ? partial.reviewDelay.value.openReviews : undefined, 2);
  // The oldest of a subset is never presented as the oldest overall.
  assert.equal(partial.reviewDelay.evidence === "measured" ? partial.reviewDelay.value.oldestCreatedAt : undefined, undefined);
  const html = renderToStaticMarkup(createElement(OperatorCapacityWorkspace, { view: partial }));
  assert.match(html, /No oldest open review time is reported, so no delay is claimed/);
});

test("operator capacity view is read-only and grants no authority", () => {
  const view = projectOperatorCapacityViewV1({ snapshot: operatorSnapshot() });
  assert.deepEqual(view.boundary, { readOnly: true, canAssign: false, canSchedule: false, canAuthorize: false });
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.boundary), true);
  assert.equal(view.schema, "control-room-operator-capacity-view/v1");
  assert.equal(view.freshnessMinutes, 30);
  // The rendered panel offers no control at all: no form, input or button exists in
  // static markup unless the caller supplies the read-retry handler, so the view
  // cannot offer an operation that assigns, reserves or authorizes work.
  const html = renderToStaticMarkup(createElement(OperatorCapacityWorkspace, { view }));
  assert.doesNotMatch(html, /<button|<form|<input|<select|<textarea/);
});

test("model and effort outcomes summarize only the fields every counted sample reports", () => {
  const reported = (index: number, overrides: Partial<ReportedModelOutcomeRecordV1> = {}): ReportedModelOutcomeRecordV1 => ({
    model: "reported-model", effort: "medium", reworkCount: index % 2, rejected: index === 0,
    elapsedMinutes: 10 + index, inputTokens: 100 * (index + 1), outputTokens: 50 * (index + 1), costMicrousd: 1_000, ...overrides });
  const complete = summarizeReportedModelOutcomesV1(Array.from({ length: COMPARABLE_MINIMUM_V1 }, (_, index) => reported(index)));
  assert.equal(complete.evidence, "measured");
  const summary = complete.evidence === "measured" ? complete.value : undefined;
  assert.equal(summary?.samples, COMPARABLE_MINIMUM_V1);
  assert.equal(summary?.comparable, true);
  assert.equal(summary?.reworkRate, 0.4);
  assert.equal(summary?.reworkRounds, 2);
  assert.equal(summary?.rejectionRate, 0.2);
  assert.equal(summary?.medianElapsedMinutes, 12);
  assert.equal(summary?.inputTokens, 1_500);
  assert.equal(summary?.outputTokens, 750);
  assert.equal(summary?.costMicrousd, 5_000);
  assert.deepEqual(summary?.unreported, []);

  // Token counts are reported by one sample only: the summary never scales a
  // partial figure up to the sample count, it names the field as unreported.
  const partial = summarizeReportedModelOutcomesV1(Array.from({ length: COMPARABLE_MINIMUM_V1 }, (_, index) =>
    reported(index, { inputTokens: index === 0 ? 900 : undefined, outputTokens: undefined })));
  const partialSummary = partial.evidence === "measured" ? partial.value : undefined;
  assert.equal(partialSummary?.inputTokens, undefined);
  assert.equal(partialSummary?.outputTokens, undefined);
  assert.deepEqual(partialSummary?.unreported, ["inputTokens", "outputTokens"]);
  assert.equal(partialSummary?.medianElapsedMinutes, 12);

  // One sample reporting three rework rounds is one reworked sample, not three:
  // the rate is the share of counted samples and the rounds stay raw.
  const rounds = summarizeReportedModelOutcomesV1(Array.from({ length: COMPARABLE_MINIMUM_V1 },
    (_, index) => reported(index, { reworkCount: index === 0 ? 3 : 0 })));
  const roundsSummary = rounds.evidence === "measured" ? rounds.value : undefined;
  assert.equal(roundsSummary?.reworkRate, 0.2);
  assert.equal(roundsSummary?.reworkRounds, 3);
});

test("a reported effort of unknown counts, a misspelled effort is dropped rather than guessed", () => {
  // `scripts/public-model-outcomes.mjs` lists `unknown` in its effort vocabulary, so
  // an explicitly reported `unknown` is a reported effort; a value outside the
  // vocabulary is not counted at all, so no model is credited with a guessed effort.
  const unknown = summarizeReportedModelOutcomesV1([{ model: "reported-model", effort: "unknown" }]);
  assert.equal(unknown.evidence, "measured");
  assert.equal(unknown.evidence === "measured" ? unknown.value.samples : undefined, 1);
  const padded = summarizeReportedModelOutcomesV1([{ model: "reported-model", effort: " High " }]);
  assert.equal(padded.evidence === "measured" ? padded.value.samples : undefined, 1);
  assert.deepEqual(summarizeReportedModelOutcomesV1([{ model: "reported-model", effort: "turbo" }]),
    { evidence: "unavailable", reasonCode: "evidence_not_served" });
});

test("model and effort outcomes below the sample floor are observations without a winner", () => {
  const below = summarizeReportedModelOutcomesV1([
    { model: "reported-model", effort: "low" }, { model: "reported-model", effort: "high" }, { model: "reported-model", effort: "medium" },
  ]);
  const summary = below.evidence === "measured" ? below.value : undefined;
  assert.equal(summary?.samples, 3);
  assert.equal(summary?.comparable, false);
  assert.equal(summary?.reworkRate, undefined);
  assert.deepEqual(summary?.unreported, ["reworkCount", "rejected", "elapsedMinutes", "inputTokens", "outputTokens", "costMicrousd"]);
  // Unreported and empty model names are not counted as samples at all.
  assert.deepEqual(summarizeReportedModelOutcomesV1([{ model: "", effort: "low" }]),
    { evidence: "unavailable", reasonCode: "evidence_not_served" });
});

test("operator capacity workspace renders evidence classes, text alternatives and the non-authority boundary", () => {
  const view = projectOperatorCapacityViewV1({ snapshot: operatorSnapshot(), modelOutcomeEvidence: [
    { model: "reported-model", effort: "medium", reworkCount: 0, rejected: false, elapsedMinutes: 12, costMicrousd: 1_000 }] });
  const html = renderToStaticMarkup(createElement(OperatorCapacityWorkspace, { view }));
  for (const text of ["Operator capacity", "measured from the source records", "inferred — ", "excluded from every total",
    "Open reviews awaiting an owner", "Model and effort outcomes", "Neither reported nor comparable: inputTokens",
    "Reported rework rounds", "A rate is the share of counted samples that reported it",
    "Freshness is not an attribution failure",
    "below the 5-sample floor, so these are observations without a winner",
    "does not schedule, assign, reserve or authorize work", "windows-worker", "worker-b"])
    assert.match(html, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /aria-labelledby="operator-capacity-title"/);
  assert.match(html, /<time dateTime="2026-09-17T01:00:00.000Z"/);
  // Text alternatives only: no image, no fixed-width table, no control at all.
  assert.doesNotMatch(html, /<img|<table|<button|<form|<input/);
  assert.doesNotMatch(html, /undefined|\bNaN\b/);
});

test("operator capacity workspace shows no figures when the read is unavailable", () => {
  const html = renderToStaticMarkup(createElement(OperatorCapacityWorkspace, { unavailableCode: "operator_surface_unavailable" }));
  assert.match(html, /No sample or saved capacity figures are substituted here/);
  assert.match(html, /never schedules, assigns, reserves or authorizes work/);
  assert.doesNotMatch(html, /Measured|measured from the source records|worker-a/);
  const blank = renderToStaticMarkup(createElement(OperatorCapacityWorkspace, {}));
  assert.match(blank, /No operator capacity view is currently available to this page/);
  assert.match(blank, /Nothing here is estimated, sampled or carried over from an earlier read/);
  // The only control the panel ever offers is the read retry, and only when the
  // caller supplies it; it can re-read, not act.
  assert.equal((blank.match(/<button/g) ?? []).length, 0);
  const retry = renderToStaticMarkup(createElement(OperatorCapacityWorkspace, { unavailableCode: "request_failed", onRetry: () => {} }));
  assert.equal((retry.match(/<button/g) ?? []).length, 1);
  assert.match(retry, /<button type="button"/);
});