import assert from "node:assert/strict";
import test from "node:test";
import { parsePhaseRecord, parsePhaseRecords, compareDelegatedToDirect, readContributionMetrics,
  renderContributionMetrics, ROLES, COMPARABLE_GROUP_MINIMUM } from "../scripts/public-contribution-metrics.mjs";

const marker = payload => `Lead review phase.\n\n<!-- acr-contribution-metrics:v1 ${JSON.stringify(payload)} -->`;
const phase = (role, overrides = {}) => ({ schema: "acr-contribution-metrics:v1", role, model: "Lead/Planner",
  effort: "medium", activeMinutes: 20, inputTokens: 5000, outputTokens: 500, providerCalls: 2, interruptions: 0,
  startedAt: "2026-09-01T10:00:00.000Z", endedAt: "2026-09-01T10:20:00.000Z", issue: 10, pr: 11, interrupted: false,
  ...overrides });
const comment = body => ({ body, created_at: "2026-09-02T10:00:00.000Z" });
const labels = { labels: ["difficulty:intermediate", "size:feature-package", "risk:ordinary"] };

test("phase records parse completely and reject malformed values into unknown", () => {
  assert.deepEqual(parsePhaseRecord(marker(phase("lead-review"))).role, "lead-review");
  assert.equal(parsePhaseRecord(marker(phase("lead-review", { activeMinutes: null }))).activeMinutes, undefined);
  assert.equal(parsePhaseRecord("no marker here"), undefined);
  assert.equal(parsePhaseRecord(marker({ ...phase("lead-review"), role: "janitor" })), undefined);
  assert.equal(parsePhaseRecord(marker({ ...phase("lead-review"), model: "" })), undefined);
  assert.equal(parsePhaseRecord(marker({ ...phase("lead-review"), inputTokens: -3 })), undefined);
  assert.equal(parsePhaseRecord(marker({ ...phase("lead-review"), inputTokens: 2 ** 53 })), undefined);
  assert.equal(parsePhaseRecord(marker({ ...phase("lead-review"), activeMinutes: "soon" })), undefined);
  assert.equal(parsePhaseRecord(marker({ ...phase("lead-review"), startedAt: "not-a-date" })), undefined);
  assert.equal(parsePhaseRecord("<!-- acr-contribution-metrics:v1 {broken -->"), undefined);
  // One call reads the first marker; batch counting rejects multi-marker comments.
  assert.equal(parsePhaseRecord(marker(phase("lead-review")) + "\n" + marker(phase("lead-review"))).role, "lead-review");
  for (const role of ROLES) assert.ok(parsePhaseRecord(marker(phase(role))).role === role);
});

test("phase record batches count malformed markers without coercing them", () => {
  const { records, malformed } = parsePhaseRecords([
    comment(marker(phase("lead-review"))),
    comment(marker({ ...phase("lead-review"), inputTokens: -1 })),
    comment(marker(phase("lead-review")) + marker(phase("lead-review"))),
    comment("plain comment"),
  ]);
  assert.equal(records.length, 1);
  assert.equal(malformed, 2);
});

const claim = ms => ({ body: `CLAIM ACCEPTED — x.\n<!-- agent-control-room-claim:v3 issue=10 request=1 actor=a worker=w packet=p accepted=${ms} -->`,
  created_at: new Date(ms).toISOString() });
const handoff = (state, msValue) => ({ body: `Workflow handoff: complete\n\nWorker: w\nState: ${state}\nNext: reviewer\nReviewed/submitted commit: ${"a".repeat(40)}\nInstructions: u\n\n<!-- agent-control-room-handoff:v1 ${JSON.stringify({ issue: 10, pr: 11, workerId: "w", actor: "a", head: "a".repeat(40), state, action: "reviewer", acknowledged: false, requestId: 2, previousId: 0, claimId: 1, phase: "complete", reviewUrl: "u" })} -->`,
  created_at: new Date(msValue).toISOString() });
const workerBody = (model = "Worker/Sol", effort = "high") =>
  `Control-Room-Issue: 10\nWorker-Model: ${model}\nWorker-Effort: ${effort}\nWorker-Active-Minutes: 60\nWorker-Input-Tokens: 10000\nWorker-Output-Tokens: 2000\nWorker-Provider-Calls: 5\nWorker-Interruptions: 1`;
const T0 = Date.parse("2026-09-01T10:00:00.000Z");

function delegatedPull(overrides = {}) {
  return { number: 11, body: workerBody(), state: "closed", merged: true, correctionRounds: 0,
    created_at: new Date(T0 + 60_000).toISOString(), merged_at: new Date(T0 + 3_600_000).toISOString(),
    comments: [claim(T0), handoff("in-review", T0 + 120_000),
      comment(marker(phase("reviewer", { model: "Reviewer/Cap", activeMinutes: 10, inputTokens: 1000, outputTokens: 100 }))),
      comment(marker(phase("lead-packet", { issue: 10, pr: 11 }))),
      comment(marker(phase("lead-review", { issue: 10, pr: 11 }))),
      comment(marker(phase("lead-integration", { issue: 10, pr: 11 })))], ...overrides };
}

test("delegated totals stay unknown unless every phase source is known", () => {
  const issues = new Map([[10, labels]]);
  const pull = delegatedPull();
  const phaseRecords = parsePhaseRecords(pull.comments).records;
  const full = compareDelegatedToDirect({ pulls: [pull],
    issuesByNumber: issues, phaseRecords, nowMs: T0 + 7_200_000 });
  assert.equal(full[0].delegated.entries[0].totalTokens, 10000 + 2000 + 1000 + 100 + 5000 + 500 + 5000 + 500 + 5000 + 500);
  assert.equal(full[0].delegated.entries[0].activeMinutes, 60 + 10 + 20 + 20 + 20);
  assert.equal(full[0].verdict, "observations-only");
  // Missing reviewer phase: totals unknown, never partial sums.
  pull.comments = pull.comments.filter(comment => !comment.body.includes('"reviewer"'));
  const partial = compareDelegatedToDirect({ pulls: [pull], issuesByNumber: issues,
    phaseRecords: parsePhaseRecords(pull.comments).records, nowMs: T0 + 7_200_000 });
  assert.equal(partial[0].delegated.entries[0].totalTokens, undefined);
  assert.equal(partial[0].delegated.entries[0].activeMinutes, undefined);
});

test("direct builds land in their own bucket with lead-only costs", () => {
  const issues = new Map([[10, labels]]);
  const direct = { number: 11, body: "Control-Room-Issue: 10\nNo model reported.", state: "closed", merged: true,
    correctionRounds: 0, created_at: new Date(T0).toISOString(), merged_at: new Date(T0 + 1_800_000).toISOString(),
    comments: [claim(T0), comment(marker(phase("lead-direct", { activeMinutes: 45, inputTokens: 9000, outputTokens: 900 }))),
      comment(marker(phase("reviewer", { model: "Reviewer/Cap", activeMinutes: 5, inputTokens: 500, outputTokens: 50 }))) ] };
  const groups = compareDelegatedToDirect({ pulls: [direct], issuesByNumber: issues,
    phaseRecords: parsePhaseRecords(direct.comments).records, nowMs: T0 + 7_200_000 });
  assert.equal(groups[0].direct.accepted, 1);
  assert.equal(groups[0].delegated.accepted, 0);
  assert.equal(groups[0].direct.entries[0].totalTokens, 9900 + 550);
  assert.equal(groups[0].direct.entries[0].activeMinutes, 50);
});

test("five accepted outcomes per method unlock comparable per-100k signals", () => {
  const issues = new Map([[10, labels]]);
  const pulls = Array.from({ length: COMPARABLE_GROUP_MINIMUM }, () => delegatedPull());
  const recordsOf = list => parsePhaseRecords(list.flatMap(pull => pull.comments)).records;
  const small = compareDelegatedToDirect({ pulls: pulls.slice(0, 2), issuesByNumber: issues,
    phaseRecords: recordsOf(pulls.slice(0, 2)), nowMs: T0 + 7_200_000 });
  assert.equal(small[0].verdict, "observations-only");
  assert.equal(small[0].acceptedPer100kTokens, undefined);
  const directPull = { number: 12, body: "Control-Room-Issue: 10\nNo model reported.", state: "closed", merged: true,
    correctionRounds: 0, created_at: new Date(T0).toISOString(), merged_at: new Date(T0 + 1_800_000).toISOString(),
    comments: [claim(T0), comment(marker(phase("lead-direct", { pr: 12 })))] };
  const directs = Array.from({ length: COMPARABLE_GROUP_MINIMUM }, () => ({ ...directPull }));
  const full = compareDelegatedToDirect({ pulls: [...pulls, ...directs],
    issuesByNumber: issues, phaseRecords: recordsOf([...pulls, ...directs]), nowMs: T0 + 7_200_000 });
  assert.equal(full[0].verdict, "comparable");
  assert.equal(full[0].acceptedPer100kTokens.length, 2);
  assert.ok(full[0].acceptedPer100kTokens.every(entry => entry.accepted === COMPARABLE_GROUP_MINIMUM));
});

test("open, interrupted and truncated histories render honestly", async () => {
  const openPull = { number: 12, body: workerBody(), state: "open", merged_at: null,
    created_at: new Date(T0).toISOString() };
  const fetchImpl = async url => ({ ok: true, status: 200, async json() {
    if (url.includes("/pulls?")) return [openPull];
    if (url.includes("/issues/comments?")) return [{ ...claim(T0), issue_url: "https://api.github.com/repos/o/r/issues/10" }];
    return [{ number: 10, labels: labels.labels.map(name => ({ name })) }];
  } });
  const report = await readContributionMetrics({ repository: "o/r", fetchImpl });
  assert.equal(report.comparison.length, 0);
  assert.match(renderContributionMetrics(report), /self-reported/i);
  assert.match(renderContributionMetrics(report), /never active model time/i);
  // Truncated history is flagged, never silently completed.
  const many = Array.from({ length: 100 }, (_, index) => ({ number: index }));
  const truncated = await readContributionMetrics({ repository: "o/r",
    fetchImpl: async url => ({ ok: true, status: 200, async json() { return many; } }) });
  assert.equal(truncated.uncertainty.truncated, true);
  assert.match(renderContributionMetrics(truncated), /truncated/i);
  // Malformed markers are counted and warned about.
  const bad = await readContributionMetrics({ repository: "o/r", fetchImpl: async url => ({ ok: true, status: 200,
    async json() {
      if (url.includes("/pulls?")) return [];
      if (url.includes("/issues/comments?")) return [{ body: marker({ role: "lead-review" }), issue_url: "https://api.github.com/repos/o/r/issues/1" }];
      return [];
    } }) });
  assert.equal(bad.malformedPhaseRecords, 1);
  assert.match(renderContributionMetrics(bad), /malformed/i);
});

test("interrupted phases keep their flag and counts", () => {
  const record = parsePhaseRecord(marker(phase("worker", { model: "Worker/Sol", interrupted: true, interruptions: 2 })));
  assert.equal(record.interrupted, true);
  assert.equal(record.interruptions, 2);
});
