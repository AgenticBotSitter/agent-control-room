import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { CONTROLLER_WORKER_REMOTE_ADAPTER_V1, CONTROLLER_WORKER_REMOTE_CAPABILITY_V1,
  CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1, CONTROLLER_WORKER_REMOTE_START_OPERATION_V1 } from "../src/harness/v1/remote-worker-delivery";
import { TaskExecutionPlanner, nativeTaskTemplateSchema, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { taskPlanningTemplateChoiceSchema } from "../src/web/v1/task-planning-wire";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { taskDraft } from "./helpers/web-task";

test("a remote-compatible text-review plan is durable but does not configure or deliver a worker", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:remote",
    allowedOperations: [CONTROLLER_WORKER_REMOTE_START_OPERATION_V1], credentialRefs: ["credential:remote"], filesystemRoots: [],
    networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
    maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:controller-worker-remote", adapter: CONTROLLER_WORKER_REMOTE_ADAPTER_V1,
    authority, instructions: "Return a bounded plain-text review only.", connectorProfileDigest: sha256Digest("remote-profile"),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  assert.deepEqual(taskPlanningTemplateChoiceSchema.parse({ id: template.id, adapter: CONTROLLER_WORKER_REMOTE_ADAPTER_V1 }),
    { id: template.id, adapter: CONTROLLER_WORKER_REMOTE_ADAPTER_V1 });
  assert.doesNotThrow(() => nativeTaskTemplateSchema.parse(template));
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(99),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => instant + 7_000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "remote-plan-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const replay = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  assert.equal(replay.replayed, true);
  const saved = await planner.read(planned.receipt.jobId);
  assert.ok(saved && saved.schema === "control-room.task-execution-plan/v11");
  if (!saved || saved.schema !== "control-room.task-execution-plan/v11") throw new Error("missing remote plan");
  assert.equal(saved.adapter, CONTROLLER_WORKER_REMOTE_ADAPTER_V1);
  assert.equal(saved.executionClass, "text_review");
  assert.equal(saved.job.jobType, CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1);
  assert.equal(saved.job.requiredCapability, CONTROLLER_WORKER_REMOTE_CAPABILITY_V1);
  assert.equal(planned.receipt.startsWork, false);
  assert.equal(planned.receipt.grantsExecutionAuthority, false);
  assert.equal(await planner.readConfiguredLocalRoute(f.identity, binding.projectId, planned.receipt.jobId), "not_configured");
});
