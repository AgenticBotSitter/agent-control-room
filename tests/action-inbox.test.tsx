import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionInbox } from "../app/components/action-inbox";
import type { ActionInboxItemV1 } from "../src/operator-surfaces/v1";

const item: ActionInboxItemV1 = {
  id: "attention:1", tenantId: "tenant:1", projectId: "project:1", workItemId: "work:1", kind: "incident", state: "open",
  requestedAction: "Review service evidence", reasonCode: "service_degraded", blockedWorkItemIds: ["work:1"],
  legalResponses: [
    { id: "response:inspect", kind: "open_source", label: "Open evidence", requiresConfirmation: false, available: true },
    { id: "response:approve", kind: "approve_exact_operation", label: "Approve exact operation", requiresConfirmation: true, available: false, unavailableReasonCode: "approval_not_issued" },
  ], evidence: [{ id: "incident:1", kind: "incident" }], createdAt: "2026-08-27T12:00:00.000Z", expiresAt: "2026-08-28T12:00:00.000Z", deliveryState: "failed",
};

function render(items: ActionInboxItemV1[]): string { return renderToStaticMarkup(createElement(ActionInbox, { items })); }

test("renders the complete, safe attention record without pretending it took an action", () => {
  const html = render([item]);
  assert.match(html, /Review service evidence/);
  assert.match(html, /Service Degraded/);
  assert.match(html, /work:1/);
  assert.match(html, /Delivery: Failed/);
  assert.match(html, /1 reference/);
  assert.match(html, /Open evidence/);
  assert.match(html, /Confirmation required/);
  assert.match(html, /Unavailable: Approval Not Issued/);
  assert.match(html, /Response choices are not actions/);
  assert.ok(!html.toLowerCase().includes("success"));
});

test("renders disabled unavailable responses and a clear empty state", () => {
  const html = render([item]);
  assert.match(html, /<button[^>]*disabled[^>]*>Approve exact operation/);
  assert.match(render([]), /No action items match this view\./);
});

test("escapes hostile projected text", () => {
  const html = render([{ ...item, requestedAction: '<script>alert("x")</script>' }]);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});
