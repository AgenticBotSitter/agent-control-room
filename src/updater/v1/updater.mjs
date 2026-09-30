import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { PostgresUpdaterStoreV1 } from "./store.mjs";
import { UpdaterControlServerV1 } from "./control-socket.mjs";
import { UpdaterHeartbeatV1, UpdaterRunnerV1 } from "./runner.mjs";
import { FileStepJournalV1, UpdaterMainLoopV1, UpdaterModeV1, UpdaterStateFilesV1,
  newUpdaterIdentityV1, reconcileJournalDisplayV1 } from "./runtime.mjs";
import { updaterRefuseV1 } from "./contracts.mjs";

// The fixed updater bundle exposes the item-13 actuator for composition with
// the item-5 lifecycle and item-14 health ports. `startUpdaterV1` accepts that
// composed instance through `options.effects` and settles it before listening.
export { DiskReserveV1, PairHistoryV1, UpdaterActuatorV1, collectOldReleasesV1 } from "./actuator.mjs";
export { UpdaterHealthEvaluatorV1, UpdaterScheduledHealthV1, captureHealthPolicyV1,
  loadRunningHealthPolicyV1, readUpdaterHealthProbeKeyV1 } from "./health.mjs";

function updaterRootV1(env) {
  const production = "/Library/Application Support/Control Room";
  if (!env.CONTROL_ROOM_UPDATER_ROOT) return production;
  if (env.CONTROL_ROOM_UPDATER_TESTING !== "1") throw updaterRefuseV1("updater_root_override_refused");
  const candidate = resolve(env.CONTROL_ROOM_UPDATER_ROOT);
  if (!candidate.startsWith("/private/tmp/") && !candidate.startsWith("/tmp/"))
    throw updaterRefuseV1("updater_test_root_refused");
  return candidate;
}

export async function startUpdaterV1(options = {}) {
  const env = options.env ?? process.env, root = options.root ?? updaterRootV1(env);
  let client = options.client, ownsClient = false, store = options.store;
  if (!store) {
    const pg = options.pg ?? await import("pg");
    if (!client) {
      client = new pg.Client({ host: env.PGHOST, port: env.PGPORT ? Number(env.PGPORT) : undefined,
        database: env.PGDATABASE, user: "control_room_deployer" });
      ownsClient = true;
    }
    try {
      if (ownsClient) await client.connect();
      store = new PostgresUpdaterStoreV1(client); await store.initialize();
    } catch (error) {
      if (ownsClient) await client.end().catch(() => {});
      throw error;
    }
  }
  const requestedIdentity = options.identity ?? newUpdaterIdentityV1();
  let acquisition;
  try {
    if (store.acquire) acquisition = await store.acquire(requestedIdentity.leaseToken);
    else {
      const run = await store.liveRun();
      acquisition = { status: "acquired", run, leaseToken: run?.lease_token ?? requestedIdentity.leaseToken };
    }
  } catch (error) {
    if (ownsClient) await client.end().catch(() => {});
    throw error;
  }
  if (acquisition.status !== "acquired") {
    if (ownsClient) await client.end().catch(() => {});
    throw updaterRefuseV1("updater_live_session_busy");
  }
  const identity = Object.freeze({ ...requestedIdentity, leaseToken: acquisition.leaseToken });
  const stateFiles = new UpdaterStateFilesV1(root, identity.leaseToken), mode = new UpdaterModeV1();
  const unavailable = async () => { throw updaterRefuseV1("updater_actuator_port_unbound"); };
  const effects = options.effects ?? { precheck: unavailable, stage: unavailable, quickBackup: unavailable,
    drain: unavailable, switchPair: unavailable, restart: unavailable, health: unavailable,
    commitKnownGood: unavailable, rollback: unavailable, measure: async () => {} };
  const referee = options.referee ?? { assertPlanAllowed: async () => {
    throw updaterRefuseV1("updater_referee_port_unbound");
  } };
  let heartbeatState = acquisition.run
    ? { state: "running", step: acquisition.run.state }
    : { state: "idle", step: null };
  const setHeartbeatState = value => { heartbeatState = value; };
  const journal = options.journal ?? new FileStepJournalV1(root);
  await journal.recoverCompaction();
  let fileJournalUncertain, displayJournalUncertain, journalRecoveryPending = false;
  const refreshJournalHealth = async () => {
    try { await journal.validate(); fileJournalUncertain = undefined; }
    catch (error) { fileJournalUncertain = error?.code ?? "updater_journal_invalid"; }
    return fileJournalUncertain;
  };
  await refreshJournalHealth();
  if (!fileJournalUncertain && options.journalDisplay) {
    const reconciliation = await reconcileJournalDisplayV1({ journal, display: options.journalDisplay,
      rescued: await stateFiles.hasRescueMarker() });
    displayJournalUncertain = reconciliation.state === "uncertain" ? reconciliation.reason : undefined;
  }
  stateFiles.refreshJournalHealth = refreshJournalHealth;
  stateFiles.journalUncertain = () => fileJournalUncertain ?? displayJournalUncertain;
  stateFiles.repairJournalUncertain = async () => {
    if (!fileJournalUncertain) return false;
    const repaired = await journal.quarantineCorrupt();
    await refreshJournalHealth();
    journalRecoveryPending = repaired && !fileJournalUncertain;
    return journalRecoveryPending;
  };
  stateFiles.journalRecoveryPending = () => journalRecoveryPending;
  stateFiles.settleJournalRecovery = () => { journalRecoveryPending = false; };
  const runner = new UpdaterRunnerV1({ store, effects, referee, mode, stateFiles, journal,
    onHeartbeatState: setHeartbeatState });
  const ownerActions = options.ownerActions ?? { handle: async request => {
    if (request.request_kind === "pause") mode.set("paused");
    else if (request.request_kind === "stop") mode.set("stopped");
    else if (request.request_kind === "resume") mode.set("running");
    else if (request.request_kind === "check_and_continue") await runner.checkAndContinue();
    else throw updaterRefuseV1("updater_owner_action_port_unbound");
  } };
  const reportTimerError = options.onTimerError ?? (error => {
    process.stderr.write(`${typeof error?.code === "string" ? error.code : "updater_timer_failed"}\n`);
  });
  // `watcher` is updaterland's addition and is independent of the health
  // contract: the main loop in runtime.mjs already accepts it (it merged
  // cleanly), and the self-update Off flag suppresses its tick. Passing it
  // here is what keeps that work alive through this merge.
  const loop = new UpdaterMainLoopV1({ runner, store, stateFiles, mode, ownerActions,
    watcher: options.watcher ?? null, onError: reportTimerError });
  const scheduledHealth = options.scheduledHealth;
  let heartbeatState = { state: "idle", step: null };  const heartbeat = new UpdaterHeartbeatV1({ store, stateFiles, ...identity, report: () => heartbeatState,
    onError: reportTimerError });
  const control = new UpdaterControlServerV1({ root, handler: async request => {
    const map = { pause: "paused", resume: "running", stop: "stopped" };
    if (map[request.verb]) { mode.set(map[request.verb]); return { accepted: true }; }
    return ownerActions.handle({ request_kind: request.verb.replaceAll("-", "_"), detail: { arguments: request.arguments },
      requires_passkey: request.verb === "rollback" });
  } });
  try {
    // Item 13: settle a durable release/database link transaction before any
    // run is observed. The actuator either completes it or restores its source.
    await effects.recover?.();
    await control.start(); await heartbeat.beat(); await loop.tick(); heartbeat.start(); loop.start();
    await scheduledHealth?.start();
  } catch (error) {
    loop.stop(); await scheduledHealth?.stop(); await heartbeat.stop(); await control.stop();
    if (ownsClient) await client.end();
    throw error;
  }
  return Object.freeze({ root, identity, store, runner, loop, heartbeat, control, scheduledHealth,
    setHeartbeatState(value) { heartbeatState = value; },
    async stop() { loop.stop(); await scheduledHealth?.stop(); await heartbeat.stop(); await control.stop();      if (ownsClient) await client.end(); } });
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) startUpdaterV1().then(updater => {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void updater.stop().finally(() => process.exit(0)));
}).catch(error => { process.stderr.write(`${error?.code ?? "updater_start_failed"}\n`); process.exitCode = 1; });
