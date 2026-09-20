import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, CLAUDE_CODE_LOCAL_ADAPTER_V1,
  CLAUDE_CODE_LOCAL_CAPABILITY_V1, CLAUDE_CODE_LOCAL_JOB_TYPE_V1,
  CLAUDE_CODE_LOCAL_START_OPERATION_V1 } from "../src/harness/claude-code-v1";
import { TaskExecutionPlanner, nativeTaskTemplateSchema, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { validateTaskAssignmentRoutes } from "../src/web/v1/task-assignment-coordinator";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { taskDraft } from "./helpers/web-task";

test("a local Claude task can be saved in the shared lifecycle but cannot be assigned or started", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:claude",
    allowedOperations: [CLAUDE_CODE_LOCAL_START_OPERATION_V1], credentialRefs: ["credential:claude"], filesystemRoots: [],
    networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
    maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:claude-local", adapter: CLAUDE_CODE_LOCAL_ADAPTER_V1, authority,
    instructions: "Return a bounded plain-text review only.", connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(74),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => instant + 7_000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "claude-local-plan-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const replay = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  assert.equal(replay.replayed, true, "the same proposal produces one durable plan");
  const saved = await planner.read(planned.receipt.jobId);
  assert.ok(saved && saved.schema === "control-room.task-execution-plan/v9");
  if (!saved || saved.schema !== "control-room.task-execution-plan/v9") throw new Error("missing Claude plan");
  assert.equal(saved.adapter, CLAUDE_CODE_LOCAL_ADAPTER_V1);
  assert.equal(saved.connectorProfileDigest, CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1);
  assert.equal(saved.executionClass, "text_review");
  assert.equal(saved.job.jobType, CLAUDE_CODE_LOCAL_JOB_TYPE_V1);
  assert.equal(saved.job.requiredCapability, CLAUDE_CODE_LOCAL_CAPABILITY_V1);
  assert.equal(planned.receipt.startsWork, false);
  assert.equal(planned.receipt.grantsExecutionAuthority, false);

  assert.throws(() => validateTaskAssignmentRoutes([{ nodeId: binding.nodeId, executorId: authority.allowedExecutor,
    capabilityProbeId: CLAUDE_CODE_LOCAL_CAPABILITY_V1, maxConcurrentTasks: 1, requiredScratchBytes: 0, leaseSeconds: 60 }] as unknown as Parameters<typeof validateTaskAssignmentRoutes>[0]),
  /Invalid option/, "no route can make an unqualified Claude plan runnable");

  const foreignProfile = { ...template, connectorProfileDigest: sha256Digest("foreign-claude-profile") };
  assert.throws(() => nativeTaskTemplateSchema.parse(foreignProfile), /unsupported native task template/);
});
