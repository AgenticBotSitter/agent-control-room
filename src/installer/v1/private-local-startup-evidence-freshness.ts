import { sha256Digest } from "../../security/canonical-digest";
import { exactHostDataSnapshotV1 } from "../../security/host-value";

/**
 * Pure, redacted L2 startup-evidence freshness contract. It accepts no
 * readers, callbacks, credentials, processes, storage, or service ports.
 */
export const PRIVATE_LOCAL_STARTUP_EVIDENCE_PREPARATION_V1 =
  "control-room.private-local-startup-evidence-preparation/v1" as const;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;

const evidenceNames = [
  "installationId",
  "installationPlanDigest",
  "installationPlanRevision",
  "topologyPlanDigest",
  "releaseDigest",
  "installedConfigurationBindingDigest",
  "firstOwnerEvidenceDigest",
  "protectedDataEvidenceDigest",
  "databaseEvidenceDigest",
  "schedulerEvidenceDigest",
  "recoveryEvidenceDigest",
  "performsEffect",
  "opensDatabase",
  "opensArtifactStore",
  "startsService",
  "startsWorker",
  "invokesHermes",
] as const;

const preparationNames = ["schema", ...evidenceNames, "preparationDigest"] as const;
const secondPassNames = [
  ...preparationNames,
  "supersedesPreparationDigest",
  "secondPreparationDigest",
] as const;

type StartupEvidenceMaterialV1 = Readonly<{
  installationId: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  installedConfigurationBindingDigest: string;
  firstOwnerEvidenceDigest: string;
  protectedDataEvidenceDigest: string;
  databaseEvidenceDigest: string;
  schedulerEvidenceDigest: string;
  recoveryEvidenceDigest: string;
  performsEffect: false;
  opensDatabase: false;
  opensArtifactStore: false;
  startsService: false;
  startsWorker: false;
  invokesHermes: false;
}>;

export type PrivateLocalStartupEvidencePreparationInputV1 = StartupEvidenceMaterialV1;

export type PrivateLocalStartupEvidencePreparationV1 = Readonly<{
  schema: typeof PRIVATE_LOCAL_STARTUP_EVIDENCE_PREPARATION_V1;
  preparationDigest: string;
} & StartupEvidenceMaterialV1>;

export type PrivateLocalStartupEvidenceSecondPassV1 = Readonly<
  PrivateLocalStartupEvidencePreparationV1 & {
    supersedesPreparationDigest: string;
    secondPreparationDigest: string;
  }
>;

const refuse = (): never => {
  const error = new Error("private_local_startup_evidence_freshness_refused");
  error.stack = undefined;
  throw error;
};

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refuse();
  return value;
}

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  const snapshot = exactHostDataSnapshotV1(value, names);
  if (!snapshot) return refuse();
  return snapshot;
}

function captureMaterial(value: unknown): StartupEvidenceMaterialV1 {
  const input = exact(value, evidenceNames);
  if (typeof input.installationId !== "string" || !installationIdPattern.test(input.installationId)
    || typeof input.installationPlanRevision !== "number"
    || !Number.isSafeInteger(input.installationPlanRevision) || input.installationPlanRevision < 0
    || input.performsEffect !== false || input.opensDatabase !== false || input.opensArtifactStore !== false
    || input.startsService !== false || input.startsWorker !== false || input.invokesHermes !== false) return refuse();
  return Object.freeze({
    installationId: input.installationId,
    installationPlanDigest: digest(input.installationPlanDigest),
    installationPlanRevision: input.installationPlanRevision,
    topologyPlanDigest: digest(input.topologyPlanDigest),
    releaseDigest: digest(input.releaseDigest),
    installedConfigurationBindingDigest: digest(input.installedConfigurationBindingDigest),
    firstOwnerEvidenceDigest: digest(input.firstOwnerEvidenceDigest),
    protectedDataEvidenceDigest: digest(input.protectedDataEvidenceDigest),
    databaseEvidenceDigest: digest(input.databaseEvidenceDigest),
    schedulerEvidenceDigest: digest(input.schedulerEvidenceDigest),
    recoveryEvidenceDigest: digest(input.recoveryEvidenceDigest),
    performsEffect: false,
    opensDatabase: false,
    opensArtifactStore: false,
    startsService: false,
    startsWorker: false,
    invokesHermes: false,
  });
}

function preparationDigest(material: StartupEvidenceMaterialV1): string {
  return sha256Digest({
    purpose: "private-local-startup-evidence-preparation/v1",
    preparation: { schema: PRIVATE_LOCAL_STARTUP_EVIDENCE_PREPARATION_V1, ...material },
  });
}

function capturePreparation(value: unknown): PrivateLocalStartupEvidencePreparationV1 {
  const input = exact(value, preparationNames);
  if (input.schema !== PRIVATE_LOCAL_STARTUP_EVIDENCE_PREPARATION_V1) return refuse();
  const material = captureMaterial(Object.fromEntries(evidenceNames.map(name => [name, input[name]])));
  const computed = preparationDigest(material);
  if (input.preparationDigest !== computed) return refuse();
  return Object.freeze({ schema: PRIVATE_LOCAL_STARTUP_EVIDENCE_PREPARATION_V1, ...material,
    preparationDigest: computed });
}

/** A second source may arrive as raw redacted material or as a prior frozen preparation. */
function captureCurrentPreparation(value: unknown): PrivateLocalStartupEvidencePreparationV1 {
  const prepared = exactHostDataSnapshotV1(value, preparationNames);
  return prepared ? capturePreparation(prepared) : preparePrivateLocalStartupEvidenceV1(value);
}

function sameMaterial(left: StartupEvidenceMaterialV1, right: StartupEvidenceMaterialV1): boolean {
  return evidenceNames.every(name => left[name] === right[name]);
}

function secondPassDigest(second: Omit<PrivateLocalStartupEvidenceSecondPassV1, "secondPreparationDigest">): string {
  return sha256Digest({ purpose: "private-local-startup-evidence-second-pass/v1", second });
}

function captureSecondPass(value: unknown): PrivateLocalStartupEvidenceSecondPassV1 {
  const input = exact(value, secondPassNames);
  const preparation = capturePreparation(Object.fromEntries(preparationNames.map(name => [name, input[name]])));
  const supersedesPreparationDigest = digest(input.supersedesPreparationDigest);
  const body = Object.freeze({ ...preparation, supersedesPreparationDigest });
  const computed = secondPassDigest(body);
  if (input.secondPreparationDigest !== computed) return refuse();
  return Object.freeze({ ...body, secondPreparationDigest: computed });
}

/** Captures one exact, inert, redacted L2 evidence snapshot. */
export function preparePrivateLocalStartupEvidenceV1(input: unknown): PrivateLocalStartupEvidencePreparationV1 {
  const material = captureMaterial(input);
  return Object.freeze({ schema: PRIVATE_LOCAL_STARTUP_EVIDENCE_PREPARATION_V1, ...material,
    preparationDigest: preparationDigest(material) });
}

/**
 * Binds a separately supplied current snapshot to the first snapshot. The
 * second digest is distinct even when the two independently captured
 * redacted snapshots contain the same L2 evidence values.
 */
export function preparePrivateLocalStartupEvidenceSecondPassV1(first: unknown,
  currentInput: unknown): PrivateLocalStartupEvidenceSecondPassV1 {
  const previous = capturePreparation(first);
  const current = captureCurrentPreparation(currentInput);
  const previousMaterial = captureMaterial(Object.fromEntries(evidenceNames.map(name => [name, previous[name]])));
  const currentMaterial = captureMaterial(Object.fromEntries(evidenceNames.map(name => [name, current[name]])));
  if (!sameMaterial(previousMaterial, currentMaterial)) return refuse();
  const body = Object.freeze({ ...current, supersedesPreparationDigest: previous.preparationDigest });
  return Object.freeze({ ...body, secondPreparationDigest: secondPassDigest(body) });
}

/** Verifies both redacted snapshots, their exact evidence values, and freshness succession. */
export function verifyPrivateLocalStartupEvidenceSecondPassV1(first: unknown,
  second: unknown): PrivateLocalStartupEvidenceSecondPassV1 {
  const previous = capturePreparation(first);
  const current = captureSecondPass(second);
  const previousMaterial = captureMaterial(Object.fromEntries(evidenceNames.map(name => [name, previous[name]])));
  const currentMaterial = captureMaterial(Object.fromEntries(evidenceNames.map(name => [name, current[name]])));
  if (!sameMaterial(previousMaterial, currentMaterial)
    || current.supersedesPreparationDigest !== previous.preparationDigest) return refuse();
  return current;
}
