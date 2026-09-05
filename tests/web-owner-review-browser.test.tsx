import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding, instant } from "./hermes-native-fixture";
import { request, origin } from "./helpers/web-foundation";
import { createTaskHttpHandler } from "../src/web/v1/task-http";
import { createTaskReviewBrowserClient } from "../src/web/v1/task-review-browser-client";
import { OwnerReviewPanel, OwnerTaskReview } from "../private-app/app/task-owner-review";
import { TaskResultsPanel } from "../private-app/app/task-results";
import { taskResultContentSchema, taskResultsPageSchema } from "../src/web/v1/task-result-wire";
import { WebTaskService } from "../src/web/v1/task-service";
import { sha256Digest } from "../src/security";
import { createTaskReviewWorkspace } from "../src/web/v1/task-review-workspace";
import { TaskDetailResults } from "../private-app/app/task-workspace";
import { taskDetailSchema } from "../src/web/v1/task-wire";
const commandKey = "browser-quality-review-001";

test("page-owned review survives result subtree removal, denied reads and recovery without exposing retained feedback", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const handler = createTaskHttpHandler({ origin, trust: f.accessTrust, service: f.tasks, ownerReviews: f.reviews, clock: () => instant + 6000 });
  let phase: "lost" | "denied" | "recover" = "lost";
  const keys: string[] = [], bodies: string[] = [];
  const workspace = createTaskReviewWorkspace(() => createTaskReviewBrowserClient(async (url, init) => {
    if (init?.method === "POST") { keys.push(new Headers(init.headers).get("idempotency-key")!); bodies.push(String(init.body)); }
    if (phase === "denied") return Response.json({}, { status: 403 });
    const response = await handler(request(String(url), init?.method, init?.body ? JSON.parse(String(init.body)) : undefined,
      new Headers(init?.headers).get("idempotency-key") ?? undefined, f.jwt));
    if (phase === "lost") throw new Error("synthetic_lost_ack");
    return response;
  }, () => commandKey));
  const bound = { projectId: binding.projectId, jobId: binding.jobId, ...f.draft };
  const detail = taskDetailSchema.parse(await f.tasks.detail(f.identity, binding.projectId, binding.jobId));
  const mounted = TaskDetailResults({ detail, projectId: binding.projectId, reviewWorkspace: workspace });
  assert.equal(mounted?.props.reviewWorkspace, workspace);
  const first = workspace.get(bound); first.setFeedback("Retained private revision draft");
  let notifications = 0;
  const detach = first.subscribe(() => { notifications++; });
  await first.save("changes_requested"); assert.equal(first.client.hasPending(), true); assert.ok(notifications > 0);
  detach(); // A denied result refresh removes the child subscriber, not the task page's workspace.
  // The actual task-detail read gate also removes the entire result subtree on failure.
  assert.equal(TaskDetailResults({ detail: undefined, projectId: binding.projectId, reviewWorkspace: workspace }), null);
  phase = "denied";
  await assert.rejects(first.client.options(bound.projectId, bound.jobId, f.draft), { code: "access_denied" });
  const restored = workspace.get(bound); assert.equal(restored, first);
  const protectedShell = renderToStaticMarkup(createElement(OwnerTaskReview, { ...bound, workspace, onSaved() {} }));
  assert.doesNotMatch(protectedShell, /Retained private revision draft|A useful private result|<textarea|Saved:/);
  assert.match(protectedShell, /earlier save is unresolved/);
  await restored.save(); assert.equal(restored.client.hasPending(), true);
  assert.equal(restored.getSnapshot().feedback, "Retained private revision draft");
  phase = "recover"; const checkpoint = f.checkpoints.read(`completion-gate:${binding.tenantId}`);
  const remounted = TaskDetailResults({ detail, projectId: binding.projectId, reviewWorkspace: workspace });
  assert.equal(remounted?.props.reviewWorkspace, workspace);
  assert.equal(remounted?.props.reviewWorkspace.get(bound), first);
  await restored.save(); assert.equal(restored.client.hasPending(), false);
  assert.equal(restored.getSnapshot().receipt?.decision, "changes_requested"); assert.equal(restored.getSnapshot().feedback, "");
  assert.equal(new Set(keys).size, 1); assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(f.checkpoints.read(`completion-gate:${binding.tenantId}`), checkpoint);
  assert.equal((await f.db.query("SELECT * FROM control_web_task_review_commands")).rows.length, 1);
});

test("page-owned unsaved drafts survive result close/reopen and never follow a different exact binding", () => {
  const workspace = createTaskReviewWorkspace();
  const bound = { projectId: "project:one", jobId: "job:one", artifactId: "artifact:one", targetId: "target:one",
    targetDigest: sha256Digest("target"), contentHash: sha256Digest("content") };
  const session = workspace.get(bound); session.setFeedback("An unsaved owner draft");
  const detach = session.subscribe(() => {}); detach();
  assert.equal(workspace.get(bound).getSnapshot().feedback, "An unsaved owner draft");
  for (const field of Object.keys(bound) as (keyof typeof bound)[])
    assert.equal(workspace.get({ ...bound, [field]: `${bound[field]}-other` }).getSnapshot().feedback, "");
  assert.equal(createTaskReviewWorkspace().get(bound).getSnapshot().feedback, "");
});

test("in-flight save completes in page memory while the result subtree is detached and prevents concurrent replacement", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const receipt = (await f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, commandKey)).receipt;
  let release!: (response: Response) => void, calls = 0;
  const workspace = createTaskReviewWorkspace(() => createTaskReviewBrowserClient(async () => {
    calls++; return new Promise<Response>(resolve => { release = resolve; });
  }, () => commandKey));
  const bound = { projectId: binding.projectId, jobId: binding.jobId, ...f.draft };
  const session = workspace.get(bound), detach = session.subscribe(() => {});
  const saving = session.save("accepted"); detach();
  assert.equal(workspace.get(bound).getSnapshot().pending, true);
  await workspace.get(bound).save("changes_requested"); assert.equal(calls, 1);
  release(Response.json({ receipt, replayed: true })); await saving;
  assert.equal(workspace.get(bound).getSnapshot().pending, false);
  assert.deepEqual(workspace.get(bound).getSnapshot().receipt, receipt);
});

test("workspace capacity never evicts existing drafts or throws out of the owner review component", () => {
  const workspace = createTaskReviewWorkspace();
  const bound = { projectId: "project:one", jobId: "job:one", artifactId: "artifact:one", targetId: "target:one",
    targetDigest: sha256Digest("target"), contentHash: sha256Digest("content") };
  const existing = workspace.get(bound); existing.setFeedback("Retained draft at capacity");
  for (let i = 1; i < 128; i++) workspace.get({ ...bound, artifactId: `artifact:${i}` });
  const shell = renderToStaticMarkup(createElement(OwnerTaskReview, { ...bound, artifactId: "artifact:overflow", workspace, onSaved() {} }));
  assert.match(shell, /workspace limit/); assert.doesNotMatch(shell, /Retained draft at capacity/);
  assert.equal(workspace.get(bound), existing); assert.equal(existing.getSnapshot().feedback, "Retained draft at capacity");
});

test("real browser client only writes on an explicit quality command and reads the saved immutable feedback", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const handler = createTaskHttpHandler({ origin, trust: f.accessTrust, service: f.tasks, ownerReviews: f.reviews, clock: () => instant + 6000 });
  const calls: string[] = [];
  const client = createTaskReviewBrowserClient(async (url, init) => {
    assert.equal(init?.cache, "no-store"); assert.equal(init?.redirect, "error");
    calls.push(init!.method!); return handler(request(String(url), init?.method,
      init?.body ? JSON.parse(String(init.body)) : undefined, new Headers(init?.headers).get("idempotency-key") ?? undefined, f.jwt));
  }, () => commandKey);
  await client.options(binding.projectId, binding.jobId, f.draft); await client.options(binding.projectId, binding.jobId, f.draft);
  assert.deepEqual(calls, ["GET", "GET"]);
  const feedback = "Please include a plain-language example <b>as text</b>.";
  const receipt = await client.record(binding.projectId, binding.jobId, { ...f.draft, decision: "changes_requested", feedback });
  assert.equal(receipt.startsRevision, false); assert.equal(client.hasPending(), false);
  const options = await client.options(binding.projectId, binding.jobId, f.draft);
  assert.equal(options.canReview, false); assert.equal(options.ownReview?.feedback, feedback);
  assert.deepEqual(calls, ["GET", "GET", "POST", "GET"]);
});

test("uncertain quality save retains exact identity through later denial and reconciles without duplicate review", async t => {
  const f = await ownerReviewFixture(); t.after(f.close); let phase: "lost" | "denied" | "recover" = "lost";
  const handler = createTaskHttpHandler({ origin, trust: f.accessTrust, service: f.tasks, ownerReviews: f.reviews, clock: () => instant + 6000 });
  const keys: string[] = [], bodies: string[] = [];
  const client = createTaskReviewBrowserClient(async (url, init) => {
    if (init?.method === "POST") { keys.push(new Headers(init.headers).get("idempotency-key")!); bodies.push(String(init.body)); }
    if (phase === "denied") return Response.json({ error: "access_denied" }, { status: 403 });
    const response = await handler(request(String(url), init?.method, init?.body ? JSON.parse(String(init.body)) : undefined,
      new Headers(init?.headers).get("idempotency-key") ?? undefined, f.jwt));
    if (phase === "lost") { assert.equal(response.status, 201); throw new Error("synthetic_lost_response"); }
    return response;
  }, () => commandKey);
  await assert.rejects(client.record(binding.projectId, binding.jobId, f.draft), { code: "uncertain" });
  phase = "denied"; await assert.rejects(client.retrySave(), { code: "access_denied" }); assert.equal(client.hasPending(), true);
  await assert.rejects(client.record(binding.projectId, binding.jobId, { ...f.draft, decision: "changes_requested", feedback: "Different" }), { code: "uncertain" });
  const checkpoint = f.checkpoints.read(`completion-gate:${binding.tenantId}`);
  phase = "recover"; const receipt = await client.retrySave();
  assert.equal(client.hasPending(), false); assert.equal(receipt.decision, "accepted");
  assert.equal(new Set(keys).size, 1); assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(f.checkpoints.read(`completion-gate:${binding.tenantId}`), checkpoint);
  assert.equal((await f.db.query("SELECT * FROM control_web_task_review_commands")).rows.length, 1);
});

test("each later definitive denial preserves an already uncertain review but a first definite rejection releases it", async t => {
  for (const status of [400, 401, 403, 404, 409]) {
    const f = await ownerReviewFixture(); t.after(f.close); let lost = true;
    const client = createTaskReviewBrowserClient(async () => { if (lost) { lost = false; throw new Error(); }
      return Response.json({}, { status }); }, () => commandKey);
    await assert.rejects(client.record(binding.projectId, binding.jobId, f.draft));
    await assert.rejects(client.retrySave()); assert.equal(client.hasPending(), true);
    const definite = createTaskReviewBrowserClient(async () => Response.json({}, { status }), () => commandKey);
    await assert.rejects(definite.record(binding.projectId, binding.jobId, f.draft)); assert.equal(definite.hasPending(), false);
  }
});

test("browser rejects mismatched receipt and option evidence without discarding an uncertain save", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const result = await f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, commandKey);
  for (const receipt of [{ ...result.receipt, targetDigest: sha256Digest("other") }, { ...result.receipt, artifactId: "artifact:other" },
    { ...result.receipt, feedbackDigest: sha256Digest("other") }, { ...result.receipt, grantsExecutionAuthority: true }]) {
    const client = createTaskReviewBrowserClient(async () => Response.json({ receipt, replayed: true }), () => commandKey);
    await assert.rejects(client.record(binding.projectId, binding.jobId, f.draft), { code: "uncertain" }); assert.equal(client.hasPending(), true);
  }
  const options = await f.reviews.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id);
  for (const changed of [{ ...options, contentHash: sha256Digest("other") }, { ...options, canReview: true },
    { ...options, ownReview: { ...options.ownReview, contentHash: sha256Digest("other") } }])
    await assert.rejects(createTaskReviewBrowserClient(async () => Response.json(changed)).options(binding.projectId, binding.jobId, f.draft), { code: "unavailable" });
});

test("owner controls render exact file identity, escaped feedback, disabled uncertainty and quality-only actions", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const options = await f.reviews.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id);
  const render = (pending = false, held = false) => renderToStaticMarkup(createElement(OwnerReviewPanel,
    { options, feedback: "Please fix <b>this detail</b>.", pending, held, onFeedback() {}, onRecord() {} }));
  assert.match(render(), /Accept quality/); assert.match(render(), /Request changes/); assert.match(render(), /&lt;b&gt;this detail&lt;\/b&gt;/);
  assert.doesNotMatch(render(), /<b>this detail|Approve execution/); assert.match(render(true), /button[^>]*disabled/);
  assert.match(render(false, true), /textarea[^>]*disabled/);
  const shell = renderToStaticMarkup(createElement(OwnerTaskReview, { projectId: binding.projectId, jobId: binding.jobId,
    ...f.draft, onSaved() {} }));
  assert.match(shell, /Loading owner review/); assert.doesNotMatch(shell, /<button|A useful private result/);
});

test("private task page mounts owner controls only for the matching open result when explicitly configured", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const tasks = new WebTaskService(f.db, f.scope, () => instant + 6000, f.ownerKeys);
  const page = taskResultsPageSchema.parse(await tasks.results(f.identity, binding.projectId, binding.jobId));
  const content = taskResultContentSchema.parse(await tasks.results(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId));
  const render = (source = page, value = content) => renderToStaticMarkup(createElement(TaskResultsPanel,
    { page: source, content: value, pending: false, onOpen() {}, onClose() {} }));
  assert.match(render(), /Loading owner review/);
  assert.doesNotMatch(render({ ...page, reviewCommands: "not_connected" }), /Loading owner review/);
  assert.doesNotMatch(render(page, { ...content, artifact: { ...content.artifact, artifactId: "artifact:different" } }), /Loading owner review/);
  assert.doesNotMatch(render(page, { ...content, artifact: { ...content.artifact, contentHash: sha256Digest("different") } }), /Loading owner review/);
});
