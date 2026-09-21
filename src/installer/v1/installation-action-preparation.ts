import { z } from "zod";
import { verifyInstallationTopologyPlanV1 } from "../../harness/v1/installation-topology";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationPlanV1 } from "./installation-plan";
import { preparePlatformServiceLifecycleV1 } from "./platform-service-lifecycle";
import { preparePostgresSetupV1 } from "./postgres-setup-preparation";
import { prepareProtectedDataV1, prepareRecoveryV1 } from "./protected-data-recovery-preparation";

/**
 * Thin installation-owned composition over the existing I3-I5 preparation
 * contracts. It owns no journal, authority, observations, or effect ports.
 * The `source` object is trusted private composition data, never request data.
 */
export const INSTALLATION_ACTION_PREPARATION_V1 = "control-room.installation-action-preparation/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const action = z.enum(["postgres", "protected_data", "recovery", "platform_service"]);
const schema = z.object({
  schema: z.literal(INSTALLATION_ACTION_PREPARATION_V1),
  action,
  stage: z.enum(["database_authority", "protected_data", "recovery", "platform_service"]),
  installationPlanDigest: digest,
  installationPlanRevision: z.number().int().min(0),
  topologyPlanDigest: digest,
  releaseDigest: digest,
  componentDigest: digest,
  preparedAction: z.record(z.string(), z.unknown()),
  compositionDigest: digest,
  performsEffect: z.literal(false),
  runsDatabaseOperation: z.literal(false),
  touchesFilesystem: z.literal(false),
  startsService: z.literal(false),
  opensCredentialStore: z.literal(false),
  grantsAuthority: z.literal(false),
  acceptsBrowserPrivateValues: z.literal(false),
}).strict();

type Parsed = z.infer<typeof schema>;
export type InstallationActionPreparationV1 = Readonly<Omit<Parsed, "preparedAction"> & {
  preparedAction: Readonly<Record<string, unknown>>;
}>;

const refuse = (): never => { throw new Error("installation_action_preparation_refused"); };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const names = Object.getOwnPropertyNames(value);
  if (names.some(name => Object.getOwnPropertyDescriptor(value, name)?.enumerable !== true)) return refuse();
  return value as Record<string, unknown>;
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const parsed = record(value), allowed = new Set([...required, ...optional]), keys = Object.keys(parsed);
  if (required.some(key => !Object.prototype.hasOwnProperty.call(parsed, key)) || keys.some(key => !allowed.has(key))) return refuse();
  return parsed;
}

function component(inputAction: z.infer<typeof action>, plan: unknown, topology: unknown, sourceValue: unknown) {
  if (inputAction === "postgres") {
    const source = exact(sourceValue, ["ledgerDigest", "targetIdentityDigest", "observedTargetState", "observationDigest"]);
    const prepared = preparePostgresSetupV1({ installationPlan: plan,
      releaseDigest: verifyInstallationPlanV1(plan).releaseDigest, ledgerDigest: source.ledgerDigest,
      targetIdentityDigest: source.targetIdentityDigest, observedTargetState: source.observedTargetState,
      observationDigest: source.observationDigest });
    return { stage: prepared.stage, componentDigest: prepared.preparationDigest, preparedAction: prepared } as const;
  }
  if (inputAction === "protected_data") {
    const source = exact(sourceValue, ["storageConfiguration", "observedState", "observationDigest"]);
    const prepared = prepareProtectedDataV1({ installationPlan: plan,
      storageConfiguration: source.storageConfiguration as Parameters<typeof prepareProtectedDataV1>[0]["storageConfiguration"],
      observedState: source.observedState, observationDigest: source.observationDigest });
    return { stage: prepared.stage, componentDigest: prepared.preparationDigest, preparedAction: prepared } as const;
  }
  if (inputAction === "recovery") {
    const source = exact(sourceValue, ["protectedDataPreparation", "storageConfiguration", "protectedDataObservation",
      "databaseAuthorityOutcomeDigest", "expectedDatabaseIdentityDigest", "expectedDatabaseSchemaDigest",
      "observedState", "observationDigest"], ["backupRestoreProof"]);
    const prepared = prepareRecoveryV1({ installationPlan: plan, topologyPlan: topology,
      protectedDataPreparation: source.protectedDataPreparation,
      storageConfiguration: source.storageConfiguration as Parameters<typeof prepareRecoveryV1>[0]["storageConfiguration"],
      protectedDataObservation: source.protectedDataObservation as Parameters<typeof prepareRecoveryV1>[0]["protectedDataObservation"],
      databaseAuthorityOutcomeDigest: source.databaseAuthorityOutcomeDigest,
      expectedDatabaseIdentityDigest: source.expectedDatabaseIdentityDigest,
      expectedDatabaseSchemaDigest: source.expectedDatabaseSchemaDigest, observedState: source.observedState,
      observationDigest: source.observationDigest,
      ...(source.backupRestoreProof === undefined ? {} : { backupRestoreProof: source.backupRestoreProof }) });
    return { stage: prepared.stage, componentDigest: prepared.preparationDigest, preparedAction: prepared } as const;
  }
  const source = exact(sourceValue, ["action", "platform", "supervisorReadiness", "serviceIdentityDigest",
    "authorityDatabaseDigest", "protectedDataDigest", "observation"], ["targetReleaseDigest",
    "targetServiceDefinitionDigest", "previousVerifiedReleaseDigest", "previousServiceDefinitionDigest"]);
  const prepared = preparePlatformServiceLifecycleV1({ action: source.action, platform: source.platform,
    installationPlan: plan, supervisorReadiness: source.supervisorReadiness,
    serviceIdentityDigest: source.serviceIdentityDigest, authorityDatabaseDigest: source.authorityDatabaseDigest,
    protectedDataDigest: source.protectedDataDigest, observation: source.observation,
    ...(source.targetReleaseDigest === undefined ? {} : { targetReleaseDigest: source.targetReleaseDigest }),
    ...(source.targetServiceDefinitionDigest === undefined ? {} : { targetServiceDefinitionDigest: source.targetServiceDefinitionDigest }),
    ...(source.previousVerifiedReleaseDigest === undefined ? {} : { previousVerifiedReleaseDigest: source.previousVerifiedReleaseDigest }),
    ...(source.previousServiceDefinitionDigest === undefined ? {} : { previousServiceDefinitionDigest: source.previousServiceDefinitionDigest }) });
  return { stage: prepared.stage, componentDigest: prepared.lifecycleDigest, preparedAction: prepared } as const;
}

function build(input: unknown): Omit<InstallationActionPreparationV1, "compositionDigest"> {
  const envelope = exact(input, ["installationPlan", "topologyPlan", "expectedPlanRevision", "action", "source"]);
  const plan = verifyInstallationPlanV1(envelope.installationPlan), topology = verifyInstallationTopologyPlanV1(envelope.topologyPlan);
  const expectedPlanRevision = z.number().int().min(0).parse(envelope.expectedPlanRevision);
  const selectedAction = action.parse(envelope.action);
  if (plan.revision !== expectedPlanRevision || plan.topologyPlanDigest !== topology.planDigest) return refuse();
  const prepared = component(selectedAction, plan, topology, envelope.source);
  return { schema: INSTALLATION_ACTION_PREPARATION_V1, action: selectedAction, stage: prepared.stage,
    installationPlanDigest: plan.planDigest, installationPlanRevision: plan.revision,
    topologyPlanDigest: topology.planDigest, releaseDigest: plan.releaseDigest,
    componentDigest: prepared.componentDigest, preparedAction: prepared.preparedAction as Readonly<Record<string, unknown>>,
    performsEffect: false, runsDatabaseOperation: false, touchesFilesystem: false, startsService: false,
    opensCredentialStore: false, grantsAuthority: false, acceptsBrowserPrivateValues: false };
}

function freeze(value: Omit<InstallationActionPreparationV1, "compositionDigest">): InstallationActionPreparationV1 {
  const preparedAction = Object.freeze({ ...value.preparedAction });
  const material = { ...value, preparedAction };
  return Object.freeze({ ...material, compositionDigest: sha256Digest(material) });
}

/**
 * Prepares exactly one action against one already-current plan revision. All
 * private configuration and trusted observations arrive through installation
 * composition; this function exposes no browser, database, filesystem,
 * credential, service-manager, network, worker, or native effect capability.
 */
export function prepareInstallationActionV1(input: unknown): InstallationActionPreparationV1 {
  try { return freeze(build(input)); }
  catch { return refuse(); }
}

/** Rebuilds from trusted inputs, so a changed revision, release, topology, or observation refuses. */
export function verifyInstallationActionPreparationV1(value: unknown, input: unknown): InstallationActionPreparationV1 {
  try {
    const parsed = schema.parse(value), expected = prepareInstallationActionV1(input);
    if (canonicalJson(parsed) !== canonicalJson(expected)) return refuse();
    return expected;
  } catch { return refuse(); }
}
