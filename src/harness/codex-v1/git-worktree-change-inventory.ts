import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { CodexWorkspaceLeaseV1 } from "./workspace";
import { CodexWorkspaceManagerV1 } from "./workspace";
import type { ObservableGitWorkspacePort } from "./git-workspace-port";
import { createWorktreeChangeAuditEvidenceV1, verifyWorktreeChangeAuditPlanV1,
  type WorktreeChangeAuditEvidenceV1 } from "../v1/worktree-change-audit";

/** The host supplies a no-network, configuration-isolated Git process. */
export type WorktreeInventoryGitRunnerV1 = (cwd: string, args: readonly string[]) => Promise<Uint8Array>;

function unavailable(): never {
  throw new Error("worktree_change_inventory_unavailable");
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith("/") && !path.includes("\\")
    && !path.includes("\0") && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function nulFields(bytes: Uint8Array): string[] {
  const value = Buffer.from(bytes).toString("utf8");
  if (value && !value.endsWith("\0")) unavailable();
  return value.split("\0").filter(Boolean);
}

function rawDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function inScope(path: string, scopes: readonly string[]): boolean {
  return scopes.some(scope => scope.endsWith("/**")
    ? path.startsWith(`${scope.slice(0, -3)}/`) : path === scope);
}

function outOfScope(): never { throw new Error("worktree_change_audit_evidence_out_of_scope"); }

/**
 * Builds the existing bounded audit evidence from Git's real name inventory
 * and the exact bytes currently in the manager-owned checkout. It grants no
 * workspace, process, publication, cleanup, or retry authority.
 */
export async function inventoryManagedGitWorktreeChangesV1(input: Readonly<{
  workspaceManager: CodexWorkspaceManagerV1;
  workspacePort: ObservableGitWorkspacePort;
  lease: CodexWorkspaceLeaseV1;
  auditPlan: unknown;
  runGit: WorktreeInventoryGitRunnerV1;
}>): Promise<WorktreeChangeAuditEvidenceV1> {
  if (typeof input.runGit !== "function") unavailable();
  const lease = input.workspaceManager.requireActiveLease(input.lease);
  const plan = verifyWorktreeChangeAuditPlanV1(input.auditPlan);
  if (plan.deliveryDigest !== lease.deliveryDigest || plan.worktreeLeaseDigest !== lease.leaseId
    || plan.baseRevision !== lease.revision || !isAbsolute(lease.checkoutPath)) unavailable();

  try {
    const beforeRoots = await input.workspacePort.inspectRootIdentities();
    const beforeCheckout = await input.workspacePort.inspectExisting(lease.checkoutPath);
    if (beforeRoots.repository.realPath !== lease.repositoryRealPath
      || beforeRoots.repository.device !== lease.repositoryDevice
      || beforeRoots.repository.inode !== lease.repositoryInode
      || beforeCheckout.realPath !== lease.checkoutPath || beforeCheckout.device !== lease.device
      || beforeCheckout.inode !== lease.inode) unavailable();
    const head = Buffer.from(await input.runGit(lease.checkoutPath,
      ["--no-optional-locks", "rev-parse", "HEAD"])).toString("utf8").trim();
    if (!/^[a-f0-9]{40}$/.test(head) || head === lease.revision) unavailable();
    const status = Buffer.from(await input.runGit(lease.checkoutPath,
      ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignored=matching"])).toString("utf8");
    if (status.trim()) unavailable();
    const fields = nulFields(await input.runGit(lease.checkoutPath,
      ["--no-optional-locks", "diff", "--name-status", "-z", "--no-renames", lease.revision, head, "--"]));
    if (fields.length % 2 !== 0) unavailable();
    const kinds = new Map<string, "added" | "modified" | "deleted">();
    for (let index = 0; index < fields.length; index += 2) {
      const status = fields[index], path = fields[index + 1];
      if (!safeRelativePath(path) || !/^[AMDT]$/.test(status)) unavailable();
      kinds.set(path, status === "A" ? "added" : status === "D" ? "deleted" : "modified");
    }
    if (kinds.size > plan.maximumChangedFiles
      || [...kinds.keys()].some(path => !inScope(path, plan.allowedPaths))) outOfScope();

    const changes = [];
    let totalBytes = 0;
    for (const [path, kind] of [...kinds].sort(([left], [right]) => left.localeCompare(right))) {
      let bytes: Uint8Array;
      const tree = kind === "deleted" ? lease.revision : head;
      {
        const object = Buffer.from(await input.runGit(lease.checkoutPath,
          ["--no-optional-locks", "rev-parse", "--verify", `${tree}:${path}`])).toString("utf8").trim();
        if (!/^[a-f0-9]{40,64}$/.test(object)) unavailable();
        const sizeText = Buffer.from(await input.runGit(lease.checkoutPath,
          ["--no-optional-locks", "cat-file", "-s", object])).toString("utf8").trim();
        const size = Number(sizeText);
        if (!Number.isSafeInteger(size) || size < 0 || totalBytes + size > plan.maximumChangedBytes) outOfScope();
        bytes = await input.runGit(lease.checkoutPath, ["--no-optional-locks", "cat-file", "blob", object]);
        if (bytes.byteLength !== size) unavailable();
      }
      totalBytes += bytes.byteLength;
      changes.push({ path, kind, bytes: bytes.byteLength, contentDigest: rawDigest(bytes) });
    }
    const afterHead = Buffer.from(await input.runGit(lease.checkoutPath,
      ["--no-optional-locks", "rev-parse", "HEAD"])).toString("utf8").trim();
    const afterStatus = Buffer.from(await input.runGit(lease.checkoutPath,
      ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignored=matching"])).toString("utf8");
    const afterRoots = await input.workspacePort.inspectRootIdentities();
    const afterCheckout = await input.workspacePort.inspectExisting(lease.checkoutPath);
    if (afterHead !== head || afterStatus.trim() || canonicalRootIdentity(afterRoots) !== canonicalRootIdentity(beforeRoots)
      || afterCheckout.realPath !== beforeCheckout.realPath || afterCheckout.device !== beforeCheckout.device
      || afterCheckout.inode !== beforeCheckout.inode) unavailable();
    return createWorktreeChangeAuditEvidenceV1(plan, { baseRevision: lease.revision, headRevision: head, changes });
  } catch (error) {
    if (error instanceof Error && error.message === "worktree_change_audit_evidence_out_of_scope") throw error;
    unavailable();
  }
}

function canonicalRootIdentity(value: Awaited<ReturnType<ObservableGitWorkspacePort["inspectRootIdentities"]>>): string {
  return JSON.stringify([value.repository.realPath, value.repository.device, value.repository.inode,
    value.workspace.realPath, value.workspace.device, value.workspace.inode,
    value.commonGit.realPath, value.commonGit.device, value.commonGit.inode]);
}
