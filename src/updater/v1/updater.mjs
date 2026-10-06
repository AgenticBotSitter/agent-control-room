import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isMainModuleV1 } from "../../installer/shared/is-main-module.mjs";
import { assertT1Path, buildTrustedEnvironment } from "./trusted-runtime.mjs";
import { PostgresUpdaterStoreV1 } from "./store.mjs";
import { UpdaterControlServerV1 } from "./control-socket.mjs";
import { UpdaterHeartbeatV1, UpdaterRunnerV1 } from "./runner.mjs";
import { FileStepJournalV1, UpdaterMainLoopV1, UpdaterModeV1, UpdaterStateFilesV1,
  newUpdaterIdentityV1, reconcileJournalDisplayV1 } from "./runtime.mjs";
import { acquireUpdaterLocalLockV1 } from "./fs-safety.mjs";
import { updaterRefuseV1 } from "./contracts.mjs";
import { UpdaterAlertSenderV1 } from "./alerts.mjs";
import { PasskeyAuthorityV1, PasskeyRefusalAggregatorV1, SimpleWebAuthnVerifierV1 } from "./passkey.mjs";
import { UPDATER_CONFIGURATION_SCHEMA_V1 } from "./services/protected-config.mjs";
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

const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

export function parseUpdaterConfigurationV1(value, root) {
  const database = value?.database;
  if (!exactKeys(value, ["schema", "database"]) || value.schema !== UPDATER_CONFIGURATION_SCHEMA_V1
    || !exactKeys(database, ["host", "port", "name", "user"])
    || database.host !== join(root, "pg", "socket") || database.port !== 5432
    || database.name !== "control_room" || database.user !== "control_room_deployer") {
    throw updaterRefuseV1("updater_configuration_refused");
  }
  return Object.freeze({ schema: value.schema, database: Object.freeze({ ...database }) });
}

export async function loadUpdaterConfigurationV1(root, args = []) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === "/") {
    throw updaterRefuseV1("updater_configuration_refused");
  }
  const expected = join(root, "updater-state", "updater.json");
  if (!Array.isArray(args) || args.length !== 0 && (args.length !== 2 || args[0] !== "--configuration" || args[1] !== expected)) {
    throw updaterRefuseV1("updater_configuration_refused");
  }
  try {
    const parent = await lstat(join(root, "updater-state"));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0) throw new Error();
    const handle = await open(expected, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const entry = await handle.stat();
      if (!entry.isFile() || entry.nlink !== 1 || (entry.mode & 0o077) !== 0 || entry.size < 2 || entry.size > 16_384) {
        throw new Error();
      }
      return parseUpdaterConfigurationV1(JSON.parse(await handle.readFile("utf8")), root);
    } finally { await handle.close(); }
  } catch { throw updaterRefuseV1("updater_configuration_refused"); }
}

async function releaseStoreV1(store) {
  let timer;
  try { await Promise.race([store?.release?.(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(updaterRefuseV1("updater_release_timeout")), 1000);
  })]); } finally { clearTimeout(timer); }
}

async function drainUpdaterWorkV1(loop, control) {
  const outcomes = await Promise.allSettled([loop.shutdown(), control.stop()]);
  const failed = outcomes.find(outcome => outcome.status === "rejected");
  if (failed) throw failed.reason;
}

/**
 * The DEFAULT owner-action handler: what the owner's controls do when the
 * production composition builds them, with nothing injected.
 *
 * Exported, and not hidden inside `startUpdaterV1`, for one measured reason. The
 * owner-request loop (`UpdaterMainLoopV1`) turns ANY throw into the bare outcome
 * string `refused` and stores no reason, which is precisely how
 * `backup_now`/`rollback`/`repair_serve` were measured coming back as `refused`
 * with nothing behind it. So the loop cannot be used to assert WHICH refusal a
 * control gave — and a handler whose refusals cannot be distinguished is a
 * handler whose refusals cannot be shown to an owner. Calling the real handler
 * here is what makes the four codes four distinct, assertable facts.
 *
 * R5B-02, in order of what each control can honestly do on this install:
 *
 *   pause / stop / resume / check_and_continue  unchanged; the first three set the
 *       mode and the fourth drives the runner.
 *   backup_now     BOUND. It SPAWNS the SHIPPED nightly backup artifact against the
 *       SHIPPED protected configuration — the same `dist-vps/server/nightlyBackup.js`,
 *       credential file, lock and `pg_dump` the launchd daemon runs — so "Back up
 *       now" and tonight's scheduled backup are one operation, and the owner gets
 *       the same refusal the daemon would have got. Deliberately not a second
 *       backup path: a control that took a different dump would produce a file the
 *       owner's restore runbook had never seen. And deliberately a SPAWN, not an
 *       import: the runner's import chain reaches
 *       `deploy/postgres/migration-ledger.json`, and this bundle must not carry
 *       release data. See `defaultBackupNowV1`.
 *   rollback       REFUSED BY NAME. Restoring means replacing a running cluster's
 *       contents with a dump taken at an earlier moment. Not bound in this
 *       release, and a handler that half-performed it would be far worse than one
 *       that refuses.
 *   repair_serve   REFUSED BY NAME, for the same reason: it moves a symlink under a
 *       live install.
 *   acknowledge_attention  (R7U-01) the owner has read the outstanding update
 *       card; answered through the store, no passkey.
 *   anything else  REFUSED AS UNBOUND, so a kind this release has never heard of
 *       cannot borrow either of the two named refusals above and read as a known
 *       control that merely happens to be unavailable.
 *
 * @param mode the real `UpdaterModeV1`, for pause/stop/resume.
 * @param runner the real `UpdaterRunnerV1`, for check-and-continue.
 * @param backupNow the backup port; the default is the shipped nightly runner.
 * @param [store] the updater store, for acknowledge_attention; absent refuses it as unbound.
 */
export function defaultUpdaterOwnerActionsV1({ mode, runner, backupNow, store = /** @type {any} */ (null) }) {
  return Object.freeze({ handle: async request => {
    if (request.request_kind === "pause") {
      if (request.source !== "root" && await mode.read() === "stopped")
        throw updaterRefuseV1("updater_web_pause_from_stopped_refused");
      await mode.set("paused");
    }
    else if (request.request_kind === "stop") await mode.set("stopped");
    // A web login can mint an owner session and insert owner_requests. Resume is
    // therefore deliberately root-control-only until the approval join exists.
    else if (request.request_kind === "resume") throw updaterRefuseV1("updater_web_resume_refused");
    else if (request.request_kind === "check_and_continue")
      return runner.checkAndContinue({ source: request.source });
    else if (request.request_kind === "backup_now") await backupNow();
    // Each with its OWN code, so the refusal says what is missing rather than
    // "something is unbound". The names are stable strings an operator can grep.
    else if (request.request_kind === "rollback")
      throw updaterRefuseV1("updater_rollback_not_available_on_this_install");
    else if (request.request_kind === "repair_serve")
      throw updaterRefuseV1("updater_repair_not_available_on_this_install");
    // R7U-01 (lead decision 3): the owner's answer to a published run outcome.
    //
    // No Face ID, deliberately and by decision: acknowledging is not an effect on
    // the installation, it is the owner saying they have read a card. The
    // passkey split above already derives `requires_passkey=false` for this kind,
    // so it cannot be escalated into one by a caller that writes the row.
    //
    // The identity is the OWNER SESSION SUBJECT the web route verified live,
    // passed through the request row rather than composed here — so the name
    // written on the acknowledgement is the one the session store knows, and the
    // updater is not inventing who answered.
    else if (request.request_kind === "acknowledge_attention") {
      if (typeof store?.acknowledgeOpenRunAttention !== "function")
        throw updaterRefuseV1("updater_owner_action_port_unbound");
      const identity = request.detail?.ownerSubject;
      if (typeof identity !== "string")
        throw updaterRefuseV1("updater_owner_attention_identity_refused");
      const acknowledged = await store.acknowledgeOpenRunAttention(identity);
      // `handled_outcome` distinguishes "the owner answered what was on the card"
      // from "there was nothing outstanding", which is the same distinction the
      // port itself makes and the reason a double press is visible rather than
      // silently succeeding twice.
      if (acknowledged === false)
        throw updaterRefuseV1("updater_owner_attention_not_outstanding");
      return { acknowledged: true };
    }
    else throw updaterRefuseV1("updater_owner_action_port_unbound");
  } });
}

/**
 * The refusal codes the spawned nightly entry may name, and NOTHING else may be
 * believed. `mainNightlyBackupV1` prints `nightly database backup failed: <code>`
 * and is the only writer of that line, but the child's stderr is still just bytes
 * on a pipe: a code outside this closed set is not translated, it is replaced by
 * `nightly_backup_execution_failed`. The owner is shown a reason from this list or
 * the generic one, never a string a child invented.
 *
 * The list is the entry's own `failureCodes`, mirrored rather than imported: the
 * entry lives in `src/installer/v1` with the migration ledger in its import chain,
 * and this is the trusted updater bundle, which must not carry release code.
 * MEASURED consequence of mirroring: adding a code to the entry without adding it
 * here degrades that one refusal to `nightly_backup_execution_failed` — a less
 * specific owner message, never a wrong or invented one.
 */
const NIGHTLY_BACKUP_FAILURE_CODES_V1 = Object.freeze([
  "nightly_backup_clock_refused",
  "nightly_backup_concurrent_refused",
  "nightly_backup_configuration_refused",
  "nightly_backup_credential_refused",
  "nightly_backup_dependency_missing",
  "nightly_backup_execution_failed",
  "nightly_backup_incomplete",
  "nightly_backup_output_refused",
  "nightly_backup_retention_failed",
  "nightly_backup_usage_refused",
  "unsafe_generation",
]);

/**
 * How long `backup_now` waits for the child.
 *
 * ABOVE the dump's own bound: `deploy/postgres/backup-database.mjs` runs `pg_dump`
 * with `timeout: 120000`, so a child that has not answered by two minutes is
 * waiting on something the dump itself is already refusing to wait for.
 *
 * BELOW the owner-request loop's own bound, and that is the property rather than
 * a number: `UpdaterMainLoopV1` races every owner action against
 * `ownerActionTimeoutMs` (300 s by default) and, when the race is lost, reports
 * `updater_owner_action_timeout` and returns WITHOUT finishing the request — the
 * row stays pending and the control is retried on the next tick, forever, with no
 * refusal stored. Bounding the child below that means the slow case produces
 * `nightly_backup_timeout` as a named refusal the owner can read, instead of a
 * control that silently re-runs all night. MEASURED, and the same two bounds the
 * launchd definition's `exitTimeOut: 120` sits between.
 */
export const BACKUP_NOW_TIMEOUT_MS_V1 = 240_000;

/**
 * The command `backup_now` runs: the SAME artifact the nightly launchd service
 * runs, from the SAME install root, with the SAME protected configuration.
 *
 * This is the whole reason "Back up now" and tonight's scheduled backup are one
 * operation rather than two. `src/updater/v1/services/bundle.mjs:232-234` builds
 * the nightly service as `<runtime>/node-current/bin/node <root>/current/dist-vps/
 * server/nightlyBackup.js --configuration <root>/Protected/config/backup.json`,
 * and these three paths are derived from the install root the same way — so a
 * control that took a different dump, a different credential or a different lock
 * would produce a file the owner's restore runbook had never seen.
 */
export function nightlyBackupSpawnPathsV1(root) {
  return Object.freeze({
    executable: join(root, "runtime", "node-current", "bin", "node"),
    script: join(root, "current", "dist-vps", "server", "nightlyBackup.js"),
    configuration: join(root, "Protected", "config", "backup.json"),
  });
}

/**
 * The outcome the OWNER is shown, from the child's exit code and stderr.
 *
 * Exit code is read first and is the only thing that can report success: a child
 * that exits 0 has taken a backup, whatever its stdout says. A nonzero exit is
 * then translated through the child's own named reason when that reason is one of
 * the codes above, and to `nightly_backup_execution_failed` otherwise — which is
 * also what a signalled child (the timeout kill) becomes, because a killed child
 * did not finish and has no reason to give.
 */
export function parseNightlyBackupOutcomeV1({ code, signal, stderr } = {}) {
  if (code === 0 && signal === null) return Object.freeze({ ok: true });
  const named = /(?:^|\n)nightly database backup failed: ([a-z0-9_]{1,64})\s*$/u.exec(String(stderr ?? ""));
  const reason = named !== null && NIGHTLY_BACKUP_FAILURE_CODES_V1.includes(named[1])
    ? named[1] : "nightly_backup_execution_failed";
  return Object.freeze({ ok: false, reason });
}

/** One child, bounded, with its output captured. Nothing here is inherited from
 * this process: the environment is the trusted base (`LANG`/`LC_ALL` only), so a
 * `PG*`, `DYLD_*` or `NODE_OPTIONS` variable in the updater's own environment
 * cannot reach the dump. `backupDatabase` spawns `pg_dump` with an absolute path
 * and its own env, so the child needs no `PATH`. */
function spawnNightlyBackupV1(executable, args, timeoutMs) {
  return new Promise((resolveSpawn, reject) => {
    // `detached: true` puts the child in its OWN process group, and that is what
    // makes the abandon kill correct. MEASURED, and the two have to go together:
    // with the default (`detached: false`) the child shares THIS process's group, so
    // there is no group whose id is the child's pid, `kill(-pid)` finds nothing, and
    // the code falls through to the bare `child.kill` — which leaves `pg_dump`
    // running, holding the snapshot. The lane's grandchild assertion caught exactly
    // that: `the grandchild (pid 49683) must be GONE too`.
    //
    // `detached: true` gives the child a group of its own whose id IS its pid, so one
    // signal reaches the child and everything it started, and nothing outside this
    // spawn. The cost is that the child no longer receives this process's signals, so
    // the updater must kill it explicitly rather than relying on group delivery — which
    // the abandon path does, and which the control socket's shutdown makes moot by
    // closing the pipes the child writes to.
    const child = spawn(executable, args, { env: buildTrustedEnvironment(), shell: false, detached: true,
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", bytes = 0, settled = false, timer;
    // The SIGKILL is only for the paths that ABANDON the child: the timeout, the
    // output cap, and a spawn that never happened. On the child's own `close` it
    // is deliberately NOT sent — sending it there is a no-op on a process that has
    // already exited, but it is a signal aimed at a pid the kernel may have RECYCLED
    // by then, which is a hazard rather than a tidy-up.
    //
    // AND IT IS THE GROUP, not the pid alone. MEASURED, and this was found by a
    // process-hygiene check rather than by a test: with `child.kill("SIGKILL")` on
    // the direct pid the lane PASSED — the port reported a refusal at its bound — and
    // `ps` afterwards still found the hung child, running and holding the install
    // root, long after the test had exited and its parent was gone. The child here
    // is `node`, and `node` starts `pg_dump`; killing the direct child leaves the
    // dump running, holding the SERIALIZABLE snapshot and the output file open,
    // which is a lock on the owner's database that nothing would ever release.
    //
    // So the child is spawned `detached: true`, which gives it a process group of its
    // own whose id is its pid, and the abandon path signals THAT group by the negative
    // pid. It reaches the child and everything it started and nothing else, because the
    // group was created for this spawn alone. Never a `pgrep`/`pkill` pattern and never
    // a bare pid found by searching.
    const finish = (action, value, abandoned) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (abandoned) {
        try { process.kill(child.pid === undefined ? undefined : -child.pid, "SIGKILL"); }
        catch { try { child.kill("SIGKILL"); } catch { /* the child is already gone */ } }
      }
      action(value);
    };
    // Bounded output, because the port reads a line out of it. A child that
    // wrote a megabyte cannot make this process hold a megabyte.
    const append = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { finish(resolveSpawn, { code: null, signal: "SIGKILL", stdout, stderr }, true); return target; }
      return target + chunk.toString("utf8");
    };
    timer = setTimeout(() => finish(resolveSpawn, { code: null, signal: "SIGKILL", stdout, stderr }, true), timeoutMs);
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.once("error", error => finish(reject,
      Object.assign(new Error("nightly_backup_spawn_failed"), { cause: error }), true));
    child.once("close", (code, signal) => finish(resolveSpawn, { code, signal, stdout, stderr }, false));
  });
}

/**
 * The default `backup_now` port: the SHIPPED nightly backup artifact, spawned
 * against the SHIPPED protected configuration for this install root.
 *
 * WHY IT SPAWNS AND DOES NOT IMPORT, and this is the whole fix. It used to
 * `await import("../../installer/v1/nightly-backup")` in-process. That import
 * chain reaches `nightly-backup-configuration.ts`, which imports
 * `deploy/postgres/migration-ledger.json` — RELEASE DATA. The fixed updater bundle
 * is built from an isolated copy of `src/updater/v1` plus a short, explicit list
 * of crossed-in files, precisely so the trusted, self-updating component never
 * carries release code, and
 * `src/updater/v1/pg/apply-release-schema.mjs` documents that rule by name for
 * the same reason. MEASURED: with the import in place the bundle build refused
 * outright with esbuild `Could not resolve "../../installer/v1/nightly-backup"`
 * — so `buildFixedUpdaterBundleV1` could produce NO self-update bundle, and the
 * owner's installed updater could never receive R5B-01's alert or R5B-02's
 * button. Spawning the artifact that already exists fixes the build and keeps
 * the trust rule, and it is the pattern the project already uses to cross this
 * boundary: `moveLiveDatabaseV1` and `initializeDatabaseV1` in
 * `cli/control-room-native-ports.mjs` both spawn the shipped script rather than
 * importing it, and take their `assertPath` as a parameter for exactly this
 * reason.
 *
 * WHY THE OWNER STILL GETS A NAMED REFUSAL. A root with no
 * `Protected/config/backup.json` is refused by the child's OWN configuration guard
 * as `nightly_backup_configuration_refused`, and that reason is mapped back out of
 * the child's exit code and stderr — the shape the brief asks for: a control that
 * cannot run refuses UP FRONT with a plain reason and is not shown as accepted.
 *
 * @param root the install root, which is the updater's own root.
 * @param assertPath the trusted-path check, injected for the same reason the two
 *   database-phase ports inject theirs: `assertT1Path` walks the ancestry and
 *   requires root ownership, which a test running as an unprivileged user cannot
 *   satisfy. It defaults to the real one, so production is not stubbed.
 * @param timeoutMs the child's bound; see `BACKUP_NOW_TIMEOUT_MS_V1`.
 */
export function defaultBackupNowV1(root, {
  assertPath = assertT1Path,
  timeoutMs = BACKUP_NOW_TIMEOUT_MS_V1,
  // The spawn and the read-back, as parameters so both can be asserted.
  //
  // MEASURED, and this is the reason rather than a testing convenience. With the
  // spawn inline, three mutations left this port's own lane GREEN: replacing it
  // with a hardcoded success, deleting the timeout, and (before the bundle test
  // grew a negative control) deleting its trust assertions. Each was a property
  // of a spawn that was never made. A port whose subprocess cannot be observed is
  // a port whose argv, environment, timeout and exit mapping are asserted
  // nowhere — and the two database-phase ports in
  // `cli/control-room-native-ports.mjs` take their transport as a parameter for
  // exactly this reason, with the same measurement written into their comments.
  // Production passes neither, so both defaults are the real functions.
  spawnBackup = spawnNightlyBackupV1,
  readOutcome = parseNightlyBackupOutcomeV1,
} = {}) {
  return async () => {
    if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === "/") {
      throw updaterRefuseV1("updater_configuration_refused");
    }
    const paths = nightlyBackupSpawnPathsV1(root);
    // The trust half, before anything is spawned: both the interpreter and the
    // script must be inside this install root, root-owned and not writable by
    // anyone else. Without it a substituted `current/dist-vps` would be run by
    // the trusted updater with the updater's own authority.
    await assertPath(paths.executable, { allowedRoots: [root], executable: true });
    await assertPath(paths.script, { allowedRoots: [root] });
    const outcome = readOutcome(await spawnBackup(paths.executable,
      [paths.script, "--configuration", paths.configuration], timeoutMs));
    if (!outcome.ok) throw Object.assign(new Error(outcome.reason), { code: outcome.reason });
  };
}

export async function startUpdaterV1(options = {}) {
  const root = options.root ?? updaterRootV1(options.env ?? process.env);
  const release = await acquireUpdaterLocalLockV1(root, "updater-state/updater.lock");
  try {
    const updater = await startLockedUpdaterV1({ ...options, root });
    let stopping;
    return Object.freeze({ ...updater, stop() {
      stopping ??= updater.stop().finally(release);
      return stopping;
    } });
  } catch (error) { await release(); throw error; }
}

async function startLockedUpdaterV1(options = {}) {
  const env = options.env ?? process.env, root = options.root ?? updaterRootV1(env);
  let client = options.client, ownsClient = false, store = options.store, startupStep = "configuration";
  try {
  if (!store) {
    const configuration = await loadUpdaterConfigurationV1(root, options.args ?? []);
    const pg = options.pg ?? await import("pg");
    if (!client) {
      client = new pg.Client({ host: configuration.database.host, port: configuration.database.port,
        database: configuration.database.name, user: configuration.database.user });
      ownsClient = true;
    }
    startupStep = "database_connect"; if (ownsClient) await client.connect();
    startupStep = "database_initialize"; store = new PostgresUpdaterStoreV1(client); await store.initialize();
  }
  const reportError = options.onTimerError ?? (error => {
    process.stderr.write(`${typeof error?.code === "string" ? error.code : "updater_timer_failed"}\n`);
  });
  // R12 wiring, corrected after review. The production entry point passes NO
  // options, so the ABSENCE of an `alerts` key has to mean the real sender,
  // exactly like every other optional collaborator in this function (`store`,
  // `effects`, `referee`, `ownerActions`). The previous ternary read the
  // absence of the key as "off" and an explicit `null` as "on", so production
  // started with no sender at all and the VAPID custody gate below never ran:
  // the item could not fire, and the gate meant to catch a mis-held key was
  // dead code. Only an explicit `alerts: null`/`false` opts out.
  //
  // `alertRuntime` injects the PROCESS IDENTITY the VAPID custody check reads
  // (`getuid`, `lstat`, `readFile`) and nothing else — never the sender, its
  // store or its send path. It exists so a test running as a non-root user can
  // exercise this DEFAULT construction, which is the whole point of the fix.
  // Production leaves it unset.
  const alerts = options.alerts === false || options.alerts === null ? null
    : options.alerts ?? new UpdaterAlertSenderV1({ root, store, ...(options.alertRuntime ?? {}) });
  // Preflight BEFORE the lease is acquired below, so a custody refusal cannot
  // strand a session advisory lock that the acquire failure path is not in
  // scope to release — a stranded lock is a permanent, silent refusal to ever
  // update again.
  //
  // A key that is simply not installed yet is NOT a refusal. §15 item 21 states
  // install-night pushes come from item 8's minimal sender, and the key is
  // written by the installer, so a root-only updater that starts before it
  // would otherwise refuse to apply the release it was woken for. The absence
  // is reported once, as a warning, and the sender is left off so no send is
  // attempted without a key. Every other custody refusal — `not_root`,
  // `permissions_refused`, `invalid` — stops the updater rather than starting a
  // process that could never alert.
  let alertSender = alerts;
  if (alerts) {
    startupStep = "alert_preflight";
    try { await alerts.preflight(); }
    catch (error) {
      if (error?.code !== "updater_vapid_unavailable") throw error;
      reportError(Object.assign(new Error("updater_vapid_unavailable"),
        { code: "updater_vapid_unavailable", warning: true }));
      alertSender = null;
    }
  }
  const requestedIdentity = options.identity ?? newUpdaterIdentityV1();
  let acquisition;
  startupStep = "lease_acquire";
  if (store.acquire) acquisition = await store.acquire(requestedIdentity.leaseToken);
  else {
    const run = await store.liveRun();
    acquisition = { status: "acquired", run, leaseToken: run?.lease_token ?? requestedIdentity.leaseToken };
  }
  if (acquisition.status !== "acquired") {
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
  startupStep = "journal_recovery"; await journal.recoverCompaction();
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
  // R5B-02. THE OWNER'S THREE CONTROLS. Measured on the production composition
  // (only the database store and the install root substituted): `backup_now`,
  // `rollback` and `repair_serve` were each ACCEPTED from the owner and then
  // refused, because the default handler knew only pause, stop, resume and
  // check-and-continue and answered everything else with
  // `updater_owner_action_port_unbound`. The outcome column said `refused` with no
  // reason stored (`runtime.mjs` turns any throw into that string), so the owner's
  // button did nothing and said nothing.
  //
  // BACKUP NOW IS BOUND, because it genuinely can run here. It SPAWNS the SHIPPED
  // nightly entry against the SHIPPED protected configuration — the same
  // `dist-vps/server/nightlyBackup.js`, the same credential file, the same lock and
  // the same `pg_dump` the launchd daemon runs — so "Back up now" and tonight's
  // scheduled backup are the same operation, and the owner gets the same refusal the
  // daemon would have got if it could not run. It is deliberately NOT a second
  // backup path: a control that took a different dump would be a control whose
  // output the owner's restore runbook had never seen. It is also deliberately not
  // an import of that entry: the runner's chain reaches
  // `deploy/postgres/migration-ledger.json`, and this bundle must not carry release
  // data — the rule `pg/apply-release-schema.mjs` states for the same reason.
  //
  // ROLLBACK AND REPAIR ARE REFUSED WITH A NAMED REASON, up front, and the reason
  // is the operator's to read. Restoring a database means replacing the running
  // cluster's contents with a dump taken at an earlier moment, and repairing the
  // serving pair means moving a symlink under a live install; neither is bound in
  // this release, and a handler that half-performed either would be far worse than
  // one that refuses. So each refuses with its own code rather than one generic
  // "unbound", and each code names what is missing. These are refusals the owner
  // can be shown — which is what "refuse it UP FRONT with a plain reason"
  // requires — and the request row still lands as `refused`, so the ledger of
  // owner requests stays truthful about what happened.
  const backupNow = options.backupNow ?? defaultBackupNowV1(root);
  const ownerActions = options.ownerActions
    ?? defaultUpdaterOwnerActionsV1({ mode, runner, backupNow, store });
  // R5B-01, THE OWNER HALF. `alerts.reconcile` already knows a
  // `backupMissing` condition and already has a reviewed push template for it
  // ("Control Room backup is missing or too old"), but nothing ever SET it — a
  // search of `src/` found no producer, which is how the nightly could fail every
  // night for a release and the owner heard nothing. This is the producer.
  //
  // It is COMPOSED rather than injected, for the same reason every other optional
  // collaborator above is: the production entry point passes no options, so the
  // ABSENCE of the key has to mean "the real one" and only an explicit null opts
  // out. An injected-only producer would be another dead flag in production, which
  // is the defect this fixes.
  //
  // The root is the SAME one the nightly writes under (`<root>/backups/nightly`,
  // from the shipped configuration builder), so the reader and the writer cannot
  // disagree about where a backup lives. A root that has no backup directory at
  // all — an install whose nightly has never run, or a rehearsal — reads overdue,
  // which is the loud answer and the correct one.
  const alertFacts = options.alertFacts ?? (async () => {
    const { readNewestGoodBackupV1 } = await import("../../installer/v1/nightly-backup-recency.ts");
    const newest = await readNewestGoodBackupV1(join(root, "backups", "nightly"));
    return Object.freeze({ backupMissing: newest.overdue === true });
  });
  const loop = new UpdaterMainLoopV1({ runner, store, stateFiles, mode, ownerActions, watcher: options.watcher ?? null,
    alerts: alertSender, alertFacts, onError: reportError });
  const heartbeat = new UpdaterHeartbeatV1({ store, stateFiles, ...identity, report: () => heartbeatState,
    onError: reportError });
  const control = new UpdaterControlServerV1({ root, handler: async (request, context) => {
    if (request.verb === "passkey-add-begin") {
      // The mode travels from the CLI, which chose it from the ledger, rather
      // than being hard-coded to `add` here. MEASURED: with `add` hard-coded on
      // both sides, `passkey add` on a Mac with no passkey produced a first
      // passkey that was inactive for 24 hours — there is no active passkey to
      // approve it, so the cooling-off could never be skipped. The authority
      // refuses `initial` when the ledger already holds a passkey, so accepting
      // the mode here cannot weaken a later passkey.
      const mode = request.arguments.length === 0 ? "add" : request.arguments[0];
      if (request.arguments.length > 1 || !["initial", "add"].includes(mode))
        throw updaterRefuseV1("updater_passkey_arguments_refused");
      const registration = await passkeys.beginRegistration({ mode });
      const registrationOptions = await passkeys.registrationOptions(registration.registrationSecret);
      if (!passkeyStore?.openRegistration) throw updaterRefuseV1("updater_passkey_store_port_unbound");
      await passkeyStore.openRegistration({ registrationDigest: registration.registrationDigest,
        installationId: registration.config.installationId, mode, optionsJson: registrationOptions,
        authorizationChallenge: registration.authorizationChallenge, expiresAt: registration.expiresAt });
      return { registrationSecret: registration.registrationSecret, mode,
        expectedOrigin: registration.config.expectedOrigin, expiresAt: registration.expiresAt };
    }
    if (request.verb === "passkey-add-complete") {
      if (request.arguments.length !== 2) throw updaterRefuseV1("updater_passkey_arguments_refused");
      const registration = await passkeys.registrationOptions(request.arguments[0]);
      if (!passkeyStore?.consumeRegistration) throw updaterRefuseV1("updater_passkey_store_port_unbound");
      // Close the phone write window first. The response row remains readable
      // by the updater, but the registration secret is single-use: after an
      // uncertain reply the owner must use passkey list to verify the result.
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
      requires_passkey: request.verb === "rollback", source: "root" }, context);
  } });
  try {
    startupStep = "mode_initialize"; await mode.initialize();
    startupStep = "passkey_initialize"; if (ownsPasskeyStore) await passkeyStore.initialize();
    // Item 13: settle a durable release/database link transaction before any
    // run is observed. The actuator either completes it or restores its source.
    startupStep = "effects_recovery";
    await effects.recover?.();
    startupStep = "control_start"; await control.start();
    startupStep = "initial_heartbeat"; await heartbeat.beat();
    startupStep = "initial_tick"; await loop.tick();
    startupStep = "ready_heartbeat"; await heartbeat.beat(); heartbeat.start(); loop.start();
  } catch (error) {
    try { await drainUpdaterWorkV1(loop, control); } finally { await heartbeat.stop(); }
    throw error;
  }
  return Object.freeze({ root, identity, store, runner, loop, heartbeat, control, passkeys, refusalAggregator, alerts: alertSender,
    setHeartbeatState,
    // R7U-01 (lead decision 3): the owner's acknowledgement PORT, for a web host
    // to mount. It is a composition value rather than a route here, because this
    // process is root-owned and the web host is not: the host asks, and this
    // composition writes the durable `owner_requests` row the loop answers on its
    // next tick.
    //
    // It refuses when the store cannot record a request at all, rather than
    // reporting a press as accepted and losing it — the difference between "I have
    // seen this" being recorded and the card silently not clearing.
    ownerAttention: typeof store?.requestAttentionAcknowledgement === "function"
      ? Object.freeze({ acknowledge: async ({ ownerSubject, ownerSessionDigest } = {}) => {
        const request = await store.requestAttentionAcknowledgement(ownerSessionDigest, { ownerSubject });
        return Object.freeze({ schema: "control-room.updater-owner-attention/v1",
          acknowledged: true, nothingOutstanding: false, requestId: request.id });
      } })
      : null,
    async stop() {
      try { await drainUpdaterWorkV1(loop, control); }
      finally {
        await heartbeat.stop();
        if (ownsClient) await client.end();
        else if (store.release) {
          try { await releaseStoreV1(store); } catch (error) { reportError(error); }
        }
      }
    } });
  } catch (error) {
    if (ownsClient) await client.end().catch(() => {});
    else await releaseStoreV1(store).catch(() => {});
    error.updaterStep ??= startupStep;
    throw error;
  }
}

// The shared entry guard, asked the one question it can answer here — "is this
// the entry?" — and its refusal is only allowed to BE the answer when there IS
// an entry to be wrong about.
//
// This file is both an entry and an import target:
// `control-room-native-ports.mjs` imports it, so anything that imports THAT
// (the installer's own `the archived installer entry and native ports load
// without node_modules` does, through `--eval`) must reach this module's body
// without running its CLI. Two `process.argv[1]` shapes make that an import
// rather than an entry, both MEASURED with `--eval` and `--input-type=module`:
//
//   absent        — `node --input-type=module --eval "<code>"` with no extra
//                   argument leaves `argv` at one element. The helper answers
//                   `false` and this body does not run.
//
//   "file:…"      — under `--eval` the first extra argument lands in `argv[1]`
//                   verbatim, which is how `--eval "await import(process.argv[1])"
//                   <url>` names the module to load. MEASURED: `node <a file: URL>`
//                   fails with `Cannot find module '<cwd>/file:/…'`, so a `file:`
//                   URL is never a real entry. The helper REFUSES this shape,
//                   which is why the "import" test in `invoked-directly.test.mjs`
//                   loads the module with `await import()` and passes the URL as
//                   a REAL PATH rather than as a URL.
//
// The pre-guard that used to sit here (`typeof argv[1] === "string" && … &&
// !startsWith("file:") && isMainModuleV1(…)`) duplicated that decision in three
// files. It is gone with the second copy of the guard; the helper is the one
// definition, and the repository-wide policy test still rejects any direct
// comparison outside it.
if (isMainModuleV1(process.argv[1], import.meta.url)) startUpdaterV1({ args: process.argv.slice(2) }).then(updater => {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void updater.stop().finally(() => process.exit(0)));
}).catch(error => { process.stderr.write(`${"updater_start_failed"}:${error?.updaterStep ?? "local_lock"}:${error?.code ?? "unknown"}\n`); process.exitCode = 1; });
