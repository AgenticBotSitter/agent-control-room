import { execFile as execFileCallback } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { IntegrationRepositoryObserverV1, IntegrationRepositorySnapshotV1 } from "./publisher";

const execFile = promisify(execFileCallback), revision = /^[a-f0-9]{40}$/u;
const branch = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,179}$/u;
const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[\x21-\x7e]{1,512}$/u;

export type LocalIntegrationRepositoryConfigurationV1 = Readonly<{
  repositoryPath: string;
  managedBranch: string;
  expectedRemoteName: string;
  expectedRemoteUrl: string;
  lastAcceptedRevision: string;
  /** Installation-private durable binding written by the lead integration step. */
  candidateRevisionForRun(pipelineRunId: string): Promise<string>;
}>;

type Git = (args: readonly string[]) => Promise<string>;

async function runGit(cwd: string, args: readonly string[]) {
  try {
    const result = await execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
      "--no-optional-locks", ...args], { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      env: { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
    return result.stdout;
  } catch { throw new Error("update_candidate_repository_unavailable"); }
}

/** Captures the installation-private repository identity without exposing its path in returned evidence. */
export async function createLocalIntegrationRepositoryObserverV1(value: LocalIntegrationRepositoryConfigurationV1,
  runtime: Readonly<{ canonical?: typeof realpath; identity?: typeof stat; git?: Git }> = {}): Promise<IntegrationRepositoryObserverV1> {
  if (!value || typeof value.repositoryPath !== "string" || !isAbsolute(value.repositoryPath)
    || !branch.test(value.managedBranch) || !branch.test(value.expectedRemoteName)
    || !revision.test(value.lastAcceptedRevision) || typeof value.expectedRemoteUrl !== "string"
    || value.expectedRemoteUrl.length < 1 || value.expectedRemoteUrl.length > 2048 || /[\r\n\0]/u.test(value.expectedRemoteUrl)
    || typeof value.candidateRevisionForRun !== "function")
    throw new Error("update_candidate_repository_configuration_invalid");
  const canonical = runtime.canonical ?? realpath, identity = runtime.identity ?? stat;
  const root = await canonical(value.repositoryPath).catch(() => { throw new Error("update_candidate_repository_configuration_invalid"); });
  if (root !== resolve(value.repositoryPath)) throw new Error("update_candidate_repository_configuration_invalid");
  const initial = await identity(root), git: Git = runtime.git ?? (args => runGit(root, args));
  if (!initial.isDirectory()) throw new Error("update_candidate_repository_configuration_invalid");
  const inspectIdentity = async () => {
    const currentRoot = await canonical(value.repositoryPath), current = await identity(currentRoot);
    if (currentRoot !== root || current.dev !== initial.dev || current.ino !== initial.ino || !current.isDirectory())
      throw new Error("update_candidate_repository_unavailable");
  };
  const fixed = Object.freeze({ managedBranch: value.managedBranch, expectedRemoteName: value.expectedRemoteName,
    expectedRemoteUrl: value.expectedRemoteUrl, lastAcceptedRevision: value.lastAcceptedRevision,
    candidateRevisionForRun: value.candidateRevisionForRun.bind(value) });
  const observe = async (input: Readonly<{ pipelineRunId: string }>): Promise<IntegrationRepositorySnapshotV1> => {
    if (!input || typeof input.pipelineRunId !== "string") throw new Error("update_candidate_repository_unavailable");
    const expectedRevision = await fixed.candidateRevisionForRun(input.pipelineRunId)
      .catch(() => { throw new Error("update_candidate_repository_unavailable"); });
    if (!revision.test(expectedRevision) || expectedRevision === fixed.lastAcceptedRevision)
      throw new Error("update_candidate_repository_unavailable");
    await inspectIdentity();
    const [top, currentBranch, status, head, remote] = await Promise.all([
      git(["rev-parse", "--show-toplevel"]), git(["branch", "--show-current"]),
      git(["status", "--porcelain=v1", "--untracked-files=all"]), git(["rev-parse", "HEAD"]),
      git(["remote", "get-url", fixed.expectedRemoteName]),
    ]);
    if (await canonical(top.trim()) !== root || currentBranch.trim() !== fixed.managedBranch || status.trim()
      || remote.trim() !== fixed.expectedRemoteUrl || head.trim() !== expectedRevision)
      throw new Error("update_candidate_repository_unavailable");
    const candidateRevision = head.trim();
    const mergeBase = (await git(["merge-base", fixed.lastAcceptedRevision, candidateRevision])).trim();
    if (mergeBase !== fixed.lastAcceptedRevision) throw new Error("update_candidate_repository_unavailable");
    const [pathsRaw, addedRaw, subjectsRaw] = await Promise.all([
      git(["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", `${fixed.lastAcceptedRevision}..${candidateRevision}`, "--"]),
      git(["diff", "--name-only", "-z", "--diff-filter=A", `${fixed.lastAcceptedRevision}..${candidateRevision}`, "--"]),
      git(["log", "--format=%s", `${fixed.lastAcceptedRevision}..${candidateRevision}`, "--"]),
    ]);
    const changedPaths = pathsRaw.split("\0").filter(Boolean);
    const addedPaths = addedRaw.split("\0").filter(Boolean);
    if (!changedPaths.length || changedPaths.length > 1000 || changedPaths.some(path => !safePath.test(path))
      || new Set(changedPaths).size !== changedPaths.length || addedPaths.some(path => !safePath.test(path) || !changedPaths.includes(path))
      || new Set(addedPaths).size !== addedPaths.length
      || changedPaths.some(path => /^db\/migrations\//u.test(path) && !addedPaths.includes(path)))
      throw new Error("update_candidate_repository_unavailable");
    const commitSubjects = subjectsRaw.split("\n").map(subject => subject.trim()).filter(Boolean);
    if (!commitSubjects.length || commitSubjects.length > 1000 || commitSubjects.some(subject => subject.length > 500))
      throw new Error("update_candidate_repository_unavailable");
    await inspectIdentity();
    const [afterHead, afterBranch, afterStatus] = await Promise.all([git(["rev-parse", "HEAD"]),
      git(["branch", "--show-current"]), git(["status", "--porcelain=v1", "--untracked-files=all"])]);
    const afterExpected = await fixed.candidateRevisionForRun(input.pipelineRunId)
      .catch(() => { throw new Error("update_candidate_repository_unavailable"); });
    if (afterExpected !== expectedRevision || afterHead.trim() !== candidateRevision
      || afterBranch.trim() !== fixed.managedBranch || afterStatus.trim())
      throw new Error("update_candidate_repository_unavailable");
    return Object.freeze({ baseRevision: fixed.lastAcceptedRevision, candidateRevision,
      changedPaths: Object.freeze([...changedPaths].sort()), addedPaths: Object.freeze([...addedPaths].sort()),
      commitSubjects: Object.freeze(commitSubjects) });
  };
  return Object.freeze({ observe });
}
