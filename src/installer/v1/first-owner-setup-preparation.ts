import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationPlanV1 } from "./installation-plan";

/**
 * Digest-only preparation for the existing first-owner ceremony. This is not
 * another identity system: it binds the installation plan to the retained
 * owner-bootstrap implementation without accepting an assertion, code,
 * credential, subject, database target, or private path.
 */
export const FIRST_OWNER_SETUP_PREPARATION_V1 = "control-room.first-owner-setup-preparation/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const observed = z.enum(["empty", "existing", "uncertain"]);
const schema = z.object({
  schema: z.literal(FIRST_OWNER_SETUP_PREPARATION_V1),
  installationPlanDigest: digest,
  releaseDigest: digest,
  databaseAuthorityOutcomeDigest: digest,
  bootstrapConfigurationDigest: digest,
  trustConfigurationDigest: digest,
  expectedOwnerSubjectDigest: digest,
  observedOwnerState: z.literal("empty"),
  observationDigest: digest,
  stage: z.literal("first_owner"),
  stageInputDigest: digest,
  nextOperation: z.literal("arm_existing_owner_bootstrap_ceremony"),
  precondition: z.literal("empty_owner_target_and_owner_attendance"),
  preparationDigest: digest,
  createsOwner: z.literal(false),
  opensDatabase: z.literal(false),
  startsListener: z.literal(false),
  exposesIdentity: z.literal(false),
  acceptsAssertion: z.literal(false),
  acceptsOneTimeCode: z.literal(false),
}).strict();

export type FirstOwnerSetupPreparationV1 = Readonly<z.infer<typeof schema>>;
const refuse = (): never => { throw new Error("first_owner_setup_preparation_refused"); };

export function firstOwnerStageInputDigestV1(input: Readonly<{
  releaseDigest: unknown;
  databaseAuthorityOutcomeDigest: unknown;
  bootstrapConfigurationDigest: unknown;
  trustConfigurationDigest: unknown;
  expectedOwnerSubjectDigest: unknown;
}>): string {
  try {
    return sha256Digest({ purpose: "first-owner-setup-stage-input/v1",
      releaseDigest: digest.parse(input.releaseDigest),
      databaseAuthorityOutcomeDigest: digest.parse(input.databaseAuthorityOutcomeDigest),
      bootstrapConfigurationDigest: digest.parse(input.bootstrapConfigurationDigest),
      trustConfigurationDigest: digest.parse(input.trustConfigurationDigest),
      expectedOwnerSubjectDigest: digest.parse(input.expectedOwnerSubjectDigest) });
  } catch { return refuse(); }
}

type Input = Readonly<{
  installationPlan: unknown;
  releaseDigest: unknown;
  databaseAuthorityOutcomeDigest: unknown;
  bootstrapConfigurationDigest: unknown;
  trustConfigurationDigest: unknown;
  expectedOwnerSubjectDigest: unknown;
  observedOwnerState: unknown;
  observationDigest: unknown;
}>;

function build(input: Input): Omit<FirstOwnerSetupPreparationV1, "preparationDigest"> {
  const plan = verifyInstallationPlanV1(input.installationPlan);
  const releaseDigest = digest.parse(input.releaseDigest);
  const databaseAuthorityOutcomeDigest = digest.parse(input.databaseAuthorityOutcomeDigest);
  const bootstrapConfigurationDigest = digest.parse(input.bootstrapConfigurationDigest);
  const trustConfigurationDigest = digest.parse(input.trustConfigurationDigest);
  const expectedOwnerSubjectDigest = digest.parse(input.expectedOwnerSubjectDigest);
  const observedOwnerState = z.literal("empty").parse(observed.parse(input.observedOwnerState));
  const observationDigest = digest.parse(input.observationDigest);
  const active = plan.stages.find(item => item.stage === "first_owner");
  const database = plan.stages.find(item => item.stage === "database_authority");
  if (releaseDigest !== plan.releaseDigest) refuse();
  if (!active) throw new Error("first_owner_setup_preparation_refused");
  if (active.state !== "running") refuse();
  if (!database || database.state !== "passed" || database.outcomeDigest !== databaseAuthorityOutcomeDigest) refuse();
  const stageInputDigest = firstOwnerStageInputDigestV1({ releaseDigest, databaseAuthorityOutcomeDigest,
    bootstrapConfigurationDigest, trustConfigurationDigest, expectedOwnerSubjectDigest });
  if (active.inputDigest !== stageInputDigest) refuse();
  return { schema: FIRST_OWNER_SETUP_PREPARATION_V1, installationPlanDigest: plan.planDigest,
    releaseDigest, databaseAuthorityOutcomeDigest, bootstrapConfigurationDigest, trustConfigurationDigest,
    expectedOwnerSubjectDigest, observedOwnerState, observationDigest, stage: "first_owner", stageInputDigest,
    nextOperation: "arm_existing_owner_bootstrap_ceremony",
    precondition: "empty_owner_target_and_owner_attendance", createsOwner: false, opensDatabase: false,
    startsListener: false, exposesIdentity: false, acceptsAssertion: false, acceptsOneTimeCode: false };
}

function freeze(value: Omit<FirstOwnerSetupPreparationV1, "preparationDigest">): FirstOwnerSetupPreparationV1 {
  return Object.freeze({ ...value, preparationDigest: sha256Digest(value) });
}

/** Prepares the retained ceremony; only the later private owner operation may act. */
export function prepareFirstOwnerSetupV1(input: Input): FirstOwnerSetupPreparationV1 {
  try { return freeze(build(input)); } catch { return refuse(); }
}

/** Rebuilds from the exact private inputs and independently observed empty-owner state. */
export function verifyFirstOwnerSetupPreparationV1(value: unknown, input: Input,
  observation: Readonly<{ observedOwnerState: unknown; observationDigest: unknown }>): FirstOwnerSetupPreparationV1 {
  try {
    if (observed.parse(observation.observedOwnerState) !== "empty"
      || digest.parse(observation.observationDigest) !== digest.parse(input.observationDigest)) refuse();
    const parsed = schema.parse(value), expected = prepareFirstOwnerSetupV1({ ...input,
      observedOwnerState: observation.observedOwnerState, observationDigest: observation.observationDigest });
    if (canonicalJson(parsed) !== canonicalJson(expected)) refuse();
    return expected;
  } catch { return refuse(); }
}

/** Returns no assertion, code, identity, command, connection or effect capability. */
export function firstOwnerSetupNextOperationV1(value: unknown, input: Input,
  observation: Readonly<{ observedOwnerState: unknown; observationDigest: unknown }>) {
  const prepared = verifyFirstOwnerSetupPreparationV1(value, input, observation);
  return Object.freeze({ stage: prepared.stage, operation: prepared.nextOperation,
    precondition: prepared.precondition, performsEffect: false as const, createsOwner: false as const,
    opensDatabase: false as const, startsListener: false as const });
}
