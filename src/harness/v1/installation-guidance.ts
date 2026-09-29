import { summarizeInstallationReadinessV1, type InstallationReadinessV1 } from "./installation-readiness";
import type { InstallationTopologyPlanV1 } from "./installation-topology";

export type InstallationGuidanceStepV1 = Readonly<{
  proof?: "local_owner_qualification" | "local_runner_bridge" | "remote_enrollment" | "two_computer_delivery" | "backup_restore";
  state: "next" | "complete" | "blocked";
  title: string;
  detail: string;
}>;

/**
 * Safe, human-readable setup guidance for the protected website. It derives
 * from a verified plan and opaque proof states only: no worker address,
 * account, command, private path, evidence digest, or enablement control can
 * enter this projection.
 */
export function guideInstallationReadinessV1(planInput: unknown, readinessInput?: unknown): readonly InstallationGuidanceStepV1[] {
  const summary = summarizeInstallationReadinessV1(planInput, readinessInput);
  if (summary.state === "ready_for_owner_enablement") return Object.freeze([Object.freeze({ state: "complete",
    title: "Setup proofs are complete", detail: "The owner may now choose whether to enable this reviewed installation. This page cannot enable a worker." })]);
  if (summary.state === "blocked") return Object.freeze([Object.freeze({ state: "blocked",
    title: "A setup proof needs attention", detail: "Do not start or retry a worker from this page. Review the owner procedure and record a new proof only after the underlying problem is resolved." })]);
  const next = summary.nextProof;
  if (next === "local_owner_qualification") return Object.freeze([Object.freeze({ proof: next, state: "next",
    title: "Check the local agent connection", detail: "The owner runs one small text-only check against the existing local agent. Its safe outcome is recorded as a fingerprint; it does not start automatic work." })]);
  if (next === "local_runner_bridge") return Object.freeze([Object.freeze({ proof: next, state: "next",
    title: "Check the local Control Room runner", detail: "First use the no-agent preflight, then the owner runs one text-only check through the exact runner bridge. This is separate from the agent connection check." })]);
  if (next === "backup_restore") return Object.freeze([Object.freeze({ proof: next, state: "next",
    title: "Prove backup and recovery", detail: "Restore disposable copies of the database and protected result bytes, then record only the safe proof outcome. A backup has not been proven merely because a file exists." })]);
  if (next === "remote_enrollment") return Object.freeze([Object.freeze({ proof: next, state: "next",
    title: "Enroll the remote worker", detail: "The owner privately verifies the worker identity and compatible adapter version before it can receive work." })]);
  if (next === "two_computer_delivery") return Object.freeze([Object.freeze({ proof: next, state: "next",
    title: "Prove one controlled remote delivery", detail: "Use disposable work to verify the intended remote worker receives one task and returns one result through the ordinary review path." })]);
  return Object.freeze([Object.freeze({ state: "blocked", title: "Setup guidance is unavailable", detail: "The reviewed plan did not describe a next safe proof. No worker is treated as ready." })]);
}
