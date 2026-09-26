import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationPlanV1, type InstallationPlanV1 } from "./installation-plan";

/** Digest-only preparation for an owner-attended use of existing PostgreSQL tools. */
export const POSTGRES_SETUP_PREPARATION_V1 = "control-room.postgres-setup-preparation/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const observed = z.enum(["fresh", "provisioned", "existing_verified", "broken"]);
const operation = z.enum(["owner_provision_database", "apply_existing_migration_ledger", "collect_existing_database_evidence"]);
const precondition = z.enum(["empty_target_and_owner_attendance", "provisioned_target_and_owner_attendance", "existing_verified_target_only"]);
const schema = z.object({ schema: z.literal(POSTGRES_SETUP_PREPARATION_V1), installationPlanDigest: digest,
  releaseDigest: digest, ledgerDigest: digest, targetIdentityDigest: digest, observedTargetState: observed.exclude(["broken"]),
  observationDigest: digest,
  stage: z.literal("database_authority"), stageInputDigest: digest, nextOperation: operation, precondition,
  preparationDigest: digest, createsDatabase: z.literal(false), runsSql: z.literal(false),
  exposesCredentials: z.literal(false), startsService: z.literal(false) }).strict();

export type PostgresSetupPreparationV1 = Readonly<z.infer<typeof schema>>;
const refuse = (): never => { throw new Error("postgres_setup_preparation_refused"); };

function operationFor(state: z.infer<typeof observed>) {
  if (state === "fresh") return Object.freeze({ nextOperation: "owner_provision_database" as const,
    precondition: "empty_target_and_owner_attendance" as const });
  if (state === "provisioned") return Object.freeze({ nextOperation: "apply_existing_migration_ledger" as const,
    precondition: "provisioned_target_and_owner_attendance" as const });
  if (state === "existing_verified") return Object.freeze({ nextOperation: "collect_existing_database_evidence" as const,
    precondition: "existing_verified_target_only" as const });
  return refuse();
}

export function postgresSetupStageInputDigestV1(input: Readonly<{
  releaseDigest: unknown; ledgerDigest: unknown; targetIdentityDigest: unknown;
}>): string {
  return sha256Digest({ purpose: "postgres-setup-stage-input/v1", releaseDigest: digest.parse(input.releaseDigest),
    ledgerDigest: digest.parse(input.ledgerDigest), targetIdentityDigest: digest.parse(input.targetIdentityDigest) });
}

function from(input: Readonly<{ installationPlan: unknown; releaseDigest: unknown; ledgerDigest: unknown;
  targetIdentityDigest: unknown; observedTargetState: unknown; observationDigest: unknown }>): Omit<PostgresSetupPreparationV1, "preparationDigest"> {
  const plan = verifyInstallationPlanV1(input.installationPlan);
  const releaseDigest = digest.parse(input.releaseDigest), ledgerDigest = digest.parse(input.ledgerDigest),
    targetIdentityDigest = digest.parse(input.targetIdentityDigest), observedTargetState = observed.parse(input.observedTargetState),
    observationDigest = digest.parse(input.observationDigest);
  if (observedTargetState === "broken") throw new Error("postgres_setup_preparation_refused");
  if (releaseDigest !== plan.releaseDigest) throw new Error("postgres_setup_preparation_refused");
  const databaseStage = plan.stages.find(item => item.stage === "database_authority");
  if (databaseStage === undefined) throw new Error("postgres_setup_preparation_refused");
  if (databaseStage.state !== "running"
    || databaseStage.inputDigest !== postgresSetupStageInputDigestV1({ releaseDigest, ledgerDigest, targetIdentityDigest })) refuse();
  const next = operationFor(observedTargetState);
  return { schema: POSTGRES_SETUP_PREPARATION_V1, installationPlanDigest: plan.planDigest, releaseDigest, ledgerDigest,
    targetIdentityDigest, observedTargetState, observationDigest, stage: "database_authority", stageInputDigest: databaseStage.inputDigest,
    ...next, createsDatabase: false, runsSql: false, exposesCredentials: false,
    startsService: false };
}

function freeze(value: Omit<PostgresSetupPreparationV1, "preparationDigest">): PostgresSetupPreparationV1 {
  return Object.freeze({ ...value, preparationDigest: sha256Digest(value) });
}

/** Prepares a redacted, single-stage operation request; it does not perform it. */
export function preparePostgresSetupV1(input: Readonly<{ installationPlan: unknown; releaseDigest: unknown; ledgerDigest: unknown;
  targetIdentityDigest: unknown; observedTargetState: unknown; observationDigest: unknown }>): PostgresSetupPreparationV1 {
  return freeze(from(input));
}

export function verifyPostgresSetupPreparationV1(value: unknown, installationPlan: unknown, observation: Readonly<{
  observedTargetState: unknown; observationDigest: unknown;
}>): PostgresSetupPreparationV1 {
  const parsed = schema.parse(value), { preparationDigest, ...material } = parsed;
  const plan = verifyInstallationPlanV1(installationPlan);
  const databaseStage = plan.stages.find(item => item.stage === "database_authority");
  const expected = operationFor(parsed.observedTargetState);
  const trustedState = observed.exclude(["broken"]).parse(observation.observedTargetState);
  const trustedObservationDigest = digest.parse(observation.observationDigest);
  if (preparationDigest !== sha256Digest(material) || parsed.nextOperation !== expected.nextOperation
    || parsed.precondition !== expected.precondition || parsed.installationPlanDigest !== plan.planDigest
    || parsed.releaseDigest !== plan.releaseDigest || !databaseStage || databaseStage.state !== "running"
    || parsed.observedTargetState !== trustedState || parsed.observationDigest !== trustedObservationDigest
    || parsed.stageInputDigest !== databaseStage.inputDigest
    || parsed.stageInputDigest !== postgresSetupStageInputDigestV1(parsed)) refuse();
  return freeze(material);
}

/** Exact input is replay-safe; any changed release, ledger, target, or plan invalidates the prior preparation. */
export function refreshPostgresSetupPreparationV1(currentValue: unknown, currentInstallationPlan: unknown,
  currentObservation: Readonly<{ observedTargetState: unknown; observationDigest: unknown }>, input: Readonly<{
  installationPlan: unknown; releaseDigest: unknown; ledgerDigest: unknown; targetIdentityDigest: unknown; observedTargetState: unknown; observationDigest: unknown;
}>) {
  const current = verifyPostgresSetupPreparationV1(currentValue, currentInstallationPlan, currentObservation), next = preparePostgresSetupV1(input);
  if (canonicalJson(current) === canonicalJson(next)) return Object.freeze({ kind: "replay" as const, preparation: current,
    performsEffect: false as const });
  return Object.freeze({ kind: "invalidated" as const, preparation: next, performsEffect: false as const });
}

/** Gives an owner wrapper an operation name, never a target, password, path, or connection string. */
export function postgresSetupNextOperationV1(value: unknown, installationPlan: unknown,
  observation: Readonly<{ observedTargetState: unknown; observationDigest: unknown }>) {
  const preparation = verifyPostgresSetupPreparationV1(value, installationPlan, observation);
  return Object.freeze({ stage: preparation.stage, operation: preparation.nextOperation,
    precondition: preparation.precondition, performsEffect: false as const, runsSql: false as const });
}
