import { z } from "zod";
import { DURABLE_RESULT_RESERVATION_SCHEMA_V1 } from "../../artifacts/v1/durable-result-publication";
import { durableResultReviewPlanSchemaV1 } from "../../completion-gate/v1/durable-result-review-plan";
import { HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1,
  HERMES_021_SOURCE_REVISION_V1 } from "../../harness/hermes-021-v1/connector-profile";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, hermes021MacosLocalBindingSchemaV1 } from "../../harness/hermes-021-v1/macos-local-worker";
import { CANONICAL_TEXT_RESULT_SCHEMA_V1 } from "../../harness/v1/canonical-text-result";
import { CONTROLLER_WORKER_DELIVERY_V1 } from "../../harness/v1/controller-worker-delivery";
import { installationTopologyInputSchemaV1, planInstallationTopologyV1 } from "../../harness/v1/installation-topology";
import { sha256Digest } from "../../security/canonical-digest";
import { taskRevisionReceiptSchema } from "../../web/v1/task-revision-wire";
import { verifyInstallationPlanV1, type InstallationPlanV1 } from "./installation-plan";
import { type InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import { verifyLocalHermesInstallationBindingV1,
  type LocalHermesInstallationBindingInputV1 } from "./local-hermes-installation-binding";

/**
 * A redacted bridge from installation evidence to a later owner-controlled
 * admission ceremony. It is deliberately not the ceremony, an admission
 * record, or a startup capability.
 */
export const LOCAL_HERMES_ADMISSION_PREPARATION_V1 =
  "control-room.local-hermes-admission-preparation/v1" as const;

const installationId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u);
type Journal = Pick<InstallationPlanFilesystemJournalV1, "append" | "readHistory">;

export const localHermesAdmissionBlockerCodesV1 = Object.freeze([
  "database_authority_not_settled",
  "protected_data_not_settled",
  "first_owner_not_settled",
  "recovery_not_settled",
  "platform_service_not_settled",
  "agent_readiness_not_started",
  "agent_readiness_requires_owner_attention",
  "installation_binding_not_verified",
  "private_startup_composition_not_supplied",
  "owner_admission_not_recorded",
  "agent_readiness_not_settled",
  "final_review_not_settled",
] as const);
export type LocalHermesAdmissionBlockerCodeV1 = typeof localHermesAdmissionBlockerCodesV1[number];

export type LocalHermesAdmissionPreparationInputV1 = Readonly<{
  installationId: string;
  installationPlan: unknown;
  /** Complete protected route input. A digest-only topology plan cannot prove
   * which adapter revision owns the local route. */
  topologyInput: unknown;
  workerBinding: unknown;
  /** Both values are required together. The saved preparation is never
   * accepted without rechecking the current private observations. */
  installationBinding?: unknown;
  installationBindingInput?: LocalHermesInstallationBindingInputV1;
}>;

export type LocalHermesAdmissionPreparationV1 = Readonly<{
  schema: typeof LOCAL_HERMES_ADMISSION_PREPARATION_V1;
  installationId: string;
  state: "blocked" | "awaiting_owner_admission_review";
  topologyPlanDigest: string;
  releaseDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  workerBindingDigest: string;
  installationBindingDigest?: string;
  lifecycleContractDigest: string;
  admissionRequestDigest?: string;
  taskClass: "text_review";
  blockers: readonly LocalHermesAdmissionBlockerCodeV1[];
  nextOperation: "finish_installation_prerequisite" | "verify_installation_binding" |
    "supply_private_startup_and_owner_admission";
  invokesRunner: false;
  startsWork: false;
  startsService: false;
  enablesWorker: false;
  grantsExecutionAuthority: false;
  createsQueue: false;
  createsStore: false;
  capacityAuthorizesAdmission: false;
}>;

const refuse = (): never => { throw new Error("local_hermes_admission_preparation_refused"); };

const lifecycle = Object.freeze({
  taskClass: "text_review" as const,
  adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
  adapterRevision: HERMES_021_SOURCE_REVISION_V1,
  connectorProfileDigest: HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1,
  deliveryContract: CONTROLLER_WORKER_DELIVERY_V1,
  canonicalResultContract: CANONICAL_TEXT_RESULT_SCHEMA_V1,
  resultReservationContract: DURABLE_RESULT_RESERVATION_SCHEMA_V1,
  reviewContract: durableResultReviewPlanSchemaV1.shape.schema.value,
  correctionExecutionAvailability: taskRevisionReceiptSchema.shape.executionAvailability.value,
});

const stageBlockers = Object.freeze({
  database_authority: "database_authority_not_settled",
  protected_data: "protected_data_not_settled",
  first_owner: "first_owner_not_settled",
  recovery: "recovery_not_settled",
  platform_service: "platform_service_not_settled",
} as const);

function stage(plan: InstallationPlanV1, name: InstallationPlanV1["stages"][number]["stage"]) {
  const found = plan.stages.find(item => item.stage === name);
  if (!found) return refuse();
  return found;
}

function captureJournal(value: unknown): Journal {
  if (!value || typeof value !== "object") return refuse();
  const journal = value as Journal;
  if (typeof journal.append !== "function" || typeof journal.readHistory !== "function") return refuse();
  return Object.freeze({ append: journal.append.bind(value), readHistory: journal.readHistory.bind(value) });
}

/**
 * Produces an exact, inert owner-review request only after the existing local
 * Hermes installation binding re-verifies against current private inputs.
 * Before that point it returns one actionable, redacted blocker category from
 * the canonical setup plan. Even the ready-for-review result remains blocked
 * on a separately reviewed private startup composition and owner admission
 * record; capacity telemetry can never satisfy either condition.
 */
export async function prepareLocalHermesAdmissionV1(input: LocalHermesAdmissionPreparationInputV1,
  runtime: Readonly<{ journal: Journal }>): Promise<LocalHermesAdmissionPreparationV1> {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) return refuse();
    const allowed = ["installationId", "installationPlan", "topologyInput", "workerBinding",
      "installationBinding", "installationBindingInput"];
    if (Object.keys(input).some(key => !allowed.includes(key))) return refuse();
    const id = installationId.parse(input.installationId);
    const plan = verifyInstallationPlanV1(input.installationPlan);
    const journal = captureJournal(runtime?.journal);
    const history = await journal.readHistory(), current = history.at(-1);
    if (!current || current.revision !== plan.revision || current.planDigest !== plan.planDigest) return refuse();
    const journalIdentity = await journal.append(plan);
    if (!journalIdentity.replayed || journalIdentity.installationId !== id || journalIdentity.revision !== plan.revision
      || journalIdentity.planDigest !== plan.planDigest) return refuse();
    const confirmedHistory = await journal.readHistory(), confirmedCurrent = confirmedHistory.at(-1);
    if (!confirmedCurrent || confirmedCurrent.revision !== plan.revision
      || confirmedCurrent.planDigest !== plan.planDigest) return refuse();
    const topologyInput = installationTopologyInputSchemaV1.parse(input.topologyInput);
    const topology = planInstallationTopologyV1(topologyInput);
    const binding = hermes021MacosLocalBindingSchemaV1.parse(input.workerBinding);
    if (plan.topologyPlanDigest !== topology.planDigest || binding.sourceRevision !== HERMES_021_SOURCE_REVISION_V1) return refuse();
    const route = topologyInput.requestedRoutes.find(item => item.kind === "local" && item.workerId === binding.workerId);
    if (!route || route.adapterId !== HERMES_021_MACOS_LOCAL_ADAPTER_V1
      || route.adapterRevision !== binding.sourceRevision) return refuse();

    const common = { schema: LOCAL_HERMES_ADMISSION_PREPARATION_V1, installationId: id,
      topologyPlanDigest: topology.planDigest, releaseDigest: plan.releaseDigest,
      installationPlanDigest: plan.planDigest, installationPlanRevision: plan.revision,
      workerBindingDigest: sha256Digest(binding), lifecycleContractDigest: sha256Digest(lifecycle),
      taskClass: "text_review" as const, invokesRunner: false as const, startsWork: false as const,
      startsService: false as const, enablesWorker: false as const, grantsExecutionAuthority: false as const,
      createsQueue: false as const, createsStore: false as const, capacityAuthorizesAdmission: false as const };

    for (const name of ["database_authority", "protected_data", "first_owner", "recovery", "platform_service"] as const) {
      if (stage(plan, name).state !== "passed") return Object.freeze({ ...common, state: "blocked" as const,
        blockers: Object.freeze([stageBlockers[name]]), nextOperation: "finish_installation_prerequisite" as const });
    }
    const readiness = stage(plan, "agent_readiness");
    if (readiness.state === "not_started") return Object.freeze({ ...common, state: "blocked" as const,
      blockers: Object.freeze(["agent_readiness_not_started" as const]),
      nextOperation: "finish_installation_prerequisite" as const });
    if (readiness.state !== "running") return Object.freeze({ ...common, state: "blocked" as const,
      blockers: Object.freeze(["agent_readiness_requires_owner_attention" as const]),
      nextOperation: "finish_installation_prerequisite" as const });

    if ((input.installationBinding === undefined) !== (input.installationBindingInput === undefined)) return refuse();
    if (input.installationBinding === undefined || input.installationBindingInput === undefined) {
      return Object.freeze({ ...common, state: "blocked" as const,
        blockers: Object.freeze(["installation_binding_not_verified" as const]),
        nextOperation: "verify_installation_binding" as const });
    }
    const verified = verifyLocalHermesInstallationBindingV1(input.installationBinding,
      input.installationBindingInput);
    if (verified.installationPlanDigest !== plan.planDigest
      || verified.topologyPlanDigest !== topology.planDigest
      || verified.workerBindingDigest !== common.workerBindingDigest) return refuse();
    const installationBindingDigest = verified.preparationDigest;
    const admissionMaterial = { purpose: "local-hermes-owner-admission-request/v1", installationId: id,
      installationPlanDigest: plan.planDigest, installationPlanRevision: plan.revision,
      installationBindingDigest, lifecycleContractDigest: common.lifecycleContractDigest };
    return Object.freeze({ ...common, state: "awaiting_owner_admission_review" as const,
      installationBindingDigest, admissionRequestDigest: sha256Digest(admissionMaterial),
      blockers: Object.freeze(["private_startup_composition_not_supplied" as const,
        "owner_admission_not_recorded" as const, "agent_readiness_not_settled" as const,
        "final_review_not_settled" as const]),
      nextOperation: "supply_private_startup_and_owner_admission" as const });
  } catch { return refuse(); }
}
