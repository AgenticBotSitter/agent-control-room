import { z } from "zod";
import { verifyInstallationTransitionV1 } from "./installation-transition";

/**
 * Safe, read-only wording for setup surfaces. It deliberately exposes counts
 * and progress only: route IDs, host details, credentials and transition
 * evidence remain installation-owned.
 *
 * The evaluated T3 Code project is a presentation reference only. No upstream
 * source is retained: Control Room's transition authority stays in the
 * verified record above.
 */
export type InstallationTransitionSummaryV1 = Readonly<{
  state: "not_started" | "prepared" | "admission_paused" | "drained" | "proofs_verified" | "committed" | "failed" | "rollback_ready" | "rolled_back";
  affectedWorkerCount: number;
  ownerMessage: string;
  nextStep: string;
  canEnableWorkers: false;
  canRelocateAuthority: false;
}>;

const summarySchema = z.object({
  state: z.enum(["not_started", "prepared", "admission_paused", "drained", "proofs_verified", "committed", "failed", "rollback_ready", "rolled_back"]),
  affectedWorkerCount: z.number().int().min(0).max(200),
  ownerMessage: z.string().min(1).max(500),
  nextStep: z.string().min(1).max(500),
  canEnableWorkers: z.literal(false),
  canRelocateAuthority: z.literal(false),
}).strict();

/** Validates the already-redacted browser shape. It is intentionally not the
 * transition record verifier: browsers never receive that record. */
export function parseInstallationTransitionSummaryV1(value: unknown): InstallationTransitionSummaryV1 {
  return Object.freeze(summarySchema.parse(value));
}

const messages: Readonly<Record<Exclude<InstallationTransitionSummaryV1["state"], "not_started">, Readonly<{
  ownerMessage: string; nextStep: string;
}>>> = Object.freeze({
  prepared: Object.freeze({ ownerMessage: "A reviewed setup change is prepared. No worker has been started or moved.",
    nextStep: "Pause new work for the affected workers before making any change." }),
  admission_paused: Object.freeze({ ownerMessage: "New work is paused for the affected workers. Existing work is still being checked.",
    nextStep: "Record whether active work drained safely or needs attention." }),
  drained: Object.freeze({ ownerMessage: "Affected work is drained or clearly marked uncertain. No route change is committed yet.",
    nextStep: "Verify the required setup and recovery proofs." }),
  proofs_verified: Object.freeze({ ownerMessage: "Required setup proofs are recorded. This does not itself start a worker or move the database.",
    nextStep: "A separately authorized controller action may commit the reviewed setup change." }),
  committed: Object.freeze({ ownerMessage: "The reviewed setup change is recorded as committed. Worker enablement remains a separate decision.",
    nextStep: "Complete any separately required worker enablement and acceptance proof." }),
  failed: Object.freeze({ ownerMessage: "The setup change did not complete. Nothing should be treated as automatically recovered.",
    nextStep: "Prepare an evidence-bound rollback or resolve the recorded uncertainty." }),
  rollback_ready: Object.freeze({ ownerMessage: "Rollback preparation is recorded. The change has not been silently undone.",
    nextStep: "Perform the separately authorized rollback procedure." }),
  rolled_back: Object.freeze({ ownerMessage: "Rollback is recorded. A new change requires a fresh reviewed plan and proof.",
    nextStep: "Create a new reviewed setup plan if a change is still wanted." }),
});

export function summarizeInstallationTransitionV1(value: unknown): InstallationTransitionSummaryV1 {
  if (value === undefined || value === null) return parseInstallationTransitionSummaryV1({ state: "not_started", affectedWorkerCount: 0,
    ownerMessage: "No setup change is in progress.", nextStep: "Create a reviewed setup plan before changing worker placement.",
    canEnableWorkers: false, canRelocateAuthority: false });
  const record = verifyInstallationTransitionV1(value);
  const message = messages[record.state];
  return parseInstallationTransitionSummaryV1({ state: record.state, affectedWorkerCount: record.affectedWorkerIds.length,
    ownerMessage: message.ownerMessage, nextStep: message.nextStep,
    canEnableWorkers: false, canRelocateAuthority: false });
}
