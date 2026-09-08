import assert from "node:assert/strict";
import test from "node:test";
import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnerTaskReview } from "../private-app/app/task-owner-review";
import { OwnerRevisionPanel } from "../private-app/app/task-owner-revision";
import { TaskResultsPanel } from "../private-app/app/task-results";
import { BrowserRequestError } from "../src/web/v1/browser-client";
import { createTaskReviewBrowserClient } from "../src/web/v1/task-review-browser-client";
import { createTaskReviewWorkspace } from "../src/web/v1/task-review-workspace";
import { createTaskRevisionBrowserClient, revisionRequestFromReview } from "../src/web/v1/task-revision-browser-client";
import { taskResultContentSchema, taskResultsPageSchema } from "../src/web/v1/task-result-wire";
import { taskRevisionReceiptSchema } from "../src/web/v1/task-revision-wire";
import { taskReviewOptionsSchema } from "../src/web/v1/task-review-wire";
import { sha256Digest } from "../src/security";

const feedback = "Add an exact evidence source and explain the result.";
const binding = { projectId: "project:test", jobId: "job:source", artifactId: "artifact:result", targetId: "target:result",
  targetDigest: sha256Digest("target"), contentHash: sha256Digest("content") };
const runId = "run:source";
const options = taskReviewOptionsSchema.parse({ ...binding, canReview: false, availability: "already_reviewed",
  ownReview: { reviewId: "review:owner", findingId: "finding:owner", artifactId: binding.artifactId,
    targetId: binding.targetId, targetDigest: binding.targetDigest, contentHash: binding.contentHash,
    decision: "changes_requested", feedback, recordedAt: "2026-09-05T12:00:00.000Z" },
  grantsExecutionAuthority: false, revisionPlanning: "configured" });
const revisionRequest = revisionRequestFromReview(runId, options)!;
const receipt = taskRevisionReceiptSchema.parse({ projectId: binding.projectId, sourceJobId: binding.jobId,
  jobId: "job:revision", sourceInputDigest: sha256Digest("source input"), inputDigest: sha256Digest("revision input"),
  plannedAt: "2026-09-05T12:01:00.000Z", startsWork: false, grantsExecutionAuthority: false,
  rootSubjectId: binding.jobId, rootTargetId: binding.targetId, fromRunId: runId, fromTargetId: binding.targetId,
  fromTargetDigest: binding.targetDigest, fromContentHash: binding.contentHash, reviewId: "review:owner",
  feedbackDigest: sha256Digest(feedback), revisionNumber: 1,
  executionAvailability: "requires_separate_assignment_and_approval" });
const command = { receipt, replayed: false };

test("only an exact saved changes-request review can construct the immutable revision request", () => {
  const before = structuredClone(options);
  assert.deepEqual(revisionRequest, { runId, targetId: binding.targetId, targetDigest: binding.targetDigest,
    contentHash: binding.contentHash, reviewId: options.ownReview!.reviewId, feedback });
  assert.deepEqual(options, before);
  assert.equal(revisionRequestFromReview(undefined, options), undefined);
  assert.equal(revisionRequestFromReview(runId, { ...options, ownReview: null }), undefined);
  for (const ownReview of [
    { ...options.ownReview!, decision: "accepted" as const, findingId: null, feedback: "" },
    { ...options.ownReview!, findingId: null },
    { ...options.ownReview!, artifactId: "artifact:other" },
    { ...options.ownReview!, targetId: "target:other" },
    { ...options.ownReview!, targetDigest: sha256Digest("other target") },
    { ...options.ownReview!, contentHash: sha256Digest("other content") },
    { ...options.ownReview!, feedback: ` ${feedback}` },
  ]) assert.equal(revisionRequestFromReview(runId, { ...options, ownReview }), undefined);
});

test("revision browser client writes only on explicit prepare and binds the complete response identity", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createTaskRevisionBrowserClient(async (url, init) => {
    calls.push({ url: String(url), init: init! }); return Response.json(command);
  });
  assert.equal(client.hasPending(), false); assert.equal(calls.length, 0);
  const saved = await client.prepare(binding.projectId, binding.jobId, revisionRequest);
  assert.deepEqual(saved, receipt); assert.equal(client.hasPending(), false); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v1/projects/project%3Atest/tasks/job%3Asource/revisions");
  assert.equal(calls[0].init.method, "POST"); assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.cache, "no-store"); assert.equal(calls[0].init.redirect, "error");
  assert.equal(new Headers(calls[0].init.headers).has("idempotency-key"), false);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), revisionRequest);
  assert.deepEqual(client.savedReceipt(binding.projectId, binding.jobId, revisionRequest), receipt);
  saved.jobId = "job:mutated";
  assert.deepEqual(client.savedReceipt(binding.projectId, binding.jobId, revisionRequest), receipt);
  assert.equal(client.savedReceipt(binding.projectId, "job:other", revisionRequest), undefined);
  assert.equal(client.savedReceipt(binding.projectId, binding.jobId, { ...revisionRequest, reviewId: "review:other" }), undefined);

  const changed = [
    { projectId: "project:other" }, { sourceJobId: "job:other" }, { jobId: binding.jobId },
    { fromRunId: "run:other" }, { fromTargetId: "target:other" }, { fromTargetDigest: sha256Digest("wrong target") },
    { fromContentHash: sha256Digest("wrong content") }, { reviewId: "review:other" }, { feedbackDigest: sha256Digest("wrong feedback") },
    { startsWork: true }, { grantsExecutionAuthority: true }, { executionAvailability: "revision_submission_not_connected" },
  ];
  for (const patch of changed) {
    const invalid = createTaskRevisionBrowserClient(async () => Response.json({ ...command, receipt: { ...receipt, ...patch } }));
    await assert.rejects(invalid.prepare(binding.projectId, binding.jobId, revisionRequest), { code: "uncertain" });
    assert.equal(invalid.hasPending(), true);
  }
});

test("page-owned revision uncertainty retains one exact body across detach, denial and explicit reconciliation", async () => {
  let phase: "lost" | "denied" | "saved" = "lost", writes = 0;
  const bodies: string[] = [];
  const revisionClient = createTaskRevisionBrowserClient(async (_url, init) => {
    writes++; bodies.push(String(init?.body));
    if (phase === "lost") throw new Error("synthetic_lost_response");
    if (phase === "denied") return Response.json({}, { status: 403 });
    return Response.json({ ...command, replayed: true });
  });
  const workspace = createTaskReviewWorkspace(
    () => createTaskReviewBrowserClient(async () => Response.json(options)), () => revisionClient);
  const session = workspace.get(binding); let notifications = 0;
  const detach = session.subscribe(() => { notifications++; });
  assert.equal(await session.prepareRevision(revisionRequest), undefined);
  assert.equal(session.revisionClient.hasPending(), true); assert.equal(session.getSnapshot().revisionPending, false);
  assert.equal(session.getSnapshot().revisionError?.code, "uncertain"); assert.ok(notifications > 0); detach();
  assert.equal(workspace.get(binding), session);
  assert.equal(await session.prepareRevision({ ...revisionRequest, reviewId: "review:other" }), undefined);
  assert.equal(writes, 1); assert.equal(session.getSnapshot().revisionError?.code, "uncertain");
  phase = "denied"; assert.equal(await session.prepareRevision(), undefined);
  assert.equal(session.revisionClient.hasPending(), true); assert.equal(session.getSnapshot().revisionError?.code, "access_denied");
  phase = "saved"; assert.deepEqual(await workspace.get(binding).prepareRevision(), receipt);
  assert.equal(session.revisionClient.hasPending(), false); assert.deepEqual(session.getSnapshot().revisionReceipt, receipt);
  assert.equal(new Set(bodies).size, 1); assert.deepEqual(JSON.parse(bodies[0]), revisionRequest);
  assert.equal(workspace.get({ ...binding, artifactId: "artifact:other" }).getSnapshot().revisionReceipt, undefined);
});

test("definitive first denials release revision holds while malformed and server failures retain them", async () => {
  for (const status of [400, 401, 403, 404, 409]) {
    const client = createTaskRevisionBrowserClient(async () => Response.json({}, { status }));
    await assert.rejects(client.prepare(binding.projectId, binding.jobId, revisionRequest));
    assert.equal(client.hasPending(), false);
  }
  for (const response of [() => new Response("not-json"), () => Response.json({ value: "x".repeat(20_000) }),
    () => Response.json({}, { status: 503 })]) {
    const client = createTaskRevisionBrowserClient(async () => response());
    await assert.rejects(client.prepare(binding.projectId, binding.jobId, revisionRequest), { code: "uncertain" });
    assert.equal(client.hasPending(), true);
  }
  let finish!: (response: Response) => void, calls = 0;
  const client = createTaskRevisionBrowserClient(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = client.prepare(binding.projectId, binding.jobId, revisionRequest);
  await assert.rejects(client.prepare(binding.projectId, binding.jobId, revisionRequest), { code: "uncertain" });
  assert.equal(calls, 1); finish(Response.json(command)); await first;
});

test("bounded page workspace never evicts an unresolved revision command", async () => {
  const pendingClient = createTaskRevisionBrowserClient(async () => { throw new Error("lost"); });
  const workspace = createTaskReviewWorkspace(undefined, () => pendingClient);
  assert.equal(workspace.hasPending(), false);
  const first = workspace.get(binding); await first.prepareRevision(revisionRequest);
  assert.equal(workspace.hasPending(), true);
  assert.equal(first.revisionClient.hasPending(), true);
  for (let index = 1; index < 128; index++) workspace.get({ ...binding, artifactId: `artifact:${index}` });
  assert.throws(() => workspace.get({ ...binding, artifactId: "artifact:overflow" }), { code: "unavailable" });
  assert.equal(workspace.get(binding), first); assert.equal(first.revisionClient.hasPending(), true);
  assert.equal(workspace.hasPending(), true);
  assert.deepEqual(first.getSnapshot().revisionError, new BrowserRequestError("uncertain"));
});

test("revision panel names preparation truthfully and exposes only the eligible explicit action or exact check", () => {
  const props = { options, request: revisionRequest, eligible: true, pending: false, held: false,
    onPrepare() {}, onCheck() {} };
  const available = renderToStaticMarkup(<OwnerRevisionPanel {...props} />);
  assert.match(available, /Prepare revised task/); assert.match(available, /exact changes recorded in your review/);
  assert.match(available, /does not start an agent/); assert.match(available, /needs its own assignment and approval/);
  assert.doesNotMatch(available, /Approve execution|Complete this task|Check this exact revision preparation/);
  assert.equal(renderToStaticMarkup(<OwnerRevisionPanel {...props} request={undefined} />), "");
  const disconnected = renderToStaticMarkup(<OwnerRevisionPanel {...props} options={{ ...options, revisionPlanning: "not_connected" }} />);
  assert.match(disconnected, /not connected/); assert.doesNotMatch(disconnected, /<button/);
  const ineligible = renderToStaticMarkup(<OwnerRevisionPanel {...props} eligible={false} />);
  assert.match(ineligible, /no longer awaiting a revision/); assert.doesNotMatch(ineligible, /<button/);
  const held = renderToStaticMarkup(<OwnerRevisionPanel {...props} held />);
  assert.match(held, /Check this exact revision preparation/); assert.doesNotMatch(held, />Prepare revised task<\/button/);
  const pending = renderToStaticMarkup(<OwnerRevisionPanel {...props} held pending />);
  assert.match(pending, /button[^>]*disabled/); assert.match(pending, /Checking revision preparation/);
  const saved = renderToStaticMarkup(<OwnerRevisionPanel {...props} receipt={receipt} />);
  assert.match(saved, /Revision 1 is prepared/); assert.match(saved, /Open revised task/); assert.doesNotMatch(saved, /<button/);
});

function descendants(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!isValidElement(node)) return [];
  return [node, ...descendants((node.props as { children?: ReactNode }).children)];
}

test("result panel passes revision eligibility and producer run only for the exact open file and target", () => {
  const artifact = { artifactId: binding.artifactId, attemptId: "attempt:source", runId, contentHash: binding.contentHash,
    sizeBytes: 20, receivedAt: "2026-09-05T11:59:00.000Z", byteCheck: "matched_recorded_claim" as const, qualityAccepted: false as const };
  const review = { targetId: binding.targetId, kind: "document" as const, targetDigest: binding.targetDigest,
    contentHash: binding.contentHash, revision: 0, supersedesTargetId: null, status: "changes_requested" as const,
    matchingArtifactIds: [binding.artifactId], additionalEvidenceOmitted: false,
    reviews: [], verifications: [], findings: [], missingVerificationScenarioIds: [], openFindingCount: 1,
    grantsApproval: false as const, grantsExecutionAuthority: false as const };
  const page = taskResultsPageSchema.parse({ projectId: binding.projectId, jobId: binding.jobId,
    observedAt: "2026-09-05T12:00:00.000Z", resultSource: "configured", reviewSource: "configured",
    items: [artifact], reviews: [review], additionalResultsOmitted: false, additionalTargetsOmitted: false,
    canReadContent: true, reviewCommands: "configured", verificationCommands: "not_connected" });
  const content = taskResultContentSchema.parse({ projectId: binding.projectId, jobId: binding.jobId, artifact,
    text: "Exact result content.", contentVerifiedAt: "2026-09-05T12:00:00.000Z", untrustedContent: true });
  const controls = (source = page, opened = content) => {
    const matches = descendants(TaskResultsPanel({ page: source, content: opened,
      pending: false, onOpen() {}, onClose() {} })).filter(element => element.type === OwnerTaskReview);
    return matches as ReactElement<ComponentProps<typeof OwnerTaskReview>>[];
  };
  assert.equal(controls().length, 1); assert.equal(controls()[0].props.runId, runId); assert.equal(controls()[0].props.revisionEligible, true);
  assert.equal(controls({ ...page, reviews: [{ ...review, status: "pending" }] })[0].props.revisionEligible, false);
  assert.equal(controls({ ...page, reviewCommands: "not_connected" }).length, 0);
  assert.equal(controls(page, { ...content, artifact: { ...artifact, artifactId: "artifact:other" } }).length, 0);
  assert.equal(controls(page, { ...content, artifact: { ...artifact, contentHash: sha256Digest("other") } }).length, 0);
});
