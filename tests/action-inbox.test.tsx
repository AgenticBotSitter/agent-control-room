import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionInboxPanel, type ActionInboxState } from "../private-app/app/needs-me/action-inbox";
import { OPERATOR_SURFACES_CONTRACT_V1, OperatorSurfaceReadServiceV1, type ActionInboxItemV1,
  type OperatorFleetReadSourceV1, type OperatorSurfaceSnapshotV1, type OperatorSurfaceStoreV1 } from "../src/operator-surfaces/v1";
import type { ServiceIncidentStore } from "../src/services/v1/incident-store";
import { buildActionInbox } from "../src/web/v1/action-inbox";
import { readActionInboxSource } from "../src/web/v1/action-inbox-browser-client";
import { taskAttentionPageSchema } from "../src/web/v1/task-attention-wire";

const now = "2026-09-28T14:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;

function taskPage() {
  const task = (jobId: string, title: string, updatedAt: string, reasons: string[]) => ({
    task: { projectId: "project:alpha", jobId, requestId: `request:${jobId}`, title, state: "failed" as const,
      version: 1, createdAt: "2026-09-28T09:00:00.000Z", updatedAt }, inputDigest: digest, reasons,
  });
  return taskAttentionPageSchema.parse({ items: [
    task("job:review", "Review returned result", "2026-09-28T11:00:00.000Z", ["review"]),
    task("job:failed", "Choose after failed run", "2026-09-28T13:00:00.000Z", ["failed"]),
    task("job:approval", "Approve prepared work", "2026-09-28T10:00:00.000Z", ["approval"]),
  ], nextCursor: null, examined: 3, observedAt: now, startsWork: false,
  planningSource: "configured", deliverySource: "configured", sources: { ordinary: "included", ideas: "not_configured" } });
}

function canonical(patch: Partial<ActionInboxItemV1>): ActionInboxItemV1 {
  return { id: "attention:blocked", tenantId: "tenant:test", projectId: "project:alpha", workItemId: "job:blocked",
    kind: "ambiguity", state: "open", requestedAction: "Resolve blocked work", reasonCode: "outcome_uncertain",
    blockedWorkItemIds: ["job:blocked"], legalResponses: [{ id: "response:blocked", kind: "request_review",
      label: "Request reconciliation review", requiresConfirmation: true, available: true }],
    evidence: [{ id: "evidence:blocked", kind: "audit", observedAt: "2026-09-28T08:00:00.000Z" }],
    createdAt: "2026-09-28T08:00:00.000Z", expiresAt: "2026-09-29T08:00:00.000Z", deliveryState: "failed", ...patch };
}

function snapshot(): OperatorSurfaceSnapshotV1 {
  return { contractVersion: OPERATOR_SURFACES_CONTRACT_V1, tenantId: "tenant:test", generatedAt: now,
    fleet: [], bottlenecks: [], activeWork: [], portfolio: [], services: [], schedules: [], ownerFocus: [],
    actionInbox: [canonical({}), canonical({ id: "attention:resolved", state: "resolved", requestedAction: "Already handled" }),
      canonical({ id: "attention:batch", workItemId: "batch:one", kind: "approval", reasonCode: "work_batch_proposed",
        requestedAction: "Review proposed work batch", blockedWorkItemIds: [], expiresAt: undefined }),
      canonical({ id: "attention:notice", projectId: undefined, workItemId: undefined, kind: "native_session",
        requestedAction: "Inspect saved native session notice", blockedWorkItemIds: [], expiresAt: undefined })],
    serviceIncidents: [{ id: "incident:one", serviceId: "service:queue", severity: "warning", state: "open",
      reasonCode: "delivery_delayed", remedyCode: "inspect_saved_state", openedAt: "2026-09-28T07:00:00.000Z",
      lastObservedAt: "2026-09-28T12:00:00.000Z" }],
  };
}

test("universal Action Inbox orders and links every required item type", () => {
  const items = buildActionInbox([taskPage()], snapshot().actionInbox);
  assert.deepEqual(items.map(item => item.kind), ["failure", "blocked", "approval", "approval", "review", "notification"]);
  assert.equal(items.find(item => item.title === "Choose after failed run")?.href,
    "/projects/project%3Aalpha/tasks/job%3Afailed");
  assert.equal(items.find(item => item.title === "Resolve blocked work")?.href,
    "/projects/project%3Aalpha/tasks/job%3Ablocked");
  assert.equal(items.find(item => item.title === "Review proposed work batch")?.href, undefined);
  assert.equal(items.find(item => item.title === "Review proposed work batch")?.actionLabel,
    "Exact action route unavailable");
  assert.equal(items.find(item => item.title.includes("native session"))?.href, undefined);
  assert.equal(items.some(item => item.title === "Already handled"), false);
  const html = renderToStaticMarkup(createElement(ActionInboxPanel, { data: {
    tasks: { state: "available", pages: [taskPage()], truncated: false }, operator: { state: "available",
      source: { observedAt: now, items: snapshot().actionInbox, truncated: false } },
  } satisfies ActionInboxState }));
  for (const label of ["Failed run", "Blocked work", "Approval needed", "Review or accept", "Attention notification"])
    assert.match(html, new RegExp(label));
  assert.match(html, /Request reconciliation review/); assert.match(html, /No exact in-product action route is recorded/);
  assert.match(html, /Notification delivery failed/);
  assert.ok(html.indexOf("Choose after failed run") < html.indexOf("Resolve blocked work"));
  assert.ok(html.indexOf("Resolve blocked work") < html.indexOf("Approve prepared work"));
  assert.ok(html.indexOf("Approve prepared work") < html.indexOf("Review returned result"));
});

test("canonical attention filters open records before the database safety cap", async () => {
  const olderOpen = canonical({ id: "attention:older-open", state: "open", createdAt: "2025-01-01T00:00:00.000Z",
    requestedAction: "Review the older open approval" });
  const records = [...Array.from({ length: 501 }, (_, index) => canonical({
    id: `attention:resolved-${index}`, state: "resolved", createdAt: "2026-09-28T13:00:00.000Z",
    requestedAction: `Resolved item ${index}`,
  })), olderOpen];
  const inboxReads: unknown[] = [];
  const surfaces = {
    async listInbox(input: { tenantId: string; state?: ActionInboxItemV1["state"]; limit: number }) {
      inboxReads.push(input);
      return records.filter(item => input.state === undefined || item.state === input.state).slice(0, input.limit);
    },
    async listOwnerFocus() { return []; },
  } as unknown as OperatorSurfaceStoreV1;
  const incidents = { async list() { return []; } } as unknown as ServiceIncidentStore;
  const emptyFleet: OperatorFleetReadSourceV1 = {
    async fleet() { return []; }, async bottlenecks() { return []; }, async activeWork() { return []; },
    async portfolio() { return []; }, async services() { return []; }, async schedules() { return []; },
  };
  const result = await new OperatorSurfaceReadServiceV1(surfaces, incidents, emptyFleet).read({
    scope: { tenantId: "tenant:test", actorId: "identity:test", grantedAt: now }, now,
    inboxFilter: { states: ["open"], limit: 100 },
  });
  assert.deepEqual(inboxReads, [{ tenantId: "tenant:test", state: "open", limit: 500 }]);
  assert.deepEqual(result.snapshot.actionInbox.map(item => item.id), [olderOpen.id]);
  assert.equal(result.snapshot.actionInbox.length === 100, false, "resolved history must not cause a truncation warning");
});

test("Action Inbox claims empty only after every source succeeds", () => {
  const emptySnapshot = { ...snapshot(), actionInbox: [], serviceIncidents: [] };
  const emptyPage = taskAttentionPageSchema.parse({ items: [], nextCursor: null, examined: 0, observedAt: now,
    startsWork: false, planningSource: "configured", deliverySource: "configured",
    sources: { ordinary: "included", ideas: "not_configured" } });
  const ready = renderToStaticMarkup(createElement(ActionInboxPanel, { data: {
    tasks: { state: "available", pages: [emptyPage], truncated: false }, operator: { state: "available",
      source: { observedAt: now, items: emptySnapshot.actionInbox, truncated: false } },
  } satisfies ActionInboxState }));
  assert.match(ready, /No actions are waiting in the sources you can access/);
  const ideaOnly = renderToStaticMarkup(createElement(ActionInboxPanel, { data: {
    tasks: { state: "available", pages: [emptyPage], truncated: false },
    operator: { state: "unavailable", code: "access_denied" },
  } satisfies ActionInboxState }));
  assert.match(ideaOnly, /Workspace action records are not included with Idea Lab-only access/);
  assert.match(ideaOnly, /No actions are waiting in the sources you can access/);
  assert.doesNotMatch(ideaOnly, /role="alert"|This is not an all-clear|Owner access is required to read cross-project task attention/);
  const partial = renderToStaticMarkup(createElement(ActionInboxPanel, { data: {
    tasks: { state: "available", pages: [emptyPage], truncated: false }, operator: { state: "unavailable", code: "request_failed" },
  } satisfies ActionInboxState }));
  assert.match(partial, /No empty inbox or all-clear is inferred/);
  assert.match(partial, /This is not an all-clear/);
  assert.doesNotMatch(partial, /No actions are waiting/);
  const loading = renderToStaticMarkup(createElement(ActionInboxPanel, { data: {
    tasks: { state: "loading" }, operator: { state: "loading" },
  } satisfies ActionInboxState }));
  assert.match(loading, /role="status"/);
  assert.match(loading, /Loading approvals/);
  // The one state the assertions above cannot reach: the task source has not
  // finished reading while the canonical source HAS, and is entitled to an
  // empty answer. `operatorComplete` is true here, so only the task-side
  // condition stands between this render and a claimed empty inbox. A predicate
  // that accepted any non-unavailable task state (`!== "unavailable"`) would
  // read a still-loading source as a read one and claim all-clear over work it
  // has not looked at.
  const tasksStillReading = renderToStaticMarkup(createElement(ActionInboxPanel, { data: {
    tasks: { state: "loading" }, operator: { state: "available",
      source: { observedAt: now, items: emptySnapshot.actionInbox, truncated: false } },
  } satisfies ActionInboxState }));
  assert.doesNotMatch(tasksStillReading, /No actions are waiting in the sources you can access/,
    "a task source that has not finished reading must never back an empty-inbox claim");
  assert.doesNotMatch(tasksStillReading, /role="alert"/,
    "nothing has failed here, so an unfinished read must not be announced as a failure");
  assert.match(tasksStillReading, /Loading approvals/);
});

test("later task pages participate in the one attention-first ordering", () => {
  const normalItems = Array.from({ length: 25 }, (_, index) => ({
    task: { projectId: "project:alpha", jobId: `job:normal-${String(index).padStart(2, "0")}`,
      requestId: `request:normal-${index}`, title: `Preparation ${index}`, state: "proposed" as const, version: 1,
      createdAt: "2026-09-28T09:00:00.000Z", updatedAt: "2026-09-28T10:00:00.000Z" }, inputDigest: digest,
    reasons: ["proposal"],
  }));
  const first = taskAttentionPageSchema.parse({ items: normalItems, nextCursor: "job:normal-24", examined: 25,
    observedAt: now, startsWork: false, planningSource: "configured", deliverySource: "configured",
    sources: { ordinary: "included", ideas: "not_configured" } });
  const later = taskAttentionPageSchema.parse({ items: [{ task: { projectId: "project:alpha", jobId: "job:urgent",
    requestId: "request:urgent", title: "Later failed run", state: "failed", version: 1,
    createdAt: "2026-09-28T09:00:00.000Z", updatedAt: "2026-09-28T11:00:00.000Z" }, inputDigest: digest,
    reasons: ["failed"] }], nextCursor: null, examined: 1, observedAt: now, startsWork: false,
  planningSource: "configured", deliverySource: "configured", sources: { ordinary: "included", ideas: "not_configured" } });
  const ordered = buildActionInbox([first, later]);
  assert.equal(ordered[0]?.title, "Later failed run");
  assert.equal(ordered[1]?.kind, "preparation");
});

test("the canonical attention client uses the owner-scoped endpoint and rejects malformed responses", async () => {
  let requestedUrl = "";
  const available = await readActionInboxSource(async (input, init) => {
    requestedUrl = String(input);
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "same-origin");
    return Response.json({ observedAt: now, items: snapshot().actionInbox, truncated: false });
  });
  assert.equal(requestedUrl, "/api/v1/needs-me/action-items");
  assert.equal(available.state, "available");

  const invalid = await readActionInboxSource(async () => Response.json({ items: [] }));
  assert.deepEqual(invalid, { state: "unavailable", code: "invalid_response" });
  const denied = await readActionInboxSource(async () => new Response(null, { status: 403 }));
  assert.deepEqual(denied, { state: "unavailable", code: "access_denied" });
});
