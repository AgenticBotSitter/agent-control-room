import type { CodexWorkspaceLeaseV1, CodexWorkspaceManagerV1 } from "../codex-v1/workspace";
import { createControllerDeliveryWorktreeChangeAuditPlanV1, type WorktreeChangeAuditPlanV1 } from "./worktree-change-audit";

/**
 * A process-private capability held by the trusted local workspace/controller
 * composition. It fixes the permitted paths and size limits once; a worker
 * supplies neither those limits nor a self-claimed workspace lease.
 *
 * This derives evidence metadata only. It does not create a worktree, run
 * Git, start an agent, save a database row, or grant execution authority.
 */
export interface ManagedWorktreeChangeAuditAuthorityV1 {
  derive(input: Readonly<{ delivery: unknown; lease: CodexWorkspaceLeaseV1 }>): WorktreeChangeAuditPlanV1;
}

export function createManagedWorktreeChangeAuditAuthorityV1(input: Readonly<{
  workspaceManager: CodexWorkspaceManagerV1;
  allowedPaths: readonly string[];
  maximumChangedFiles: number;
  maximumChangedBytes: number;
}>): ManagedWorktreeChangeAuditAuthorityV1 {
  if (!input.workspaceManager || typeof input.workspaceManager.requireActiveLease !== "function") {
    throw new Error("worktree_change_audit_authority_unavailable");
  }
  const workspaceManager = input.workspaceManager;
  const policy = Object.freeze({
    allowedPaths: Object.freeze([...input.allowedPaths]),
    maximumChangedFiles: input.maximumChangedFiles,
    maximumChangedBytes: input.maximumChangedBytes,
  });
  return Object.freeze({
    derive(value: Readonly<{ delivery: unknown; lease: CodexWorkspaceLeaseV1 }>) {
      const lease = workspaceManager.requireActiveLease(value.lease);
      // The preceding line means a caller cannot substitute a self-computed
      // lease. Reuse the existing shared plan validator for all remaining
      // delivery/run/revision/scope checks.
      return createControllerDeliveryWorktreeChangeAuditPlanV1({ delivery: value.delivery, lease, ...policy });
    },
  });
}
