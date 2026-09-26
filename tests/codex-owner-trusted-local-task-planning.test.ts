import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1,
  CODEX_OWNER_TRUSTED_LOCAL_JOB_TYPE_V1, CODEX_OWNER_TRUSTED_LOCAL_START_OPERATION_V1 } from "../src/harness/codex-v1/owner-trusted-local-task-planning-contract";
import { TaskExecutionPlanner, nativeTaskTemplateSchema, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { taskDraft } from "./helpers/web-task";

test("an admitted owner-trusted local Codex template creates a text-review plan without using the older App Server route", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:codex",
    allowedOperations: [CODEX_OWNER_TRUSTED_LOCAL_START_OPERATION_V1], credentialRefs: ["credential:codex"], filesystemRoots: [],
    networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
    maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:codex-owner-trusted-local", adapter: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1,
    authority, instructions: "Return a bounded plain-text review only.", connectorProfileDigest: sha256Digest("mac-local-codex-profile"),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  assert.doesNotThrow(() => nativeTaskTemplateSchema.parse(template));
  const blocked = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(65),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints, localAdapterAdmission: { enabledAdapters: [] } }, () => instant + 7_000);
  assert.equal(blocked.supportsProject(binding.projectId), false, "an unenabled local Codex executable is not offered to the owner");
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(65),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints,
    localAdapterAdmission: { enabledAdapters: [CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1] } }, () => instant + 7_000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "codex-owner-trusted-local-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const replay = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  assert.equal(replay.replayed, true, "the same browser request has one durable planning receipt");
  const saved = await planner.read(planned.receipt.jobId);
  assert.ok(saved && saved.schema === "control-room.task-execution-plan/v13");
  if (!saved || saved.schema !== "control-room.task-execution-plan/v13") throw new Error("missing local Codex plan");
  assert.equal(saved.adapter, CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1);
  assert.equal(saved.executionClass, "text_review");
  assert.equal(saved.job.jobType, CODEX_OWNER_TRUSTED_LOCAL_JOB_TYPE_V1);
  assert.equal(saved.job.requiredCapability, CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1);
  assert.equal(await planner.readPreparedWorker(f.identity, binding.projectId, planned.receipt.jobId), "codex",
    "the website can describe this as Codex without exposing a command, account, or local path");
  assert.equal(await planner.readConfiguredLocalRoute(f.identity, binding.projectId, planned.receipt.jobId), "configured");
  assert.equal(planned.receipt.startsWork, false);
  assert.equal(planned.receipt.grantsExecutionAuthority, false);
});
