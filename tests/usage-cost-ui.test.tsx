import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunPanel } from "../private-app/app/task-panels";
import { ProjectOverviewActivityView } from "../private-app/app/project-overview-activity";
import type { TaskRun } from "../src/web/v1/task-wire";

const baseRun: TaskRun = { runId: "run:usage", harness: "codex", model: "gpt-fixture", effort: "high",
  state: "succeeded", lastObservedAt: "2026-09-28T00:00:01.000Z", stale: false,
  firstObservedExecutionAt: "2026-09-28T00:00:00.000Z", finishedObservedAt: "2026-09-28T00:00:01.000Z",
  cancellation: "not_requested", source: "legacy", nativeState: null, availability: null,
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, wallTimeMs: 1000 },
  cost: { kind: "unknown", reason: "price_entry_not_recorded" }, resultClaim: null, timeline: [], earlierObservationsOmitted: false };

test("run UI states an honest unknown reason and subscription billing", () => {
  const unknown = renderToStaticMarkup(<RunPanel run={baseRun} />);
  assert.match(unknown, /Input tokens/); assert.match(unknown, />100</); assert.match(unknown, /Output tokens/);
  assert.match(unknown, /Cost unknown — the recorded price table has no matching model entry/);
  const included = renderToStaticMarkup(<RunPanel run={{ ...baseRun,
    cost: { kind: "included_in_subscription", priceEntryId: "flat-plan", tableId: "owner-prices" } }} />);
  assert.match(included, /Included in subscription/); assert.doesNotMatch(included, /estimated/i);
});

test("project UI shows exact mixed billing rollup and owner-visible table identity", () => {
  const html = renderToStaticMarkup(<ProjectOverviewActivityView projectId="project:test" state={{ state: "ready", value: {
    projectId: "project:test", current: [], awaitingReview: [], recent: [], additionalCurrentOmitted: false,
    additionalReviewsOmitted: false, additionalRecentOmitted: false, observedAt: "2026-09-28T00:00:00.000Z", startsWork: false,
    usageRollup: { runs: 3, inputTokens: null, outputTokens: null, totalTokens: null, wallTimeMs: 1750,
      knownCostNanoUsd: "325000", knownCostRuns: 1, subscriptionRuns: 1, unknownCostRuns: 1,
      unknownCostReasons: ["usage_not_reported"] },
    priceTable: { state: "recorded", tableId: "owner-prices", recordedAt: "2026-09-28T00:00:00.000Z" },
  } }} />);
  assert.match(html, /Project usage and cost/); assert.match(html, /1 run\(s\) included in subscription/);
  assert.match(html, /owner-prices/); assert.match(html, /Unknown cost/);
});


test("M3-COST-01: the project displays an exact decimal token and wall-time aggregate", () => {
  const html = renderToStaticMarkup(<ProjectOverviewActivityView projectId="project:test" state={{ state: "ready", value: {
    projectId: "project:test", current: [], awaitingReview: [], recent: [], additionalCurrentOmitted: false,
    additionalReviewsOmitted: false, additionalRecentOmitted: false, observedAt: "2026-10-01T00:00:00.000Z", startsWork: false,
    usageRollup: { runs: 2, inputTokens: "9007199254740993", outputTokens: "9007199254740993",
      totalTokens: "18014398509481986", wallTimeMs: "9007199254740993", knownCostNanoUsd: "9007199254740993",
      knownCostRuns: 2, subscriptionRuns: 0, unknownCostRuns: 0, unknownCostReasons: [] },
    priceTable: { state: "not_recorded", tableId: null, recordedAt: null },
  } }} />);
  assert.match(html, /9007199254740993/);
  assert.doesNotMatch(html, /9007199254740992/);
});
