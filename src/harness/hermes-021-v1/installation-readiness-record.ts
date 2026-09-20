import { createInstallationReadinessV1, verifyInstallationReadinessV1, type InstallationReadinessV1 } from "../v1/installation-readiness";
import { verifyInstallationTopologyPlanV1, type InstallationTopologyPlanV1 } from "../v1/installation-topology";
import { createHermes021MacosLocalQualificationEvidenceV1 } from "./qualification-evidence";

const unavailable = (): never => { throw new Error("hermes_021_macos_installation_readiness_unavailable"); };

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
  const existing = existingValue === undefined ? undefined : verifyInstallationReadinessV1(existingValue);
  if (existing && existing.planDigest !== plan.planDigest) unavailable();
  if (existing?.proofs.some(item => !plan.requiredProofs.includes(item.proof))) unavailable();
  const evidence = createHermes021MacosLocalQualificationEvidenceV1(successfulReport);
  const byProof = new Map(existing?.proofs.map(item => [item.proof, item]) ?? []);
  byProof.set("local_owner_qualification", { proof: "local_owner_qualification" as const, state: "passed" as const,
    evidenceDigest: evidence.evidenceDigest });
  return createInstallationReadinessV1({ planDigest: plan.planDigest,
    proofs: [...byProof.values()] });
}
