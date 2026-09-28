import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGitWorkspacePort } from "../src/harness/codex-v1/git-workspace-port";
import { CodexWorkspaceManagerV1 } from "../src/harness/codex-v1/workspace";
import { captureGitWorktreeDiffEvidenceV1, recordWorkspaceWriteRefusalV1 }
  from "../src/harness/codex-v1/git-worktree-diff-evidence";
import { createWorktreeChangeAuditPlanV1, verifyWorktreeChangeAuditEvidenceV1 }
  from "../src/harness/v1/worktree-change-audit";
import { cleanupTerminalCodingWorkspaceV1, createCodingWorkspaceCleanupAuthorizationV1,
  type CodingWorkspaceTerminalDispositionV1 } from "../src/harness/v1/coding-workspace-terminal-cleanup";
import { sha256Digest } from "../src/security";

const execute = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await execute("git", args, { cwd, encoding: "utf8" })).stdout;

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "control-room-coding-worktree-"));
  const repository = join(root, "repository"), workspace = join(root, "workspaces"), owner = join(root, "owner-checkout");
  await mkdir(repository, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 }); await mkdir(owner, { mode: 0o700 });
  await git(repository, ["init", "-q"]); await git(repository, ["config", "user.name", "Control Room Test"]);
  await git(repository, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(repository, "README.md"), "base\n"); await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-qm", "base"]); const base = (await git(repository, ["rev-parse", "HEAD"])).trim();
  const port = await createGitWorkspacePort({ repositoryRoot: repository, workspaceRoot: workspace, runGit: git });
  return { root, repository, workspace, owner, base, port, close: () => rm(root, { recursive: true, force: true }) };
}

const planFor = (lease: Awaited<ReturnType<CodexWorkspaceManagerV1["prepare"]>>) => createWorktreeChangeAuditPlanV1({
  deliveryDigest: sha256Digest(lease.runId), worktreeLeaseDigest: lease.leaseId, baseRevision: lease.revision,
  allowedPaths: ["src/**", "README.md"], maximumChangedFiles: 20, maximumChangedBytes: 2 * 1024 * 1024,
});

async function commitChange(path: string, content: string, subject = "attempt change") {
  await mkdir(join(path, "src"), { recursive: true }); await writeFile(join(path, "src", "change.ts"), content);
  await git(path, ["add", "src/change.ts"]); await git(path, ["commit", "-qm", subject]);
}

test("two attempts receive disjoint named worktrees and the owner's live checkout is refused as a base", async t => {
  const f = await fixture(); t.after(f.close);
  const manager = new CodexWorkspaceManagerV1(f.port);
  const [first, second] = await Promise.all([
    manager.prepareCoding({ ownerCheckoutRoot: f.owner, runId: "run:first-attempt", repositoryRoot: f.repository, workspaceRoot: f.workspace, revision: f.base }),
    manager.prepareCoding({ ownerCheckoutRoot: f.owner, runId: "run:second-attempt", repositoryRoot: f.repository, workspaceRoot: f.workspace, revision: f.base }),
  ]);
  assert.notEqual(first.checkoutPath, second.checkoutPath);
  assert.equal((await git(first.checkoutPath, ["branch", "--show-current"])).trim(), `control-room/${first.checkoutPath.split("/").at(-1)}`);
  assert.equal((await git(second.checkoutPath, ["branch", "--show-current"])).trim(), `control-room/${second.checkoutPath.split("/").at(-1)}`);

  const ownerManager = new CodexWorkspaceManagerV1(f.port);
  await assert.rejects(ownerManager.prepareCoding({ runId: "run:owner-checkout", repositoryRoot: f.repository,
    ownerCheckoutRoot: f.repository, workspaceRoot: f.workspace, revision: f.base }), /live checkout/);
});

test("diff evidence matches Git, binds commits and full bytes, and truncates honestly", async t => {
  const f = await fixture(); t.after(f.close);
  const manager = new CodexWorkspaceManagerV1(f.port);
  const lease = await manager.prepareCoding({ ownerCheckoutRoot: f.owner, runId: "run:evidence", repositoryRoot: f.repository, workspaceRoot: f.workspace, revision: f.base });
  await commitChange(lease.checkoutPath, "export const value = 1;\n");
  const plan = planFor(lease);
  const confinement = recordWorkspaceWriteRefusalV1({ worktreeLeaseDigest: lease.leaseId,
    attemptedPath: join(f.owner, "forbidden.txt"), safeReasonCode: "sandbox_denied" });
  const evidence = await captureGitWorktreeDiffEvidenceV1({ plan, checkoutPath: lease.checkoutPath, confinement });
  assert.equal(evidence.baseRevision, f.base); assert.equal(evidence.git?.headRevision,
    (await git(lease.checkoutPath, ["rev-parse", "HEAD"])).trim());
  assert.deepEqual(evidence.changes.map(change => change.path), ["src/change.ts"]);
  assert.equal(evidence.git?.commits[0]?.subject, "attempt change");
  const actualDiff = await execute("git", ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-renames", f.base, "--"],
    { cwd: lease.checkoutPath, encoding: "buffer" });
  assert.equal(evidence.git?.unifiedDiff.contentDigest,
    `sha256:${createHash("sha256").update(actualDiff.stdout).digest("hex")}`);
  assert.equal(verifyWorktreeChangeAuditEvidenceV1(plan, evidence).evidenceDigest, evidence.evidenceDigest);
  assert.throws(() => verifyWorktreeChangeAuditEvidenceV1(plan, { ...evidence,
    git: { ...evidence.git!, headRevision: "f".repeat(40) } }), /invalid/);

  await writeFile(join(lease.checkoutPath, "README.md"), "uncommitted\n");
  await assert.rejects(captureGitWorktreeDiffEvidenceV1({ plan, checkoutPath: lease.checkoutPath, confinement }),
    /worktree_not_committed/);
  await git(lease.checkoutPath, ["restore", "README.md"]);

  await writeFile(join(lease.checkoutPath, "src", "change.ts"), `${"0123456789abcdef".repeat(800)}\n`);
  await git(lease.checkoutPath, ["add", "src/change.ts"]); await git(lease.checkoutPath, ["commit", "-qm", "large change"]);
  const truncated = await captureGitWorktreeDiffEvidenceV1({ plan, checkoutPath: lease.checkoutPath,
    confinement, maximumDiffBytes: 1024 });
  assert.equal(truncated.git?.unifiedDiff.truncated, true);
  assert.match(truncated.git?.unifiedDiff.text ?? "", /CONTROL ROOM: unified diff truncated/);
  assert.equal(Buffer.byteLength(truncated.git?.unifiedDiff.text ?? ""), truncated.git?.unifiedDiff.retainedBytes);
  assert.ok((truncated.git?.unifiedDiff.originalBytes ?? 0) > (truncated.git?.unifiedDiff.retainedBytes ?? 0));
});

test("terminal cleanup covers accept, reject, expiry and execution terminals, including restart", async t => {
  const dispositions: CodingWorkspaceTerminalDispositionV1[] = ["accepted", "rejected", "expired", "failed", "cancelled", "orphaned"];
  for (const disposition of dispositions) {
    const f = await fixture(); t.after(f.close);
    const manager = new CodexWorkspaceManagerV1(f.port);
    const lease = await manager.prepareCoding({ ownerCheckoutRoot: f.owner, runId: `run:${disposition}`, repositoryRoot: f.repository,
      workspaceRoot: f.workspace, revision: f.base });
    await commitChange(lease.checkoutPath, `export const state = ${JSON.stringify(disposition)};\n`);
    const plan = planFor(lease), confinement = recordWorkspaceWriteRefusalV1({ worktreeLeaseDigest: lease.leaseId,
      attemptedPath: join(f.owner, "refused.txt"), safeReasonCode: "outside_workspace" });
    const evidence = await captureGitWorktreeDiffEvidenceV1({ plan, checkoutPath: lease.checkoutPath, confinement });
    const authorization = createCodingWorkspaceCleanupAuthorizationV1({ lease, plan, evidence, disposition });
    // Recreate the port to prove cleanup does not depend on process-memory ownership.
    const restarted = await createGitWorkspacePort({ repositoryRoot: f.repository, workspaceRoot: f.workspace, runGit: git });
    assert.equal(await cleanupTerminalCodingWorkspaceV1({ port: restarted, lease, authorization }), "workspace_cleaned");
    await assert.rejects(readFile(lease.checkoutPath));
    assert.equal((await git(f.repository, ["branch", "--list", `control-room/${lease.checkoutPath.split("/").at(-1)}`])).trim(), "");
    assert.equal(await cleanupTerminalCodingWorkspaceV1({ port: restarted, lease, authorization }), "already_absent");
  }
});

test("restart finishes cleanup after a crash between worktree and branch removal", async t => {
  const f = await fixture(); t.after(f.close);
  const manager = new CodexWorkspaceManagerV1(f.port);
  const lease = await manager.prepareCoding({ ownerCheckoutRoot: f.owner, runId: "run:cleanup-crash", repositoryRoot: f.repository,
    workspaceRoot: f.workspace, revision: f.base });
  await commitChange(lease.checkoutPath, "export const recovered = true;\n");
  const plan = planFor(lease), confinement = recordWorkspaceWriteRefusalV1({ worktreeLeaseDigest: lease.leaseId,
    attemptedPath: join(f.owner, "refused.txt"), safeReasonCode: "sandbox_denied" });
  const evidence = await captureGitWorktreeDiffEvidenceV1({ plan, checkoutPath: lease.checkoutPath, confinement });
  const authorization = createCodingWorkspaceCleanupAuthorizationV1({ lease, plan, evidence, disposition: "accepted" });
  let interrupted = false;
  const crashingPort = await createGitWorkspacePort({ repositoryRoot: f.repository, workspaceRoot: f.workspace,
    runGit: async (cwd, args) => {
      if (!interrupted && args[0] === "branch" && args[1] === "-D") { interrupted = true; throw new Error("simulated_crash"); }
      return git(cwd, args);
    } });
  await assert.rejects(cleanupTerminalCodingWorkspaceV1({ port: crashingPort, lease, authorization }), /simulated_crash/);
  const restarted = await createGitWorkspacePort({ repositoryRoot: f.repository, workspaceRoot: f.workspace, runGit: git });
  assert.equal(await cleanupTerminalCodingWorkspaceV1({ port: restarted, lease, authorization }), "already_absent");
  assert.equal((await git(f.repository, ["branch", "--list", `control-room/${lease.checkoutPath.split("/").at(-1)}`])).trim(), "");
});

test("outside-worktree refusal evidence is path-redacted and hash-bound", async t => {
  const f = await fixture(); t.after(f.close);
  const attempted = join(f.owner, "must-not-write.txt");
  await chmod(f.owner, 0o500);
  await assert.rejects(writeFile(attempted, "blocked"));
  const refusal = recordWorkspaceWriteRefusalV1({ worktreeLeaseDigest: sha256Digest("lease"), attemptedPath: attempted,
    safeReasonCode: "sandbox_denied" });
  assert.equal(refusal.outsideWorktree, "refused");
  assert.doesNotMatch(JSON.stringify(refusal), /must-not-write|owner-checkout/);
  await chmod(f.owner, 0o700);
});
