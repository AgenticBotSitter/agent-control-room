// The updater's four recovery faults, as permanent tests on real PostgreSQL 17,
// as the PRODUCTION logins (review updint-fable, B2/B3/B4/M1).
//
// WHAT THIS FILE IS. The integration review found three faults that would strand
// an update half-way — the new code live, no health check, no automatic undo, no
// way forward — plus one that let a rollback cite the wrong Face ID. Each fault
// was a refusal, so none of them was visible as a wrong answer: they were
// visible as an updater that refuses to do the only thing left for it. That
// shape is why they survived to review, and it is why these tests are about
// what the database ACCEPTS after a bad thing has already happened, not about
// whether a good thing is permitted.
//
//   B2  A newer release landing, or the 72-hour expiry passing, while an update
//       is running must not wedge it. The plan check moved to INSERT only, and a
//       plan with a live run can no longer be superseded.
//   B3  `uncertain` is a state, not a tombstone: §11's measured settle has to be
//       expressible in the transition table.
//   B4  The run row and its journal mirror move in ONE statement, so a kill
//       between them is not a state the database can be left in.
//   M1  A rollback request must be passkey-backed, and the approval it cites must
//       belong to a `kind:'rollback'` plan.
//
// EVERY TEST HERE RUNS THE PRODUCTION DEFAULT PATH. No injected port, fake
// runner or stub store for the code under test: the real `PostgresUpdaterStoreV1`
// against the real `updater` DDL applied by the real loader, as
// `control_room_deployer` and `control_room_web`. The kill tests spawn a real
// child process that is SIGKILLed between two statements, in its own process
// group, because that is the only way to reproduce a kill rather than simulate
// one.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { PostgresUpdaterStoreV1 } from "../src/updater/v1/store.mjs";
import { applyUpdaterSchemaV1 } from "../src/updater/v1/schema-installer";

const KILL_CHILD = join(process.cwd(), "tests/updater-run-recovery-kill-child.mjs");

// Ports 59480-59489 are this job's block. The lane takes one at a time.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59480), PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };

const TENANT = "tenant:updater-recovery";
const OWNER = "identity:updater-recovery-owner";
const DEPLOYER_PASSWORD = "fixture-deployer";
const AUTH = Buffer.alloc(32, 0x11), SIG = Buffer.alloc(64, 0x22), CLIENT = Buffer.from('{"type":"webauthn.get"}', "utf8");
const CREDENTIAL = "Y3JlZGVudGlhbC1maXh0dXJlLTMyLWJ5dGVzLWxvbmc";
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const OWNER_SESSION = digest("owner-session-recovery");

function planJson(planId: string, kind: string, commit: string) {
  return { schema: "control-room.install-plan/v2", planId, installationId: "install-fixture", kind,
    candidate: { commit }, updaterDerived: { classes: ["code"], changesDatabase: false, changesUpdater: false } };
}

type Postgres = Parameters<Parameters<typeof withRealPostgres>[0]>[0];

/** A production login's client. Short names are fixture vocabulary. */
function as(postgres: Postgres, role: "deployer" | "web") {
  const password = role === "deployer" ? DEPLOYER_PASSWORD : (postgres.connection("web") as { password: string }).password;
  return new Client({ host: postgres.socketDirectory, port: postgres.port, database: postgres.database,
    user: role === "deployer" ? "control_room_deployer" : "control_room_web", password });
}

/** Fixture rows only, as the superuser, with triggers disabled the documented way. */
async function seed<T extends Record<string, unknown>>(postgres: Postgres, sql: string, params: unknown[] = []) {
  const client = new Client(postgres.admin());
  await client.connect();
  try {
    await client.query("SET session_replication_role = replica");
    return (await client.query<T>(sql, params as never[])).rows;
  } finally { await client.end(); }
}

async function seedOwnerSession(postgres: Postgres) {
  const now = new Date().toISOString();
  await seed(postgres, `INSERT INTO tenants(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING`, [TENANT]);
  await seed(postgres, `INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','Owner','test',$3,'active',$4,$4)
    ON CONFLICT DO NOTHING`, [OWNER, TENANT, digest(OWNER), now]);
  await seed(postgres, `INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,risk_ceiling,
    allowed_actions,project_ids,created_at,updated_at) VALUES($1,$2,$3,'owner','critical','["*"]','["*"]',$4,$4)
    ON CONFLICT DO NOTHING`, [`grant:${OWNER}`, TENANT, OWNER, now]);
  await seed(postgres, `INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
  [TENANT, OWNER_SESSION, OWNER, now, new Date(Date.parse(now) + 3_600_000).toISOString()]);
}

/** Apply the updater's fixed DDL through the updater's own loader. The SCRAM
 * verifier is set BETWEEN the loader's two halves; see the item-7 lane for why
 * that ordering is the point rather than plumbing. */
async function installUpdaterSchema(postgres: Postgres) {
  const bootstrap = new Client({ ...postgres.admin(), user: "fixture_admin" } as never);
  await bootstrap.connect();
  const owner = new Client({ host: postgres.socketDirectory, port: postgres.port,
    user: "control_room_migrator", password: (postgres.connection("migrator") as { password: string }).password,
    database: postgres.database });
  await owner.connect();
  let deployer: Client | undefined;
  try {
    return await applyUpdaterSchemaV1({
      bootstrap,
      directory: join(process.cwd(), "src/updater/v1/ddl"),
      deployerHasFixturePassword: true,
      connectDeployer: async () => {
        await owner.query(await readFile(join(process.cwd(), "db/roles/updater_release_reader_roles.sql"), "utf8"));
        await bootstrap.query(`ALTER ROLE control_room_deployer PASSWORD '${DEPLOYER_PASSWORD}'`);
        deployer = as(postgres, "deployer");
        await deployer.connect();
        return deployer;
      },
    });
  } finally {
    await deployer?.end().catch(() => {});
    await owner.end().catch(() => {});
    await bootstrap.end();
  }
}

/** Assert a statement is refused, and return `SQLSTATE message`. */
async function refuses(client: Client, sql: string, params: unknown[] = []): Promise<string> {
  try { await client.query(sql, params as never[]); }
  catch (error) {
    const { code, message } = error as { code?: string; message: string };
    assert.equal(typeof code, "string", `refusal carried no SQLSTATE: ${message}`);
    return `${code} ${message.split("\n")[0]}`;
  }
  assert.fail(`statement was not refused: ${sql.slice(0, 140)}`);
}

/** Insert a plan as the deployer, in whatever state the test needs.
 *
 * `expiresIn` is measured from a `created_at` the caller can move rather than
 * from `now()`, because `plans_expiry_after_creation` refuses `expires_at <=
 * created_at` and the B2 expiry case needs a window that is short but real. */
async function insertPlan(client: Client, planId: string, {
  kind = "code", state = "ready_for_approval", expiresIn = "72 hours", commit = "a".repeat(40),
} = {}) {
  await client.query(`INSERT INTO updater.plans(plan_id,installation_id,kind,state,classes,changes_database,
    changes_updater,plan_digest,plan_json,needs_mac_confirm,expires_at)
    VALUES($1,'install-fixture',$2,$3,ARRAY['code'],false,false,$4,$5::jsonb,$6,
      now() + $7::interval)`, [planId, kind, state, digest(planId), JSON.stringify(planJson(planId, kind, commit)),
  kind === "updater" || kind === "setting", expiresIn]);
}

/** A plan that expires `seconds` from now, with `created_at` backdated so the
 * expiry CHECK holds on insert. The row's own column is what the guard reads
 * (`expires_at > now()`), so moving `created_at` does not change the answer. */
async function insertExpiringPlan(client: Client, planId: string, seconds: number) {
  await client.query(`INSERT INTO updater.plans(plan_id,installation_id,kind,state,classes,changes_database,
    changes_updater,plan_digest,plan_json,needs_mac_confirm,created_at,expires_at)
    VALUES($1,'install-fixture','code','ready_for_approval',ARRAY['code'],false,false,$2,$3::jsonb,false,
      now() - make_interval(secs => $5::float8), now() + make_interval(secs => $4::float8))`,
  [planId, digest(planId), JSON.stringify(planJson(planId, "code", "a".repeat(40))), seconds, seconds + 5]);
}

/** Close a plan so the next one can be open. The design allows exactly one open
 * plan (design §5.5), so every fixture that mints a second plan must retire the
 * first — and doing it through `superseded` is the production route. */
async function retirePlan(client: Client, planId: string, by = "plan-retired") {
  await client.query("UPDATE updater.plans SET state='superseded',superseded_by_plan_id=$2 WHERE plan_id=$1",
    [planId, by]);
}

/** Mint an approved plan and its live run, through the real store. */
async function liveRun(store: PostgresUpdaterStoreV1, client: Client, planId: string,
  leaseToken: string, upTo: string[] = []) {
  await insertPlan(client, planId);
  await client.query("UPDATE updater.plans SET state='approved' WHERE plan_id=$1", [planId]);
  const runId = `run:${randomUUID()}`;
  await client.query("INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token) "
    + "VALUES($1,$2,'approved','code',$3)", [runId, planId, leaseToken]);
  for (const state of upTo) await store.transition(runId, leaseToken, state, { step: state });
  return runId;
}

/** Retire every live run and every open plan, so a fixture starts from nothing.
 *
 * `runs_one_live` and the one-open-plan guard are database-wide facts, so a test
 * that mints several runs has to finish the previous one the way a real update
 * does — not by disabling the guards, which would test a database nobody runs,
 * and not by hand-writing `UPDATE updater.runs`, which `guard_run_state`
 * correctly refuses once a mirror event exists (the row and its journal are two
 * records of one fact, and raw SQL moves only one of them). So this walks every
 * live run through the PRODUCTION port: `store.transition`, which is B4's atomic
 * function, and which keeps the row and its mirror in step by construction.
 *
 * The path taken depends on where the run is, because §8.1 says different states
 * have different exits: a run still pre-drain is refused outright (§8.1's
 * "nothing was changed" exit), while anything at or past drain — including
 * `uncertain` and `attended_upgrade_required`, the two states reachable from
 * anywhere — goes down the rollback tail, which is §8.5's route back.
 */
async function quiesceInstall(store: PostgresUpdaterStoreV1, client: Client) {
  const live = await client.query<{ run_id: string; lease_token: string; state: string }>(
    "SELECT run_id,lease_token,state FROM updater.runs WHERE finished_at IS NULL ORDER BY started_at");
  const PRE_DRAIN = ["approved", "prechecked", "staged", "quick_backup"];
  for (const run of live.rows) {
    const path = PRE_DRAIN.includes(run.state)
      ? [{ state: "refused", terminal: true }]
      : run.state === "rollback_started"
        ? [{ state: "code_restored" }, { state: "rolled_back", terminal: true }]
        : run.state === "code_restored"
          ? [{ state: "rolled_back", terminal: true }]
          : run.state === "restore_started" || run.state === "db_restored"
            ? [{ state: "code_restored" }, { state: "rolled_back", terminal: true }]
            : [{ state: "rollback_started" }, { state: "code_restored" }, { state: "rolled_back", terminal: true }];
    for (const step of path)
      await store.transition(run.run_id, run.lease_token, step.state, { quiesce: true },
        { terminal: step.terminal === true });
  }
  // The PLAN closes last, and that ordering is not cosmetic. B2's second guard
  // refuses to supersede a plan whose run is still live — which is exactly the
  // right behaviour and exactly what breaks a quiesce written the other way
  // round. Retiring the run first is the order the update itself finishes in.
  await client.query("UPDATE updater.plans SET state='superseded',superseded_by_plan_id='plan-quiesced' "
    + "WHERE state IN ('building','ready_for_approval','approved','approval_required') "
    + "AND superseded_by_plan_id IS NULL");
  const left = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM updater.runs WHERE finished_at IS NULL");
  assert.equal(left.rows[0]?.n, 0, "a live run survives quiesce, so the next fixture cannot start");
}

const runRow = async (client: Client, runId: string) => (await client.query(
  "SELECT state, finished_at IS NOT NULL AS finished FROM updater.runs WHERE run_id=$1", [runId])).rows[0];
const eventStates = async (client: Client, runId: string) => (await client.query(
  "SELECT state FROM updater.run_events WHERE run_id=$1 ORDER BY ordinal", [runId])).rows.map(row => row.state);

/**
 * Run the real transition in a CHILD process and SIGKILL it at `killAt`.
 *
 * This is the reproduction B4 needs and cannot be faked: the child holds a real
 * `control_room_deployer` session on a real cluster, drives the real
 * `PostgresUpdaterStoreV1`, and is killed with SIGKILL — so there is no
 * ROLLBACK, no `finally`, no cleanup, and whatever PostgreSQL had committed is
 * what survives. Killing only the child's own pid (`-child.pid` is the group,
 * which the child does not lead here) would leave a grandchild holding the
 * session, so the whole GROUP is signalled.
 *
 * The protocol the child implements — write the label, THEN park — is what makes
 * this synchronous rather than a race: the kill is sent only once the label has
 * arrived, so the child is provably parked with its session open. A child that
 * died before reporting its seam is a failure here, not a silent pass, because
 * otherwise "the kill landed somewhere" would be indistinguishable from "the
 * kill landed where we meant".
 *
 * @param {object} options
 * @param {string} options.socketDirectory cluster socket directory
 * @param {number} options.port cluster port
 * @param {string} options.database database name
 * @param {string} options.password the deployer fixture password
 * @param {string} options.runId the run to move
 * @param {string} options.leaseToken the run's durable lease token
 * @param {string} options.from the state the run is in
 * @param {string} options.to the state to move it to
 * @param {string} options.killAt the seam to die at
 * @param {boolean} options.terminal whether the move finishes the run
 * @param {number} options.boundMs how long to wait for the seam label
 * @returns {Promise<{seam: string, signal: string|null, transcript: string}>}
 */
async function killDuringTransition(options: {
  socketDirectory: string; port: number; database: string; password: string;
  runId: string; leaseToken: string; from: string; to: string; killAt: string;
  terminal: boolean; boundMs?: number;
}): Promise<{ seam: string; signal: string | null; transcript: string }> {
  const boundMs = options.boundMs ?? 60_000;
  const child = spawn(process.execPath, [KILL_CHILD, options.socketDirectory, String(options.port),
    options.database, options.runId, options.leaseToken, options.from, options.to, options.killAt,
    String(options.terminal)], {
    // Its own process group, so the whole test owns one group to tear down.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CONTROL_ROOM_TEST_DEPLOYER_PASSWORD: options.password },
  });
  const group = child.pid;
  let transcript = "";
  const say = (chunk: string) => { transcript += chunk; };
  child.stdout?.setEncoding("utf8"); child.stdout?.on("data", say);
  child.stderr?.setEncoding("utf8"); child.stderr?.on("data", say);

  // The seam arrives on stderr as a line, then the child parks. Read ONE line,
  // kill, and only then wait for the exit.
  const parked = await new Promise<{ seam: string; failure?: Error }>((resolve) => {
    let buffered = "";
    const timer = setTimeout(() => resolve({ seam: "",
      failure: new Error(`the child never reached seam ${options.killAt} within ${boundMs}ms;`
        + ` it must write the label BEFORE it parks, or this read blocks forever`) }), boundMs);
    child.stderr?.on("data", (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline).trim();
      // Only a SEAM resolves this wait. `moved:` and `error:` are the child's
      // ordinary output; treating either as a seam would make the parent kill on
      // a line that means something else, and the test would assert nothing about
      // the parking it was written to prove.
      if (!line || line.startsWith("moved:") || line.startsWith("error:")) return;
      clearTimeout(timer);
      resolve({ seam: line });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ seam: "", failure: new Error(`the child exited before reaching seam `
        + `${options.killAt} (code=${code} signal=${signal}); transcript=${transcript.trim()}`) });
    });
  });

  let signal: string | null = null;
  if (!parked.failure) {
    // The kill. The GROUP, not the pid: `detached: true` made the child a group
    // leader, so a negative pid reaches anything it spawned as well.
    try { process.kill(-(group as number), "SIGKILL"); } catch { /* already gone */ }
    signal = await new Promise<string | null>((resolve) => {
      child.once("exit", (_code, exitSignal) => resolve(exitSignal));
      setTimeout(() => resolve("still-running"), 30_000).unref?.();
    });
  }
  // Belt and braces: whatever the exit reported, the group must be gone before
  // this returns, or a session outlives the test that started it.
  try { process.kill(-(group as number), "SIGKILL"); } catch { /* already gone */ }
  if (parked.failure) throw parked.failure;
  return { seam: parked.seam, signal, transcript };
}

// ---------------------------------------------------------------------------

test("B2: a live run survives a newer release and an expired plan", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const client = as(postgres, "deployer"); await client.connect();
    try {
      const store = new PostgresUpdaterStoreV1(client); await store.initialize();

      // ---- half one: the plan check is on INSERT only -------------------
      // It still refuses an unauthorised INSERT, which is the whole point of
      // keeping it at all: the run is bound to an approved, unexpired plan, or it
      // was never authorised. Both shapes are checked — a plan that was never
      // approved, and a plan whose 72 hours ran out — because the guard reads
      // two columns and either one alone would be a vacuous test.
      await insertPlan(client, "plan-b2-closed", { state: "refused_build" });
      assert.match(await refuses(client, "INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token) "
        + "VALUES($1,$2,'approved','code','boot')", [`run:${randomUUID()}`, "plan-b2-closed"]),
      /updater run needs an approved, unexpired plan/u);
      await insertExpiringPlan(client, "plan-b2-expired", 2);
      // Approved while still inside the window, then the window closes on its
      // own. The alternative — rewriting `expires_at` after the card was shown —
      // is refused by the plan immutability guard, which is the point of that
      // guard, so the fixture waits instead.
      await client.query("UPDATE updater.plans SET state='approved' WHERE plan_id='plan-b2-expired'");
      await new Promise(resolve => setTimeout(resolve, 2_500));
      const stale = await client.query<{ past: boolean }>(
        "SELECT expires_at < now() AS past FROM updater.plans WHERE plan_id=$1", ["plan-b2-expired"]);
      assert.equal(stale.rows[0]?.past, true, "the plan really did expire before the run was claimed");
      assert.match(await refuses(client, "INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token) "
        + "VALUES($1,$2,'approved','code','boot')", [`run:${randomUUID()}`, "plan-b2-expired"]),
      /updater run needs an approved, unexpired plan/u,
      "an expired approval authorises nothing: the 72 hours are the owner's window, not a formality");
      await retirePlan(client, "plan-b2-expired", "plan-b2-newer");

      // ---- half two: no supersede while a run is live -------------------
      // Every fixture above retired itself, so the live case starts clean.
      await quiesceInstall(store, client);
      const planId = "plan-b2-live", leaseToken = "lease-b2-live";
      const runId = await liveRun(store, client, planId, leaseToken,
        ["prechecked", "staged", "quick_backup", "draining", "switched"]);
      assert.equal((await runRow(client, runId)).state, "switched");
      // This is the review's P2 exactly: a newer commit lands, the watcher tries
      // to supersede the approved plan the run is executing from.
      assert.match(await refuses(client, "UPDATE updater.plans SET state='superseded',superseded_by_plan_id=$1 "
        + "WHERE plan_id=$2", ["plan-b2-newer", planId]),
      /updater plan cannot be superseded while its run is live/u);

      // And the run keeps going. At `switched` the new code is ALREADY live, so a
      // refusal here is the wedge: no health check, no rollback, nothing.
      for (const next of ["restarted", "healthy"]) await store.transition(runId, leaseToken, next, {});
      const succeeded = await store.transition(runId, leaseToken, "succeeded", {}, { terminal: true });
      assert.equal(succeeded.state, "succeeded");
      assert.equal((await runRow(client, runId)).finished, true);
      // Every non-terminal step has its mirror row, in order, and the terminal
      // step has none (the insert guard requires an unfinished run).
      assert.deepEqual(await eventStates(client, runId),
        ["prechecked", "staged", "quick_backup", "draining", "switched", "restarted", "healthy"]);

      // ---- half three: expiry passing mid-run does not wedge it ---------
      // The 72-hour window is the review's P3. It is driven by the row's own
      // column, because `expires_at` is covered by the plan immutability guard:
      // changing it after the card was shown would be changing the plan. So the
      // window is short and REAL — the run starts inside it and the test waits
      // for it to close — rather than rewritten mid-run.
      await quiesceInstall(store, client);
      const expiringPlan = "plan-b2-expiring", expiringLease = "lease-b2-expiring";
      await insertExpiringPlan(client, expiringPlan, 2);
      await client.query("UPDATE updater.plans SET state='approved' WHERE plan_id=$1", [expiringPlan]);
      const expiringRun = `run:${randomUUID()}`;
      await client.query("INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token) "
        + "VALUES($1,$2,'approved','code',$3)", [expiringRun, expiringPlan, expiringLease]);
      // The code path §8.1: a code run always takes a quick backup between staging
      // and drain, so the fixture walks the real path rather than skipping a step
      // the state machine requires.
      for (const state of ["prechecked", "staged", "quick_backup", "draining", "switched"])
        await store.transition(expiringRun, expiringLease, state, {});
      await new Promise(resolve => setTimeout(resolve, 2_500));
      const past = await client.query<{ past: boolean }>(
        "SELECT expires_at < now() AS past FROM updater.plans WHERE plan_id=$1", [expiringPlan]);
      assert.equal(past.rows[0]?.past, true, "the plan really did expire mid-run");
      // Restart, then the health check, then success: the expiry changed nothing.
      await store.transition(expiringRun, expiringLease, "restarted", {});
      await store.transition(expiringRun, expiringLease, "healthy", {});
      const finished = await store.transition(expiringRun, expiringLease, "succeeded", {}, { terminal: true });
      assert.equal(finished.state, "succeeded");

      // ---- half four: a FINISHED run no longer blocks supersession ------
      // The guard is about a live run, not about a plan that once had one. An
      // install that could never supersede an old plan could never update again.
      // The run is walked all the way to `succeeded` because that state is
      // reachable only from `healthy` (§8.1) — a shortcut would be testing the
      // transition table, not this guard.
      await quiesceInstall(store, client);
      const settled = "plan-b2-settled";
      const settledRun = await liveRun(store, client, settled, "lease-b2-settled");
      for (const state of ["prechecked", "staged", "quick_backup", "draining", "switched", "restarted", "healthy"])
        await store.transition(settledRun, "lease-b2-settled", state, { step: state });
      await store.transition(settledRun, "lease-b2-settled", "succeeded", {}, { terminal: true });
      await client.query("UPDATE updater.plans SET state='superseded',superseded_by_plan_id=$1 WHERE plan_id=$2",
        ["plan-b2-newer", settled]);
      assert.equal((await client.query("SELECT state FROM updater.plans WHERE plan_id=$1", [settled]))
        .rows[0]?.state, "superseded", "a terminal run does not freeze its plan forever");
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 900_000 });
});

test("B3: uncertain has a way out, and only through a measurement", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const client = as(postgres, "deployer"); await client.connect();
    try {
      const store = new PostgresUpdaterStoreV1(client); await store.initialize();

      // A rescued run goes `uncertain` from wherever it was, and §11 says the
      // owner taps "Check and continue", the updater MEASURES, and then records a
      // terminal state. Each of the three measured outcomes must be expressible,
      // and each is run through the REAL store, so the measurement the guard
      // demands is the one the production caller writes.
      for (const [label, states] of [
        ["measured succeeded", ["succeeded"]],
        ["measured rolled_back", ["rolled_back"]],
        ["measured inconsistent -> rollback", ["rollback_started", "code_restored", "rolled_back"]],
      ] as const) {
        await quiesceInstall(store, client);
        const planId = `plan-b3-${label.replace(/\W+/gu, "-")}`;
        const runId = await liveRun(store, client, planId, "lease-b3", ["prechecked", "staged"]);
        await store.transition(runId, "lease-b3", "uncertain", { reason: "rescue_marker" });
        assert.equal((await runRow(client, runId)).state, "uncertain");
        let last;
        // Only the LAST step is terminal. `rolled_back` is terminal by the
        // design's vocabulary, so a run that reached it by the rollback tail must
        // carry a finish time — `runs_finished_shape` enforces the pairing, and
        // getting this wrong would test the wrong refusal.
        for (const [index, state] of states.entries())
          last = await store.transition(runId, "lease-b3", state, { measured: true },
            { terminal: index === states.length - 1 });
        assert.ok(last, `${label} produced no run row`);
        assert.equal((await runRow(client, runId)).finished, true,
          `${label} ends the run, and the row says so`);
      }

      // The measurement is a FACT ON THE ROW, not a promise in a comment. This is
      // the guard that makes the exits above mean what they say: a run cannot
      // leave `uncertain` recorded as "succeeded" without an answer behind it.
      // Before this check, the transition table alone would have accepted
      // `uncertain -> succeeded` with `detail = {}` — the database would then say
      // an update succeeded on a run that admits it does not know what happened.
      await quiesceInstall(store, client);
      const barePlan = "plan-b3-unmeasured";
      const bareRun = await liveRun(store, client, barePlan, "lease-b3-bare", ["prechecked"]);
      await store.transition(bareRun, "lease-b3-bare", "uncertain", { reason: "rescue_marker" });
      assert.match(await refuses(client,
        "UPDATE updater.runs SET state='succeeded',finished_at=now() WHERE run_id=$1", [bareRun]),
      /updater run leaves uncertain only on a recorded measurement/u,
      "an UNMEASURED 'succeeded' is exactly the record §11 forbids");
      assert.equal((await runRow(client, bareRun)).state, "uncertain",
        "and the refused measurement left the run where it was");
      // The same move WITH the measurement lands, through the store.
      assert.equal((await store.transition(bareRun, "lease-b3-bare", "succeeded",
        { measured: true }, { terminal: true })).state, "succeeded");

      // The forward path is still refused. This is the half that makes the
      // exits above safe rather than a hole: `uncertain` exists so a run cannot
      // resume FORWARD on its own. An update that measured "I don't know" must
      // not then decide to try the next step. Only the forward steps are in this
      // list — the two measured exits are already exercised above, and a
      // measurement does not unlock a forward move.
      await quiesceInstall(store, client);
      const guardPlan = "plan-b3-forward";
      const guardRun = await liveRun(store, client, guardPlan, "lease-b3-forward", ["prechecked", "staged"]);
      await store.transition(guardRun, "lease-b3-forward", "uncertain", { reason: "rescue_marker" });
      for (const forward of ["prechecked", "staged", "quick_backup", "draining", "switched", "restarted", "healthy"]) {
        assert.match(await refuses(client, "UPDATE updater.runs SET state=$1 WHERE run_id=$2", [forward, guardRun]),
        /updater run transition refused/u, `uncertain -> ${forward} must stay refused`);
      }
      assert.equal((await runRow(client, guardRun)).state, "uncertain",
        "every refused forward move left the run exactly where it was");

      // §9.7's attended hand-off is a state of its own with the same need, and its
      // exit is a run the owner watches — so it may be recorded without the
      // `measured` annotation. Asserted because "no measurement required here" is
      // a decision, and a decision nobody tests is a decision nobody made.
      await quiesceInstall(store, client);
      const attendedPlan = "plan-b3-attended";
      const attendedRun = await liveRun(store, client, attendedPlan, "lease-b3-attended", ["prechecked"]);
      await store.transition(attendedRun, "lease-b3-attended", "attended_upgrade_required",
        { reason: "postgres_major_change" });
      assert.equal((await store.transition(attendedRun, "lease-b3-attended", "succeeded", {},
        { terminal: true })).state, "succeeded",
      "the attended upgrader records what it found without a measured annotation");

      // A terminal run is still terminal from `uncertain`: measurement cannot
      // reopen a run that has already ended.
      await quiesceInstall(store, client);
      const donePlan = "plan-b3-terminal";
      const doneRun = await liveRun(store, client, donePlan, "lease-b3-done");
      for (const state of ["prechecked", "staged", "quick_backup", "draining", "switched", "restarted", "healthy"])
        await store.transition(doneRun, "lease-b3-done", state, { step: state });
      await store.transition(doneRun, "lease-b3-done", "succeeded", {}, { terminal: true });
      assert.match(await refuses(client, "UPDATE updater.runs SET state='uncertain' WHERE run_id=$1", [doneRun]),
        /updater run succeeded is terminal/u);
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 900_000 });
});

test("B4: the run row and its journal mirror move in one statement", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const client = as(postgres, "deployer"); await client.connect();
    try {
      const store = new PostgresUpdaterStoreV1(client); await store.initialize();
      const planId = "plan-b4", leaseToken = "lease-b4";
      const runId = await liveRun(store, client, planId, leaseToken);

      // The property itself: after EVERY step, the row's state and the last
      // mirror event are the same fact. The two-statement form could not promise
      // this — between the UPDATE and the INSERT the row said `switched` and the
      // last event still said `draining`.
      for (const state of ["prechecked", "staged", "quick_backup", "draining", "switched", "restarted", "healthy"]) {
        await store.transition(runId, leaseToken, state, { step: state });
        const row = await runRow(client, runId);
        const events = await eventStates(client, runId);
        assert.equal(row.state, state, `the row moved to ${state}`);
        assert.equal(events.at(-1), state, `the mirror agrees with the row at ${state}`);
      }

      // A terminal step writes no mirror row, and the row is finished. Stated
      // explicitly because it is the one asymmetry in the function, and an
      // asymmetry nobody asserts is an asymmetry nobody reviewed.
      await store.transition(runId, leaseToken, "succeeded", {}, { terminal: true });
      assert.deepEqual(await eventStates(client, runId),
        ["prechecked", "staged", "quick_backup", "draining", "switched", "restarted", "healthy"]);

      // A repeated step is a NO-OP, not a second event. Design §8.1 requires every
      // effect to be repeat-safe, and `guard_run_state` returns early when
      // `NEW.state = OLD.state` (a no-op move is not a transition), so without an
      // explicit repeat check the function wrote a mirror row every time it was
      // asked for a state the row already held. Measured: three repeats produced
      // ordinals 1, 2, 3 for one step. A run's journal is the audit trail the
      // recovery path reads, so that is a record that lies about how the run got
      // where it is — and it consumes the ordinal the NEXT real step needs.
      //
      // This is the single-caller shape of the twenty-caller case the load lane
      // exercises; it is asserted here too because a sequential repeat is the
      // shape a retried effect actually takes.
      await quiesceInstall(store, client);
      const repeatPlan = "plan-b4-repeat";
      const repeatRun = await liveRun(store, client, repeatPlan, "lease-b4-repeat");
      for (const _attempt of [1, 2, 3])
        assert.equal((await store.transition(repeatRun, "lease-b4-repeat", "prechecked", { step: "prechecked" }))
          .state, "prechecked", "a repeat of the current state succeeds, it is not refused");
      assert.deepEqual(await eventStates(client, repeatRun), ["prechecked"],
        "three repeats wrote ONE mirror row: a repeat is a no-op");
      // And the chain is still usable for the steps that follow.
      assert.equal((await store.transition(repeatRun, "lease-b4-repeat", "staged", {})).state, "staged");
      assert.deepEqual(await eventStates(client, repeatRun), ["prechecked", "staged"],
        "the next real step took ordinal 2, so the repeats did not poison the chain");

      // The lease is re-checked inside the statement. A second caller that does
      // not hold the token moves nothing AND writes nothing: the ownership check
      // and the move are one fact, not a read followed by a write.
      await quiesceInstall(store, client);
      const planId2 = "plan-b4-b", leaseToken2 = "lease-b4-b";
      const runId2 = await liveRun(store, client, planId2, leaseToken2);
      await assert.rejects(store.transition(runId2, "not-my-lease", "prechecked", {}),
        /updater_run_lease_lost/u);
      assert.equal((await runRow(client, runId2)).state, "approved", "the row did not move");
      assert.deepEqual(await eventStates(client, runId2), [], "and no mirror row was written for it");
      // The rightful holder still works afterwards: a failed attempt is not a
      // poisoned run.
      assert.equal((await store.transition(runId2, leaseToken2, "prechecked", {})).state, "prechecked");

      // A rejected step leaves NOTHING behind. This is what makes the function
      // safe to retry: an illegal transition must not consume the ordinal.
      const before = await eventStates(client, runId2);
      assert.match(await refuses(client, "SELECT updater.record_run_step($1,$2,'healthy','{}'::jsonb,false)",
        [runId2, leaseToken2]), /updater run transition refused/u);
      assert.deepEqual(await eventStates(client, runId2), before, "a refused step wrote no mirror row");
      assert.equal((await runRow(client, runId2)).state, "prechecked", "and left the row where it was");

      // The web login must not be able to EXECUTE the function. Asserted on the
      // CATALOG, not on the refusal a call produces, because those are two
      // different layers and only one of them is this guard: with the REVOKE
      // removed, `has_function_privilege` for the web login reads true and a call
      // is still refused — but by the function's own lease check, because the
      // attacker does not hold the lease. So a test that only asserts "the call
      // is refused" passes with the REVOKE deleted, which is a test of the lease
      // wearing the label of a privilege test. The privilege itself is what has
      // to be absent, and only the catalog says so.
      const web = as(postgres, "web"); await web.connect();
      try {
        await seedOwnerSession(postgres);
        const acl = await web.query<{ executable: boolean }>(
          "SELECT has_function_privilege(current_user,"
          + "'updater.record_run_step(text,text,text,jsonb,boolean)','EXECUTE') AS executable");
        assert.equal(acl.rows[0]?.executable, false,
          "the web login holds no EXECUTE on record_run_step: the routine is REVOKEd from PUBLIC, "
          + "so a compromised release cannot reach it even if it found the SQL");
        // And it is still refused when it tries, which is the second layer.
        assert.match(await refuses(web, "SELECT updater.record_run_step($1,$2,'healthy','{}'::jsonb,false)",
          [runId2, leaseToken2]), /permission denied|lease lost/u);
      } finally { await web.end(); }
      // The same assertion as the deployer, because the deployer must keep it.
      const deployerAcl = await client.query<{ executable: boolean }>(
        "SELECT has_function_privilege(current_user,"
        + "'updater.record_run_step(text,text,text,jsonb,boolean)','EXECUTE') AS executable");
      assert.equal(deployerAcl.rows[0]?.executable, true,
        "the updater's own login is the holder, and it keeps it");
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 900_000 });
});

test("B4: a SIGKILL at every seam of the transition leaves a run that can still move", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const client = as(postgres, "deployer"); await client.connect();
    try {
      const store = new PostgresUpdaterStoreV1(client); await store.initialize();
      // The step the review's P4 killed at: `draining -> switched`, the instant at
      // which the new code is ALREADY live. A wedge here is the worst outcome the
      // updater has — new code running, no health check, no rollback.
      const path = ["prechecked", "staged", "quick_backup", "draining"];

      // EVERY seam of the one statement, one at a time. `before_transition` is
      // the window the old two-statement form had and does not have now;
      // `after_transition` is "the move committed, the caller has not yet
      // learned it did"; `after_report` is "the caller knows, and has not
      // written anything else". All three must leave the same property.
      for (const seam of ["before_transition", "after_transition", "after_report"] as const) {
        await quiesceInstall(store, client);
        const planId = `plan-kill-${seam}`, leaseToken = `lease-kill-${seam.replace(/_/gu, "-")}`;
        const runId = await liveRun(store, client, planId, leaseToken, path);
        assert.equal((await runRow(client, runId)).state, "draining", `${seam}: fixture is at draining`);

        const killed = await killDuringTransition({ socketDirectory: postgres.socketDirectory,
          port: postgres.port, database: postgres.database, password: DEPLOYER_PASSWORD,
          runId, leaseToken, from: "draining", to: "switched", killAt: seam, terminal: false });
        assert.equal(killed.seam, seam, `${seam}: the child parked at the seam we named`);
        assert.equal(killed.signal, "SIGKILL",
          `${seam}: the child really died from a signal, not an exit (transcript=${killed.transcript.trim()})`);

        // THE PROPERTY. Whatever survived the kill, the row and its last mirror
        // event are the SAME fact — and the run is still at a state the next step
        // can be taken from. Either the statement committed (row at `switched`,
        // last event `switched`) or it did not (row at `draining`, last event
        // `draining`). The old form had a third possibility, and it was the bug.
        const row = await runRow(client, runId);
        const events = await eventStates(client, runId);
        assert.equal(events.at(-1), row.state,
          `${seam}: the row says ${row.state} and its mirror says ${events.at(-1)}`);
        assert.equal(row.finished, false, `${seam}: a killed non-terminal step never finishes the run`);

        // AND THE RUN IS NOT WEDGED. This is the assertion the whole thing is
        // for: after the kill, a fresh caller can take the very next step. Under
        // the old two-statement form this is where `23514 updater run state
        // disagrees with its journal` fired and the run was stranded.
        const next = row.state === "switched" ? "restarted" : "switched";
        assert.equal((await store.transition(runId, leaseToken, next, { step: next })).state, next,
          `${seam}: the next step after a kill at ${seam} is reachable`);
        // And the run can still finish the ordinary way, so a kill at any seam
        // costs a repeated step rather than the update.
        for (const state of ["restarted", "healthy"])
          if ((await runRow(client, runId)).state !== state) await store.transition(runId, leaseToken, state, {});
        await store.transition(runId, leaseToken, "succeeded", {}, { terminal: true });
        assert.equal((await runRow(client, runId)).finished, true, `${seam}: the run still completes`);
      }

      // A kill at a TERMINAL step, which is the one asymmetry in the function: it
      // writes no mirror row, so "the mirror agrees with the row" has a different
      // meaning here — the row is finished and the mirror correctly stops at the
      // last real step. Asserted because an asymmetry nobody states is an
      // asymmetry nobody reviewed.
      await quiesceInstall(store, client);
      const finalPlan = "plan-kill-terminal", finalLease = "lease-kill-terminal";
      const finalRun = await liveRun(store, client, finalPlan, finalLease,
        [...path, "switched", "restarted", "healthy"]);
      await killDuringTransition({ socketDirectory: postgres.socketDirectory, port: postgres.port,
        database: postgres.database, password: DEPLOYER_PASSWORD, runId: finalRun,
        leaseToken: finalLease, from: "healthy", to: "succeeded", killAt: "after_transition", terminal: true });
      const finalRow = await runRow(client, finalRun);
      assert.equal(finalRow.state, "succeeded", "the terminal move committed");
      assert.equal(finalRow.finished, true, "and carried its finish time with it");
      assert.equal((await eventStates(client, finalRun)).at(-1), "healthy",
        "a terminal step writes no mirror row, so the mirror correctly stops at `healthy`");
      // A finished run is finished, and the REFUSAL is the lease check rather
      // than the terminal check — worth stating, because it is the function's
      // own `finished_at IS NULL` predicate answering first. The run is done
      // either way: nothing can move it, and the mirror is still at `healthy`.
      assert.match(await refuses(client, "SELECT updater.record_run_step($1,$2,'restarted','{}'::jsonb,false)",
        [finalRun, finalLease]), /updater run lease lost/u,
      "a run that already finished admits no further step, whatever the reason it reports");
      assert.match(await refuses(client, "UPDATE updater.runs SET state='restarted' WHERE run_id=$1", [finalRun]),
        /updater run succeeded is terminal/u,
      "and the row itself says so too, for a caller that goes around the function");
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 900_000 });
});

test("M1: a rollback request must be passkey-backed, and cite a rollback approval", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const client = as(postgres, "deployer"); await client.connect();
    const web = as(postgres, "web"); await web.connect();
    try {
      // A real approval row the web can insert, against a real install plan.
      const installPlanId = "plan-m1-install";
      await insertPlan(client, installPlanId);
      const approvalId = `approval:${randomUUID()}`;
      await web.query("INSERT INTO updater.plan_approvals(id,plan_id,credential_id,authenticator_data,"
        + "client_data_json,signature,owner_session_digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [approvalId, installPlanId, CREDENTIAL, AUTH, CLIENT, SIG, OWNER_SESSION]);

      // (a) The review's P5a: `rollback` with `requires_passkey=false`. Before
      // this constraint the row was perfectly well formed — the column was
      // simply lying about what the request needed.
      assert.match(await refuses(web, "INSERT INTO updater.owner_requests(id,request_kind,requires_passkey,"
        + "owner_session_digest) VALUES($1,'rollback',false,$2)", [`owner-request:${randomUUID()}`, OWNER_SESSION]),
      /violates check constraint "owner_request_passkey_kinds"/u);

      // (b) The review's P5c: a rollback citing the INSTALL plan's approval. The
      // row is well formed on every column — a real approval id, a real plan —
      // and it would have carried the owner's Face ID over the wrong bytes.
      assert.match(await refuses(web, "INSERT INTO updater.owner_requests(id,request_kind,requires_passkey,"
        + "approval_id,owner_session_digest) VALUES($1,'rollback',true,$2,$3)",
      [`owner-request:${randomUUID()}`, approvalId, OWNER_SESSION]),
      /needs an approval for a rollback plan, not code/u);

      // (c) The right approval for the right request: a `kind:'rollback'` plan,
      // cited by a rollback request. This is the request the owner means when
      // they tap "Roll back with Face ID", and it must be ACCEPTED — a constraint
      // that refuses the legitimate case is a feature that does not work.
      //
      // Each new plan retires the previous one: the design allows exactly one
      // OPEN plan, so a fixture that mints a second must close the first or it is
      // testing the open-plan guard by accident. That is a fixture rule, not a
      // property under test here, so it is stated once here rather than repeated.
      await retirePlan(client, installPlanId, "plan-m1-rollback");
      const rollbackPlanId = "plan-m1-rollback";
      await insertPlan(client, rollbackPlanId, { kind: "rollback" });
      const rollbackApproval = `approval:${randomUUID()}`;
      await web.query("INSERT INTO updater.plan_approvals(id,plan_id,credential_id,authenticator_data,"
        + "client_data_json,signature,owner_session_digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [rollbackApproval, rollbackPlanId, CREDENTIAL, AUTH, CLIENT, SIG, OWNER_SESSION]);
      const goodRequest = `owner-request:${randomUUID()}`;
      await web.query("INSERT INTO updater.owner_requests(id,request_kind,requires_passkey,approval_id,"
        + "owner_session_digest) VALUES($1,'rollback',true,$2,$3)", [goodRequest, rollbackApproval, OWNER_SESSION]);
      assert.equal((await client.query("SELECT request_kind FROM updater.owner_requests WHERE id=$1", [goodRequest]))
        .rows[0]?.request_kind, "rollback");

      // (d) `serve_accepted` turns self-update On, so the design gives it a
      // passkey against a `kind:'setting'` plan (R4a). Naming `rollback` alone
      // in the CHECK would have forced this to `false` and REMOVED the owner's
      // Face ID from turning self-update on — a security regression wearing the
      // shape of a fix. So it is asserted both ways.
      assert.match(await refuses(web, "INSERT INTO updater.owner_requests(id,request_kind,requires_passkey,"
        + "owner_session_digest) VALUES($1,'serve_accepted',false,$2)",
      [`owner-request:${randomUUID()}`, OWNER_SESSION]), /violates check constraint "owner_request_passkey_kinds"/u);
      assert.match(await refuses(web, "INSERT INTO updater.owner_requests(id,request_kind,requires_passkey,"
        + "approval_id,owner_session_digest) VALUES($1,'serve_accepted',true,$2,$3)",
      [`owner-request:${randomUUID()}`, rollbackApproval, OWNER_SESSION]),
      /needs an approval for a setting plan, not rollback/u);
      await retirePlan(client, rollbackPlanId, "plan-m1-setting");
      const settingPlanId = "plan-m1-setting";
      await insertPlan(client, settingPlanId, { kind: "setting" });
      const settingApproval = `approval:${randomUUID()}`;
      await web.query("INSERT INTO updater.plan_approvals(id,plan_id,credential_id,authenticator_data,"
        + "client_data_json,signature,owner_session_digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [settingApproval, settingPlanId, CREDENTIAL, AUTH, CLIENT, SIG, OWNER_SESSION]);
      await web.query("INSERT INTO updater.owner_requests(id,request_kind,requires_passkey,approval_id,"
        + "owner_session_digest) VALUES($1,'serve_accepted',true,$2,$3)",
      [`owner-request:${randomUUID()}`, settingApproval, OWNER_SESSION]);

      // (e) The risk-reducing controls keep working. Every one of them is a
      // session-only request in §5.6, and a constraint that broke them would
      // break Pause, Stop and Check-and-continue — the controls that exist to
      // REDUCE risk — so they are exercised one at a time.
      for (const kind of ["pause", "resume", "stop", "backup_now", "check_and_continue", "repair_serve",
        "passkey_added"] as const) {
        const id = `owner-request:${randomUUID()}`;
        await web.query("INSERT INTO updater.owner_requests(id,request_kind,requires_passkey,owner_session_digest) "
          + "VALUES($1,$2,false,$3)", [id, kind, OWNER_SESSION]);
        assert.equal((await client.query("SELECT request_kind FROM updater.owner_requests WHERE id=$1", [id]))
          .rows[0]?.request_kind, kind, `${kind} is a session-only request and must land`);
      }

      // (f) An approval id that does not exist. The named refusal is M1's own
      // trigger, not the foreign key: a BEFORE INSERT trigger runs first, so it
      // is what the caller actually sees, and it names the problem in the
      // design's words rather than in the constraint's.
      assert.match(await refuses(web, "INSERT INTO updater.owner_requests(id,request_kind,requires_passkey,"
        + "approval_id,owner_session_digest) VALUES($1,'rollback',true,$2,$3)",
      [`owner-request:${randomUUID()}`, `approval:${randomUUID()}`, OWNER_SESSION]),
      /updater owner request cites an approval that does not exist/u);

      // (g) The pairing CHECK from item 7 still holds underneath: a passkey-backed
      // request names its approval. Stated so the two are not confused — this one
      // says "an approval is named", M1 says "and it is the RIGHT one".
      assert.match(await refuses(web, "INSERT INTO updater.owner_requests(id,request_kind,requires_passkey,"
        + "owner_session_digest) VALUES($1,'rollback',true,$2)",
      [`owner-request:${randomUUID()}`, OWNER_SESSION]), /violates check constraint "owner_request_passkey_pairing"/u);

      // (h) The kind guard runs with the WEB LOGIN's own privileges, not the
      // deployer's. Asserted on the catalog because the refusal above proves
      // nothing about privilege: the guard works either way (the web can read
      // `plans`, so it needs no definer), which is exactly why "it works" is not
      // evidence that it holds no more authority than it should. This is the
      // difference from `guard_owner_session`, which IS a definer because
      // `control_web_sessions` really is unreadable from the web side.
      const kind = await client.query<{ security_definer: boolean }>(
        "SELECT p.prosecdef AS security_definer FROM pg_catalog.pg_proc p "
        + "WHERE p.oid = 'updater.guard_owner_request_approval_kind()'::regprocedure");
      assert.equal(kind.rows[0]?.security_definer, false,
        "M1's kind guard must stay INVOKER: a definer would give it the deployer's reach for nothing");
      // The pinned path is asserted by the passkey lane's live search_path audit,
      // which parses `proconfig` with PostgreSQL's own GUC rules rather than by
      // string-matching it — re-asserting it here would be a weaker second copy,
      // and a weaker copy of a security property is worse than none.
    } finally { await client.end(); await web.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 900_000 });
});

test("the lane ran on a real cluster, not a skip", () => {
  if (PG) assert.equal(ran, required, "every PostgreSQL test in this lane ran");
});
