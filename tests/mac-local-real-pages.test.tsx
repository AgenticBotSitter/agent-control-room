import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { promisify } from "node:util";
import React, { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import HomePage from "../private-app/app/page";
import ProjectPage from "../private-app/app/projects/[projectId]/page";
import ProjectTaskPage from "../private-app/app/projects/[projectId]/tasks/page";
import TaskPage from "../private-app/app/projects/[projectId]/tasks/[jobId]/page";
import ProjectsPage from "../private-app/app/projects/page";
import WorkersPage from "../private-app/app/workers/page";
import { LocalRuntimeContextV1 } from "../private-app/app/local-runtime";
import { sha256Digest } from "../src/security/canonical-digest";
import { createProjectBrowserClient } from "../src/web/v1/browser-client";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1, type MacLocalWebProcessOptionsV1 } from "../src/web/v1/mac-local-web-process";
import { createPrivateOwnerBootstrapCommand, type PrivateOwnerBootstrapConfiguration }
  from "../src/web/v1/private-owner-bootstrap";
import { createPrivatePostgresDatabase, type PrivatePostgresConfiguration } from "../src/web/v1/private-postgres";
import { createTaskBrowserClient } from "../src/web/v1/task-browser-client";
import type { AccessTrust } from "../src/web/v1/access-verifier";
import { conformanceNow, conformanceSubject, syntheticAccessTrust, syntheticAssertion, syntheticSigningKey }
  from "./helpers/private-owner-bootstrap-conformance";
import { openDisposableMacLocalDatabase } from "./helpers/mac-local-disposable-database";

const exec = promisify(execFile);
const PORT = 15_650;
const origin = "http://127.0.0.1:3210";
const ownerCode = "mac-local-real-pages-owner-code-000001";
const subject = conformanceSubject;
const nowMs = conformanceNow;

function resolvePostgresBin(): string | undefined {
  for (const directory of [process.env.PG_BIN, "/opt/homebrew/bin", "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/lib/postgresql/17/bin"].filter((value): value is string => !!value)) {
    if (["initdb", "pg_ctl", "postgres"].every(name => existsSync(join(directory, name)))) return directory;
  }
  return undefined;
}

const PG_BIN = resolvePostgresBin();
const needsPg = PG_BIN ? false : "needs PostgreSQL 17 binaries";
const execOptions = { timeout: 120_000, maxBuffer: 1 << 26, encoding: "utf8" as const };
type Cluster = Readonly<{ run: string; data: string; socket: string; pgCtl: string; password: string }>;
let cluster: Cluster | undefined;
let stopFailure: Error | undefined;

async function startCluster(): Promise<Cluster> {
  const run = await mkdtemp(join(tmpdir(), "cr-mac-local-real-pages-"));
  const data = join(run, "data"), socket = join(run, "socket");
  await mkdir(socket, { mode: 0o700 });
  const base = { env: { ...process.env, PATH: "/usr/bin:/bin:/opt/homebrew/bin", LC_ALL: "C", TMPDIR: run,
    NODE_ENV: "test" as const }, ...execOptions };
  try {
    await exec(join(PG_BIN!, "initdb"), ["-D", data, "-U", "fixture_admin", "-E", "UTF8", "--auth-local=trust"], base);
    const hba = join(data, "pg_hba.conf"), stock = await readFile(hba, "utf8");
    const patched = stock.replace(/^(host\s+all\s+all\s+127\.0\.0\.1\/32\s+)\S+(\s*)$/m,
      "host    all             all             127.0.0.1/32            scram-sha-256$2");
    assert.notEqual(patched, stock, "fixture must replace the stock loopback authentication rule");
    await writeFile(hba, patched, "utf8");
    await exec(join(PG_BIN!, "pg_ctl"), ["-D", data, "-o",
      `-p ${PORT} -k ${socket} -h 127.0.0.1 -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off`,
      "-l", join(run, "server.log"), "-w", "-t", "60", "start"], base);
    const password = "disposable-real-pages-password";
    await exec(join(PG_BIN!, "psql"), ["-h", socket, "-p", String(PORT), "-U", "fixture_admin", "-d", "postgres",
      "-Atc", `ALTER ROLE fixture_admin PASSWORD '${password}';`], execOptions);
    return { run, data, socket, pgCtl: join(PG_BIN!, "pg_ctl"), password };
  } catch (error) {
    await rm(run, { recursive: true, force: true });
    throw error;
  }
}

function postmasterPid(target: Cluster): number | undefined {
  try {
    const value = Number(execFileSync("/usr/bin/head", ["-n", "1", join(target.data, "postmaster.pid")], { encoding: "utf8" }).trim());
    return Number.isSafeInteger(value) && value > 1 ? value : undefined;
  } catch { return undefined; }
}

function postmasterAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try { return /\bpostgres\b/u.test(execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })); }
  catch { return false; }
}

async function stopCluster(target: Cluster) {
  const pid = postmasterPid(target);
  const stopped = await exec(target.pgCtl, ["-D", target.data, "-m", "immediate", "-w", "-t", "60", "stop"], execOptions)
    .then(() => true, (error: Error) => { stopFailure = error; return false; });
  if (!stopped && pid) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
    for (let attempt = 0; attempt < 20 && postmasterAlive(pid); attempt += 1)
      await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (postmasterAlive(pid)) throw new Error(`disposable_cluster_stop_failed:${stopFailure?.message ?? "still alive"}`);
  await rm(target.run, { recursive: true, force: true });
}

before(async () => { if (PG_BIN) cluster = await startCluster(); });
after(async () => { if (cluster) await stopCluster(cluster); });

type LocalStatus = Readonly<{ taskWorkersStarted: boolean; instruction?: string;
  projectSections: readonly ("overview" | "work" | "reviews" | "activity" | "files")[];
  workers: readonly Readonly<{ kind: string; state: "ready" | "unavailable"; proof: "proven" | "not_proven" }>[] }>;
type Journey = Readonly<{ app: ReturnType<typeof createMacLocalWebProcessV1>; cookie: string; status: LocalStatus;
  request(path: string, init?: RequestInit): Promise<Response>; fetch: typeof fetch }>;

async function journeyFixture(t: TestContext): Promise<Journey> {
  const active = cluster!;
  const database = await openDisposableMacLocalDatabase({ run: active.run, port: PORT, name: "realpages",
    fixtureUser: "fixture_admin", fixturePassword: active.password });
  const key = syntheticSigningKey(), trust: AccessTrust = syntheticAccessTrust(key, nowMs);
  const configuration: PrivateOwnerBootstrapConfiguration = {
    databaseName: database.name, tenantId: "tenant:real-pages", workspaceId: "workspace:real-pages",
    tenantDisplayName: "Disposable tenant", workspaceDisplayName: "Disposable workspace",
    identityId: "identity:synthetic-owner-real-pages", grantId: "grant:synthetic-owner-real-pages",
    displayName: "Synthetic owner", expectedOwnerSubjectDigest: sha256Digest({ provider: trust.issuer, subject }),
  };
  const pgConfig: PrivatePostgresConfiguration = { host: "127.0.0.1", port: PORT, database: database.name,
    username: "fixture_admin", password: active.password, majorVersion: 17 };
  const opened = createPrivatePostgresDatabase(pgConfig);
  const owner = await createPrivateOwnerBootstrapCommand({
    openDatabase: () => ({ client: opened.client, close: async () => {}, isAvailable: () => true }), clock: () => nowMs,
  })({ configuration, database: pgConfig, trust, assertion: syntheticAssertion(key) });
  assert.equal(owner.ownerCreated, true);
  const planning: NonNullable<MacLocalWebProcessOptionsV1["planning"]> = {
    supportsProject: () => true,
    async plan() { throw new Error("real_page_test_does_not_prepare_work"); },
    async readSaved() { return null; },
    async readPreparedWorker() { return null; },
    async readConfiguredLocalRoute() { return "not_configured"; },
    templatesForProject: () => [],
  };
  const app = createMacLocalWebProcessV1({ origin, workspaceId: configuration.workspaceId, clock: () => nowMs,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: configuration.tenantId,
      provider: trust.issuer, subject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: opened.client, close: async () => {} }, planning,
    workerReadiness: { read: () => [{ kind: "codex" as const, state: "ready" as const, proof: "proven" as const }] },
    taskWorkersStarted: true,
  });
  t.after(async () => { await app.close(); await opened.close(); await database.drop(); });
  const request = (path: string, init: RequestInit = {}) => app.handle(new Request(`${origin}${path}`, init),
    () => new Response("<!doctype html><div id=__next></div>", { headers: { "content-type": "text/html" } }));
  const signedIn = await request("/api/v1/local-owner-session", { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) });
  assert.equal(signedIn.status, 201);
  const cookie = signedIn.headers.get("set-cookie"); assert.ok(cookie);
  const workerResponse = await request("/api/v1/local-workers", { headers: { cookie } });
  assert.equal(workerResponse.status, 200);
  const status = await workerResponse.json() as LocalStatus;
  const browserFetch: typeof fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const source = input instanceof Request ? input : new Request(new URL(String(input), origin), init);
    const url = new URL(source.url), headers = new Headers(source.headers); headers.set("cookie", cookie);
    if (!["GET", "HEAD"].includes(source.method)) headers.set("origin", origin);
    const response = await app.handle(new Request(url, { method: source.method, headers,
      body: ["GET", "HEAD"].includes(source.method) ? undefined : source.body, duplex: source.body ? "half" : undefined,
      signal: source.signal } as RequestInit), () => new Response("page"));
    assert.ok(response.status < 400, `${source.method} ${url.pathname}${url.search} returned ${response.status}: ${await response.clone().text()}`);
    return response;
  };
  return { app, cookie, status, request, fetch: browserFetch };
}

type MountedPage = Readonly<{ dom: JSDOM; root: Root; errors: unknown[]; requests: readonly string[]; close(): Promise<void> }>;

async function mountPage(journey: Journey, path: string, element: ReactElement): Promise<MountedPage> {
  const errors: unknown[] = [], requests: string[] = [];
  const dom = new JSDOM("<!doctype html><div id=root></div>", { url: `${origin}${path}`, pretendToBeVisual: true });
  dom.window.addEventListener("error", event => { errors.push(event.error ?? event.message); });
  dom.window.addEventListener("unhandledrejection", event => { errors.push(event.reason); });
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    location: globalThis.location, fetch: globalThis.fetch,
    act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    location: dom.window.location });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const source = input instanceof Request ? input : new Request(new URL(String(input), origin), init);
    const url = new URL(source.url); requests.push(`${source.method} ${url.pathname}${url.search}`);
    try { return await journey.fetch(source); }
    catch (error) { errors.push(error); throw error; }
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => {
    root.render(createElement(LocalRuntimeContextV1.Provider, { value: { mode: "local", status: journey.status } }, element));
    await new Promise(resolve => dom.window.setTimeout(resolve, 25));
  });
  const close = async () => {
    await act(async () => { root.unmount(); }); dom.window.close();
    Object.assign(globalThis, previous);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previous.act;
  };
  return { dom, root, errors, requests, close };
}

function assertHealthyPage(page: MountedPage, expected: readonly RegExp[]) {
  assert.deepEqual(page.errors, [], `uncaught jsdom errors: ${page.errors.map(String).join("\n")}`);
  const text = page.dom.window.document.body.textContent ?? "";
  for (const pattern of expected) assert.match(text, pattern);
  assert.doesNotMatch(text, /not available|page unavailable|application error|error boundary/i);
  assert.equal(page.dom.window.document.querySelector('[role="alert"]'), null, text);
}

test("real Mac-local pages complete the signed-in project and task journey without hidden HTTP failures", { skip: needsPg }, async t => {
  const journey = await journeyFixture(t);
  const signIn = await journey.request("/session");
  assert.equal(signIn.status, 200); assert.match(await signIn.text(), /ownerCode/);

  const projectsRoute = await journey.request("/projects", { headers: { cookie: journey.cookie } });
  assert.equal(projectsRoute.status, 200);
  const projects = await mountPage(journey, "/projects", await ProjectsPage({ searchParams: Promise.resolve({}) }));
  try {
    assertHealthyPage(projects, [/Projects/, /New project/]);
    assert.ok(projects.requests.includes("GET /api/v1/projects"));
  } finally { await projects.close(); }

  const projectClient = createProjectBrowserClient(journey.fetch, () => "realpagesproject0001");
  const project = await projectClient.create({ title: "Real page journey", summary: "Disposable real-page coverage" });
  const projectView = await mountPage(journey, `/projects/${encodeURIComponent(project.projectId)}`,
    await ProjectPage({ params: Promise.resolve({ projectId: encodeURIComponent(project.projectId) }) }));
  try {
    assertHealthyPage(projectView, [/Real page journey/, /Purpose/, /Work/]);
    assert.ok(projectView.requests.some(value => value.startsWith("GET /api/v1/projects/")));
  } finally { await projectView.close(); }

  const work = await mountPage(journey, `/projects/${encodeURIComponent(project.projectId)}/tasks`,
    await ProjectTaskPage({ params: Promise.resolve({ projectId: encodeURIComponent(project.projectId) }), searchParams: Promise.resolve({}) }));
  try { assertHealthyPage(work, [/Saved tasks/, /Propose a task/]); } finally { await work.close(); }

  const taskClient = createTaskBrowserClient(journey.fetch, () => "realpagestask0000001");
  const receipt = await taskClient.propose(project.projectId,
    { title: "Real-page task", instructions: "Return one harmless short line." });
  const task = await mountPage(journey, `/projects/${encodeURIComponent(project.projectId)}/tasks/${encodeURIComponent(receipt.jobId)}`,
    await TaskPage({ params: Promise.resolve({ projectId: encodeURIComponent(project.projectId), jobId: encodeURIComponent(receipt.jobId) }) }));
  try {
    assertHealthyPage(task, [/Real-page task/, /Prepare task/, /Task assignment/, /Execution approval/]);
    assert.ok(task.requests.some(value => value.endsWith("/plan")), "the real preparation panel must execute its client read");
  } finally { await task.close(); }

  const workers = await mountPage(journey, "/workers", createElement(WorkersPage));
  try { assertHealthyPage(workers, [/Workers on this Mac/, /Codex/, /Status: ready/]); } finally { await workers.close(); }

  const home = await mountPage(journey, "/", createElement(HomePage));
  try { assertHealthyPage(home, [/Running work/, /Needs attention/, /Worker status/]); } finally { await home.close(); }
});
