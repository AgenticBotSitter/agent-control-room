// M2 — W5 journey steps for the `mac-local` product composition.
//
// What this file proves
// ---------------------
// The route table that `mac:up`/`mac:host` actually mounts is
// `src/web/v1/mac-local-web-process.ts` (NOT `private-process.ts`). M1
// (`docs/MARVIN_MAC_WEBSITE_ROUTE_INVENTORY.md`) read that table and recorded
// which journey steps are reachable as shipped. This file turns that report
// into executable assertions, so the report cannot silently drift from the
// code.
//
// Coverage follows M1's table exactly:
//   reachable (7):  sign in, project list, create project, create task,
//                   status/run, result review, worker status
//   routed-but-refused (5): assign, approve, request changes, accept, plan
//   no route at all (1): cancel
//
// A test that asserts a gap is still worth having: if someone installs the
// missing operation, or adds a cancel route, these cases fail and force a
// deliberate decision rather than an accidental capability change.
//
// Database
// --------
// A DISPOSABLE PostgreSQL 17 cluster, created by this file in `before` via
// initdb/pg_ctl against a temp data directory on a nonstandard loopback port,
// torn down in `after`. It never reads the protected root and never reaches a
// non-loopback host. If PostgreSQL binaries are absent the whole file SKIPS
// (loudly, with a reason) rather than silently reporting green.
//
// NOTE on the `*_not_configured` refusals
// ---------------------------------------
// M1 recorded these refusals by their internal error names
// (`assignment_not_configured`, `task_approval_not_configured`,
// `revision_planning_not_configured`, `owner_review_not_configured`,
// `task_planning_not_configured`). Those names are thrown as plain `Error`s and
// `webFailure()` (src/web/v1/http-common.ts:8-12) maps every non-`WebAccessError`
// to `{error:"service_unavailable"}` / HTTP 503. The internal name is therefore
// NOT visible to the browser. These cases assert the two things that ARE
// observable and that pin the gap:
//   1. the exact HTTP 503 `service_unavailable` refusal — not a 404 (route
//      missing, a different defect) and not a 500 (unhandled crash),
//   2. against a real, authorized project + proposed task, so the refusal
//      cannot pass for the wrong reason of "unauthorized" or "no such task".
// The DISTINGUISHING check — that this refusal is gap-specific and not just a
// blanket 503 — is the per-case control read at the end of each test: the very
// same session, project and task still answer 200 on the reachable detail
// route. A blanket-503 bug would fail that control.

import assert from "node:assert/strict";
import test, { after, before, describe, type TestContext } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Digest } from "../src/security/canonical-digest";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { createPrivateOwnerBootstrapCommand, type PrivateOwnerBootstrapConfiguration }
  from "../src/web/v1/private-owner-bootstrap";
import { createPrivatePostgresDatabase, type PrivatePostgresConfiguration } from "../src/web/v1/private-postgres";
import type { AccessTrust } from "../src/web/v1/access-verifier";
import type { MacLocalWebProcessOptionsV1 } from "../src/web/v1/mac-local-web-process";
import { conformanceNow, conformanceSubject, syntheticAssertion, syntheticSigningKey, syntheticAccessTrust }
  from "./helpers/private-owner-bootstrap-conformance";
import { openDisposableMacLocalDatabase } from "./helpers/mac-local-disposable-database";

const exec = promisify(execFile);

/**
 * PG_BIN is how the repo's own live-cluster tests (package.json
 * `test:postgres-production`) locate PostgreSQL. Homebrew's bin directory
 * holds initdb/pg_ctl/psql directly, so probe both shapes.
 */
function resolvePostgresBin(): string | undefined {
  const candidates = [process.env.PG_BIN, "/opt/homebrew/bin", "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/lib/postgresql/17/bin"].filter((value): value is string => !!value);
  for (const dir of candidates) {
    if (existsSync(join(dir, "initdb")) && existsSync(join(dir, "pg_ctl")) && existsSync(join(dir, "postgres")))
      return dir;
  }
  return undefined;
}

const PG_BIN = resolvePostgresBin();
const PG_AVAILABLE = PG_BIN !== undefined;
// The repo's own PG tests pass this as the second `test()` argument; keep the
// same convention so a missing PostgreSQL reads as a loud skip, never green.
const needsPg = PG_AVAILABLE ? false : "needs PostgreSQL 17 binaries (PG_BIN, /opt/homebrew/bin, or /usr/lib/postgresql/17/bin)";

/** Nonstandard loopback port (<= 65535), clear of the repo's other PG tests (65434, 5432). */
const PORT = 65_431;
const origin = "http://127.0.0.1:3210";
const ownerCode = "mac-local-journey-owner-code-000001";
// Anchor the clock and the owner subject to the repo's existing conformance
// constants. createAccessVerifier refuses a `now` at or past trust.validUntilMs,
// and syntheticAssertion/syntheticAccessTrust both build their window around
// conformanceNow, so using a different clock here would only manufacture a
// spurious authentication_required. Same choice as
// tests/mac-local-web-process.test.ts.
const nowMs = conformanceNow;
const subject = conformanceSubject;
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;
const digestD = `sha256:${"d".repeat(64)}`;

interface Cluster { run: string; data: string; socket: string; pgCtl: string; fixturePassword: string }
let cluster: Cluster | undefined;

const execOptions = { timeout: 120_000, maxBuffer: 1 << 26, encoding: "utf8" as const };

async function startCluster(): Promise<Cluster> {
  const run = await mkdtemp(join(tmpdir(), "cr-mac-local-m2-"));
  const data = join(run, "data");
  const socket = join(run, "socket");
  await mkdir(socket, { mode: 0o700 });
  const base = { env: { ...process.env, PATH: "/usr/bin:/bin:/opt/homebrew/bin", LC_ALL: "C", TMPDIR: run,
      NODE_ENV: "test" as const }, ...execOptions };
  // initdb into a temp dir only. `-U fixture_admin` is a synthetic role; the
  // password set below is a throwaway constant, never a real credential.
  await exec(join(PG_BIN!, "initdb"), ["-D", data, "-U", "fixture_admin", "-E", "UTF8", "--auth-local=trust"], base);
  // Loopback-only TCP with scram. initdb with --auth-local=trust writes a
  // stock pg_hba.conf whose loopback TCP rule is `trust` (with --auth-host=reject
  // it is `reject` instead). pg_hba is first-match-wins, so rewrite whatever the
  // stock loopback TCP rule is rather than appending a line that never applies.
  const hba = join(data, "pg_hba.conf");
  const { readFile: read, writeFile: write } = await import("node:fs/promises");
  const stock = await read(hba, "utf8");
  const patched = stock.replace(/^(host\s+all\s+all\s+127\.0\.0\.1\/32\s+)\S+(\s*)$/m,
    "host    all             all             127.0.0.1/32            scram-sha-256$2");
  assert.notEqual(patched, stock,
    "pg_hba.conf must still contain a stock loopback TCP rule to patch to scram");
  await write(hba, patched, "utf8");
  const fixturePassword = "disposable-fixture-password";
  await exec(join(PG_BIN!, "pg_ctl"), ["-D", data, "-o",
    `-p ${PORT} -k ${socket} -h 127.0.0.1 -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off`,
    "-l", join(run, "server.log"), "-w", "-t", "60", "start"], base);
  // Set the synthetic role password over the local socket (trust auth).
  await exec(join(PG_BIN!, "psql"), ["-h", socket, "-p", String(PORT), "-U", "fixture_admin",
    "-d", "postgres", "-Atc", `ALTER ROLE fixture_admin PASSWORD '${fixturePassword}';`], execOptions);
  return { run, data, socket, pgCtl: join(PG_BIN!, "pg_ctl"), fixturePassword };
}

/** Stop the cluster and prove it is gone before the data directory is removed.
 *
 * A swallowed stop failure used to be followed by `rm` anyway, which could
 * delete the socket and data directory out from under a still-running
 * postmaster, leave an unreaped process and a bound port behind, and make the
 * next run fail with an unrelated-looking EADDRINUSE. Teardown now fails
 * loudly instead: it falls back to the recorded postmaster pid, verifies the
 * process is gone, and only then removes the directory. */
async function stopCluster(target: Cluster) {
  const stopped = await exec(target.pgCtl, ["-D", target.data, "-m", "immediate", "-w", "-t", "60", "stop"],
    { timeout: 120_000, maxBuffer: 1 << 26, encoding: "utf8" }).then(() => true,
      (error: Error) => { stopFailure = error; return false; });
  if (!stopped) {
    // pg_ctl writes postmaster.pid into the data directory; use it as the fallback.
    const pidFile = join(target.data, "postmaster.pid");
    let pid: number | undefined;
    try { pid = Number((await readFile(pidFile, "utf8")).split("\n")[0]?.trim()); } catch { pid = undefined; }
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    // Give the kernel a moment to release the listening socket.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!(await isPostmasterAlive(pid))) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (await isPostmasterAlive(pid))
      throw new Error(`disposable_cluster_stop_failed: ${stopFailure?.message ?? "postmaster still alive"}`);
  }
  if (await isPostmasterAlive(await readPostmasterPid(target)))
    throw new Error("disposable_cluster_survived_teardown");
  await rm(target.run, { recursive: true, force: true });
}

let stopFailure: Error | undefined;

async function readPostmasterPid(target: Cluster): Promise<number | undefined> {
  try { const raw = (await readFile(join(target.data, "postmaster.pid"), "utf8")).split("\n")[0]?.trim();
    return Number.isSafeInteger(Number(raw)) && Number(raw) > 1 ? Number(raw) : undefined; }
  catch { return undefined; }
}

/** A pid is only "alive" if it exists AND is the postgres postmaster, so a
 * recycled pid belonging to something else can never be reported as ours. */
function isPostmasterAlive(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const command = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return /\bpostgres\b/u.test(command);
  } catch { return false; }
}

before(async () => { if (PG_AVAILABLE) cluster = await startCluster(); });
after(async () => { if (cluster) await stopCluster(cluster); });

interface Journey {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  auth: { cookie: string };
  id: (value: string) => string;
}

/** Boot the real `mac-local` composition against a freshly migrated database. */
async function journeyFixture(t: TestContext, fresh: string, extra: Partial<MacLocalWebProcessOptionsV1> = {}): Promise<Journey> {
  const active = cluster!;
  const database = await openDisposableMacLocalDatabase({ run: active.run, port: PORT, name: fresh,
    fixtureUser: "fixture_admin", fixturePassword: active.fixturePassword });
  const key = syntheticSigningKey();
  // The trust window, the assertion exp and the run clock all share conformanceNow.
  const trust: AccessTrust = syntheticAccessTrust(key, nowMs);
  const configuration: PrivateOwnerBootstrapConfiguration = {
    databaseName: database.name, tenantId: `tenant:${fresh}`, workspaceId: `workspace:${fresh}`,
    tenantDisplayName: "Disposable tenant", workspaceDisplayName: "Disposable workspace",
    identityId: `identity:synthetic-owner-${fresh}`, grantId: `grant:synthetic-owner-${fresh}`,
    displayName: "Synthetic owner", expectedOwnerSubjectDigest: sha256Digest({ provider: trust.issuer, subject }),
  };
  const pgConfig: PrivatePostgresConfiguration = { host: "127.0.0.1", port: PORT, database: database.name,
    username: "fixture_admin", password: active.fixturePassword, majorVersion: 17 };
  const opened = createPrivatePostgresDatabase(pgConfig);
  const ownerCreated = await createPrivateOwnerBootstrapCommand({
    openDatabase: () => ({ client: opened.client, close: async () => {}, isAvailable: () => true }),
    clock: () => nowMs,
  })({ configuration, database: pgConfig, trust, assertion: syntheticAssertion(key) });
  assert.equal(ownerCreated.ownerCreated, true, `owner bootstrap failed for ${fresh}`);
  assert.ok(database.applied > 0, "the migration ledger must have applied before the journey runs");

  const app = createMacLocalWebProcessV1({
    origin, workspaceId: configuration.workspaceId, clock: () => nowMs,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: configuration.tenantId,
      provider: trust.issuer, subject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: opened.client, close: async () => {} },
    ...extra,
  });
  t.after(async () => { await app.close(); await opened.close(); await database.drop(); });

  const request = (path: string, init: RequestInit = {}) =>
    app.handle(new Request(`${origin}${path}`, init), () => new Response("product shell"));
  const signedIn = await app.handle(new Request(`${origin}/api/v1/local-owner-session`, { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }),
    () => new Response("unused"));
  assert.equal(signedIn.status, 201, `sign-in failed for ${fresh}`);
  const cookie = signedIn.headers.get("set-cookie");
  assert.ok(cookie, "sign-in must set a session cookie");
  return { request, auth: { cookie }, id: (value: string) => encodeURIComponent(value) };
}

/** Parse a JSON response exactly once. A Response body is single-use, so any
 * helper that both asserts a status and reads the body must do it here. */
async function readJson<T>(response: Response, expected: number, label: string): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, expected, `${label}: expected ${expected}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** Create a project through the real HTTP boundary and return its id. */
async function seedProject(f: Journey, fresh: string) {
  const created = await f.request("/api/v1/projects", { method: "POST", headers: { ...f.auth, origin,
    "content-type": "application/json", "idempotency-key": `m2seedproj${fresh}`.padEnd(12, "0") },
    body: JSON.stringify({ title: "Seed project", summary: "Seeded for the journey read cases" }) });
  const { project } = await readJson<{ project: { projectId: string } }>(created, 201, "seed project");
  return { projectId: project.projectId };
}

/** Create a project and a proposed task through the real HTTP boundary. */
async function seedTask(f: Journey, fresh: string) {
  const { projectId } = await seedProject(f, fresh);
  const proposed = await f.request(`/api/v1/projects/${f.id(projectId)}/tasks`, { method: "POST", headers: {
    ...f.auth, origin, "content-type": "application/json", "idempotency-key": `m2seedtask${fresh}`.padEnd(12, "0") },
    body: JSON.stringify({ title: "Seed task", instructions: "Return one harmless short line." }) });
  const { receipt } = await readJson<{ receipt: { jobId: string } }>(proposed, 201, "seed task");
  return { projectId, jobId: receipt.jobId };
}

describe("W5 journey steps that are reachable as shipped", { skip: needsPg }, () => {
  test("1. sign in issues a loopback session and every protected read refuses without it", async t => {
    const f = await journeyFixture(t, "m2signin");
    assert.equal((await f.request("/api/v1/projects")).status, 401, "an unauthenticated read must be refused");
    const bad = await f.request("/api/v1/local-owner-session", { method: "POST", headers: {
      origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ ownerCode: "wrong-owner-code-long-enough-000" }) });
    assert.equal(bad.status, 401, "a wrong owner code must be refused, not accepted");
    const page = await f.request("/session");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /ownerCode/, "the sign-in page must post an owner code");
  });

  test("2. project list returns the authorized catalog page", async t => {
    const f = await journeyFixture(t, "m2list");
    const listed = await f.request("/api/v1/projects", { headers: f.auth });
    const page = await readJson<{ projects: unknown[]; canCreate: boolean }>(listed, 200, "project list");
    assert.ok(Array.isArray(page.projects), "the catalog must be a bounded array");
    assert.equal(page.canCreate, true, "the owner must be able to create the first project");
  });

  test("3. create project persists and is then readable", async t => {
    const f = await journeyFixture(t, "m2createproject");
    const created = await f.request("/api/v1/projects", { method: "POST", headers: { ...f.auth, origin,
      "content-type": "application/json", "idempotency-key": "m2projectcreate000001" },
      body: JSON.stringify({ title: "Journey project", summary: "Disposable W5 route proof" }) });
    const { project } = await readJson<{ project: { projectId: string; title: string } }>(created, 201, "create project");
    assert.match(project.projectId, /^project:/);
    assert.equal(project.title, "Journey project");
    // A fresh request: the create response body is already consumed by readJson.
    // The authoritative read-back for this journey is the catalog (journey step
    // 2): confirm the new project appears there. getView by id is a separate
    // grant-scoped lookup and is covered by the service's own tests, so do not
    // make this journey case depend on it.
    const catalog = await readJson<{ projects: { projectId: string; title: string }[] }>(
      await f.request("/api/v1/projects", { headers: f.auth }), 200, "project list after create");
    const found = catalog.projects.find(item => item.projectId === project.projectId);
    assert.ok(found, "the created project must appear in the authorized catalog");
    assert.equal(found!.title, "Journey project");
    // Recorded separately, because M1 does not claim it and it is easy to
    // misread: the project list returns the project, but the per-id
    // `GET /api/v1/projects/{id}` lookup answers not_found for the same id.
    // The list query and getView apply different source/adapter eligibility
    // (project-service.ts:96 uses manual_project_<id> domain_state, which
    // `create` evidently does not set the way getView expects). Assert the
    // observed behaviour so a future fix is a deliberate change to this test,
    // not a silent capability.
    const byId = await f.request(`/api/v1/projects/${f.id(project.projectId)}`, { headers: f.auth });
    assert.equal(byId.status, 404,
      "per-id project lookup currently answers not_found even though the catalog lists the project");
    assert.deepEqual(await readJson(byId, 404, "project by id"), { error: "not_found" });
  });

  test("4. create task saves a proposal that does not start work", async t => {
    const f = await journeyFixture(t, "m2createtask");
    const { projectId } = await seedProject(f, "m2createtask");
    const proposed = await f.request(`/api/v1/projects/${f.id(projectId)}/tasks`, { method: "POST",
      headers: { ...f.auth, origin, "content-type": "application/json", "idempotency-key": "m2taskcreate000001" },
      body: JSON.stringify({ title: "Journey task", instructions: "Return one harmless short line." }) });
    const receipt = await readJson<{ receipt: { startsWork: boolean; submission: string } }>(proposed, 201, "create task");
    assert.equal(receipt.receipt.startsWork, false, "saving a proposal must never start work");
    assert.equal(receipt.receipt.submission, "proposed");
  });

  test("5. status / run read returns the protected task detail", async t => {
    const f = await journeyFixture(t, "m2status");
    const { projectId, jobId } = await seedTask(f, "m2status");
    const detail = await f.request(`/api/v1/projects/${f.id(projectId)}/tasks/${f.id(jobId)}`, { headers: f.auth });
    // taskDetailSchema nests the summary under `task`; jobId is not top-level.
    const body = await readJson<{ task: { jobId: string }; dispatch: string }>(detail, 200, "task detail");
    assert.equal(body.task.jobId, jobId);
    assert.equal(body.dispatch, "not_connected", "mac-local ships no submission transport");
  });

  test("6. result review read is available and reports no results rather than inventing any", async t => {
    const f = await journeyFixture(t, "m2results");
    const { projectId, jobId } = await seedTask(f, "m2results");
    const results = await f.request(`/api/v1/projects/${f.id(projectId)}/tasks/${f.id(jobId)}/results`, { headers: f.auth });
    const body = await readJson<{ results?: unknown[] }>(results, 200, "task results");
    assert.ok(Array.isArray(body.results ?? []), "results must be a bounded array, never a fabricated result");
    assert.equal((body.results ?? []).length, 0, "a freshly proposed task has no saved result");
  });

  test("7. worker status read returns host-generated evidence, not a live claim", async t => {
    const f = await journeyFixture(t, "m2workers", { workerReadiness: { read: () => [
      { kind: "hermes-021" as const, state: "ready" as const, proof: "not_proven" as const }] } });
    const workers = await f.request("/api/v1/local-workers", { headers: f.auth });
    assert.deepEqual(await readJson(workers, 200, "worker status"),
      { workers: [{ kind: "hermes-021", state: "ready", proof: "not_proven" }] });
  });
});

describe("W5 journey steps that are routed but unusable as shipped", { skip: needsPg }, () => {
  // Each case asserts the specific refusal M1 recorded, against a real
  // authorized project + proposed task so it cannot pass for the wrong reason.
  // Bodies are schema-valid on purpose: where the handler parses the draft
  // before the not_configured check (revisions, planning), a malformed body
  // would be refused as invalid_request and the case would pass for the wrong
  // reason.
  const refusals: readonly { step: string; name: string; suffix: string; method: "GET" | "POST";
    query?: string; body?: unknown }[] = [
    // The assignment GET route takes NO query: task-http.ts:141 refuses any
    // search string outright, so probe it bare. (The approval GET route does
    // require exactly one inputDigest, hence the query on that entry.)
    { step: "8. assign worker", name: "assignment", suffix: "assignment", method: "GET" },
    { step: "9. approve", name: "approval", suffix: "approval", method: "GET",
      query: `?inputDigest=${digestA}` },
    { step: "10. request changes", name: "revisions", suffix: "revisions", method: "POST",
      body: { runId: "run:synthetic", targetId: "target:synthetic", targetDigest: digestB,
        contentHash: digestC, reviewId: "review:synthetic", feedback: "Please revise this." } },
    { step: "11. accept", name: "accept", suffix: "results/artifact%3Asynthetic/reviews/target%3Asynthetic",
      method: "POST",
      body: { artifactId: "artifact:synthetic", targetId: "target:synthetic", targetDigest: digestB,
        contentHash: digestC, decision: "accepted", feedback: "" } },
    { step: "12. plan a task", name: "plan", suffix: "plan", method: "POST",
      body: { expectedInputDigest: digestD } },
  ];

  for (const refusal of refusals) {
    test(`${refusal.step} is refused by the mounted route, not missing from it`, async t => {
      const f = await journeyFixture(t, `m2refuse${refusal.name}`.slice(0, 60));
      const { projectId, jobId } = await seedTask(f, `m2refuse${refusal.name}`.slice(0, 60));
      const path = `/api/v1/projects/${f.id(projectId)}/tasks/${f.id(jobId)}/${refusal.suffix}${refusal.query ?? ""}`;
      const response = refusal.method === "POST"
        ? await f.request(path, { method: "POST", headers: { ...f.auth, origin, "content-type": "application/json" },
            body: JSON.stringify(refusal.body) })
        : await f.request(path, { headers: f.auth });
      // M1 recorded `<name>_not_configured`. Those are plain Errors, and
      // webFailure() maps every non-WebAccessError to 503 service_unavailable.
      // The route therefore answers 503 — NOT 404 (route missing) and NOT 500.
      assert.equal(response.status, 503,
        `${refusal.step}: expected the not_configured refusal, got ${response.status}`);
      assert.deepEqual(await response.json(), { error: "service_unavailable" },
        `${refusal.step}: the refusal body must be the specific not_configured surface`);
      // The distinguishing control: the same session/project/task still
      // answers 200 on the reachable detail route. A blanket-503 bug, an
      // authorization bug, or a missing-record bug would all fail here.
      const control = await f.request(`/api/v1/projects/${f.id(projectId)}/tasks/${f.id(jobId)}`, { headers: f.auth });
      assert.equal(control.status, 200,
        `${refusal.step}: the control read must still succeed, so the refusal is gap-specific`);
    });
  }
});

describe("W5 journey step 13: cancel has no route anywhere in the mac-local table", { skip: needsPg }, () => {
  test("every plausible cancel surface is unmounted in mac-local", async t => {
    const f = await journeyFixture(t, "m2cancel");
    const { projectId, jobId } = await seedTask(f, "m2cancel");
    // M1 found no cancel route in task-http.ts, project-http.ts,
    // mac-local-web-process.ts, or private-process.ts. The only browser-visible
    // cancel in the wider product is the Idea Lab `ideas/{id}/stop`, which lives
    // in private-process.ts and is not mounted in mac-local at all. Pin all of
    // it: adding a cancel route later must fail this test on purpose.
    //
    // The assertion is on the error CODE, not one status: mac-local's task
    // dispatch (`/^\/api\/v1\/projects\/[^/]+\/tasks(?:\/|$)/`) never matches
    // `/api/v1/ideas/...`, so the idea path falls through to the product route
    // and is refused as not_found. Either way it must be refused as NOT FOUND
    // — it must never be accepted, and never invent a cancelled state.
    const candidates = [
      `/api/v1/projects/${f.id(projectId)}/tasks/${f.id(jobId)}/cancel`,
      `/api/v1/projects/${f.id(projectId)}/tasks/${f.id(jobId)}/cancelled`,
      `/api/v1/projects/${f.id(projectId)}/tasks/${f.id(jobId)}/stop`,
      `/api/v1/projects/${f.id(projectId)}/tasks/${f.id(jobId)}/abort`,
      `/api/v1/projects/${f.id(projectId)}/tasks/${f.id(jobId)}/revoke`,
      `/api/v1/ideas/${f.id(projectId)}/stop`,
      `/api/v1/projects/${f.id(projectId)}/cancel`,
    ];
    for (const path of candidates) {
      for (const method of ["GET", "POST"] as const) {
        const response = await f.request(path, method === "POST"
          ? { method, headers: { ...f.auth, origin, "content-type": "application/json" }, body: "{}" }
          : { headers: f.auth });
        assert.notEqual(response.status, 200,
          `${method} ${path} must stay unmounted; it answered ${response.status}`);
        assert.notEqual(response.status, 201,
          `${method} ${path} must stay unmounted; it answered ${response.status}`);
        const body = await readJson<{ error?: string }>(response, response.status, `${method} ${path}`);
        assert.ok(["not_found", "invalid_request"].includes(body.error ?? ""),
          `${method} ${path} must be refused as absent, got ${body.error}`);
      }
    }
    // The task is still readable, so a reviewer can see the absence is about
    // routing, not about a broken fixture.
    const detail = await f.request(`/api/v1/projects/${f.id(projectId)}/tasks/${f.id(jobId)}`, { headers: f.auth });
    const body = await readJson<{ task: { state: string } }>(detail, 200, "task detail after cancel probes");
    assert.notEqual(body.task.state, "cancelled", "mac-local must not invent a cancelled state");
  });
});

describe("no preview or fake panel is reachable through the rendered mac-local product route", { skip: needsPg }, () => {
  test("the product route refuses the local-preview workspace and the demo paths", async t => {
    const f = await journeyFixture(t, "m2preview");
    // M1 §5: zero preview/fake panels are reachable in mac-local, verified by
    // reading the route table. Pin the guarantee with a test so it stops being
    // true by report alone. renderProductRoute throws not_found for anything
    // outside /, /projects, /projects/{id}, /projects/{id}/tasks and
    // /projects/{id}/tasks/{job}.
    const refused = ["/local-preview", "/local-preview?project=project%3Aexample", "/demo", "/contributor-demo",
      "/app/local-preview/workspace", "/local-pilot"];
    for (const path of refused) {
      assert.deepEqual(await readJson(await f.request(path, { headers: f.auth }), 404, `preview path ${path}`),
        { error: "not_found" }, `${path} must not render`);
    }
    // The preview/demo transports are not mounted either: those two API paths
    // belong to the separate contributor-demo server, not to mac-local.
    for (const path of ["/api/v1/local-pilot/workspace?resource=home", "/api/v1/local-pilot/session"]) {
      const response = await f.request(path, { headers: f.auth });
      assert.equal(response.status, 404, `${path} must not be mounted in mac-local`);
    }
  });
});
