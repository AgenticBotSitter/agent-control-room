import { publishLocalFixtureV1 } from "./support/publish-local-fixture.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:https";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { once } from "node:events";
import test from "node:test";
import { FilePlanAuthorityV1, GitMirrorSourceV1, RefereeGitClassifierV1, UpdaterWatcherV1,
} from "../src/updater/v1/watcher.mjs";

const run = promisify(execFile);
const SHA = /^[0-9a-f]{40,64}$/u;

async function git(args, cwd) { return run("git", args, { cwd, encoding: "utf8" }); }

function httpBackend(env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] }), chunks = [], errors = [];
    child.stdout.on("data", chunk => chunks.push(chunk)); child.stderr.on("data", chunk => errors.push(chunk));
    child.once("error", reject); child.once("close", code => code === 0 ? resolve(Buffer.concat(chunks))
      : reject(new Error(`git_http_backend_failed:${code}:${Buffer.concat(errors).toString("utf8")}`)));
    child.stdin.end(input);
  });
}

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), "updater-watcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git"), work = join(root, "work"), updaterRoot = join(root, "updater-root");
  await mkdir(join(updaterRoot, "updater-state", "plans"), { recursive: true });
  await mkdir(join(updaterRoot, "updater-state"), { recursive: true });
  await git(["init", "--bare", origin]); await git(["clone", origin, work]);
  await git(["config", "user.email", "watcher@example.invalid"], work); await git(["config", "user.name", "Watcher Test"], work);
  await writeFile(join(work, "README.md"), "initial\n"); await git(["add", "."], work); await git(["commit", "-m", "initial"], work);
  await git(["branch", "-M", "main"], work); await publishLocalFixtureV1(work);
  const fromCommit = (await git(["rev-parse", "HEAD"], work)).stdout.trim(); assert.match(fromCommit, SHA);
  return { root, origin: `file://${origin}`, work, updaterRoot, fromCommit };
}

async function commit(work, path, contents, message = path, push = true) {
  await mkdir(join(work, path, ".."), { recursive: true }); await writeFile(join(work, path), contents);
  await git(["add", path], work); await git(["commit", "-m", message], work); if (push) await publishLocalFixtureV1(work);
  return (await git(["rev-parse", "HEAD"], work)).stdout.trim();
}

async function credentialHttpsOrigin(t, fixture, token) {
  const key = join(fixture.root, "test.key"), certificate = join(fixture.root, "test.crt");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate,
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-days", "1"], { encoding: "utf8" });
  const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  let authenticated = 0, rejected = 0;
  const server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, async (request, response) => {
    if (request.headers.authorization !== expected) {
      rejected += 1; response.writeHead(401, { "www-authenticate": "Basic realm=control-room" }); response.end(); return;
    }
    authenticated += 1;
    const url = new URL(request.url, "https://127.0.0.1"), chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let output;
    try {
      output = await httpBackend({ PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_HTTP_EXPORT_ALL: "1", GIT_PROJECT_ROOT: fixture.root,
        PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "", CONTENT_LENGTH: String(body.length) }, body);
    } catch (error) { response.writeHead(500); response.end(error.message); return; }
    const separator = output.indexOf(Buffer.from("\r\n\r\n"));
    assert.notEqual(separator, -1, "git http-backend returned CGI headers");
    const headers = output.subarray(0, separator).toString("utf8").split("\r\n"), values = {};
    let status = 200;
    for (const header of headers) {
      const index = header.indexOf(":"); if (index < 0) continue;
      const name = header.slice(0, index), value = header.slice(index + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.slice(0, 3)); else values[name] = value;
    }
    response.writeHead(status, values); response.end(output.subarray(separator + 4));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { origin: `https://127.0.0.1:${address.port}/origin.git`, counts: () => ({ authenticated, rejected }) };
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

test("a live updater run suppresses source polling until the run is finished", async t => {
  const fixture = await repository(t), plans = new Plans(); let fetches = 0;
  plans.liveRun = async () => ({ run_id: "run:00000000-0000-4000-8000-000000000001", state: "switched" });
  const source = { fromCommit: fixture.fromCommit, async fetchMain() { fetches += 1;
    return { commit: "b".repeat(40), tree: "c".repeat(40), repository: "fixture" }; },
  async isAncestor() { return true; } };
  const result = await watcher({ source, plans, root: fixture.updaterRoot,
    ci: { async statusForCommit(sha) { return green(sha); } } }).tick();
  assert.deepEqual(result, { status: "run_active" });
  assert.equal(fetches, 0, "the watcher does not contact GitHub while an update owns the installation");
  assert.equal(plans.rows.length, 0, "the live run's approved plan is not replaced");
});

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
  const wrongCheckSha = green(candidate); wrongCheckSha.checkRuns[0].commit = "f".repeat(40);
  for (const status of [green(candidate, "failure"), green(candidate, "pending"), green(candidate, "success", "f".repeat(40)), wrongCheckSha, extraFailure]) {
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
  await publishLocalFixtureV1(fixture.work);
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

test("oversized mirrors fail closed", async t => {
  const fixture = await repository(t), plans = new Plans();
  await commit(fixture.work, "large.bin", randomBytes(16 * 1024));
  const huge = new GitMirrorSourceV1({ root: fixture.updaterRoot, origin: fixture.origin, fromCommit: fixture.fromCommit,
    testing: true, maxRepositoryKiB: 1 });
  await assert.rejects(watcher({ source: huge, plans, root: fixture.updaterRoot, ci: { async statusForCommit(sha) { return green(sha); } } }).tick(),
    /watcher_repository_too_large/u);
});

test("real Git invokes the shared helper with argv get for an authenticated local HTTPS smart-HTTP origin", async t => {
  const fixture = await repository(t), token = "fake-read-token";
  const apostropheRoot = `${fixture.updaterRoot}'quoted`;
  await mkdir(join(apostropheRoot, "updater-state", "plans"), { recursive: true });
  await writeFile(join(apostropheRoot, "updater-state", "github-read.token"), `${token}\n`, { mode: 0o600 });
  const https = await credentialHttpsOrigin(t, fixture, token);
  const source = new GitMirrorSourceV1({ root: apostropheRoot, origin: https.origin, fromCommit: fixture.fromCommit, testing: true });
  let fetched;
  try { fetched = await source.fetchMain(); }
  catch (error) { assert.fail(`${error.message}; server=${JSON.stringify(https.counts())}`); }
  assert.equal(fetched.commit, fixture.fromCommit);
  assert.ok(https.counts().rejected >= 1, "the server required basic authentication before serving Git");
  assert.ok(https.counts().authenticated >= 1, "real Git retried with the shared helper's token response");
});
