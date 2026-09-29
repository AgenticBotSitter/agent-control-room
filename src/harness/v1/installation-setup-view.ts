import { guideInstallationReadinessV1 } from "./installation-guidance";
import { summarizeInstallationReadinessV1, type InstallationReadinessV1 } from "./installation-readiness";
import { summarizeLocalHarnessCapabilitiesV1 } from "./local-harness-capabilities";
import { summarizeLocalSupervisorReadinessV1, type LocalSupervisorReadinessV1 } from "./local-supervisor-readiness";
import type { InstallationTopologyPlanV1 } from "./installation-topology";
import { summarizeInstallationTransitionV1 } from "./installation-transition-summary";
import type { InstallationTransitionV1 } from "./installation-transition";
import type { CodexMacosCustodyReadinessV1 } from "../codex-v1/macos-custody-readiness";

import { parseInstallationSetupViewV1, type InstallationSetupViewV1 } from "./installation-setup-wire";
export { parseInstallationSetupViewV1, type InstallationSetupViewV1 } from "./installation-setup-wire";

/** Builds the one safe setup projection sent to a browser. It deliberately
 * replaces raw topology/readiness records with the product facts a user needs
 * to understand the next step. */
export function createInstallationSetupViewV1(input: Readonly<{
  plan: InstallationTopologyPlanV1; readiness?: InstallationReadinessV1; localBackupRestoreVerified: boolean;
  codexMacosCustodyReadiness?: CodexMacosCustodyReadinessV1; claudeCodeLocalProcessReadiness?: unknown;
  localSupervisorReadiness?: LocalSupervisorReadinessV1; transition?: InstallationTransitionV1;
}>): InstallationSetupViewV1 {
  const readiness = summarizeInstallationReadinessV1(input.plan, input.readiness);
  const backupEvidencePending = input.plan.mode === "this_computer"
    && readiness.state === "ready_for_owner_enablement" && input.localBackupRestoreVerified !== true;
  const overallState: InstallationSetupViewV1["overallState"] = backupEvidencePending ? "not_ready" : readiness.state;
  const local = input.plan.mode === "this_computer";
  const supervisor = local ? summarizeLocalSupervisorReadinessV1(input.plan.planDigest, input.localSupervisorReadiness) : undefined;
  return parseInstallationSetupViewV1({ mode: input.plan.mode, overallState,
    ...(backupEvidencePending ? {} : readiness.nextProof === undefined ? {} : { nextProof: readiness.nextProof }),
    backupEvidencePending, proofs: readiness.proofs, guidance: guideInstallationReadinessV1(input.plan, input.readiness),
    ...(local ? { localCapabilities: summarizeLocalHarnessCapabilitiesV1(input.plan, input.readiness,
      input.codexMacosCustodyReadiness, input.claudeCodeLocalProcessReadiness, input.localBackupRestoreVerified,
      input.localSupervisorReadiness),
    localService: { state: supervisor!.state, proofs: supervisor!.proofs } } : {}),
    transition: summarizeInstallationTransitionV1(input.transition) });
}
