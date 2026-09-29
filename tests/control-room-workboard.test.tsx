import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ControlRoomWorkboardContent, ControlRoomWorkboardExpiryContent, workerAvailabilityForTaskV1 } from "../private-app/app/control-room-workboard";
import { readControlRoomWorkboardV1, type ControlRoomWorkboardReadV1 } from "../src/web/v1/control-room-workboard-browser-client";
import type { OperatorCapacityWorkerV1 } from "../src/web/v1/operator-capacity-browser-client";
import type { TaskProjectAgentOptions } from "../src/web/v1/task-project-agents-wire";
import { JSDOM } from "jsdom";

const projectId = "project:control-room";
const jobId = "job:exact";
const now = Date.parse("2026-09-22T16:00:00.000Z");
const eligibility: TaskProjectAgentOptions = {
  projectId, eligibilitySource: "configured", workers: [{ nodeId: "node:hermes", label: "Hermes", platform: "macos",
    eligibleTasks: [{ jobId, title: "Exact task", inputDigest: `sha256:${"a".repeat(64)}`, workScope: "configured_task" }] }],
  tasksExamined: 1, additionalTasksOmitted: false, candidateEvidence: "configured_routes_only",
  observedAt: "2026-09-22T16:00:00.000Z", startsWork: false, grantsAssignmentAuthority: false, grantsExecutionAuthority: false,
};

const worker = (overrides: Partial<OperatorCapacityWorkerV1> = {}): OperatorCapacityWorkerV1 => ({
  workerId: "node:hermes", platform: "macos", state: "idle", lastObservedAt: "2026-09-22T16:00:00.000Z",
  attribution: "self_reported", capacity: { evidence: "measured", value: { availableSlots: 1, totalSlots: 2 } },
  capability: { evidence: "measured", value: "verified" }, ...overrides,
});

test("a generic eligible worker is available only for the exact task with matching verified positive capacity and an online or idle state", () => {
  assert.deepEqual(workerAvailabilityForTaskV1(eligibility, worker(), jobId, now), {
    state: "available", message: "Available now — exact eligibility, verified fresh capacity, online or idle state, and a positive measured slot agree.",
  });
  const cases: Array<[string, TaskProjectAgentOptions, OperatorCapacityWorkerV1 | undefined, string]> = [
    ["qualify-only", { ...eligibility, workers: [] }, worker(), "Not eligible"],
    ["cross-project task", { ...eligibility, workers: [{ ...eligibility.workers[0]!, eligibleTasks: [{ ...eligibility.workers[0]!.eligibleTasks[0]!, jobId: "job:other" }] }] }, worker(), "Not eligible"],
    ["wrong node", eligibility, worker({ workerId: "node:other" }), "Matching worker capacity is unavailable"],
    ["stale or missing", eligibility, worker({ capacity: { evidence: "unavailable", reasonCode: "observation_stale" } }), "Matching capacity is unavailable"],
    ["zero slots", eligibility, worker({ capacity: { evidence: "measured", value: { availableSlots: 0, totalSlots: 2 } } }), "No measured slot"],
    ["offline", eligibility, worker({ state: "offline" }), "Worker is offline"],
    ["not verified", eligibility, worker({ capability: { evidence: "measured", value: "provisional" } }), "not verified"],
  ];
  for (const [name, options, observed, message] of cases) {
    const result = workerAvailabilityForTaskV1(options, observed, jobId, now);
    assert.equal(result.state, "unavailable", name);
    assert.match(result.message, new RegExp(message, "i"), name);
  }
});

test("the workboard never identifies a generic or other harness candidate as Hermes", () => {
  const generic = { ...eligibility, workers: [{ ...eligibility.workers[0]!, label: "Generic worker" }] };
  const otherHarness = { ...eligibility, workers: [{ ...eligibility.workers[0]!, label: "Claude worker" }] };
  for (const options of [generic, otherHarness]) {
    const result = workerAvailabilityForTaskV1(options, worker(), jobId, now);
    assert.equal(result.state, "available");
    assert.doesNotMatch(result.message, /hermes|claude|codex/i);
  }
  const source = readFileSync(new URL("../private-app/app/control-room-workboard.tsx", import.meta.url), "utf8");
  assert.match(source, /Eligible worker: Available now/);
  assert.doesNotMatch(source, /Hermes/);
});

test("the exact canonical capacity boundary remains fresh and one millisecond later is stale", () => {
  const boundary = workerAvailabilityForTaskV1(eligibility, worker(), jobId, now + 30 * 60_000);
  assert.equal(boundary.state, "available");
  const result = workerAvailabilityForTaskV1(eligibility, worker(), jobId, now + 30 * 60_000 + 1);
  assert.deepEqual(result, { state: "unavailable", message: "Matching capacity observation is stale." });
});

test("an open workboard redraws at canonical capacity expiry without polling or reading again", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let clockNow = now, cancelled = false;
  const timers: Array<{ delay: number; callback: () => void }> = [];
  const staleOther = worker({ workerId: "node:stale", lastObservedAt: new Date(now - 31 * 60_000).toISOString() });
  const laterFresh = worker({ workerId: "node:later", lastObservedAt: new Date(now - 10 * 60_000).toISOString() });
  const data = {
    home: { state: "unavailable" },
    capacity: { state: "ready", value: { workers: [staleOther, worker({ lastObservedAt: new Date(now - 20 * 60_000).toISOString() }), laterFresh], capacity: { evidence: "measured", value: { availableSlots: 1, totalSlots: 2, reportingWorkers: 2 } } } },
    project: { state: "ready", value: { projectId, current: [{ projectId, jobId, title: "Exact task", state: "ready" }], awaitingReview: [], recent: [], additionalCurrentOmitted: false, additionalReviewsOmitted: false, additionalRecentOmitted: false, observedAt: new Date(now).toISOString(), startsWork: false } },
    eligibility: { state: "ready", value: eligibility }, inbox: { state: "unavailable" }, reviews: { state: "unavailable" },
  } as unknown as ControlRoomWorkboardReadV1;
  try {
    await act(async () => root.render(createElement(ControlRoomWorkboardExpiryContent, { projectId, data,
      clock: () => clockNow, schedule: (callback, delay) => { timers.push({ callback, delay }); return timers.length as unknown as ReturnType<typeof setTimeout>; },
      cancel: () => { cancelled = true; }, })));
    assert.match(dom.window.document.body.textContent ?? "", /Eligible worker: Available now/);
    // The stale unrelated row does not suppress the fresh matching row's
    // expiry; the +1 ms is required because the exact boundary remains fresh.
    assert.equal(timers[0]?.delay, 10 * 60_000 + 1);
    clockNow += timers[0]!.delay;
    await act(async () => timers[0]!.callback());
    assert.match(dom.window.document.body.textContent ?? "", /Matching capacity observation is stale/);
    // A later fresh row causes a second, bounded one-shot redraw to be armed.
    assert.equal(timers[1]?.delay, 10 * 60_000);
    clockNow += timers[1]!.delay;
    await act(async () => timers[1]!.callback());
    assert.equal(timers.length, 2);
    await act(async () => root.unmount());
    assert.equal(cancelled, true);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("an advancing clock does not cause an immediate workboard timer loop before expiry", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let clockNow = now, schedules = 0;
  const data = { home: { state: "unavailable" },
    capacity: { state: "ready", value: { workers: [worker()], capacity: { evidence: "measured", value: { availableSlots: 1, totalSlots: 2, reportingWorkers: 1 } } } },
  } as unknown as ControlRoomWorkboardReadV1;
  try {
    await act(async () => root.render(createElement(ControlRoomWorkboardExpiryContent, { data,
      clock: () => clockNow++, schedule: () => { schedules += 1; return schedules as unknown as ReturnType<typeof setTimeout>; }, cancel: () => {} })));
    assert.equal(schedules, 1, "only the next future expiry is armed before it fires");
    await act(async () => root.unmount());
  } finally {
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("workboard reads are GET-only and navigation cancellation reaches every protected read", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  let attached = 0;
  const transport = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    calls.push({ input: String(input), init });
    assert.equal(init?.method, "GET");
    assert.ok(init?.signal);
    attached += 1;
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;
  const controller = new AbortController();
  const reading = readControlRoomWorkboardV1(projectId, transport, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  const result = await reading;
  assert.equal(attached, 6);
  assert.equal(calls.length, 6);
  assert.deepEqual(Object.values(result).map(value => value && value.state), ["unavailable", "unavailable", "unavailable", "unavailable", "unavailable", "unavailable"]);
  assert.ok(calls.some(call => call.input.endsWith(`/projects/${encodeURIComponent(projectId)}/agents`)));
});

test("a failed project overview remains unavailable instead of becoming an empty eligibility list", async () => {
  const transport = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith(`/projects/${encodeURIComponent(projectId)}/overview`)) return new Response("unavailable", { status: 503 });
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  const result = await readControlRoomWorkboardV1(projectId, transport);
  assert.equal(result.project?.state, "unavailable");
  assert.notEqual(result.project?.state, "ready");
  const unavailable: ControlRoomWorkboardReadV1 = {
    home: { state: "unavailable" }, capacity: { state: "unavailable" }, project: { state: "unavailable" },
    eligibility: { state: "unavailable" }, inbox: { state: "unavailable" }, reviews: { state: "unavailable" },
  };
  const html = renderToStaticMarkup(createElement(ControlRoomWorkboardContent, { projectId, data: unavailable }));
  assert.match(html, /Project activity is unavailable, so worker eligibility cannot be evaluated for a task/);
  assert.doesNotMatch(html, /No current project task has eligibility to evaluate/);
});

test("the local preview pilot remains explicitly repository-fake", () => {
  const source = readFileSync(new URL("../src/local-pilot/v1/project-tasks.ts", import.meta.url), "utf8");
  assert.match(source, /eligibilitySource: "not_configured"/);
  assert.match(source, /workers: \[\]/);
  assert.match(source, /startsWork: false/);
});
