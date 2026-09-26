import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivateMacLocalTaskSubmission } from "../private-app/app/task-submission";
import { TaskApprovalPanel } from "../private-app/app/task-approval";
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

async function mounted(responses: Array<object>) {
  const { JSDOM } = await import("jsdom");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/" });
  const saved = Object.fromEntries(["window", "document", "fetch", "IS_REACT_ACT_ENVIRONMENT"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const calls: Array<{ method: string; body?: string }> = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (_url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? "GET", body: init.body as string | undefined });
      const value = responses.shift(); assert.ok(value, "unexpected submission request");
      return Response.json(value);
    } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => { root.render(createElement(PrivateMacLocalTaskSubmission, { detail })); });
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
