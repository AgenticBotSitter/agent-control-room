import { isAbsolute, join, relative, resolve } from "node:path";
import { sha256Digest } from "../../security";

export interface CodexWorkspaceIdentityV1 {
  realPath: string;
  device: string;
  inode: string;
}

export interface CodexWorkspaceCreateEvidenceV1 extends CodexWorkspaceIdentityV1 {
  repositoryRealPath: string;
  headRevision: string;
}

export interface CodexWorkspacePortV1 {
  inspectExisting(path: string): Promise<CodexWorkspaceIdentityV1>;
  inspectOwnerCheckout?(path: string): Promise<CodexWorkspaceIdentityV1>;
  createDetachedWorktree(input: { repositoryRealPath: string; checkoutPath: string; revision: string }): Promise<CodexWorkspaceCreateEvidenceV1>;
  createCodingWorktree?(input: { repositoryRealPath: string; checkoutPath: string; revision: string }): Promise<CodexWorkspaceCreateEvidenceV1>;
  removeWorktree(input: { repositoryRealPath: string; checkoutPath: string }): Promise<void>;
}

export interface CodexWorkspaceRootIdentitiesV1 {
  repository: CodexWorkspaceIdentityV1;
  workspace: CodexWorkspaceIdentityV1;
  commonGit: CodexWorkspaceIdentityV1;
}

export interface CodexWorkspaceLeaseV1 {
  leaseId: string;
  runId: string;
  repositoryRealPath: string;
  checkoutPath: string;
  revision: string;
  device: string;
  inode: string;
}

export class CodexWorkspaceManagerV1 {
  private readonly active = new Map<string, CodexWorkspaceLeaseV1>();
  private readonly coding = new Set<string>();
  private readonly busy = new Set<string>();
  private readonly uncertainCreates = new Set<string>();

  constructor(private readonly port: CodexWorkspacePortV1) {}

  async prepare(input: { runId: string; repositoryRoot: string; workspaceRoot: string; revision: string }): Promise<CodexWorkspaceLeaseV1> {
    input = { ...input };
    if (this.uncertainCreates.has(input.runId)) throw new Error("Codex workspace creation requires reconciliation");
    if (this.busy.has(input.runId)) throw new Error("Codex workspace operation is already pending");
    this.busy.add(input.runId);
    try { return await this.prepareExclusive(input, false); }
    finally { this.busy.delete(input.runId); }
  }

  /** Coding tasks must use a repository source distinct from the owner's live
   * checkout. The canonical identity check happens before any create effect. */
  async prepareCoding(input: { runId: string; repositoryRoot: string; workspaceRoot: string;
    ownerCheckoutRoot: string; revision: string }): Promise<CodexWorkspaceLeaseV1> {
    input = { ...input };
    if (!isAbsolute(input.ownerCheckoutRoot)) throw new Error("Codex owner checkout root must be absolute");
    if (resolve(input.repositoryRoot) === resolve(input.ownerCheckoutRoot))
      throw new Error("Codex owner live checkout cannot be a coding base");
    if (!this.port.inspectOwnerCheckout) throw new Error("Codex owner checkout inspection is unavailable");
    const [repository, owner] = await Promise.all([this.port.inspectExisting(resolve(input.repositoryRoot)),
      this.port.inspectOwnerCheckout(resolve(input.ownerCheckoutRoot))]);
    requireCanonicalRoot(owner, input.ownerCheckoutRoot, "owner checkout");
    if (sameIdentity(repository, owner)) throw new Error("Codex owner live checkout cannot be a coding base");
    if (this.uncertainCreates.has(input.runId)) throw new Error("Codex workspace creation requires reconciliation");
    if (this.busy.has(input.runId)) throw new Error("Codex workspace operation is already pending");
    this.busy.add(input.runId);
    try { return await this.prepareExclusive(input, true); }
    finally { this.busy.delete(input.runId); }
  }

  private async prepareExclusive(input: { runId: string; repositoryRoot: string; workspaceRoot: string; revision: string }, coding: boolean): Promise<CodexWorkspaceLeaseV1> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(input.runId)) throw new Error("Codex workspace run id is invalid");
    if (!/^[a-f0-9]{40}$/.test(input.revision)) throw new Error("Codex workspace revision must be a full Git commit");
    if (!isAbsolute(input.repositoryRoot) || !isAbsolute(input.workspaceRoot)) throw new Error("Codex workspace roots must be absolute");
    if (this.active.has(input.runId)) throw new Error("Codex workspace run is already active");

    const repository = await this.port.inspectExisting(resolve(input.repositoryRoot));
    const workspace = await this.port.inspectExisting(resolve(input.workspaceRoot));
    requireCanonicalRoot(repository, input.repositoryRoot, "repository");
    requireCanonicalRoot(workspace, input.workspaceRoot, "workspace");
    if (overlaps(repository.realPath, workspace.realPath)) throw new Error("Codex repository and workspace roots must be disjoint");

    const checkoutPath = join(workspace.realPath, `codex-${sha256Digest(input.runId).slice(7, 31)}`);
    if (relative(workspace.realPath, checkoutPath).split("/").length !== 1) throw new Error("Codex checkout must be a direct workspace child");
    // Once the effect boundary is crossed, absence cannot be inferred from an error.
    this.uncertainCreates.add(input.runId);
    if (coding && !this.port.createCodingWorktree) throw new Error("Codex coding workspace port is unavailable");
    const create = coding ? this.port.createCodingWorktree!.bind(this.port) : this.port.createDetachedWorktree.bind(this.port);
    const created = await create({ repositoryRealPath: repository.realPath, checkoutPath, revision: input.revision });
    if (created.realPath !== checkoutPath || created.repositoryRealPath !== repository.realPath || created.headRevision !== input.revision) {
      throw new Error("Codex created worktree failed identity verification");
    }
    requireIdentity(created);
    const lease: CodexWorkspaceLeaseV1 = {
      leaseId: sha256Digest({ runId: input.runId, repositoryRealPath: repository.realPath, checkoutPath, revision: input.revision, device: created.device, inode: created.inode }),
      runId: input.runId,
      repositoryRealPath: repository.realPath,
      checkoutPath,
      revision: input.revision,
      device: created.device,
      inode: created.inode,
    };
    this.active.set(input.runId, lease);
    if (coding) this.coding.add(input.runId);
    this.uncertainCreates.delete(input.runId);
    return { ...lease };
  }

  async cleanup(lease: CodexWorkspaceLeaseV1): Promise<void> {
    lease = { ...lease };
    if (this.busy.has(lease.runId)) throw new Error("Codex workspace operation is already pending");
    this.busy.add(lease.runId);
    try { await this.cleanupExclusive(lease); }
    finally { this.busy.delete(lease.runId); }
  }

  /**
   * Returns the manager-owned active lease for a later trusted composition.
   * This is deliberately narrower than the exported structural lease check:
   * a structurally valid lease can be manufactured, but it cannot pass this
   * check unless this manager created it and has not cleaned it up.  Do not
   * expose a workspace manager instance to a worker or browser.
   */
  requireActiveLease(leaseValue: CodexWorkspaceLeaseV1): CodexWorkspaceLeaseV1 {
    const lease = { ...leaseValue };
    assertCodexWorkspaceLeaseV1(lease);
    const active = this.active.get(lease.runId);
    if (!active || !sameLease(active, lease) || this.busy.has(lease.runId)) {
      throw new Error("Codex workspace lease is not active");
    }
    return { ...active };
  }

  requireActiveCodingLease(leaseValue: CodexWorkspaceLeaseV1): CodexWorkspaceLeaseV1 {
    const lease = this.requireActiveLease(leaseValue);
    if (!this.coding.has(lease.runId)) throw new Error("Codex coding workspace lease is not active");
    return lease;
  }

  private async cleanupExclusive(lease: CodexWorkspaceLeaseV1): Promise<void> {
    const active = this.active.get(lease.runId);
    assertCodexWorkspaceLeaseV1(lease);
    if (!active || !sameLease(active, lease)) throw new Error("Codex workspace lease is not active");
    const observed = await this.port.inspectExisting(active.checkoutPath);
    if (observed.realPath !== active.checkoutPath || observed.device !== active.device || observed.inode !== active.inode) {
      throw new Error("Codex workspace identity changed before cleanup");
    }
    await this.port.removeWorktree({ repositoryRealPath: active.repositoryRealPath, checkoutPath: active.checkoutPath });
    this.active.delete(active.runId);
    this.coding.delete(active.runId);
  }
}

export function assertCodexWorkspaceLeaseV1(lease: CodexWorkspaceLeaseV1): void {
  requireIdentity({ realPath: lease.checkoutPath, device: lease.device, inode: lease.inode });
  if (!isAbsolute(lease.repositoryRealPath) || !/^[a-f0-9]{40}$/.test(lease.revision)) throw new Error("Codex workspace lease is invalid");
  const expected = sha256Digest({ runId: lease.runId, repositoryRealPath: lease.repositoryRealPath, checkoutPath: lease.checkoutPath, revision: lease.revision, device: lease.device, inode: lease.inode });
  if (lease.leaseId !== expected) throw new Error("Codex workspace lease digest mismatch");
}

function requireCanonicalRoot(identity: CodexWorkspaceIdentityV1, requested: string, label: string): void {
  requireIdentity(identity);
  if (identity.realPath !== resolve(requested)) throw new Error(`Codex ${label} root must not traverse a symlink`);
}

function requireIdentity(identity: CodexWorkspaceIdentityV1): void {
  if (!isAbsolute(identity.realPath) || !/^[1-9][0-9]*$/.test(identity.device) || !/^[1-9][0-9]*$/.test(identity.inode)) {
    throw new Error("Codex workspace identity is invalid");
  }
}

function overlaps(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const nested = (path: string) => !isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\");
  return nested(leftToRight) || nested(rightToLeft);
}

function sameLease(left: CodexWorkspaceLeaseV1, right: CodexWorkspaceLeaseV1): boolean {
  return left.leaseId === right.leaseId && left.runId === right.runId && left.repositoryRealPath === right.repositoryRealPath
    && left.checkoutPath === right.checkoutPath && left.revision === right.revision && left.device === right.device && left.inode === right.inode;
}

function sameIdentity(left: CodexWorkspaceIdentityV1, right: CodexWorkspaceIdentityV1): boolean {
  return left.realPath === right.realPath && left.device === right.device && left.inode === right.inode;
}
