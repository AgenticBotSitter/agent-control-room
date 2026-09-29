import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationTopologyPlanV1, type InstallationTopologyPlanV1 } from "./installation-topology";

/**
 * An append-only, pure transition record for changing one installation's
 * worker layout. It is deliberately not a scheduler switch, database move,
 * worker enablement, or transport. The eventual canonical-store adapter must
 * persist these exact records before it performs any corresponding effect.
 */
export const INSTALLATION_TRANSITION_V1 = "control-room.installation-transition/v1" as const;

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const state = z.enum(["prepared", "admission_paused", "drained", "proofs_verified", "committed", "failed", "rollback_ready", "rolled_back"]);
const action = z.enum(["pause_admission", "record_drain", "verify_proofs", "commit", "fail", "prepare_rollback", "rollback"]);
const drainStatus = z.enum(["all_drained", "uncertain_work_recorded"]);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);

export type InstallationTransitionStateV1 = z.infer<typeof state>;
export type InstallationTransitionActionV1 = z.infer<typeof action>;
export type InstallationTransitionV1 = Readonly<{
  schema: typeof INSTALLATION_TRANSITION_V1;
  transitionId: string;
  planDigest: string;
  /** These remain fixed for the whole worker-placement transition. */
  databaseAuthorityDigest: string;
  schedulerAuthorityDigest: string;
  affectedWorkerIds: readonly string[];
  revision: number;
  state: InstallationTransitionStateV1;
  evidenceDigest?: string;
  failureDigest?: string;
  /** A relocation preflight may use only an explicitly clean drain. */
  drainStatus?: "all_drained" | "uncertain_work_recorded";
  updatedAt: string;
  /** This record is preparatory only. */
  enablesWorkers: false;
  authorizesAuthorityRelocation: false;
  transitionDigest: string;
}>;

function requiresDrainStatus(value: InstallationTransitionStateV1): boolean {
  return value === "drained" || value === "proofs_verified" || value === "committed";
}

function affected(plan: InstallationTopologyPlanV1): readonly string[] {
  return Object.freeze([...new Set([
    ...plan.reboundWorkerIds,
    ...plan.addedLocalWorkerIds,
    ...plan.addedRemoteWorkerIds,
    ...plan.removedWorkerIds,
  ])].sort());
}

function freeze(value: Omit<InstallationTransitionV1, "transitionDigest">): InstallationTransitionV1 {
  const material = { ...value, affectedWorkerIds: [...value.affectedWorkerIds] };
  return Object.freeze({ ...material, affectedWorkerIds: Object.freeze(material.affectedWorkerIds), transitionDigest: sha256Digest(material) });
}

export function createInstallationTransitionV1(input: Readonly<{
  transitionId: unknown; topologyPlan: unknown; now: unknown;
}>): InstallationTransitionV1 {
  const plan = verifyInstallationTopologyPlanV1(input.topologyPlan);
  return freeze({ schema: INSTALLATION_TRANSITION_V1, transitionId: id.parse(input.transitionId), planDigest: plan.planDigest,
    databaseAuthorityDigest: plan.databaseAuthorityDigest, schedulerAuthorityDigest: plan.schedulerAuthorityDigest,
    affectedWorkerIds: affected(plan), revision: 0, state: "prepared", updatedAt: instant.parse(input.now),
    enablesWorkers: false, authorizesAuthorityRelocation: false });
}

export function verifyInstallationTransitionV1(value: unknown): InstallationTransitionV1 {
  const parsed = z.object({ schema: z.literal(INSTALLATION_TRANSITION_V1), transitionId: id, planDigest: digest,
    databaseAuthorityDigest: digest, schedulerAuthorityDigest: digest,
    // A 100-route current layout may be replaced by a disjoint 100-route requested layout.
    affectedWorkerIds: z.array(id).max(200), revision: z.number().int().min(0), state, evidenceDigest: digest.optional(),
    failureDigest: digest.optional(), drainStatus: drainStatus.optional(), updatedAt: instant, enablesWorkers: z.literal(false),
    authorizesAuthorityRelocation: z.literal(false), transitionDigest: digest }).strict().parse(value);
  const { transitionDigest, ...material } = parsed;
  const evidenceStates: readonly InstallationTransitionStateV1[] = ["admission_paused", "drained", "proofs_verified", "committed", "rollback_ready", "rolled_back"];
  if (transitionDigest !== sha256Digest(material) || new Set(parsed.affectedWorkerIds).size !== parsed.affectedWorkerIds.length
    || canonicalJson(parsed.affectedWorkerIds) !== canonicalJson([...parsed.affectedWorkerIds].sort())
    || (parsed.state === "failed" ? parsed.failureDigest === undefined : parsed.failureDigest !== undefined)
    || requiresDrainStatus(parsed.state) !== (parsed.drainStatus !== undefined)
    || evidenceStates.includes(parsed.state)
      && parsed.evidenceDigest === undefined) throw new Error("installation_transition_invalid");
  return Object.freeze({ ...parsed, affectedWorkerIds: Object.freeze([...parsed.affectedWorkerIds]) });
}

export function advanceInstallationTransitionV1(currentValue: unknown, input: Readonly<{
  expectedRevision: unknown; action: unknown; now: unknown; evidenceDigest?: unknown; failureDigest?: unknown; drainStatus?: unknown;
}>): InstallationTransitionV1 {
  const current = verifyInstallationTransitionV1(currentValue);
  const expectedRevision = z.number().int().min(0).parse(input.expectedRevision);
  const selected = action.parse(input.action);
  const now = instant.parse(input.now);
  if (expectedRevision !== current.revision || Date.parse(now) < Date.parse(current.updatedAt)) throw new Error("installation_transition_conflict");
  const evidenceDigest = input.evidenceDigest === undefined ? undefined : digest.parse(input.evidenceDigest);
  const failureDigest = input.failureDigest === undefined ? undefined : digest.parse(input.failureDigest);
  const requestedDrainStatus = input.drainStatus === undefined ? undefined : drainStatus.parse(input.drainStatus);
  const requiresEvidence = selected !== "fail";
  if ((requiresEvidence && evidenceDigest === undefined) || (!requiresEvidence && failureDigest === undefined)
    || (requiresEvidence && failureDigest !== undefined) || (!requiresEvidence && evidenceDigest !== undefined))
    throw new Error("installation_transition_evidence_invalid");
  const allowed: Readonly<Record<InstallationTransitionStateV1, Partial<Record<InstallationTransitionActionV1, InstallationTransitionStateV1>>>> = {
    prepared: { pause_admission: "admission_paused", fail: "failed" },
    admission_paused: { record_drain: "drained", fail: "failed" },
    drained: { verify_proofs: "proofs_verified", fail: "failed" },
    proofs_verified: { commit: "committed", fail: "failed" },
    committed: {},
    failed: { prepare_rollback: "rollback_ready" },
    rollback_ready: { rollback: "rolled_back" },
    rolled_back: {},
  };
  const next = allowed[current.state][selected];
  if (!next) throw new Error("installation_transition_action_invalid");
  if (selected !== "record_drain" && requestedDrainStatus !== undefined) throw new Error("installation_transition_drain_status_invalid");
  // Old callers remain conservative: an undeclared drain is explicitly
  // uncertain and cannot later authorize a database cutover preparation.
  const nextDrainStatus = selected === "record_drain"
    ? requestedDrainStatus ?? "uncertain_work_recorded"
    : current.drainStatus;
  return freeze({ schema: INSTALLATION_TRANSITION_V1, transitionId: current.transitionId, planDigest: current.planDigest,
    databaseAuthorityDigest: current.databaseAuthorityDigest, schedulerAuthorityDigest: current.schedulerAuthorityDigest,
    affectedWorkerIds: current.affectedWorkerIds, revision: current.revision + 1, state: next, updatedAt: now,
    ...(evidenceDigest ? { evidenceDigest } : {}), ...(failureDigest ? { failureDigest } : {}),
    ...(requiresDrainStatus(next) ? { drainStatus: nextDrainStatus } : {}),
    enablesWorkers: false, authorizesAuthorityRelocation: false });
}
