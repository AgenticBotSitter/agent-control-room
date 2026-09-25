import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { HERMES_LOCAL_ADAPTER_V1, HERMES_LOCAL_CAPABILITY_V1, HERMES_LOCAL_JOB_TYPE_V1,
  HERMES_LOCAL_START_OPERATION_V1 } from "../src/harness/hermes-local-v1";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding, enrollment, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { taskDraft } from "./helpers/web-task";

test("a current qualified Hermes template creates an update-independent local text-review plan", async t => {
  const f = await ownerReviewFixture();
  t.after(f.close);
  const authority: NativeTaskTemplate["authority"] = {
    projectId: binding.projectId,
    allowedExecutor: "executor:marvin",
    allowedOperations: [HERMES_LOCAL_START_OPERATION_V1],
    credentialRefs: ["credential:marvin"],
    filesystemRoots: [],
    networkPolicy: "allowlist",
    allowedNetworkDestinations: [enrollment.canonicalDestination],
    effectPolicy: "approval_required",
    maxRisk: "low",
    maxDurationSeconds: 120,
    maxConcurrentEffects: 1,
    expiresAt: at(300_000),
    digest: "",
  };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = {
    id: "template:marvin-current",
    adapter: HERMES_LOCAL_ADAPTER_V1,
    authority,
    instructions: "Return a bounded plain-text result.",
    // This is captured from the qualified installed build, never a source pin.
    connectorProfileDigest: sha256Digest("qualified-current-hermes-build"),
    acceptanceProfileId: f.profile.id,
    acceptanceProfileDigest: sha256Digest(f.profile),
  };
  const unavailable = new TaskExecutionPlanner(f.db, f.scope, {
    template,
    integrityKey: new Uint8Array(32).fill(61),
    reviewIntegrityKey: f.reviewKey,
    checkpoints: f.checkpoints,
    localAdapterAdmission: { enabledAdapters: [] },
  }, () => instant + 7_000);
  assert.deepEqual(unavailable.templatesForProject(binding.projectId), []);

  const planner = new TaskExecutionPlanner(f.db, f.scope, {
    template,
    integrityKey: new Uint8Array(32).fill(61),
    reviewIntegrityKey: f.reviewKey,
    checkpoints: f.checkpoints,
    localAdapterAdmission: { enabledAdapters: [HERMES_LOCAL_ADAPTER_V1] },
  }, () => instant + 7_000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "current-hermes-plan-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const saved = await planner.read(planned.receipt.jobId);
  assert.ok(saved && saved.schema === "control-room.task-execution-plan/v15");
  if (!saved || saved.schema !== "control-room.task-execution-plan/v15") throw new Error("current Hermes plan missing");
  assert.equal(saved.adapter, HERMES_LOCAL_ADAPTER_V1);
  assert.equal(saved.job.jobType, HERMES_LOCAL_JOB_TYPE_V1);
  assert.equal(saved.job.requiredCapability, HERMES_LOCAL_CAPABILITY_V1);
  assert.equal(saved.executionClass, "text_review");
  assert.equal(await planner.readPreparedWorker(f.identity, binding.projectId, saved.job.id), "hermes");
  assert.equal(await planner.readConfiguredLocalRoute(f.identity, binding.projectId, saved.job.id), "configured");
});
