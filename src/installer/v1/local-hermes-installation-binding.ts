import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { installationTopologyInputSchemaV1, planInstallationTopologyV1 } from "../../harness/v1/installation-topology";
import { verifyInstallationReadinessV1 } from "../../harness/v1/installation-readiness";
import { verifyLocalBackupRestoreReadinessV1 } from "../../harness/v1/local-backup-restore-readiness";
import { summarizeLocalSupervisorReadinessV1, verifyLocalSupervisorReadinessV1 } from "../../harness/v1/local-supervisor-readiness";
import { HERMES_021_SOURCE_REVISION_V1 } from "../../harness/hermes-021-v1/connector-profile";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, hermes021MacosLocalBindingSchemaV1 } from "../../harness/hermes-021-v1/macos-local-worker";
import { captureHermes021MacosSubprocessHostConfigurationV1 } from "../../harness/hermes-021-v1/subprocess-stream-json-host";
import { createHermes021MacosLocalRunnerQualificationEvidenceV1 } from "../../harness/hermes-021-v1/runner-qualification-evidence";
import { verifyInstallationPlanV1 } from "./installation-plan";

/** Installer-private preparation only. No returned value is an admission grant. */
export const LOCAL_HERMES_INSTALLATION_BINDING_V1 = "control-room.local-hermes-installation-binding/v1" as const;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const qualificationObservation = z.object({
  state: z.enum(["passed", "failed", "uncertain", "revoked"]),
  topologyPlanDigest: digest, releaseDigest: digest, workerBindingDigest: digest,
  runnerConfigurationDigest: digest, qualificationEvidenceDigest: digest,
  observationDigest: digest,
}).strict();
const serviceObservation = z.object({
  state: z.enum(["running", "stopped", "failed", "uncertain", "revoked"]),
  topologyPlanDigest: digest, releaseDigest: digest, serviceIdentityDigest: digest,
  databaseAuthorityDigest: digest, protectedDataBindingDigest: digest,
  supervisorReadinessDigest: digest, observationDigest: digest,
}).strict();
const stageBindings = z.object({ topologyPlanDigest: digest, releaseDigest: digest,
  workerBindingDigest: digest, runnerConfigurationDigest: digest,
  qualificationEvidenceDigest: digest, qualificationObservationDigest: digest,
  installationReadinessDigest: digest, recoveryProofDigest: digest,
  supervisorReadinessDigest: digest, serviceObservationDigest: digest,
}).strict();
const resultSchema = stageBindings.extend({ schema: z.literal(LOCAL_HERMES_INSTALLATION_BINDING_V1),
  installationPlanDigest: digest, installationPlanRevision: z.number().int().nonnegative(),
  stage: z.literal("agent_readiness"), stageInputDigest: digest,
  taskClass: z.literal("text_review"), nextOperation: z.literal("owner_review_local_hermes_enablement"),
  preparationDigest: digest, startsWork: z.literal(false), enablesWorker: z.literal(false),
  grantsExecutionAuthority: z.literal(false), createsCallback: z.literal(false),
}).strict();
export type LocalHermesInstallationBindingV1 = Readonly<z.infer<typeof resultSchema>>;
export type LocalHermesInstallationBindingInputV1 = Readonly<{
  installationPlan: unknown; topologyInput: unknown; installationReadiness: unknown;
  workerBinding: unknown; runnerConfiguration: unknown; runnerQualificationReport: unknown;
  /** Supplied by the protected installer after rechecking its retained observation.
   * A sanitized successful report alone does not bind executable/settings. */
  qualificationObservation: unknown;
  backupRestoreProof: unknown; supervisorReadiness: unknown; serviceObservation: unknown;
}>;
const refuse = (): never => { throw new Error("local_hermes_installation_binding_refused"); };

/** Hashes only the existing captured fixed-runner configuration. Never returns it. */
export function localHermesRunnerConfigurationDigestV1(value: unknown): string {
  try { return sha256Digest({ purpose: "local-hermes-runner-configuration/v1",
    configuration: captureHermes021MacosSubprocessHostConfigurationV1(value) }); }
  catch { return refuse(); }
}

/** This is the completion digest recorded by the private service action after
 * observing health. Preparing a service lifecycle is not a health observation. */
export function localHermesServiceObservationDigestV1(value: unknown): string {
  try { return sha256Digest({ purpose: "local-hermes-service-observation/v1", observation: serviceObservation.parse(value) }); }
  catch { return refuse(); }
}

/** Stable stage input excludes the evolving installation-plan revision. */
export function localHermesInstallationStageInputDigestV1(value: unknown): string {
  try { return sha256Digest({ purpose: "local-hermes-installation-stage/v1", bindings: stageBindings.parse(value) }); }
  catch { return refuse(); }
}

/** Reuses the already qualified runner, canonical queue and result pipeline.
 * This pure function neither constructs a runnable callback nor imports a queue.
 * The private effectful host must recheck current observations before enablement. */
export function prepareLocalHermesInstallationBindingV1(input: LocalHermesInstallationBindingInputV1): LocalHermesInstallationBindingV1 {
  try {
    const plan = verifyInstallationPlanV1(input.installationPlan);
    const topologyInput = installationTopologyInputSchemaV1.parse(input.topologyInput);
    const topology = planInstallationTopologyV1(topologyInput);
    const binding = hermes021MacosLocalBindingSchemaV1.parse(input.workerBinding);
    const runnerConfigurationDigest = localHermesRunnerConfigurationDigestV1(input.runnerConfiguration);
    const workerBindingDigest = sha256Digest(binding);
    const qualification = createHermes021MacosLocalRunnerQualificationEvidenceV1(input.runnerQualificationReport);
    const qualified = qualificationObservation.parse(input.qualificationObservation);
    const readiness = verifyInstallationReadinessV1(input.installationReadiness);
    const recovery = verifyLocalBackupRestoreReadinessV1(input.backupRestoreProof);
    const supervisor = verifyLocalSupervisorReadinessV1(input.supervisorReadiness);
    const service = serviceObservation.parse(input.serviceObservation);
    const route = topologyInput.requestedRoutes.find(item => item.workerId === binding.workerId);
    const stage = plan.stages.find(item => item.stage === "agent_readiness");
    const recovered = plan.stages.find(item => item.stage === "recovery");
    const supervised = plan.stages.find(item => item.stage === "platform_service");
    const protectedData = plan.stages.find(item => item.stage === "protected_data");
    if (!stage || !recovered || !supervised || !protectedData) return refuse();
    if (plan.topologyPlanDigest !== topology.planDigest || readiness.planDigest !== topology.planDigest
      || !route || route.kind !== "local" || route.adapterId !== HERMES_021_MACOS_LOCAL_ADAPTER_V1
      || binding.sourceRevision !== HERMES_021_SOURCE_REVISION_V1 || route.adapterRevision !== binding.sourceRevision
      || stage.state !== "running" || recovered.state !== "passed" || supervised.state !== "passed"
      || protectedData.state !== "passed") refuse();
    for (const proof of ["local_owner_qualification", "local_runner_bridge", "backup_restore"] as const) {
      if (!topology.requiredProofs.includes(proof) || readiness.proofs.find(item => item.proof === proof)?.state !== "passed") refuse();
    }
    if (qualified.state !== "passed" || qualified.topologyPlanDigest !== topology.planDigest
      || qualified.releaseDigest !== plan.releaseDigest || qualified.workerBindingDigest !== workerBindingDigest
      || qualified.runnerConfigurationDigest !== runnerConfigurationDigest
      || qualified.qualificationEvidenceDigest !== qualification.evidenceDigest
      || readiness.proofs.find(item => item.proof === "local_runner_bridge")?.evidenceDigest !== qualification.evidenceDigest) refuse();
    if (recovery.planDigest !== topology.planDigest || recovery.releaseDigest !== plan.releaseDigest
      || recovered.outcomeDigest !== recovery.proofDigest
      || readiness.proofs.find(item => item.proof === "backup_restore")?.evidenceDigest !== recovery.proofDigest) refuse();
    if (summarizeLocalSupervisorReadinessV1(topology.planDigest, supervisor).state !== "readiness_recorded"
      || service.state !== "running" || service.topologyPlanDigest !== topology.planDigest
      || service.releaseDigest !== plan.releaseDigest || service.databaseAuthorityDigest !== topology.databaseAuthorityDigest
      || service.protectedDataBindingDigest !== protectedData.outcomeDigest
      || service.supervisorReadinessDigest !== supervisor.readinessDigest) refuse();
    const serviceObservationDigest = localHermesServiceObservationDigestV1(service);
    if (supervised.outcomeDigest !== serviceObservationDigest) refuse();
    const bound = { topologyPlanDigest: topology.planDigest, releaseDigest: plan.releaseDigest,
      workerBindingDigest, runnerConfigurationDigest, qualificationEvidenceDigest: qualification.evidenceDigest,
      qualificationObservationDigest: sha256Digest(qualified), installationReadinessDigest: readiness.readinessDigest,
      recoveryProofDigest: recovery.proofDigest, supervisorReadinessDigest: supervisor.readinessDigest, serviceObservationDigest };
    const stageInputDigest = localHermesInstallationStageInputDigestV1(bound);
    if (stage.inputDigest !== stageInputDigest) refuse();
    const material = { schema: LOCAL_HERMES_INSTALLATION_BINDING_V1, ...bound,
      installationPlanDigest: plan.planDigest, installationPlanRevision: plan.revision,
      stage: "agent_readiness" as const, stageInputDigest, taskClass: "text_review" as const,
      nextOperation: "owner_review_local_hermes_enablement" as const,
      startsWork: false as const, enablesWorker: false as const,
      grantsExecutionAuthority: false as const, createsCallback: false as const };
    return Object.freeze({ ...material, preparationDigest: sha256Digest(material) });
  } catch { return refuse(); }
}

/** A saved preparation never validates itself: replay it against separately
 * supplied current private inputs so revoked or changed proof is refused. */
export function verifyLocalHermesInstallationBindingV1(value: unknown,
  input: LocalHermesInstallationBindingInputV1): LocalHermesInstallationBindingV1 {
  try {
    const parsed = resultSchema.parse(value), expected = prepareLocalHermesInstallationBindingV1(input);
    if (canonicalJson(parsed) !== canonicalJson(expected)) refuse();
    return expected;
  } catch { return refuse(); }
}
