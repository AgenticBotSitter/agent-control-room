import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationTopologyPlanV1 } from "../../harness/v1/installation-topology";
import { advanceInstallationPlanV1, refreshInstallationPlanV1,
  type InstallationPlanV1 } from "./installation-plan";
import { type InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";

/**
 * Durable, source-only bridge between the already verified release reports and
 * the first owner-action stage.  It owns no release checker, stager, native
 * command, or receipt store: the installation-plan journal is the sole
 * append-only record of its four transitions.
 */
export const LOCAL_INSTALLATION_PREREQUISITE_TRANSACTION_V1 =
  "control-room.local-installation-prerequisite-transaction/v1" as const;

type Journal = Pick<InstallationPlanFilesystemJournalV1, "append" | "readHistory">;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const installationId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
const releasePreflight = z.object({
  schema: z.literal("control-room.local-installation-package-preparation/v1"),
  mode: z.literal("dry-run"),
  bundle: z.object({ state: z.enum(["fingerprinted", "matched_expected_digest"]), version, fileCount: z.number().int().positive(),
    byteCount: z.number().int().positive(), digest, authenticityVerified: z.literal(false) }).strict(),
  service: z.object({ state: z.enum(["awaiting_owner_setup", "validated_not_installed"]) }).strict(),
  releaseManifestDigest: digest,
  readyForOwnerSetup: z.literal(true),
  startsService: z.literal(false),
  createsDatabase: z.literal(false),
  writesCredentials: z.literal(false),
  nextSteps: z.array(z.string().min(1)).min(1),
}).strict();

const privatePlacement = z.object({
  schema: z.literal("control-room.local-release-staging/v1"),
  state: z.literal("verified_release_staged"),
  version,
  releaseManifestDigest: digest,
  alreadyStaged: z.boolean(),
  fileCount: z.number().int().positive(),
  byteCount: z.number().int().positive(),
  remainingCategory: z.literal("production_dependencies_not_prepared"),
  preparesDependencies: z.literal(false),
  switchesCurrentRelease: z.literal(false),
  installsOrStartsService: z.literal(false),
  createsDatabase: z.literal(false),
  writesCredentials: z.literal(false),
  usesNetwork: z.literal(false),
  publishes: z.literal(false),
}).strict();

export type LocalInstallationPrerequisiteTerminalReceiptV1 = Readonly<{
  schema: typeof LOCAL_INSTALLATION_PREREQUISITE_TRANSACTION_V1;
  installationId: string;
  stage: "release_preflight" | "private_placement";
  stageInputDigest: string;
  evidenceDigest: string;
  receiptDigest: string;
  performsEffect: false;
  startsService: false;
  createsDatabase: false;
  startsWorker: false;
}>;

export type LocalInstallationPrerequisiteTransactionResultV1 = Readonly<{
  schema: typeof LOCAL_INSTALLATION_PREREQUISITE_TRANSACTION_V1;
  installationPlan: InstallationPlanV1;
  releasePreflight: LocalInstallationPrerequisiteTerminalReceiptV1;
  privatePlacement: LocalInstallationPrerequisiteTerminalReceiptV1;
  replayed: boolean;
  createsReceiptStore: false;
  performsEffect: false;
  startsService: false;
  createsDatabase: false;
  startsWorker: false;
}>;

type Captured = Readonly<{
  installationId: string;
  topologyPlan: ReturnType<typeof verifyInstallationTopologyPlanV1>;
  releaseDigest: string;
  releasePreflightEvidenceDigest: string;
  privatePlacementEvidenceDigest: string;
  releasePreflightStageInputDigest: string;
  privatePlacementStageInputDigest: string;
}>;

const refuse = (): never => { throw new Error("local_installation_prerequisite_transaction_refused"); };

function receiptFor(input: Captured, selectedStage: "release_preflight" | "private_placement",
  stageInputDigest: string, evidenceDigest: string): LocalInstallationPrerequisiteTerminalReceiptV1 {
  const body = { schema: LOCAL_INSTALLATION_PREREQUISITE_TRANSACTION_V1, installationId: input.installationId,
    stage: selectedStage, stageInputDigest, evidenceDigest, performsEffect: false as const, startsService: false as const,
    createsDatabase: false as const, startsWorker: false as const };
  return Object.freeze({ ...body, receiptDigest: sha256Digest({ purpose: "local-installation-prerequisite-receipt/v1", receipt: body }) });
}

function capture(value: unknown): Captured {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "installationId,privatePlacement,releaseDigest,releasePreflight,topologyPlan") return refuse();
  const parsedInstallationId = installationId.parse(input.installationId);
  const topologyPlan = verifyInstallationTopologyPlanV1(input.topologyPlan);
  const releaseDigest = digest.parse(input.releaseDigest);
  const preflight = releasePreflight.parse(input.releasePreflight);
  const placement = privatePlacement.parse(input.privatePlacement);
  if (preflight.releaseManifestDigest !== releaseDigest || placement.releaseManifestDigest !== releaseDigest
    || placement.version !== preflight.bundle.version) return refuse();
  const preflightEvidenceDigest = sha256Digest({ purpose: "local-installation-release-preflight-report-evidence/v1",
    releaseDigest, report: preflight });
  const placementEvidenceDigest = sha256Digest({ purpose: "local-installation-private-placement-report-evidence/v1",
    installationId: parsedInstallationId, releaseDigest, report: placement });
  const releasePreflightStageInputDigest = sha256Digest({ purpose: "local-installation-release-preflight-stage-input/v1",
    topologyPlanDigest: topologyPlan.planDigest, releaseDigest, preflightEvidenceDigest,
    preflight: { version: preflight.bundle.version, fileCount: preflight.bundle.fileCount, byteCount: preflight.bundle.byteCount,
      state: preflight.bundle.state, serviceState: preflight.service.state } });
  const privatePlacementStageInputDigest = sha256Digest({ purpose: "local-installation-private-placement-stage-input/v1",
    topologyPlanDigest: topologyPlan.planDigest, releaseDigest, releasePreflightStageInputDigest,
    privatePlacementEvidenceDigest: placementEvidenceDigest,
    placement: { version: placement.version, fileCount: placement.fileCount, byteCount: placement.byteCount,
      state: placement.state, alreadyStaged: placement.alreadyStaged } });
  return Object.freeze({ installationId: parsedInstallationId, topologyPlan, releaseDigest,
    releasePreflightEvidenceDigest: preflightEvidenceDigest, privatePlacementEvidenceDigest: placementEvidenceDigest,
    releasePreflightStageInputDigest, privatePlacementStageInputDigest });
}

function current(history: readonly InstallationPlanV1[]): InstallationPlanV1 {
  const plan = history.at(-1);
  if (!plan) return refuse();
  return plan;
}

function planStage(plan: InstallationPlanV1, selected: "release_preflight" | "private_placement" | "database_authority") {
  const item = plan.stages.find(value => value.stage === selected);
  if (!item) return refuse();
  return item;
}

function assertCapturedCurrent(plan: InstallationPlanV1, captured: Captured, allowBootstrapInputs: boolean): InstallationPlanV1 {
  if (plan.topologyPlanDigest !== captured.topologyPlan.planDigest || plan.releaseDigest !== captured.releaseDigest) return refuse();
  const preflight = planStage(plan, "release_preflight"), placement = planStage(plan, "private_placement");
  if (preflight.inputDigest === captured.releasePreflightStageInputDigest
    && placement.inputDigest === captured.privatePlacementStageInputDigest) return plan;
  // Revision zero is the one canonical bootstrap record, whose reviewed
  // placeholder inputs are deliberately replaced by this transaction.  An
  // interleaved revision is never treated as that bootstrap exception.
  if (allowBootstrapInputs && plan.revision === 0 && preflight.state === "not_started" && placement.state === "not_started") return plan;
  return refuse();
}

async function appendAndReadCurrent(journal: Journal, input: Captured, plan: InstallationPlanV1,
  allowBootstrapInputs = false): Promise<InstallationPlanV1> {
  let result;
  try { result = await journal.append(plan); }
  catch { return refuse(); }
  if (result.installationId !== input.installationId || result.revision !== plan.revision || result.planDigest !== plan.planDigest) return refuse();
  const settled = current(await reread(journal));
  // A replay of an old revision says nothing about the current plan.  Every
  // transition therefore binds and returns the reread tip to the state machine.
  return assertCapturedCurrent(settled, input, allowBootstrapInputs);
}

function receipts(input: Captured, plan: InstallationPlanV1) {
  const preflight = planStage(plan, "release_preflight"), placement = planStage(plan, "private_placement");
  return Object.freeze({ releasePreflight: receiptFor(input, "release_preflight", preflight.inputDigest,
    input.releasePreflightEvidenceDigest), privatePlacement: receiptFor(input, "private_placement", placement.inputDigest,
    input.privatePlacementEvidenceDigest) });
}

function completed(plan: InstallationPlanV1, expected: ReturnType<typeof receipts>) {
  const preflight = planStage(plan, "release_preflight"), placement = planStage(plan, "private_placement");
  return preflight.state === "passed" && placement.state === "passed"
    && preflight.outcomeDigest === expected.releasePreflight.receiptDigest
    && placement.outcomeDigest === expected.privatePlacement.receiptDigest
    // Do not let an append/replay of the historical placement revision stand
    // in for the current plan: this transaction succeeds only at its own tip.
    && placement.recordedRevision === plan.revision;
}

function coherentInProgress(plan: InstallationPlanV1, expected: ReturnType<typeof receipts>) {
  const preflight = planStage(plan, "release_preflight"), placement = planStage(plan, "private_placement");
  if (preflight.state === "passed" && preflight.outcomeDigest !== expected.releasePreflight.receiptDigest) return false;
  if (placement.state === "passed" && placement.outcomeDigest !== expected.privatePlacement.receiptDigest) return false;
  if (preflight.state === "running" && preflight.inputDigest !== expected.releasePreflight.stageInputDigest) return false;
  if (placement.state === "running" && placement.inputDigest !== expected.privatePlacement.stageInputDigest) return false;
  return ![preflight, placement].some(item => item.state === "failed" || item.state === "uncertain");
}

async function reread(journal: Journal): Promise<readonly InstallationPlanV1[]> {
  try { return await journal.readHistory(); }
  catch { return refuse(); }
}

function samePlan(left: InstallationPlanV1, right: InstallationPlanV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function advancePass(journal: Journal, input: Captured, plan: InstallationPlanV1,
  selected: "release_preflight" | "private_placement", receipt: LocalInstallationPrerequisiteTerminalReceiptV1): Promise<InstallationPlanV1> {
  const item = planStage(plan, selected);
  if (item.state === "passed" && item.outcomeDigest === receipt.receiptDigest) return plan;
  let persisted: InstallationPlanV1;
  if (item.state === "running") {
    if (item.inputDigest !== receipt.stageInputDigest) return refuse();
    persisted = plan;
  } else {
    if (item.state !== "not_started") return refuse();
    const running = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "start" });
    persisted = await appendAndReadCurrent(journal, input, running);
  }
  const runningStage = planStage(persisted, selected);
  if (runningStage.state === "passed" && runningStage.outcomeDigest === receipt.receiptDigest) return persisted;
  if (runningStage.state !== "running" || runningStage.inputDigest !== item.inputDigest) return refuse();
  const passed = advanceInstallationPlanV1(persisted, { expectedRevision: persisted.revision, stage: selected,
    action: "pass", outcomeDigest: receipt.receiptDigest });
  return appendAndReadCurrent(journal, input, passed);
}

/**
 * Records the release-preflight then private-placement terminal evidence in
 * order.  All supplied evidence is already verified by its respective
 * release-preflight/stager contract; this function merely binds it to the
 * current installation plan.  A non-exact, running, uncertain, failed or
 * concurrently changed journal is refused rather than repaired or retried.
 */
export async function completeLocalInstallationPrerequisitesV1(input: unknown,
  runtime: Readonly<{ journal: Journal }>): Promise<LocalInstallationPrerequisiteTransactionResultV1> {
  try {
    const captured = capture(input);
    if (!runtime?.journal || typeof runtime.journal.append !== "function" || typeof runtime.journal.readHistory !== "function") return refuse();
    let history = await reread(runtime.journal), plan = current(history);
    assertCapturedCurrent(plan, captured, true);
    plan = await appendAndReadCurrent(runtime.journal, captured, plan, true);
    const desiredInputs = Object.fromEntries(plan.stages.map(item => [item.stage,
      item.stage === "release_preflight" ? captured.releasePreflightStageInputDigest
        : item.stage === "private_placement" ? captured.privatePlacementStageInputDigest : item.inputDigest]));
    const refreshed = refreshInstallationPlanV1(plan, { topologyPlan: captured.topologyPlan, releaseDigest: captured.releaseDigest,
      stageInputDigests: desiredInputs });
    if (!samePlan(refreshed, plan)) {
      const prerequisiteStates = [planStage(plan, "release_preflight"), planStage(plan, "private_placement")];
      if (prerequisiteStates.some(item => item.state !== "not_started")) return refuse();
      plan = await appendAndReadCurrent(runtime.journal, captured, refreshed);
    }
    let expected = receipts(captured, plan);
    if (completed(plan, expected) && planStage(plan, "database_authority").state === "not_started") return Object.freeze({ schema: LOCAL_INSTALLATION_PREREQUISITE_TRANSACTION_V1, installationPlan: plan,
      ...expected, replayed: true, createsReceiptStore: false, performsEffect: false, startsService: false,
      createsDatabase: false, startsWorker: false });
    if (!coherentInProgress(plan, expected)) return refuse();
    plan = await advancePass(runtime.journal, captured, plan, "release_preflight", expected.releasePreflight);
    expected = receipts(captured, plan);
    plan = await advancePass(runtime.journal, captured, plan, "private_placement", expected.privatePlacement);
    expected = receipts(captured, plan);
    if (!completed(plan, expected) || planStage(plan, "database_authority").state !== "not_started") return refuse();
    return Object.freeze({ schema: LOCAL_INSTALLATION_PREREQUISITE_TRANSACTION_V1, installationPlan: plan,
      ...expected, replayed: false, createsReceiptStore: false, performsEffect: false, startsService: false,
      createsDatabase: false, startsWorker: false });
  } catch { return refuse(); }
}
