import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { atomicWriteNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";
import { canonicalJsonV1 } from "./cli.mjs";
import { assertPlainObjectV1, assertSafeIdV1, updaterRefuseV1 } from "./contracts.mjs";

const execFileAsync = promisify(execFile);
const OPEN_PLAN_STATES_V1 = Object.freeze(["building", "ready_for_approval", "approved", "approval_required"]);
const SHA_V1 = /^[0-9a-f]{40,64}$/u;
const MAX_REPOSITORY_KIB_V1 = 256 * 1024;
const CREDENTIAL_HELPER_V1 = fileURLToPath(new URL("./bin/git-credential-control-room", import.meta.url));

function sha256V1(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function shellQuoteV1(value) {
  // This string is interpreted only by Git when it invokes its credential
  // helper. Quote every byte that could turn the fixed helper invocation into
  // another command; credentials themselves are never interpolated here.
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function validCommitV1(value, code = "watcher_commit_refused") {
  if (typeof value !== "string" || !SHA_V1.test(value)) throw updaterRefuseV1(code);
  return value;
}

function candidateCommitV1(plan) {
  const commit = plan?.candidate?.commit;
  return typeof commit === "string" && SHA_V1.test(commit) ? commit : null;
}

function parseGitSizeV1(output) {
  const fields = new Map(output.trim().split("\n").map(line => {
    const index = line.indexOf(":"); return [line.slice(0, index), line.slice(index + 1).trim()];
  }));
  const loose = Number(fields.get("size") ?? "NaN"), packed = Number(fields.get("size-pack") ?? "NaN");
  if (!Number.isSafeInteger(loose) || loose < 0 || !Number.isSafeInteger(packed) || packed < 0)
    throw updaterRefuseV1("watcher_repository_size_refused");
  return loose + packed;
}

/**
 * A deliberately narrow Git port. It tracks origin/main in a mirror ref that
 * is never force-updated: a rewritten remote is therefore refused before its
 * bytes become a candidate. The credential helper reads the root-only token
 * itself; neither Git's argv/environment nor our logs contain the token.
 */
export class GitMirrorSourceV1 {
  constructor({ root, origin, fromCommit, testing = false, git = "git", maxRepositoryKiB = MAX_REPOSITORY_KIB_V1,
    credentialHelper = CREDENTIAL_HELPER_V1 }) {
    this.root = root; this.origin = origin; this.fromCommit = validCommitV1(fromCommit);
    this.testing = testing; this.git = git; this.maxRepositoryKiB = maxRepositoryKiB;
    this.credentialHelper = credentialHelper;
    this.credentialPath = join(root, "updater-state", "github-read.token");
    if (typeof origin !== "string" || (testing ? !/^(?:https:|file:)/u.test(origin) : !origin.startsWith("https://")))
      throw updaterRefuseV1("watcher_origin_refused");
    if (!Number.isSafeInteger(maxRepositoryKiB) || maxRepositoryKiB < 1)
      throw updaterRefuseV1("watcher_repository_limit_refused");
    if (typeof credentialHelper !== "string" || credentialHelper.length < 1
      || !testing && credentialHelper !== CREDENTIAL_HELPER_V1)
      throw updaterRefuseV1("watcher_credential_helper_refused");
  }

  get mirror() { return join(this.root, "updater-state", "mirror.git"); }

  async #git(args, { credential = false } = {}) {
    const config = ["-c", "core.hooksPath=/dev/null", "-c", "transfer.fsckObjects=true",
      "-c", "protocol.allow=never", "-c", "protocol.https.allow=always"];
    if (this.testing) config.push("-c", "protocol.file.allow=always", "-c", "http.sslVerify=false");
    if (credential) {
      const helper = `!${shellQuoteV1(this.credentialHelper)} ${shellQuoteV1(this.credentialPath)}`;
      config.push("-c", `credential.helper=${helper}`, "-c", "credential.useHttpPath=true");
    }
    try {
      return await execFileAsync(this.git, [...config, "--git-dir", this.mirror, ...args], {
        encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/var/empty", GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", LC_ALL: "C",
          ...(credential && this.testing ? { CONTROL_ROOM_TEST_CREDENTIAL_UID: String(process.getuid()) } : {}) },
      });
    } catch (error) { throw updaterRefuseV1("watcher_source_fetch_refused"); }
  }

  async #ensureMirror() {
    try {
      const entry = await lstat(this.mirror);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw updaterRefuseV1("watcher_mirror_refused");
    }
    catch (error) {
      if (error?.code !== "ENOENT") throw updaterRefuseV1("watcher_mirror_refused");
      await execFileAsync(this.git, ["init", "--bare", this.mirror], { encoding: "utf8", maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/var/empty", GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" } }).catch(() => { throw updaterRefuseV1("watcher_mirror_refused"); });
    }
    let remote;
    try { remote = (await this.#git(["remote", "get-url", "origin"])).stdout.trim(); }
    catch { await this.#git(["remote", "add", "origin", this.origin]); return; }
    if (remote !== this.origin) throw updaterRefuseV1("watcher_origin_changed");
  }

  async #isAncestor(ancestor, descendant) {
    try { await this.#git(["merge-base", "--is-ancestor", ancestor, descendant]); return true; }
    catch { return false; }
  }

  async fetchMain() {
    await this.#ensureMirror();
    // Deliberately no '+' on the refspec. Git rejects a forced update rather
    // than silently replacing the last trusted main tip in the mirror.
    await this.#git(["fetch", "--no-tags", "origin", "refs/heads/main:refs/updater/main"],
      { credential: this.origin.startsWith("https://") });
    const commit = (await this.#git(["rev-parse", "refs/updater/main^{commit}"])).stdout.trim();
    validCommitV1(commit);
    const tree = (await this.#git(["rev-parse", `${commit}^{tree}`])).stdout.trim(); validCommitV1(tree);
    if (!(await this.#isAncestor(this.fromCommit, commit))) throw updaterRefuseV1("watcher_history_rewritten");
    const kib = parseGitSizeV1((await this.#git(["count-objects", "-v"])).stdout);
    if (kib > this.maxRepositoryKiB) throw updaterRefuseV1("watcher_repository_too_large");
    return Object.freeze({ commit, tree, repository: this.mirror });
  }

  async isAncestor(ancestor, descendant) {
    validCommitV1(ancestor); validCommitV1(descendant);
    return this.#isAncestor(ancestor, descendant);
  }
}

export class RefereeGitClassifierV1 {
  constructor({ policyDirectory = join(dirname(fileURLToPath(import.meta.url)), "policy"), node = process.execPath } = {}) {
    this.policyDirectory = policyDirectory; this.node = node;
  }
  async classify({ repository, fromCommit, candidateCommit }) {
    validCommitV1(fromCommit); validCommitV1(candidateCommit);
    const cli = join(dirname(fileURLToPath(import.meta.url)), "referee", "cli.ts");
    try {
      const { stdout } = await execFileAsync(this.node, ["--import", "tsx", cli, "--policy-dir", this.policyDirectory,
        "--repo", repository, fromCommit, candidateCommit], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/var/empty", NODE_ENV: "production", LC_ALL: "C" } });
      return JSON.parse(stdout);
    } catch { throw updaterRefuseV1("watcher_classification_refused"); }
  }
}

export class FilePlanAuthorityV1 {
  constructor(root) { this.root = root; }
  async write(plan) {
    assertSafeIdV1(plan.planId, "watcher_plan_refused");
    await atomicWriteNoFollowV1(this.root, `updater-state/plans/${plan.planId}.json`, `${JSON.stringify(plan)}\n`);
  }
  async read(planId) {
    return JSON.parse(await readFileNoFollowV1(this.root, `updater-state/plans/${planId}.json`, { maxBytes: 65_536 }));
  }
}

function makePlanV1({ installationId, source, classification, now }) {
  const planId = `plan-${source.commit}`;
  const kind = classification.classification === "updater" ? "updater"
    : classification.classification === "database" ? "database" : "code";
  const createdAt = now.toISOString(), expiresAt = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString();
  const plan = { schema: "control-room.install-plan/v2", planId, installationId, kind,
    candidate: { commit: source.commit, tree: source.tree, mainProof: { checkRuns: source.checkRuns, protectionOn: true }, reviews: [] },
    artifact: { state: "not_built" }, from: { commit: source.fromCommit },
    database: { class: classification.changesDatabase ? "attended" : "none", migrations: [], expectedSchemaDigest: null,
      n1Compatible: false, backup: classification.changesDatabase ? "verified-dump+preimage" : "quick-dump" },
    updaterDerived: { classes: classification.classes, protectedPaths: classification.protectedPaths,
      filesChanged: classification.filesChanged, filesAdded: classification.filesAdded, filesDeleted: classification.filesDeleted,
      changesDatabase: classification.changesDatabase, changesUpdater: classification.changesUpdater },
    policyDigest: null, downtimeEstimateSeconds: null, serveGeneration: null,
    botSays: { title: "Update candidate", changedAreas: classification.changedPaths.slice(0, 200) },
    onFailure: "automatic-restore", createdAt, expiresAt, nonce: randomBytes(32).toString("base64url") };
  return Object.freeze({ plan, planDigest: sha256V1(canonicalJsonV1(plan)) });
}

function greenChecksV1(status, commit, requiredChecks) {
  if (!status || status.commit !== commit || !Array.isArray(status.checkRuns)) throw updaterRefuseV1("watcher_ci_status_refused");
  const checks = status.checkRuns.map(check => {
    if (!check || check.commit !== commit || typeof check.name !== "string" || check.appSlug !== "github-actions"
        || typeof check.conclusion !== "string") throw updaterRefuseV1("watcher_ci_status_refused");
    return Object.freeze({ name: check.name, appSlug: check.appSlug, conclusion: check.conclusion,
      id: typeof check.id === "string" || typeof check.id === "number" ? String(check.id) : "" });
  });
  if (checks.length === 0 || requiredChecks.some(name => !checks.some(check => check.name === name && check.conclusion === "success"))
      || checks.some(check => check.conclusion !== "success")) throw updaterRefuseV1("watcher_ci_not_green");
  return checks;
}

/** Item 17's coordinator. Its durable store is deliberately a port: the
 * production implementation is the item-7 deployer store, while tests can
 * run against a local bare repository with no GitHub credential. */
export class UpdaterWatcherV1 {
  constructor({ source, ci, classifier, plans, planFiles, installationId, requiredChecks = [] }) {
    this.source = source; this.ci = ci; this.classifier = classifier; this.plans = plans; this.planFiles = planFiles;
    this.installationId = assertSafeIdV1(installationId, "watcher_installation_refused");
    if (!Array.isArray(requiredChecks) || requiredChecks.length < 1 || requiredChecks.some(name => typeof name !== "string" || !name))
      throw updaterRefuseV1("watcher_required_checks_refused");
    this.requiredChecks = [...new Set(requiredChecks)]; this.ticking = false;
  }

  async #tick(attempt = 0) {
    if (attempt > 2) throw updaterRefuseV1("watcher_plan_race_refused");
    const source = await this.source.fetchMain();
    if (source.commit === this.source.fromCommit) return { status: "no_candidate" };
    const status = await this.ci.statusForCommit(source.commit);
    const checkRuns = greenChecksV1(status, source.commit, this.requiredChecks);
    const existing = await this.plans.openPlan();
    if (existing && candidateCommitV1(existing.plan) === source.commit) {
      await this.planFiles.write(existing.plan); return { status: "unchanged", planId: existing.planId };
    }
    if (existing) {
      const oldCommit = candidateCommitV1(existing.plan);
      if (!oldCommit || !(await this.source.isAncestor(oldCommit, source.commit)))
        throw updaterRefuseV1("watcher_history_rewritten");
    }
    const classification = await this.classifier.classify({ repository: source.repository, fromCommit: this.source.fromCommit,
      candidateCommit: source.commit });
    if (!classification || classification.refused === true || !Array.isArray(classification.classes))
      throw updaterRefuseV1("watcher_classification_refused");
    const now = await this.plans.databaseNow();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw updaterRefuseV1("watcher_database_time_refused");
    const draft = makePlanV1({ installationId: this.installationId,
      source: { ...source, fromCommit: this.source.fromCommit, checkRuns }, classification, now });
    const result = await this.plans.replaceOpenPlan({ ...draft, state: "building", expectedOpenPlanId: existing?.planId ?? null });
    if (result?.status === "raced") return this.#tick(attempt + 1);
    if (!result || !["created", "existing"].includes(result.status) || !result.plan)
      throw updaterRefuseV1("watcher_plan_store_refused");
    // A concurrent watcher may have won. Only persist the exact plan that the
    // atomic store selected, never this loser's nonce/digest.
    await this.planFiles.write(result.plan);
    return { status: result.status, planId: result.plan.planId, classification: result.plan.kind };
  }

  async tick() {
    if (this.ticking) return { status: "busy" };
    this.ticking = true;
    try { return await this.#tick(); } finally { this.ticking = false; }
  }
}
