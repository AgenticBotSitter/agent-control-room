import assert from "node:assert/strict";
import test from "node:test";
import { createTaskHttpHandler } from "../src/web/v1/task-http";
import { authenticatedWebSessionBindingV1 } from "../src/web/v1/access-verifier";
import { LocalOwnerSessionServiceV1, LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import type { WebTaskReviewService } from "../src/web/v1/task-review-service";
import { sha256Digest } from "../src/security";
import { taskDraft, taskFixture } from "./helpers/web-task";
import { now, origin, request, trust } from "./helpers/web-foundation";

test("attested review refuses a two-session cookie handoff before recording", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const localOrigin = "http://127.0.0.1:3210", ownerCode = "owner-code-long-enough-for-review-test";
  const sessions = new LocalOwnerSessionServiceV1(Object.freeze({ schema: LOCAL_OWNER_SESSION_PROFILE_V1,
    origin: localOrigin, tenantId: "tenant:local", provider: "local-owner", subject: "owner:local",
    ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 }));
  const signIn = () => sessions.issue(new Request(`${localOrigin}/api/v1/local-owner-session`, { method: "POST", headers: {
    origin: localOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }),
  ownerCode, now);
  const firstCookie = (await signIn()).cookie.split(";", 1)[0]!, secondCookie = (await signIn()).cookie.split(";", 1)[0]!;
  const authentication = (cookie: string) => authenticatedWebSessionBindingV1(sessions.verify(
    new Request(`${localOrigin}/api/v1/projects`, { headers: { cookie } }), now));
  const firstBinding = authentication(firstCookie), secondBinding = authentication(secondCookie);
  assert.notEqual(firstBinding.sessionEpoch, secondBinding.sessionEpoch);

  const rows: unknown[] = [], saved = new Map<string, unknown>(); let recordCalls = 0;
  const ownerReviews = { async record(_identity: unknown, projectId: string, jobId: string, draft: Record<string, unknown>, key: string) {
    recordCalls += 1;
    const prior = saved.get(key);
    if (prior) return { receipt: prior, replayed: true };
    const receipt = { projectId, jobId, artifactId: draft.artifactId, targetId: draft.targetId,
      targetDigest: draft.targetDigest, contentHash: draft.contentHash, reviewId: "review:session-bound", findingId: null,
      decision: draft.decision, feedbackDigest: sha256Digest(""), recordedAt: new Date(now).toISOString(),
      grantsApproval: false, grantsExecutionAuthority: false, startsRevision: false };
    rows.push(receipt); saved.set(key, receipt); return { receipt, replayed: false };
  } };
  const handler = createTaskHttpHandler({ origin: localOrigin, localOwnerSession: sessions, service: f.tasks,
    ownerReviews: ownerReviews as unknown as WebTaskReviewService, clock: () => now });
  const path = "/api/v1/projects/project:one/tasks/job:one/results/artifact:one/reviews/target:one";
  const review = { artifactId: "artifact:one", targetId: "target:one", targetDigest: sha256Digest("target"),
    contentHash: sha256Digest("content"), decision: "accepted", feedback: "", acceptanceAttestation: {
      scenarioId: "scenario:owner", instructionsDigest: sha256Digest("instructions"), confirmed: true } };
  const body = JSON.stringify({ review, expectedAuthentication: firstBinding });
  const post = (cookie: string, value = body) => new Request(`${localOrigin}${path}`, { method: "POST", headers: {
    origin: localOrigin, "sec-fetch-site": "same-origin", cookie, "content-type": "application/json",
    "idempotency-key": "review-session-bound-key" }, body: value });

  const refused = await handler(post(secondCookie));
  assert.equal(refused.status, 409);
  assert.equal(refused.headers.get("x-control-room-review-refusal"), "authenticated-session-changed");
  assert.deepEqual(await refused.json(), { error: "conflict", refusal: "authenticated-session-changed" });
  assert.equal(recordCalls, 0, "a replaced cookie must be refused before ownerReviews.record");
  assert.equal(rows.length, 0, "a refused handoff must create zero review rows");
  assert.equal((await handler(post(secondCookie, JSON.stringify(review)))).status, 400,
    "an attested legacy request cannot bypass the expected-session comparison");
  assert.equal(recordCalls, 0);
  assert.equal(rows.length, 0);

  const matchingBody = JSON.stringify({ review, expectedAuthentication: secondBinding });
  assert.equal((await handler(post(secondCookie, matchingBody))).status, 201);
  assert.equal(recordCalls, 1);
  assert.equal(rows.length, 1, "the matching authenticated session still records");
  assert.equal((await handler(post(secondCookie, matchingBody))).status, 200);
  assert.equal(recordCalls, 2);
  assert.equal(rows.length, 1, "the byte-identical retry remains idempotent");
});

test("task detail presents only the server-recorded prepared worker", async t => {
  const f = await taskFixture();
  t.after(() => f.db.close());
  const saved = await f.handler(request(f.path, "POST", taskDraft, "prepared-worker-source"));
  assert.equal(saved.status, 201);
  const command = await saved.json() as { receipt: { jobId: string } };
  const detailPath = `${f.path}/${encodeURIComponent(command.receipt.jobId)}`;
  const calls: unknown[][] = [];
  const preparedJobId = "job:prepared-child";
  const handler = createTaskHttpHandler({ origin, trust, service: f.tasks, clock: () => now,
    planning: { async plan() { throw new Error("not reached by task detail"); }, async readPreparedWorker(...input) {
      calls.push(input);
      return "claude" as const;
    }, async readSavedContinuation(_identity, projectId, sourceJobId) {
      const source = await f.tasks.detail(f.identity, projectId, sourceJobId);
      const observedAt = new Date(now).toISOString();
      return { receipt: { projectId, sourceJobId, jobId: preparedJobId, sourceInputDigest: source.inputDigest,
        inputDigest: `sha256:${"f".repeat(64)}`, plannedAt: observedAt, startsWork: false as const, grantsExecutionAuthority: false as const },
      preparedTask: { jobId: preparedJobId, state: "leased" as const, version: 2, updatedAt: observedAt } };
    }, async readConfiguredLocalRoute() { return "configured" as const; } } });

  const response = await handler(request(detailPath));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-control-room-authenticated-actor") ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.match(response.headers.get("x-control-room-session-epoch") ?? "", /^sha256:[a-f0-9]{64}$/u);
  const detail = await response.json() as { preparedFor: unknown; localRouteObservation: { state: unknown; adapter: unknown } };
  assert.equal(detail.preparedFor, "claude");
  assert.deepEqual(detail.localRouteObservation, { state: "not_observed", adapter: "claude" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.slice(1), [f.project.projectId, command.receipt.jobId]);

  const planningResponse = await handler(request(`${detailPath}/plan`));
  assert.equal(planningResponse.status, 200);
  const planning = await planningResponse.json() as {
    availability: string; savedPlan: { jobId: string }; preparedTask: { jobId: string; state: string } };
  assert.equal(planning.availability, "already_planned");
  assert.equal(planning.savedPlan.jobId, preparedJobId);
  assert.deepEqual(planning.preparedTask, { jobId: preparedJobId, state: "leased", version: 2,
    updatedAt: new Date(now).toISOString() });

  // A browser parameter cannot choose a worker or reinterpret the saved plan.
  assert.equal((await handler(request(`${detailPath}?preparedFor=hermes`))).status, 400);
  const withoutPlanning = createTaskHttpHandler({ origin, trust, service: f.tasks, clock: () => now });
  const without = await (await withoutPlanning(request(detailPath))).json() as { preparedFor: unknown; localRouteObservation: unknown };
  assert.equal(without.preparedFor, null);
  assert.deepEqual(without.localRouteObservation, { state: "not_prepared", adapter: null });
});
