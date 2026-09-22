import { isAbsolute, resolve } from "node:path";
import { planInstallationTopologyV1, verifyInstallationTopologyPlanV1 } from "../../harness/v1/installation-topology";
import { sha256Digest } from "../../security/canonical-digest";
import { InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import { createInstallationPlanV1, installationSetupStagesV1 } from "./installation-plan";

/** The reviewed labels are coordination inputs, not claims that a stage ran. */
export const LOCAL_INSTALLATION_PLAN_BOOTSTRAP_V1 = "control-room.local-installation-plan-bootstrap/v1" as const;
export const LOCAL_INSTALLATION_STAGE_INPUTS_V1 = "control-room.local-installation-stage-inputs/v1" as const;
export const CONTROLLER_ONLY_INSTALLATION_TOPOLOGY_V1 = "control-room.controller-only-installation-topology/v1" as const;

export const localInstallationStageLabelsV1 = Object.freeze({
  release_preflight: "verify the exact reviewed release",
  private_placement: "place the verified release in the owner-private installation",
  database_authority: "prepare the one reviewed PostgreSQL authority",
  protected_data: "prepare owner-private protected data custody",
  first_owner: "prepare the retained first-owner ceremony",
  recovery: "prove database and protected-data recovery",
  platform_service: "prepare the reviewed platform service lifecycle",
  agent_readiness: "record separately qualified agent readiness",
  final_review: "review the complete installation without activating it",
} satisfies Record<typeof installationSetupStagesV1[number], string>);

const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const refuse = (): never => { throw new Error("local_installation_plan_bootstrap_refused"); };

type Journal = Pick<InstallationPlanFilesystemJournalV1, "append">;
export type LocalInstallationPlanBootstrapRuntimeV1 = Readonly<{
  ownerUid(): number | undefined;
  createJournal?(configuration: Readonly<{ rootDirectory: string; installationId: string; ownerUid: number }>): Journal;
}>;

export type LocalInstallationPlanBootstrapResultV1 = Readonly<{
  schema: typeof LOCAL_INSTALLATION_PLAN_BOOTSTRAP_V1;
  installationId: string;
  revision: 0;
  planDigest: string;
  replayed: boolean;
  createsDatabase: false;
  writesCredentials: false;
  startsService: false;
  startsWorker: false;
  enablesAuthority: false;
  enablesWorkers: false;
  grantsExecutionAuthority: false;
}>;

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const names = Object.getOwnPropertyNames(value);
  if (names.some(name => Object.getOwnPropertyDescriptor(value, name)?.enumerable !== true)) return refuse();
  return value as Record<string, unknown>;
}

function capture(input: unknown) {
  const value = plainRecord(input);
  if (Object.keys(value).sort().join(",") !== "installationId,journalRoot,ownerAttended,releaseDigest,topologyPlan"
    || value.ownerAttended !== true
    || typeof value.journalRoot !== "string" || !isAbsolute(value.journalRoot)
    || resolve(value.journalRoot) !== value.journalRoot
    || typeof value.installationId !== "string" || !installationIdPattern.test(value.installationId)
    || typeof value.releaseDigest !== "string" || !digestPattern.test(value.releaseDigest)) return refuse();
  const topologyPlan = verifyInstallationTopologyPlanV1(value.topologyPlan);
  return Object.freeze({ journalRoot: value.journalRoot, installationId: value.installationId,
    releaseDigest: value.releaseDigest, topologyPlan });
}

/**
 * Stable stage inputs describe what must later be reviewed. They are not
 * evidence digests and cannot mark any stage complete.
 */
export function localInstallationStageInputDigestsV1(): Readonly<Record<typeof installationSetupStagesV1[number], string>> {
  return Object.freeze(Object.fromEntries(installationSetupStagesV1.map(stage => [stage, sha256Digest({
    contract: LOCAL_INSTALLATION_STAGE_INPUTS_V1, stage, reviewedLabel: localInstallationStageLabelsV1[stage],
  })])) as Record<typeof installationSetupStagesV1[number], string>);
}

/**
 * The truthful initial topology before an owner selects either authority or
 * any worker. These opaque markers mean "not selected"; they are not invented
 * database, scheduler, host, or worker identities.
 */
export function createControllerOnlyInstallationTopologyV1() {
  return planInstallationTopologyV1({
    databaseAuthorityDigest: sha256Digest({ contract: CONTROLLER_ONLY_INSTALLATION_TOPOLOGY_V1,
      component: "database_authority", state: "not_selected" }),
    schedulerAuthorityDigest: sha256Digest({ contract: CONTROLLER_ONLY_INSTALLATION_TOPOLOGY_V1,
      component: "scheduler_authority", state: "not_selected" }),
    currentRoutes: [], requestedRoutes: [],
  });
}

/**
 * Creates and appends only canonical revision zero. The supplied private root
 * must already exist; filesystem safety and exact replay are delegated to the
 * accepted installation-plan journal.
 */
export async function initializeLocalInstallationPlanV1(input: unknown,
  runtime: LocalInstallationPlanBootstrapRuntimeV1): Promise<LocalInstallationPlanBootstrapResultV1> {
  try {
    const captured = capture(input);
    const ownerUid = runtime?.ownerUid?.();
    if (!Number.isSafeInteger(ownerUid) || (ownerUid as number) < 0) return refuse();
    const plan = createInstallationPlanV1({ topologyPlan: captured.topologyPlan,
      releaseDigest: captured.releaseDigest, stageInputDigests: localInstallationStageInputDigestsV1() });
    const journal = runtime.createJournal?.({ rootDirectory: captured.journalRoot,
      installationId: captured.installationId, ownerUid: ownerUid as number })
      ?? new InstallationPlanFilesystemJournalV1({ rootDirectory: captured.journalRoot,
        installationId: captured.installationId, ownerUid: ownerUid as number });
    const appended = await journal.append(plan);
    if (appended.revision !== 0 || appended.installationId !== captured.installationId
      || appended.planDigest !== plan.planDigest) return refuse();
    return Object.freeze({ schema: LOCAL_INSTALLATION_PLAN_BOOTSTRAP_V1,
      installationId: appended.installationId, revision: 0, planDigest: appended.planDigest,
      replayed: appended.replayed, createsDatabase: false, writesCredentials: false,
      startsService: false, startsWorker: false, enablesAuthority: false, enablesWorkers: false,
      grantsExecutionAuthority: false });
  } catch (error) {
    if (error instanceof Error && error.message === "installation_plan_journal_conflict")
      throw new Error("local_installation_plan_bootstrap_conflict");
    return refuse();
  }
}
