import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { installationTopologyInputSchemaV1, planInstallationTopologyV1 } from "../../harness/v1/installation-topology";
import { verifyInstallationReadinessV1 } from "../../harness/v1/installation-readiness";
import { verifyLocalBackupRestoreReadinessV1 } from "../../harness/v1/local-backup-restore-readiness";
import { summarizeLocalSupervisorReadinessV1, verifyLocalSupervisorReadinessV1 } from "../../harness/v1/local-supervisor-readiness";
import { summarizeClaudeCodeLocalProcessReadinessV1, verifyClaudeCodeLocalProcessReadinessV1 } from "../../harness/claude-code-v1/local-process-readiness";
import { capturePrivateClaudeCodeProcessAcquisitionConfigurationV1 } from "../../harness/claude-code-v1/private-process-acquisition";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1, CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 } from "../../harness/claude-code-v1/task-planning-contract";
import { verifyInstallationPlanV1 } from "./installation-plan";
import { captureLocalPlatformServiceObservationV1, localPlatformServiceObservationDigestV1 } from "./local-platform-service-observation";

/** Private installer preparation; never a callback or admission capability. */
export const LOCAL_CLAUDE_INSTALLATION_BINDING_V1 = "control-room.local-claude-installation-binding/v1" as const;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const routeSchema = z.object({ kind: z.literal("local"),
  workerId: z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  adapterId: z.literal(CLAUDE_CODE_LOCAL_ADAPTER_V1), adapterRevision: z.string().min(7).max(180),
}).strict();
const processObservationSchema = z.object({ state: z.enum(["passed", "failed", "uncertain", "revoked"]),
  topologyPlanDigest: digest, releaseDigest: digest, workerRouteDigest: digest,
  connectorProfileDigest: digest, processConfigurationDigest: digest, processReadinessDigest: digest,
  observationDigest: digest,
}).strict();
const stageBindings = z.object({ topologyPlanDigest: digest, releaseDigest: digest, workerRouteDigest: digest,
  connectorProfileDigest: digest, processConfigurationDigest: digest, processReadinessDigest: digest,
  processObservationDigest: digest, installationReadinessDigest: digest, recoveryProofDigest: digest,
  supervisorReadinessDigest: digest, serviceObservationDigest: digest,
}).strict();
const resultSchema = stageBindings.extend({ schema: z.literal(LOCAL_CLAUDE_INSTALLATION_BINDING_V1),
  installationPlanDigest: digest, installationPlanRevision: z.number().int().nonnegative(),
  stage: z.literal("agent_readiness"), stageInputDigest: digest, taskClass: z.literal("text_review"),
  nextOperation: z.literal("qualified_private_process_host_required"), preparationDigest: digest,
  startsWork: z.literal(false), enablesWorker: z.literal(false), grantsExecutionAuthority: z.literal(false),
  createsCallback: z.literal(false), permitsRetry: z.literal(false), permitsResume: z.literal(false),
}).strict();
export type LocalClaudeInstallationBindingV1 = Readonly<z.infer<typeof resultSchema>>;
export type LocalClaudeInstallationBindingInputV1 = Readonly<{
  installationPlan: unknown; topologyInput: unknown; installationReadiness: unknown;
  workerRoute: unknown; connectorProfileDigest: unknown; processConfiguration: unknown; processReadiness: unknown;
  /** Re-read by the protected installer from retained owner evidence. The
   * readiness record alone does not bind an installed executable or release. */
  processObservation: unknown;
  backupRestoreProof: unknown; supervisorReadiness: unknown; serviceObservation: unknown;
}>;
const refuse = (): never => { throw new Error("local_claude_installation_binding_refused"); };

export function localClaudeProcessConfigurationDigestV1(value: unknown): string {
  try { return sha256Digest({ purpose: "local-claude-process-configuration/v1",
    configuration: capturePrivateClaudeCodeProcessAcquisitionConfigurationV1(value) }); }
  catch { return refuse(); }
}

/** Stable stage input excludes the changing installation-plan revision. */
export function localClaudeInstallationStageInputDigestV1(value: unknown): string {
  try { return sha256Digest({ purpose: "local-claude-installation-stage/v1", bindings: stageBindings.parse(value) }); }
  catch { return refuse(); }
}

export function prepareLocalClaudeInstallationBindingV1(input: LocalClaudeInstallationBindingInputV1): LocalClaudeInstallationBindingV1 {
  try {
    const plan = verifyInstallationPlanV1(input.installationPlan);
    const topologyInput = installationTopologyInputSchemaV1.parse(input.topologyInput);
    const topology = planInstallationTopologyV1(topologyInput), route = routeSchema.parse(input.workerRoute);
    const workerRouteDigest = sha256Digest(route);
    const connectorProfileDigest = digest.parse(input.connectorProfileDigest);
    const processConfigurationDigest = localClaudeProcessConfigurationDigestV1(input.processConfiguration);
    const process = verifyClaudeCodeLocalProcessReadinessV1(input.processReadiness);
    const observed = processObservationSchema.parse(input.processObservation);
    const readiness = verifyInstallationReadinessV1(input.installationReadiness);
    const recovery = verifyLocalBackupRestoreReadinessV1(input.backupRestoreProof);
    const supervisor = verifyLocalSupervisorReadinessV1(input.supervisorReadiness);
    const service = captureLocalPlatformServiceObservationV1(input.serviceObservation);
    const stage = plan.stages.find(item => item.stage === "agent_readiness");
    const recovered = plan.stages.find(item => item.stage === "recovery");
    const supervised = plan.stages.find(item => item.stage === "platform_service");
    const protectedData = plan.stages.find(item => item.stage === "protected_data");
    if (!stage || !recovered || !supervised || !protectedData) return refuse();
    if (plan.topologyPlanDigest !== topology.planDigest || readiness.planDigest !== topology.planDigest
      || connectorProfileDigest !== CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1
      || !topologyInput.requestedRoutes.some(item => canonicalJson(item) === canonicalJson(route))
      || stage.state !== "running" || recovered.state !== "passed" || supervised.state !== "passed"
      || protectedData.state !== "passed") refuse();
    for (const proof of ["local_owner_qualification", "local_runner_bridge", "backup_restore"] as const) {
      if (!topology.requiredProofs.includes(proof) || readiness.proofs.find(item => item.proof === proof)?.state !== "passed") refuse();
    }
    if (summarizeClaudeCodeLocalProcessReadinessV1(topology.planDigest, process).state !== "readiness_recorded"
      || observed.state !== "passed" || observed.topologyPlanDigest !== topology.planDigest
      || observed.releaseDigest !== plan.releaseDigest || observed.workerRouteDigest !== workerRouteDigest
      || observed.connectorProfileDigest !== connectorProfileDigest || observed.processConfigurationDigest !== processConfigurationDigest
      || observed.processReadinessDigest !== process.readinessDigest
      || readiness.proofs.find(item => item.proof === "local_runner_bridge")?.evidenceDigest !== process.readinessDigest) refuse();
    if (recovery.planDigest !== topology.planDigest || recovery.releaseDigest !== plan.releaseDigest
      || recovered.outcomeDigest !== recovery.proofDigest
      || readiness.proofs.find(item => item.proof === "backup_restore")?.evidenceDigest !== recovery.proofDigest) refuse();
    if (summarizeLocalSupervisorReadinessV1(topology.planDigest, supervisor).state !== "readiness_recorded"
      || service.state !== "running" || service.topologyPlanDigest !== topology.planDigest
      || service.releaseDigest !== plan.releaseDigest || service.databaseAuthorityDigest !== topology.databaseAuthorityDigest
      || service.protectedDataBindingDigest !== protectedData.outcomeDigest
      || service.supervisorReadinessDigest !== supervisor.readinessDigest) refuse();
    const serviceObservationDigest = localPlatformServiceObservationDigestV1(service);
    if (supervised.outcomeDigest !== serviceObservationDigest) refuse();
    const bound = { topologyPlanDigest: topology.planDigest, releaseDigest: plan.releaseDigest, workerRouteDigest,
      connectorProfileDigest, processConfigurationDigest, processReadinessDigest: process.readinessDigest,
      processObservationDigest: sha256Digest(observed), installationReadinessDigest: readiness.readinessDigest,
      recoveryProofDigest: recovery.proofDigest, supervisorReadinessDigest: supervisor.readinessDigest, serviceObservationDigest };
    const stageInputDigest = localClaudeInstallationStageInputDigestV1(bound);
    if (stage.inputDigest !== stageInputDigest) refuse();
    const material = { schema: LOCAL_CLAUDE_INSTALLATION_BINDING_V1, ...bound,
      installationPlanDigest: plan.planDigest, installationPlanRevision: plan.revision,
      stage: "agent_readiness" as const, stageInputDigest, taskClass: "text_review" as const,
      nextOperation: "qualified_private_process_host_required" as const,
      startsWork: false as const, enablesWorker: false as const, grantsExecutionAuthority: false as const,
      createsCallback: false as const, permitsRetry: false as const, permitsResume: false as const };
    return Object.freeze({ ...material, preparationDigest: sha256Digest(material) });
  } catch { return refuse(); }
}

/** A saved record is compared with separately re-read current private inputs;
 * its hash alone proves neither freshness nor authority. */
export function verifyLocalClaudeInstallationBindingV1(value: unknown,
  input: LocalClaudeInstallationBindingInputV1): LocalClaudeInstallationBindingV1 {
  try {
    const parsed = resultSchema.parse(value), expected = prepareLocalClaudeInstallationBindingV1(input);
    if (canonicalJson(parsed) !== canonicalJson(expected)) refuse();
    return expected;
  } catch { return refuse(); }
}
