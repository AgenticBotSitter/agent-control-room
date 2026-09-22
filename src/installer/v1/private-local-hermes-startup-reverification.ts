import { sha256Digest } from "../../security/canonical-digest";
import { verifyPrivateHermes021LocalCurrentStartupBindingV1,
  type PrivateHermes021LocalStartupAdmissionBindingV1 } from
  "../../web/v1/hermes-021-private-installation-composition";
import { verifyInstallationPlanV1, type InstallationPlanV1 } from "./installation-plan";
import type { InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import { localHermesAdmissionTerminalReceiptForRequestV1 } from "./local-hermes-admission-transaction";
import { preparePrivateLocalHermesAdmissionRequestV1 } from "./private-local-hermes-admission-runner";
import { privateInstallationFinalReviewBindingsV1 } from "./private-installation-final-review";

export const PRIVATE_LOCAL_HERMES_STARTUP_REVERIFICATION_V1 =
  "control-room.private-local-hermes-startup-reverification/v1" as const;

type SettledJournal = Pick<InstallationPlanFilesystemJournalV1, "inspectSettledHistory">;

export type PrivateLocalHermesStartupReverificationV1 = Readonly<{
  schema: typeof PRIVATE_LOCAL_HERMES_STARTUP_REVERIFICATION_V1;
  installationId: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  agentReadinessReceiptDigest: string;
  finalReviewOutcomeDigest: string;
  startupAdmissionBinding: PrivateHermes021LocalStartupAdmissionBindingV1;
  receiptDigest: string;
  invokesHermes: false;
  opensDatabase: false;
  startsService: false;
  startsWorker: false;
  startsWork: false;
  grantsExecutionAuthority: false;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const refuse = (): never => {
  const error = new Error("private_local_hermes_startup_reverification_refused");
  error.stack = undefined;
  throw error;
};

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))
    || names.some(name => !Object.prototype.hasOwnProperty.call(value, name))
    || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
    })) return refuse();
  return value as Readonly<Record<string, unknown>>;
}

function stage(plan: InstallationPlanV1, name: InstallationPlanV1["stages"][number]["stage"]) {
  const found = plan.stages.find(item => item.stage === name);
  if (!found) return refuse();
  return found;
}

function captureJournal(value: unknown): SettledJournal {
  if (!value || typeof value !== "object"
    || typeof (value as SettledJournal).inspectSettledHistory !== "function") return refuse();
  const journal = value as SettledJournal;
  return Object.freeze({ inspectSettledHistory: journal.inspectSettledHistory.bind(value) });
}

function finalReviewOutcome(installationId: string, running: InstallationPlanV1) {
  const binding = privateInstallationFinalReviewBindingsV1(running);
  const body = { schema: "control-room.private-installation-final-review-terminal/v1" as const,
    installationId, installationPlanDigest: running.planDigest,
    installationPlanRevision: running.revision, topologyPlanDigest: running.topologyPlanDigest,
    releaseDigest: running.releaseDigest, finalReviewInputDigest: binding.finalReviewInputDigest,
    priorStageEvidenceDigest: binding.priorStageEvidenceDigest, invokesAgent: false as const,
    enablesAuthority: false as const, startsService: false as const, startsWorker: false as const };
  return Object.freeze({ inputDigest: binding.finalReviewInputDigest,
    outcomeDigest: sha256Digest({ purpose: "private-installation-final-review-terminal/v1", confirmation: body }) });
}

function material(value: Omit<PrivateLocalHermesStartupReverificationV1, "receiptDigest">) {
  return { ...value, startupAdmissionBinding: { ...value.startupAdmissionBinding } };
}

/**
 * Re-verifies the completely settled private installation against the exact
 * current Hermes composition. It reads only a settled journal snapshot and
 * cannot invoke an agent, open PostgreSQL, start a service/worker or create a
 * second activation store.
 */
export async function reverifyPrivateLocalHermesStartupV1(inputValue: unknown,
  runtimeValue: unknown): Promise<PrivateLocalHermesStartupReverificationV1> {
  try {
    const input = exact(inputValue, ["runnerInput"]), runnerInput = exact(input.runnerInput,
      ["admissionPreparationInput", "privateStartupConfiguration", "startupAdmissionBinding"]);
    const admission = exact(runnerInput.admissionPreparationInput,
      ["installationId", "installationPlan", "topologyInput", "workerBinding", "installationBinding",
        "installationBindingInput"]);
    if (typeof admission.installationId !== "string" || !installationIdPattern.test(admission.installationId)) return refuse();
    const runtime = exact(runtimeValue, ["journal"]), journal = captureJournal(runtime.journal);
    const history = await journal.inspectSettledHistory();
    const current = history.at(-1);
    if (!current || history.length !== current.revision + 1 || current.stages.some(item => item.state !== "passed")) return refuse();
    const historical = verifyInstallationPlanV1(admission.installationPlan);
    if (history[historical.revision]?.planDigest !== historical.planDigest
      || stage(historical, "agent_readiness").state !== "running"
      || stage(historical, "final_review").state !== "not_started") return refuse();

    // This replay-only facade lets the existing admission request builder
    // authenticate the historical plan without writing the real journal.
    const historicalHistory = Object.freeze(history.slice(0, historical.revision + 1));
    const request = await preparePrivateLocalHermesAdmissionRequestV1(runnerInput, Object.freeze({
      async readHistory() { return historicalHistory; },
      async append(value: unknown) {
        const plan = verifyInstallationPlanV1(value);
        if (plan.revision !== historical.revision || plan.planDigest !== historical.planDigest) return refuse();
        return Object.freeze({ schema: "control-room.installation-plan-journal/v1" as const,
          installationId: admission.installationId as string, revision: plan.revision,
          planDigest: plan.planDigest, replayed: true, enablesAuthority: false as const,
          startsService: false as const, startsWorker: false as const });
      },
    }));
    const readiness = localHermesAdmissionTerminalReceiptForRequestV1(request);
    const readinessStage = stage(current, "agent_readiness");
    if (readinessStage.outcomeDigest !== readiness.receiptDigest) return refuse();

    const finalStage = stage(current, "final_review");
    if (finalStage.recordedRevision !== current.revision || current.revision < 1) return refuse();
    const finalRunning = history[current.revision - 1];
    if (!finalRunning || stage(finalRunning, "final_review").state !== "running") return refuse();
    const expectedFinal = finalReviewOutcome(admission.installationId, finalRunning);
    if (finalStage.inputDigest !== expectedFinal.inputDigest
      || finalStage.outcomeDigest !== expectedFinal.outcomeDigest) return refuse();

    const binding = verifyPrivateHermes021LocalCurrentStartupBindingV1(runnerInput.startupAdmissionBinding, {
      delivery: (runnerInput.privateStartupConfiguration as { coordinator?: { hermes021Local?: unknown } }).coordinator?.hermes021Local,
      queueWorker: (runnerInput.privateStartupConfiguration as { coordinator?: { queueWorker?: unknown } }).coordinator?.queueWorker,
      topologyPlanDigest: current.topologyPlanDigest, releaseDigest: current.releaseDigest,
    });
    if (binding.admissionRequestDigest !== request.admissionRequestDigest
      || binding.bindingDigest !== request.privateStartupBindingDigest
      || current.topologyPlanDigest !== request.topologyPlanDigest || current.releaseDigest !== request.releaseDigest) return refuse();

    const body = Object.freeze({ schema: PRIVATE_LOCAL_HERMES_STARTUP_REVERIFICATION_V1,
      installationId: admission.installationId, installationPlanDigest: current.planDigest,
      installationPlanRevision: current.revision, topologyPlanDigest: current.topologyPlanDigest,
      releaseDigest: current.releaseDigest, agentReadinessReceiptDigest: readiness.receiptDigest,
      finalReviewOutcomeDigest: expectedFinal.outcomeDigest, startupAdmissionBinding: binding,
      invokesHermes: false as const, opensDatabase: false as const, startsService: false as const,
      startsWorker: false as const, startsWork: false as const, grantsExecutionAuthority: false as const });
    return Object.freeze({ ...body,
      receiptDigest: sha256Digest({ purpose: "private-local-hermes-startup-reverification/v1", receipt: material(body) }) });
  } catch { return refuse(); }
}

/** Final synchronous gate used by protected operator assembly and task startup. */
export function verifyPrivateLocalHermesStartupReverificationV1(value: unknown, inputValue: unknown):
PrivateLocalHermesStartupReverificationV1 {
  try {
    const receipt = exact(value, ["schema", "installationId", "installationPlanDigest", "installationPlanRevision",
      "topologyPlanDigest", "releaseDigest", "agentReadinessReceiptDigest", "finalReviewOutcomeDigest",
      "startupAdmissionBinding", "receiptDigest", "invokesHermes", "opensDatabase", "startsService", "startsWorker",
      "startsWork", "grantsExecutionAuthority"]);
    if (receipt.schema !== PRIVATE_LOCAL_HERMES_STARTUP_REVERIFICATION_V1
      || typeof receipt.installationId !== "string" || !installationIdPattern.test(receipt.installationId)
      || !Number.isSafeInteger(receipt.installationPlanRevision)
      || [receipt.installationPlanDigest, receipt.topologyPlanDigest, receipt.releaseDigest,
        receipt.agentReadinessReceiptDigest, receipt.finalReviewOutcomeDigest, receipt.receiptDigest]
        .some(item => typeof item !== "string" || !digestPattern.test(item))
      || receipt.invokesHermes !== false || receipt.opensDatabase !== false || receipt.startsService !== false
      || receipt.startsWorker !== false || receipt.startsWork !== false || receipt.grantsExecutionAuthority !== false) return refuse();
    const input = exact(inputValue, ["delivery", "installationPlan", "queueWorker"]);
    const plan = verifyInstallationPlanV1(input.installationPlan);
    if (plan.planDigest !== receipt.installationPlanDigest || plan.revision !== receipt.installationPlanRevision
      || plan.topologyPlanDigest !== receipt.topologyPlanDigest || plan.releaseDigest !== receipt.releaseDigest
      || plan.stages.some(item => item.state !== "passed")
      || stage(plan, "agent_readiness").outcomeDigest !== receipt.agentReadinessReceiptDigest
      || stage(plan, "final_review").outcomeDigest !== receipt.finalReviewOutcomeDigest) return refuse();
    const binding = verifyPrivateHermes021LocalCurrentStartupBindingV1(receipt.startupAdmissionBinding, {
      delivery: input.delivery, queueWorker: input.queueWorker,
      topologyPlanDigest: plan.topologyPlanDigest, releaseDigest: plan.releaseDigest,
    });
    const parsed = Object.freeze({ ...receipt, startupAdmissionBinding: binding }) as
      PrivateLocalHermesStartupReverificationV1;
    const { receiptDigest: _digest, ...body } = parsed; void _digest;
    if (parsed.receiptDigest !== sha256Digest({ purpose: "private-local-hermes-startup-reverification/v1",
      receipt: material(body) })) return refuse();
    return parsed;
  } catch { return refuse(); }
}
