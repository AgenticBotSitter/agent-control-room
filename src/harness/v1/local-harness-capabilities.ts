import type { ConnectorOperationNameV1, ConnectorProfileV1 } from "./connector-profile";
import { claudeCodeConnectorProfileV1 } from "../claude-code-v1/connector-profile";
import { hermes021MacosLocalConnectorProfileV1 } from "../hermes-021-v1/connector-profile";
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
    nextStep: "Record the exact local runner check and protected backup-and-recovery proof before a bounded Hermes task can be enabled.",
    operations: operationSummary(hermes021MacosLocalConnectorProfileV1),
  }),
  Object.freeze({
    id: "claude",
    label: "Claude Code",
    state: "setup_required",
    stateLabel: "Adapter preparation required",
    summary: "Control Room can safely decode Claude output and prepare a result for review, but it does not yet own a qualified local Claude process.",
    firstSupportedWork: "No local work is enabled until the installed process and its permission behavior are qualified.",
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
  readiness?: InstallationReadinessV1): readonly LocalHarnessCapabilityV1[] {
  if (!plan || !plan.requiredProofs.includes("local_owner_qualification") || !plan.requiredProofs.includes("local_runner_bridge"))
    return localHarnessCapabilitiesV1;
  const summary = summarizeInstallationReadinessV1(plan, readiness);
  const localProofs = summary.proofs.filter(item => ["local_owner_qualification", "local_runner_bridge", "backup_restore"].includes(item.proof));
  const hermes = localHarnessCapabilitiesV1[0]!;
  if (localProofs.some(item => item.state === "failed" || item.state === "unavailable")) {
    return Object.freeze([Object.freeze({ ...hermes, state: "setup_needs_attention" as const,
      stateLabel: "Setup needs attention", summary: "Control Room has not enabled Hermes. One or more required local proof checks needs attention.",
      nextStep: "Correct the failed local proof through the owner-run procedure, then record a fresh non-secret proof result." }), ...localHarnessCapabilitiesV1.slice(1)]);
  }
  if (localProofs.length === 3 && localProofs.every(item => item.state === "passed")) {
    return Object.freeze([Object.freeze({ ...hermes, state: "owner_enablement_required" as const,
      stateLabel: "Proof complete; owner enablement required", summary: "The required local proof records are complete, but Control Room still has not started Hermes.",
      nextStep: "The owner may now make the separate, explicit local-worker enablement decision." }), ...localHarnessCapabilitiesV1.slice(1)]);
  }
  return localHarnessCapabilitiesV1;
}
