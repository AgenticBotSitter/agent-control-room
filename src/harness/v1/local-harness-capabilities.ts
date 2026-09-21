import type { ConnectorOperationNameV1, ConnectorProfileV1 } from "./connector-profile";
import { claudeCodeConnectorProfileV1 } from "../claude-code-v1/connector-profile";
import { hermes021MacosLocalConnectorProfileV1 } from "../hermes-021-v1/connector-profile";
import { summarizeCodexMacosCustodyReadinessV1 } from "../codex-v1/macos-custody-readiness";
import { summarizeInstallationReadinessV1, type InstallationReadinessV1 } from "./installation-readiness";
import type { InstallationTopologyPlanV1 } from "./installation-topology";

export type LocalHarnessCapabilityStateV1 = "setup_required" | "setup_needs_attention" | "owner_enablement_required" | "not_available";
export type LocalHarnessCapabilityV1 = Readonly<{
  id: "hermes" | "claude" | "codex";
  label: string;
  state: LocalHarnessCapabilityStateV1;
  stateLabel: string;
  summary: string;
  /** Useful work the product may offer only after the displayed proof passes. */
  firstSupportedWork: string;
  /** The bounded, non-operating product behavior that is safe to describe today. */
  safeNow: string;
  /** Makes the source-contract boundary visible without exposing local configuration. */
  sourceOnly: string;
  /** A short category, so an owner can identify the remaining setup without a private diagnostic. */
  remainingSetupCategory: string;
  nextStep: string;
  operations: Readonly<{
    submit: "supported" | "unsupported" | "unknown";
    result: "supported" | "unsupported" | "unknown";
    cancel: "supported" | "unsupported" | "unknown";
    read: "supported" | "unsupported" | "unknown";
  }>;
}>;

function operationSummary(profile: ConnectorProfileV1) {
  const names = ["submit", "result", "cancel", "read"] as const satisfies readonly ConnectorOperationNameV1[];
  return Object.freeze(Object.fromEntries(names.map(name => [name, profile.operations[name].status])) as LocalHarnessCapabilityV1["operations"]);
}

/**
 * A public-safe, source-derived description of the local harness choices.
 * This is deliberately installation-independent: it reports what the product
 * still needs to prove, never whether a person's private executable, account,
 * model, workspace, or credential is available.
 */
export const localHarnessCapabilitiesV1: readonly LocalHarnessCapabilityV1[] = Object.freeze([
  Object.freeze({
    id: "hermes",
    label: "Hermes Agent",
    state: "setup_required",
    stateLabel: "Setup proof required",
    summary: "Control Room has a prepared local delivery, staged-result, review and restart-recovery path. It is not enabled by this screen.",
    firstSupportedWork: "A one-turn plain-text review, test outline, or proposed patch from supplied task context. It cannot edit a project yet.",
    safeNow: "Prepare and check one bounded delivery and retain a staged result for review or restart recovery. This does not send work to Hermes or start it.",
    sourceOnly: "The delivery, result and recovery path is source-only evidence tested with disposable data; no installed Hermes program is being claimed.",
    remainingSetupCategory: "Local runner, protected storage and recovery proof",
    nextStep: "Record the exact local runner check and protected backup-and-recovery proof before a bounded Hermes task can be enabled.",
    operations: operationSummary(hermes021MacosLocalConnectorProfileV1),
  }),
  Object.freeze({
    id: "claude",
    label: "Claude Code",
    state: "setup_required",
    stateLabel: "Adapter preparation required",
    summary: "Control Room can save a bounded Claude text-review task, decode output and prepare a result for review, but it does not yet own a qualified local Claude process.",
    firstSupportedWork: "The owner may prepare a bounded text-review task, but no local Claude work is enabled until the installed process and its permission behavior are qualified.",
    safeNow: "Save a bounded text-review plan and validate the source-side result format. This does not contact, start or grant work to Claude Code.",
    sourceOnly: "The task-plan and result-decoding path is source-only; it is not evidence of an installed Claude Code process or its permissions.",
    remainingSetupCategory: "Installed-process and permission qualification",
    nextStep: "Qualify the installed Claude process, its approval behavior and restart-safe result read before it can receive a task.",
    operations: operationSummary(claudeCodeConnectorProfileV1),
  }),
  Object.freeze({
    id: "codex",
    label: "Codex",
    state: "not_available",
    stateLabel: "Not available on this Mac yet",
    summary: "Control Room has the App Server task and recovery contracts, but local macOS execution deliberately remains off.",
    firstSupportedWork: "No local work is enabled on this Mac until the separate process-custody proof passes.",
    safeNow: "Retain the source contracts for a future App Server task and recovery path. This does not inspect or start Codex.",
    sourceOnly: "The App Server task and recovery contracts are source-only. They are not evidence of a local Codex installation, identity or private-state access.",
    remainingSetupCategory: "macOS process and private-state custody qualification",
    nextStep: "First prove a safe macOS process and private-credential custody design, then perform the separate owner-attended qualification.",
    operations: Object.freeze({ submit: "unsupported", result: "unsupported", cancel: "unsupported", read: "unsupported" }),
  }),
]);

/**
 * Combines the safe, installation-independent descriptions above with the
 * existing non-secret proof record. Passing setup proof never means that an
 * agent is running: it only means the operator may perform the next, separate
 * enablement decision. A missing or foreign plan remains the conservative
 * source-only description.
 */
export function summarizeLocalHarnessCapabilitiesV1(plan?: InstallationTopologyPlanV1,
  readiness?: InstallationReadinessV1, codexMacosCustodyReadiness?: unknown): readonly LocalHarnessCapabilityV1[] {
  if (!plan || !plan.requiredProofs.includes("local_owner_qualification") || !plan.requiredProofs.includes("local_runner_bridge"))
    return localHarnessCapabilitiesV1;
  const summary = summarizeInstallationReadinessV1(plan, readiness);
  const localProofs = summary.proofs.filter(item => ["local_owner_qualification", "local_runner_bridge", "backup_restore"].includes(item.proof));
  const hermes = localHarnessCapabilitiesV1[0]!;
  const codex = localHarnessCapabilitiesV1[2]!;
  const custody = summarizeCodexMacosCustodyReadinessV1(plan.planDigest, codexMacosCustodyReadiness);
  const codexCapability = custody.state === "blocked" ? Object.freeze({ ...codex, state: "setup_needs_attention" as const,
    stateLabel: "Mac safety proof needs attention", summary: "Control Room has not enabled Codex on this Mac. A required process or private-state custody proof is unavailable or failed.",
    remainingSetupCategory: "Corrective macOS custody proof",
    nextStep: "Correct the specific owner-run custody proof, record fresh non-secret evidence, then complete the separate exact-harness qualification." })
    : custody.state === "custody_recorded" ? Object.freeze({ ...codex, state: "setup_required" as const,
      stateLabel: "Mac safety prerequisites recorded", summary: "The two Mac custody prerequisites are recorded, but Control Room still has not started Codex.",
      remainingSetupCategory: "Owner-attended exact-harness qualification",
      nextStep: "Perform the separate owner-attended exact-harness qualification. This record alone cannot enable or launch Codex." }) : codex;
  if (localProofs.some(item => item.state === "failed" || item.state === "unavailable")) {
    return Object.freeze([Object.freeze({ ...hermes, state: "setup_needs_attention" as const,
      stateLabel: "Setup needs attention", summary: "Control Room has not enabled Hermes. One or more required local proof checks needs attention.",
      remainingSetupCategory: "Corrective local proof",
      nextStep: "Correct the failed local proof through the owner-run procedure, then record a fresh non-secret proof result." }), localHarnessCapabilitiesV1[1]!, codexCapability]);
  }
  if (localProofs.length === 3 && localProofs.every(item => item.state === "passed")) {
    return Object.freeze([Object.freeze({ ...hermes, state: "owner_enablement_required" as const,
      stateLabel: "Proof complete; owner enablement required", summary: "The required local proof records are complete, but Control Room still has not started Hermes.",
      remainingSetupCategory: "Separate owner enablement decision",
      nextStep: "The owner may now make the separate, explicit local-worker enablement decision." }), localHarnessCapabilitiesV1[1]!, codexCapability]);
  }
  const passed = new Set(localProofs.filter(item => item.state === "passed").map(item => item.proof));
  const runnerRecorded = passed.has("local_runner_bridge");
  const textRecorded = passed.has("local_owner_qualification");
  const backupRecorded = passed.has("backup_restore");
  if (runnerRecorded || textRecorded || backupRecorded) {
    const missing = [
      !runnerRecorded ? "the local runner check" : undefined,
      !textRecorded ? "the local agent check" : undefined,
      !backupRecorded ? "the backup-and-restore check" : undefined,
    ].filter((value): value is string => value !== undefined);
    return Object.freeze([Object.freeze({ ...hermes,
      stateLabel: "Partial setup proof recorded",
      summary: "Control Room has recorded part of the local Hermes setup proof. Hermes is still not enabled or running.",
      remainingSetupCategory: "Remaining local setup proof",
      nextStep: `Record ${missing.join(", ")} before a bounded Hermes task can be enabled.`,
    }), localHarnessCapabilitiesV1[1]!, codexCapability]);
  }
  return Object.freeze([hermes, localHarnessCapabilitiesV1[1]!, codexCapability]);
}
