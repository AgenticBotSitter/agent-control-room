import { createClaudeCodeLocalProcessReadinessV1,
  verifyClaudeCodeLocalProcessReadinessV1,
  type ClaudeCodeLocalProcessReadinessV1 } from "./local-process-readiness";
import { claudeCodeTextReviewQualificationReportSchemaV1,
  createClaudeCodeTextReviewQualificationEvidenceV1,
  createClaudeCodeTextReviewQualificationFailureEvidenceV1 } from "./qualification-evidence";
import { verifyInstallationTopologyPlanV1 } from "../v1/installation-topology";

const unavailable = (): never => {
  throw new Error("claude_code_local_installation_readiness_unavailable");
};

/**
 * Converts one already-sanitized owner qualification report into the redacted
 * Claude process-readiness record used by setup presentation and admission.
 *
 * A successful one-turn check proves only the selected installed process and
 * the fixed no-tools permission policy. It deliberately leaves cancellation
 * and restart recovery unfinished until the separate installed-task proof is
 * observed. This helper starts no process and grants no task authority.
 */
export function recordClaudeCodeLocalQualificationReadinessV1(planValue: unknown,
  reportValue: unknown, existingValue?: unknown): ClaudeCodeLocalProcessReadinessV1 {
  try {
    const plan = verifyInstallationTopologyPlanV1(planValue);
    // The redacted plan intentionally retains worker IDs and route digests,
    // not adapter IDs. Require the additive local-worker transition shape
    // here; the later installation binding rechecks the exact Claude adapter.
    if (plan.mode !== "this_computer" || plan.addedLocalWorkerIds.length !== 1
      || plan.addedRemoteWorkerIds.length !== 0 || plan.removedWorkerIds.length !== 0
      || plan.reboundWorkerIds.length !== 0) unavailable();
    const existing = existingValue === undefined ? undefined : verifyClaudeCodeLocalProcessReadinessV1(existingValue);
    if (existing && existing.planDigest !== plan.planDigest) unavailable();
    const report = claudeCodeTextReviewQualificationReportSchemaV1.parse(reportValue);
    const evidence = report.qualified
      ? createClaudeCodeTextReviewQualificationEvidenceV1(report)
      : createClaudeCodeTextReviewQualificationFailureEvidenceV1(report);
    const settledState = report.qualified ? "passed" as const : "failed" as const;
    const byProof = new Map(existing?.proofs.map(item => [item.proof, item]) ?? []);
    byProof.set("installed_process_identity", { proof: "installed_process_identity", state: settledState,
      evidenceDigest: evidence.evidenceDigest });
    byProof.set("permission_boundary", { proof: "permission_boundary", state: settledState,
      evidenceDigest: evidence.evidenceDigest });
    if (!byProof.has("cancellation_and_restart_recovery")) {
      byProof.set("cancellation_and_restart_recovery",
        { proof: "cancellation_and_restart_recovery", state: "not_started" });
    }
    return createClaudeCodeLocalProcessReadinessV1({ planDigest: plan.planDigest,
      proofs: [...byProof.values()] });
  } catch {
    return unavailable();
  }
}
