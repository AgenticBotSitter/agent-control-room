import assert from "node:assert/strict";
import test from "node:test";
import { parseReportedMetrics, median, addCounts, summarizeIssueCycleTimes, renderDuration,
  parseReportedModel, readModelOutcomes, renderModelOutcomes, summarizeModelOutcomes } from "../scripts/public-model-outcomes.mjs";

const body = (model, effort = "medium") => `Control-Room-Issue: 10\nWorker-Model: ${model}\nWorker-Effort: ${effort}`;
const correction = head => ({ body: `CHANGES REQUIRED at exact head ${head}.` });

test("model and effort require exactly one bounded report", () => {
  assert.deepEqual(parseReportedModel(body("OpenAI/Sol", "high")), { model: "OpenAI/Sol", effort: "high", valid: true });
  assert.equal(parseReportedModel("Worker-Model: A\nWorker-Model: B\nWorker-Effort: high").model, "unreported");
  assert.deepEqual(parseReportedModel("Worker-Model: A\nWorker-Effort: enormous"), { model: "A", effort: "unknown", valid: false });
});

test("outcomes count unique corrected heads and keep open work distinct", () => {
  const head = "a".repeat(40);
  const rows = summarizeModelOutcomes([
    { body: body("OpenAI/Sol", "high"), merged: true, state: "closed", comments: [] },
    { body: body("OpenAI/Sol", "high"), merged: true, state: "closed", comments: [correction(head), correction(head)] },
    { body: body("Anthropic/Opus", "medium"), merged: false, state: "open", comments: [correction("b".repeat(40))] },
  ]);
  assert.deepEqual(rows[0], { model: "OpenAI/Sol", effort: "high", submissions: 2, merged: 2, open: 0,
    closedWithoutMerge: 0, correctionRequested: 1, correctionRounds: 1, firstPassMerges: 1,
    invalidOrMissingReport: 0, activeMinutes: [], activeMinutesUnknown: 2, activeMinutesMedian: undefined,
    inputTokens: 0, inputTokensUnknown: 2, outputTokens: 0, outputTokensUnknown: 2,
    providerCallsUnknown: 2, interruptionsUnknown: 2, mergeRate: 1, correctionRate: 0.5 });
  assert.equal(rows[1].open, 1);
});

test("worker cost fields stay unknown unless exactly one valid value is reported", () => {
  const full = "Control-Room-Issue: 1\nWorker-Active-Minutes: 12.5\nWorker-Input-Tokens: 100\nWorker-Output-Tokens: 20\nWorker-Provider-Calls: 3\nWorker-Interruptions: 0";
  assert.deepEqual(parseReportedMetrics(full),
    { activeMinutes: 12.5, inputTokens: 100, outputTokens: 20, providerCalls: 3, interruptions: 0 });
  assert.deepEqual(parseReportedMetrics("Control-Room-Issue: 1"),
    { activeMinutes: undefined, inputTokens: undefined, outputTokens: undefined, providerCalls: undefined, interruptions: undefined });
  // Duplicated, negative, non-numeric and overflowed values are unknown, never coerced.
  assert.equal(parseReportedMetrics("Worker-Input-Tokens: 1\nWorker-Input-Tokens: 2").inputTokens, undefined);
  assert.equal(parseReportedMetrics("Worker-Input-Tokens: -5").inputTokens, undefined);
  assert.equal(parseReportedMetrics("Worker-Input-Tokens: 1.5").inputTokens, undefined);
  assert.equal(parseReportedMetrics(`Worker-Input-Tokens: ${2 ** 53}`).inputTokens, undefined);
  assert.equal(parseReportedMetrics("Worker-Active-Minutes: soon").activeMinutes, undefined);
  assert.equal(parseReportedMetrics("Worker-Active-Minutes: -1").activeMinutes, undefined);
  // Medians use known values only; sums never wrap into guessed totals.
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), undefined);
  assert.equal(addCounts(1, 2, 3), 6);
  assert.equal(addCounts(1, undefined), undefined);
  assert.equal(addCounts(Number.MAX_SAFE_INTEGER, 1), undefined);
});

test("cycle times measure GitHub timestamps and attribute current waiting honestly", () => {
  const T0 = Date.parse("2026-09-01T10:00:00.000Z");
  const at = ms => new Date(ms).toISOString();
  const claim = { body: `CLAIM ACCEPTED — x.\n<!-- agent-control-room-claim:v3 issue=10 request=1 actor=a worker=w packet=p accepted=${T0} -->`, created_at: at(T0) };
  const submit = { body: `Workflow handoff: complete\n\nWorker: w\nState: in-review\nNext: reviewer\nReviewed/submitted commit: ${"a".repeat(40)}\nInstructions: u\n\n<!-- agent-control-room-handoff:v1 {"issue":10,"pr":11,"workerId":"w","actor":"a","head":"${"a".repeat(40)}","state":"in-review","action":"reviewer","acknowledged":false,"requestId":2,"previousId":0,"claimId":1,"phase":"complete","reviewUrl":"u"} -->`, created_at: at(T0 + 600_000) };
  const pull = { body: "Control-Room-Issue: 10\nWorker-Model: M\nWorker-Effort: low", state: "closed",
    created_at: at(T0 + 60_000), merged_at: at(T0 + 3_600_000), comments: [claim, submit] };
  const full = summarizeIssueCycleTimes([pull], new Map(), T0 + 7_200_000);
  assert.equal(full.outcomes[0].claimToFirstPrMs, 60_000);
  assert.equal(full.outcomes[0].claimToMergeMs, 3_600_000);
  assert.equal(full.outcomes[0].submitToDecisionMs, undefined);
  assert.equal(full.outcomes[0].waitingOwner, "none");
  assert.equal(full.aggregate.claimToMerge.medianMs, 3_600_000);
  // Open work with no events after the claim waits on the worker.
  const open = summarizeIssueCycleTimes(
    [{ body: "Control-Room-Issue: 11\nWorker-Model: M\nWorker-Effort: low", state: "open", comments: [claim] }],
    new Map([[11, { labels: ["status:working"] }]]), T0 + 3_600_000);
  assert.equal(open.outcomes[0].waitingOwner, "worker");
  assert.equal(open.outcomes[0].waitingMs, 3_600_000);
  assert.equal(renderDuration(90_000), "1.5m");
  assert.equal(renderDuration(undefined), "unknown");
});

test("GitHub read is bounded, read-only and renders its limits honestly", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const values = url.includes("/pulls?")
      ? [{ number: 1, body: body("OpenAI/Terra"), state: "closed", merged_at: "now" }] : [];
    return { ok: true, status: 200, async json() { return structuredClone(values); } };
  };
  const report = await readModelOutcomes({ repository: "owner/repo", fetchImpl });
  assert.equal(report.rows[0].merged, 1);
  assert.ok(calls.every(call => !call.options.method || call.options.method === "GET"));
  assert.match(renderModelOutcomes(report), /self-reported/i);
  assert.match(renderModelOutcomes(report), /not a general model-quality ranking/i);
});

test("issue-side correction records are attributed to the pull request model", async () => {
  const issueUrl = "https://api.github.com/repos/owner/repo/issues/10";
  const fetchImpl = async url => ({ ok: true, status: 200, async json() {
    if (url.includes("/pulls?")) return [{ number: 7, body: body("OpenAI/Astra", "xhigh"), state: "open",
      merged_at: null }];
    return [{ ...correction("c".repeat(40)), issue_url: issueUrl }];
  } });
  const report = await readModelOutcomes({ repository: "owner/repo", fetchImpl });
  assert.equal(report.rows[0].correctionRequested, 1);
  assert.equal(report.rows[0].correctionRounds, 1);
});
