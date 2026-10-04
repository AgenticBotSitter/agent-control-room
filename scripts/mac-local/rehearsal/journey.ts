// Package 6b: the disposable PG17 rehearsal the website actually serves, driven only
// through the same HTTP API the website uses.
//
// The installed Mac is CONNECTOR-ONLY (start-web-host.mjs `connectorOnly: true`):
// it builds no planner, no assignment coordinator and no queue, so its bots are
// fleet connector workers and an owner's task reaches one only as an offer
// claimed through the gateway. This journey therefore drives propose -> offer ->
// claim -> result -> owner decision -> completed, through the real connector
// client against the real signed connector release, and proves both PG17
// lock-order collisions against the fleet rows that path writes.
//
// Usage: node --import tsx scripts/mac-local/rehearsal/journey.ts ABSOLUTE_REHEARSAL_DIR
//   [--browser-proof|--browser-e2e|--browser-owner-e2e|--browser-adversarial-e2e|--browser-phone-width-e2e|--model-allowlists]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Client } from "pg";
import { connectTarget } from "../../../deploy/postgres/evidence.mjs";
import { applyMacLocalFirstOwnerV1 } from "../first-owner-vps.mjs";
import { serviceInstalled } from "../service.mjs";
import { removeRehearsalConnectorAdvertisementV1, signRehearsalConnectorReleaseV1 } from "./sign-connector-release";
import { connectBotForJourney, deliverForJourney, removeJourneyConnectorWorkspacesV1 } from "./journey-connector-route";
import { runMacLocalJourneyV1 } from "./journey-lifecycle";

const [arg, mode] = process.argv.slice(2);
if (!arg || ![3, 4].includes(process.argv.length) || mode !== undefined && !["--browser-proof", "--browser-e2e",
  "--browser-owner-e2e", "--browser-adversarial-e2e", "--browser-phone-width-e2e", "--model-allowlists"].includes(mode)
  || !isAbsolute(arg) || resolve(arg) !== arg) {
  process.stderr.write("usage: node --import tsx scripts/mac-local/rehearsal/journey.ts ABSOLUTE_REHEARSAL_DIR [--browser-proof|--browser-e2e|--browser-owner-e2e|--browser-adversarial-e2e|--browser-phone-width-e2e|--model-allowlists]\n");
  process.exit(2);
}
const root = resolve(arg), protectedRoot = join(root, "protected");
const pgBin = process.env.PG_BIN;
if (pgBin !== undefined && (!isAbsolute(pgBin) || resolve(pgBin) !== pgBin)) {
  throw new Error("rehearsal_pg_bin_must_be_absolute");
}
const pgExecutable = (name: string) => pgBin ? join(pgBin, name) : name;
let verifiedThisRehearsalCluster = false;
let stackMayBeUp = false;
let signedConnectorRelease = false;
let stoppingDatabase = false;
let journeySignal: AbortSignal;

function invoke(args: string[]) {
  journeySignal.throwIfAborted();
  return spawnSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: process.cwd(), encoding: "utf8", timeout: 180_000,
    env: { ...process.env, CONTROL_ROOM_PROTECTED_ROOT: protectedRoot },
  });
}
function journeyFetch(input: string | URL, init?: RequestInit) {
  journeySignal.throwIfAborted();
  return fetch(input, { ...init, signal: journeySignal });
}
async function writeJsonPrivate(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function waitFor(check: () => Promise<boolean>, seconds: number) {
  for (let i = 0; i < seconds * 2; i++) {
    journeySignal.throwIfAborted();
    if (await check()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const config = JSON.parse(await readFile(join(protectedRoot, "config/mac-local.json"), "utf8"));
  const roleMap = JSON.parse(await readFile(join(protectedRoot, "config/database-roles.json"), "utf8"));
  if (config?.database?.host !== "127.0.0.1" || config.database.database !== "control_room"
    || config.database.majorVersion !== 17 || !Number.isInteger(config.database.port)
    || config.port === 3210 || !Number.isInteger(config.port)
    || roleMap?.coordinator?.host !== "127.0.0.1" || roleMap.coordinator.port !== config.database.port
    || roleMap.coordinator.database !== "control_room") throw new Error("rehearsal_database_scope_refused");
  if (await serviceInstalled()) throw new Error("rehearsal_refused_existing_launchd_service");
  if (!existsSync(join(protectedRoot, "config/task-runtime.json")))
    throw new Error("journey_requires_mac_prepare_task_runtime_first");

  const target = `host=127.0.0.1 port=${config.database.port} dbname=control_room user=postgres`;
  const admin = connectTarget(target);
  await admin.connect();
  try {
    const identity = (await admin.query<{ data_directory: string; version_num: number; current_user: string; current_database: string }>(
      "SELECT current_setting('data_directory') AS data_directory,current_setting('server_version_num')::int AS version_num,current_user,current_database() AS current_database")).rows[0];
    if (resolve(identity?.data_directory ?? "") !== resolve(root, "pg")
      || Math.floor((identity?.version_num ?? 0) / 10_000) !== 17
      || identity?.current_user !== "postgres" || identity.current_database !== "control_room")
      throw new Error("rehearsal_database_scope_refused");
    verifiedThisRehearsalCluster = true;
  } finally { await admin.end(); }

  const coordinator = new Client({ host: roleMap.coordinator.host, port: roleMap.coordinator.port,
    database: roleMap.coordinator.database, user: roleMap.coordinator.username, password: roleMap.coordinator.password,
    connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
  await coordinator.connect();
  try {
    const roleName = (await coordinator.query<{ current_user: string }>("SELECT current_user")).rows[0]?.current_user;
    if (roleName !== roleMap.coordinator.username) throw new Error("completion_gate_coordinator_role_mismatch");
    for (const table of ["control_completion_gate_integrity", "control_completion_gate_records"])
      await coordinator.query(`SELECT tenant_id FROM ${table} WHERE false`);
  } catch { throw new Error("STOP: coordinator lacks SELECT on a completion-gate table; do not widen grants or provision the tenant"); }
  finally { await coordinator.end(); }

  // The connector-only host never spawns a pinned local executable, so this
  // rehearsal writes no fakes. Bots are real connector clients driven below.

  // First-owner setup: the minimal positive path (see section13.ts for the
  // negative/fault-injection coverage of this same sequence).
  const manifestOut = join(root, "first-owner-manifest.json");
  const generate = invoke(["scripts/mac-local/first-owner-manifest.mjs", protectedRoot, manifestOut]);
  assert.equal(generate.status, 0, generate.stderr || generate.stdout);
  const manifest = JSON.parse(await readFile(join(protectedRoot, "config/first-owner-manifest.json"), "utf8"));
  const vps = new Client({ host: "127.0.0.1", port: config.database.port, database: "control_room", user: "postgres",
    connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 30_000 });
  await vps.connect();
  let receipt: Awaited<ReturnType<typeof applyMacLocalFirstOwnerV1>>;
  try { receipt = await applyMacLocalFirstOwnerV1(vps, manifest); }
  finally { await vps.end(); }
  const receiptPath = join(protectedRoot, "config/first-owner-receipt.json");
  await writeJsonPrivate(receiptPath, receipt);
  const complete = invoke(["scripts/mac-local/complete-first-owner.mjs", protectedRoot, receiptPath]);
  assert.equal(complete.status, 0, complete.stderr || complete.stdout);

  // The installed Mac runs a fleet gateway from a signed connector release, and
  // its bots reach work only through it. Sign this rehearsal's release so
  // `mac:up` starts the same gateway instead of a website no bot can join.
  signedConnectorRelease = true;
  await signRehearsalConnectorReleaseV1(root);
  const upArgs = ["scripts/mac-local/up.mjs", "--protected-root", protectedRoot];

  // Start with no active project, then create the first project through the
  // real HTTP boundary. The running task host must prepare it without restart.
  stackMayBeUp = true;
  const start1 = invoke(upArgs);
  assert.equal(start1.status, 0, start1.stderr || start1.stdout);
  const ownerCode = (await readFile(join(protectedRoot, "config/owner-sign-in.txt"), "utf8")).trim();
  const origin = `http://127.0.0.1:${config.port}`;
  const signIn = async () => {
    const response = await journeyFetch(new URL("/api/v1/local-owner-session", origin), {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) });
    assert.equal(response.status, 201, "local disposable owner sign-in should succeed");
    const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
    assert.ok(cookie.startsWith("control_room_local_owner="));
    return cookie;
  };
  if (["--browser-e2e", "--browser-owner-e2e", "--browser-adversarial-e2e", "--browser-phone-width-e2e"].includes(mode ?? "")) {
    const browserScript = mode === "--browser-owner-e2e" ? "test:mac-local-owner-journey-browser"
      : mode === "--browser-adversarial-e2e" ? "test:adversarial-owner-browser"
      : mode === "--browser-phone-width-e2e" ? "test:owner-phone-width-browser" : "test:mac-local-owner-browser";
    const browser = spawnSync("pnpm", ["run", browserScript], {
      cwd: process.cwd(), encoding: "utf8", timeout: 25 * 60_000, stdio: "inherit",
      env: { ...process.env, CONTROL_ROOM_E2E_ORIGIN: origin, CONTROL_ROOM_E2E_OWNER_CODE: ownerCode,
        CONTROL_ROOM_E2E_ROOT: root },
    });
    assert.equal(browser.status, 0, `owner browser journey failed with status ${browser.status}`);
    return;
  }
  let cookie = await signIn();
  const projectResponse = await journeyFetch(new URL("/api/v1/projects", origin), {
    method: "POST", headers: { origin, cookie, "content-type": "application/json", "idempotency-key": "journey-rehearsal-project" },
    body: JSON.stringify({ title: "Post-startup journey project", summary: "One task per local agent." }),
  });
  const { project } = await require5xxOr201(projectResponse, "create project") as { project: { projectId: string } };
  const projectId = project.projectId;

  const idOf = (value: string) => encodeURIComponent(value);
  // The installed Mac is CONNECTOR-ONLY (start-web-host.mjs `connectorOnly:
  // true`): its workers are fleet connector bots the owner connects, and a task
  // reaches one only as an offer claimed through the gateway. There is no local
  // worker roster to be "ready" and no /plan route to prepare against, so this
  // journey drives the route the Mac really has -- the same route the browser
  // suites drive -- instead of the removed direct one.
  const fleetBoardResponse = await journeyFetch(new URL("/api/v1/fleet", origin), { headers: { cookie } });
  assert.equal(fleetBoardResponse.status, 200, "the connector-only host must serve the fleet board");
  const fleetBoard = await fleetBoardResponse.json() as { workers: unknown[]; pendingCodes: unknown[];
    gatewayConfigured: boolean };
  assert.ok(Array.isArray(fleetBoard.workers) && Array.isArray(fleetBoard.pendingCodes),
    `the fleet board must list workers and codes: ${JSON.stringify(fleetBoard)}`);
  assert.equal(fleetBoard.gatewayConfigured, true,
    "a signed connector release and a running gateway are what make a bot reachable");
  // The dead-end steps this host does not have must answer honestly, not as a
  // dead end the owner could follow. The plan route is mounted and reports its
  // own availability; the assignment and submission routes are not mounted.
  // Probed against the real project and a real proposed task, because a
  // fabricated job id would 404 for a reason that proves nothing here.
  const probeTask = await require5xxOr201(await journeyFetch(new URL(
    `/api/v1/projects/${idOf(projectId)}/tasks`, origin), {
    method: "POST", headers: { origin, cookie, "content-type": "application/json",
      "idempotency-key": "journey-default-probe-0001" },
    body: JSON.stringify({ title: "Journey preflight probe", instructions: "Return one harmless short line." }),
  }), "connector-only preflight probe") as { receipt: { jobId: string } };
  const planProbe = await requireOk(await journeyFetch(new URL(
    `/api/v1/projects/${idOf(projectId)}/tasks/${idOf(probeTask.receipt.jobId)}/plan`, origin),
    { headers: { cookie } }), 200, "connector-only plan probe") as { availability: string; templates?: unknown[] };
  assert.equal(planProbe.availability, "not_configured");
  assert.ok(!planProbe.templates || planProbe.templates.length === 0,
    "there is no local worker roster to choose from on this host");
  for (const [label, path] of [
    ["assignment", `/api/v1/projects/${idOf(projectId)}/tasks/${idOf(probeTask.receipt.jobId)}/assignment`],
    ["submission", `/api/v1/projects/${idOf(projectId)}/tasks/${idOf(probeTask.receipt.jobId)}/submission`],
  ] as const) {
    const gone = await journeyFetch(new URL(path, origin), { headers: { cookie } });
    assert.ok(gone.status >= 400, `${label} must not be served on a connector-only host: ${await gone.text()}`);
  }

  if (mode === "--browser-proof") {
    process.stdout.write(`Isolated built-page browser proof ready at ${origin}/projects. Press Return in this runner after the proof to shut down its host and database.\n`);
    await once(process.stdin, "data", { signal: journeySignal });
    return;
  }

  const outcomes: Record<string, unknown> = {};

  // The connector-only Mac's own journey: an owner saves a task, offers it, a
  // real connector bot claims it through the gateway and returns a result, and
  // the owner decides on it. This is the same chain the browser suites drive, so
  // this mode is not a second opinion about a route that no longer exists.
  const firstBot = await connectBotForJourney({ origin, cookie, projectId, name: "Journey default bot" });
  const defaultTask = await require5xxOr201(await journeyFetch(new URL(
    `/api/v1/projects/${idOf(projectId)}/tasks`, origin), {
    method: "POST", headers: { origin, cookie, "content-type": "application/json",
      "idempotency-key": "journey-default-source-0001" },
    body: JSON.stringify({ title: "Journey default task", instructions: "Return one harmless short line." }),
  }), "default journey propose") as { receipt: { jobId: string } };
  const defaultJobId = defaultTask.receipt.jobId;
  // The direct preparation steps must not lead anywhere on this host. The plan
  // route is mounted and reports its own availability honestly; the assignment
  // and submission routes are not mounted at all. What must never happen is one
  // of them offering a choice the owner could take.
  const planOptions = await requireOk(await journeyFetch(new URL(
    `/api/v1/projects/${idOf(projectId)}/tasks/${idOf(defaultJobId)}/plan`, origin), { headers: { cookie } }),
    200, "connector journey plan options") as { availability: string; templates?: unknown[] };
  assert.equal(planOptions.availability, "not_configured",
    `a connector-only host must not offer a local worker: ${JSON.stringify(planOptions)}`);
  assert.ok(!planOptions.templates || planOptions.templates.length === 0,
    "there is no local worker roster to choose from on this host");
  for (const [label, path] of [
    ["assignment", `/api/v1/projects/${idOf(projectId)}/tasks/${idOf(defaultJobId)}/assignment`],
    ["submission", `/api/v1/projects/${idOf(projectId)}/tasks/${idOf(defaultJobId)}/submission`],
  ] as const) {
    const gone = await journeyFetch(new URL(path, origin), { headers: { cookie } });
    assert.ok(gone.status >= 400, `${label} must not be served on a connector-only host: ${await gone.text()}`);
  }
  const offered = await requireOk(await journeyFetch(new URL("/api/v1/fleet/offers", origin), {
    method: "POST", headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({ projectId, jobId: defaultJobId, capability: "code.change" }),
  }), 201, "connector journey offer") as { offerId: string };
  // A replay of the same offer is the same offer, not a second one.
  const offerReplay = await requireOk(await journeyFetch(new URL("/api/v1/fleet/offers", origin), {
    method: "POST", headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({ projectId, jobId: defaultJobId, capability: "code.change" }),
  }), 201, "connector journey offer replay") as { offerId: string; replayed: boolean };
  assert.equal(offerReplay.offerId, offered.offerId, "an exact replay must return the same offer");
  assert.equal(offerReplay.replayed, true);

  const offerLedger = connectTarget(target);
  await offerLedger.connect();
  let offerRows: string;
  try {
    offerRows = (await offerLedger.query<{ n: string }>("SELECT count(*)::text AS n FROM fleet_work_offers"
      + " WHERE tenant_id=$1 AND job_id=$2", [config.localOwnerSession.tenantId, defaultJobId])).rows[0]!.n;
  } finally { await offerLedger.end(); }
  assert.equal(offerRows, "1", "two identical owner gestures must record exactly one offer");

  await deliverForJourney({ bot: firstBot, jobId: defaultJobId, answer: "One harmless line.", key: "journey-default-0001" });

  // The owner's decision, recorded by the production service and applied by the
  // production gateway reconciler. The web host has no hook into the separate
  // gateway process, so the task settles on the gateway's reconcile timer.
  // A poll that opens and closes its own connection each round. The cluster is
  // stopped by this journey's own teardown, so a probe interrupted mid-flight by
  // the administrator is a fact about teardown, not a journey failure, and must
  // not escape as an unhandled 'error' event.
const probeJobState = async (jobId: string): Promise<string | undefined> => {
  const probe = connectTarget(target);
  try { await probe.connect(); } catch { return undefined; }
  probe.on("error", () => {});
  try {
    return (await probe.query<{ state: string }>("SELECT state FROM control_jobs WHERE tenant_id=$1 AND id=$2",
      [config.localOwnerSession.tenantId, jobId])).rows[0]?.state;
  } catch { return undefined; }
  finally { await probe.end().catch(() => {}); }
};

  const waitingForOwner = await waitFor(async () =>
    (await probeJobState(defaultJobId)) === "waiting_approval", 90);
  assert.ok(waitingForOwner, "a returned result must reach the owner");
  const board = await requireOk(await journeyFetch(new URL("/api/v1/fleet", origin), { headers: { cookie } }),
    200, "connector journey board") as { results: { resultId: string; jobId: string; decision: string | null }[] };
  const result = board.results.find(item => item.jobId === defaultJobId);
  assert.ok(result, `the owner's result list must show the returned result: ${JSON.stringify(board.results)}`);
  const reviewed = await requireOk(await journeyFetch(new URL(
    `/api/v1/fleet/results/${idOf(result.resultId)}/review`, origin), {
    method: "POST", headers: { origin, cookie, "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
    body: JSON.stringify({ decision: "accepted" }),
  }), 200, "connector journey owner decision") as { reviewId: string; decision: string; replayed: boolean };
  assert.equal(reviewed.decision, "accepted");
  assert.equal(reviewed.replayed, false);
  // The same decision again is a replay of one row, not a second decision.
  const reviewReplay = await requireOk(await journeyFetch(new URL(
    `/api/v1/fleet/results/${idOf(result.resultId)}/review`, origin), {
    method: "POST", headers: { origin, cookie, "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
    body: JSON.stringify({ decision: "accepted" }),
  }), 200, "connector journey owner decision replay") as { reviewId: string; replayed: boolean };
  assert.equal(reviewReplay.replayed, true);
  assert.equal(reviewReplay.reviewId, reviewed.reviewId, "one decision must keep one reviewId");

  const settled = await waitFor(async () => (await probeJobState(defaultJobId)) === "succeeded", 75);
  assert.ok(settled, "an accepted result must complete the task exactly once");
  outcomes.connectorRoute = { jobId: defaultJobId.slice(0, 24), offerId: offered.offerId.slice(0, 24),
    reviewId: reviewed.reviewId.slice(0, 24), offerRows, taskState: "succeeded" };

  // The exact parent-before-child collision, against the fleet tables the
  // accepted decision just wrote. Same proof as before, on the rows this host
  // really produces.
  // Each collision client carries its own error handler: the cluster is stopped by
  // this journey's own teardown, and an unhandled 'error' event on a pg client
  // crashes the process after the work has already been reported.
const collisionConnection = () => {
    const client = new Client({ host: roleMap.coordinator.host, port: roleMap.coordinator.port,
      database: roleMap.coordinator.database, user: roleMap.coordinator.username, password: roleMap.coordinator.password,
      connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
    client.on("error", () => {});
    return client;
  };
  // The fleet tables are readable ONLY by the fleet roles (0140 grants them to
  // control_room_fleet_gateway, control_room_fleet_owner_authority and
  // control_room_private_web). The coordinator login is refused on them, so the
  // fleet-side collision is proved as the login that actually does that work.
  const fleetConnection = () => {
    const login = roleMap.fleetGateway;
    const client = new Client({ host: login.host, port: login.port, database: login.database,
      user: login.username, password: login.password,
      connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
    client.on("error", () => {});
    return client;
  };
  const lookup = fleetConnection();
  await lookup.connect();
  const collisionRow = (await lookup.query<{ job_id: string; result_id: string }>(`SELECT r.job_id,r.result_id
    FROM fleet_results r WHERE r.tenant_id=$1 ORDER BY r.result_id LIMIT 1`,
    [config.localOwnerSession.tenantId])).rows[0];
  await lookup.end();
  assert.ok(collisionRow, "collision proof requires a saved fleet result");
  const publisher = fleetConnection(), reader = fleetConnection();
  await Promise.all([publisher.connect(), reader.connect()]);
  try {
    await publisher.query("BEGIN"); await reader.query("BEGIN");
    await publisher.query("SELECT id FROM control_jobs WHERE id=$1 FOR KEY SHARE", [collisionRow.job_id]);
    const read = (async () => {
      await reader.query("SELECT id FROM control_jobs WHERE id=$1 FOR UPDATE", [collisionRow.job_id]);
      await reader.query("SELECT result_id FROM fleet_results WHERE tenant_id=$1 AND result_id=$2 FOR UPDATE",
        [config.localOwnerSession.tenantId, collisionRow.result_id]);
    })();
    await new Promise(resolve => setTimeout(resolve, 100));
    await publisher.query("SELECT result_id FROM fleet_results WHERE tenant_id=$1 AND result_id=$2 FOR UPDATE",
      [config.localOwnerSession.tenantId, collisionRow.result_id]);
    await publisher.query("COMMIT");
    await read;
    await reader.query("COMMIT");
  } finally {
    await Promise.allSettled([publisher.query("ROLLBACK"), reader.query("ROLLBACK")]);
    await Promise.allSettled([publisher.end(), reader.end()]);
  }
  process.stdout.write("Connector-route parent-before-child PG17 collision: PASS (no deadlock)\n");

  // The tenant-before-completion-gate order, against the same rows.
  const assignment = collisionConnection(), completion = collisionConnection();
  await Promise.all([assignment.connect(), completion.connect()]);
  try {
    const tenantId = config.localOwnerSession.tenantId;
    await assignment.query("BEGIN"); await completion.query("BEGIN");
    await assignment.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenantId]);
    const complete = (async () => {
      await completion.query("SELECT id FROM tenants WHERE id=$1 FOR KEY SHARE", [tenantId]);
      await completion.query("SELECT tenant_id FROM control_completion_gate_integrity WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
      await completion.query(`INSERT INTO control_transition_events
        (id,tenant_id,entity_kind,entity_id,from_state,to_state,from_version,to_version,
         actor_id,actor_type,idempotency_key,safe_metadata,occurred_at)
        VALUES('transition:rehearsal-lock-order',$1,'service','service:rehearsal-lock-order',
          'pending','done',0,1,'service:rehearsal-lock-order','service',
          'rehearsal-lock-order','{}'::jsonb,now())`, [tenantId]);
    })();
    await new Promise(resolve => setTimeout(resolve, 100));
    await assignment.query("SELECT tenant_id FROM control_completion_gate_integrity WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
    await assignment.query("COMMIT");
    await complete;
    await completion.query("ROLLBACK");
  } finally {
    await Promise.allSettled([assignment.query("ROLLBACK"), completion.query("ROLLBACK")]);
    await Promise.allSettled([assignment.end(), completion.end()]);
  }
  process.stdout.write("Connector-route tenant-before-gate PG17 collision: PASS (no deadlock)\n");

  process.stdout.write(`Package 6b journey (connector-only route): PASS ${JSON.stringify(outcomes)}\n`);

  const finalDown = invoke(["scripts/mac-local/down.mjs", "--protected-root", protectedRoot]);
  assert.equal(finalDown.status, 0, finalDown.stderr || finalDown.stdout);
  stackMayBeUp = false;
}

async function requireOk(response: Response, expected: number, label: string) {
  const text = await response.text();
  assert.equal(response.status, expected, `${label}: expected ${expected}, got ${response.status}: ${text}`);
  return JSON.parse(text);
}
async function require5xxOr201(response: Response, label: string) {
  const text = await response.text();
  assert.ok([200, 201].includes(response.status), `${label}: expected 200/201, got ${response.status}: ${text}`);
  return JSON.parse(text);
}

await runMacLocalJourneyV1(async signal => {
  journeySignal = signal;
  await main();
}, async settleWork => {
  try {
    if (verifiedThisRehearsalCluster) {
      if (stackMayBeUp) {
        const downHost = spawnSync(process.execPath, ["--import", "tsx", "scripts/mac-local/down.mjs", "--protected-root", protectedRoot], {
          cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
        });
        if (downHost.status !== 0) throw new Error("rehearsal_mac_stack_stop_failed");
      }
      stoppingDatabase = true;
      const down = spawnSync(process.execPath, ["--import", "tsx", "scripts/mac-local/rehearsal/setup.ts", "down", root], {
        cwd: process.cwd(), encoding: "utf8", timeout: 120_000,
      });
      const status = spawnSync(pgExecutable("pg_ctl"), ["-D", join(root, "pg"), "status"], { encoding: "utf8", timeout: 10_000 });
      if (status.status === 0) throw new Error("rehearsal_cluster_still_running_after_cleanup");
      if (down.status !== 0 && !/data directory .* not exist/u.test(`${down.stderr}\n${down.stdout}`))
        throw new Error("rehearsal_cluster_stop_failed");
    }
  } finally {
    await settleWork();
    // The advertisement is signed by this rehearsal's throwaway key. Left in
    // the shared release directory, it would make a later `mac:up` on any other
    // protected root refuse its connector release outright.
    if (signedConnectorRelease) await removeRehearsalConnectorAdvertisementV1();
    // Every bot workspace this run created, whether the journey reached its
    // connector leg or not, is removed before the process exits.
    await removeJourneyConnectorWorkspacesV1();
  }
}, { isStoppingDatabase: () => stoppingDatabase });
