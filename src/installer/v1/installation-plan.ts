import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationTopologyPlanV1 } from "../../harness/v1/installation-topology";

/** Pure, digest-only installation coordination. It cannot perform a setup effect. */
export const INSTALLATION_PLAN_V1 = "control-room.installation-plan/v1" as const;

export const installationSetupStagesV1 = Object.freeze([
  "release_preflight", "private_placement", "database_authority", "protected_data", "first_owner",
  "recovery", "platform_service", "agent_readiness", "final_review",
] as const);
type Stage = typeof installationSetupStagesV1[number];

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revision = z.number().int().min(0);
const stage = z.enum(installationSetupStagesV1);
const state = z.enum(["not_started", "running", "passed", "failed", "uncertain"]);
const stageInputs = z.object(Object.fromEntries(installationSetupStagesV1.map(name => [name, digest])) as Record<Stage, typeof digest>).strict();
const stageRecord = z.object({ stage, inputDigest: digest, state, outcomeDigest: digest.optional(), recordedRevision: revision.optional() }).strict();
const schema = z.object({ schema: z.literal(INSTALLATION_PLAN_V1), topologyPlanDigest: digest, releaseDigest: digest,
  revision, stages: z.array(stageRecord).length(installationSetupStagesV1.length), planDigest: digest,
  enablesAuthority: z.literal(false), startsService: z.literal(false), startsWorker: z.literal(false) }).strict();

export type InstallationPlanV1 = Readonly<{
  schema: typeof INSTALLATION_PLAN_V1;
  topologyPlanDigest: string;
  releaseDigest: string;
  revision: number;
  stages: readonly Readonly<{ stage: Stage; inputDigest: string; state: z.infer<typeof state>; outcomeDigest?: string; recordedRevision?: number }>[];
  planDigest: string;
  enablesAuthority: false;
  startsService: false;
  startsWorker: false;
}>;

const fail = (): never => { throw new Error("installation_plan_invalid"); };
const indexOf = (value: Stage) => installationSetupStagesV1.indexOf(value);

function material(input: Omit<InstallationPlanV1, "planDigest">) {
  return { ...input, stages: input.stages.map(item => ({ ...item })) };
}

function freeze(input: Omit<InstallationPlanV1, "planDigest">): InstallationPlanV1 {
  const value = material(input);
  return Object.freeze({ ...value, stages: Object.freeze(value.stages.map(item => Object.freeze(item))),
    planDigest: sha256Digest(value) });
}

function validateStages(value: readonly z.infer<typeof stageRecord>[], planRevision: number): void {
  if (value.length !== installationSetupStagesV1.length
    || value.some((item, index) => item.stage !== installationSetupStagesV1[index])
    || value.some(item => (item.state === "not_started"
      ? item.outcomeDigest !== undefined || item.recordedRevision !== undefined
      : item.recordedRevision === undefined || (item.state === "running" ? item.outcomeDigest !== undefined : item.outcomeDigest === undefined)))) fail();
  const recorded = value.filter(item => item.recordedRevision !== undefined).map(item => item.recordedRevision!);
  if (recorded.some((item, index) => item < 1 || item > planRevision || (index > 0 && recorded[index - 1]! >= item))) fail();
  const firstIncomplete = value.findIndex(item => item.state !== "passed");
  if (firstIncomplete >= 0 && value.slice(firstIncomplete + 1).some(item => item.state !== "not_started")) fail();
  if (firstIncomplete >= 0 && value[firstIncomplete]!.state === "not_started") {
    if (value.slice(firstIncomplete + 1).some(item => item.state !== "not_started")) fail();
  }
}

export function verifyInstallationPlanV1(value: unknown): InstallationPlanV1 {
  const parsed = schema.parse(value);
  validateStages(parsed.stages, parsed.revision);
  const { planDigest, ...unsigned } = parsed;
  if (planDigest !== sha256Digest(unsigned)) fail();
  return freeze(unsigned);
}

function bindings(input: Readonly<{ topologyPlan: unknown; releaseDigest: unknown; stageInputDigests: unknown }>) {
  const topology = verifyInstallationTopologyPlanV1(input.topologyPlan);
  return Object.freeze({ topologyPlanDigest: topology.planDigest, releaseDigest: digest.parse(input.releaseDigest),
    stageInputDigests: stageInputs.parse(input.stageInputDigests) });
}

/** Creates the one fixed setup plan. Only digest inputs are retained. */
export function createInstallationPlanV1(input: Readonly<{ topologyPlan: unknown; releaseDigest: unknown; stageInputDigests: unknown }>): InstallationPlanV1 {
  const bound = bindings(input);
  return freeze({ schema: INSTALLATION_PLAN_V1, topologyPlanDigest: bound.topologyPlanDigest, releaseDigest: bound.releaseDigest,
    revision: 0, stages: installationSetupStagesV1.map(name => ({ stage: name, inputDigest: bound.stageInputDigests[name], state: "not_started" as const })),
    enablesAuthority: false, startsService: false, startsWorker: false });
}

/**
 * Refreshes immutable inputs after a restart or revised installation choice.
 * A release/topology change invalidates all proof; a stage-input change
 * invalidates that stage and every dependent stage, while retaining prior proof.
 */
export function refreshInstallationPlanV1(currentValue: unknown,
  input: Readonly<{ topologyPlan: unknown; releaseDigest: unknown; stageInputDigests: unknown }>): InstallationPlanV1 {
  const current = verifyInstallationPlanV1(currentValue), next = bindings(input);
  let changedAt = -1;
  if (current.topologyPlanDigest !== next.topologyPlanDigest || current.releaseDigest !== next.releaseDigest) changedAt = 0;
  else changedAt = installationSetupStagesV1.findIndex((name, index) => current.stages[index]!.inputDigest !== next.stageInputDigests[name]);
  if (changedAt === -1) return current;
  if (current.stages.slice(changedAt).some(item => item.state === "running" || item.state === "uncertain"))
    throw new Error("installation_plan_conflict");
  return freeze({ schema: INSTALLATION_PLAN_V1, topologyPlanDigest: next.topologyPlanDigest, releaseDigest: next.releaseDigest,
    revision: current.revision + 1, stages: installationSetupStagesV1.map((name, index) => index < changedAt
      ? current.stages[index]! : { stage: name, inputDigest: next.stageInputDigests[name], state: "not_started" as const }),
    enablesAuthority: false, startsService: false, startsWorker: false });
}

/** Records one stage state; callers provide a digest, never raw operator evidence. */
export function advanceInstallationPlanV1(currentValue: unknown, input: Readonly<{
  expectedRevision: unknown; stage: unknown; action: "start" | "pass" | "fail" | "uncertain"; outcomeDigest?: unknown;
}>): InstallationPlanV1 {
  const current = verifyInstallationPlanV1(currentValue), expectedRevision = revision.parse(input.expectedRevision), selected = stage.parse(input.stage);
  const index = indexOf(selected), prior = current.stages[index]!;
  const wantsOutcome = input.action !== "start";
  const outcomeDigest = input.outcomeDigest === undefined ? undefined : digest.parse(input.outcomeDigest);
  if (wantsOutcome !== (outcomeDigest !== undefined)) fail();
  const desired: z.infer<typeof state> = input.action === "start" ? "running"
    : input.action === "pass" ? "passed" : input.action === "fail" ? "failed" : "uncertain";
  // A caller that lost the response repeats its original expected revision.
  // Recognize an exact already-recorded outcome before the stale-revision gate;
  // a changed replay still reaches the conflict below.
  if (prior.state === desired && prior.outcomeDigest === outcomeDigest) {
    if (prior.recordedRevision !== expectedRevision + 1 || current.revision !== prior.recordedRevision)
      throw new Error("installation_plan_conflict");
    return current;
  }
  if (expectedRevision !== current.revision) throw new Error("installation_plan_conflict");
  if (index > 0 && current.stages[index - 1]!.state !== "passed") throw new Error("installation_plan_conflict");
  if ((desired === "running" && prior.state !== "not_started") || (desired !== "running" && prior.state !== "running"))
    throw new Error("installation_plan_conflict");
  const stages = current.stages.map((record, recordIndex) => recordIndex === index
    ? { stage: selected, inputDigest: prior.inputDigest, state: desired, recordedRevision: current.revision + 1,
      ...(outcomeDigest ? { outcomeDigest } : {}) } : record);
  return freeze({ schema: INSTALLATION_PLAN_V1, topologyPlanDigest: current.topologyPlanDigest, releaseDigest: current.releaseDigest,
    revision: current.revision + 1, stages, enablesAuthority: false, startsService: false, startsWorker: false });
}

/** Restart callers may inspect interrupted work, but cannot treat it as permission to repeat an effect. */
export function installationPlanRestartGuidanceV1(value: unknown) {
  const plan = verifyInstallationPlanV1(value);
  const next = plan.stages.find(item => item.state !== "passed");
  if (!next) return Object.freeze({ kind: "complete" as const, startsWork: false as const });
  if (next.state === "running" || next.state === "uncertain") return Object.freeze({ kind: "inspect" as const,
    stage: next.stage, reason: next.state, startsWork: false as const });
  if (next.state === "failed") return Object.freeze({ kind: "owner_attention" as const,
    stage: next.stage, reason: "failed" as const, startsWork: false as const });
  return Object.freeze({ kind: "ready_to_begin" as const, stage: next.stage, startsWork: false as const });
}

/** Exact state equality is a convenient safe idempotency check for a persistence adapter. */
export function installationPlanReplayMatchesV1(left: unknown, right: unknown): boolean {
  return canonicalJson(verifyInstallationPlanV1(left)) === canonicalJson(verifyInstallationPlanV1(right));
}
