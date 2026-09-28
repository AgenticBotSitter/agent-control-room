import { execFile as executeFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { isAbsolute, normalize } from "node:path";
import { sha256Digest } from "../../security/canonical-digest";
import { createWorktreeChangeAuditEvidenceV1, verifyWorktreeChangeAuditPlanV1,
  type WorktreeChangeAuditEvidenceV1 } from "../v1/worktree-change-audit";

const execFile = promisify(executeFile);
const MAX_DIFF_BYTES = 65_536;
const TRUNCATION_PREFIX = "\n[CONTROL ROOM: unified diff truncated";

export type GitEvidenceRunnerV1 = (cwd: string, args: readonly string[], maximumBytes: number) => Promise<Uint8Array>;

export type WorkspaceWriteRefusalV1 = Readonly<{
  kind: "workspace_write";
  outsideWorktree: "refused";
  evidenceDigest: string;
}>;

function safePath(value: string): boolean {
  return isAbsolute(value) && normalize(value) === value && value.length <= 4096
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Records a refusal observed by the installation-owned sandbox boundary. The
 * attempted path itself is deliberately reduced to a digest before persistence. */
export function recordWorkspaceWriteRefusalV1(input: Readonly<{
  worktreeLeaseDigest: string;
  attemptedPath: string;
  safeReasonCode: "sandbox_denied" | "outside_workspace";
}>): WorkspaceWriteRefusalV1 {
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.worktreeLeaseDigest) || !safePath(input.attemptedPath)) {
    throw new Error("workspace_write_refusal_invalid");
  }
  return Object.freeze({ kind: "workspace_write", outsideWorktree: "refused",
    evidenceDigest: sha256Digest({ schema: "control-room.workspace-write-refusal/v1",
      worktreeLeaseDigest: input.worktreeLeaseDigest, attemptedPathDigest: sha256Digest(input.attemptedPath),
      safeReasonCode: input.safeReasonCode }) });
}

/** Bounded, configuration-isolated Git runner. It never enables hooks, filters,
 * pagers, credential prompts or network transports. */
export const runBoundedEvidenceGitV1: GitEvidenceRunnerV1 = async (cwd, args, maximumBytes) => {
  if (!safePath(cwd) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 17 * 1024 * 1024) {
    throw new Error("git_evidence_runner_invalid");
  }
  const fixed = ["-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "filter.lfs.smudge=cat",
    "-c", "filter.lfs.clean=cat", "--no-pager", ...args];
  try {
    const result = await execFile("git", fixed, { cwd, encoding: "buffer", timeout: 30_000,
      maxBuffer: maximumBytes + 1, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C",
        NODE_ENV: "production", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
    const stdout = Buffer.from(result.stdout as Uint8Array);
    if (stdout.byteLength > maximumBytes) throw new Error();
    return Uint8Array.from(stdout);
  } catch { throw new Error("git_evidence_unavailable"); }
};

const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function pairs(bytes: Uint8Array): readonly [string, string][] {
  const values = text(bytes).split("\0");
  if (values.at(-1) === "") values.pop();
  if (values.length % 2 !== 0) throw new Error("git_evidence_unavailable");
  const output: [string, string][] = [];
  for (let index = 0; index < values.length; index += 2) output.push([values[index]!, values[index + 1]!]);
  return output;
}

function boundedDiff(bytes: Uint8Array, maximumBytes: number) {
  const contentDigest = digest(bytes);
  if (bytes.byteLength <= maximumBytes) {
    const value = text(bytes);
    return Object.freeze({ text: value, originalBytes: bytes.byteLength, retainedBytes: bytes.byteLength,
      truncated: false, contentDigest, retainedDigest: contentDigest });
  }
  const marker = `${TRUNCATION_PREFIX}; original ${bytes.byteLength} bytes; ${contentDigest}]\n`;
  const markerBytes = Buffer.from(marker);
  if (markerBytes.byteLength >= maximumBytes) throw new Error("git_evidence_diff_bound_invalid");
  const prefix = Buffer.from(bytes).subarray(0, maximumBytes - markerBytes.byteLength);
  // LF is never part of a multi-byte UTF-8 sequence. Retaining only complete
  // diff lines gives us a valid boundary without decoding user content or
  // confusing a literal U+FFFD with decoder damage at the cut.
  const lastLine = prefix.lastIndexOf(0x0a);
  const retained = lastLine < 0 ? prefix.subarray(0, 0) : prefix.subarray(0, lastLine + 1);
  const stored = Buffer.concat([retained, markerBytes]);
  return Object.freeze({ text: stored.toString("utf8"), originalBytes: bytes.byteLength,
    retainedBytes: stored.byteLength, truncated: true, contentDigest, retainedDigest: digest(stored) });
}

/** Captures one exact Git state after execution. Dirty/staged files and commits
 * are all compared to the recorded base; nothing is read from the owner's checkout. */
export async function captureGitWorktreeDiffEvidenceV1(input: Readonly<{
  plan: unknown;
  checkoutPath: string;
  confinement: WorkspaceWriteRefusalV1;
  maximumDiffBytes?: number;
  runGit?: GitEvidenceRunnerV1;
}>): Promise<WorktreeChangeAuditEvidenceV1> {
  const plan = verifyWorktreeChangeAuditPlanV1(input.plan);
  if (!safePath(input.checkoutPath) || input.confinement.kind !== "workspace_write"
    || input.confinement.outsideWorktree !== "refused" || !/^sha256:[a-f0-9]{64}$/u.test(input.confinement.evidenceDigest)) {
    throw new Error("git_evidence_input_invalid");
  }
  const maximumDiffBytes = input.maximumDiffBytes ?? MAX_DIFF_BYTES;
  if (!Number.isSafeInteger(maximumDiffBytes) || maximumDiffBytes < 1024 || maximumDiffBytes > MAX_DIFF_BYTES) {
    throw new Error("git_evidence_diff_bound_invalid");
  }
  const run = input.runGit ?? runBoundedEvidenceGitV1;
  const headRevision = text(await run(input.checkoutPath, ["rev-parse", "HEAD"], 128)).trim();
  if (!/^[a-f0-9]{40}$/u.test(headRevision)) throw new Error("git_evidence_unavailable");
  const mergeBase = text(await run(input.checkoutPath, ["merge-base", plan.baseRevision, headRevision], 128)).trim();
  if (mergeBase !== plan.baseRevision) throw new Error("git_evidence_base_not_ancestor");
  const status = await run(input.checkoutPath,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"], 1024 * 1024);
  if (status.byteLength !== 0) throw new Error("git_evidence_worktree_not_committed");

  const statuses = pairs(await run(input.checkoutPath,
    ["diff", "--name-status", "-z", "--no-renames", plan.baseRevision, "--"], plan.maximumChangedFiles * 1100 + 1));
  if (statuses.length > plan.maximumChangedFiles) throw new Error("worktree_change_audit_evidence_out_of_scope");
  const changes = [];
  for (const [status, path] of statuses) {
    const kind = status === "A" ? "added" as const : status === "D" ? "deleted" as const
      : status === "M" || status === "T" ? "modified" as const : undefined;
    if (!kind) throw new Error("git_evidence_status_unsupported");
    const patch = await run(input.checkoutPath,
      ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-renames", plan.baseRevision, "--", path],
      plan.maximumChangedBytes + 65_536);
    changes.push({ path, kind, bytes: patch.byteLength, contentDigest: digest(patch) });
  }

  const diff = await run(input.checkoutPath,
    ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-renames", plan.baseRevision, "--"],
    plan.maximumChangedBytes + 65_536);
  const commitPairs = pairs(await run(input.checkoutPath,
    ["log", "-z", "--format=%H%x00%s", `${plan.baseRevision}..${headRevision}`, "--"], 256 * 1024));
  const commitsTruncated = commitPairs.length > 200;
  const commits = commitPairs.slice(0, 200).map(([revision, subject]) => ({ revision, subject }));
  return createWorktreeChangeAuditEvidenceV1(plan, { baseRevision: plan.baseRevision, changes,
    git: { headRevision, commits, commitsTruncated, unifiedDiff: boundedDiff(diff, maximumDiffBytes),
      confinement: input.confinement } });
}
