import { z } from "zod";
import { types } from "node:util";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { installationTopologyInputSchemaV1, planInstallationTopologyV1,
  verifyInstallationTopologyPlanV1 } from "../v1/installation-topology";
import { HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1, HERMES_021_SOURCE_REVISION_V1,
  HERMES_021_VERSION_V1 } from "./connector-profile";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_MACOS_LOCAL_CAPABILITY_V1,
  hermes021MacosLocalBindingSchemaV1 } from "./macos-local-worker";
import { hermes021MacosRunnerConfigurationDigestV1,
  verifyHermes021MacosInstallationBoundRunnerQualificationEvidenceV1 } from "./runner-qualification-evidence";

/**
 * Protected, non-executing join between the already completed fixed-runner
 * qualification and one exact installed local worker selection. The record is
 * useful only when replayed against current private inputs; it is not an
 * admission token, queue entry, callback, or task permission.
 */
export const HERMES_021_MACOS_PROTECTED_WORKER_READINESS_V1 =
  "control-room.hermes-021-macos-protected-worker-readiness/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const installationId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u);
const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);

const workerRegistrationSchema = z.object({
  workerId: id,
  adapterId: z.literal(HERMES_021_MACOS_LOCAL_ADAPTER_V1),
  adapterRevision: z.literal(HERMES_021_SOURCE_REVISION_V1),
  capabilityId: z.literal(HERMES_021_MACOS_LOCAL_CAPABILITY_V1),
  connectorProfileDigest: z.literal(HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1),
  taskClass: z.literal("text_review"),
  maximumTurns: z.literal(1),
  maximumConcurrentTasks: z.literal(1),
}).strict();

const readinessSchema = z.object({
  schema: z.literal(HERMES_021_MACOS_PROTECTED_WORKER_READINESS_V1),
  installationId,
  releaseDigest: digest,
  topologyPlanDigest: digest,
  databaseAuthorityDigest: digest,
  schedulerAuthorityDigest: digest,
  workerRegistration: workerRegistrationSchema,
  workerBindingDigest: digest,
  runnerConfigurationDigest: digest,
  qualificationEvidenceDigest: digest,
  state: z.literal("qualification_recorded_owner_enablement_required"),
  startsHermes: z.literal(false),
  startsService: z.literal(false),
  createsDatabaseEntry: z.literal(false),
  sendsTask: z.literal(false),
  enablesWorker: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  readinessDigest: digest,
}).strict();

export type Hermes021MacosProtectedWorkerReadinessV1 = Readonly<z.infer<typeof readinessSchema>>;

export type Hermes021MacosProtectedWorkerReadinessInputV1 = Readonly<{
  installationId: string;
  releaseDigest: string;
  topologyInput: unknown;
  topologyPlan: unknown;
  workerBinding: unknown;
  runnerConfiguration: unknown;
  runnerQualificationReport: unknown;
  runnerQualificationEvidence: unknown;
}>;

const unavailable = (): never => {
  const error = new Error("hermes_021_macos_protected_worker_readiness_unavailable");
  error.stack = undefined;
  throw error;
};

function exactInput(value: unknown): Hermes021MacosProtectedWorkerReadinessInputV1 {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return unavailable();
  const names = ["installationId", "releaseDigest", "topologyInput", "topologyPlan", "workerBinding",
    "runnerConfiguration", "runnerQualificationReport", "runnerQualificationEvidence"] as const;
  const actual = Object.getOwnPropertyNames(value);
  if (actual.length !== names.length || actual.some(name => !names.includes(name as typeof names[number]))) return unavailable();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return unavailable();
  }
  return value as Hermes021MacosProtectedWorkerReadinessInputV1;
}

function freeze(readiness: z.infer<typeof readinessSchema>): Hermes021MacosProtectedWorkerReadinessV1 {
  return Object.freeze({ ...readiness, workerRegistration: Object.freeze({ ...readiness.workerRegistration }) });
}

/**
 * Converts protected inputs already selected by the installation host into a
 * redacted readiness record. Parsing and hashing are the only operations: the
 * function has no runner, filesystem, database, service, queue, or task port.
 */
export function createHermes021MacosProtectedWorkerReadinessV1(inputValue: unknown):
Hermes021MacosProtectedWorkerReadinessV1 {
  try {
    const input = exactInput(inputValue);
    const selectedInstallationId = installationId.parse(input.installationId);
    const selectedReleaseDigest = digest.parse(input.releaseDigest);
    const topologyInput = installationTopologyInputSchemaV1.parse(input.topologyInput);
    const topologyPlan = verifyInstallationTopologyPlanV1(input.topologyPlan);
    const expectedTopologyPlan = planInstallationTopologyV1(topologyInput);
    if (canonicalJson(topologyPlan) !== canonicalJson(expectedTopologyPlan)) return unavailable();

    const workerBinding = hermes021MacosLocalBindingSchemaV1.parse(input.workerBinding);
    if (workerBinding.expectedVersion !== HERMES_021_VERSION_V1
      || workerBinding.sourceRevision !== HERMES_021_SOURCE_REVISION_V1) return unavailable();
    const route = topologyInput.requestedRoutes.find(candidate => candidate.workerId === workerBinding.workerId);
    if (!route || route.kind !== "local" || route.adapterId !== HERMES_021_MACOS_LOCAL_ADAPTER_V1
      || route.adapterRevision !== HERMES_021_SOURCE_REVISION_V1
      || !topologyPlan.requiredProofs.includes("local_owner_qualification")
      || !topologyPlan.requiredProofs.includes("local_runner_bridge")) return unavailable();

    const qualificationInput = { installationId: selectedInstallationId, releaseDigest: selectedReleaseDigest,
      topologyPlan, workerBinding, runnerConfiguration: input.runnerConfiguration,
      runnerQualificationReport: input.runnerQualificationReport };
    const qualification = verifyHermes021MacosInstallationBoundRunnerQualificationEvidenceV1(
      input.runnerQualificationEvidence, qualificationInput);
    const workerRegistration = Object.freeze({ workerId: workerBinding.workerId,
      adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1, adapterRevision: HERMES_021_SOURCE_REVISION_V1,
      capabilityId: HERMES_021_MACOS_LOCAL_CAPABILITY_V1,
      connectorProfileDigest: HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1,
      taskClass: "text_review" as const, maximumTurns: 1 as const, maximumConcurrentTasks: 1 as const });
    const material = { schema: HERMES_021_MACOS_PROTECTED_WORKER_READINESS_V1,
      installationId: selectedInstallationId, releaseDigest: selectedReleaseDigest,
      topologyPlanDigest: topologyPlan.planDigest,
      databaseAuthorityDigest: topologyPlan.databaseAuthorityDigest,
      schedulerAuthorityDigest: topologyPlan.schedulerAuthorityDigest,
      workerRegistration,
      workerBindingDigest: sha256Digest(workerBinding),
      runnerConfigurationDigest: hermes021MacosRunnerConfigurationDigestV1(input.runnerConfiguration),
      qualificationEvidenceDigest: qualification.evidenceDigest,
      state: "qualification_recorded_owner_enablement_required" as const,
      startsHermes: false as const, startsService: false as const, createsDatabaseEntry: false as const,
      sendsTask: false as const, enablesWorker: false as const, grantsExecutionAuthority: false as const };
    return freeze(readinessSchema.parse({ ...material,
      readinessDigest: sha256Digest({ purpose: "hermes-021-protected-worker-readiness/v1", readiness: material }) }));
  } catch {
    return unavailable();
  }
}

/** Re-derives the record from current protected inputs so a saved readiness
 * value cannot survive installation, route, runner-setting, or qualification
 * substitution. */
export function verifyHermes021MacosProtectedWorkerReadinessV1(value: unknown, currentInput: unknown):
Hermes021MacosProtectedWorkerReadinessV1 {
  try {
    const parsed = readinessSchema.parse(value);
    const expected = createHermes021MacosProtectedWorkerReadinessV1(currentInput);
    if (canonicalJson(parsed) !== canonicalJson(expected)) return unavailable();
    return expected;
  } catch {
    return unavailable();
  }
}
