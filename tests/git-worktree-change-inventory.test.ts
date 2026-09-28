import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CodexWorkspaceManagerV1 } from "../src/harness/codex-v1/workspace";
import { createGitWorkspacePort } from "../src/harness/codex-v1/git-workspace-port";
import { inventoryManagedGitWorktreeChangesV1 } from "../src/harness/codex-v1/git-worktree-change-inventory";
import { createWorktreeChangeAuditPlanV1 } from "../src/harness/v1/worktree-change-audit";
import { sha256Digest } from "../src/security/canonical-digest";

const run = promisify(execFile);
const deliveryDigest = sha256Digest("delivery:git-inventory");
const canonicalTmp = tmpdir().startsWith("/var/") ? `/private${tmpdir()}` : tmpdir();

test("real Git inventory audits committed objects and never follows a worktree symlink", async t => {
  const root = await mkdtemp(join(canonicalTmp, "acr-s6-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository"), workspaces = join(root, "workspaces");
  await mkdir(repository); await mkdir(workspaces);
  const git = async (cwd: string, args: readonly string[]) => Buffer.from((await run("git",
    ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...args],
    { cwd, encoding: "buffer", env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, maxBuffer: 1024 * 1024 })).stdout);
  await git(repository, ["init", "--quiet"]);
  await git(repository, ["config", "user.name", "Fixture"]); await git(repository, ["config", "user.email", "fixture@example.invalid"]);
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src", "kept.txt"), "base\n");
  await writeFile(join(repository, "src", "deleted.txt"), "remove-me\n");
  await git(repository, ["add", "--", "src/kept.txt", "src/deleted.txt"]); await git(repository, ["commit", "--quiet", "-m", "base"]);
  const revision = Buffer.from(await git(repository, ["rev-parse", "HEAD"])).toString("utf8").trim();
  const port = await createGitWorkspacePort({ repositoryRoot: repository, workspaceRoot: workspaces,
    runGit: async (cwd, args) => Buffer.from(await git(cwd, args)).toString("utf8") });
  const manager = new CodexWorkspaceManagerV1(port);
  const lease = await manager.prepare({ deliveryDigest, runId: "run:git-inventory", repositoryRoot: repository,
    workspaceRoot: workspaces, revision });
  await writeFile(join(lease.checkoutPath, "src", "kept.txt"), "changed\n");
  await rm(join(lease.checkoutPath, "src", "deleted.txt"));
  await writeFile(join(lease.checkoutPath, "src", "untracked.txt"), "new\n");
  await writeFile(join(root, "outside-secret.txt"), "not-publication-evidence\n");
  const linkTarget = "../../../outside-secret.txt";
  await symlink(linkTarget, join(lease.checkoutPath, "src", "link.txt"));
  await git(lease.checkoutPath, ["add", "-A", "--", "src"]); await git(lease.checkoutPath, ["commit", "--quiet", "-m", "change"]);
  const plan = createWorktreeChangeAuditPlanV1({ deliveryDigest, worktreeLeaseDigest: lease.leaseId,
    baseRevision: revision, allowedPaths: ["src/**"], maximumChangedFiles: 4, maximumChangedBytes: 128 });
  const evidence = await inventoryManagedGitWorktreeChangesV1({ workspaceManager: manager, workspacePort: port,
    lease, auditPlan: plan, runGit: git });
  assert.deepEqual(evidence.changes.map(change => [change.path, change.kind, change.bytes]), [
    ["src/deleted.txt", "deleted", 10], ["src/kept.txt", "modified", 8],
    ["src/link.txt", "added", Buffer.byteLength(linkTarget)], ["src/untracked.txt", "added", 4],
  ]);
  assert.ok(evidence.changes.every(change => /^sha256:[a-f0-9]{64}$/.test(change.contentDigest)));
  const retained = await port.observeCheckout({ realPath: lease.checkoutPath, repositoryRealPath: repository,
    headRevision: revision, device: lease.device, inode: lease.inode });
  assert.equal(retained.state, "preserve");
  await assert.rejects(inventoryManagedGitWorktreeChangesV1({ workspaceManager: manager, workspacePort: port, lease,
    auditPlan: plan, runGit: async () => { throw new Error("git_read_failed"); } }),
  /worktree_change_inventory_unavailable/);
  let rootReads = 0;
  const replacedPort = { ...port,
    async inspectRootIdentities() { const roots = await port.inspectRootIdentities(); rootReads++;
      return rootReads === 1 ? roots : { ...roots, commonGit: { ...roots.commonGit, inode: `${Number(roots.commonGit.inode) + 1}` } }; },
  };
  await assert.rejects(inventoryManagedGitWorktreeChangesV1({ workspaceManager: manager,
    workspacePort: replacedPort, lease, auditPlan: plan, runGit: git }), /worktree_change_inventory_unavailable/,
  "common Git replacement during collection is unavailable");
});

test("real Git inventory sends scope and byte excess through the existing refusal", async t => {
  const root = await mkdtemp(join(canonicalTmp, "acr-s6-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository"), workspaces = join(root, "workspaces");
  await mkdir(repository); await mkdir(workspaces);
  const git = async (cwd: string, args: readonly string[]) => Buffer.from((await run("git",
    ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...args],
    { cwd, encoding: "buffer", env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" } })).stdout);
  await git(repository, ["init", "--quiet"]); await git(repository, ["config", "user.name", "Fixture"]);
  await git(repository, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repository, "README.md"), "base\n"); await git(repository, ["add", "--", "README.md"]);
  await git(repository, ["commit", "--quiet", "-m", "base"]);
  const revision = Buffer.from(await git(repository, ["rev-parse", "HEAD"])).toString("utf8").trim();
  const port = await createGitWorkspacePort({ repositoryRoot: repository, workspaceRoot: workspaces,
    runGit: async (cwd, args) => Buffer.from(await git(cwd, args)).toString("utf8") });
  const manager = new CodexWorkspaceManagerV1(port);
  const lease = await manager.prepare({ deliveryDigest, runId: "run:scope-refusal", repositoryRoot: repository,
    workspaceRoot: workspaces, revision });
  await writeFile(join(lease.checkoutPath, "README.md"), "outside scope\n");
  await git(lease.checkoutPath, ["add", "--", "README.md"]); await git(lease.checkoutPath, ["commit", "--quiet", "-m", "outside"]);
  const plan = createWorktreeChangeAuditPlanV1({ deliveryDigest, worktreeLeaseDigest: lease.leaseId,
    baseRevision: revision, allowedPaths: ["src/**"], maximumChangedFiles: 1, maximumChangedBytes: 1 });
  await assert.rejects(inventoryManagedGitWorktreeChangesV1({ workspaceManager: manager, workspacePort: port, lease,
    auditPlan: plan, runGit: git }), /worktree_change_audit_evidence_out_of_scope/);
});
