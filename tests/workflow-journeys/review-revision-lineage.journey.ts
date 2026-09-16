/**
 * Issue #208 journey: the protected owner review and revision-lineage path.
 *
 * Issue #208's acceptance requires the review/revision path to be proven, not
 * described. This journey drives the compiled two-role application
 * (`dist-vps`) with the same protected browser client the private task views
 * use, over the real HTTP routes:
 *
 *   - an unauthenticated review attempt is refused (the route is protected);
 *   - a saved owner review with `changes_requested` is recorded through the
 *     compiled handler and reports `startsRevision: false`;
 *   - the review's own note is read back and turned into the revision request
 *     through `revisionRequestFromReview`, the only producer the browser has;
 *   - the revision plan is prepared through `createTaskRevisionBrowserClient`
 *     and the receipt keeps the full lineage (root subject/target, source run,
 *     source target digest, content hash, review id, feedback digest, revision
 *     number 1) while `startsWork: false` and
 *     `executionAvailability: "requires_separate_assignment_and_approval"`;
 *   - canonical storage holds a proposed child job with no attempt, its source
 *     job/attempt/lease/target/checkpoint are unchanged, and the native executor
 *     recorded no call and no effect — no agent work and no installation start;
 *   - an exact replay is inert: the same receipt, one audit record, no new plan.
 *
 * This is the reuse path `tests/vps-built-revision-planning.test.mjs` and
 * `tests/vps-built-owner-revision-interface.test.mjs` already exercise; the
 * completion that produces the reviewed result comes from the existing synthetic
 * native fixture, which is named in the findings rather than presented as a live
 * agent run.
 */
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
// The compiled application is a build artifact (`pnpm build` writes `dist-vps`), so it is absent
// from a clean checkout: the `quick` lane type-checks this file before any build, where a static
// import of `../../dist-vps/server/index.js` fails with TS2307. The four entry points are therefore
// loaded through a computed specifier at run time, and the signatures still come from the source
// modules that build compiles (see `vite.vps.config.ts`), so this file stays typed.
import type { createPrivateNodeHandler as createPrivateNodeHandlerFactory,
  loadPrivateClientAssets as loadPrivateClientAssetsFactory } from "../../src/web/v1/private-serving";
import type { createPrivateTaskBootstrap as createPrivateTaskBootstrapFactory } from "../../src/web/v1/private-task-startup";
import type { installPrivateApplication as installPrivateApplicationFactory } from "../../src/web/v1/private-process";
import { createTaskRevisionBrowserClient, revisionRequestFromReview } from "../../src/web/v1/task-revision-browser-client";
import { CanonicalStore } from "../../src/persistence/canonical-store";
import { nativeQualityCompletionFixture } from "../helpers/native-quality-completion";
import { taskStartupFixture } from "../helpers/task-startup";
import { nodeExchange } from "../helpers/web-node";
import { origin, request } from "../helpers/web-foundation";
import type { JobRecord, RequestRecord, WorkflowRecord } from "../../src/domain/v1/types";
import type { JourneyOutcomeV1 } from "./attributed-cases";

// Signatures of the compiled entry points, taken from the source modules the build compiles.
type CompiledServingModule = {
  createPrivateNodeHandler: typeof createPrivateNodeHandlerFactory;
  loadPrivateClientAssets: typeof loadPrivateClientAssetsFactory;
};
type CompiledTaskBootstrapModule = { createPrivateTaskBootstrap: typeof createPrivateTaskBootstrapFactory };
type CompiledRuntimeModule = { installPrivateApplication: typeof installPrivateApplicationFactory };
type CompiledIndexModule = { default: Parameters<typeof createPrivateNodeHandlerFactory>[0]["handler"] };

const compiledServerDirectory = new URL("../../dist-vps/server/", import.meta.url);
const loadCompiledServer = async <Module>(file: string): Promise<Module> => {
  const url = new URL(file, compiledServerDirectory);
  try {
    return (await import(url.href)) as Module;
  } catch (cause) {
    throw new Error(`this journey drives the compiled application: build it first (pnpm build); `
      + `${url.href} did not load: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
};

export async function runReviewRevisionLineageJourney(): Promise<JourneyOutcomeV1> {
  const steps: JourneyOutcomeV1["steps"] = [], findings: string[] = [];
  const record = (step: string, detail: string) => { steps.push({ step, detail }); };

  const x = await nativeQualityCompletionFixture();
  try {
    const [compiledIndex, compiledRuntime, compiledTaskBootstrap, compiledServing] = await Promise.all([
      loadCompiledServer<CompiledIndexModule>("index.js"),
      loadCompiledServer<CompiledRuntimeModule>("runtime.js"),
      loadCompiledServer<CompiledTaskBootstrapModule>("taskBootstrap.js"),
      loadCompiledServer<CompiledServingModule>("serving.js"),
    ]);
    const startup = await taskStartupFixture(x.f.assignmentFixture);
    const canonical = new CanonicalStore(startup.coordinator.client);
    // `CanonicalStore.get` returns the whole domain union, so every read below is narrowed to
    // the record being asserted on and a missing record fails here instead of surfacing later
    // as an undefined-property read.
    const requireRecord = async <T>(kind: Parameters<CanonicalStore["get"]>[1], id: string): Promise<T> => {
      const found = await canonical.get(x.request.tenantId, kind, id);
      assert.ok(found, `canonical ${kind} ${id} must exist`);
      return found as unknown as T;
    };
    const opened: string[] = [];
    const runtime = await compiledTaskBootstrap.createPrivateTaskBootstrap({ clock: x.f.clock,
      install: compiledRuntime.installPrivateApplication,
      openDatabase(config: { username: string }) {
        opened.push(config.username);
        return startup.openDatabase(config);
      },
    }).start({ ...startup.config, coordinator: { ...startup.config.coordinator,
      quality: { ...x.f.ownerConfig, scenarios: [x.scenario] }, revisionPlanning: true,
    } });
    try {
      assert.equal(runtime.isReady(), true);
      assert.ok(runtime.revisions, "the compiled runtime must expose the revision planner");
      assert.deepEqual(opened, ["web_test", "coordinator_test"], "the compiled startup must open the two restricted roles");
      record("compiled two-role startup", `opened ${opened.join(" + ")}; revision planning configured, browser assets loaded from dist-vps/client`);

      const bridge = compiledServing.createPrivateNodeHandler({ origin, application: runtime,
        handler: compiledIndex.default,
        assets: await compiledServing.loadPrivateClientAssets(await realpath("dist-vps/client")) });
      try {
        const send = async (webRequest: Request) => {
          const url = new URL(webRequest.url);
          const exchange = nodeExchange({ path: `${url.pathname}${url.search}`, method: webRequest.method,
            headers: [...webRequest.headers].flat(), body: webRequest.body ? await webRequest.text() : undefined });
          await bridge.handle(exchange.input, exchange.output);
          return new Response(exchange.body(), { status: exchange.output.statusCode,
            headers: Object.fromEntries(exchange.headers) });
        };

        const projectId = x.registration.projectId, sourceJobId = x.registration.jobId;
        const reviewPath = `/api/v1/projects/${projectId}/tasks/${sourceJobId}/results/${x.artifact.artifactId}/reviews/${x.target.id}`;
        const feedback = "Prepare a clearer explanation of the recorded evidence.";
        const reviewDraft = { artifactId: x.artifact.artifactId, targetId: x.target.id, targetDigest: x.request.targetDigest,
          contentHash: x.request.contentHash, decision: "changes_requested", feedback };
        const denied = await send(new Request(`${origin}${reviewPath}`, { method: "POST",
          headers: { origin, "content-type": "application/json" }, body: JSON.stringify(reviewDraft) }));
        assert.equal(denied.status, 401, "an unauthenticated review attempt must be refused");
        const reviewed = await send(request(reviewPath, "POST", reviewDraft, "workflow-journey-review-001", x.f.jwt));
        assert.equal(reviewed.status, 201, await reviewed.clone().text());
        const reviewReceipt = (await reviewed.json()).receipt;
        assert.equal(reviewReceipt.startsRevision, false, "recording a review must not start a revision");
        assert.equal(reviewReceipt.decision, "changes_requested");
        record("protected owner review recorded",
          `401 without an owner assertion; owner review ${reviewReceipt.reviewId} recorded with decision=changes_requested, startsRevision=false`);

        const optionsResponse = await send(request(reviewPath, "GET", undefined, undefined, x.f.jwt));
        assert.equal(optionsResponse.status, 200, await optionsResponse.clone().text());
        const options = await optionsResponse.json();
        assert.equal(options.revisionPlanning, "configured");
        assert.equal(options.ownReview.reviewId, reviewReceipt.reviewId);
        assert.equal(options.ownReview.findingId, reviewReceipt.findingId);
        assert.equal(options.ownReview.feedback, feedback);
        const draft = revisionRequestFromReview(x.registration.id, options);
        assert.ok(draft, "only the exact saved owner note may populate a revision command");
        record("saved review read back",
          `options expose the own review (${options.ownReview.reviewId}) and revisionRequestFromReview produced the request for run ${draft.runId}`);

        const nativeTask = x.registration.nativeTask;
        assert.ok(nativeTask, "the registered run must carry its native task before the review");
        const source = {
          job: await canonical.get(x.request.tenantId, "job", sourceJobId),
          attempt: await canonical.get(x.request.tenantId, "attempt", x.registration.attemptId),
          lease: await canonical.get(x.request.tenantId, "lease", nativeTask.leaseId),
          target: await x.f.reviewStore.snapshot(x.request.tenantId, x.target.id),
          checkpoint: x.f.checkpoints.read(`completion-gate:${x.request.tenantId}`),
        };
        const nativeCalls = [...x.local.calls], nativeEffects = x.local.effects.countFull();
        const plansBefore = (await startup.coordinator.client.query("SELECT job_id FROM control_task_execution_plans")).rows;
        const statuses: number[] = [], bodies: string[] = [];
        const client = createTaskRevisionBrowserClient(async (url, init) => {
          const browserHeaders = new Headers(init?.headers);
          assert.equal(browserHeaders.has("idempotency-key"), false, "the browser must not choose the command identity");
          bodies.push(String(init?.body));
          browserHeaders.set("cf-access-jwt-assertion", x.f.jwt);
          browserHeaders.set("origin", origin);
          const response = await send(new Request(`${origin}${url}`, { ...init, headers: browserHeaders }));
          statuses.push(response.status);
          return response;
        });
        const saved = await client.prepare(projectId, sourceJobId, draft);
        assert.deepEqual(statuses, [201]);
        assert.equal(saved.projectId, projectId);
        assert.equal(saved.sourceJobId, sourceJobId);
        assert.notEqual(saved.jobId, sourceJobId, "a revision must be a new job, not the source job");
        assert.equal(saved.rootSubjectId, x.target.subjectId);
        assert.equal(saved.rootTargetId, x.target.rootTargetId);
        assert.equal(saved.fromRunId, x.registration.id);
        assert.equal(saved.fromTargetId, x.target.id);
        assert.equal(saved.fromTargetDigest, x.request.targetDigest);
        assert.equal(saved.fromContentHash, x.request.contentHash);
        assert.equal(saved.reviewId, reviewReceipt.reviewId);
        assert.equal(saved.revisionNumber, 1);
        assert.equal(saved.startsWork, false);
        assert.equal(saved.grantsExecutionAuthority, false);
        assert.equal(saved.executionAvailability, "requires_separate_assignment_and_approval");

        const child = await requireRecord<JobRecord>("job", saved.jobId);
        assert.equal(child.state, "proposed");
        assert.equal(child.version, 0);
        assert.equal(child.projectId, projectId);
        const workflow = await requireRecord<WorkflowRecord>("workflow", child.workflowId);
        const childRequest = await requireRecord<RequestRecord>("request", workflow.requestId);
        assert.equal(workflow.state, "proposed");
        assert.deepEqual(workflow.jobIds, [child.id]);
        assert.equal(childRequest.state, "draft");
        assert.equal((await startup.coordinator.client.query("SELECT id FROM control_attempts WHERE job_id=$1", [child.id])).rows.length, 0,
          "a prepared revision must have no attempt");
        assert.equal((await startup.coordinator.client.query("SELECT job_id FROM control_task_execution_plans")).rows.length,
          plansBefore.length + 1, "exactly one execution plan may be planned");
        record("revision prepared with full lineage",
          `child job ${saved.jobId} proposed from review ${saved.reviewId}: revisionNumber=1, rootSubject=${saved.rootSubjectId}, rootTarget=${saved.rootTargetId}, fromTarget=${saved.fromTargetId}, startsWork=false, executionAvailability=${saved.executionAvailability}`);

        assert.deepEqual(await canonical.get(x.request.tenantId, "job", sourceJobId), source.job);
        assert.deepEqual(await canonical.get(x.request.tenantId, "attempt", x.registration.attemptId), source.attempt);
        assert.deepEqual(await canonical.get(x.request.tenantId, "lease", nativeTask.leaseId), source.lease);
        assert.deepEqual(await x.f.reviewStore.snapshot(x.request.tenantId, x.target.id), source.target);
        assert.deepEqual(x.f.checkpoints.read(`completion-gate:${x.request.tenantId}`), source.checkpoint);
        assert.deepEqual(x.local.calls, nativeCalls, "preparing a revision must call no native executor");
        assert.equal(x.local.effects.countFull(), nativeEffects, "preparing a revision must produce no effect");
        record("source work and native executor untouched",
          `source job/attempt/lease/target/checkpoint unchanged; ${nativeEffects} native effects and ${nativeCalls.length} native calls unchanged by the review and the revision plan`);

        const replay = await client.prepare(projectId, sourceJobId, draft);
        assert.deepEqual(statuses, [201, 200]);
        assert.deepEqual(replay, saved, "an exact replay must return the original revision receipt");
        assert.equal(new Set(bodies).size, 1);
        assert.equal((await startup.coordinator.client.query(
          "SELECT id FROM audit_events WHERE action='tasks.revisions.plan' AND target_id=$1", [child.id])).rows.length, 1,
          "a replay must not record a second plan");
        assert.deepEqual(x.local.calls, nativeCalls);
        assert.equal(x.local.effects.countFull(), nativeEffects);
        record("replay is inert",
          "the same request returned the same receipt (200, replayed), one tasks.revisions.plan audit record, native executor still untouched");

        findings.push("The protected review and revision routes are driven through the compiled two-role application and the browser clients the private views use; the owner review starts no revision and the prepared revision starts no work.");
        findings.push("Revision lineage is proven on the receipt and in canonical storage: a new proposed child job, root subject/target retained, source run/target digest/content hash/review id carried over, revisionNumber 1, no attempt, one planned execution plan.");
        findings.push("Honest limit: the reviewed result in this journey is produced by the existing synthetic native completion fixture (tests/helpers/native-quality-completion.ts), not by a live agent run; no provider, credential, publication, installation or production effect is involved.");
        return { journey: "owner review -> revision lineage", steps, findings };
      } finally {
        bridge.close();
      }
    } finally {
      await runtime.close();
      assert.equal(runtime.isReady(), false);
      assert.equal(startup.web.closes(), 1);
      assert.equal(startup.coordinator.closes(), 1);
    }
  } finally {
    await x.close();
  }
}