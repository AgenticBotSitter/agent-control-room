import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createTaskExecutionWorkspace } from "../src/web/v1/task-execution-workspace";
import { createTaskSubmissionBrowserClient } from "../src/web/v1/task-submission-browser-client";
import { createTaskApprovalBrowserClient } from "../src/web/v1/task-approval-browser-client";
import { createTaskPlanningBrowserClient } from "../src/web/v1/task-planning-browser-client";
import { createTaskAssignmentBrowserClient } from "../src/web/v1/task-assignment-browser-client";
import { TaskApprovalSubmission } from "../private-app/app/task-approval";
import type { TaskDetail } from "../src/web/v1/task-wire";
import type { TaskApprovalRead } from "../src/web/v1/task-approval-wire";

const digest = `sha256:${"a".repeat(64)}`;
const bound = { projectId: "project:test", jobId: "job:test", inputDigest: digest, packetDigest: digest };
const args = [bound.projectId, bound.jobId, bound.inputDigest, bound.packetDigest] as const;
const receipt = { projectId: bound.projectId, jobId: bound.jobId, attemptId: "attempt:test", queueId: "queue:test",
  packetDigest: digest, operationDigest: digest, queuedAt: "2026-09-08T07:30:00.000Z", evidence: "recorded_delivery_intent",
  startsWork: false, grantsExecutionAuthority: false };
const read = (value: unknown = receipt) => ({ projectId: bound.projectId, jobId: bound.jobId, inputDigest: digest, receipt: value });
// Projection-only fixture: authorization and wire validation are tested by the existing HTTP suites.
const detail = { task: { projectId: bound.projectId, jobId: bound.jobId }, inputDigest: digest } as TaskDetail;
const state: TaskApprovalRead = { projectId: bound.projectId, jobId: bound.jobId, inputDigest: digest,
  receipt: { projectId: bound.projectId, jobId: bound.jobId, attemptId: "attempt:test", packetDigest: digest,
    operationDigest: digest, acceptedAt: receipt.queuedAt, startsWork: false, grantsExecutionAuthority: false, evidence: "stored_signatures_only" } };

test("submission uncertainty survives protected subtree removal and null or denied reads without another POST", async () => {
  let phase: "null" | "denied" | "saved" = "null";
  const methods: string[] = [];
  const workspace = createTaskExecutionWorkspace({ submission: () => createTaskSubmissionBrowserClient(async (_url, init) => {
    methods.push(init!.method!);
    if (init?.method === "POST") throw new Error("synthetic lost queue response");
    return phase === "denied" ? Response.json({}, { status: 401 }) : Response.json(read(phase === "saved" ? receipt : null));
  }) });
  const initial = TaskApprovalSubmission({ detail, checked: detail, state, workspace });
  assert.ok(initial && "client" in initial.props);
  const client = workspace.submission(bound); assert.equal(initial.props.client, client);
  assert.equal(workspace.hasPending(), false);
  await assert.rejects(client.submit(...args), { code: "uncertain" }); assert.equal(workspace.hasPending(), true);
  assert.equal(TaskApprovalSubmission({ detail: undefined, checked: detail, state, workspace }), null);
  const refreshed = { ...detail };
  assert.equal(TaskApprovalSubmission({ detail: refreshed, checked: detail, state, workspace }), null);
  const remounted = TaskApprovalSubmission({ detail: refreshed, checked: refreshed, state, workspace });
  assert.ok(remounted && "client" in remounted.props); assert.equal(remounted.props.client, client);
  const html = renderToStaticMarkup(remounted);
  assert.match(html, /Submission could not be confirmed/);
  assert.match(html, /button[^>]*disabled[^>]*>Queue approved task/);
  assert.doesNotMatch(html, /No submission was recorded/);
  await client.read(...args); assert.equal(workspace.hasPending(), true);
  phase = "denied"; await assert.rejects(client.read(...args)); assert.equal(workspace.hasPending(), true);
  await assert.rejects(workspace.submission(bound).submit(...args), { code: "uncertain" });
  phase = "saved"; await workspace.submission(bound).read(...args);
  assert.equal(workspace.hasPending(), false);
  assert.deepEqual(methods, ["POST", "GET", "GET", "GET"]);
  assert.equal(TaskApprovalSubmission({ detail, checked: detail, state: { ...state, jobId: "job:other" }, workspace }), null);
});

test("in-flight queue command stays owned after panel removal and only exact readback clears uncertainty", async () => {
  let release!: () => void, writes = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const workspace = createTaskExecutionWorkspace({ submission: () => createTaskSubmissionBrowserClient(async (_url, init) => {
    if (init?.method === "POST") { writes++; await waiting; throw new Error("lost"); }
    return Response.json(read());
  }) });
  const client = workspace.submission(bound), saving = client.submit(...args);
  assert.equal(workspace.hasPending(), true);
  assert.equal(TaskApprovalSubmission({ detail: undefined, workspace }), null);
  await assert.rejects(workspace.submission(bound).submit(...args));
  release(); await assert.rejects(saving); assert.equal(workspace.hasPending(), true);
  await client.read(...args); assert.equal(workspace.hasPending(), false); assert.equal(writes, 1);
});

test("submission bindings are bounded and isolated without evicting earlier uncertainty", async () => {
  let factories = 0;
  const workspace = createTaskExecutionWorkspace({ submission: () => { factories++;
    return createTaskSubmissionBrowserClient(async () => { throw new Error("lost"); }); } });
  assert.throws(() => workspace.submission({ ...bound, inputDigest: "invalid" })); assert.equal(factories, 0);
  const first = workspace.submission(bound); await assert.rejects(first.submit(...args));
  for (const field of Object.keys(bound) as (keyof typeof bound)[]) {
    const other = workspace.submission({ ...bound, [field]: field.endsWith("Digest") ? `sha256:${"b".repeat(64)}` : `${bound[field]}:other` });
    assert.notEqual(other, first); assert.equal(other.hasPending(), false);
  }
  for (let index = 5; index < 128; index++) workspace.submission({ ...bound, jobId: `job:${index}` });
  assert.equal(factories, 128);
  assert.throws(() => workspace.submission({ ...bound, jobId: "job:overflow" }), { code: "unavailable" });
  assert.equal(workspace.submission(bound), first); assert.equal(workspace.hasPending(), true);
});

test("page navigation aggregate covers planning, assignment and approval including pre-transfer digest preparation", async () => {
  const lost = async () => { throw new Error("synthetic response loss"); };
  for (const operation of ["planning", "assignment", "approval"] as const) {
    const workspace = createTaskExecutionWorkspace({ planning: () => createTaskPlanningBrowserClient(lost),
      assignment: () => createTaskAssignmentBrowserClient(lost), approval: () => createTaskApprovalBrowserClient(lost) });
    assert.equal(workspace.hasPending(), false);
    const attempt = operation === "planning" ? workspace.planning.prepare(bound.projectId, bound.jobId, digest)
      : operation === "assignment" ? workspace.assignment.change(bound.projectId, bound.jobId,
        { action: "assign", expectedInputDigest: digest, nodeId: "node:test" })
      : workspace.approval.store(bound.projectId, bound.jobId, digest, JSON.stringify({ synthetic: true }));
    assert.equal(workspace.hasPending(), true, operation);
    await assert.rejects(attempt); assert.equal(workspace.hasPending(), true, operation);
  }
});
