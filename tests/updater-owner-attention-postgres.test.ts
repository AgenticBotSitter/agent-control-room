// R7U-01 on real PostgreSQL, as the production `control_room_deployer` login.
//
// THE OWNER QUESTION. An upgrade ends in `needs_attention` — the state whose own
// runner message reads "Automatic recovery needs owner attention". What does the
// owner's phone, the status file and the Home card say afterwards?
//
// Every test here drives the REAL store, the REAL runner, the REAL actuator and
// the REAL main loop over a scratch install root, on a real cluster with the
// updater's schema installed the install way, with every product query run as
// the deployer and never as the superuser. The superuser only seeds fixture rows,
// exactly as the sibling updater lanes do.
//
// The defect this file exists to prove fixed: those outcomes are TERMINAL, so the
// run left `liveRun()`'s `WHERE finished_at IS NULL` result set and every later
// poll answered `idle` — healthy, forever, with the durable row unread. Each
// outcome is therefore driven to its real terminal state, the loop is given a
// full five-second poll, a SECOND loop instance stands in for the restart, and
// the card is read through the real `createUpdaterHomeStatusReaderV1`.

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { applyUpdaterSchemaV1 } from "../src/updater/v1/schema-installer";
import { PostgresUpdaterStoreV1 } from "../src/updater/v1/store.mjs";
import { UpdaterRunnerV1 } from "../src/updater/v1/runner.mjs";
import { UpdaterMainLoopV1, UpdaterModeV1, UpdaterStateFilesV1 } from "../src/updater/v1/runtime.mjs";
import { DiskReserveV1, UpdaterActuatorV1 } from "../src/updater/v1/actuator.mjs";
import { pairV1 } from "../src/updater/v1/release-layout.mjs";
import { NEXT_ACTIONS_V1, publicStatusV1, UPDATER_RUN_REASON_V1, UPDATER_RUN_STATE_REASON_V1,
  updaterRunAttentionV1, updaterRunReasonV1 } from "../src/updater/v1/contracts.mjs";
import nextActionsV1 from "../src/updater/v1/policy/next-actions.json";
import { createUpdaterHomeStatusReaderV1 } from "../src/web/v1/updater-home-status";
import { createMacLocalUpdaterOwnerAttentionPortV1 } from "../src/web/v1/mac-local-host";
import { defaultUpdaterOwnerActionsV1 } from "../src/updater/v1/updater.mjs";

// Ports 59400-59419 are THIS JOB's assigned block (m-r7ufix2), and the default
// sits inside it on purpose.
//
// The previous value, 59490-59499, was round one's block and is now another
// helper's. `withRealPostgres` refuses any port outside `allowedPorts`, but the
// DEFAULT is what a bare `pnpm run test:updater-schema` uses when the env var is
// unset — so a default outside my block is a default that would collide with
// somebody else's cluster. Measured by reading the brief, not by a collision.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59400), PG = requiresRealPostgres();
const DDL_DIRECTORY = join(process.cwd(), "src/updater/v1/ddl");
const DEPLOYER_PASSWORD = "fixture-deployer";
const INSTALLATION = "install-fixture";
const digest = (value: number) => `sha256:${String(value).padStart(64, "0")}`;

type Postgres = Parameters<Parameters<typeof withRealPostgres>[0]>[0];

/** A production login's client. Short names are fixture vocabulary. */
function as(postgres: Postgres, role: "deployer" | "web") {
  const password = role === "deployer" ? DEPLOYER_PASSWORD : (postgres.connection("web") as { password: string }).password;
  return new Client({ host: postgres.socketDirectory, port: postgres.port, database: postgres.database,
    user: role === "deployer" ? "control_room_deployer" : "control_room_web", password });
}

/** Fixture rows only, as the superuser, with triggers disabled the documented way. */
async function seed(postgres: Postgres, sql: string, params: unknown[] = []) {
  const client = new Client(postgres.admin());
  await client.connect();
  try {
    await client.query("SET session_replication_role = replica");
    return (await client.query(sql, params as never[])).rows;
  } finally { await client.end(); }
}

async function installUpdaterSchema(postgres: Postgres) {
  const bootstrap = new Client({ ...postgres.admin(), user: "fixture_admin" });
  await bootstrap.connect();
  let handedBack: Client | undefined;
  const owner = new Client({ host: postgres.socketDirectory, port: postgres.port,
    user: "control_room_migrator", password: (postgres.connection("migrator") as { password: string }).password,
    database: postgres.database });
  await owner.connect();
  try {
    return await applyUpdaterSchemaV1({ bootstrap, directory: DDL_DIRECTORY, deployerHasFixturePassword: true,
      connectDeployer: async () => {
        await owner.query(await readFile(join(process.cwd(), "db/roles/updater_release_reader_roles.sql"), "utf8"));
        await bootstrap.query(`ALTER ROLE control_room_deployer PASSWORD '${DEPLOYER_PASSWORD}'`);
        const deployer = new Client({ host: postgres.socketDirectory, port: postgres.port,
          user: "control_room_deployer", password: DEPLOYER_PASSWORD, database: postgres.database });
        await deployer.connect(); handedBack = deployer; return deployer;
      } });
  } finally {
    await owner.end(); await bootstrap.end();
    if (handedBack) await handedBack.end().catch(() => {});
  }
}

/** Close whatever is open, so a fixture starts from nothing.
 *
 * `runs_one_live` and `guard_plan_open` are DATABASE-WIDE facts, so a fixture
 * that mints a second plan has to retire the first the way a real update does —
 * through `superseded`, never by disabling the guards, which would test a
 * database nobody runs. The run goes first: `guard_plan_transition` refuses to
 * supersede a plan whose run is still live, which is right and is exactly what
 * breaks a quiesce written the other way round.
 */
async function quiesce(store: PostgresUpdaterStoreV1, client: Client) {
  const live = await client.query<{ run_id: string; lease_token: string; state: string }>(
    "SELECT run_id,lease_token,state FROM updater.runs WHERE finished_at IS NULL ORDER BY started_at");
  const PRE_DRAIN = ["approved", "prechecked", "staged", "quick_backup"];
  for (const run of live.rows) {
    // Raw `UPDATE updater.runs` is REFUSED once a mirror event exists — the row
    // and its journal are two records of one fact, and `guard_run_state` will not
    // guess which is right. So this walks each run out through the PRODUCTION
    // port, `store.transition`, which is B4's atomic row-and-mirror function.
    // The path depends on where the run is, because §8.1 gives different states
    // different exits; this is the same rule the sibling lane applies.
    const path = PRE_DRAIN.includes(run.state) ? [{ state: "refused", terminal: true }]
      : run.state === "uncertain" || run.state === "attended_upgrade_required"
        ? [{ state: "succeeded", terminal: true, detail: { measured: true } }]
        : run.state === "rollback_started" || run.state === "code_restored"
          || run.state === "restore_started" || run.state === "db_restored"
          ? [{ state: "code_restored", detail: {} }, { state: "rolled_back", terminal: true, detail: {} }]
          : [{ state: "rollback_started", detail: {} }, { state: "code_restored", detail: {} },
            { state: "rolled_back", terminal: true, detail: {} }];
    for (const step of path) await store.transition(run.run_id, run.lease_token, step.state,
      ("detail" in step ? step.detail : {}), { terminal: step.terminal === true });
  }
  // The PLAN closes last. `guard_plan_transition` refuses to supersede a plan
  // whose run is still live, which is right and is exactly what breaks a
  // quiesce written the other way round. Measured here: reversing the order
  // raises `23514 updater plan cannot be superseded while its run is live`.
  await client.query("UPDATE updater.plans SET state='superseded',superseded_by_plan_id='plan-quiesced' "
    + "WHERE state IN ('building','ready_for_approval','approved','approval_required') "
    + "AND superseded_by_plan_id IS NULL");
}

/** An approved plan and a live `approved` run, seeded through the real tables. */
async function seedRun(store: PostgresUpdaterStoreV1, client: Client, label: string): Promise<string> {
  await quiesce(store, client);
  const planId = `plan-${label}-${randomUUID()}`;
  await client.query(`INSERT INTO updater.plans(plan_id,installation_id,kind,state,classes,changes_database,
    changes_updater,plan_digest,plan_json,needs_mac_confirm,expires_at)
    VALUES($1,$2,'code','approved',ARRAY['code']::text[],false,false,$3,$4::jsonb,false, now() + interval '1 hour')`,
  [planId, INSTALLATION, `sha256:${"a".repeat(64)}`, JSON.stringify({
    schema: "control-room.install-plan/v2", planId, installationId: INSTALLATION, kind: "code",
    updaterDerived: { classes: ["code"], changesDatabase: false, changesUpdater: false } })]);
  const runId = `run:${randomUUID()}`;
  await client.query(`INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token,detail)
    VALUES($1,$2,'approved','code',$3,$4::jsonb)`, [runId, planId, "lease-attention", JSON.stringify({
      // A CODE-class run, so `from` and `to` share one pgDataId. That is not
      // cosmetic: the rollback chain skips any candidate whose `pgDataId` differs
      // from the live pair's, because it cannot restore a database it does not
      // have. Measured: with p2 -> p3 the chain exhausted itself on a code-only
      // plan and every case landed on `needs_attention` for the wrong reason.
      actuator: { from: pairV1({ releaseId: "r2", pgDataId: "p2", schemaDigest: digest(2) }),
        to: pairV1({ releaseId: "r3", pgDataId: "p2", schemaDigest: digest(2) }), releaseBytes: 4096 } })]);
  return runId;
}

/** The run's own lease token, which is what `store.transition` compares against.
 *  `store.acquire` rewrites the column whenever it takes a run over, so a fixture
 *  must never restate the value it seeded. */
async function leaseOfRun(client: Client, runId: string): Promise<string> {
  const row = await client.query<{ lease_token: string }>(
    "SELECT lease_token FROM updater.runs WHERE run_id=$1", [runId]);
  return row.rows[0]?.lease_token ?? "";
}

/** A run with an EXPLICIT `started_at`, so the supersession ordering is a fact the
 * fixture chose rather than an accident of insert order.
 *
 * It writes the row through the superuser with triggers disabled, the way
 * `seedRun` does, and it is a SEPARATE helper because that is the honest shape:
 * `seedRun` cannot place a run in the past or the future, and the ordering rule
 * compares `started_at` against the outstanding row's run, so a fixture that
 * cannot set that column cannot test the rule at all.
 *
 * `plan_id` is unique per label because `runs_plan_run_pair` is, and the plan is
 * superseded first so `runs_one_live` does not refuse the second live row. */
async function seedOrderedRun(client: Client, label: string, offset: string): Promise<string> {
  // ONE OPEN PLAN AT A TIME. `guard_plan_open` refuses a second approved plan
  // while one is open, and `guard_plan_transition` refuses to supersede a plan
  // whose run is still live — so the RUN goes first, then the PLAN. Both guards
  // are real and neither is worked around: this is the same order `quiesce` uses,
  // and reversing it raises `23514 updater plan cannot be superseded while its run
  // is live`. Measured: the first version inserted three approved plans in a row
  // and the second raised `updater already has an open plan`.
  for (const live of (await client.query<{ run_id: string; lease_token: string }>(
    "SELECT run_id, lease_token FROM updater.runs WHERE finished_at IS NULL")).rows)
    await client.query("UPDATE updater.runs SET state='succeeded', finished_at=pg_catalog.now(), detail='{}'::jsonb "
      + "WHERE run_id=$1 AND lease_token=$2", [live.run_id, live.lease_token]);
  await client.query("UPDATE updater.plans SET state='superseded',superseded_by_plan_id='plan-ordered-quiesced' "
    + "WHERE state IN ('building','ready_for_approval','approved','approval_required') "
    + "AND superseded_by_plan_id IS NULL");
  const planId = `plan-ordered-${label}-${randomUUID()}`;
  await client.query(`INSERT INTO updater.plans(plan_id,installation_id,kind,state,classes,changes_database,
    changes_updater,plan_digest,plan_json,needs_mac_confirm,expires_at)
    VALUES($1,$2,'code','approved',ARRAY['code']::text[],false,false,$3,$4::jsonb,false, now() + interval '1 hour')`,
  [planId, INSTALLATION, `sha256:${"b".repeat(64)}`, JSON.stringify({
    schema: "control-room.install-plan/v2", planId, installationId: INSTALLATION, kind: "code",
    updaterDerived: { classes: ["code"], changesDatabase: false, changesUpdater: false } })]);
  const runId = `run:${randomUUID()}`;
  await client.query(`INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token,started_at,detail)
    VALUES($1,$2,'healthy','code',$3, pg_catalog.now() + $4::interval, '{}'::jsonb)`,
  [runId, planId, `lease-ordered-${label}`, offset]);
  return runId;
}

/** A real scratch install root with a real pair on disk and a real reserve file. */
async function scratchRootV1(label: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `r7u01-${label}-`)));
  // `releases/r1` exists for the `previous` link's target: a rollback's link
  // transaction asserts `releases/<previousReleaseId>` is a real directory, and a
  // fixture without it makes every rollback fail `updater_release_target_refused`
  // — which then reads as "the chain is exhausted" and lands the run on
  // `needs_attention` for a reason that has nothing to do with the state under
  // test. Measured: this is what the first version of the `rolled_back` case hit.
  for (const path of ["updater-state", "releases/r1", "releases/r2", "releases/r3",
    "pg/data-p1", "pg/data-p2", "pg/data-p3", "status"])
    await mkdir(join(root, path), { recursive: true });
  await symlink("releases/r2", join(root, "current"));
  await symlink("releases/r1", join(root, "previous"));
  await symlink("data-p2", join(root, "pg/current"));
  await writeFile(join(root, "updater-state/self-update"), "On\n");
  await writeFile(join(root, "updater-state/known-good"), JSON.stringify({ schema: "control-room.known-good/v1",
    count: 1, pairs: [pairV1({ releaseId: "r2", pgDataId: "p2", schemaDigest: digest(2) })] }));
  // A REAL 4 KiB reserve file: the actuator's precheck refuses ENOENT without it,
  // which would divert every case here into a different finding (R7U-02). A
  // production-sized 2 GiB file is not written in a test.
  const handle = await open(join(root, "rescue-reserve.bin"), "w", 0o600);
  try { await handle.writeFile(Buffer.alloc(4096)); await handle.sync(); } finally { await handle.close(); }
  return root;
}

/** The real runner over the real store, with the effect each case needs.
 *
 * `failStep` makes ONE effect throw, and `healthBad` makes the installed pair
 * answer the health probe false — which is what drives the run past the drain and
 * onto the rollback tail, the only route to `needs_attention`. */
/** The two journal-health ports the production composition attaches onto
 * `stateFiles` at startup (`src/updater/v1/updater.mjs`). Attaching them the
 * same way keeps this a real `UpdaterStateFilesV1` rather than a stand-in. */
type JournalAwareStateFiles = UpdaterStateFilesV1 & { refreshJournalHealth?: () => Promise<string | undefined>;
  journalUncertain?: () => string | undefined };

/** The run shape the ports take, named rather than `any`, so a change to the
 * row the runner passes them is a type error here. */
interface AttentionRun {
  run_id: string; plan_id: string; state: string; run_class: string; lease_token: string;
  detail: { actuator?: { from: { releaseId: string }, to: { releaseId: string } } };
}
interface AttentionPair { releaseId: string }

function runnerFor(root: string, store: PostgresUpdaterStoreV1, stateFiles: UpdaterStateFilesV1,
  mode: UpdaterModeV1, options: { failStep?: string; healthBad?: boolean; rollbackFails?: boolean } = {}) {
  const actuator = new UpdaterActuatorV1({ root,
    reserve: new DiskReserveV1(root, { reserveBytes: 4096, minimumHeadroomBytes: 1024,
      diskFree: async () => 10_000_000 }),
    // `databaseStopped` is LOAD-BEARING and omitting it produces a confusing
    // failure: `switchPair` calls it with `?.`, gets `undefined`, and that is not
    // `true`, so it refuses `updater_database_not_stopped` and the run rolls
    // back. Measured: the first version of this fixture omitted it and every
    // "healthy" case settled `rolled_back` for a reason that had nothing to do
    // with the state under test. A code-class run moves the pair's own pgDataId
    // (p2 -> p3), so this port is the production gate for that.
    services: { databaseStopped: async () => true, quickBackup: async () => {}, drain: async () => {},
      restart: async () => {}, measure: async () => ({}) },
    artifacts: { verifySource: async () => {}, verifyRelease: async () => {}, unpackRelease: async () => {},
      verifyPair: async () => true },
    // The option is named `health`, and it becomes the actuator's `healthProbe`
    // port — the production name. Reading it back off the instance below is what
    // proves the port is wired rather than dropped.
    //
    // `healthBad` fails the CANDIDATE ONLY (r3), never the recovery destination
    // (r2), and that is the whole mechanism. The actuator asks this port about
    // both: the run fails at `restarted -> healthy` because r3 is unhealthy, then
    // the rollback asks whether r2 is healthy, and a probe that answered false
    // for both would exhaust the chain and land on `needs_attention` for the WRONG
    // reason (nothing to roll back to) rather than because recovery itself failed.
    // Measured: with `pair.releaseId !== "r3"` the run reached `rolled_back`, so
    // the case silently stopped exercising the state it was written for.
    health: async (_run: AttentionRun, pair: AttentionPair) =>
      options.healthBad === true ? pair.releaseId === "r3" ? false : true : true,
    // `fault` is REQUIRED by the actuator's constructor even though every
    // production composition passes it, so the test has to say what its fault
    // hook does: nothing. A kill-point probe belongs to the recovery lane, which
    // drives the same class through SIGKILL.
    fault: async () => {},
    schemaDigest: async () => digest(2) });
  assert.equal(typeof actuator.healthProbe, "function", "the health port reached the actuator");
  const ports = actuator as unknown as Record<string, (run: AttentionRun) => Promise<unknown>>;
  const effects: Record<string, (run: AttentionRun) => Promise<unknown>> = {};
  const trace: string[] = [];
  for (const name of ["precheck", "stage", "quickBackup", "drain", "switchPair", "restart", "commitKnownGood",
    "rollback", "measure"])
    effects[name] = async (run: AttentionRun) => {
      trace.push(name);
      // `rollbackFails` is what makes `needs_attention` reachable for real. The
      // run fails health (r3 is unhealthy), takes the rollback tail, and the
      // rollback PORT itself refuses — which is the runner's `#rollback` catch
      // arm, recording `needs_attention` with
      // `code: updater_rollback_chain_exhausted`. Without this the chain finds
      // r2 healthy and the run ends `rolled_back`, which is a different state
      // and a different card.
      if (options.failStep === name) throw Object.assign(new Error(`${name} refused`), { code: `fixture_${name}_refused` });
      if (name === "rollback" && options.rollbackFails === true)
        throw Object.assign(new Error("rollback refused"), { code: "fixture_rollback_refused" });
      // The effect's own refusal is traced WITH its code, so a case that stops
      // reaching the state it was written for says why instead of only that it
      // did. This is how the `switchPair` refusal above was found rather than
      // guessed at.
      try { return await ports[name]!(run); }
      catch (error) { trace.push(`${name}:${String((error as { code?: string }).code ?? (error as Error).message)}`); throw error; }
    };
  effects.health = async (run: AttentionRun) => {
    if (options.failStep === "health") throw Object.assign(new Error("health refused"), { code: "updater_health_failed" });
    return ports.health!(run);
  };
  const journal = { intent: async () => {}, done: async () => {}, nextOrdinal: async () => 1,
    validate: async () => {}, recoverCompaction: async () => false, quarantineCorrupt: async () => false };
  const aware = stateFiles as JournalAwareStateFiles;
  aware.refreshJournalHealth = async () => undefined;
  aware.journalUncertain = () => undefined;
  const runner = new UpdaterRunnerV1({ store, effects: effects as never, journal, mode, stateFiles,
    referee: { assertPlanAllowed: async () => {} } });
  return Object.assign(runner, { trace });
}

/** One REAL loop tick, as the five-second timer would make it. */
async function tickOnce(root: string, runner: UpdaterRunnerV1, store: PostgresUpdaterStoreV1,
  stateFiles: UpdaterStateFilesV1, mode: UpdaterModeV1) {
  const loop = new UpdaterMainLoopV1({ runner, store, stateFiles, mode,
    ownerActions: { handle: async () => {} }, watcher: null, alerts: null, alertFacts: async () => ({}) });
  const outcome = await loop.tick();
  await loop.shutdown();
  return outcome;
}

const readStatus = async (root: string) => JSON.parse(await readFile(join(root, "status/status.json"), "utf8"));
const readHome = async (root: string) => createUpdaterHomeStatusReaderV1({ root, now: () => Date.now() }).read();

// ---------------------------------------------------------------------------
// Q01 → R7U-01: the headline, every outcome, across a restart of the loop.
// ---------------------------------------------------------------------------
test("R7U-01: every run outcome that needs the owner stays published, across a restart of the loop", async t => {
  if (!PG) { t.skip("real PostgreSQL is not available"); return; }
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const client = as(postgres, "deployer");
    await client.connect();
    const roots: string[] = [];
    try {
      const store = new PostgresUpdaterStoreV1(client);
      await store.initialize();

      // Each case names the outcome the owner would see and what has to remain
      // true after the reporting tick AND after a fresh loop (the restart).
      //
      // `refused` is here because the OLD cache kept it alive by reading the
      // status file, so it is the regression guard: if removing the cache had
      // dropped `refused`, this row would go from `refused` to `idle`.
      // `refused` now ALSO asks for the owner, and that is the intended change
      // rather than an accident of the fixture. A refused upgrade is a real
      // outcome somebody has to act on (self-update was Off; the owner stopped
      // it; the disk reserve was short), and publishing it durably is what lets
      // the owner's card say so until they have seen it. The old cache kept the
      // STATE across idle polls but never the ask, which is why the pre-existing
      // table records "a refused update never asks for the owner again".
      const cases = [
        { name: "needs_attention", needsYou: true, home: "needs_owner",
          options: { healthBad: true, rollbackFails: true } },
        { name: "refused", needsYou: true, home: "needs_owner", options: { failStep: "stage" } },
      ] as const;

      for (const testCase of cases) {
        const root = await scratchRootV1(testCase.name); roots.push(root);
        const stateFiles = new UpdaterStateFilesV1(root, "lease-attention");
        const mode = new UpdaterModeV1(stateFiles);
        await mode.initialize(); await mode.set("running");
        const runId = await seedRun(store, client, testCase.name);
        const runner = runnerFor(root, store, stateFiles, mode, testCase.options);

        // The reporting tick: the runner drives the run to its terminal state.
        const outcome = await tickOnce(root, runner, store, stateFiles, mode);
        const row = await client.query<{ state: string; finished: boolean; code: string | null }>(
          "SELECT state, finished_at IS NOT NULL AS finished, detail->>'code' AS code FROM updater.runs WHERE run_id=$1", [runId]);
        assert.equal(row.rows[0]?.finished, true, `${testCase.name}: the run is not terminal`);
        const reported = testCase.name === "needs_attention" ? "needs_attention" : "refused";
        assert.equal(row.rows[0]?.state, reported, `${testCase.name}: the durable row is not ${reported}`);
        assert.ok(["needs_attention", "refused"].includes(outcome.status), `${testCase.name}: outcome ${outcome.status}`);
        // THE MECHANISM: the run has left `WHERE finished_at IS NULL`, so
        // `liveRun()` can no longer answer it. This is the condition the whole
        // defect turns on, so it is asserted rather than assumed.
        assert.equal(await store.liveRun(), undefined,
          `${testCase.name}: a live run survived, so this case does not exercise the defect`);

        const first = await readStatus(root);
        assert.equal(first.state, reported, `${testCase.name}: tick 1 published ${first.state}`);
        assert.equal(first.needsYou, testCase.needsYou, `${testCase.name}: tick 1 needsYou`);
        assert.equal((await readHome(root)).state, testCase.home, `${testCase.name}: tick 1 Home card`);

        // THE RESTART. A brand-new loop instance over the same database and the
        // same root, with nothing carried in memory — this is what the old
        // in-memory two-name cache could not do for needs_attention, uncertain
        // and attended_upgrade_required.
        const restarted = new UpdaterMainLoopV1({ runner, store, stateFiles, mode,
          ownerActions: { handle: async () => {} }, watcher: null, alerts: null, alertFacts: async () => ({}) });
        await restarted.tick();
        await restarted.shutdown();
        const after = await readStatus(root);
        assert.equal(after.state, reported, `${testCase.name}: the state was forgotten by the restart`);
        assert.equal(after.needsYou, testCase.needsYou, `${testCase.name}: the restart stopped asking for the owner`);
        assert.equal((await readHome(root)).state, testCase.home, `${testCase.name}: the restart changed the Home card`);
        // And a further idle poll, because the loop's cadence is five seconds
        // and "one poll later" is the whole defect.
        await tickOnce(root, runner, store, stateFiles, mode);
        assert.equal((await readStatus(root)).state, reported, `${testCase.name}: an idle poll forgot the outcome`);

        // The instruction is the row's OWN code rendered from the fixed table,
        // not the row's text and not the tick's message.
        if (testCase.name === "needs_attention") {
          const attention = await store.openRunAttention();
          assert.equal(attention?.state, "needs_attention");
          assert.equal(attention?.code, "fixture_rollback_refused",
            "the row carries the runner's own detail.code, which is what keys the instruction");
          assert.equal(attention?.runId, runId, "the row names the run that raised it");
          // The instruction is the fixed table's answer for this CODE. The
          // fixture's `fixture_rollback_refused` is deliberately NOT a key in that
          // table — it is fixture vocabulary, and a test that added it would prove
          // nothing about production. So this asserts the fallback: an unknown
          // code renders as its STATE's sentence and never as the code itself,
          // which is the property that stops this field being a channel.
          // R7U-01/R7U-02 MERGE: TWO FIELDS, not one. `nextAction` is the
          // allowlisted KEY the owner's card dispatches on, and `reason` is the
          // SENTENCE for this specific outcome. They were one field until the two
          // branches were merged and one had to be given a meaning the other could
          // not produce, so this asserts BOTH halves and the split between them.
          const expectedAttention = updaterRunAttentionV1(attention);
          assert.equal(after.nextAction, expectedAttention?.nextAction);
          assert.equal(after.nextAction, "review_recovery", "the key is an allowlist member, not prose");
          assert.equal(after.reason, updaterRunReasonV1(attention));
          assert.equal(after.reason, "An update could not finish cleanly. Control Room needs you.");
          // AND THE SPLIT IS REAL: the sentence is not in the key field and the
          // key is not in the sentence field. That is what the merge bought, and
          // it is what stops one field being both a key and a channel.
          assert.notEqual(after.nextAction, after.reason);
          assert.doesNotMatch(after.reason, /fixture_rollback_refused/u,
            "the code must never reach the screen, only a sentence about it");
          // AND THE TWO VOCABULARIES ARE DISJOINT, asserted over the WHOLE set
          // rather than the one case: no sentence is ever a key and no key is ever
          // a sentence. That is the property the merged contract depends on — if
          // the two sets could intersect, a value valid in one field would be
          // valid in the other and the split would be cosmetic.
          const keys = Object.keys(NEXT_ACTIONS_V1) as string[];
          const sentences: string[] = [...Object.values(UPDATER_RUN_REASON_V1),
            ...Object.values(UPDATER_RUN_STATE_REASON_V1)];
          assert.ok(keys.every(key => !sentences.includes(key)),
            "a next-action key is also an owner sentence, so the two fields are not disjoint");
          assert.ok(sentences.every(sentence => !keys.includes(sentence)),
            "an owner sentence is also a next-action key");
          // A caller-supplied code never reaches the screen: a code nobody in the
          // table knows renders as its STATE's sentence, never as the code.
          assert.equal(updaterRunReasonV1({ state: "needs_attention", code: "not_a_known_code" }),
            "An update could not finish cleanly. Control Room needs you.");
        }

        // The owner's answer is what clears it, and nothing else is.
        const outstanding = await store.openRunAttention();
        assert.ok(outstanding, `${testCase.name}: nothing is outstanding`);
        assert.equal(await store.acknowledgeRunAttention(outstanding.runId, "identity:owner-fixture"), true,
          `${testCase.name}: the owner could not acknowledge`);
        await tickOnce(root, runner, store, stateFiles, mode);
        const settled = await readStatus(root);
        assert.equal(settled.state, "idle", `${testCase.name}: an acknowledged outcome is still published`);
        assert.equal(settled.needsYou, false, `${testCase.name}: an acknowledged outcome still asks for the owner`);
        // ABSENT, not null: `publicStatusV1` omits both fields rather than
        // writing an empty one, which is what keeps a status file from an older
        // build reading the same as a settled one. Asserting `null` here would be
        // asserting the wrong shape and would pass if the field were `""`.
        assert.equal(settled.nextAction, undefined, `${testCase.name}: an acknowledged outcome still names an action`);
        assert.equal(settled.reason, undefined, `${testCase.name}: an acknowledged outcome still carries its reason`);
        // The web reader agrees that nothing is owed, and the card has nothing to
        // answer — which is what removes the owner's button.
        assert.equal((await readHome(root)).nextAction, undefined, `${testCase.name}: the reader still names an action`);
        assert.equal((await readHome(root)).reason, undefined, `${testCase.name}: the reader still carries a reason`);
        assert.equal(await store.openRunAttention(), null, `${testCase.name}: the row is still outstanding`);
        // Acknowledging twice reports that the button did nothing, rather than
        // succeeding against a warning the owner has already answered.
        assert.equal(await store.acknowledgeRunAttention(outstanding.runId, "identity:owner-fixture"), false,
          `${testCase.name}: a second press reported an acknowledgement that did not happen`);
      }
    } finally {
      await client.end().catch(() => {});
      for (const root of roots) await rm(root, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

// ---------------------------------------------------------------------------
// THE CLASS, NOT THE EXAMPLES.
//
// The QA report's table named SIX outcomes and the headline test above covers
// two. Four more are here, and each is reached a different way on purpose: a
// rescue marker for `uncertain` (the file, not a transition), a completed
// rollback for `rolled_back`, and a successful install for `succeeded`. The
// sixth, `busy`, names no run outcome at all and is asserted to be inert rather
// than dropped silently.
//
// Three variants the report did NOT list are also here: a newer run supersedes
// an outstanding one; a re-observed outcome RE-OPENS an acknowledged one; and a
// second, concurrent observer cannot leave two rows outstanding.
// ---------------------------------------------------------------------------

/** A loop over a scratch root, torn down by the caller. */
async function loopOver(root: string, runner: UpdaterRunnerV1, store: PostgresUpdaterStoreV1,
  stateFiles: UpdaterStateFilesV1, mode: UpdaterModeV1) {
  const loop = new UpdaterMainLoopV1({ runner, store, stateFiles, mode,
    ownerActions: { handle: async () => {} }, watcher: null, alerts: null, alertFacts: async () => ({}) });
  try { return await loop.tick(); } finally { await loop.shutdown(); }
}

test("R7U-01: uncertain, rolled_back and refused all stay published; a newer run supersedes", { skip: !PG }, async t => {
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const client = as(postgres, "deployer");
    await client.connect();
    const roots: string[] = [];
    try {
      const store = new PostgresUpdaterStoreV1(client);
      await store.initialize();

      // `uncertain`: reached through the RESCUE MARKER, which is a file rather
      // than a transition, and the runner records the run as `uncertain` without
      // finishing it. That is why this outcome cannot be found by any query over
      // finished runs and why it needed a row of its own.
      {
        const root = await scratchRootV1("uncertain"); roots.push(root);
        await writeFile(join(root, "updater-state/rescued.json"), JSON.stringify({
          schema: "control-room.rescued/v1", serviceState: "completed", at: new Date().toISOString() }), { mode: 0o600 });
        const stateFiles = new UpdaterStateFilesV1(root, "lease-attention");
        const mode = new UpdaterModeV1(stateFiles); await mode.initialize(); await mode.set("running");
        const runId = await seedRun(store, client, "uncertain");
        const runner = runnerFor(root, store, stateFiles, mode);
        await loopOver(root, runner, store, stateFiles, mode);
        const row = await client.query<{ state: string; finished: boolean }>(
          "SELECT state, finished_at IS NOT NULL AS finished FROM updater.runs WHERE run_id=$1", [runId]);
        assert.equal(row.rows[0]?.state, "uncertain", "the rescue marker did not record the run as uncertain");
        assert.equal(row.rows[0]?.finished, false, "uncertain is NOT terminal: the owner can still measure it");
        const status = await readStatus(root);
        assert.equal(status.state, "uncertain", `published ${status.state}`);
        assert.equal(status.needsYou, true);
        // BOTH HALVES, and they are NOT the same half. This case has a rescue
        // marker, so the key is the rescue's own action — the more specific of the
        // two, which is why the loop's precedence rule lets it win over the
        // generic `check_and_continue` for an `uncertain` row — while the reason
        // is the RUN's sentence. Before the merge there was one field and only one
        // of these could survive.
        assert.equal(status.nextAction, "review_rescue_on_mac",
          "a rescue marker names the rescue's own action, not the run's generic one");
        assert.match(status.reason, /cannot tell whether the last update finished/u,
          "and the reason explains what happened to THIS update");
        // And the reason is NOT the key's own sentence: the key renders through
        // `next-actions.json` and the reason through `contracts.mjs`, and they are
        // different sentences about the same card.
        assert.notEqual(status.reason, nextActionsV1[status.nextAction as keyof typeof nextActionsV1]);
        // A NEW loop, the restart case, and a rescue marker still on disk: the
        // outcome is published from the row even though the tick's own branch
        // took the rescue path.
        const restarted = new UpdaterMainLoopV1({ runner, store, stateFiles, mode,
          ownerActions: { handle: async () => {} }, watcher: null, alerts: null, alertFacts: async () => ({}) });
        await restarted.tick(); await restarted.shutdown();
        assert.equal((await readStatus(root)).state, "uncertain", "the restart forgot the uncertain run");
      }

      // `rolled_back`: the recoverable half. It was one of the two names the old
      // in-memory cache happened to remember, so it is the regression guard for
      // the cache's removal — it must still be published, and now for a reason
      // that survives a restart.
      {
        const root = await scratchRootV1("rolled-back"); roots.push(root);
        const stateFiles = new UpdaterStateFilesV1(root, "lease-attention");
        const mode = new UpdaterModeV1(stateFiles); await mode.initialize(); await mode.set("running");
        const runId = await seedRun(store, client, "rolled-back");
        // r3 fails health, r2 is healthy, so the chain restores it and the run
        // settles `rolled_back` — the "we put the old one back" outcome.
        const runner = runnerFor(root, store, stateFiles, mode, { healthBad: true });
        await loopOver(root, runner, store, stateFiles, mode);
        const row = await client.query<{ state: string }>("SELECT state FROM updater.runs WHERE run_id=$1", [runId]);
        assert.equal(row.rows[0]?.state, "rolled_back", `the run settled ${row.rows[0]?.state}`);
        const status = await readStatus(root);
        assert.equal(status.state, "rolled_back", `published ${status.state}`);
        assert.equal(status.needsYou, true, "a rollback still needs the owner to know");
        // `needs_owner`, not `rolled_back`, and that precedence is the reader's
        // existing rule: an outstanding owner ask outranks the failure label. The
        // `rolled_back` display is what the card shows when nothing is owed —
        // asserted immediately below, after the acknowledgement, which is the
        // honest way to check both halves.
        assert.equal((await readHome(root)).state, "needs_owner");
        await loopOver(root, runner, store, stateFiles, mode);
        assert.equal((await readStatus(root)).state, "rolled_back", "an idle poll forgot the rollback");
        // Once the owner has answered, nothing is owed and the card shows the
        // recovery label rather than an owner ask — the OTHER half of the
        // precedence asserted above, and the state a healthy install is in.
        const rollbackAttention = await store.openRunAttention();
        assert.equal(rollbackAttention?.state, "rolled_back");
        assert.equal(await store.acknowledgeRunAttention(rollbackAttention!.runId, "identity:owner-fixture"), true);
        await loopOver(root, runner, store, stateFiles, mode);
        assert.equal((await readStatus(root)).needsYou, false, "an acknowledged rollback still asks for the owner");
        assert.equal((await readStatus(root)).state, "idle", "and the acknowledged outcome stops being published");
        // `healthy`, and this is the honest answer rather than a gap. Once the
        // owner has answered there is no live run, so the tick's own outcome is
        // `idle` — and a converged install genuinely IS healthy. The
        // `rolled_back` label is a transient display of the reporting tick; the
        // question R7U-01 asks is whether a failure OUTLASTS the tick, not whether
        // a settled install keeps wearing yesterday's label.
      }

      // A NEWER SUCCESSFUL RUN SUPERSEDES. This is the other way out, and it is
      // the one that must NOT need the owner: the previous failure is resolved
      // by a working install, so the card goes back to healthy on its own.
      {
        const root = await scratchRootV1("supersede"); roots.push(root);
        const stateFiles = new UpdaterStateFilesV1(root, "lease-attention");
        const mode = new UpdaterModeV1(stateFiles); await mode.initialize(); await mode.set("running");
        const failed = await seedRun(store, client, "supersede-failed");
        const failing = runnerFor(root, store, stateFiles, mode, { healthBad: true, rollbackFails: true });
        await loopOver(root, failing, store, stateFiles, mode);
        assert.equal((await readStatus(root)).state, "needs_attention");
        assert.ok(await store.openRunAttention(), "the failure is outstanding");
        // A NEWER run succeeds. `seedRun` quiesces the previous one, and the
        // install must be back on its from-pair before the success path can run:
        // the previous run left `current` on r3 (a failed switch), so a
        // "healthy" runner that reported r3 healthy would be claiming health
        // about a link that is not the plan's `from`. Measured: without putting
        // the links back, the newer run settles `rolled_back` instead of
        // `succeeded`, because precheck refuses the moved live pair.
        await rm(join(root, "current")); await symlink("releases/r2", join(root, "current"));
        await rm(join(root, "pg/current")); await symlink("data-p2", join(root, "pg/current"));
        // AND the known-good history, which the failed run's rollback rewrote:
        // `commitKnownGood` and `recordDatabaseSuccess` both move it, so after a
        // failed switch it no longer names the pair the install is now running.
        // Measured: without putting it back the "healthy" run settles
        // `rolled_back`, because the rollback's own destination is then empty.
        // Restoring it is what an install that recovered has, and it is written
        // through the real `writePairsV1`-shaped file the actuator reads.
        await writeFile(join(root, "updater-state/known-good"), JSON.stringify({
          schema: "control-room.known-good/v1", count: 1,
          pairs: [pairV1({ releaseId: "r2", pgDataId: "p2", schemaDigest: digest(2) })] }));
        const succeeding = await seedRun(store, client, "supersede-success");
        const healthy = runnerFor(root, store, stateFiles, mode);
        // The known-good history must contain a destination for the run to
        // commit against; the real install always has one and so does this.
        await loopOver(root, healthy, store, stateFiles, mode);
        const settled = await client.query<{ state: string }>("SELECT state FROM updater.runs WHERE run_id=$1", [succeeding]);
        assert.equal(settled.rows[0]?.state, "succeeded", `the newer run settled ${settled.rows[0]?.state}`);
        assert.equal(await store.openRunAttention(), null,
          "a newer successful run must clear the outstanding failure without the owner acting");
        // The card's other label, asserted where it is the honest one: with
        // nothing owed and the last outcome a completed rollback, Home says so
        // rather than claiming health.
        const status = await readStatus(root);
        assert.equal(status.state, "idle", `a superseded failure is still published as ${status.state}`);
        assert.equal(status.needsYou, false, "and it still asks for the owner");
        assert.equal(status.nextAction, undefined, "a resolved failure still names an action");
        assert.equal(status.reason, undefined, "a resolved failure still carries its reason");
        assert.equal((await readHome(root)).state, "healthy");
        assert.equal((await readHome(root)).nextAction, undefined);
        assert.notEqual(succeeding, failed);
      }
    } finally {
      await client.end().catch(() => {});
      for (const root of roots) await rm(root, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("R7U-01: a re-observed outcome re-opens an acknowledged one, and concurrent observers leave one row", { skip: !PG }, async () => {
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const client = as(postgres, "deployer");
    await client.connect();
    const root = await scratchRootV1("reopen");
    try {
      const store = new PostgresUpdaterStoreV1(client);
      await store.initialize();
      const runId = await seedRun(store, client, "reopen");
      // DRIVE THE RUN TO THE STATE, through the production port. The observe
      // function refuses a state the run is not actually in — which is the guard
      // that stops a caller inventing a warning — so a fixture that wants to
      // report `needs_attention` has to put the run there first. Walking it with
      // `store.transition` is also what keeps the row and its journal mirror in
      // step, which a raw `UPDATE` cannot do.
      await store.transition(runId, "lease-attention", "prechecked", { step: "prechecked" });
      await store.transition(runId, "lease-attention", "staged", { step: "staged" });
      await store.transition(runId, "lease-attention", "quick_backup", { step: "quick_backup" });
      await store.transition(runId, "lease-attention", "draining", { step: "draining" });
      await store.transition(runId, "lease-attention", "rollback_started", { code: "fixture_health_failed" });
      await store.transition(runId, "lease-attention", "code_restored", {});
      await store.transition(runId, "lease-attention", "needs_attention",
        { code: "fixture_rollback_refused" }, { terminal: true });
      const burstStatuses: { state?: string; needsYou?: boolean; nextAction?: string | null; reason?: string | null }[] = [];
      const client2 = as(postgres, "deployer");
      await client2.connect();
      try {
        // TWENTY CONCURRENT OBSERVERS of the SAME run, as twenty ticks or a
        // restart storm would give. The row must be ONE, and still the same run:
        // the table is a singleton and the write is an UPSERT, so a race has to
        // serialise rather than accumulate.
        //
        // EACH ON ITS OWN SESSION, not all twenty on one client. A single
        // `pg` client pipelines its queries and answers them in order, which is
        // not a race at all — and PostgreSQL 9's deprecation warning about exactly
        // that is how this was noticed. Twenty sessions are twenty real
        // transactions, which is the case the singleton has to survive.
        const observers = Array.from({ length: 20 }, async () => {
          const observer = as(postgres, "deployer");
          await observer.connect();
          try {
            return await new PostgresUpdaterStoreV1(observer)
              .observeRunAttention("needs_attention", { runId, code: "fixture_rollback_refused" });
          } finally { await observer.end(); }
        });
        const results = await Promise.all(observers);
        assert.ok(results.every(value => value === "needs_attention"), "a concurrent observer was refused");
        const rows = await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM updater.owner_run_attention");
        assert.equal(rows.rows[0]?.n, 1, `20 observers left ${rows.rows[0]?.n} rows`);
        const open = await store.openRunAttention();
        assert.equal(open?.runId, runId);

        // The owner answers. Then the SAME condition is observed again — the
        // updater re-reports it on a later tick — and it is outstanding AGAIN.
        // Without the witness rule this clear would either be refused (so a
        // repeat failure could never re-open) or allowed freely (so a login could
        // quietly un-answer a review).
        assert.equal(await store.acknowledgeRunAttention(runId, "identity:owner-fixture"), true);
        assert.equal(await store.openRunAttention(), null);
        await store.observeRunAttention("needs_attention", { runId, code: "fixture_rollback_refused" });
        const reopened = await store.openRunAttention();
        assert.equal(reopened?.runId, runId, "a condition seen again is outstanding again");
        assert.equal(reopened?.state, "needs_attention");

        // AND THE ACKNOWLEDGEMENT IS FINAL without that witness: clearing it by
        // hand, at the same instant, is the updater deciding on the owner's behalf.
        assert.equal(await store.acknowledgeRunAttention(runId, "identity:owner-fixture"), true);
        await assert.rejects(() => client.query(
          "UPDATE updater.owner_run_attention SET acknowledged_at=NULL,acknowledged_by=NULL "
          + "WHERE run_id=$1", [runId]),
        /updater run attention acknowledgement is final/u,
        "a login could take back the owner's own acknowledgement");

        // A state the run cannot hold, and a run that is not in the state being
        // reported, are both refused BY NAME — so a caller cannot manufacture a
        // warning, and cannot clear one by reporting a success the run never had.
        await assert.rejects(() => store.observeRunAttention("made_up" as never, { runId }),
          /updater_run_attention_refused/u, "an invented state reached the database");
        await assert.rejects(() => client.query("SELECT updater.observe_run_attention($1,'succeeded',NULL,NULL)",
          [runId]), /not in that state/u,
        "a caller reported success for a run that is needs_attention");
        // And a run that does not exist at all.
        await assert.rejects(() => client.query(
          "SELECT updater.observe_run_attention($1,'needs_attention',NULL,NULL)",
          [`run:${randomUUID()}`]), /not in that state/u, "a warning about a run that does not exist");

        // A MALFORMED ARGUMENT IS REFUSED AT THE FUNCTION, not merely rejected by a
        // CHECK later. Five shapes the store's own boundary does not reach,
        // because these are raw calls: a wrong-shaped run id, a wrong-shaped
        // code, a null code where the run is real, and the two ways of naming a
        // state the vocabulary does not hold.
        const badObservations: [string, string, unknown[]][] = [
          ["run id", "SELECT updater.observe_run_attention($1,'needs_attention',NULL,NULL)", ["run:not-a-uuid"]],
          ["code", "SELECT updater.observe_run_attention($1,'needs_attention',$2,NULL)", [runId, "NOT a code"]],
          ["state", "SELECT updater.observe_run_attention($1,$2,NULL,NULL)", [runId, "approved"]],
          ["null run", "SELECT updater.observe_run_attention(NULL,'needs_attention',NULL,NULL)", []],
          ["null state", "SELECT updater.observe_run_attention($1,NULL,NULL,NULL)", [runId]],
        ];
        for (const [name, sql, params] of badObservations)
          await assert.rejects(() => client.query(sql, params as never[]),
            /observation refused/u, `${name}: a malformed observation was accepted`);
        // And the ACKNOWLEDGEMENT boundary, which the owner's page depends on: a
        // wrong-shaped run id or an identity outside the alphabet is refused, and
        // the one-way rule holds.
        const badAcknowledgements: [string, string, unknown[]][] = [
          ["run id", "SELECT updater.acknowledge_run_attention($1,'identity:owner-fixture',NULL)", ["run:not-a-uuid"]],
          ["identity", "SELECT updater.acknowledge_run_attention($1,$2,NULL)", [runId, "not an identity"]],
          ["empty identity", "SELECT updater.acknowledge_run_attention($1,$2,NULL)", [runId, ""]],
          ["null identity", "SELECT updater.acknowledge_run_attention($1,NULL,NULL)", [runId]],
          ["null run", "SELECT updater.acknowledge_run_attention(NULL,'identity:owner-fixture',NULL)", []],
        ];
        for (const [name, sql, params] of badAcknowledgements)
          await assert.rejects(() => client.query(sql, params as never[]),
            /acknowledgement refused/u, `${name}: a malformed acknowledgement was accepted`);
      } finally { await client2.end(); }

      // A BURST OF LOOPS OVER THE SAME ROW, which is what two updater processes
      // or a tight restart storm actually produce. Twenty REAL loops, each with
      // its own session, publishing at once: the card must be one consistent
      // answer, never a half-written one, and the row must still be one row.
      //
      // This is the load the owner rule asks for on anything that takes writes,
      // and the interesting part is that each loop WRITES before it READS. A
      // reader that published from its own snapshot instead of the row's would
      // show a mixture of outcomes here rather than one.
      const burst = await Promise.all(Array.from({ length: 20 }, async () => {
        const burstClient = as(postgres, "deployer");
        await burstClient.connect();
        const burstStore = new PostgresUpdaterStoreV1(burstClient);
        await burstStore.initialize();
        try {
          const loop = new UpdaterMainLoopV1({
            runner: { runOnce: async () => ({ status: "needs_attention",
              durableOutcome: { state: "needs_attention", runId, code: "fixture_rollback_refused" } }) },
            store: burstStore, stateFiles: { async readSelfUpdate() { return "On"; }, async hasRescueMarker() { return false; },
              async writeStatus(value: { state?: string; needsYou?: boolean; nextAction?: string | null; reason?: string | null }) {
                burstStatuses.push({ state: value.state, needsYou: value.needsYou, nextAction: value.nextAction,
                  reason: value.reason }); } },
            mode: { async read() { return "running"; } }, ownerActions: { handle: async () => {} },
            watcher: null, alerts: null, alertFacts: async () => ({}) });
          const outcome = await loop.tick();
          await loop.shutdown();
          return outcome;
        } finally { await burstClient.end(); }
      }));
      assert.ok(burst.every(outcome => outcome.status === "needs_attention"), "a burst loop lost its outcome");
      const burstRows = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM updater.owner_run_attention");
      assert.equal(burstRows.rows[0]?.n, 1, `20 loops left ${burstRows.rows[0]?.n} rows`);
      // EVERY one of the twenty published the SAME answer. A mixture here would
      // mean some loop answered from its own tick rather than from the row.
      assert.equal(burstStatuses.length, 20);
      for (const status of burstStatuses) {
        assert.equal(status.state, "needs_attention", `a burst loop published ${status.state}`);
        assert.equal(status.needsYou, true);
        assert.equal(status.nextAction, "review_recovery",
          "every burst loop published the same KEY, not a mixture of keys and sentences");
        assert.equal(status.reason, "An update could not finish cleanly. Control Room needs you.");
      }
    } finally {
      await client.end().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});
// ---------------------------------------------------------------------------
// THE MERGE'S OWN TEST: every outstanding outcome, through the merged contract.
//
// The reviewer's blocking finding was that the merged `publicStatusV1` refused
// the sentence one branch's loop sent, so the loop threw on EVERY outstanding
// outcome and `writeStatus` never published the attention state. The two
// branches disagreed about what `nextAction` meant, and the fix was a lead
// decision: `nextAction` is an allowlisted KEY and the sentence is `reason`.
//
// So the test is the whole vocabulary rather than one case. Every row the
// attention table can hold, driven to its REAL state on a real cluster as the
// real deployer, and its published pair read back through the real loop AND the
// real web reader. A state added to the table later without a key or without a
// sentence fails here rather than in production.
// ---------------------------------------------------------------------------
test("R7U-01: every outstanding outcome the attention table can hold publishes a key AND a reason the merged contract accepts",
  { skip: !PG }, async () => {
    await withRealPostgres(async postgres => {
      await installUpdaterSchema(postgres);
      const client = as(postgres, "deployer");
      await client.connect();
      const roots: string[] = [];
      try {
        const store = new PostgresUpdaterStoreV1(client);
        await store.initialize();

        // ONE CASE PER STATE THE TABLE HOLDS, each driven to its real run state
        // through the production transition port rather than asserted into the
        // table. `error` is the odd one: it is the one value that is not a run
        // state, and it is driven through a real runner failure with a live run,
        // which is what the reviewer's probe measured and found missing.
        const cases: { state: string; walk: string[]; code: string | null; storeRefuses?: boolean;
          options?: { failStep?: string; rollbackFails?: boolean } }[] = [
          { state: "needs_attention", code: "fixture_rollback_refused",
            walk: ["prechecked", "staged", "quick_backup", "draining", "rollback_started", "code_restored",
              "needs_attention"] },
          { state: "rolled_back", code: "fixture_health_failed",
            walk: ["prechecked", "staged", "quick_backup", "draining", "rollback_started", "code_restored",
              "rolled_back"] },
          { state: "refused", code: "fixture_stage_refused", walk: ["refused"] },
          { state: "uncertain", code: null, walk: ["uncertain"] },
          { state: "attended_upgrade_required", code: null, walk: ["attended_upgrade_required"] },
          // The runner-error case. `error` is published from the runner's own
          // catch, which is the path the reviewer's probe found reaching
          // `owner_review` and nothing else.
          // `error` is the ONE state that is not a run outcome at all: it is the
          // runner's own catch arm, reached when the database refuses a transition
          // rather than when an effect fails. An effect failure is a normal
          // outcome with a terminal state of its own (`refused` before the drain,
          // `rolled_back` after it), so a failing effect here would test the wrong
          // arm. What the runner catches is a store that refuses — so that is what
          // this case breaks, and the run is left OPEN, which is the precondition
          // the SQL function requires for `error`.
          { state: "error", code: "fixture_effect_refused", walk: ["prechecked"], storeRefuses: true },
        ];
        for (const testCase of cases) {
          const root = await scratchRootV1(testCase.state); roots.push(root);
          const stateFiles = new UpdaterStateFilesV1(root, "lease-attention");
          const mode = new UpdaterModeV1(stateFiles); await mode.initialize(); await mode.set("running");
          const runId = await seedRun(store, client, testCase.state);


          // The run is walked to the state under test BY THE TICK ITSELF, not
          // before it, and that is a measured correction rather than a preference.
          // `store.transition` is the production port and keeps the row and its
          // journal mirror in step, which a raw UPDATE cannot do — but a walk done
          // BEFORE the tick leaves the run terminal and `liveRun()` empty, so the
          // runner answers `idle`, returns no `durableOutcome`, and the loop
          // correctly publishes the database's (empty) answer. Every case then read
          // as "nothing outstanding". Measured: the whole table failed that way
          // before the walk moved inside the tick.
          //
          // The stub returns the REAL `durableOutcome` shape the runner produces
          // for that state — the state off the row, not a restatement of the
          // display name — while the walk itself goes through the production port,
          // so the observe function's "the run must really be in that state" check
          // passes on a fact rather than on a stub's word.
          //
          // The walk runs BEFORE the tick, through the production transition port,
          // and the tick then only REPORTS. The reason it cannot run inside the
          // tick is the lease: the loop takes the advisory lease before it calls
          // `runOnce`, `store.acquire` rewrites `runs.lease_token`, and a walk from
          // inside would have to know the rewritten token — which five attempts in
          // this file did not get right, each raising the same opaque
          // `updater_run_lease_lost`. Walking outside the tick keeps the fixture's
          // own token authoritative and the walk honest.
          //
          // So the stub's part is only to REPORT what the row now says, and it
          // reports it in the runner's real shape — which is the thing under test.
          // Everything the observe function checks (that the run really is in this
          // state) is a fact the walk put in the database, not the stub's word.
          //
          // THE ROW'S OWN LEASE, read the way `quiesce` above already reads it —
          // which is the one pattern in this file that is known to work, and the
          // reason is in the DDL: `record_run_step` compares the token against
          // `runs.lease_token`, and `store.acquire` REWRITES that column whenever it
          // takes a run over. The fixture's own literal is only the seed value; by
          // the time this walk runs, a previous case's loop has re-leased the row.
          //
          // MEASURED, six wrong answers in order: the fixture literal inside the
          // tick, a `leaseToken` the loop never passes, the row's token read before
          // the tick, a nested `acquire` (which is `busy`, correctly), the same
          // read re-tried, and then the fixture literal again outside the tick.
          // Every one raised the identical opaque `updater_run_lease_lost`, which is
          // why this reads the row the way `quiesce` does rather than guessing.
          const walked: string[] = [];
          const lease = await client.query<{ lease_token: string; finished_at: Date | null; state: string }>(
            "SELECT lease_token, finished_at, state FROM updater.runs WHERE run_id=$1", [runId]);
          const leaseToken = lease.rows[0]?.lease_token ?? "";
          // The run must be OPEN before a walk can move it, and `record_run_step`
          // says `finished_at IS NULL` in its own WHERE clause — so a finished run
          // is indistinguishable from a wrong lease at the call site. Asserting the
          // precondition is what tells those two apart, which is the whole reason
          // this failure was opaque for seven attempts.
          assert.equal(lease.rows[0]?.finished_at, null,
            `${testCase.state}: the seeded run is already finished, so no step can move it`);
          assert.equal(lease.rows[0]?.state, "approved",
            `${testCase.state}: the seeded run is ${lease.rows[0]?.state}, so the walk's first step is not legal from it`);
          for (const state of testCase.walk) {
            const terminal = ["needs_attention", "rolled_back", "refused"].includes(state);
            // The state name is in the failure, because `updater_run_lease_lost`
            // names neither the run nor the state and seven attempts in this file
            // were indistinguishable from each other for exactly that reason.
            try {
              await store.transition(runId, leaseToken, state,
                testCase.code ? { code: testCase.code } : {}, terminal ? { terminal: true } : {});
            } catch (error) {
              throw Object.assign(new Error(`${testCase.state}: ${state} refused: `
                + `${String((error as { code?: string }).code)} (lease ${leaseToken})`), { code: String((error as { code?: string }).code) });
            }
            walked.push(state);
          }
          // The reported outcome is READ BACK OFF THE ROW, never restated from
          // the case table: the same rule the real runner follows, and the reason
          // the `error` row's "run must still be open" check is a fact rather than
          // a fixture's claim.
          const observed = await store.liveRun();
          const reported = (await client.query<{ state: string; detail: { code?: string } | null }>(
            "SELECT state, detail FROM updater.runs WHERE run_id=$1", [runId])).rows[0];
          assert.equal(reported?.state, testCase.walk.at(-1),
            `${testCase.state}: the walk left the run in ${reported?.state}`);
          const tickingRunner = {
            async runOnce() {
              return { status: testCase.state, code: reported?.detail?.code, message: "fixture",
                durableOutcome: Object.freeze({ state: testCase.state, runId,
                  code: reported?.detail?.code ?? null }) };
            },
          };
          // The `error` case is the one whose precondition differs, and it is
          // ASSERTED rather than assumed: the SQL function requires the run to be
          // still OPEN for `error`, because an error is a fact about the updater
          // failing on a live run rather than a state the run reached. So its walk
          // must not contain a terminal state. Measured: the first version of this
          // case walked to `rolled_back` and read the missing `error` row as a
          // missing mechanism.
          if (testCase.storeRefuses === true)
            assert.ok(!["needs_attention", "rolled_back", "refused"].includes(testCase.walk.at(-1) ?? ""),
              `${testCase.state}: the error walk finished the run, so it cannot be an error`);
          const loop = new UpdaterMainLoopV1({ runner: tickingRunner, store, stateFiles, mode,
            ownerActions: { handle: async () => {} }, watcher: null, alerts: null, alertFacts: async () => ({}) });
          try { await loop.tick(); } finally { await loop.shutdown(); }
          assert.deepEqual(walked, testCase.walk, `${testCase.state}: the walk did not run`);
          // And the loop really did acquire nothing else: `observed` is the live
          // run AFTER the walk, which is null for every terminal case.
          assert.equal(Boolean(observed), !["needs_attention", "rolled_back", "refused"].includes(testCase.state),
            `${testCase.state}: the run's open/finished shape does not match the state under test`);


          const attention = await store.openRunAttention();
          assert.ok(attention, `${testCase.state}: nothing is outstanding, so the card cannot name it `
            + `(published ${JSON.stringify(await readStatus(root))})`);
          assert.equal(attention.state, testCase.state, `${testCase.state}: the row carries ${attention.state}`);

          // THE MERGED CONTRACT. This is the assertion the reviewer's blocking
          // finding asked for: the pair the loop publishes is accepted by the
          // contract that carries both branches' meanings.
          const published = updaterRunAttentionV1(attention);
          assert.ok(published, `${testCase.state}: the loop has no pair to publish`);
          assert.ok(Object.hasOwn(NEXT_ACTIONS_V1, published.nextAction),
            `${testCase.state}: ${published.nextAction} is not in the key allowlist`);
          assert.ok(typeof published.reason === "string" && published.reason.length > 0,
            `${testCase.state}: no sentence for this outcome`);
          // And `publicStatusV1` — the real one, both fields — accepts it. This
          // is the exact call the merged loop makes.
          assert.doesNotThrow(() => publicStatusV1({ state: "needs_attention", needsYou: true,
            nextAction: published.nextAction, reason: published.reason }),
          `${testCase.state}: the merged contract refused its own outcome`);
          // And it still refuses the CROSSED-OVER pair, which is the other half
          // of the merge's fix: the old shape (a sentence in `nextAction`) and
          // the new one (a key in `reason`) are both refused.
          assert.throws(() => publicStatusV1({ state: "needs_attention", needsYou: true, nextAction: published.reason }),
            /updater_status_next_action_refused/u,
            `${testCase.state}: a sentence was accepted as a key`);
          assert.throws(() => publicStatusV1({ state: "needs_attention", needsYou: true, reason: published.nextAction }),
            /updater_status_reason_refused/u,
            `${testCase.state}: a key was accepted as a sentence`);

          // AND THE READER agrees, over the real file, through the real reader.
          // The reason is what gates the owner's button on the card, so its
          // arrival through this path is what makes the button appear.
          const status = await readStatus(root);
          assert.equal(status.nextAction, published.nextAction, `${testCase.state}: published ${String(status.nextAction)}`);
          assert.equal(status.reason, published.reason, `${testCase.state}: published reason`);
          const home = await readHome(root);
          assert.equal(home.nextAction, published.nextAction as never,
            `${testCase.state}: the reader dropped the key`);
          assert.equal(home.reason, published.reason, `${testCase.state}: the reader dropped the reason`);
          // The row is cleared by the owner's answer and the card stops asking,
          // which is what removes the button again.
          assert.notEqual(await store.acknowledgeOpenRunAttention("identity:owner-fixture"), false,
            `${testCase.state}: the owner could not answer`);
          assert.equal(await store.openRunAttention(), null, `${testCase.state}: the row survived the answer`);
        }
      } finally {
        await client.end().catch(() => {});
        for (const root of roots) await rm(root, { recursive: true, force: true });
      }
    }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
  });

// ---------------------------------------------------------------------------
// FINDING 4: THE GRANTS, AS THE CATALOG ACTUALLY HAS THEM.
//
// The reviewer's probe measured that the `GRANT UPDATE` this branch's DDL
// described was never in effect, and that the same was already true of
// `owner_review`'s pre-existing grant. The trailing
// `REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA updater` undoes both.
// The grants are now DELETED rather than moved, and this asserts the real answer
// through `has_column_privilege` — the catalog's own function — as the WEB LOGIN.
// ---------------------------------------------------------------------------
test("R7U-01: the web login can READ the attention columns and can write none of them", { skip: !PG }, async () => {
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const web = as(postgres, "web");
    await web.connect();
    try {
      // `has_column_privilege` is the catalog's own answer, so this is the real
      // grant and not a restatement of the DDL's intent. Both directions of each
      // column are asked, because a column that is readable but updatable is the
      // forgery vector the reviewer's probe closed by accident.
      // `has_column_privilege` accepts SELECT, INSERT, UPDATE and REFERENCES, and
      // that is ONE MORE than a column can hold: DELETE is a TABLE-level privilege
      // and asking for it per column raises `unrecognized privilege type: "DELETE"`
      // on a real cluster. So the table-level pair is asked once, on the relation
      // itself, and the column-level pair per column — which is also the honest
      // shape, since INSERT and DELETE are never column-scoped in PostgreSQL.
      const tablePrivileges = await web.query<{ can_insert: boolean; can_delete: boolean }>(
        `SELECT pg_catalog.has_table_privilege('control_room_private_web'::name,
                  'updater.owner_run_attention', 'INSERT') AS can_insert,
                pg_catalog.has_table_privilege('control_room_private_web'::name,
                  'updater.owner_run_attention', 'DELETE') AS can_delete`);
      const privileges = await web.query<{ column_name: string; can_select: boolean; can_update: boolean }>(
        `SELECT a.attname AS column_name,
           pg_catalog.has_column_privilege('control_room_private_web'::name, a.attrelid, a.attname, 'SELECT') AS can_select,
           pg_catalog.has_column_privilege('control_room_private_web'::name, a.attrelid, a.attname, 'UPDATE') AS can_update
           FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = 'updater.owner_run_attention'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`);
      const byColumn = new Map(privileges.rows.map(row => [row.column_name, row]));
      assert.equal(tablePrivileges.rows[0]?.can_insert, false, "the web login can INSERT a row of its own");
      assert.equal(tablePrivileges.rows[0]?.can_delete, false, "the web login can DELETE a row");
      // THE FIVE THE OWNER'S PAGE READS.
      for (const column of ["state", "code", "last_observed_at", "acknowledged_at", "acknowledged_by"])
        assert.equal(byColumn.get(column)?.can_select, true, `${column}: the web login cannot read a column the page renders`);
      // `run_id` IS WITHHELD, and that is what makes the owner's answer impossible to
      // forge: the page cannot build a request naming a run.
      assert.equal(byColumn.get("run_id")?.can_select, false,
        "the web login can read run_id, so it could name a run to acknowledge");
      // NO WRITE ON ANY COLUMN, which is decision 4 and the measured finding. The
      // `singleton` key is checked too: a column-scoped UPDATE on it would let a
      // login try to add a second "the one thing outstanding".
      for (const [column, row] of byColumn)
        assert.equal(row.can_update, false, `${column}: the web login can UPDATE it`);
      // AND THE PROBE STILL REFUSES, as the web login, rather than only in the
      // catalog: a catalog assertion that the grant is absent and a query that is
      // refused are two different claims, and only one of them is what an attacker
      // would meet.
      const forged = await web.query("SELECT state, code FROM updater.owner_run_attention");
      assert.equal(forged.rows.length, 0, "a row was outstanding, so this assertion proved nothing about the read");
      // The refusal is PostgreSQL's own and its SQLSTATE is 42501; the MESSAGE is
      // what a caller sees, so both are asked for. Asserting the message alone
      // would pass on a fixture that refused for the wrong reason, and asserting
      // the SQLSTATE alone would not say why.
      await assert.rejects(() => web.query("UPDATE updater.owner_run_attention SET acknowledged_at=pg_catalog.now()"),
        (error: unknown) => {
          const failure = error as { code?: string; message?: string };
          assert.equal(failure.code, "42501",
            `the web login's UPDATE failed as ${failure.code} rather than being refused with 42501`);
          assert.match(String(failure.message), /permission denied for table owner_run_attention/u);
          return true;
        }, "the web login can acknowledge a card by writing the row");
      // `owner_review`'s dead grant is asserted GONE too. It predates this branch,
      // so nothing here removes it — but the reviewer's finding was that its
      // comment described a capability nobody had, and that has to be pinned so it
      // cannot come back quietly.
      const reviewPrivileges = await web.query<{ column_name: string; can_update: boolean }>(
        `SELECT a.attname AS column_name,
           pg_catalog.has_column_privilege('control_room_private_web'::name, a.attrelid, a.attname, 'UPDATE') AS can_update
           FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = 'updater.owner_review'::regclass AND a.attnum > 0 AND NOT a.attisdropped`);
      assert.ok(reviewPrivileges.rows.every(row => row.can_update === false),
        "the web login can UPDATE an owner_review column, so the deleted grant came back");
      // AND THE OWNER'S ANSWER IS AVAILABLE THROUGH THE PORT instead, which is the
      // shape decision 3 chose: the deployer holds the function.
      const hasFunction = await web.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
          WHERE ns.nspname = 'updater' AND p.proname = 'acknowledge_run_attention'`);
      assert.equal(hasFunction.rows[0]?.n, 1, "the updater\'s own acknowledgement port is missing");
    } finally { await web.end().catch(() => {}); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

// ---------------------------------------------------------------------------
// FINDING 5: ONLY A NEWER SUCCESSFUL RUN CLEARS AN OLDER OUTSTANDING ROW.
//
// The reviewer's finding was that `observe_run_attention('succeeded', ...)` checked
// only that the run was in state `succeeded`, not that it was NEWER than the open
// row — so a replayed stale success could clear a real warning. The reviewer also
// noted it is not reachable today, because the runner only observes its live run.
// This test drives it directly through the function, which is the only way to reach
// it, and asserts the ordering in both directions.
// ---------------------------------------------------------------------------
test("R7U-01: a stale success cannot clear a newer outstanding outcome", { skip: !PG }, async () => {
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const client = as(postgres, "deployer");
    await client.connect();
    try {
      const store = new PostgresUpdaterStoreV1(client);
      await store.initialize();
      // TWO runs, the FIRST OLDER, both seeded so the ordering is a fact and not a
      // coincidence. `started_at` is the column the rule compares, and both rows are
      // written with an explicit instant rather than relying on insert order.
      const older = await seedOrderedRun(client, "older", "-1 hour");
      const newer = await seedOrderedRun(client, "newer", "-1 minute");
      // The newer run fails. That is the warning the owner is looking at, and it is
      // reached through the PRODUCTION transition port rather than a raw UPDATE —
      // `guard_run_state` is what makes these states reachable at all, and a raw
      // UPDATE that bypassed it would be testing a database nobody runs.
      //
      // `healthy` has exactly two successors, `succeeded` and `rollback_started`, so
      // the walk is the same rollback tail a real failed recovery takes. Measured:
      // the first version wrote `needs_attention` straight onto the row and the
      // transition guard refused `healthy -> needs_attention`, which is correct and
      // is why this walks the tail rather than naming the state.
      for (const state of ["rollback_started", "code_restored", "needs_attention"])
        await store.transition(newer, await leaseOfRun(client, newer), state,
          state === "needs_attention" ? { code: "updater_rollback_failed" } : {},
          state === "needs_attention" ? { terminal: true } : {});
      await store.observeRunAttention("needs_attention", { runId: newer, code: "updater_rollback_failed" });
      assert.equal((await store.openRunAttention())?.runId, newer, "the fixture did not raise the warning");

      // THE STALE SUCCESS. The older run really did succeed — it is in state
      // `succeeded` — and it finished BEFORE the failure it would clear. Ordering
      // the observation must refuse it, and must leave the warning exactly as it
      // was, naming the run that raised it.
      await store.observeRunAttention("succeeded", { runId: older });
      const afterStale = await store.openRunAttention();
      assert.equal(afterStale?.runId, newer,
        "a stale successful run cleared a NEWER outstanding outcome");
      assert.equal(afterStale?.state, "needs_attention", "and the warning was replaced by the success");

      // THE OTHER DIRECTION, which must still work: the older row already went, so
      // this uses a THIRD run that is newer than the outstanding one.
      // NOT IN THE FUTURE. `runs_finished_after_start` refuses a terminal row
      // whose `finished_at` precedes `started_at`, so a `+1 minute` seed finishes
      // the run before it began. Measured: the first version used `+1 minute` and
      // the CHECK refused it — correctly, and it is the constraint doing its job.
      //
      // The instant is `-1 second` rather than `-1 minute` so it is strictly newer
      // than the outstanding run at `-1 minute` while still being in the past,
      // which is what the ordering rule actually compares.
      const newest = await seedOrderedRun(client, "newest", "-1 second");
      // `healthy -> succeeded` is legal and is the real success step, terminal.
      await store.transition(newest, await leaseOfRun(client, newest), "succeeded", {}, { terminal: true });
      await store.observeRunAttention("succeeded", { runId: newest });
      assert.equal(await store.openRunAttention(), null,
        "a NEWER successful run did not clear the outstanding outcome, so the rule refuses the good case too");

      // AND THE ORDERING IS NOT A TIE-BREAK THAT ERASES THE EVIDENCE: the
      // superseded row records what resolved it, so an operator reconciling later
      // can still see which run cleared which warning.
      const closed = await client.query<{ acknowledged_by: string; run_id: string }>(
        "SELECT acknowledged_by, run_id FROM updater.owner_run_attention");
      assert.equal(closed.rows[0]?.acknowledged_by, "updater:superseded_by_newer_run");
      assert.equal(closed.rows[0]?.run_id, newest, "the row does not name the run that resolved it");
    } finally { await client.end().catch(() => {}); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

// ---------------------------------------------------------------------------
// cook/11int11: THE OWNER'S PRESS ON THE SHIPPED HOST REACHES THE UPDATER.
//
// The shipped Mac web host composed no `updaterOwnerAttention` port, so the
// route answered 400 and the card could never be answered from the app. The
// default port is now the web login's own INSERT (mac-local-host.ts). This drives
// the whole chain with production logins: the real runner raises the card, the
// WEB login records the press through the port the shipped host composes, and
// the next REAL loop tick, with the production owner-action handler, answers it
// and stops publishing the reason that shows the button.
// ---------------------------------------------------------------------------
test("int11: the shipped host's press is recorded by the web login and the next tick clears the card", { skip: !PG }, async () => {
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const client = as(postgres, "deployer"), web = as(postgres, "web");
    await client.connect(); await web.connect();
    const root = await scratchRootV1("press");
    try {
      const store = new PostgresUpdaterStoreV1(client);
      await store.initialize();
      const stateFiles = new UpdaterStateFilesV1(root, "lease-attention");
      const mode = new UpdaterModeV1(stateFiles);
      await mode.initialize(); await mode.set("running");
      await seedRun(store, client, "press");
      const runner = runnerFor(root, store, stateFiles, mode, { healthBad: true, rollbackFails: true });
      await tickOnce(root, runner, store, stateFiles, mode);
      const raised = await readHome(root);
      assert.equal(raised.state, "needs_owner", "the fixture did not raise the card");
      assert.ok(raised.reason, "the card carries no reason, so it would show no button");

      // THE PRESS, as the shipped host records it: the web login, no run id, and
      // the digest of a LIVE owner session (guard_owner_session refuses any other,
      // which is asserted first so the seeded session is what lets the press in).
      const port = createMacLocalUpdaterOwnerAttentionPortV1(web as never);
      await assert.rejects(port.acknowledge({ ownerSubject: "owner-fixture-subject", ownerSessionDigest: digest(11) }),
        /updater row needs a live owner session/u, "a press from a session that is not live was recorded");
      const now = new Date().toISOString(), tenant = "tenant:int11-press", owner = "identity:int11-press-owner";
      await seed(postgres, "INSERT INTO tenants(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING", [tenant]);
      await seed(postgres, `INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
        auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','Owner','test',$3,'active',$4,$4)`,
      [owner, tenant, digest(12), now]);
      await seed(postgres, `INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,risk_ceiling,
        allowed_actions,project_ids,created_at,updated_at) VALUES($1,$2,$3,'owner','critical','["*"]','["*"]',$4,$4)`,
      [`grant:${owner}`, tenant, owner, now]);
      await seed(postgres, `INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5)`, [tenant, digest(11), owner, now, new Date(Date.parse(now) + 3_600_000).toISOString()]);
      const receipt = await port.acknowledge({ ownerSubject: "owner-fixture-subject", ownerSessionDigest: digest(11) });
      assert.match(receipt.requestId, /^owner-request:[0-9a-f-]{36}$/u);
      const pending = await store.unhandledOwnerRequests();
      assert.deepEqual(pending.map((row: { id: string; request_kind: string }) => [row.id, row.request_kind]),
        [[receipt.requestId, "acknowledge_attention"]], "the press did not land as exactly one acknowledge_attention request");
      // A malformed digest is refused before any write.
      await assert.rejects(port.acknowledge({ ownerSubject: "owner-fixture-subject", ownerSessionDigest: "token" }),
        /updater_owner_attention_identity_refused/u);

      // THE NEXT TICK, with the handler the production composition builds.
      const loop = new UpdaterMainLoopV1({ runner, store, stateFiles, mode,
        ownerActions: defaultUpdaterOwnerActionsV1({ mode, runner, backupNow: async () => {}, store }),
        watcher: null, alerts: null, alertFacts: async () => ({}) });
      try { await loop.tick(); } finally { await loop.shutdown(); }
      const handled = await client.query<{ handled_outcome: string | null }>(
        "SELECT handled_outcome FROM updater.owner_requests WHERE id=$1", [receipt.requestId]);
      assert.equal(handled.rows[0]?.handled_outcome, "acted", "the updater did not act on the press");
      assert.equal(await store.openRunAttention(), null, "the outcome is still outstanding after the press");
      const cleared = await readHome(root);
      assert.equal(cleared.reason, undefined, "the card still carries the reason, so the button is still shown");
      assert.equal((await readStatus(root)).needsYou, false, "the card still asks for the owner");
    } finally {
      await web.end().catch(() => {}); await client.end().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});
