import { createInstallationReadinessV1, verifyInstallationReadinessV1, type InstallationReadinessV1 } from "../v1/installation-readiness";
import { localBackupRestoreEvidenceDigestForInstallationPlanV1 } from "../v1/local-backup-restore-readiness";
import { verifyInstallationTopologyPlanV1, type InstallationTopologyPlanV1 } from "../v1/installation-topology";
import { createHermes021MacosLocalQualificationEvidenceV1 } from "./qualification-evidence";
import { createHermes021MacosLocalRunnerQualificationEvidenceV1 } from "./runner-qualification-evidence";

const unavailable = (): never => { throw new Error("hermes_021_macos_installation_readiness_unavailable"); };

function existingReadinessFor(plan: InstallationTopologyPlanV1, existingValue?: unknown): InstallationReadinessV1 | undefined {
  const existing = existingValue === undefined ? undefined : verifyInstallationReadinessV1(existingValue);
  if (existing && (existing.planDigest !== plan.planDigest
    || existing.proofs.some(item => !plan.requiredProofs.includes(item.proof)))) unavailable();
  return existing;
}

function replaceProof(existing: InstallationReadinessV1 | undefined,
  proof: InstallationReadinessV1["proofs"][number]): InstallationReadinessV1["proofs"] {
  const byProof = new Map(existing?.proofs.map(item => [item.proof, item]) ?? []);
  byProof.set(proof.proof, proof);
  return [...byProof.values()];
}

/**
 * Records the backup-and-restore prerequisite only from the verified,
 * plan-bound restore evidence. It does not perform a backup or restore; the
 * caller supplies the already captured safe evidence after an owner-run,
 * disposable restore. This prevents an arbitrary digest from making a local
 * Hermes installation look ready.
 */
export function recordLocalBackupRestoreReadinessV1(planValue: unknown,
  backupRestoreProof: unknown, existingValue?: unknown): InstallationReadinessV1 {
  try {
    const plan = verifyInstallationTopologyPlanV1(planValue);
    if (!plan.requiredProofs.includes("backup_restore")) unavailable();
    const existing = existingReadinessFor(plan, existingValue);
    const evidenceDigest = localBackupRestoreEvidenceDigestForInstallationPlanV1(plan, backupRestoreProof);
    return createInstallationReadinessV1({ planDigest: plan.planDigest,
      proofs: replaceProof(existing, { proof: "backup_restore", state: "passed", evidenceDigest }) });
  } catch { return unavailable(); }
}

/**
 * Server-only helper for recording the safe outcome of the already owner-run
 * text check. It does not write a database, enable a worker, or accept a web
 * request. The installer persists the returned, plan-bound readiness record
 * through its existing protected configuration path.
 */
export function recordHermes021MacosLocalQualificationReadinessV1(planValue: unknown,
  successfulReport: unknown, existingValue?: unknown): InstallationReadinessV1 {
  const plan: InstallationTopologyPlanV1 = verifyInstallationTopologyPlanV1(planValue);
  if (!plan.requiredProofs.includes("local_owner_qualification")) unavailable();
  const existing = existingReadinessFor(plan, existingValue);
  const evidence = createHermes021MacosLocalQualificationEvidenceV1(successfulReport);
  return createInstallationReadinessV1({ planDigest: plan.planDigest,
    proofs: replaceProof(existing, { proof: "local_owner_qualification", state: "passed", evidenceDigest: evidence.evidenceDigest }) });
}

/**
 * Records the separate proof that the fixed-argument Control Room runner can
 * reach Hermes. A successful text-only Hermes qualification cannot substitute
 * for this proof: it did not exercise the runner that will receive work.
 */
export function recordHermes021MacosLocalRunnerQualificationReadinessV1(planValue: unknown,
  successfulReport: unknown, existingValue?: unknown): InstallationReadinessV1 {
  const plan: InstallationTopologyPlanV1 = verifyInstallationTopologyPlanV1(planValue);
  if (!plan.requiredProofs.includes("local_runner_bridge")) unavailable();
  const existing = existingReadinessFor(plan, existingValue);
  const evidence = createHermes021MacosLocalRunnerQualificationEvidenceV1(successfulReport);
  return createInstallationReadinessV1({ planDigest: plan.planDigest,
    proofs: replaceProof(existing, { proof: "local_runner_bridge", state: "passed", evidenceDigest: evidence.evidenceDigest }) });
}
