import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { PostgresUpdaterStoreV1 } from "./store.mjs";
import { UpdaterControlServerV1 } from "./control-socket.mjs";
import { UpdaterHeartbeatV1, UpdaterRunnerV1 } from "./runner.mjs";
import { FileStepJournalV1, UpdaterMainLoopV1, UpdaterModeV1, UpdaterStateFilesV1,
  newUpdaterIdentityV1, reconcileJournalDisplayV1 } from "./runtime.mjs";
import { updaterRefuseV1 } from "./contracts.mjs";
import { PasskeyAuthorityV1, PasskeyRefusalAggregatorV1, SimpleWebAuthnVerifierV1 } from "./passkey.mjs";
import { PasskeyStoreV1 } from "./passkey-store.mjs";

// The fixed updater bundle exposes the item-13 actuator for composition with
// the item-5 lifecycle and item-14 health ports. `startUpdaterV1` accepts that
// composed instance through `options.effects` and settles it before listening.
export { DiskReserveV1, PairHistoryV1, UpdaterActuatorV1, collectOldReleasesV1 } from "./actuator.mjs";

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
  const stateFiles = new UpdaterStateFilesV1(root, identity.leaseToken), mode = new UpdaterModeV1(stateFiles);
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
  // Item 10b binds the web/approval polling loop. Item 10a exposes the complete
  // authority and typed DB/sink ports now, without adding SQL here.
  const ownsPasskeyStore = !options.passkeyStore && !options.store && Boolean(client);
  const passkeyStore = options.passkeyStore ?? (ownsPasskeyStore ? new PasskeyStoreV1(client) : store);
  // Item 21's sender belongs in this production startup composition: it must
  // drain updater.push_queue through the owner web-push transport and mark each
  // row only after delivery. No sender is composed here yet, so owner text must
  // describe the 24-hour hold without claiming that a phone was warned.
  const passkeys = options.passkeys ?? new PasskeyAuthorityV1({ root,
    store: passkeyStore, verifier: options.passkeyVerifier ?? new SimpleWebAuthnVerifierV1() });
  const refusalAggregator = options.refusalAggregator ?? (passkeyStore?.recordApprovalRefusal && options.refusalJournal
      && options.refusalPush ? new PasskeyRefusalAggregatorV1({ store: passkeyStore,
        journal: options.refusalJournal, push: options.refusalPush }) : undefined);
  const ownerActions = options.ownerActions ?? { handle: async request => {
    if (request.request_kind === "pause") await mode.set("paused");
    else if (request.request_kind === "stop") await mode.set("stopped");
    // A web login can mint an owner session and insert owner_requests. Resume is
    // therefore deliberately root-control-only until the approval join exists.
    else if (request.request_kind === "resume") throw updaterRefuseV1("updater_web_resume_refused");
    else if (request.request_kind === "check_and_continue") await runner.checkAndContinue();
    else throw updaterRefuseV1("updater_owner_action_port_unbound");
  } };
  const reportTimerError = options.onTimerError ?? (error => {
    process.stderr.write(`${typeof error?.code === "string" ? error.code : "updater_timer_failed"}\n`);
  });
  const loop = new UpdaterMainLoopV1({ runner, store, stateFiles, mode, ownerActions, watcher: options.watcher ?? null,
    onError: reportTimerError });
  const heartbeat = new UpdaterHeartbeatV1({ store, stateFiles, ...identity, report: () => heartbeatState,
    onError: reportTimerError });
  const control = new UpdaterControlServerV1({ root, handler: async request => {
    if (request.verb === "passkey-add-begin") {
      if (request.arguments.length) throw updaterRefuseV1("updater_passkey_arguments_refused");
      const registration = await passkeys.beginRegistration({ mode: "add" });
      const registrationOptions = await passkeys.registrationOptions(registration.registrationSecret);
      if (!passkeyStore?.openRegistration) throw updaterRefuseV1("updater_passkey_store_port_unbound");
      await passkeyStore.openRegistration({ registrationDigest: registration.registrationDigest,
        installationId: registration.config.installationId, mode: "add", optionsJson: registrationOptions,
        authorizationChallenge: registration.authorizationChallenge, expiresAt: registration.expiresAt });
      return { registrationSecret: registration.registrationSecret,
        expectedOrigin: registration.config.expectedOrigin, expiresAt: registration.expiresAt };
    }
    if (request.verb === "passkey-add-complete") {
      if (request.arguments.length !== 2) throw updaterRefuseV1("updater_passkey_arguments_refused");
      const registration = await passkeys.registrationOptions(request.arguments[0]);
      if (!passkeyStore?.consumeRegistration) throw updaterRefuseV1("updater_passkey_store_port_unbound");
      // Close the phone write window first. The response row remains readable
      // by the updater, so a dropped reply can retry completion without opening
      // the ceremony to a second browser write.
      await passkeyStore.consumeRegistration(registration.registrationDigest);
      return passkeys.completeRegistration({ registrationSecret: request.arguments[0], typedCode: request.arguments[1] });
    }
    if (request.verb === "passkey-list") {
      if (request.arguments.length) throw updaterRefuseV1("updater_passkey_arguments_refused");
      return passkeys.listPasskeys();
    }
    if (request.verb === "passkey-revoke") {
      if (request.arguments.length !== 1 || !/^[1-9][0-9]{0,2}$/u.test(request.arguments[0]))
        throw updaterRefuseV1("updater_passkey_number_refused");
      return passkeys.revokePasskey(Number(request.arguments[0]));
    }
    const map = { pause: "paused", resume: "running", stop: "stopped" };
    if (map[request.verb]) { await mode.set(map[request.verb]); return { accepted: true }; }
    return ownerActions.handle({ request_kind: request.verb.replaceAll("-", "_"), detail: { arguments: request.arguments },
      requires_passkey: request.verb === "rollback" });
  } });
  try {
    await mode.initialize();
    if (ownsPasskeyStore) await passkeyStore.initialize();
    // Item 13: settle a durable release/database link transaction before any
    // run is observed. The actuator either completes it or restores its source.
    await effects.recover?.();
    await control.start(); await heartbeat.beat(); await loop.tick(); await heartbeat.beat(); heartbeat.start(); loop.start();
  } catch (error) {
    loop.stop(); await heartbeat.stop(); await control.stop();
    if (store.release) await store.release().catch(() => {});
    if (ownsClient) await client.end();
    throw error;
  }
  return Object.freeze({ root, identity, store, runner, loop, heartbeat, control, passkeys, refusalAggregator,
    setHeartbeatState,
    async stop() { loop.stop(); await heartbeat.stop(); await control.stop(); await store.release?.();
      if (ownsClient) await client.end(); } });
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) startUpdaterV1().then(updater => {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void updater.stop().finally(() => process.exit(0)));
}).catch(error => { process.stderr.write(`${error?.code ?? "updater_start_failed"}\n`); process.exitCode = 1; });
