import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createInstallationTransitionV1, advanceInstallationTransitionV1 } from "../src/harness/v1/installation-transition";
import { createClaudeCodeLocalProcessReadinessV1 } from "../src/harness/claude-code-v1/local-process-readiness";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1, CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 } from
  "../src/harness/claude-code-v1/task-planning-contract";
import { createInstallationPlanV1, advanceInstallationPlanV1, installationSetupStagesV1,
  refreshInstallationPlanV1, type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { privateInstallationFinalReviewBindingsV1 } from "../src/installer/v1/private-installation-final-review";
import { verifyLocalClaudePostInstallAdmissionV1 } from "../src/installer/v1/local-claude-post-install-admission";
import { privateArtifactStorageNamespaceDigestV1 } from "../src/web/v1/private-artifact-storage";
import { createClaudeCodePrivateInstallationCompositionV1, isClaudeCodePrivateInstalledDeliverCapabilityV1 } from
  "../src/web/v1/claude-code-private-installation-composition";
import { CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1,
  CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1 } from "../src/harness/claude-code-v1/text-review-invocation-policy";
import { CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1,
  createClaudeCodeTextReviewQualificationEvidenceV1 } from "../src/harness/claude-code-v1/qualification-evidence";

const d = (value: unknown) => sha256Digest(value);

function originalInstallation() {
  const hermes = { kind: "local" as const, workerId: "worker:hermes", adapterId: "connector:hermes-021-macos-local-v1",
    adapterRevision: "revision-hermes-0001" };
  const topologyInput = { databaseAuthorityDigest: d("database"), schedulerAuthorityDigest: d("scheduler"),
    currentRoutes: [hermes], requestedRoutes: [hermes] };
  const topology = planInstallationTopologyV1(topologyInput), releaseDigest = d("release");
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest,
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, d(`input:${stage}`)])) });
  const history: InstallationPlanV1[] = [plan];
  for (const stage of installationSetupStagesV1.filter(value => value !== "final_review")) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "start" }); history.push(plan);
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "pass", outcomeDigest: d(`outcome:${stage}`) }); history.push(plan);
  }
  const bindings = privateInstallationFinalReviewBindingsV1(plan);
  plan = refreshInstallationPlanV1(plan, { topologyPlan: topology, releaseDigest,
    stageInputDigests: Object.fromEntries(plan.stages.map(item => [item.stage,
      item.stage === "final_review" ? bindings.finalReviewInputDigest : item.inputDigest])) }); history.push(plan);
  plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "final_review", action: "start" }); history.push(plan);
  const finalBody = { schema: "control-room.private-installation-final-review-terminal/v1" as const,
    installationId: "installation:fixture", installationPlanDigest: plan.planDigest, installationPlanRevision: plan.revision,
    topologyPlanDigest: plan.topologyPlanDigest, releaseDigest: plan.releaseDigest,
    finalReviewInputDigest: bindings.finalReviewInputDigest, priorStageEvidenceDigest: bindings.priorStageEvidenceDigest,
    invokesAgent: false as const, enablesAuthority: false as const, startsService: false as const, startsWorker: false as const };
  plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "final_review", action: "pass",
    outcomeDigest: d({ purpose: "private-installation-final-review-terminal/v1", confirmation: finalBody }) }); history.push(plan);
  return { topologyInput, topology, releaseDigest, plan, history };
}

test("post-install Claude admission binds one additive committed transition without publishing a route", async () => {
  const original = originalInstallation();
  const workerRoute = { kind: "local" as const, workerId: "worker:claude", adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1,
    adapterRevision: "revision-claude-0001" };
  const transitionInput = { databaseAuthorityDigest: original.topology.databaseAuthorityDigest,
    schedulerAuthorityDigest: original.topology.schedulerAuthorityDigest,
    currentRoutes: original.topologyInput.requestedRoutes,
    requestedRoutes: [...original.topologyInput.requestedRoutes, workerRoute] };
  const topology = planInstallationTopologyV1(transitionInput);
  const qualificationReport = {
    schema: CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1, qualified: true,
    fixedInvocationPolicyDigest: CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1,
    terminalResultObserved: true, terminalResultDigest: d("claude-terminal"), inputTokens: 5, outputTokens: 4,
    totalTokens: 9, durationMs: 100, failureReason: "none", retryRequiresFreshOwnerAuthorization: false,
    startsWork: false, grantsExecutionAuthority: false,
  };
  const qualificationEvidence = createClaudeCodeTextReviewQualificationEvidenceV1(qualificationReport);
  const processConfiguration = { schema: "control-room.claude-code-private-installed-process-host-configuration/v1" as const,
    process: { executablePath: "/private/bin/claude", args: [...CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1], workingDirectory: "/private/workspace", cleanupMs: 100 },
    executableSha256: d("executable"), workingDirectoryBindingDigest: d("workspace"), qualificationDigest: qualificationEvidence.evidenceDigest,
    startupDeadlineMs: 100, terminateDeadlineMs: 100, killDeadlineMs: 100 };
  const processConfigurationDigest = d({ purpose: "local-claude-installed-process-configuration/v1", configuration: processConfiguration });
  const readiness = createClaudeCodeLocalProcessReadinessV1({ planDigest: topology.planDigest,
    proofs: (["installed_process_identity", "permission_boundary", "cancellation_and_restart_recovery"] as const)
      .map(proof => ({ proof, state: "passed" as const, evidenceDigest: d(proof) })) });
  const processObservation = { state: "passed" as const, topologyPlanDigest: topology.planDigest,
    releaseDigest: original.releaseDigest, workerRouteDigest: d(workerRoute),
    connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, processConfigurationDigest,
    processReadinessDigest: readiness.readinessDigest, observationDigest: d("process-observation") };
  const protectedResultStorage = { local: { rootPath: "/private/results", maximumArtifacts: 10,
      maximumFileBytes: 65_536, maximumTotalBytes: 655_360, operationTimeoutMs: 1000 },
    inventory: { releaseId: "release:fixture", releaseDigest: original.releaseDigest,
      databaseSchemaVersion: "schema:fixture", databaseSchemaDigest: d("schema"), storageNamespace: "claude-results",
      storageNamespaceDigest: privateArtifactStorageNamespaceDigestV1("claude-results", "/private/results") } };
  const serviceObservation = { state: "running" as const, topologyPlanDigest: original.topology.planDigest,
    releaseDigest: original.releaseDigest, serviceIdentityDigest: d("service"),
    databaseAuthorityDigest: original.topology.databaseAuthorityDigest, protectedDataBindingDigest: d("protected"),
    supervisorReadinessDigest: d("supervisor"), observationDigest: d("service-observation") };
  const transitionId = "transition:add-claude";
  const reviewedMaterial = { installationId: "installation:fixture", originalInstallationPlanDigest: original.plan.planDigest,
    originalInstallationPlanRevision: original.plan.revision, originalTopologyPlanDigest: original.topology.planDigest,
    transitionId, transitionPlanDigest: topology.planDigest, requestedRouteDigest: topology.requestedRouteDigest,
    databaseAuthorityDigest: topology.databaseAuthorityDigest, schedulerAuthorityDigest: topology.schedulerAuthorityDigest,
    workerRouteDigest: d(workerRoute), workerId: workerRoute.workerId, adapterId: workerRoute.adapterId,
    adapterRevision: workerRoute.adapterRevision,
    connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, processConfigurationDigest,
    processReadinessDigest: readiness.readinessDigest, processObservationDigest: d(processObservation),
    protectedResultStorageDigest: d(protectedResultStorage), serviceObservationDigest: d(serviceObservation),
    releaseDigest: original.releaseDigest, workspaceBindingDigest: processConfiguration.workingDirectoryBindingDigest };
  const evidenceDigest = d({ purpose: "local-claude-post-install-reviewed-evidence/v1", admission: reviewedMaterial });
  let transition = createInstallationTransitionV1({ transitionId, topologyPlan: topology, now: "2026-09-22T00:00:00.000Z" });
  for (const [action, now] of [["pause_admission", 1], ["record_drain", 2], ["verify_proofs", 3], ["commit", 4]] as const)
    transition = advanceInstallationTransitionV1(transition, { expectedRevision: transition.revision, action,
      now: `2026-09-22T00:00:0${now}.000Z`, evidenceDigest });
  const input = { installationId: "installation:fixture", originalInstallationPlan: original.plan,
    originalTopologyInput: original.topologyInput, transitionTopologyInput: transitionInput, transitionId,
    workerRoute, requestedRoutes: transitionInput.requestedRoutes, installedProcessConfiguration: processConfiguration, qualificationReport,
    processReadiness: readiness, processObservation, protectedResultStorage, serviceObservation,
    permittedWorkspace: { workspaceId: "workspace:fixture", workingDirectory: "/private/workspace",
      bindingDigest: processConfiguration.workingDirectoryBindingDigest } };
  assert.equal(processConfiguration.qualificationDigest, qualificationEvidence.evidenceDigest);
  const receipt = await verifyLocalClaudePostInstallAdmissionV1(input, {
    async readOriginalInstallationHistory() { return original.history; }, async readTransition() { return transition; } });
  assert.equal(receipt.transitionPublishesRoute, false);
  assert.equal(receipt.retainsBootstrapHermes, true);
  assert.equal(receipt.workerId, workerRoute.workerId);
  assert.equal(receipt.evidenceDigest, evidenceDigest);
  assert.equal(isClaudeCodePrivateInstalledDeliverCapabilityV1(Object.freeze({ async deliver() {} })), false);
  const capability = createClaudeCodePrivateInstallationCompositionV1({ tenantId: "tenant:fixture", admission: receipt,
    installedProcessConfiguration: processConfiguration,
    ports: { async verifyInstallation() { throw new Error("must not run during composition"); },
      launch() { throw new Error("must not run during composition"); } },
    execution: { preparation: {} as never, runs: {} as never,
      delivery: { db: {} as never, integrityKey: new Uint8Array(32),
        binding: { workerId: workerRoute.workerId, adapterId: workerRoute.adapterId,
          adapterRevision: workerRoute.adapterRevision, authorityDigest: d("authority"),
          acceptanceProfileId: "profile:fixture", acceptanceProfileDigest: d("acceptance") },
        authority: {} as never, receiptPort: {} as never, cleanupMs: 100,
        clock: () => 0 }, results: {} as never,
      protectedStorage: { async put() { throw new Error("must not run during composition"); },
        async read() { throw new Error("must not run during composition"); } } },
    assertCurrentProcess() {}, assertCurrentDelivery() {} });
  assert.equal(isClaudeCodePrivateInstalledDeliverCapabilityV1(capability), true);
  assert.deepEqual(Object.getOwnPropertyNames(capability), ["deliver"]);
  assert.equal(Object.isFrozen(capability), true);
  await assert.rejects(verifyLocalClaudePostInstallAdmissionV1({ ...input,
    requestedRoutes: [workerRoute] }, { async readOriginalInstallationHistory() { return original.history; },
    async readTransition() { return transition; } }), /post_install_admission_refused/);
  await assert.rejects(verifyLocalClaudePostInstallAdmissionV1({ ...input,
    qualificationReport: { ...qualificationReport, durationMs: 101 } }, {
    async readOriginalInstallationHistory() { return original.history; }, async readTransition() { return transition; },
  }), /post_install_admission_refused/);
});
