import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  WorkerOperationPanel,
  type WorkerOperationPanelModelV1,
} from "../app/components/worker-operation-panel";

function baseModel(overrides: Partial<WorkerOperationPanelModelV1> = {}): WorkerOperationPanelModelV1 {
  return {
    schema: "control-room.worker-operation-panel/v1",
    workerId: "worker.ziggy.01",
    nodeId: "node.ziggy.01",
    nodeVersion: 4,
    nodeState: "active",
    displayName: "Ziggy Windows",
    platform: "windows",
    state: "online",
    lastHeartbeatAt: "2026-08-26T12:00:00.000Z",
    requests: [
      { operation: "request_drain", enabled: true, reason: "Graceful stop before maintenance." },
      { operation: "request_resume", enabled: false, reason: "Worker is not drained." },
      { operation: "request_quarantine", enabled: true, reason: "Suspicious activity detected." },
    ],
    ...overrides,
  };
}

function renderPanel(model: WorkerOperationPanelModelV1): string {
  return renderToStaticMarkup(
    createElement(WorkerOperationPanel, { model, onRequest: () => {} }),
  );
}

test("renders identity, platform, state, reason, and heartbeat exactly as supplied", () => {
  const html = renderPanel(
    baseModel({ stateReason: "Heartbeat latency above threshold." }),
  );
  assert.match(html, /Ziggy Windows/);
  assert.match(html, /worker\.ziggy\.01/);
  assert.match(html, /node\.ziggy\.01/);
  assert.match(html, />4</);
  assert.match(html, />windows</);
  assert.match(html, /online/);
  assert.match(html, /Heartbeat latency above threshold\./);
  assert.match(html, /2026-08-26T12:00:00\.000Z/);
});

test("renders all three operation labels with request phrasing", () => {
  const html = renderPanel(baseModel());
  assert.match(html, /Request drain/);
  assert.match(html, /Request resume/);
  assert.match(html, /Request quarantine/);
});

test("respects disabled operations and exposes their reasons as text", () => {
  const html = renderPanel(baseModel());
  const disabledMatch = html.match(/<button[^>]*disabled[^>]*>[^<]*Request resume/);
  assert.ok(disabledMatch, "resume button should be disabled");
  assert.match(html, /Worker is not drained\./);
});

test("renders only the operations present in the model", () => {
  const html = renderPanel(
    baseModel({
      requests: [{ operation: "request_quarantine", enabled: true, reason: "Escalated." }],
    }),
  );
  assert.match(html, /Request quarantine/);
  assert.doesNotMatch(html, /Request drain/);
  assert.doesNotMatch(html, /Request resume/);
});

test("renders an empty state when no operations are available", () => {
  const html = renderPanel(baseModel({ requests: [] }));
  assert.match(html, /No operations available\./);
  assert.doesNotMatch(html, /<button/);
});

test("escapes hostile text instead of injecting markup", () => {
  const html = renderPanel(
    baseModel({
      displayName: '<script>alert("x")</script>',
      stateReason: '" onload="alert(1)',
      requests: [
        { operation: "request_drain", enabled: true, reason: "<img src=x onerror=alert(2)>" },
      ],
    }),
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;script&gt;"), "script text should be escaped");
});

test("authority and confirmation statement is present", () => {
  const html = renderPanel(baseModel());
  assert.match(html, /server authority/);
  assert.match(html, /confirmation/i);
});

test("no success confirmation is rendered", () => {
  const html = renderPanel(baseModel());
  assert.ok(!html.toLowerCase().includes("success"));
  assert.ok(!html.toLowerCase().includes("confirmed"));
});
