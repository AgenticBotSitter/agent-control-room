import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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

const syntheticBase = "a".repeat(40), syntheticHead = "b".repeat(40);
async function captureSyntheticDiff(diff: Uint8Array, maximumDiffBytes = 65_536) {
  const worktreeLeaseDigest = sha256Digest("synthetic worktree lease");
  const plan = createWorktreeChangeAuditPlanV1({ deliveryDigest: sha256Digest("synthetic delivery"),
    worktreeLeaseDigest, baseRevision: syntheticBase, allowedPaths: ["src/**"],
    maximumChangedFiles: 1, maximumChangedBytes: 512 * 1024 });
  const confinement = recordWorkspaceWriteRefusalV1({ worktreeLeaseDigest,
    attemptedPath: "/fixture/owner/refused.txt", safeReasonCode: "sandbox_denied" });
  return captureGitWorktreeDiffEvidenceV1({ plan, checkoutPath: "/fixture/worktree", confinement,
    maximumDiffBytes, runGit: async (_cwd, args) => {
      if (args[0] === "rev-parse") return Buffer.from(`${syntheticHead}\n`);
      if (args[0] === "merge-base") return Buffer.from(`${syntheticBase}\n`);
      if (args[0] === "status") return Buffer.alloc(0);
      if (args[0] === "diff" && args[1] === "--name-status") return Buffer.from("A\0src/large.ts\0");
      if (args[0] === "diff") return diff;
      if (args[0] === "log") return Buffer.from(`${syntheticHead}\0large one-line diff\0`);
      throw new Error(`unexpected synthetic Git command: ${args[0] ?? "missing"}`);
    } });
}

function oneHunkDiff(line: Uint8Array) {
  return Buffer.concat([Buffer.from("diff --git a/src/large.ts b/src/large.ts\nnew file mode 100644\n"
    + `index ${"0".repeat(40)}..${"1".repeat(40)}\n--- /dev/null\n+++ b/src/large.ts\n@@ -0,0 +1 @@\n+`),
  line, Buffer.from("\n")]);
}

async function terminalCleanupCase(runId: string) {
  const f = await fixture();
  const manager = new CodexWorkspaceManagerV1(f.port);
  const lease = await manager.prepareCoding({ ownerCheckoutRoot: f.owner, runId,
    repositoryRoot: f.repository, workspaceRoot: f.workspace, revision: f.base });
  await commitChange(lease.checkoutPath, "export const reviewed = true;\n", "reviewed head");
  const plan = planFor(lease), confinement = recordWorkspaceWriteRefusalV1({ worktreeLeaseDigest: lease.leaseId,
    attemptedPath: join(f.owner, "refused.txt"), safeReasonCode: "sandbox_denied" });
  const evidence = await captureGitWorktreeDiffEvidenceV1({ plan, checkoutPath: lease.checkoutPath, confinement });
  const authorization = createCodingWorkspaceCleanupAuthorizationV1({ lease, plan, evidence, disposition: "accepted" });
  const restarted = await createGitWorkspacePort({ repositoryRoot: f.repository,
    workspaceRoot: f.workspace, runGit: git });
  return { ...f, lease, authorization, restarted };
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

test("owner checkout identity alias is refused before a coding worktree is created", async () => {
  const repository = "/fixture/repository", owner = "/fixture/owner-alias", workspace = "/fixture/workspaces";
  let creates = 0;
  const manager = new CodexWorkspaceManagerV1({
    inspectExisting: async path => path === repository
      ? { realPath: repository, device: "7", inode: "11" }
      : { realPath: workspace, device: "7", inode: "12" },
    inspectOwnerCheckout: async () => ({ realPath: owner, device: "7", inode: "11" }),
    createDetachedWorktree: async () => { throw new Error("must_not_create"); },
    createCodingWorktree: async () => { creates += 1; throw new Error("must_not_create"); },
    removeWorktree: async () => { throw new Error("must_not_remove"); },
  });
  await assert.rejects(manager.prepareCoding({ runId: "run:owner-alias", repositoryRoot: repository,
    ownerCheckoutRoot: owner, workspaceRoot: workspace, revision: "a".repeat(40) }), /live checkout/);
  assert.equal(creates, 0);
});

test("owner checkout inspection rechecks pinned repository roots", async t => {
  const f = await fixture(); t.after(f.close);
  const moved = `${f.workspace}-moved`;
  await rename(f.workspace, moved);
  await mkdir(f.workspace, { mode: 0o700 });
  await assert.rejects(f.port.inspectOwnerCheckout!(f.owner), /workspace_root_identity_changed/);
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

test("diff truncation preserves literal U+FFFD and complete multi-byte lines near the cut", async t => {
  const f = await fixture(); t.after(f.close);
  const manager = new CodexWorkspaceManagerV1(f.port);
  const lease = await manager.prepareCoding({ ownerCheckoutRoot: f.owner, runId: "run:utf8-evidence",
    repositoryRoot: f.repository, workspaceRoot: f.workspace, revision: f.base });
  const lines = ["export const literal = \"\uFFFD\";", "export const afterLiteral = \"still here\";",
    ...Array.from({ length: 600 }, (_, index) => `export const row${index} = \"snow 雪 and smile 🙂\";`)];
  await commitChange(lease.checkoutPath, `${lines.join("\n")}\n`, "utf8 evidence");
  const plan = planFor(lease), confinement = recordWorkspaceWriteRefusalV1({ worktreeLeaseDigest: lease.leaseId,
    attemptedPath: join(f.owner, "refused.txt"), safeReasonCode: "sandbox_denied" });
  const actualDiff = Buffer.from((await execute("git",
    ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-renames", f.base, "--"],
    { cwd: lease.checkoutPath, encoding: "buffer" })).stdout);
  const contentDigest = `sha256:${createHash("sha256").update(actualDiff).digest("hex")}`;
  const markerBytes = Buffer.byteLength(`\n[CONTROL ROOM: unified diff truncated; original ${actualDiff.byteLength} bytes; ${contentDigest}]\n`);
  let maximumDiffBytes = 1024;
  while (maximumDiffBytes < Math.min(actualDiff.byteLength, 65_536)
    && (actualDiff[maximumDiffBytes - markerBytes]! & 0xc0) !== 0x80) maximumDiffBytes += 1;
  assert.ok(maximumDiffBytes < Math.min(actualDiff.byteLength, 65_536), "raw cut lands inside a multi-byte character");
  const evidence = await captureGitWorktreeDiffEvidenceV1({ plan, checkoutPath: lease.checkoutPath,
    confinement, maximumDiffBytes });
  const stored = evidence.git!.unifiedDiff;
  assert.equal(stored.truncated, true);
  assert.match(stored.text, /literal = "\uFFFD"/u);
  assert.match(stored.text, /afterLiteral = "still here"/u);
  assert.match(stored.text, /snow 雪 and smile 🙂/u);
  assert.equal([...stored.text.matchAll(/\uFFFD/gu)].length, 1);
  assert.ok(stored.retainedBytes <= maximumDiffBytes);
});

test("diff truncation retains a near-budget body for one 300,000-byte added line", async () => {
  const maximumDiffBytes = 65_536;
  const evidence = await captureSyntheticDiff(oneHunkDiff(Buffer.alloc(300_000, 0x78)), maximumDiffBytes);
  const stored = evidence.git!.unifiedDiff;
  assert.equal(stored.truncated, true);
  assert.ok(stored.originalBytes > 300_000);
  assert.ok(stored.retainedBytes >= maximumDiffBytes - 3);
  assert.ok(stored.retainedBytes <= maximumDiffBytes);
  assert.doesNotMatch(stored.text, /\uFFFD/u);
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(stored.text)));
});

test("diff truncation backs up before a four-byte emoji straddling the budget cut", async () => {
  const maximumDiffBytes = 65_536;
  const ascii = oneHunkDiff(Buffer.alloc(300_000, 0x78));
  const contentDigest = `sha256:${createHash("sha256").update(ascii).digest("hex")}`;
  const markerBytes = Buffer.byteLength(`\n[CONTROL ROOM: unified diff truncated; original ${ascii.byteLength} bytes; ${contentDigest}]\n`);
  const rawCut = maximumDiffBytes - markerBytes;
  const diff = Buffer.from(ascii), emoji = Buffer.from("🙂");
  emoji.copy(diff, rawCut - 2);
  const evidence = await captureSyntheticDiff(diff, maximumDiffBytes);
  const stored = evidence.git!.unifiedDiff;
  assert.equal(stored.truncated, true);
  assert.equal(stored.retainedBytes, maximumDiffBytes - 2);
  assert.doesNotMatch(stored.text, /\uFFFD/u);
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(stored.text)));
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

for (const scenario of [
  { name: "an uncommitted edit", content: "export const reviewed = false;\n", path: (checkout: string) => join(checkout, "src", "change.ts"),
    mutate: async (checkout: string, path: string, content: string) => writeFile(path, content) },
  { name: "a staged change", content: "export const staged = true;\n", path: (checkout: string) => join(checkout, "src", "change.ts"),
    mutate: async (checkout: string, path: string, content: string) => { await writeFile(path, content); await git(checkout, ["add", "src/change.ts"]); } },
  { name: "an untracked file", content: "keep this untracked file\n", path: (checkout: string) => join(checkout, "untracked.txt"),
    mutate: async (_checkout: string, path: string, content: string) => writeFile(path, content) },
] as const) {
  test(`terminal cleanup preserves ${scenario.name} and its file`, async t => {
    const x = await terminalCleanupCase(`run:preserve-${scenario.name.replaceAll(" ", "-")}`); t.after(x.close);
    const path = scenario.path(x.lease.checkoutPath);
    await scenario.mutate(x.lease.checkoutPath, path, scenario.content);
    assert.notEqual((await git(x.lease.checkoutPath, ["status", "--short"])).trim(), "");
    assert.equal(await cleanupTerminalCodingWorkspaceV1({ port: x.restarted, lease: x.lease,
      authorization: x.authorization }), "workspace_preserved");
    assert.equal(await readFile(path, "utf8"), scenario.content);
    assert.notEqual((await git(x.repository,
      ["branch", "--list", `control-room/${x.lease.checkoutPath.split("/").at(-1)}`])).trim(), "");
  });
}

test("terminal cleanup removes a clean evidence-bound worktree", async t => {
  const x = await terminalCleanupCase("run:clean-terminal"); t.after(x.close);
  assert.equal(await cleanupTerminalCodingWorkspaceV1({ port: x.restarted, lease: x.lease,
    authorization: x.authorization }), "workspace_cleaned");
  await assert.rejects(readFile(x.lease.checkoutPath));
});

test("terminal removal preserves an untracked file written after observation", async t => {
  const x = await terminalCleanupCase("run:late-terminal-write"); t.after(x.close);
  assert.deepEqual(await x.restarted.observeCheckout({ realPath: x.lease.checkoutPath,
    device: x.lease.device, inode: x.lease.inode, repositoryRealPath: x.lease.repositoryRealPath,
    headRevision: x.authorization.headRevision }), { state: "unchanged" });
  const path = join(x.lease.checkoutPath, "late-untracked.txt");
  await writeFile(path, "written after the clean observation\n");
  await assert.rejects(x.restarted.removeTerminalWorktree!({ repositoryRealPath: x.lease.repositoryRealPath,
    checkoutPath: x.lease.checkoutPath, baseRevision: x.authorization.baseRevision,
    headRevision: x.authorization.headRevision, device: x.lease.device, inode: x.lease.inode,
    cleanupDigest: x.authorization.cleanupDigest }), /workspace_terminal_uncommitted_changes/);
  assert.equal(await readFile(path, "utf8"), "written after the clean observation\n");
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

test("terminal cleanup preserves a worktree whose HEAD changed after evidence capture", async t => {
  const f = await fixture(); t.after(f.close);
  const manager = new CodexWorkspaceManagerV1(f.port);
  const lease = await manager.prepareCoding({ ownerCheckoutRoot: f.owner, runId: "run:changed-terminal-head",
    repositoryRoot: f.repository, workspaceRoot: f.workspace, revision: f.base });
  await commitChange(lease.checkoutPath, "export const reviewed = true;\n", "reviewed head");
  const plan = planFor(lease), confinement = recordWorkspaceWriteRefusalV1({ worktreeLeaseDigest: lease.leaseId,
    attemptedPath: join(f.owner, "refused.txt"), safeReasonCode: "sandbox_denied" });
  const evidence = await captureGitWorktreeDiffEvidenceV1({ plan, checkoutPath: lease.checkoutPath, confinement });
  const authorization = createCodingWorkspaceCleanupAuthorizationV1({ lease, plan, evidence, disposition: "accepted" });
  await commitChange(lease.checkoutPath, "export const reviewed = false;\n", "unreviewed head");
  const changedHead = (await git(lease.checkoutPath, ["rev-parse", "HEAD"])).trim();
  const restarted = await createGitWorkspacePort({ repositoryRoot: f.repository, workspaceRoot: f.workspace, runGit: git });
  assert.equal(await cleanupTerminalCodingWorkspaceV1({ port: restarted, lease, authorization }), "workspace_preserved");
  assert.equal((await git(lease.checkoutPath, ["rev-parse", "HEAD"])).trim(), changedHead);
  assert.equal((await git(f.repository,
    ["branch", "--format=%(objectname)", "--list", `control-room/${lease.checkoutPath.split("/").at(-1)}`])).trim(), changedHead);
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
