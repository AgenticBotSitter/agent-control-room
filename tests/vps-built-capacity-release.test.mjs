import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import handler from "../dist-vps/server/index.js";
import { createPrivateTaskBootstrap } from "../dist-vps/server/taskBootstrap.js";
import { installPrivateApplication } from "../dist-vps/server/runtime.js";
import { sha256Digest } from "../src/security/index.ts";
import { nativeQualityCompletionFixture } from "./helpers/native-quality-completion.ts";
import { taskStartupFixture } from "./helpers/task-startup.ts";
import { request } from "./helpers/web-foundation.ts";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";

test("compiled startup releases finished native capacity before owner review and completes without rewriting its lease", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close);
  const startup = await taskStartupFixture(x.f.assignmentFixture);
  const canonical = new CanonicalStore(startup.coordinator.client);
  const states = async () => ({
    job: await canonical.get(x.request.tenantId, "job", x.registration.jobId),
    attempt: await canonical.get(x.request.tenantId, "attempt", x.registration.attemptId),
    lease: await canonical.get(x.request.tenantId, "lease", x.registration.nativeTask.leaseId),
  });
  const runtime = await createPrivateTaskBootstrap({ clock: x.f.clock, install: installPrivateApplication,
    openDatabase: startup.openDatabase }).start({ ...startup.config, coordinator: { ...startup.config.coordinator,
      quality: { ...x.f.ownerConfig, scenarios: [x.scenario] },
    } });
  t.after(() => runtime.close());
  assert.equal(runtime.isReady(), true); assert.ok(runtime.quality);

  const input = { ...x.request, projectId: x.registration.projectId, jobId: x.registration.jobId };
  const reconcile = () => runtime.quality.reconcile(input, new AbortController().signal);
  const before = await states(), calls = [...x.local.calls], effects = x.local.effects.countFull();
  const waiting = await reconcile();
  assert.equal(waiting.disposition, "waiting_review"); assert.equal(waiting.verification, "recorded");
  assert.equal(waiting.capacity.replayed, false); assert.equal(waiting.capacity.receipt.jobId, input.jobId);
  assert.equal(waiting.capacity.receipt.runId, input.runId); assert.equal(waiting.capacity.receipt.leaseId, before.lease.id);
  assert.equal(waiting.capacity.receipt.leaseEpoch, before.lease.epoch);
  assert.equal(waiting.capacity.receipt.leaseVersion, before.lease.version + 1);
  assert.equal(waiting.capacity.receipt.qualityAccepted, false);
  assert.equal(waiting.capacity.receipt.grantsApproval, false);
  assert.equal(waiting.capacity.receipt.grantsExecutionAuthority, false);
  const released = await states();
  assert.deepEqual(released.job, before.job); assert.deepEqual(released.attempt, before.attempt);
  assert.equal(released.lease.state, "released"); assert.equal(released.lease.version, before.lease.version + 1);

  const assignmentPath = `/api/v1/projects/${input.projectId}/tasks/${input.jobId}/assignment`;
  const assignmentRequest = (method = "GET", body) => request(
    assignmentPath, method, body, "compiled-capacity-assignment-001", x.f.jwt);
  const optionsResponse = await handler(assignmentRequest());
  assert.equal(optionsResponse.status, 200, await optionsResponse.clone().text());
  const options = await optionsResponse.json();
  assert.equal(options.receipt.leaseState, "released"); assert.equal(options.receipt.leaseCurrent, false);
  const assignedResponse = await handler(assignmentRequest("POST", { action: "assign", nodeId: x.f.route.nodeId,
    expectedInputDigest: x.registration.nativeTask.inputDigest }));
  assert.equal(assignedResponse.status, 200, await assignedResponse.clone().text());
  const assigned = await assignedResponse.json();
  assert.equal(assigned.replayed, true); assert.equal(assigned.receipt.leaseState, "released");
  assert.equal(assigned.receipt.leaseCurrent, false); assert.deepEqual(assigned.receipt, options.receipt);

  const replayedWaiting = await reconcile();
  assert.equal(replayedWaiting.disposition, "waiting_review"); assert.equal(replayedWaiting.verification, "replayed");
  assert.equal(replayedWaiting.capacity.replayed, true);
  assert.deepEqual(replayedWaiting.capacity.receipt, waiting.capacity.receipt);
  assert.deepEqual(await states(), released);

  const reviewPath = `/api/v1/projects/${input.projectId}/tasks/${input.jobId}/results/${x.artifact.artifactId}/reviews/${x.target.id}`;
  const reviewDraft = { artifactId: x.artifact.artifactId, targetId: x.target.id, targetDigest: input.targetDigest,
    contentHash: input.contentHash, decision: "accepted", feedback: "" };
  const reviewed = await handler(request(reviewPath, "POST", reviewDraft, "compiled-capacity-review-001", x.f.jwt));
  assert.equal(reviewed.status, 201, await reviewed.clone().text());
  const beforeCompletion = await states();
  const completed = await reconcile();
  assert.equal(completed.disposition, "completed"); assert.equal(completed.verification, "replayed");
  assert.equal(completed.completion.replayed, false);
  assert.equal(completed.completion.receipt.capacityReleaseDigest, sha256Digest(waiting.capacity.receipt));
  assert.equal(completed.completion.receipt.leaseVersion, released.lease.version);
  const final = await states();
  assert.equal(final.job.state, "succeeded"); assert.equal(final.attempt.state, "succeeded");
  assert.deepEqual(final.lease, beforeCompletion.lease);
  const replay = await reconcile();
  assert.equal(replay.disposition, "completed"); assert.equal(replay.completion.replayed, true);
  assert.deepEqual(replay.completion.receipt, completed.completion.receipt);
  assert.deepEqual((await states()).lease, final.lease);
  assert.deepEqual(x.local.calls, calls); assert.equal(x.local.effects.countFull(), effects);

  await runtime.close(); assert.equal(runtime.isReady(), false);
  assert.equal(startup.web.closes(), 1); assert.equal(startup.coordinator.closes(), 1);
  await assert.rejects(reconcile(), { message: "task_coordinator_unavailable" });
  assert.equal((await handler(assignmentRequest())).status, 503);
});

test("compiled browser assets exclude private capacity-release implementation", () => {
  const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  const javascript = files("dist-vps/client").filter(file => file.endsWith(".js"));
  assert.ok(javascript.length > 0);
  for (const file of javascript) assert.doesNotMatch(readFileSync(file, "utf8"),
    /NativeTaskCompletionService|native-capacity-release|task\.native\.capacity_released/);
});
