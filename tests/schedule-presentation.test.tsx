import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleStatusView } from "../private-app/app/schedule-status";
import { readScheduleStatus } from "../src/schedules/browser-client";
import type { ProjectScheduleStatus } from "../src/schedules/status-wire";

const value: ProjectScheduleStatus = { projectId: "project:test", observedAt: "2026-09-04T12:00:00.000Z",
  windowEndsAt: "2026-09-11T12:00:00.000Z", automaticExecutionEnabled: false, additionalSchedulesOmitted: false,
  schedules: [{ scheduleId: "schedule:test", state: "active", scheduleType: "interval", timezone: "UTC",
    nextOccurrenceAt: null, nextReason: "anchor_unavailable", additionalOccurrencesOmitted: false,
    occurrences: [{ occurrenceKey: "schedule:test:one", scheduledFor: "2026-09-03T12:00:00.000Z", state: "dispatched", pastDue: false }] }] };
test("presentation distinguishes forecast, delivery, unavailable and absent data", () => {
  const render = (state: Parameters<typeof ScheduleStatusView>[0]["state"]) => renderToStaticMarkup(createElement(ScheduleStatusView, { projectId: value.projectId, state }));
  const html = render({ state: "ready", value });
  assert.match(html, /no interval anchor/); assert.match(html, /Delivery recorded — execution unverified/);
  assert.match(html, /does not enable automatic work/);
  assert.match(render({ state: "loading" }), /Loading/);
  assert.match(render({ state: "unavailable" }), /No empty schedule list/);
  assert.match(render({ state: "ready", value: { ...value, schedules: [] } }), /No schedules are recorded/);
  const wrong = render({ state: "ready", value: { ...value, projectId: "project:other" } });
  assert.doesNotMatch(wrong, /schedule:test/); assert.match(wrong, /unavailable/);
});
test("browser read is bounded, project-bound and never mutates or follows redirects", async () => {
  const transport: typeof fetch = async (url, options) => {
    assert.equal(url, "/api/v1/projects/project%3Atest/schedules");
    assert.equal(options?.method, "GET"); assert.equal(options?.redirect, "error"); assert.equal(options?.cache, "no-store");
    return Response.json(value);
  };
  assert.deepEqual(await readScheduleStatus(value.projectId, transport), value);
  await assert.rejects(readScheduleStatus("project:other", async () => Response.json(value)), /unavailable/);
  for (const status of [401, 403, 404, 503]) await assert.rejects(readScheduleStatus(value.projectId, async () => new Response(null, { status })));
  await assert.rejects(readScheduleStatus(value.projectId, async () => Response.json({ ...value, automaticExecutionEnabled: true })), /unavailable/);
});
