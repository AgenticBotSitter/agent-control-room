import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivateMacLocalTaskSubmission } from "../private-app/app/task-submission";
import { PrivateTaskApproval, TaskApprovalPanel } from "../private-app/app/task-approval";
import { TaskWorkflowGuide } from "../private-app/app/task-workflow-guide";
import { TaskExecutionStage } from "../private-app/app/task-workspace";
import { TaskPlanningPanel } from "../private-app/app/task-planning";
import { createTaskExecutionWorkspace } from "../src/web/v1/task-execution-workspace";
import { createTaskPlanningBrowserClient } from "../src/web/v1/task-planning-browser-client";
import { HERMES_LOCAL_ADAPTER_V1 } from "../src/harness/hermes-local-v1/task-planning-contract";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } from "../src/harness/codex-v1/owner-trusted-local-task-planning-contract";
import type { TaskDetail } from "../src/web/v1/task-wire";

const digest = (char: string) => `sha256:${char.repeat(64)}`;
const at = "2026-09-25T00:00:00.000Z";
const detail = { task: { projectId: "project:test", jobId: "job:test", title: "Write a report" },
  inputDigest: digest("a"), preparedFor: "hermes", instructions: "Summarize the evidence" } as TaskDetail;
const preview = { projectId: detail.task.projectId, jobId: detail.task.jobId, packetDigest: digest("b") };
const receipt = { projectId: detail.task.projectId, jobId: detail.task.jobId, attemptId: "attempt:test",
  queueId: "queue:test", packetDigest: preview.packetDigest, operationDigest: digest("c"), queuedAt: at,
  evidence: "recorded_delivery_intent", startsWork: false, grantsExecutionAuthority: false };
const read = (extra: object = {}) => ({ projectId: detail.task.projectId, jobId: detail.task.jobId,
  inputDigest: detail.inputDigest, receipt: null, ...extra });

async function mounted(responses: Array<object>, element: ReactElement = createElement(PrivateMacLocalTaskSubmission, { detail })) {
  const { JSDOM } = await import("jsdom");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/" });
  const saved = Object.fromEntries(["window", "document", "fetch", "IS_REACT_ACT_ENVIRONMENT"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body as string | undefined });
      const value = responses.shift(); assert.ok(value, "unexpected submission request");
      return Response.json(value);
    } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => { root.render(element); });
  return { dom, calls, act, close: async () => {
    await act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  } };
}

test("owner sees exact local preview and submits its digest", async () => {
  const view = await mounted([read({ preview }), read({ preview }), { ...receipt, replayed: false }, read({ receipt })]);
  try {
    assert.match(view.dom.window.document.body.textContent ?? "", /Agent: hermes.*Task: Write a report/);
    assert.match(view.dom.window.document.body.textContent ?? "", /Summarize the evidence/);
    const button = [...view.dom.window.document.querySelectorAll("button")].find(item => item.textContent === "Submit task");
    assert.ok(button);
    await view.act(async () => { button.click(); });
    assert.deepEqual(JSON.parse(view.calls.find(call => call.method === "POST")?.body ?? "{}"),
      { expectedInputDigest: detail.inputDigest, expectedPacketDigest: preview.packetDigest });
    assert.match(view.dom.window.document.body.textContent ?? "", /Submission recorded/);
    assert.equal(view.dom.window.document.body.textContent?.includes(receipt.queueId), true);
  } finally { await view.close(); }
});

test("no preview means no Submit; a vanished preview cannot submit", async () => {
  const absent = await mounted([read()]);
  try { assert.equal(absent.dom.window.document.body.textContent?.includes("Submit task"), false); }
  finally { await absent.close(); }
  const expired = await mounted([read({ preview }), read()]);
  try {
    const button = [...expired.dom.window.document.querySelectorAll("button")].find(item => item.textContent === "Submit task");
    assert.ok(button); await expired.act(async () => { button.click(); });
    assert.equal(expired.calls.some(call => call.method === "POST"), false);
    assert.equal(expired.dom.window.document.body.textContent?.includes("Submit task"), false);
  } finally { await expired.close(); }
});

test("replayed receipt is shown without a new Submit", async () => {
  const view = await mounted([read({ receipt })]);
  try {
    assert.match(view.dom.window.document.body.textContent ?? "", /Submission recorded/);
    assert.equal(view.dom.window.document.body.textContent?.includes("Submit task"), false);
    assert.equal(view.calls.length, 1);
  } finally { await view.close(); }
});

test("hosted signed-approval panel retains its saved-permission wording and controls", () => {
  const html = renderToStaticMarkup(createElement(TaskApprovalPanel, {
    state: { projectId: detail.task.projectId, jobId: detail.task.jobId, inputDigest: detail.inputDigest,
      receipt: { packetDigest: preview.packetDigest, acceptedAt: at } } as Parameters<typeof TaskApprovalPanel>[0]["state"],
    pending: false, uncertain: false, fileName: "", onReview() {}, onCheck() {}, onFile() {}, onSave() {},
  }));
  assert.match(html, /Signed permission recorded/);
  assert.match(html, /Check saved approval/);
  assert.doesNotMatch(html, /Submit task/);
});

test("Mac-local approval reads only the preview and never asks for a signed file", async () => {
  const assigned = { ...detail, attempts: [{ attemptId: "attempt:test" }] } as TaskDetail;
  const view = await mounted([read({ preview })], createElement(PrivateTaskApproval, { detail: assigned, local: true }));
  try {
    assert.equal(view.calls.length, 1);
    assert.match(view.calls[0]!.url, /\/submission\?/);
    assert.doesNotMatch(view.dom.window.document.body.textContent ?? "", /signed approval file|signing is not connected/i);
    assert.match(view.dom.window.document.body.textContent ?? "", /Submit task/);
  } finally { await view.close(); }
});

test("workflow guidance distinguishes local preview from hosted signing", () => {
  const local = renderToStaticMarkup(createElement(TaskWorkflowGuide, { local: true, prepared: true }));
  const hosted = renderToStaticMarkup(createElement(TaskWorkflowGuide, { prepared: true }));
  const source = renderToStaticMarkup(createElement(TaskWorkflowGuide, { local: true }));
  assert.match(local, /fresh local preview/);
  assert.doesNotMatch(local, /signed approval file/);
  assert.match(hosted, /separately signed approval file/);
  assert.match(source, /Prepare/);
  assert.doesNotMatch(source, /href="#task-assignment"|href="#task-approval"/);
});

test("source proposal shows the later assignment and approval steps as disabled, without reading or submitting them", () => {
  const html = renderToStaticMarkup(createElement(TaskExecutionStage,
    { detail: { ...detail, preparedFor: null, attempts: [] } as TaskDetail, mode: "local", workspace: createTaskExecutionWorkspace() }));
  assert.match(html, /Prepare task/);
  assert.match(html, /Task assignment/);
  assert.match(html, /Execution approval/);
  assert.match(html, /Assign after preparation/);
  assert.match(html, /Approve after assignment/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Submit task/);
});

test("a refreshed source proposal replaces obsolete disabled steps with its prepared continuation", async () => {
  const source = { ...detail, preparedFor: null, attempts: [] } as TaskDetail;
  const preparedJobId = "job:prepared";
  const savedPlan = { projectId: source.task.projectId, sourceJobId: source.task.jobId, jobId: preparedJobId,
    sourceInputDigest: source.inputDigest, inputDigest: digest("e"), plannedAt: at, startsWork: false,
    grantsExecutionAuthority: false };
  const options = { projectId: source.task.projectId, sourceJobId: source.task.jobId, inputDigest: source.inputDigest,
    availability: "already_planned", startsWork: false, savedPlan,
    preparedTask: { jobId: preparedJobId, state: "proposed", version: 0, updatedAt: at } };
  const workspace = createTaskExecutionWorkspace({ planning: () => createTaskPlanningBrowserClient(async () => Response.json(options)) });
  const view = await mounted([], createElement(TaskExecutionStage, { detail: source, mode: "local", workspace }));
  try {
    await view.act(async () => { await Promise.resolve(); });
    assert.match(view.dom.window.document.body.textContent ?? "", /Prepared task status: proposed/);
    assert.equal(view.dom.window.document.body.textContent?.includes("Assign after preparation"), false);
    assert.equal(view.dom.window.document.body.textContent?.includes("Approve after assignment"), false);
  } finally { await view.close(); }
});

test("prepared Mac task offers assignment and local submission, not a second plan or hosted signing", () => {
  const html = renderToStaticMarkup(createElement(TaskExecutionStage,
    { detail: { ...detail, attempts: [{ attemptId: "attempt:test" }] } as TaskDetail,
      mode: "local", workspace: createTaskExecutionWorkspace() }));
  assert.match(html, /Task assignment/);
  assert.match(html, /Local execution approval/);
  assert.doesNotMatch(html, /Prepare task|Signed approval file/);
});

test("hosted task workspace retains its existing planning, assignment and signed approval sections", () => {
  const html = renderToStaticMarkup(createElement(TaskExecutionStage,
    { detail: { ...detail, preparedFor: null, attempts: [] } as TaskDetail,
      mode: "hosted", workspace: createTaskExecutionWorkspace() }));
  assert.match(html, /Prepare task/);
  assert.match(html, /Task assignment/);
  assert.match(html, /Execution approval/);
  const guide = renderToStaticMarkup(createElement(TaskWorkflowGuide, { local: false }));
  assert.match(guide, /Prepare/);
  assert.match(guide, /Assign/);
  assert.match(guide, /separately signed approval file/);
});

test("the planning selector names all three server-supplied local worker choices", () => {
  const html = renderToStaticMarkup(createElement(TaskPlanningPanel, { options: {
    projectId: detail.task.projectId, sourceJobId: detail.task.jobId, inputDigest: detail.inputDigest,
    availability: "available", startsWork: false,
    templates: [
      { id: "template:hermes", adapter: HERMES_LOCAL_ADAPTER_V1 },
      { id: "template:claude", adapter: "connector:claude-code-local-v1" },
      { id: "template:codex", adapter: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 },
    ],
  }, pending: false, uncertain: false, onSelectTemplate() {}, onPrepare() {}, onRetry() {} }));
  assert.match(html, /Hermes Agent/);
  assert.match(html, /Claude Code/);
  assert.match(html, /Codex/);
  assert.match(html, /Choose a worker/);
});

test("a saved source plan links to the prepared task and shows its canonical status", () => {
  const preparedJobId = "job:prepared";
  const savedPlan = { projectId: detail.task.projectId, sourceJobId: detail.task.jobId, jobId: preparedJobId,
    sourceInputDigest: detail.inputDigest, inputDigest: digest("d"), plannedAt: at, startsWork: false as const,
    grantsExecutionAuthority: false as const };
  const html = renderToStaticMarkup(createElement(TaskPlanningPanel, { options: {
    projectId: detail.task.projectId, sourceJobId: detail.task.jobId, inputDigest: detail.inputDigest,
    availability: "already_planned", startsWork: false, savedPlan,
    preparedTask: { jobId: preparedJobId, state: "leased", version: 2, updatedAt: at },
  }, receipt: savedPlan, pending: false, uncertain: false, onSelectTemplate() {}, onPrepare() {}, onRetry() {} }));
  assert.match(html, /Prepared task status:.*leased/);
  assert.match(html, new RegExp(encodeURIComponent(preparedJobId)));
});
