import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import { createProjectOrchestrationServiceV1 } from "../src/web/v1/project-orchestration-composition";
import { OperatorSurfaceStoreV1 } from "../src/operator-surfaces/v1/store";
import type { ResultFileStoreV1 } from "../src/artifacts/v1/result-file-store";
import { UPDATER_HOME_STATUS_SCHEMA_V1 } from "../src/web/v1/updater-home-status";
import type { AccessTrust } from "../src/web/v1/access-verifier";
import { conformanceNow, conformanceSubject, syntheticAccessTrust, syntheticAssertion, syntheticSigningKey }
  from "./helpers/private-owner-bootstrap-conformance";
import { openDisposableMacLocalDatabase } from "./helpers/mac-local-disposable-database";
// The shared disposable-cluster teardown. `.mjs` because
// `scripts/ops/verify-database-backup.mjs` imports it with bare `node`, and a
// `.ts` module could not be imported by one of its own callers.
import { createClusterTeardown } from "../scripts/dev/postgres-cluster-lifecycle.mjs";

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
/** The shared teardown, created before `initdb` and released by `stopCluster`. */
let teardown: ReturnType<typeof createClusterTeardown> | undefined;

async function startCluster(): Promise<Cluster> {
  const run = await mkdtemp(join(tmpdir(), "cr-mac-local-real-pages-"));
  const data = join(run, "data"), socket = join(run, "socket");
  await mkdir(socket, { mode: 0o700 });
  const base = { env: { ...process.env, PATH: "/usr/bin:/bin:/opt/homebrew/bin", LC_ALL: "C", TMPDIR: run,
    NODE_ENV: "test" as const }, ...execOptions };
  // Registered BEFORE initdb, and that ordering is the fix. `pg_ctl start` runs
  // the postmaster with `setsid`, so it is its own session leader with PPID 1: a
  // group signal from a bounded runner cannot reach it, and this lane used to
  // have no SIGINT/SIGTERM handler at all. A lane stopped at its bound, or a
  // Ctrl-C, skipped `after()` and left a postmaster holding a 56-byte SysV
  // shared-memory segment. This machine has 32 of those in total.
  teardown = createClusterTeardown({ dataDirectory: data, runDirectory: run,
    socketDirectory: socket, port: PORT, pgBin: PG_BIN! });
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
    // Retained while the cluster is up, so the teardown has a pid even if the
    // lane throws before its own bookkeeping records one.
    await teardown?.capturePostmasterPid();
    const password = "disposable-real-pages-password";
    await exec(join(PG_BIN!, "psql"), ["-h", socket, "-p", String(PORT), "-U", "fixture_admin", "-d", "postgres",
      "-Atc", `ALTER ROLE fixture_admin PASSWORD '${password}';`], execOptions);
    return { run, data, socket, pgCtl: join(PG_BIN!, "pg_ctl"), password };
  } catch (error) {
    // A start that got as far as a live postmaster and then failed must not hand
    // back a run directory with a cluster still in it. The teardown refuses to
    // delete the evidence if the postmaster will not stop, and names the pid.
    // The old `rm` here deleted the data directory out from under a running
    // postmaster, which is how a leaked segment became unreapable.
    await teardown?.stop();
    throw error;
  }
}

/**
 * Stop the cluster and prove it is gone before the data directory is removed.
 *
 * The `-m immediate` that used to lead is now the ladder's SECOND step, and the
 * `SIGKILL` that used to end it is now its last. Both moves matter: a postmaster
 * creates one 56-byte SysV shared-memory segment and releases it on any
 * shutdown that runs its exit path, and SIGKILL cannot run one. This machine has
 * 32 such segments in total, so a SIGKILL here cost the machine a segment on
 * every run whose `pg_ctl` did not succeed. `-m fast` releases it, and
 * `-m immediate` still does, so the common case now ends after one command.
 */
async function stopCluster(target: Cluster) {
  await teardown?.stop();
}

before(async () => { if (PG_BIN) cluster = await startCluster(); });
after(async () => { if (cluster) await stopCluster(cluster); });

type LocalStatus = Readonly<{ taskWorkersStarted: boolean; instruction?: string;
  projectSections: readonly ("overview" | "work" | "reviews" | "activity" | "files")[];
  workers: readonly Readonly<{ kind: string; state: "ready" | "unavailable"; proof: "proven" | "not_proven" }>[] }>;
type Journey = Readonly<{ app: ReturnType<typeof createMacLocalWebProcessV1>; cookie: string; status: LocalStatus;
  request(path: string, init?: RequestInit): Promise<Response>; fetch: typeof fetch }>;

/**
 * Reads a page may legitimately get a 404 for, because the route is mounted only
 * when the installation has that capability and the caller degrades on a
 * non-ok answer. Every entry names the component and what it does with the 404.
 *
 * A test that adds to this list has to name both, or it has quietly stopped
 * proving that page -- which is the whole point of the guard.
 */
const OPTIONAL_CAPABILITY_PROBES: ReadonlyMap<string, string> = new Map([
  // private-app/app/workers/fleet-offer.tsx -- `setEnabled(response.ok)`, hides
  // itself. Mounted only when `options.fleet` configures the gateway.
  ["/api/v1/fleet", "FleetOfferControl reads response.ok"],
  // src/web/v1/worker-scorecard-browser-client.ts -- returns
  // `{ state: "unavailable" }` for any non-ok response.
  ["/api/v1/workers-scorecard", "readWorkerScorecardV1 returns state: unavailable"],
  // private-app/app/update-candidates-home.tsx -- `status === 404` throws
  // NotConfigured and the desk reports "not_configured".
  ["/api/v1/update-candidates", "update-candidates-home reports not_configured"],
  // src/web/v1/operations-mode-browser-client.ts -- a 404 maps to
  // BrowserRequestError("not_found"). Mounted only with an operations-mode key.
  ["/api/v1/operations-mode", "operations-mode browser client maps 404 to not_found"],
  // src/web/v1/updater-owner-ui-browser.ts -- `status === 404` returns
  // `{ state: "not_configured" }`. Mounted only with `options.updaterOwnerUi`,
  // which the installed updater supplies and this page-journey fixture does not.
  ["/api/v1/updater-owner-ui", "readUpdaterOwnerUiV1 returns state: not_configured"],
]);

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
    database: { client: opened.client, close: async () => {}, isAvailable: () => true }, planning,
    workerReadiness: { read: () => [{ kind: "codex" as const, state: "ready" as const, proof: "proven" as const }] },
    taskWorkersStarted: true,
    // The installed host always mounts the updater status card's route. A fixture
    // reader keeps this test off the owner's real status file (the default reader
    // reads UPDATER_PUBLIC_ROOT_V1) and reports an idle, healthy updater, so the
    // home page has no "Self-update needs your attention" alert to excuse.
    updaterHomeStatus: { read: async () => ({ schema: UPDATER_HOME_STATUS_SCHEMA_V1, state: "healthy" as const }) },
    // Mount the installed host's DB-backed catalog. This journey publishes no
    // file bytes; the byte-store port stays empty on both macOS and Linux.
    resultFileStore: { read: async () => undefined } as unknown as ResultFileStoreV1,
    taskReadKeys: { harnessIntegrityKey: new Uint8Array(32).fill(7) },
    // Match the installed host's durable settings service, without a planner.
    orchestration: createProjectOrchestrationServiceV1({ db: opened.client,
      tenantId: configuration.tenantId, workspaceId: configuration.workspaceId,
      queueCatalog: [], integrityKey: new Uint8Array(32).fill(7), clock: () => nowMs }),
    // The installed host always passes the task application's Action Inbox source
    // (mac-local-task-application.ts), and every page's header now reads it
    // (r6ibfix's shared attention). Built here the same way, over this fixture's
    // real database, so the header reads a real, empty, complete inbox rather than
    // a 404 the installed product never answers.
    actionInboxSource: { read: async scope => {
      const items = await new OperatorSurfaceStoreV1(opened.client).listInbox({ tenantId: scope.tenantId, state: "open", limit: 500 });
      return { observedAt: scope.now, items, truncated: items.length === 500 };
    } },
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
    // A 404 is a legitimate answer on an OPTIONAL capability, and the two the
    // product ships both read the route on mount precisely to find out whether the
    // installation has it, then hide themselves when it does not:
    //
    //  - `/api/v1/fleet` (FleetOfferControl) checks `response.ok`. The route is
    //    only mounted when the gateway is configured
    //    (mac-local-web-process.ts: `options.fleet ? createFleetOwnerHttpHandlerV1
    //    (...) : undefined`), and this fixture builds the host without it.
    //  - `/api/v1/workers-scorecard` (readWorkerScorecardV1) returns
    //    `{ state: "unavailable" }` for any non-ok response, including 404 and
    //    also 401, so it degrades by design.
    //
    // What this guard is FOR is everything else: a page that fetches a route the
    // installation does serve, or that gets a 500, is a hidden failure. The
    // exemption is exactly these two paths, read-only, and only for 404 -- a typo
    // in any other path, or a 500 on either of these, still trips it.
    const optionalCapabilityProbe = OPTIONAL_CAPABILITY_PROBES.has(url.pathname)
      && ["GET", "HEAD"].includes(source.method);
    assert.ok(response.status < 400 || (optionalCapabilityProbe && response.status === 404),
      `${source.method} ${url.pathname}${url.search} returned ${response.status}: ${await response.clone().text()}`);
    return response;
  };
  return { app, cookie, status, request, fetch: browserFetch };
}

type MountedPage = Readonly<{ dom: JSDOM; root: Root; errors: unknown[]; requests: readonly string[]; close(): Promise<void> }>;

async function mountPage(journey: Journey, path: string, element: ReactElement): Promise<MountedPage> {
  const errors: unknown[] = [], requests: string[] = [];
  let pendingRequests = 0;
  const dom = new JSDOM("<!doctype html><div id=root></div>", { url: `${origin}${path}`, pretendToBeVisual: true });
  dom.window.addEventListener("error", event => { errors.push(event.error ?? event.message); });
  dom.window.addEventListener("unhandledrejection", event => { errors.push(event.reason); });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const installGlobal = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  installGlobal("window", dom.window);
  installGlobal("document", dom.window.document);
  installGlobal("navigator", dom.window.navigator);
  installGlobal("location", dom.window.location);
  installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const source = input instanceof Request ? input : new Request(new URL(String(input), origin), init);
    const url = new URL(source.url); requests.push(`${source.method} ${url.pathname}${url.search}`);
    pendingRequests++;
    try { return await journey.fetch(source); }
    catch (error) { errors.push(error); throw error; }
    finally { pendingRequests--; }
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => { root.render(createElement(LocalRuntimeContextV1.Provider,
    { value: { mode: "local", status: journey.status } }, element)); });
  let quietChecks = 0, previousCount = -1;
  for (let attempt = 0; attempt < 100 && quietChecks < 2; attempt += 1) {
    await act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 10)); });
    if (pendingRequests === 0 && requests.length === previousCount) quietChecks++;
    else quietChecks = 0;
    previousCount = requests.length;
  }
  assert.equal(pendingRequests, 0, `${path} still had client reads after the bounded render wait`);
  const close = async () => {
    await act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return { dom, root, errors, requests, close };
}

function assertHealthyPage(page: MountedPage, expected: readonly RegExp[]) {
  assert.deepEqual(page.errors, [], `uncaught jsdom errors: ${page.errors.map(String).join("\n")}`);
  const text = page.dom.window.document.body.textContent ?? "";
  for (const pattern of expected) assert.match(text, pattern);
  // A page that failed to render is the thing this is for. An HONEST capability
  // message is not: `OperationsControlPanel` is mounted unconditionally and
  // reads `/api/v1/operations-mode` on mount, and that route is only mounted when
  // the installation supplies the service (mac-local-host.ts: `...(service ?
  // { operationsMode: service } : {})`). Without it the panel says it could not
  // read the state and offers only "read it again" -- a deliberate refusal to
  // show a mode it did not read, and the correct answer for this fixture, which
  // builds the host without that service.
  //
  // So the patterns are about the PAGE, not about any one panel's honest wording.
  // "not available" as a bare phrase was matching "This project is not
  // available.", which is the browser client's 404 text for a genuine missing
  // route -- which the 404 exemption above already covers deliberately.
  assert.doesNotMatch(text, /page unavailable|application error|error boundary|this page (?:is|could not)/i);
  // The alert TEXTS, not the elements: a failing `assert.equal` on a live JSDOM
  // element makes node format the element and its whole window, which grew to
  // ~15 GB here before macOS killed the lane.
  const alerts = [...page.dom.window.document.querySelectorAll('[role="alert"]')].map(alert => alert.textContent ?? "");
  assert.deepEqual(alerts, [], `${page.dom.window.location.pathname} shows role=alert: ${text.slice(0, 300)}`);
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
  const projectPath = `/projects/${encodeURIComponent(project.projectId)}`;
  assert.equal((await journey.request(projectPath, { headers: { cookie: journey.cookie } })).status, 200);
  const projectView = await mountPage(journey, projectPath,
    await ProjectPage({ params: Promise.resolve({ projectId: encodeURIComponent(project.projectId) }) }));
  try {
    assertHealthyPage(projectView, [/Real page journey/, /Purpose/, /Tasks/]);
    assert.ok(projectView.requests.some(value => value.startsWith("GET /api/v1/projects/")));
  } finally { await projectView.close(); }

  const workPath = `/projects/${encodeURIComponent(project.projectId)}/tasks`;
  assert.equal((await journey.request(workPath, { headers: { cookie: journey.cookie } })).status, 200);
  const work = await mountPage(journey, workPath,
    await ProjectTaskPage({ params: Promise.resolve({ projectId: encodeURIComponent(project.projectId) }), searchParams: Promise.resolve({}) }));
  try { assertHealthyPage(work, [/Saved tasks/, /New task/]); } finally { await work.close(); }

  const taskClient = createTaskBrowserClient(journey.fetch, () => "realpagestask0000001");
  const receipt = await taskClient.propose(project.projectId,
    { title: "Real-page task", instructions: "Return one harmless short line." });
  const taskPath = `/projects/${encodeURIComponent(project.projectId)}/tasks/${encodeURIComponent(receipt.jobId)}`;
  assert.equal((await journey.request(taskPath, { headers: { cookie: journey.cookie } })).status, 200);
  const task = await mountPage(journey, taskPath,
    await TaskPage({ params: Promise.resolve({ projectId: encodeURIComponent(project.projectId), jobId: encodeURIComponent(receipt.jobId) }) }));
  try {
    // The installed Mac host is connector-only: its task routes answer
    // dispatch "not_connected", so the page offers work to connected bots and
    // must not show the hosted Prepare / Assign / Approve dead ends.
    assertHealthyPage(task, [/Real-page task/, /Send this task to a bot/, /Offer to other machines/]);
    assert.doesNotMatch(task.dom.window.document.body.textContent ?? "", /Task assignment|Execution approval/u,
      "the connector-only Mac must not show hosted planning panels");
    assert.ok(task.requests.includes(`GET /api/v1/projects/${encodeURIComponent(project.projectId)}/result-files?job=${encodeURIComponent(receipt.jobId)}`),
      "the task page must read the installed result-file catalog route");
  } finally { await task.close(); }

  assert.equal((await journey.request("/workers", { headers: { cookie: journey.cookie } })).status, 200);
  const workers = await mountPage(journey, "/workers", createElement(WorkersPage));
  try { assertHealthyPage(workers, [/Workers on this Mac/, /Codex/, /Startup check passed/, /result proof recorded this host run/]); }
  finally { await workers.close(); }

  assert.equal((await journey.request("/", { headers: { cookie: journey.cookie } })).status, 200);
  const home = await mountPage(journey, "/", createElement(HomePage));
  try { assertHealthyPage(home, [/Running work/, /Needs attention/, /Worker status/]); } finally { await home.close(); }
});
