import { sha256Digest } from "../../security/canonical-digest";
import type { CodexWorkspaceLeaseV1 } from "../codex-v1/workspace";
import type { ObservableGitWorkspacePort } from "../codex-v1/git-workspace-port";
import { verifyWorktreeChangeAuditEvidenceV1, verifyWorktreeChangeAuditPlanV1 } from "./worktree-change-audit";

export type CodingWorkspaceTerminalDispositionV1 = "accepted" | "rejected" | "expired" | "failed" | "cancelled" | "orphaned";

export function createCodingWorkspaceCleanupAuthorizationV1(input: Readonly<{
  lease: CodexWorkspaceLeaseV1;
  plan: unknown;
  evidence: unknown;
  disposition: CodingWorkspaceTerminalDispositionV1;
}>) {
  const plan = verifyWorktreeChangeAuditPlanV1(input.plan);
  const evidence = verifyWorktreeChangeAuditEvidenceV1(plan, input.evidence);
  if (!evidence.git || input.lease.leaseId !== plan.worktreeLeaseDigest || input.lease.revision !== plan.baseRevision
    || input.lease.runId.length < 3) throw new Error("coding_workspace_cleanup_unauthorized");
  const material = { schema: "control-room.coding-workspace-cleanup/v1" as const,
    leaseId: input.lease.leaseId, planDigest: plan.planDigest, evidenceDigest: evidence.evidenceDigest,
    disposition: input.disposition, baseRevision: plan.baseRevision, headRevision: evidence.git.headRevision };
  return Object.freeze({ ...material, cleanupDigest: sha256Digest(material) });
}

/** Idempotent terminal cleanup. The same operation is usable on restart from
 * the durable lease/plan/evidence tuple; it never recreates or resumes work. */
export async function cleanupTerminalCodingWorkspaceV1(input: Readonly<{
  port: ObservableGitWorkspacePort;
  lease: CodexWorkspaceLeaseV1;
  authorization: ReturnType<typeof createCodingWorkspaceCleanupAuthorizationV1>;
}>): Promise<"workspace_cleaned" | "already_absent"> {
  if (!input.port.removeTerminalWorktree || input.authorization.leaseId !== input.lease.leaseId
    || input.authorization.baseRevision !== input.lease.revision) throw new Error("coding_workspace_cleanup_unavailable");
  const observation = await input.port.observeCheckout({ realPath: input.lease.checkoutPath,
    device: input.lease.device, inode: input.lease.inode, repositoryRealPath: input.lease.repositoryRealPath,
    headRevision: input.authorization.headRevision });
  if (observation.state === "absent") {
    if (!input.port.removeTerminalBranch) throw new Error("coding_workspace_cleanup_unavailable");
    await input.port.removeTerminalBranch({ repositoryRealPath: input.lease.repositoryRealPath,
      checkoutPath: input.lease.checkoutPath, headRevision: input.authorization.headRevision,
      cleanupDigest: input.authorization.cleanupDigest });
    return "already_absent";
  }
  if (observation.state === "changed" || observation.state === "unavailable") throw new Error("coding_workspace_reconciliation_required");
  // Changed files are expected after a coding run; the evidence-bound forced
  // removal rechecks identity, branch, base ancestry and exact HEAD.
  await input.port.removeTerminalWorktree({ repositoryRealPath: input.lease.repositoryRealPath,
    checkoutPath: input.lease.checkoutPath, baseRevision: input.authorization.baseRevision,
    headRevision: input.authorization.headRevision, device: input.lease.device, inode: input.lease.inode,
    cleanupDigest: input.authorization.cleanupDigest });
  return "workspace_cleaned";
}
