// R5B-02: THE OWNER'S BACKUP BUTTON MUST DO A BACKUP, AND THE TWO CONTROLS
// THAT CANNOT RUN MUST SAY SO.
//
// MEASURED FAILURE THIS LANE REPRODUCES. On the PRODUCTION composition — the
// real `startUpdaterV1`, with only the database store and the install root
// substituted, exactly as a launchd service runs it — the owner's controls came
// back:
//
//   backup_now:refused   rollback:refused   repair_serve:refused   pause:acted
//
// with self-update both On and Off. The reason was `updater_owner_action_port_unbound`
// for all three, and `UpdaterMainLoopV1` turns any throw into the bare outcome
// string `refused` with nothing stored, so the owner's button did nothing and said
// nothing. Meanwhile R5B-01 meant there was no backup at all.
//
// THIS LANE RUNS THE PRODUCTION COMPOSITION. No injected `ownerActions`, no
// injected `effects`, no stub store for the code under test: the real startup,
// the real owner-request loop, the real outcome accounting. Only the store (the
// updater's own database port, which needs a cluster this file does not have) and
// the root are substituted, and `alerts: null` opts out of the push sender — which
// is the SAME documented opt-out production uses in `updater.mjs`.
//
// WHY `backup_now` IS EXPECTED TO ACT. It is now bound to the shipped
// `runNightlyBackupV1` against the shipped protected configuration, so "Back up
// now" and tonight's scheduled backup are the same operation. In THIS test that
// port is supplied (the real one would need a live cluster, and the real cluster
// path is proven in `nightly-backup-real-postgres.test.ts`); the default port's own
// refusals are asserted separately, below, from a root with no configuration.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startUpdaterV1 } from "../src/updater/v1/updater.mjs";

/** One owner request of each kind the owner page can send. */
const REQUESTS = Object.freeze([
  { id: "owner-request:11111111-1111-4111-8111-111111111111", request_kind: "backup_now", detail: {}, requires_passkey: false },
  { id: "owner-request:22222222-2222-4222-8222-222222222222", request_kind: "rollback", detail: {}, requires_passkey: true },
  { id: "owner-request:33333333-3333-4333-8333-333333333333", request_kind: "repair_serve", detail: {}, requires_passkey: false },
  { id: "owner-request:44444444-4444-4444-8444-444444444444", request_kind: "pause", detail: {}, requires_passkey: false },
]);

type Finished = { id: string; outcome: string }[];

/**
 * The updater's own store port, with the three methods the owner-request loop
 * uses. Only `unhandledOwnerRequests` and `finishOwnerRequest` carry the code
 * under test; the rest are the store's contract the startup sequence calls.
 */
function storeV1(finished: Finished) {
  const pending = [...REQUESTS];
  return {
    initialize: async () => {},
    liveRun: async () => null,
    heartbeat: async () => {},
    events: async () => [],
    unhandledOwnerRequests: async () => [...pending],
    finishOwnerRequest: async (id: string, outcome: string) => {
      finished.push({ id, outcome });
      const index = pending.findIndex(request => request.id === id);
      if (index >= 0) pending.splice(index, 1);
      return true;
    },
    release: async () => {},
  };
}

/** An install root the real startup accepts: an updater-state and a status dir.
 *
 * Under `/tmp`, not `os.tmpdir()`. `UpdaterControlServerV1` refuses a control
 * socket path over ~103 bytes with `updater_control_socket_path_too_long`, and
 * macOS's `tmpdir()` is `/var/folders/qb/llfk_qh163d9rlt2zvhgdncc0000gn/T` —
 * 47 characters — so a root named under it plus `/updater-state/updater.sock`
 * crosses the cap and the startup fails before any owner request is read. The
 * guard is real and correct; a test has to give it room. */
async function rootV1(t: test.TestContext, flag = "On\n") {
  const root = await mkdtemp(join("/tmp", "r5bk-owner-action-"));
  await mkdir(join(root, "updater-state"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "status"), { recursive: true, mode: 0o755 });
  await writeFile(join(root, "updater-state", "self-update"), flag, { mode: 0o600 });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

for (const flag of ["On\n", "Off\n"]) {
  test(`the owner's controls do the work or say why they cannot, with self-update ${flag.trim()}`, async t => {
    const root = await rootV1(t, flag);
    const finished: Finished = [];
    // The bound `backup_now` port. Records that it RAN and returns; the real
    // cluster path is the other lane's job.
    const backups: string[] = [];
    let updater: Awaited<ReturnType<typeof startUpdaterV1>> | undefined;
    try {
      updater = await startUpdaterV1({ root, store: storeV1(finished), alerts: null, onTimerError: () => {},
        backupNow: async () => { backups.push("ran"); } });
      await updater.loop.tick();
    } finally { await updater?.stop().catch(() => {}); }

    const outcomeOf = (kind: string) => {
      const request = REQUESTS.find(entry => entry.request_kind === kind)!;
      return finished.find(entry => entry.id === request.id)?.outcome;
    };
    // THE REGRESSION. `backup_now` acted, and the port it called ran exactly once.
    assert.equal(outcomeOf("backup_now"), "acted",
      'the owner\'s "Back up now" must reach a real handler, not a refusal');
    assert.deepEqual(backups, ["ran"], "and it must actually run the backup it was asked for");
    // `pause` is the control that already worked; it must keep working.
    assert.equal(outcomeOf("pause"), "acted", "the pause control must not regress");
    // The two that cannot run here refuse — but they refuse for their OWN named
    // reason, and the distinction is asserted below.
    assert.equal(outcomeOf("rollback"), "refused");
    assert.equal(outcomeOf("repair_serve"), "refused");
  });
}

test("the real handler gives each control its OWN refusal code, and an unknown kind still refuses as unbound", async t => {
  const root = await rootV1(t);
  // The REAL handler, composed the way production composes it — no injected
  // `ownerActions`, so what is under test is the shipped dispatch, not a copy.
  // `mode` and `runner` are the two collaborators pause/resume/check need, and
  // only `backup_now` is substituted here because the real one needs a cluster.
  const { UpdaterModeV1, UpdaterStateFilesV1 } = await import("../src/updater/v1/runtime.mjs");
  const stateFiles = new UpdaterStateFilesV1(root, "lease-r5bk");
  const mode = new UpdaterModeV1(stateFiles);
  const runner = { checkAndContinue: async () => ({ status: "idle" }) };
  const backups: string[] = [];
  const { defaultUpdaterOwnerActionsV1 } = await import("../src/updater/v1/updater.mjs");
  const handler = defaultUpdaterOwnerActionsV1({ mode, runner, backupNow: async () => { backups.push("ran"); } });

  // Each kind, and the code it throws. Four DISTINCT answers, because a control
  // that cannot run has to be able to say WHICH thing is missing.
  const codes = new Map<string, string>();
  for (const kind of ["backup_now", "rollback", "repair_serve", "serve_accepted", "passkey_added", "made_up_kind"]) {
    try {
      await handler.handle({ request_kind: kind, detail: {}, requires_passkey: false, source: "web" });
      codes.set(kind, "acted");
    } catch (error) { codes.set(kind, (error as { code?: string }).code ?? String((error as Error).message)); }
  }
  assert.deepEqual(Object.fromEntries(codes), {
    backup_now: "acted",
    rollback: "updater_rollback_not_available_on_this_install",
    repair_serve: "updater_repair_not_available_on_this_install",
    // A kind this release has never heard of must NOT borrow either named
    // refusal — otherwise an unknown control reads as a known one that merely
    // happens to be unavailable, and the owner's reason is a lie.
    serve_accepted: "updater_owner_action_port_unbound",
    passkey_added: "updater_owner_action_port_unbound",
    made_up_kind: "updater_owner_action_port_unbound",
  }, "each control refuses with its own code, and an unknown kind stays unbound");
  assert.deepEqual(backups, ["ran"], "the backup_now port ran once, for the one request that asked for it");
});

// R5B-01's OWNER HALF, on the production composition: the updater's alert facts
// must actually report `backupMissing` when the nightly has left nothing, because
// `alerts.reconcile` already knows that condition and already has a reviewed push
// template for it ("Control Room backup is missing or too old") — and nothing ever
// set it. That is how the nightly could fail every night for a release and the
// owner heard nothing.
test("the production alert facts report backupMissing only when the newest good backup is old", async t => {
  const root = await rootV1(t);
  const fresh = join(root, "backups", "nightly", "2026-10-05T02-30-00-000Z");
  const writeFresh = async (createdAt: string) => {
    await mkdir(fresh, { recursive: true });
    await writeFile(join(fresh, "database.dump"), "x");
    await writeFile(join(fresh, "metadata.json"), JSON.stringify({ version: 1, createdAt,
      identity: { identityDigest: `sha256:${"e".repeat(64)}` } }));
  };
  // The real sender is the one port substituted; the facts producer under test is
  // the one the production composition builds with nothing injected.
  const reconcileWith = async (): Promise<Record<string, unknown>> => {
    let seen: Record<string, unknown> = {};
    let updater: Awaited<ReturnType<typeof startUpdaterV1>> | undefined;
    try {
      updater = await startUpdaterV1({ root, store: storeV1([]), onTimerError: () => {},
        alerts: { preflight: async () => {}, reconcile: async (facts: Record<string, unknown>) => { seen = facts; },
          tick: async () => ({ status: "ok", sent: 0, subscriptions: 0 }) } as never });
      await updater.loop.tick();
    } finally { await updater?.stop().catch(() => {}); }
    return seen;
  };

  // No backups/nightly directory at all: the case that let the nightly fail every
  // night in silence. Overdue.
  assert.equal((await reconcileWith()).backupMissing, true,
    "an install root with no backups/nightly directory at all is overdue, and must say so");

  // A good generation from a minute ago: NOT overdue. Without this half the test
  // would pass for a producer that simply always returns true, which would make
  // the owner get a "backup is missing" push every night and learn to ignore it.
  await writeFresh(new Date(Date.now() - 60_000).toISOString());
  assert.equal((await reconcileWith()).backupMissing, false,
    "a good backup taken a minute ago must not be reported as missing");

  // The same generation, now 40 hours old: overdue again. The threshold is the
  // owner's (36 hours), and this is the case the finding is actually about.
  await writeFile(join(fresh, "metadata.json"), JSON.stringify({ version: 1,
    createdAt: new Date(Date.now() - 40 * 3_600_000).toISOString(),
    identity: { identityDigest: `sha256:${"e".repeat(64)}` } }));
  assert.equal((await reconcileWith()).backupMissing, true,
    "a good backup 40 hours old is overdue, which is the owner's threshold");
});

// The DEFAULT `backup_now` port is the shipped one, and it must refuse a root
// with no protected configuration rather than silently reporting success. This
// is the failure mode the brief calls out: a control that cannot run must refuse
// UP FRONT with a plain reason, not be shown as accepted.
test("the default backup-now port refuses an install with no nightly configuration", async t => {
  const root = await rootV1(t, "Off\n");
  const { defaultBackupNowV1, defaultUpdaterOwnerActionsV1 } = await import("../src/updater/v1/updater.mjs");
  const { UpdaterModeV1, UpdaterStateFilesV1 } = await import("../src/updater/v1/runtime.mjs");
  // The install root is built to the SHAPE the port spawns, because `backup_now`
  // no longer imports the runner: it SPAWNS `<root>/runtime/node-current/bin/node
  // <root>/current/dist-vps/server/nightlyBackup.js`, and it checks both paths with
  // `assertT1Path` BEFORE spawning. MEASURED: with a bare root this test failed with
  // `t1_path_missing` rather than the refusal it exists to assert — the port refused
  // for a missing interpreter, which is a different and weaker answer than "the
  // protected configuration is absent".
  //
  // What is stubbed is therefore the TRUST CHECK, which needs root ownership this
  // lane does not have — the same injection the database-phase ports take and the
  // same one `tests/install-database-phase-real-postgres.test.mjs` documents. The
  // SPAWN is not stubbed: a real node runs the real fixture, which has no
  // configuration to read, so `nightly_backup_configuration_refused` comes from the
  // child's own guard through the real exit-code mapping.
  const paths = await (await import("../src/updater/v1/updater.mjs")).nightlyBackupSpawnPathsV1(root);
  await mkdir(join(root, "runtime", "node-current", "bin"), { recursive: true });
  await mkdir(join(root, "current", "dist-vps", "server"), { recursive: true });
  await symlink(process.execPath, paths.executable);
  // A stand-in for the built artifact: it refuses the way the shipped entry does
  // when `Protected/config/backup.json` is absent, which is this test's subject.
  await writeFile(paths.script, [
    'import { existsSync } from "node:fs";',
    'const configuration = process.argv[3];',
    'if (!existsSync(configuration)) {',
    '  process.stderr.write("nightly database backup failed: nightly_backup_configuration_refused\\n");',
    '  process.exitCode = 1;',
    '}',
  ].join("\n"), { mode: 0o700 });
  const handler = defaultUpdaterOwnerActionsV1({ mode: new UpdaterModeV1(new UpdaterStateFilesV1(root, "lease-r5bk")),
    runner: { checkAndContinue: async () => ({ status: "idle" }) },
    backupNow: defaultBackupNowV1(root, { assertPath: async (path: string) => path }) });
  // The SHIPPED spawn, the SHIPPED configuration path, on a root that has none.
  await assert.rejects(() => handler.handle({ request_kind: "backup_now", detail: {}, requires_passkey: false, source: "web" }),
    (error: Error) => {
      assert.match(error.message, /^nightly_backup_configuration_refused$/u,
        `an install with no Protected/config/backup.json must refuse by name, got ${error.message}`);
      return true;
    });
});
// cook/11int11: r7ufix2's acknowledge_attention branch now lives in int10's
// defaultUpdaterOwnerActionsV1, so the production composition must hand that
// handler its store. Without it the owner's "I have seen this" is refused as
// unbound on every install. Composed the production way: only the store and the
// install root are substituted.
test("the composed updater answers the owner's acknowledgement through its own store", async t => {
  const root = await rootV1(t, "On\n");
  const finished: Finished = [], acknowledged: string[] = [];
  const request = { id: "owner-request:55555555-5555-4555-8555-555555555555", request_kind: "acknowledge_attention",
    detail: { ownerSubject: "owner:local" }, requires_passkey: false };
  let pending = [request];
  const store = { ...storeV1(finished),
    unhandledOwnerRequests: async () => [...pending],
    finishOwnerRequest: async (id: string, outcome: string) => {
      finished.push({ id, outcome }); pending = pending.filter(entry => entry.id !== id); return true; },
    acknowledgeOpenRunAttention: async (identity: string) => { acknowledged.push(identity); return { runId: "run:fixture" }; } };
  let updater: Awaited<ReturnType<typeof startUpdaterV1>> | undefined;
  try {
    updater = await startUpdaterV1({ root, store, alerts: null, onTimerError: () => {}, backupNow: async () => {} });
    await updater.loop.tick();
  } finally { await updater?.stop().catch(() => {}); }
  assert.deepEqual(finished, [{ id: request.id, outcome: "acted" }], "the acknowledgement was not acted on");
  assert.deepEqual(acknowledged, ["owner:local"], "and it must be recorded against the owner the request names");
});
