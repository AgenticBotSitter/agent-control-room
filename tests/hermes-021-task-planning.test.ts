import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_MACOS_LOCAL_CAPABILITY_V1,
  HERMES_021_MACOS_LOCAL_JOB_TYPE_V1, HERMES_021_MACOS_LOCAL_START_OPERATION_V1 } from "../src/harness/hermes-021-v1";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding, enrollment, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { taskDraft } from "./helpers/web-task";

test("a Marvin Hermes 0.21 template creates a pinned v5 plan, not an older generic Hermes plan", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:marvin",
    allowedOperations: [HERMES_021_MACOS_LOCAL_START_OPERATION_V1], credentialRefs: ["credential:marvin"], filesystemRoots: [],
    networkPolicy: "allowlist", allowedNetworkDestinations: [enrollment.canonicalDestination], effectPolicy: "approval_required",
    maxRisk: "low", maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:marvin-021", adapter: HERMES_021_MACOS_LOCAL_ADAPTER_V1, authority,
    instructions: "Return a bounded plain-text result.", connectorProfileDigest: sha256Digest("marvin-hermes-021-profile"),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(91),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => instant + 7000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "marvin-021-plan-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const saved = await planner.read(planned.receipt.jobId);
  assert.ok(saved && saved.schema === "control-room.task-execution-plan/v5");
  if (!saved || saved.schema !== "control-room.task-execution-plan/v5") throw new Error("missing Hermes 0.21 plan");
  assert.equal(saved.adapter, HERMES_021_MACOS_LOCAL_ADAPTER_V1);
  assert.equal(saved.connectorProfileDigest, template.connectorProfileDigest);
  assert.equal(saved.job.jobType, HERMES_021_MACOS_LOCAL_JOB_TYPE_V1);
  assert.equal(saved.job.requiredCapability, HERMES_021_MACOS_LOCAL_CAPABILITY_V1);
  assert.notEqual(saved.schema, "control-room.task-execution-plan/v1");
});
