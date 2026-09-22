import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { verifyClaudeCodeLocalProcessReadinessV1,
  summarizeClaudeCodeLocalProcessReadinessV1 } from "../../harness/claude-code-v1/local-process-readiness";
import { capturePrivateClaudeCodeInstalledProcessHostConfigurationV1 } from
  "../../harness/claude-code-v1/private-process-acquisition";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1, CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 } from
  "../../harness/claude-code-v1/task-planning-contract";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1 } from "../../harness/hermes-021-v1/macos-local-worker";
import { installationTopologyInputSchemaV1, planInstallationTopologyV1 } from
  "../../harness/v1/installation-topology";
import { verifyInstallationTransitionV1 } from "../../harness/v1/installation-transition";
import { verifyInstallationPlanV1, type InstallationPlanV1 } from "./installation-plan";
import { privateInstallationFinalReviewBindingsV1 } from "./private-installation-final-review";
import { captureLocalPlatformServiceObservationV1 } from "./local-platform-service-observation";
import { capturePrivateArtifactStorageConfigurationV1 } from "../../web/v1/private-artifact-storage";

export const LOCAL_CLAUDE_POST_INSTALL_ADMISSION_V1 =
  "control-room.local-claude-post-install-admission/v1" as const;

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const route = z.object({ kind: z.literal("local"), workerId: id,
  adapterId: z.literal(CLAUDE_CODE_LOCAL_ADAPTER_V1), adapterRevision: id }).strict();
const observation = z.object({ state: z.literal("passed"), topologyPlanDigest: digest,
  releaseDigest: digest, workerRouteDigest: digest, connectorProfileDigest: digest,
  processConfigurationDigest: digest, processReadinessDigest: digest, observationDigest: digest }).strict();
const workspace = z.object({ workspaceId: id, workingDirectory: z.string().min(1).max(4096), bindingDigest: digest }).strict();

export type LocalClaudePostInstallAdmissionV1 = Readonly<{
  schema: typeof LOCAL_CLAUDE_POST_INSTALL_ADMISSION_V1;
  installationId: string;
  originalInstallationPlanDigest: string;
  originalInstallationPlanRevision: number;
  originalTopologyPlanDigest: string;
  transitionId: string;
  transitionDigest: string;
  transitionPlanDigest: string;
  databaseAuthorityDigest: string;
  schedulerAuthorityDigest: string;
  requestedRouteDigest: string;
  workerRouteDigest: string;
  workerId: string;
  adapterId: typeof CLAUDE_CODE_LOCAL_ADAPTER_V1;
  adapterRevision: string;
  connectorProfileDigest: string;
  processConfigurationDigest: string;
  processReadinessDigest: string;
  processObservationDigest: string;
  protectedResultStorageDigest: string;
  serviceObservationDigest: string;
  releaseDigest: string;
  workspaceBindingDigest: string;
  evidenceDigest: string;
  admissionDigest: string;
  transitionPublishesRoute: false;
  retainsBootstrapHermes: true;
  createsStateMachine: false;
  createsStore: false;
  createsScheduler: false;
  grantsExecutionAuthority: false;
}>;

const receiptSchema = z.object({ schema: z.literal(LOCAL_CLAUDE_POST_INSTALL_ADMISSION_V1), installationId: id,
  originalInstallationPlanDigest: digest, originalInstallationPlanRevision: z.number().int().nonnegative(),
  originalTopologyPlanDigest: digest, transitionId: id, transitionDigest: digest, transitionPlanDigest: digest,
  databaseAuthorityDigest: digest, schedulerAuthorityDigest: digest, requestedRouteDigest: digest,
  workerRouteDigest: digest, workerId: id, adapterId: z.literal(CLAUDE_CODE_LOCAL_ADAPTER_V1), adapterRevision: id,
  connectorProfileDigest: z.literal(CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1), processConfigurationDigest: digest,
  processReadinessDigest: digest, processObservationDigest: digest, protectedResultStorageDigest: digest,
  serviceObservationDigest: digest, releaseDigest: digest, workspaceBindingDigest: digest, evidenceDigest: digest,
  admissionDigest: digest, transitionPublishesRoute: z.literal(false), retainsBootstrapHermes: z.literal(true),
  createsStateMachine: z.literal(false), createsStore: z.literal(false), createsScheduler: z.literal(false),
  grantsExecutionAuthority: z.literal(false) }).strict();

export type LocalClaudePostInstallAdmissionInputV1 = Readonly<{
  installationId: unknown;
  originalInstallationPlan: unknown;
  originalTopologyInput: unknown;
  transitionTopologyInput: unknown;
  transitionId: unknown;
  workerRoute: unknown;
  requestedRoutes: unknown;
  installedProcessConfiguration: unknown;
  processReadiness: unknown;
  processObservation: unknown;
  protectedResultStorage: unknown;
  serviceObservation: unknown;
  permittedWorkspace: unknown;
}>;

export type LocalClaudePostInstallAdmissionRuntimeV1 = Readonly<{
  readOriginalInstallationHistory(): Promise<readonly unknown[]>;
  readTransition(transitionId: string): Promise<unknown>;
}>;

const refuse = (): never => { const error = new Error("local_claude_post_install_admission_refused"); error.stack = undefined; throw error; };

function finalReviewOutcome(installationId: string, running: InstallationPlanV1) {
  const binding = privateInstallationFinalReviewBindingsV1(running);
  const body = { schema: "control-room.private-installation-final-review-terminal/v1" as const,
    installationId, installationPlanDigest: running.planDigest, installationPlanRevision: running.revision,
    topologyPlanDigest: running.topologyPlanDigest, releaseDigest: running.releaseDigest,
    finalReviewInputDigest: binding.finalReviewInputDigest, priorStageEvidenceDigest: binding.priorStageEvidenceDigest,
    invokesAgent: false as const, enablesAuthority: false as const, startsService: false as const, startsWorker: false as const };
  return Object.freeze({ inputDigest: binding.finalReviewInputDigest,
    outcomeDigest: sha256Digest({ purpose: "private-installation-final-review-terminal/v1", confirmation: body }) });
}

function settledOriginalPlan(value: unknown, installationId: string): InstallationPlanV1 {
  const plan = verifyInstallationPlanV1(value);
  if (plan.stages.some(item => item.state !== "passed")) refuse();
  const final = plan.stages.find(item => item.stage === "final_review");
  if (!final) refuse();
  const finalStage = final!;
  if (plan.revision < 1 || finalStage.recordedRevision !== plan.revision) refuse();
  // A settled plan alone cannot reconstruct the preceding running revision.
  // Bind its authenticated terminal digest and all passed prior-stage evidence;
  // the journal-bound startup layer remains responsible for the original history.
  if (!finalStage.inputDigest || !finalStage.outcomeDigest || !installationId) refuse();
  return plan;
}

/**
 * Re-reads one committed transition and proves that it is exactly the additive
 * Claude transition described by protected staged configuration. The returned
 * receipt is evidence only: it cannot publish a route or invoke a process.
 */
export async function verifyLocalClaudePostInstallAdmissionV1(input: LocalClaudePostInstallAdmissionInputV1,
  runtime: LocalClaudePostInstallAdmissionRuntimeV1): Promise<LocalClaudePostInstallAdmissionV1> {
  try {
    const installationId = id.parse(input.installationId);
    if (!runtime || typeof runtime.readOriginalInstallationHistory !== "function"
      || typeof runtime.readTransition !== "function") refuse();
    const original = settledOriginalPlan(input.originalInstallationPlan, installationId);
    const history = await runtime.readOriginalInstallationHistory();
    if (!Array.isArray(history) || history.length !== original.revision + 1) refuse();
    const historical = history.map(item => verifyInstallationPlanV1(item));
    if (historical.at(-1)?.planDigest !== original.planDigest || historical.some((item, index) => item.revision !== index)) refuse();
    const finalRunning = historical.at(-2) as InstallationPlanV1 | undefined;
    if (!finalRunning || finalRunning.stages.find(item => item.stage === "final_review")?.state !== "running") refuse();
    const expectedFinal = finalReviewOutcome(installationId, finalRunning!);
    const finalStage = original.stages.find(item => item.stage === "final_review");
    if (finalStage?.inputDigest !== expectedFinal.inputDigest || finalStage.outcomeDigest !== expectedFinal.outcomeDigest) refuse();
    const originalTopologyInput = installationTopologyInputSchemaV1.parse(input.originalTopologyInput);
    const originalTopology = planInstallationTopologyV1(originalTopologyInput);
    if (original.topologyPlanDigest !== originalTopology.planDigest) refuse();
    const transitionTopologyInput = installationTopologyInputSchemaV1.parse(input.transitionTopologyInput);
    const topology = planInstallationTopologyV1(transitionTopologyInput);
    const workerRoute = route.parse(input.workerRoute);
    const requestedRoutes = installationTopologyInputSchemaV1.shape.requestedRoutes.parse(input.requestedRoutes);
    if (canonicalJson(requestedRoutes) !== canonicalJson(transitionTopologyInput.requestedRoutes)
      || canonicalJson(transitionTopologyInput.currentRoutes) !== canonicalJson(originalTopologyInput.requestedRoutes)
      || transitionTopologyInput.databaseAuthorityDigest !== originalTopology.databaseAuthorityDigest
      || transitionTopologyInput.schedulerAuthorityDigest !== originalTopology.schedulerAuthorityDigest
      || topology.addedLocalWorkerIds.length !== 1 || topology.addedLocalWorkerIds[0] !== workerRoute.workerId
      || topology.addedRemoteWorkerIds.length !== 0 || topology.reboundWorkerIds.length !== 0
      || topology.removedWorkerIds.length !== 0
      || !transitionTopologyInput.requestedRoutes.some(value => canonicalJson(value) === canonicalJson(workerRoute))
      || !originalTopologyInput.requestedRoutes.some(value => value.kind === "local"
        && value.adapterId === HERMES_021_MACOS_LOCAL_ADAPTER_V1)) refuse();

    const transitionId = id.parse(input.transitionId);
    const transition = verifyInstallationTransitionV1(await runtime.readTransition(transitionId));
    if (transition.transitionId !== transitionId || transition.state !== "committed"
      || transition.planDigest !== topology.planDigest
      || canonicalJson(transition.affectedWorkerIds) !== canonicalJson([workerRoute.workerId])) refuse();

    const processConfiguration = capturePrivateClaudeCodeInstalledProcessHostConfigurationV1(input.installedProcessConfiguration);
    const readiness = verifyClaudeCodeLocalProcessReadinessV1(input.processReadiness);
    if (summarizeClaudeCodeLocalProcessReadinessV1(topology.planDigest, readiness).state !== "readiness_recorded") refuse();
    const observed = observation.parse(input.processObservation);
    const workerRouteDigest = sha256Digest(workerRoute);
    const processConfigurationDigest = sha256Digest({ purpose: "local-claude-installed-process-configuration/v1",
      configuration: processConfiguration });
    if (observed.topologyPlanDigest !== topology.planDigest || observed.releaseDigest !== original.releaseDigest
      || observed.workerRouteDigest !== workerRouteDigest
      || observed.connectorProfileDigest !== CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1
      || observed.processConfigurationDigest !== processConfigurationDigest
      || observed.processReadinessDigest !== readiness.readinessDigest) refuse();

    const storage = capturePrivateArtifactStorageConfigurationV1(input.protectedResultStorage as never);
    if (storage.inventory.releaseDigest !== original.releaseDigest) refuse();
    const service = captureLocalPlatformServiceObservationV1(input.serviceObservation);
    if (service.state !== "running" || service.topologyPlanDigest !== originalTopology.planDigest
      || service.releaseDigest !== original.releaseDigest
      || service.databaseAuthorityDigest !== originalTopology.databaseAuthorityDigest) refuse();
    const permitted = workspace.parse(input.permittedWorkspace);
    if (permitted.workingDirectory !== processConfiguration.process.workingDirectory
      || permitted.bindingDigest !== processConfiguration.workingDirectoryBindingDigest) refuse();

    const material = { installationId, originalInstallationPlanDigest: original.planDigest,
      originalInstallationPlanRevision: original.revision, originalTopologyPlanDigest: originalTopology.planDigest,
      transitionId, transitionDigest: transition.transitionDigest, transitionPlanDigest: topology.planDigest,
      databaseAuthorityDigest: topology.databaseAuthorityDigest, schedulerAuthorityDigest: topology.schedulerAuthorityDigest,
      requestedRouteDigest: topology.requestedRouteDigest, workerRouteDigest, workerId: workerRoute.workerId,
      adapterId: workerRoute.adapterId, adapterRevision: workerRoute.adapterRevision,
      connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
      processConfigurationDigest, processReadinessDigest: readiness.readinessDigest,
      processObservationDigest: sha256Digest(observed), protectedResultStorageDigest: sha256Digest(storage),
      serviceObservationDigest: sha256Digest(service), releaseDigest: original.releaseDigest,
      workspaceBindingDigest: permitted.bindingDigest };
    const { transitionDigest: _transitionDigest, ...reviewedMaterial } = material; void _transitionDigest;
    const evidenceDigest = sha256Digest({ purpose: "local-claude-post-install-reviewed-evidence/v1",
      admission: reviewedMaterial });
    if (transition.evidenceDigest !== evidenceDigest) refuse();
    const body = { schema: LOCAL_CLAUDE_POST_INSTALL_ADMISSION_V1, ...material, evidenceDigest,
      transitionPublishesRoute: false as const, retainsBootstrapHermes: true as const,
      createsStateMachine: false as const, createsStore: false as const, createsScheduler: false as const,
      grantsExecutionAuthority: false as const };
    return Object.freeze({ ...body,
      admissionDigest: sha256Digest({ purpose: "local-claude-post-install-admission/v1", receipt: body }) });
  } catch { return refuse(); }
}

/** Synchronous identity check used immediately before exposing queue delivery. */
export function verifyLocalClaudePostInstallAdmissionReceiptV1(value: unknown,
  expected: Readonly<{ installationId: string; originalInstallationPlanDigest: string;
    originalInstallationPlanRevision: number; originalTopologyPlanDigest: string; releaseDigest: string;
    databaseAuthorityDigest: string; schedulerAuthorityDigest: string; adapterId: typeof CLAUDE_CODE_LOCAL_ADAPTER_V1;
    workerId?: string; adapterRevision?: string; processConfiguration?: unknown; workspaceBindingDigest?: string }>) {
  try {
    const receipt = Object.freeze(receiptSchema.parse(value)) as LocalClaudePostInstallAdmissionV1;
    if (receipt.installationId !== id.parse(expected.installationId)
      || receipt.originalInstallationPlanDigest !== digest.parse(expected.originalInstallationPlanDigest)
      || receipt.originalInstallationPlanRevision !== z.number().int().nonnegative().parse(expected.originalInstallationPlanRevision)
      || receipt.originalTopologyPlanDigest !== digest.parse(expected.originalTopologyPlanDigest)
      || receipt.releaseDigest !== digest.parse(expected.releaseDigest)
      || receipt.databaseAuthorityDigest !== digest.parse(expected.databaseAuthorityDigest)
      || receipt.schedulerAuthorityDigest !== digest.parse(expected.schedulerAuthorityDigest)
      || receipt.adapterId !== expected.adapterId || expected.adapterId !== CLAUDE_CODE_LOCAL_ADAPTER_V1
      || (expected.workerId !== undefined && receipt.workerId !== expected.workerId)
      || (expected.adapterRevision !== undefined && receipt.adapterRevision !== expected.adapterRevision)
      || (expected.processConfiguration !== undefined && receipt.processConfigurationDigest !== sha256Digest({
        purpose: "local-claude-installed-process-configuration/v1",
        configuration: capturePrivateClaudeCodeInstalledProcessHostConfigurationV1(expected.processConfiguration) }))
      || (expected.workspaceBindingDigest !== undefined
        && receipt.workspaceBindingDigest !== digest.parse(expected.workspaceBindingDigest))
      || receipt.transitionPublishesRoute !== false || receipt.retainsBootstrapHermes !== true
      || receipt.createsStateMachine !== false || receipt.createsStore !== false || receipt.createsScheduler !== false
      || receipt.grantsExecutionAuthority !== false) refuse();
    const { admissionDigest, ...body } = receipt;
    if (admissionDigest !== sha256Digest({ purpose: "local-claude-post-install-admission/v1", receipt: body })) refuse();
    return receipt;
  } catch { return refuse(); }
}
