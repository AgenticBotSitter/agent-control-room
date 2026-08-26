import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SyntheticExecutionTimeline, type SyntheticExecutionTimelineModelV1 } from "../app/components/synthetic-execution-timeline.tsx";

function baseModel(overrides: Partial<SyntheticExecutionTimelineModelV1> = {}): SyntheticExecutionTimelineModelV1 {
  return {
    schema: "control-room.synthetic-execution-timeline/v1",
    jobId: "job-42",
    attemptId: "attempt-7",
    events: [],
    ...overrides,
  };
}

test("empty event list renders the no-events status", () => {
  const html = renderToStaticMarkup(<SyntheticExecutionTimeline model={baseModel()} />);
  assert.match(html, /No execution events recorded/);
});

function sampleEvents(): SyntheticExecutionTimelineModelV1["events"] {
  return [
    { sequence: 1, occurredAt: "2026-08-26T10:00:00.000Z", event: "started" },
    { sequence: 2, occurredAt: "2026-08-26T10:00:01.000Z", event: "progress", completedSteps: 1, totalSteps: 3, progressPercent: 33 },
    { sequence: 3, occurredAt: "2026-08-26T10:00:02.000Z", event: "checkpointed", completedSteps: 2, checkpointId: "checkpoint:attempt-7:2" },
    { sequence: 4, occurredAt: "2026-08-26T10:00:03.000Z", event: "completed", completedSteps: 3 },
    { sequence: 5, occurredAt: "2026-08-26T10:00:04.000Z", event: "cancelled", completedSteps: 3, safeReasonCode: "cancelled" },
  ];
}

test("renders events in supplied order without sorting or inventing events", () => {
  const events = [...sampleEvents()].reverse();
  const html = renderToStaticMarkup(<SyntheticExecutionTimeline model={baseModel({ events })} />);
  const cancelled = html.indexOf("Sequence: 5");
  const started = html.indexOf("Sequence: 1");
  assert.ok(cancelled >= 0 && started >= 0 && cancelled < started, "supplied order preserved (reversed input)");
});

test("shows sequence, label, time, and applicable fields per event", () => {
  const html = renderToStaticMarkup(<SyntheticExecutionTimeline model={baseModel({ events: sampleEvents() })} />);
  for (const expected of [
    "Sequence: 1", "Started", "Occurred at: 2026-08-26T10:00:00.000Z",
    "Sequence: 2", "Progress", "Completed steps: 1", "Total steps: 3", "Progress: 33%",
    "Sequence: 3", "Checkpoint", "Checkpoint ID: checkpoint:attempt-7:2",
    "Sequence: 4", "Completed", "Completed steps: 3",
    "Sequence: 5", "Cancelled", "Reason code: cancelled",
  ]) {
    assert.ok(html.includes(expected), `missing: ${expected}`);
  }
});

test("distinguishes checkpoint from completion and cancellation from failure labels", () => {
  const html = renderToStaticMarkup(<SyntheticExecutionTimeline model={baseModel({ events: sampleEvents() })} />);
  assert.match(html, /Checkpoint</);
  assert.match(html, /Completed</);
  assert.match(html, /Cancelled</);
  assert.doesNotMatch(html, /Failed</);
});

test("uses an ordered list with an accessible heading and text status", () => {
  const html = renderToStaticMarkup(<SyntheticExecutionTimeline model={baseModel({ events: sampleEvents() })} />);
  assert.match(html, /<ol>/);
  assert.match(html, /aria-labelledby="synthetic-execution-timeline-heading"/);
  assert.match(html, /<h3 id="synthetic-execution-timeline-heading">/);
});

test("shows job and attempt identity", () => {
  const html = renderToStaticMarkup(<SyntheticExecutionTimeline model={baseModel()} />);
  assert.match(html, /Job: job-42/);
  assert.match(html, /Attempt: attempt-7/);
});

test("safe escaping of supplied text values", () => {
  const hostile: SyntheticExecutionTimelineModelV1["events"] = [
    { sequence: 1, occurredAt: "not-a-time<script>alert(1)</script>", event: "started" },
  ];
  const html = renderToStaticMarkup(<SyntheticExecutionTimeline model={baseModel({ events: hostile })} />);
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;/);
});

test("deterministic output for identical props", () => {
  const a = renderToStaticMarkup(<SyntheticExecutionTimeline model={baseModel({ events: sampleEvents() })} />);
  const b = renderToStaticMarkup(<SyntheticExecutionTimeline model={baseModel({ events: sampleEvents() })} />);
  assert.equal(a, b);
});
