import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { FilePlanAuthorityV1, GitMirrorSourceV1, RefereeGitClassifierV1, UpdaterWatcherV1,
  runGitCredentialHelperV1 } from "../src/updater/v1/watcher.mjs";

const run = promisify(execFile);
const SHA = /^[0-9a-f]{40,64}$/u;

async function git(args, cwd) { return run("git", args, { cwd, encoding: "utf8" }); }

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), "updater-watcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git"), work = join(root, "work"), updaterRoot = join(root, "updater-root");
  await mkdir(join(updaterRoot, "updater-state", "plans"), { recursive: true });
  await mkdir(join(updaterRoot, "updater-state"), { recursive: true });
  await git(["init", "--bare", origin]); await git(["clone", origin, work]);
  await git(["config", "user.email", "watcher@example.invalid"], work); await git(["config", "user.name", "Watcher Test"], work);
  await writeFile(join(work, "README.md"), "initial\n"); await git(["add", "."], work); await git(["commit", "-m", "initial"], work);
  await git(["branch", "-M", "main"], work); await git(["push", "origin", "main"], work);
  const fromCommit = (await git(["rev-parse", "HEAD"], work)).stdout.trim(); assert.match(fromCommit, SHA);
  return { root, origin: `file://${origin}`, work, updaterRoot, fromCommit };
}

async function commit(work, path, contents, message = path, push = true) {
  await mkdir(join(work, path, ".."), { recursive: true }); await writeFile(join(work, path), contents);
  await git(["add", path], work); await git(["commit", "-m", message], work); if (push) await git(["push", "origin", "main"], work);
  return (await git(["rev-parse", "HEAD"], work)).stdout.trim();
}

class Plans {
  constructor(now = new Date("2026-09-30T12:00:00.000Z")) { this.now = now; this.open = null; this.rows = []; this.queue = Promise.resolve(); }
  async openPlan() { return this.open ? { ...this.open, planId: this.open.plan.planId } : null; }
  async databaseNow() { return this.now; }
  async replaceOpenPlan(input) {
    const next = this.queue.then(async () => {
      if ((this.open?.plan?.planId ?? null) !== (input.expectedOpenPlanId ?? null))
        return { status: "raced", plan: this.open?.plan ?? null };
      if (this.open?.plan?.candidate?.commit === input.plan.candidate.commit)
        return { status: "existing", plan: this.open.plan };
      if (this.open) this.open = { ...this.open, state: "superseded", supersededByPlanId: input.plan.planId };
      const row = { state: "building", plan: input.plan }; this.open = row; this.rows.push(row);
      return { status: "created", plan: input.plan };
    });
    this.queue = next.then(() => undefined, () => undefined); return next;
  }
}

function green(commit, conclusion = "success", statusCommit = commit) {
  return { commit: statusCommit, checkRuns: [{ commit: statusCommit, name: "required", appSlug: "github-actions", conclusion, id: "fake-ci-1" }] };
}

function classifier() {
  return { async classify() { return { classification: "code-only", classes: ["code"], protectedPaths: [], filesChanged: 1,
    filesAdded: 1, filesDeleted: 0, changesDatabase: false, changesUpdater: false, changedPaths: ["README.md"] }; } };
}

function watcher({ source, plans, root, ci, classifierPort = classifier() }) {
  return new UpdaterWatcherV1({ source, plans, ci, classifier: classifierPort, planFiles: new FilePlanAuthorityV1(root),
    installationId: "install-test", requiredChecks: ["required"] });
}

test("local bare origin: only an exact green main tip becomes one restart-safe plan", async t => {
  const fixture = await repository(t), plans = new Plans();
  const source = new GitMirrorSourceV1({ root: fixture.updaterRoot, origin: fixture.origin, fromCommit: fixture.fromCommit, testing: true });
  const ci = { async statusForCommit(sha) { return green(sha); } };
  const first = watcher({ source, plans, root: fixture.updaterRoot, ci });
  assert.equal((await first.tick()).status, "no_candidate");
  const candidate = await commit(fixture.work, "src/example.ts", "export const v = 1;\n");
  assert.equal((await first.tick()).status, "created"); assert.equal(plans.rows.length, 1);
  const plan = plans.open.plan;
  assert.equal(plan.candidate.commit, candidate); assert.equal(plan.createdAt, "2026-09-30T12:00:00.000Z");
  assert.equal(plan.expiresAt, "2026-10-03T12:00:00.000Z", "expiry is derived from the store clock, not app time");
  assert.equal((await first.tick()).status, "unchanged", "restart does not mint another nonce or plan");
  assert.deepEqual(JSON.parse(await readFile(join(fixture.updaterRoot, "updater-state", "plans", `${plan.planId}.json`), "utf8")), plan);
});

test("red, pending, and status-for-another-sha are refused before classification or a plan", async t => {
  const fixture = await repository(t), plans = new Plans();
  const candidate = await commit(fixture.work, "change.txt", "candidate\n");
  const extraFailure = green(candidate); extraFailure.checkRuns.push({ commit: candidate, name: "extra", appSlug: "github-actions",
    conclusion: "failure", id: "fake-ci-2" });
  for (const status of [green(candidate, "failure"), green(candidate, "pending"), green(candidate, "success", "f".repeat(40)), extraFailure]) {
    const source = new GitMirrorSourceV1({ root: fixture.updaterRoot, origin: fixture.origin, fromCommit: fixture.fromCommit, testing: true });
    const ci = { async statusForCommit() { return status; } };
    await assert.rejects(watcher({ source, plans, root: fixture.updaterRoot, ci }).tick(), /watcher_ci_(?:not_green|status_refused)/u);
    assert.equal(plans.rows.length, 0);
  }
});

test("a forced/re-written main is rejected by the non-fast-forward mirror ref", async t => {
  const fixture = await repository(t), plans = new Plans();
  await commit(fixture.work, "first.txt", "first\n");
  const source = new GitMirrorSourceV1({ root: fixture.updaterRoot, origin: fixture.origin, fromCommit: fixture.fromCommit, testing: true });
  const pending = { async statusForCommit(sha) { return green(sha, "pending"); } };
  await assert.rejects(watcher({ source, plans, root: fixture.updaterRoot, ci: pending }).tick(), /watcher_ci_not_green/u);
  await git(["reset", "--hard", fixture.fromCommit], fixture.work);
  await commit(fixture.work, "rewritten.txt", "rewritten\n", "rewritten", false);
  await git(["push", "--force", "origin", "main"], fixture.work);
  await assert.rejects(watcher({ source, plans, root: fixture.updaterRoot, ci: pending }).tick(), /watcher_source_fetch_refused|watcher_history_rewritten/u);
  assert.equal(plans.rows.length, 0);
});

test("20 rapid pushes and 20 racing watchers leave only the newest one open", async t => {
  const fixture = await repository(t), plans = new Plans();
  let newest = fixture.fromCommit;
  for (let index = 0; index < 20; index += 1) newest = await commit(fixture.work, `rapid/${index}.txt`, `${index}\n`, `rapid ${index}`);
  const source = new GitMirrorSourceV1({ root: fixture.updaterRoot, origin: fixture.origin, fromCommit: fixture.fromCommit, testing: true });
  const ci = { async statusForCommit(sha) { return green(sha); } };
  await watcher({ source, plans, root: fixture.updaterRoot, ci }).tick();
  assert.equal(plans.rows.length, 1); assert.equal(plans.open.plan.candidate.commit, newest);
  const racingPlans = new Plans();
  const frozenSource = { fromCommit: fixture.fromCommit, async fetchMain() { return { commit: newest, tree: newest, repository: "fake" }; },
    async isAncestor() { return true; } };
  await Promise.all(Array.from({ length: 20 }, () => watcher({ source: frozenSource, plans: racingPlans, root: fixture.updaterRoot, ci }).tick()));
  assert.equal(racingPlans.rows.length, 1, "the store's atomic replacement selects one nonce under a 20-caller burst");
  const older = "a".repeat(40), newer = "b".repeat(40), orderedPlans = new Plans();
  const sourceFor = commit => ({ fromCommit: fixture.fromCommit, async fetchMain() { return { commit, tree: commit, repository: "fake" }; },
    async isAncestor(left, right) { return left === older && right === newer; } });
  let releaseNewer, firstNewerClassification = true;
  const delayedNewer = { async classify() {
    if (firstNewerClassification) { firstNewerClassification = false; await new Promise(resolve => { releaseNewer = resolve; }); }
    return classifier().classify();
  } };
  const newerWatch = watcher({ source: sourceFor(newer), plans: orderedPlans, root: fixture.updaterRoot, ci, classifierPort: delayedNewer }).tick();
  await new Promise(resolve => setImmediate(resolve));
  await watcher({ source: sourceFor(older), plans: orderedPlans, root: fixture.updaterRoot, ci }).tick();
  releaseNewer(); await newerWatch;
  assert.equal(orderedPlans.open.plan.candidate.commit, newer, "a delayed older watcher cannot replace the newer main tip");
});

test("the running referee, not candidate metadata, classifies a candidate that edits its own rulebook", async t => {
  const fixture = await repository(t), plans = new Plans();
  const candidate = await commit(fixture.work, "src/updater/v1/policy/classes.json", "{}\n", "change rulebook");
  const source = new GitMirrorSourceV1({ root: fixture.updaterRoot, origin: fixture.origin, fromCommit: fixture.fromCommit, testing: true });
  const ci = { async statusForCommit(sha) { return green(sha); } };
  const result = await watcher({ source, plans, root: fixture.updaterRoot, ci, classifierPort: new RefereeGitClassifierV1() }).tick();
  assert.equal(result.status, "created"); assert.equal(plans.open.plan.candidate.commit, candidate);
  assert.equal(plans.open.plan.kind, "updater"); assert.equal(plans.open.plan.updaterDerived.changesUpdater, true);
});

test("oversized mirrors and malformed credential files fail closed without exposing the token", async t => {
  const fixture = await repository(t), plans = new Plans();
  await commit(fixture.work, "large.bin", randomBytes(16 * 1024));
  const huge = new GitMirrorSourceV1({ root: fixture.updaterRoot, origin: fixture.origin, fromCommit: fixture.fromCommit,
    testing: true, maxRepositoryKiB: 1 });
  await assert.rejects(watcher({ source: huge, plans, root: fixture.updaterRoot, ci: { async statusForCommit(sha) { return green(sha); } } }).tick(),
    /watcher_repository_too_large/u);
  await writeFile(join(fixture.updaterRoot, "updater-state", "github-read.token"), "fake-read-token");
  const reply = await runGitCredentialHelperV1(fixture.updaterRoot, "get\nprotocol=https\nhost=example.invalid\n\n");
  assert.equal(reply, "username=x-access-token\npassword=fake-read-token\n\n");
  await writeFile(join(fixture.updaterRoot, "updater-state", "github-read.token"), "bad\nvalue");
  await assert.rejects(runGitCredentialHelperV1(fixture.updaterRoot, "get\n\n"), /watcher_credential_refused/u);
});
