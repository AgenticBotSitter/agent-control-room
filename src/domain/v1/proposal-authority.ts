import type { AuthorityEnvelope } from "./types";

/**
 * The horizon an owner's ordinary task proposal carries, and the one helper
 * that names it.
 *
 * WHY. An owner-proposed task (`task.proposal`) holds authority that permits
 * exactly one operation, `task.propose`, with `effectPolicy: "none"` and
 * `maxConcurrentEffects: 0`. It starts no work, reaches no network, touches no
 * filesystem and spends no money. The envelope is the OWNER'S CONSENT to
 * propose, not a lease on a machine: what the owner is consenting to does not
 * decay five minutes after they press the button. The task stays proposed until
 * they act on it, and until they act on it no bot may do anything with it at
 * all -- an offer is the owner's separate, later decision (`offerTask`), and a
 * claim is bounded by the 15-minute fleet lease, which is re-checked against
 * this envelope on every renewal.
 *
 * The old stamp was `maxDurationSeconds: 300` with `expiresAt: now + 300s`,
 * measured from the moment of creation and never re-stamped. So an offer made
 * more than five minutes after the task was created could never be claimed
 * (`claimReadyTaskJob` refuses a job whose authority has expired), a bot that
 * DID claim in time had its lease capped at creation+5min instead of the
 * 15-minute fleet lease, and both failures reached the owner as an anonymous
 * HTTP 400 "refused". Five minutes was the right number for a different thing:
 * a request token. Nothing here carries one.
 *
 * WHAT, PRECISELY. Two values, and they do different jobs:
 *
 *   - `expiresAt` is far out, so an owner may create a task on Monday and offer
 *     it on Tuesday. It is still bounded -- `authorityEnvelopeSchema` requires a
 *     parseable ISO instant -- but the bound is the project's life, not a
 *     coffee break. This is the same shape the Mac-local task templates
 *     (`mac-local-task-provider-templates.ts`) and ready-frontier
 *     materialization already use for proposal-shaped work.
 *   - `maxDurationSeconds` is the cap on ONE claim's lease, which is what the
 *     fleet claim path actually reads (`min(leaseMs, expiresAt,
 *     now + maxDurationSeconds)`). The fleet lease is 15 minutes
 *     (`FLEET_LEASE_MS_V1`) and the harness's own per-task deadline is 30
 *     minutes, so 3600 keeps BOTH real windows inside the authority: a claim
 *     that a bot legitimately renews is bounded by the lease rules, not cut off
 *     at an arbitrary number of seconds after the owner hit Create.
 *
 * A single hour is deliberately not "forever". It is longer than any single
 * claim can live, and it is short enough that an authority envelope from this
 * path can never be mistaken for a deliberately unbounded one (the
 * ready-frontier path, whose work is not owner consent, still receives the
 * policy's own expiry).
 *
 * This function is the ONLY place these two numbers exist. The other
 * proposal-shaped stampers -- scheduled-task admission and pipelines -- keep
 * their own bounded windows on purpose: those are idempotency/recovery windows
 * tied to a schedule occurrence, not an owner's standing consent, and the
 * scheduled path re-checks its own window at commit.
 */
export const PROPOSAL_AUTHORITY_MAX_DURATION_SECONDS_V1 = 3_600;

/** The same far horizon as the Mac-local and ready-frontier proposal stamps. */
export const PROPOSAL_AUTHORITY_EXPIRES_AT_V1 = "9999-12-31T23:59:59.000Z";

/**
 * The authority envelope an owner-proposed task carries: one operation,
 * `task.propose`, no effects, and a horizon that matches what that authority
 * actually is. `digest` is filled in by the caller (the canonical store
 * rejects a mismatch), so this returns the material rather than the record.
 */
export function proposalAuthorityMaterialV1(projectId: string, createdAt: string): Omit<AuthorityEnvelope, "digest"> {
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)))
    throw new Error("proposal_authority_created_at_invalid");
  return {
    projectId,
    // "unassigned" is the whole point: this job names no executor. The fleet
    // claim path checks the worker's own scope and the owner's offer, not this
    // field, and the local assignment coordinator refuses it outright
    // (task-execution-planner.ts requires an unassigned executor for a
    // proposal), so a proposal can never be run by accident.
    allowedExecutor: "executor:unassigned",
    allowedOperations: ["task.propose"],
    credentialRefs: [],
    filesystemRoots: [],
    networkPolicy: "none",
    allowedNetworkDestinations: [],
    effectPolicy: "none",
    maxRisk: "low",
    maxDurationSeconds: PROPOSAL_AUTHORITY_MAX_DURATION_SECONDS_V1,
    maxConcurrentEffects: 0,
    expiresAt: PROPOSAL_AUTHORITY_EXPIRES_AT_V1,
  };
}