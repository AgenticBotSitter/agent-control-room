import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_PAGES, DEFAULT_ADVISORY_LOGINS, READY_FLOOR, STATUSES,
  declaredSubmissionIssue, parseClaimMarker, readQueueHealth, renderQueueHealth, renderQueueHealthJson,
} from "../scripts/public-queue-health.mjs";

const issue = (number, labels, updated_at = "2026-09-14T10:00:00Z") => ({
  number, title: `Issue ${number}`, html_url: `https://github.example/issues/${number}`,
  state: "open", updated_at, labels: labels.map(name => ({ name })),
});
const comment = (body, association = "MEMBER", login = "trusted-maintainer", type = "User") => ({
  body, author_association: association, user: { login, type },
});
// Only the serialized controller posts authoritative transition records.
const controllerComment = body => comment(body, "NONE", "github-actions[bot]", "Bot");
const handoff = (issue, state, worker = "worker:test-01", action = "worker") => ({
  issue, requestId: 1, phase: "complete", workerId: worker, state, action,
  head: "a".repeat(40), reviewUrl: `https://github.example/issues/${issue}`,
});
const handoffMarker = record => `Workflow handoff\n\n<!-- agent-control-room-handoff:v1 ${JSON.stringify(record)} -->`;
// The repository's own submission convention: a pull request names the issue it delivers.
const pull = (number, declares, { state = "open", merged = false, body } = {}) => ({
  number, state, merged_at: merged ? "2026-09-14T00:00:00Z" : null,
  html_url: `https://github.example/pull/${number}`,
  body: body ?? `Outcome / issue: #${declares} — delivered\nStarting commit / submitted commit: abc`,
});
const actionMarker = (worker, state, number) =>
  `ACTION REQUIRED\n<!-- agent-control-room-action:v1 worker=${worker} state=${state} issue=${number} -->`;
const claimMarker = (number, worker) =>
  `CLAIM ACCEPTED — reserved\n<!-- agent-control-room-claim:v2 issue=${number} request=1 actor=maintainer worker=${worker} -->\n<!-- agent-control-room-claim:v3 issue=${number} request=1 actor=maintainer worker=${worker} packet=${"a".repeat(64)} accepted=1700000000000 -->`;
const ready = (number, updated) => issue(number, ["status:ready", "help wanted"], updated);

function fakeFetch({ issues = [], comments = {}, pulls = [] } = {}) {
  const calls = [];
  const ok = value => ({ ok: true, status: 200, async json() { return structuredClone(value); } });
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes("/issues?")) return ok(issues);
    if (url.includes("/pulls?")) return ok(pulls);
    const commentsMatch = /\/issues\/(\d+)\/comments/.exec(url);
    if (commentsMatch) return ok(comments[Number(commentsMatch[1])] ?? []);
    throw new Error(`unexpected_request:${url}`);
  };
  return { fetchImpl, calls };
}

test("a healthy queue reports counts, links, capacity and no anomalies", async () => {
  const api = fakeFetch({
    issues: [ready(197), ready(198), ready(199), ready(201),
      issue(166, ["status:working", "help wanted"]),
      issue(125, ["status:in-review", "action:reviewer"])],
    comments: { 166: [controllerComment(claimMarker(166, "worker:test-01"))] },
    // A healthy in-review state must have an open submission, so give it one.
    pulls: [pull(204, 125)],
  });
  const report = await readQueueHealth({ fetchImpl: api.fetchImpl, advisoryLogins: ["trusted-maintainer"] });

  assert.deepEqual(report.counts.ready, READY_FLOOR);
  assert.equal(report.counts.working, 1);
  assert.equal(report.counts["in-review"], 1);
  assert.equal(report.activeReviewCount, 1);
  assert.equal(report.claimedAssignments, 1);
  assert.equal(report.readyFloor, 4);
  assert.deepEqual(report.anomalies, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.uncertainty.truncated, false);
  for (const status of STATUSES)
    assert.match(report.links[status], new RegExp(`label%3Astatus%3A${status}$`));
  assert.match(renderQueueHealth(report), /Queue health for AgenticBotSitter\/agent-control-room/);
});

test("an empty Ready queue warns without inventing work and every state stays reportable", async () => {
  const api = fakeFetch({ issues: [issue(166, ["status:working"])], pulls: [] });
  const report = await readQueueHealth({ fetchImpl: api.fetchImpl });
  assert.equal(report.counts.ready, 0);
  assert.ok(report.warnings.includes("ready_floor_below_minimum"));
  assert.match(renderQueueHealth(report), /ready: 0 {2}<- below floor/);
  for (const status of STATUSES) assert.equal(typeof report.counts[status], "number");
  assert.equal(report.counts["needs-decision"], 0);
});

test("packet-less active work is reported as a queue-wide legacy blocker", async () => {
  const legacy = `CLAIM ACCEPTED — legacy\n<!-- agent-control-room-claim:v2 issue=166 request=1 actor=maintainer worker=worker:test-01 -->`;
  const api = fakeFetch({ issues: [issue(166, ["status:working"])], comments: { 166: [controllerComment(legacy)] } });
  const report = await readQueueHealth({ fetchImpl: api.fetchImpl });
  assert.ok(report.anomalies.find(item => item.issue === 166).codes.includes("legacy_claim_blocks_queue"));
});

test("working without an accepted controller claim is not treated as healthy", async () => {
  const api = fakeFetch({ issues: [issue(166, ["status:working"])] });
  const report = await readQueueHealth({ fetchImpl: api.fetchImpl });
  assert.ok(report.anomalies.find(item => item.issue === 166).codes.includes("working_claim_missing"));
});

test("ambiguous status and action labels are detected instead of guessed", async () => {
  const api = fakeFetch({
    issues: [
      issue(10, ["status:working", "status:paused"]),
      issue(11, ["status:in-review", "action:reviewer", "action:worker"]),
      issue(12, ["action:worker"]),
      issue(13, ["status:teleported"]),
    ],
    pulls: [pull(300, 11)],
  });
  const report = await readQueueHealth({ fetchImpl: api.fetchImpl });
  const codes = number => report.anomalies.find(item => item.issue === number)?.codes ?? [];
  assert.deepEqual(codes(10), ["status_label_ambiguous"]);
  // Contradictory action labels are ambiguous, and the issue still asks the worker to
  // correct work while advertising an active review.
  assert.deepEqual(codes(11), ["action_label_ambiguous", "correction_not_applied"]);
  assert.deepEqual(codes(12), ["status_label_missing"]);
  assert.deepEqual(codes(13), ["status_not_supported"]);
  assert.equal(report.counts.working, 0);
  assert.equal(report.counts.paused, 0);
});

test("a status that needs an action label but has none is reported with its responsibility area", async () => {
  const api = fakeFetch({ issues: [issue(125, ["status:in-review"])], pulls: [] });
  const report = await readQueueHealth({ fetchImpl: api.fetchImpl });
  const anomaly = report.anomalies.find(item => item.issue === 125);
  assert.ok(anomaly.codes.includes("action_label_missing"));
  assert.equal(anomaly.responsibilityArea, "Reviewer: review the exact submitted commit.");
  assert.equal(report.oldestReview.issue, 125);
  assert.doesNotMatch(anomaly.responsibilityArea, /codex|claude|marvin|hermes|gpt|@/i);
});

test("stale reviews and corrections report the oldest item and its age", async () => {
  const now = Date.parse("2026-09-14T12:00:00Z");
  const api = fakeFetch({
    issues: [
      issue(125, ["status:in-review", "action:reviewer"], "2026-09-04T12:00:00Z"),
      issue(130, ["status:re-review", "action:reviewer"], "2026-09-11T12:00:00Z"),
      issue(126, ["status:changes-required", "action:worker"], "2026-09-01T12:00:00Z"),
    ],
    comments: { 126: [comment(actionMarker("worker:test-01", "changes-required", 126))] },
    pulls: [],
  });
  const report = await readQueueHealth({ fetchImpl: api.fetchImpl, advisoryLogins: ["trusted-maintainer"], now });
  assert.equal(report.oldestReview.issue, 125);
  assert.equal(report.oldestReview.ageDays, 10);
  assert.equal(report.oldestCorrection.issue, 126);
  assert.equal(report.oldestCorrection.ageDays, 13);
  assert.equal(report.activeReviewCount, 2);
  assert.match(renderQueueHealth(report), /Oldest review: #125 .*10d/);
  assert.match(renderQueueHealth(report), /Oldest correction: #126 .*13d/);
});

test("a newer trusted reassignment changes the correction owner and a spoofed marker is ignored", async () => {
  const reassigned = fakeFetch({
    issues: [issue(170, ["status:changes-required", "action:worker"])],
    comments: { 170: [
      comment(actionMarker("worker:test-01", "changes-required", 170)),
      comment(actionMarker("worker:new-01", "changes-required", 170)),
    ] },
    pulls: [pull(301, 170)],
  });
  const report = await readQueueHealth({ fetchImpl: reassigned.fetchImpl, advisoryLogins: ["trusted-maintainer"] });
  assert.equal(report.oldestCorrection.workerId, "worker:new-01");
  // The reassignment is recognised, but it carries no authority: it is a legacy
  // shared-account marker, so the gap in authority is reported rather than hidden.
  assert.deepEqual(report.anomalies.find(item => item.issue === 170).codes,
    ["worker_action_marker_not_authoritative"]);

  const spoofed = fakeFetch({
    issues: [issue(170, ["status:changes-required", "action:worker"])],
    comments: { 170: [comment(actionMarker("worker:test-01", "changes-required", 170), "NONE", "random-outsider")] },
  });
  const spoofedReport = await readQueueHealth({ fetchImpl: spoofed.fetchImpl, advisoryLogins: ["trusted-maintainer"] });
  assert.ok(spoofedReport.anomalies.find(item => item.issue === 170).codes.includes("worker_action_marker_missing"));
});

test("corrections requested but still In review, and submitted work still Working, are detected", async () => {
  const api = fakeFetch({
    issues: [
      issue(180, ["status:in-review", "action:worker"]),
      issue(166, ["status:working"]),
    ],
    comments: { 180: [comment(actionMarker("worker:test-01", "changes-required", 180))], 166: [] },
    pulls: [pull(200, 166)],
  });
  const report = await readQueueHealth({ fetchImpl: api.fetchImpl, advisoryLogins: ["trusted-maintainer"] });
  assert.ok(report.anomalies.find(item => item.issue === 180).codes.includes("correction_not_applied"));
  assert.ok(report.anomalies.find(item => item.issue === 166).codes.includes("submitted_work_still_working"));
});

test("a submitted pull request that is already closed against an active review state is a mismatch", async () => {
  const closed = fakeFetch({
    issues: [issue(178, ["status:in-review", "action:reviewer"])],
    pulls: [pull(188, 178, { state: "closed", merged: true })],
  });
  const report = await readQueueHealth({ fetchImpl: closed.fetchImpl });
  assert.ok(report.anomalies.find(item => item.issue === 178).codes.includes("linked_pull_request_mismatch"));

  // An open submission for the same issue is healthy.
  const open = fakeFetch({
    issues: [issue(178, ["status:in-review", "action:reviewer"])],
    pulls: [pull(188, 178)],
  });
  assert.deepEqual((await readQueueHealth({ fetchImpl: open.fetchImpl })).anomalies, []);
});

test("a shared pull request that merely mentions an issue is not that issue's submission", async () => {
  // The real false positive this rule exists to prevent: shared integration pull
  // requests referenced many issues, which made unrelated Working issues look submitted.
  const mentioning = fakeFetch({
    issues: [issue(8, ["status:working"])],
    comments: { 8: [controllerComment(claimMarker(8, "worker:test-01"))] },
    pulls: [
      pull(176, 172, { body: `Outcome / issue: #172 — operator assembly\n\nAlso touches #8 and #64 as inputs.` }),
      pull(187, 187, { body: `Issue: #187\n\nRelated: #8, #27` }),
    ],
  });
  assert.deepEqual((await readQueueHealth({ fetchImpl: mentioning.fetchImpl })).anomalies, []);

  // A declaration deep inside a long body is a mention, not the delivered issue.
  const deep = fakeFetch({
    issues: [issue(8, ["status:working"])],
    comments: { 8: [controllerComment(claimMarker(8, "worker:test-01"))] },
    pulls: [pull(190, 999, { body: `${"x".repeat(2100)}\nissue: #8` })],
  });
  assert.deepEqual((await readQueueHealth({ fetchImpl: deep.fetchImpl })).anomalies, []);
});

test("both accepted declaration forms are recognised and prose is not", () => {
  assert.equal(declaredSubmissionIssue("Outcome / issue: #170 — queue self-service"), 170);
  assert.equal(declaredSubmissionIssue("Issue:     #166"), 166);
  assert.equal(declaredSubmissionIssue("Issue and completed outcome: #125"), 125);
  assert.equal(declaredSubmissionIssue("Closes #148."), 148);
  assert.equal(declaredSubmissionIssue("Fixes: #63"), 63);
  assert.equal(declaredSubmissionIssue("Resolves #81"), 81);
  assert.equal(declaredSubmissionIssue("Implements #125 (worker `w-01`, base `154587f`)."), 125);
  assert.equal(declaredSubmissionIssue("Implements #63"), 63);
  assert.equal(declaredSubmissionIssue("Delivers: #175"), 175);
  // Prose mentions are not declarations, however close to the marker they read.
  for (const prose of ["", "no declaration here", "this settles issue #175", "Advances #11 without closing it.",
    "Documents the decision for issue #191 across the public surface.",
    "Implements the bounded connector foundation for issue #62."])
    assert.equal(declaredSubmissionIssue(prose), undefined);
  assert.equal(declaredSubmissionIssue(undefined), undefined);
});

test("an open implementation claim keeps a resubmitted correction healthy", async () => {
  // Real regression: issue #125 carried an earlier merged submission (`Closes #125`) and an
  // open resubmission (`Implements #125`). Recognising only the closing keyword made the
  // open resubmission invisible and reported healthy work as drifted. The same shape exists
  // for #63. A declaration grammar that misses a real form does not under-report safely —
  // it manufactures drift findings.
  const api = fakeFetch({
    issues: [issue(125, ["status:changes-required", "action:worker"])],
    comments: { 125: [controllerComment(handoffMarker(handoff(125, "changes-required")))] },
    pulls: [
      pull(142, 125, { state: "closed", merged: true, body: "Closes #125." }),
      pull(150, 125, { body: "Implements #125 (worker `w-01`, base `154587f`)." }),
    ],
  });
  assert.deepEqual((await readQueueHealth({ fetchImpl: api.fetchImpl })).anomalies, []);
});

test("an open correction submission keeps an issue healthy when an earlier one merged", async () => {
  // An issue may have several declared submissions; one open one means review is live.
  const openCorrection = fakeFetch({
    issues: [issue(170, ["status:changes-required", "action:worker"])],
    comments: { 170: [controllerComment(handoffMarker(handoff(170, "changes-required")))] },
    pulls: [pull(196, 170, { state: "closed", merged: true }), pull(183, 170)],
  });
  assert.deepEqual((await readQueueHealth({ fetchImpl: openCorrection.fetchImpl })).anomalies, []);

  // With every declared submission resolved and none open, the review state has drifted.
  const allResolved = fakeFetch({
    issues: [issue(170, ["status:changes-required", "action:worker"])],
    comments: { 170: [controllerComment(handoffMarker(handoff(170, "changes-required")))] },
    pulls: [pull(196, 170, { state: "closed", merged: true }), pull(183, 170, { state: "closed" })],
  });
  assert.ok((await readQueueHealth({ fetchImpl: allResolved.fetchImpl }))
    .anomalies.find(item => item.issue === 170).codes.includes("linked_pull_request_mismatch"));
});

test("a controller handoff record is authoritative and outranks an advisory action marker", async () => {
  // The merged contributor handbook declares a legacy action:v1 marker advisory: it
  // "cannot prove that a maintainer, rather than a worker using that same account,
  // authorized it." The controller handoff:v1 record is authoritative, so it must win
  // and the report must name which record it used.
  const api = fakeFetch({
    issues: [issue(170, ["status:changes-required", "action:worker"])],
    comments: { 170: [
      comment(actionMarker("worker:stale-01", "changes-required", 170)),
      controllerComment(handoffMarker(handoff(170, "changes-required", "worker:real-01"))),
    ] },
    pulls: [pull(302, 170)],
  });
  const report = await readQueueHealth({ fetchImpl: api.fetchImpl, advisoryLogins: ["trusted-maintainer"] });
  assert.equal(report.oldestCorrection.workerId, "worker:real-01");
  assert.equal(report.oldestCorrection.recordTrust, "controller-record");
  assert.deepEqual(report.anomalies, []);
});

test("an advisory-only record is reported as advisory, never as authoritative", async () => {
  const api = fakeFetch({
    issues: [issue(170, ["status:changes-required", "action:worker"])],
    comments: { 170: [comment(actionMarker("worker:test-01", "changes-required", 170))] },
    pulls: [],
  });
  const report = await readQueueHealth({ fetchImpl: api.fetchImpl, advisoryLogins: ["trusted-maintainer"] });
  assert.equal(report.oldestCorrection.recordTrust, "advisory");
  assert.match(renderQueueHealth(report), /record: advisory/);

  // A controller record with a malformed payload is not authoritative.
  const malformed = fakeFetch({
    issues: [issue(170, ["status:changes-required", "action:worker"])],
    comments: { 170: [controllerComment('Workflow handoff\n\n<!-- agent-control-room-handoff:v1 {"issue":170} -->')] },
    pulls: [],
  });
  assert.ok((await readQueueHealth({ fetchImpl: malformed.fetchImpl }))
    .anomalies.find(item => item.issue === 170).codes.includes("worker_action_marker_missing"));
});

test("the human-readable report states who acts next for the oldest review and correction", async () => {
  const now = Date.parse("2026-09-14T12:00:00Z");
  const api = fakeFetch({
    issues: [
      issue(125, ["status:in-review", "action:reviewer"], "2026-09-04T12:00:00Z"),
      issue(126, ["status:changes-required", "action:worker"], "2026-09-01T12:00:00Z"),
    ],
    comments: { 126: [comment(actionMarker("worker:test-01", "changes-required", 126))] },
    pulls: [],
  });
  const report = await readQueueHealth({ fetchImpl: api.fetchImpl, advisoryLogins: ["trusted-maintainer"], now });
  const text = renderQueueHealth(report);
  // The responsibility area must appear in the human-readable report, not only in anomalies.
  assert.match(text, /Oldest review: #125 Issue 125 \(since [^)]*\)\n {2}next: Reviewer: review the exact submitted commit\./);
  assert.match(text, /Oldest correction: #126 Issue 126 \(since [^)]*\)\n {2}next: Original worker: correct the same pull request\./);
  // JSON carries the same field.
  assert.equal(report.oldestReview.responsibilityArea, "Reviewer: review the exact submitted commit.");
  assert.equal(report.oldestCorrection.responsibilityArea, "Original worker: correct the same pull request.");
  // Areas name a role, never a preferred person, login or bot brand.
  const areas = [report.oldestReview.responsibilityArea, report.oldestCorrection.responsibilityArea];
  for (const area of areas) assert.doesNotMatch(area, /codex|claude|marvin|ziggy|johnny5|hermes|gpt|@/i);
});

test("pagination stays bounded and the report declares its own uncertainty", async () => {
  const full = Array.from({ length: 100 }, (_, index) => ready(1000 + index));
  const api = fakeFetch({ issues: full });
  const report = await readQueueHealth({ fetchImpl: api.fetchImpl, maxPages: 1 });
  assert.equal(report.uncertainty.truncated, true);
  assert.equal(report.counts.ready, 100);
  assert.ok(report.warnings.includes("queue_read_truncated"));
  assert.match(report.uncertainty.note, /lower bound/);
  assert.equal(api.calls.filter(url => url.includes("/issues?")).length, 1);

  const short = await readQueueHealth({ fetchImpl: fakeFetch({ issues: full.slice(0, 3) }).fetchImpl, maxPages: 1 });
  assert.equal(short.uncertainty.truncated, false);
  assert.ok(!short.warnings.includes("queue_read_truncated"));
  assert.ok(short.warnings.includes("ready_floor_below_minimum"));
  assert.equal(DEFAULT_MAX_PAGES, 10);

  // Pull data is only read when some issue actually needs it, and never more than once.
  const idle = fakeFetch({ issues: [ready(1), ready(2)], pulls: [] });
  await readQueueHealth({ fetchImpl: idle.fetchImpl });
  assert.equal(idle.calls.filter(url => url.includes("/pulls?")).length, 0);

  const busy = fakeFetch({ issues: [issue(166, ["status:working"])], pulls: [] });
  const busyReport = await readQueueHealth({ fetchImpl: busy.fetchImpl });
  assert.equal(busy.calls.filter(url => url.includes("/pulls?")).length, 1);
  assert.equal(busyReport.uncertainty.submissionReads, 1);
});

test("authority comes from the controller, never from repository membership", async () => {
  // The controller posts claim and handoff records as `github-actions[bot]`. A public read
  // masks author_association (a genuine maintainer reads as CONTRIBUTOR, the controller as
  // NONE), so membership can neither identify a poster nor authorize one.
  const controller = fakeFetch({
    issues: [issue(199, ["status:working"])],
    comments: { 199: [comment(claimMarker(199, "marvin-project-templates-01"), "NONE", "github-actions[bot]", "Bot")] },
  });
  const controllerReport = await readQueueHealth({ fetchImpl: controller.fetchImpl });
  assert.equal(controllerReport.claimedAssignments, 1);
  assert.deepEqual(controllerReport.anomalies, []);

  // A configured advisory identity is recognised, but its record never becomes
  // authoritative and the gap in authority is reported rather than hidden.
  const advisory = fakeFetch({
    issues: [issue(170, ["status:changes-required", "action:worker"])],
    comments: { 170: [comment(actionMarker("worker:test-01", "changes-required", 170), "CONTRIBUTOR", "MarvinAi5")] },
    pulls: [pull(303, 170)],
  });
  const advisoryReport = await readQueueHealth({ fetchImpl: advisory.fetchImpl });
  assert.equal(advisoryReport.oldestCorrection.workerId, "worker:test-01");
  assert.equal(advisoryReport.oldestCorrection.recordTrust, "advisory");
  assert.deepEqual(advisoryReport.anomalies.find(item => item.issue === 170).codes,
    ["worker_action_marker_not_authoritative"]);

  // Regression for a material review finding: trust must never be derived from
  // author_association. Every one of these can post a comment, so treating membership as
  // trust would let an unauthorized comment satisfy a required handoff and suppress the
  // missing-record warning that should fire.
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"]) {
    const byAssociation = fakeFetch({
      issues: [issue(170, ["status:changes-required", "action:worker"])],
      comments: { 170: [comment(actionMarker("worker:test-01", "changes-required", 170), association, "not-configured")] },
      pulls: [pull(304, 170)],
    });
    const report = await readQueueHealth({ fetchImpl: byAssociation.fetchImpl, advisoryLogins: [] });
    assert.deepEqual(report.anomalies.find(item => item.issue === 170).codes,
      ["worker_action_marker_missing"], `${association} must not grant trust`);
  }

  assert.ok(DEFAULT_ADVISORY_LOGINS.includes("MarvinAi5"));
  assert.ok(!DEFAULT_ADVISORY_LOGINS.includes("github-actions[bot]"),
    "the controller is authoritative through its bot identity, not a login allowlist");
});

test("an advertised review or correction with no declared submission is reported, not assumed healthy", async () => {
  // Material review finding: a review state with no submission at all was reported as
  // healthy unless a closed pull request happened to be found. Absence of any submission
  // is itself drift, and it must be reported.
  for (const status of ["in-review", "re-review"]) {
    const api = fakeFetch({ issues: [issue(199, [`status:${status}`, "action:reviewer"])] });
    assert.deepEqual((await readQueueHealth({ fetchImpl: api.fetchImpl }))
      .anomalies.find(item => item.issue === 199).codes, ["submission_missing"],
    `${status} with no submission must be reported`);
  }
  const correction = fakeFetch({
    issues: [issue(199, ["status:changes-required", "action:worker"])],
    comments: { 199: [controllerComment(handoffMarker(handoff(199, "changes-required")))] },
  });
  assert.deepEqual((await readQueueHealth({ fetchImpl: correction.fetchImpl }))
    .anomalies.find(item => item.issue === 199).codes, ["submission_missing"]);

  // Work still being implemented is not drift: there is nothing to submit yet.
  const working = fakeFetch({ issues: [issue(199, ["status:working", "action:worker"])],
    comments: { 199: [controllerComment(claimMarker(199, "worker:test-01"))] } });
  assert.deepEqual((await readQueueHealth({ fetchImpl: working.fetchImpl })).anomalies, []);
});

test("an incomplete pull history reports the submission as indeterminate, never as drift", async () => {
  // Material review finding: a bounded pull read cannot prove that a submission is absent
  // or resolved. The relevant open pull request may simply sit outside the retained pages,
  // so an incomplete history must never be turned into a mismatch claim.
  const crowded = Array.from({ length: 100 },
    (_, index) => pull(1000 + index, 9000 + index, { state: "closed", merged: true }));
  const truncated = fakeFetch({
    issues: [issue(199, ["status:in-review", "action:reviewer"])],
    pulls: crowded,
  });
  const report = await readQueueHealth({ fetchImpl: truncated.fetchImpl });
  assert.deepEqual(report.anomalies.find(item => item.issue === 199).codes, ["submission_indeterminate"],
    "a truncated pull history must not be reported as a missing or mismatched submission");
  assert.ok(report.warnings.includes("queue_read_truncated"));

  // The identical state with a complete history is reported as a genuinely missing
  // submission, which proves the indeterminate result came from the truncation.
  const complete = fakeFetch({
    issues: [issue(199, ["status:in-review", "action:reviewer"])],
    pulls: crowded.slice(0, 3),
  });
  assert.deepEqual((await readQueueHealth({ fetchImpl: complete.fetchImpl }))
    .anomalies.find(item => item.issue === 199).codes, ["submission_missing"]);
});

test("API failure and invalid input fail closed with a bounded message", async () => {
  await assert.rejects(readQueueHealth({ fetchImpl: async () => ({ ok: false, status: 403 }) }), /queue_health_api_403/);
  await assert.rejects(readQueueHealth({ fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }) }),
    /queue_health_api_invalid/);
  await assert.rejects(readQueueHealth({ repository: "not-a-repository" }), /queue_health_repository_invalid/);
});

test("rendered output never publishes a credential value", async () => {
  const secret = "ghp_" + "A".repeat(36);
  const api = fakeFetch({
    issues: [{ ...issue(199, ["status:in-review", "action:reviewer"]), title: `Leaked ${secret}` }],
    pulls: [],
  });
  const report = await readQueueHealth({ fetchImpl: api.fetchImpl, token: secret });
  const text = renderQueueHealth(report);
  const json = renderQueueHealthJson(report);
  assert.doesNotMatch(text, /ghp_/);
  assert.doesNotMatch(json, /ghp_/);
  assert.match(text, /\[redacted\]/);
  assert.ok(json.includes("\"counts\""));
});

test("claim markers are parsed only in the exact bounded controller form", () => {
  assert.deepEqual(parseClaimMarker(`CLAIM ACCEPTED\n<!-- agent-control-room-claim:v2 issue=199 request=1 actor=maintainer worker=marvin-project-templates-01 -->`),
    { issue: 199, request: 1, actor: "maintainer", workerId: "marvin-project-templates-01" });
  for (const value of ["CLAIM ACCEPTED", "<!-- agent-control-room-claim:v2 issue=199 -->",
    "<!-- agent-control-room-claim:v2 issue=199 request=1 actor=a worker=b -->"])
    assert.equal(parseClaimMarker(value), undefined);
});
