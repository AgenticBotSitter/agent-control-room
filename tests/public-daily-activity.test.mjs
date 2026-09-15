import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ACTIVITY_CATEGORIES, parseDailyActivity, parseDailyActivityArguments,
  renderDailyActivity, summarizeDailyActivity } from "../scripts/public-daily-activity.mjs";

const START = "2026-09-15T00:00:00.000Z";
const END = "2026-09-15T04:00:00.000Z";
const NOW = Date.parse("2026-09-15T05:00:00.000Z");
const github = "https://github.com/AgenticBotSitter/agent-control-room/issues/250";
const interval = (id, overrides = {}) => ({ id, workerId: "worker:build-01", model: "OpenAI/Sol", effort: "high",
  category: "building", start: "2026-09-15T01:00:00.000Z", end: "2026-09-15T02:00:00.000Z",
  evidence: github, ...overrides });
const input = (intervals = [], availability = []) => ({ schema: "acr-daily-activity:v1", availability, intervals });
const report = value => summarizeDailyActivity(value, { start: START, end: END, nowMs: NOW });

test("unions matching overlaps, clips boundaries, and leaves uncovered time unknown", () => {
  const result = report(input([
    interval("a", { start: "2026-09-14T23:30:00.000Z", end: "2026-09-15T01:30:00.000Z" }),
    interval("b", { start: "2026-09-15T01:00:00.000Z", end: "2026-09-15T02:00:00.000Z" }),
  ]));
  assert.deepEqual(result.workers[0].observedMinutes, {
    building: 120, testing: 0, reviewing: 0, managing: 0, idle: 0, blocked: 0, offline: 0, unknown: 120,
  });
  assert.equal(result.workers[0].percentages.building, 50);
  assert.equal(result.team.productiveCoverageMinutes, 120);
  assert.deepEqual(result.models, [{ model: "OpenAI/Sol", effort: "high", selfReportedMinutes: 120,
    selfReportedProductiveMinutes: 120, selfReportedNonworkMinutes: 0 }]);
});

test("conflicting category, model, or effort overlap becomes unknown exactly once", () => {
  const result = report(input([
    interval("base", { start: START, end: "2026-09-15T03:00:00.000Z" }),
    interval("category", { category: "testing", start: "2026-09-15T00:30:00.000Z", end: "2026-09-15T01:00:00.000Z" }),
    interval("model", { model: "OpenAI/Terra", start: "2026-09-15T01:00:00.000Z", end: "2026-09-15T01:30:00.000Z" }),
    interval("effort", { effort: "medium", start: "2026-09-15T01:30:00.000Z", end: "2026-09-15T02:00:00.000Z" }),
  ]));
  assert.equal(result.workers[0].observedMinutes.building, 90);
  assert.equal(result.workers[0].observedMinutes.unknown, 150); // 90 conflict + 60 uncovered.
  assert.equal(result.workers[0].observedMinutes.testing, 0);
  assert.equal(result.team.productiveCoverageMinutes, 90);
  assert.deepEqual(result.models, [{ model: "OpenAI/Sol", effort: "high", selfReportedMinutes: 90,
    selfReportedProductiveMinutes: 90, selfReportedNonworkMinutes: 0 }]);
});

test("reports availability separately and unions team coverage across workers", () => {
  const result = report(input([
    interval("one", { start: "2026-09-15T00:30:00.000Z", end: "2026-09-15T02:00:00.000Z" }),
    interval("two", { workerId: "reviewer:public-01", category: "reviewing", model: "unknown", effort: "unknown",
      start: "2026-09-15T01:00:00.000Z", end: "2026-09-15T03:00:00.000Z", evidence: "self-reported" }),
  ], [
    { workerId: "worker:build-01", start: START, end: "2026-09-15T01:00:00.000Z" },
    { workerId: "worker:build-01", start: "2026-09-15T00:30:00.000Z", end: "2026-09-15T01:30:00.000Z" },
  ]));
  assert.equal(result.workers[0].workerId, "reviewer:public-01");
  assert.equal(result.workers[0].scheduledAvailabilityMinutes, null);
  assert.equal(result.workers[0].availableProductivePercent, null);
  assert.equal(result.workers[1].scheduledAvailabilityMinutes, 90);
  assert.equal(result.workers[1].productiveWithinAvailabilityMinutes, 60);
  assert.ok(Math.abs(result.workers[1].availableProductivePercent - 200 / 3) < 1e-12);
  assert.equal(result.workers[1].availableKnownMinutes, 60);
  assert.equal(result.workers[1].availableUnknownMinutes, 30);
  assert.ok(Math.abs(result.workers[1].availableReportingCompletenessPercent - 200 / 3) < 1e-12);
  assert.equal(result.workers[1].productiveMinutes, 90);
  assert.equal(result.workers[1].buildTestMinutes, 90);
  assert.equal(result.workers[1].reviewManageMinutes, 0);
  assert.equal(result.team.productiveCoverageMinutes, 150); // 00:30-03:00, not 210 agent-minutes.
  assert.deepEqual(result.models, [
    { model: "OpenAI/Sol", effort: "high", selfReportedMinutes: 90,
      selfReportedProductiveMinutes: 90, selfReportedNonworkMinutes: 0 },
    { model: "unknown", effort: "unknown", selfReportedMinutes: 120,
      selfReportedProductiveMinutes: 120, selfReportedNonworkMinutes: 0 },
  ]);
});

test("empty records produce no invented workers, activity, availability, or models", () => {
  const result = report(input());
  assert.deepEqual(result.workers, []);
  assert.deepEqual(result.models, []);
  assert.equal(result.team.productiveCoverageMinutes, 0);
  assert.match(renderDailyActivity(result), /No model ranking is produced/);
});

test("an availability-only worker has a fully unknown activity window", () => {
  const result = report(input([], [{ workerId: "manager:public-01", start: START, end: END }]));
  assert.equal(result.workers[0].observedMinutes.unknown, 240);
  assert.equal(result.workers[0].scheduledAvailabilityMinutes, 240);
  assert.equal(result.workers[0].productiveWithinAvailabilityMinutes, 0);
  assert.equal(result.workers[0].availableProductivePercent, 0);
  assert.equal(result.workers[0].availableKnownMinutes, 0);
  assert.equal(result.workers[0].availableUnknownMinutes, 240);
  assert.equal(result.workers[0].availableReportingCompletenessPercent, 0);
  for (const category of ACTIVITY_CATEGORIES) assert.equal(result.workers[0].observedMinutes[category], 0);
});

test("model rows separate productive work from explicit non-work reports", () => {
  const result = report(input([
    interval("idle", { category: "idle", start: START, end: "2026-09-15T00:30:00.000Z" }),
    interval("work", { category: "testing", start: "2026-09-15T00:30:00.000Z", end: "2026-09-15T01:00:00.000Z" }),
  ], [{ workerId: "worker:build-01", start: START, end: "2026-09-15T01:00:00.000Z" }]));
  assert.deepEqual(result.models, [{ model: "OpenAI/Sol", effort: "high", selfReportedMinutes: 60,
    selfReportedProductiveMinutes: 30, selfReportedNonworkMinutes: 30 }]);
  assert.equal(result.workers[0].availableKnownMinutes, 60);
  assert.equal(result.workers[0].availableUnknownMinutes, 0);
  assert.equal(result.workers[0].availableReportingCompletenessPercent, 100);
  assert.equal(result.workers[0].availableProductivePercent, 50);
});

test("registered workers stay visible without records and future schedule tails are allowed", () => {
  const value = { ...input([], [{ workerId: "worker:scheduled-01", start: START,
    end: "2026-09-16T00:00:00.000Z" }]), workerIds: ["worker:missing-01", "worker:scheduled-01"] };
  const result = report(value);
  assert.deepEqual(result.workers.map(worker => worker.workerId), ["worker:missing-01", "worker:scheduled-01"]);
  assert.equal(result.workers[0].observedMinutes.unknown, 240);
  assert.equal(result.workers[0].scheduledAvailabilityMinutes, null);
  assert.equal(result.workers[1].scheduledAvailabilityMinutes, 240);
  assert.throws(() => report({ ...input(), workerIds: ["worker:one-01", "worker:one-01"] }), /worker_id_duplicate/);
});

test("strict validation rejects malformed, unsafe, future, reversed, duplicate, and unknown data", () => {
  const bad = value => assert.throws(() => report(value), /daily_activity_/);
  bad({ schema: "wrong", availability: [], intervals: [] });
  bad({ ...input(), privatePath: "/Users/person" });
  bad(input([interval("a"), interval("a")]));
  bad(input([interval("a", { workerId: "private person" })]));
  bad(input([interval("a", { category: "coding" })]));
  bad(input([interval("a", { start: "not-a-date" })]));
  bad(input([interval("a", { start: "2026-09-15T01:00:00" })]));
  bad(input([interval("a", { start: "2026-02-30T01:00:00Z" })]));
  bad(input([interval("a", { start: "2026-09-15T02:00:00.000Z", end: "2026-09-15T01:00:00.000Z" })]));
  bad(input([interval("a", { end: "2026-09-15T06:00:00.000Z" })]));
  bad(input([interval("a", { evidence: "/Users/person/private.log" })]));
  bad(input([interval("a", { evidence: "https://github.com/other/private/issues/1" })]));
  bad(input([interval("a", { evidence: `${github}?private=/Users/person` })]));
  bad(input([interval("a", { evidence: "https://github.com:444/AgenticBotSitter/agent-control-room/issues/250" })]));
  bad(input([interval("a", { effort: "heroic" })]));
  bad(input([interval("a", { model: "bad\nmodel" })]));
  assert.throws(() => summarizeDailyActivity(input(), { start: END, end: START, nowMs: NOW }), /window_reversed/);
  assert.throws(() => summarizeDailyActivity(input(), { start: START, end: "2026-09-16T00:00:00.000Z", nowMs: NOW }), /instant_future/);
});

test("parser exposes normalized records and CLI arguments are explicit", () => {
  const parsed = parseDailyActivity(input([interval("record")]), { nowMs: NOW });
  assert.equal(parsed.intervals[0].startMs, Date.parse("2026-09-15T01:00:00.000Z"));
  assert.deepEqual(parseDailyActivityArguments(["--input", "day.json", "--start", START, "--end", END, "--json"]),
    { input: "day.json", start: START, end: END, json: true });
  assert.throws(() => parseDailyActivityArguments(["--input", "day.json"]), /arguments_required/);
  assert.throws(() => parseDailyActivityArguments(["--wat"]), /argument_invalid/);
});

test("read-only CLI emits the same report as JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-activity-"));
  const path = join(directory, "input.json");
  try {
    writeFileSync(path, JSON.stringify({ ...input(), workerIds: ["lead:public-01"] }));
    const result = spawnSync(process.execPath, ["scripts/public-daily-activity.mjs", "--input", path,
      "--start", "2020-01-01T00:00:00Z", "--end", "2020-01-01T01:00:00Z", "--json"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.workers[0].observedMinutes.unknown, 60);
    assert.equal(parsed.workers[0].availableProductivePercent, null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
