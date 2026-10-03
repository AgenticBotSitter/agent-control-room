import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { execGuardV1, guardScratchV1 } from "./support/updater-guard.mjs";
import { GUARD_DATABASE_ACCOUNT_V1, guardStatStandInV1 } from
  "../src/updater/v1/rehearsal/guard-ownership-fixture.mjs";
import { FileStepJournalV1 } from "../src/updater/v1/journal.mjs";
import { UpdaterControlServerV1, sendControlRequestV1 } from "../src/updater/v1/control-socket.mjs";
import { UpdaterHeartbeatV1 } from "../src/updater/v1/runner.mjs";
import { UpdaterMainLoopV1, UpdaterModeV1, UpdaterStateFilesV1 } from "../src/updater/v1/runtime.mjs";
import { startUpdaterV1 } from "../src/updater/v1/updater.mjs";
import { GitMirrorSourceV1, RefereeGitClassifierV1 } from "../src/updater/v1/watcher.mjs";
import { runUpdaterCliV1 } from "../src/updater/v1/cli.mjs";
import { parseSelfUpdateFlagV1 } from "../src/updater/v1/contracts.mjs";

const macGuardTest = (name, fn) => test(name, { timeout: 120_000, skip: process.platform === "darwin" ? false
  : "Mac rescue guard requires launchd, plutil and BSD lockf" }, fn);
const exec = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function rootFor(t) {
  const root = await mkdtemp("/private/tmp/h6-");
  await mkdir(join(root, "updater-state"), { mode: 0o700 }); await mkdir(join(root, "status"));
  await writeFile(join(root, "updater-state/self-update"), "On\n");
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const request = verb => ({ schema: "control-room.updater-control/v1", requestId: "test", verb, arguments: [] });
const memoryStore = () => ({ liveRun: async () => null, heartbeat: async () => {},
  unhandledOwnerRequests: async () => [], finishOwnerRequest: async () => {} });
const start = (root, options = {}) => startUpdaterV1({ root, store: memoryStore(), alerts: null, ...options });
const canonical = value => value && typeof value === "object" && !Array.isArray(value)
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);

test("F3-01 conflicting ordinals are refused before append and old damage can be quarantined", async t => {
  const root = await rootFor(t), journal = new FileStepJournalV1(root);
  const record = { runId: "run-one", ordinal: 1, from: "approved", to: "prechecked", detail: {} };
  await journal.intent(record); const original = await readFile(join(root, "updater-state/journal.jsonl"), "utf8");
  await assert.rejects(journal.intent({ ...record, to: "refused" }), /updater_journal_ordinal_refused/u);
  assert.equal(await readFile(join(root, "updater-state/journal.jsonl"), "utf8"), original);
  const previous = JSON.parse(original).mac, key = Buffer.from((await readFile(join(root, "updater-state/journal.key"), "utf8")).trim(), "hex");
  const entry = { schema: "control-room.updater-journal/v1", kind: "intent", at: new Date().toISOString(), ...record, to: "refused" };
  const mac = createHmac("sha256", key).update(`${previous}\0${canonical(entry)}`).digest("hex");
  await writeFile(join(root, "updater-state/journal.jsonl"), original + canonical({ ...entry, prevMac: previous, mac }) + "\n");
  await assert.rejects(journal.validate(), /updater_journal_ordinal_refused/u);
  assert.equal(await journal.quarantineCorrupt(), true);
  await journal.intent(record); await journal.validate();
});

test("F3-02 abandoned first-key temporary files do not wedge retries", async t => {
  const root = await rootFor(t); await writeFile(join(root, "updater-state/journal.key.new"), "", { mode: 0o600 });
  const journal = new FileStepJournalV1(root);
  await journal.intent({ runId: "run-one", ordinal: 1, from: "approved", to: "prechecked", detail: {} });
  await journal.validate();
});

test("F3-05 a complete slow request outlives the input deadline under a 50-caller burst", async t => {
  const root = await rootFor(t), server = new UpdaterControlServerV1({ root, requestTimeoutMs: 30,
    handler: async () => { await sleep(120); return "finished"; } });
  const path = await server.start(); t.after(() => server.stop());
  assert.deepEqual(await Promise.all(Array.from({ length: 50 }, () => sendControlRequestV1(path, request("check-and-continue"), { timeoutMs: 1000 }))), Array(50).fill("finished"));
});

test("F3-05 CLI recovery requests allow a long action timeout", async t => {
  const root = await rootFor(t);
  for (const verb of ["check-and-continue", "rollback"]) {
    let timeout;
    await runUpdaterCliV1([verb], { root, getuid: () => 0, stdout() {}, stderr() {},
      stdinLine: async () => "", send: async (_path, _request, options) => { timeout = options?.timeoutMs; } });
    assert.ok(timeout >= 60_000, verb);
  }
});

test("F3-07 and F3-23 stale or damaged guard display facts do not stop startup", async t => {
  const root = await rootFor(t), files = new UpdaterStateFilesV1(root, "lease");
  for (const value of ["", "{", JSON.stringify({ schema: "control-room.guard-status/v1", updaterRestartsLastHour: 3, at: 1 }),
    JSON.stringify({ schema: "control-room.guard-status/v1", updaterRestartsLastHour: 3, at: Math.floor(Date.now()/1000)+7200 }),
    JSON.stringify({ schema: "control-room.guard-status/v1", updaterRestartsLastHour: 3, at: Math.floor(Date.now()/1000)-0.5 })]) {
    await writeFile(join(root, "updater-state/guard-status.json"), value);
    assert.equal((await files.publicFacts()).updaterRestartsLastHour, 0);
    const updater = await start(root); await updater.stop();
  }
  await writeFile(join(root, "updater-state/guard-status.json"), JSON.stringify({ schema: "control-room.guard-status/v1", updaterRestartsLastHour: 2, at: Math.floor(Date.now()/1000) }));
  assert.equal((await files.publicFacts()).updaterRestartsLastHour, 2);
});

test("F3-11 a hung watcher is bounded, never overlaps, and cannot starve status or retry", async t => {
  const root = await rootFor(t), files = new UpdaterStateFilesV1(root, "lease"), mode = new UpdaterModeV1(files);
  let calls = 0, runners = 0, resolveWatcher; const errors = [];
  const loop = new UpdaterMainLoopV1({ stateFiles: files, mode, store: memoryStore(), ownerActions: {},
    runner: { async runOnce() { runners++; return { status: "idle" }; } }, watcherTimeoutMs: 30,
    watcher: { tick: () => { calls++; return new Promise(resolve => { resolveWatcher = resolve; }); } },
    onError: error => errors.push(error.code) });
  const ticking = loop.tick();
  const result = await Promise.race([ticking, sleep(300).then(() => "hung")]);
  assert.equal(result.status, "idle"); assert.equal(runners, 1);
  await mode.set("paused"); await loop.tick();
  assert.equal(JSON.parse(await readFile(join(root, "status/status.json"), "utf8")).state, "paused");
  assert.equal(calls, 1); assert.ok(errors.includes("updater_watcher_timeout"));
  resolveWatcher(); await sleep(0); await loop.tick(); resolveWatcher();
  assert.equal(calls, 2);
});

test("F3-11 git and classifier children time out and are reaped", async t => {
  const root = await rootFor(t), fake = join(root, "fake-command");
  await writeFile(fake, "#!/bin/sh\nexec /bin/sleep 10\n", { mode: 0o700 });
  for (const existing of [false, true]) {
    if (existing) await mkdir(join(root, "updater-state/mirror.git"));
    const source = new GitMirrorSourceV1({ root, origin: "https://example.invalid/repo", fromCommit: "a".repeat(40), testing: true, git: fake, commandTimeoutMs: 30 });
    const result = await Promise.race([source.fetchMain().then(() => "accepted", error => error.code), sleep(500).then(() => "hung")]);
    assert.match(result, /watcher_(mirror|source_fetch)_refused/u);
  }
  const classifier = new RefereeGitClassifierV1({ node: fake, commandTimeoutMs: 30 });
  assert.equal(await Promise.race([classifier.classify({ repository: root, fromCommit: "a".repeat(40), candidateCommit: "b".repeat(40) }).catch(error => error.code), sleep(500).then(() => "hung")]), "watcher_classification_refused");
});

test("F3-12 root quarantines middle corruption in an idle journal; web cannot clear it", async t => {
  const root = await rootFor(t);
  for (const content of ["{\"torn\"\n{}\n"]) {
    await writeFile(join(root, "updater-state/journal.jsonl"), content, { mode: 0o600 });
    const updater = await start(root);
    try {
      await assert.rejects(updater.runner.checkAndContinue({ source: "web" }), /updater_web_rescue_clear_refused/u);
      assert.equal((await updater.runner.checkAndContinue({ source: "root" })).status, "idle");
      await new FileStepJournalV1(root).refusal({ planId: "plan-one", reason: "test_refusal", count: 1 });
      await new FileStepJournalV1(root).validate();
      await assert.rejects(updater.runner.checkAndContinue({ source: "root" }), /updater_check_continue_refused/u);
    } finally { await updater.stop(); }
  }
});

test("F3-18 stop is bounded when the database heartbeat hangs", async t => {
  let finish; const errors = [];
  const heartbeat = new UpdaterHeartbeatV1({ store: { heartbeat: () => new Promise(resolve => { finish = resolve; }) },
    stateFiles: { writeHeartbeat: async () => {} }, report: () => ({}), stopTimeoutMs: 30,
    onError: error => errors.push(error.code) });
  const pending = heartbeat.beat(); await sleep(0);
  assert.equal(await Promise.race([heartbeat.stop().then(() => "stopped"), sleep(300).then(() => "hung")]), "stopped");
  assert.deepEqual(errors, ["updater_heartbeat_stop_timeout"]); finish(); await pending;
});

test("F3-19 a second control server cannot steal a live socket and stop preserves a replacement", async t => {
  const root = await rootFor(t), first = new UpdaterControlServerV1({ root, handler: async () => "first" });
  const path = await first.start(); t.after(() => first.stop());
  const second = new UpdaterControlServerV1({ root, handler: async () => "second" }); t.after(() => second.stop());
  await assert.rejects(second.start(), /updater_control_busy/u);
  assert.equal(await sendControlRequestV1(path, request("pause")), "first");
  await unlink(path);
  const replacement = createServer(socket => socket.on("data", () => socket.end('{"ok":true,"result":"replacement"}\n')));
  await new Promise(resolve => replacement.listen(path, resolve)); t.after(() => new Promise(resolve => replacement.close(resolve)));
  await first.stop(); assert.equal(await sendControlRequestV1(path, request("pause")), "replacement");
});

test("F3-19 fifty updater starts admit one local owner before any store access", async t => {
  const root = await rootFor(t); let reads = 0;
  const store = memoryStore(); store.liveRun = async () => { reads++; return null; };
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => start(root, { store })));
  const owners = results.filter(row => row.status === "fulfilled").map(row => row.value);
  try {
    assert.equal(owners.length, 1); assert.equal(reads, 2);
    for (const row of results.filter(row => row.status === "rejected")) assert.equal(row.reason.code, "updater_live_session_busy");
  } finally { await Promise.all(owners.map(updater => updater.stop())); }
  const retry = await start(root); await retry.stop();
});

test("F3-19 eight journal processes preserve one MAC chain", async t => {
  const root = await rootFor(t), children = [];
  const module = new URL("../src/updater/v1/journal.mjs", import.meta.url).href;
  const worker = `import {FileStepJournalV1} from ${JSON.stringify(module)}; const journal=new FileStepJournalV1(process.argv[1]); for(let ordinal=1;ordinal<=10;ordinal++) await journal.done({runId:'run-'+process.pid,ordinal,state:'succeeded',detail:{}});`;
  try {
    await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", worker, root], { detached: true, stdio: ["ignore", "ignore", "pipe"] }); children.push(child);
      let error = ""; child.stderr.on("data", chunk => { error += chunk; });
      child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(error)));
    })));
    assert.equal((await new FileStepJournalV1(root).validate()).entries.length, 80);
  } finally {
    for (const child of children) { if (!child.pid) continue; try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => child.once("close", resolve))));
  }
});

// R4S-13: this used to accept `"On\r\n"`, `"On \n"` and `" On\n"`. The installer writes and reads
// exactly `On\n` / `Off\n`, so a looser reader here meant two readers, two answers — and this was
// the one that could start an update. Only the exact bytes are On now.
test("F3-23 only the exact switch bytes are read; padded, marked and CR variants are refused", async t => {
  const root = await rootFor(t);
  await writeFile(join(root, "updater-state/self-update"), "On\n");
  for (const flag of ["On\r\n", "On \n", " On\n", "﻿On\n", " On \n", "On\n\n", "  On"]) {
    await writeFile(join(root, "updater-state/self-update"), flag);
    assert.throws(() => parseSelfUpdateFlagV1(flag), /updater_self_update_flag_refused/u,
      `${JSON.stringify(flag)} must not read as On`);
  }
  for (const [flag, expected] of [["On\n", "On"], ["On", "On"], ["Off\n", "Off"], ["Off", "Off"]]) {
    assert.equal(parseSelfUpdateFlagV1(flag), expected, JSON.stringify(flag));
  }
  for (const value of [undefined, null, 0, {}, [], "ON", "on", "off", "Of", "", "maybe\n"]) {
    assert.throws(() => parseSelfUpdateFlagV1(value), /updater_self_update_flag_refused/u,
      `${JSON.stringify(value)} must refuse`);
  }
  // Control: a release whose display name has a space is still tolerated. A MISSING switch is
  // treated as Off, which is what the installer already assumes (assertSelfUpdateOff returns
  // early on ENOENT) and is the safe direction: it cannot start an update.
  const updater = await start(root); await updater.stop();
  await symlink("releases/1.0.0+build 7", join(root, "current"));
  const withSpace = await start(root); await withSpace.stop();
  assert.equal(JSON.parse(await readFile(join(root, "status/status.json"), "utf8")).releaseId, null);
  await unlink(join(root, "updater-state/self-update"));
  const missing = await start(root); await missing.stop();
  const missingStatus = JSON.parse(await readFile(join(root, "status/status.json"), "utf8"));
  assert.equal(missingStatus.selfUpdate, "Off");
  assert.equal(missingStatus.needsYou, true, "a missing switch needs the owner to restore it");
});

async function guardFor(t, { now = 1000000, changed = now - 600 } = {}) {
  const root = await guardScratchV1(t, "f3"), bin = join(root, "fake-bin"), log = join(root, "calls");
  await mkdir(join(root, "updater-state"), { mode: 0o700 }); await mkdir(bin);
  for (const path of ["releases/A", "releases/B", "pg/data-pa", "pg/data-pb", "pg/socket"]) await mkdir(join(root, path), { recursive: true });
  const executable = (name, body) => writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  await executable("launchctl", 'printf "%s\\n" "$*" >> "$CONTROL_ROOM_GUARD_ROOT/calls"; echo "state = running"; echo "pid = 123"');
  await executable("date", 'case "$1" in -u) echo 2026-10-01T12:00:00Z ;; *) /bin/cat "$CONTROL_ROOM_GUARD_ROOT/now" ;; esac');
  await executable("clock", 'printf "%s %s\\n" "${CONTROL_ROOM_GUARD_TEST_BOOT_ID:-test-boot}" "$(/bin/cat "$CONTROL_ROOM_GUARD_ROOT/elapsed")"');
  await executable("id", "echo 123");
  await executable("stat", guardStatStandInV1({ mtime: '/bin/cat "$CONTROL_ROOM_GUARD_ROOT/changed"' })); await executable("sleep", "exit 0");
  await executable("pg_controldata", "echo 'Database cluster state: shut down'");
  await mkdir(join(root, "fake-plists"));
  await writeFile(join(root, `fake-plists/xyz.agentcontrolroom.rehearsal.hard6.postgres.plist`),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>UserName</key><string>${GUARD_DATABASE_ACCOUNT_V1}</string></dict></plist>`);
  for (const release of ["A", "B"]) {
    for (const path of ["scripts/mac-local", "dist-vps/server"]) await mkdir(join(root, `releases/${release}/${path}`), { recursive: true });
    for (const file of ["RELEASE_MANIFEST.json", "package.json", "scripts/mac-local/task-host-supervisor.mjs", "dist-vps/server/fleetGateway.js", "dist-vps/server/nightlyBackup.js"])
      await writeFile(join(root, `releases/${release}/${file}`), "fixture");
  }
  for (const pg of ["pa", "pb"]) {
    for (const path of ["base", "global", "pg_wal", "pg_wal/archive_status"]) await mkdir(join(root, `pg/data-${pg}/${path}`), { recursive: true });
    for (const file of ["PG_VERSION", "global/pg_control", "pg_hba.conf", "pg_ident.conf", "postgresql.conf"])
      await writeFile(join(root, `pg/data-${pg}/${file}`), "fixture");
  }
  await writeFile(join(root, "elapsed"), String(now));
  await writeFile(join(root, "updater-state/guard-heartbeat-observed"), `test-boot ${now - 600} ${changed}\n`);
  await writeFile(join(root, "now"), String(now)); await writeFile(join(root, "changed"), String(changed));
  await writeFile(log, ""); await writeFile(join(root, "updater-state/heartbeat"), "stale");
  await writeFile(join(root, "updater-state/known-good"), JSON.stringify({ schema: "control-room.known-good/v1", count: 2,
    pairs: ["A", "B"].map((releaseId, index) => ({ releaseId, pgDataId: index ? "pb" : "pa", schemaDigest: `sha256:${"a".repeat(64)}` })) }));
  await symlink("releases/B", join(root, "current")); await symlink("data-pb", join(root, "pg/current"));
  const run = (verb = "watch", options = {}) => execGuardV1("/bin/sh", ["-c", 'exec /bin/sh -p "$1" "$2" < /dev/null', "guard-test", "src/updater/v1/guard/guard.sh", verb], {
    timeout: 15000, env: { CONTROL_ROOM_GUARD_TESTING: "1", CONTROL_ROOM_GUARD_ROOT: root,
      CONTROL_ROOM_GUARD_TEST_BIN: bin, CONTROL_ROOM_GUARD_TEST_LABEL_PREFIX: "xyz.agentcontrolroom.rehearsal.hard6",
      CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1", CONTROL_ROOM_GUARD_ASSUME_YES: "1", ...options } });
  return { root, bin, log, run };
}

macGuardTest("F3-06 guard gives first load and reboot a bounded grace, then restarts a dead updater", async t => {
  const fixture = await guardFor(t); await unlink(join(fixture.root, "updater-state/heartbeat"));
  await fixture.run(); assert.equal(await readFile(fixture.log, "utf8"), "");
  await writeFile(join(fixture.root, "elapsed"), "1000181"); await fixture.run();
  assert.match(await readFile(fixture.log, "utf8"), /kickstart/u);
  const reboot = await guardFor(t);
  await reboot.run("watch", { CONTROL_ROOM_GUARD_TEST_BOOT_ID: "new-boot" });
  assert.equal(await readFile(reboot.log, "utf8"), "");
});

macGuardTest("F3-07 and F3-13 guard counter decays and future timestamps cannot wedge restart", async t => {
  const fixture = await guardFor(t); await fixture.run(); await fixture.run(); await fixture.run();
  await assert.rejects(fixture.run(), error => /restart_limit/u.test(error.stderr));
  await writeFile(join(fixture.root, "elapsed"), "1036000"); await writeFile(join(fixture.root, "now"), "1036000"); await writeFile(join(fixture.root, "changed"), "1035990"); await fixture.run();
  assert.equal(JSON.parse(await readFile(join(fixture.root, "updater-state/guard-status.json"), "utf8")).updaterRestartsLastHour, 0);
  await writeFile(join(fixture.root, "now"), "913600"); await fixture.run();
  assert.equal(JSON.parse(await readFile(join(fixture.root, "updater-state/guard-status.json"), "utf8")).updaterRestartsLastHour, 0, "wall corrections spend no restart allowance");
});

macGuardTest("F3-14 malformed selfupgrade evidence reports refusal and still restarts", async t => {
  const fixture = await guardFor(t); await writeFile(join(fixture.root, "updater-state/selfupgrade.json"), "{");
  await assert.rejects(fixture.run(), error => error.code === 1 && /malformed_state/u.test(error.stderr));
  assert.match(await readFile(fixture.log, "utf8"), /kickstart/u);
});

macGuardTest("F3-15 two-line rescue ids refuse before any service or link changes", async t => {
  const fixture = await guardFor(t), file = join(fixture.root, "updater-state/known-good");
  const known = JSON.parse(await readFile(file, "utf8")); for (const invalid of ["../../../escape\nok", "good\nbad", "a".repeat(81), "..", "", "."]) {
    known.pairs[0].releaseId = invalid; await writeFile(file, JSON.stringify(known));
    await assert.rejects(fixture.run("rescue"), error => /invalid_id/u.test(error.stderr));
  }
  assert.equal(await readlink(join(fixture.root, "current")), "releases/B"); assert.equal(await readFile(fixture.log, "utf8"), "");
});

macGuardTest("F3-16 an interrupted rescue resumes its recorded pair; EOF gives a reason", async t => {
  const fixture = await guardFor(t);
  await assert.rejects(fixture.run("rescue", { CONTROL_ROOM_GUARD_ASSUME_YES: "0" }), error => /owner_declined_data_loss/u.test(error.stderr));
  // Stop the real guard with an injected failing mv after the first link flip.
  const broken = join(fixture.bin, "guard-interrupted.sh");
  const source = await readFile("src/updater/v1/guard/guard.sh", "utf8");
  // This intentionally edited copy uses the source guard's worktree binding;
  // the root-prefix and canonical-root checks still run before fake commands.
  const interrupted = source.replace('atomic_link pg/current "data-$pg"', 'atomic_link pg/current "data-$pg"\n  exit 77')
    .replace('GUARD_SOURCE_DIR=$(cd "$(/usr/bin/dirname "$0")" && /bin/pwd -P)',
      'GUARD_SOURCE_DIR=$(cd "src/updater/v1/guard" && /bin/pwd -P)');
  await writeFile(broken, interrupted);
  await assert.rejects(execGuardV1("/bin/sh", ["-p", broken, "rescue"], { env: { CONTROL_ROOM_GUARD_TESTING: "1", CONTROL_ROOM_GUARD_ROOT: fixture.root,
    CONTROL_ROOM_GUARD_TEST_BIN: fixture.bin, CONTROL_ROOM_GUARD_TEST_LABEL_PREFIX: "xyz.agentcontrolroom.rehearsal.hard6", CONTROL_ROOM_GUARD_ASSUME_YES: "1" } }), error => error.code === 77);
  assert.equal(await readlink(join(fixture.root, "pg/current")), "data-pa");
  assert.equal(await readlink(join(fixture.root, "current")), "releases/B");
  await fixture.run("rescue");
  assert.equal(await readlink(join(fixture.root, "current")), "releases/A");
  assert.equal(await readlink(join(fixture.root, "pg/current")), "data-pa");
  const rescued = JSON.parse(await readFile(join(fixture.root, "updater-state/rescued.json"), "utf8"));
  assert.equal(rescued.from.pgDataId, "pb"); assert.equal(rescued.to.releaseId, "A");
});

macGuardTest("R6U-06: this fixture's product-shaped ownership rescues, and a root-owned pg/ is refused", async t => {
  // The SECOND fixture that would have caught the regression. `guardFor` builds a
  // different root, a different label prefix and a different heartbeat clock from
  // upddater-guard.test.mjs, and it carried the same `*/pg -> uid 0` answer, so
  // both had to be corrected or the old expectation would survive in whichever
  // file was not edited.
  const ok = await guardFor(t);
  await ok.run("rescue");
  assert.equal(await readlink(join(ok.root, "current")), "releases/A");
  assert.equal(await readlink(join(ok.root, "pg/current")), "data-pa");
  const wrong = await guardFor(t);
  await writeFile(join(wrong.bin, "stat"), `#!/bin/sh\n${guardStatStandInV1({
    overrides: [{ match: "*/pg", uid: "0", mode: "700" }] })}\n`, { mode: 0o700 });
  const refused = await wrong.run("rescue").catch(error => error);
  assert.match(refused.stderr, /rescue cannot continue: pg is owned by uid 0, but it must be owned by the database account/u);
  assert.equal(await readlink(join(wrong.root, "current")), "releases/B");
  assert.equal(await readFile(wrong.log, "utf8"), "", "no service is touched by a custody refusal");
});

test("F3-02 and F3-19 SIGKILL during key fsync releases the kernel lock and permits retry", async t => {
  const root = await rootFor(t), module = new URL("../src/updater/v1/journal.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {FileStepJournalV1} from ${JSON.stringify(module)};
    const journal=new FileStepJournalV1(process.argv[1], {checkpoint:async point=>{if(point==='key_before_rename'){process.stdout.write('ready\\n');await new Promise(()=>{});}}});
    await journal.intent({runId:'run-killed',ordinal:1,from:'approved',to:'prechecked',detail:{}});`, root],
  { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise(resolve => child.once("close", resolve)); let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("key_checkpoint_not_reached")), 5000);
      child.once("error", reject); child.stdout.once("data", resolve);
    });
    process.kill(-child.pid, "SIGKILL"); await closed;
    const journal = new FileStepJournalV1(root);
    await journal.intent({ runId: "run-retry", ordinal: 1, from: "approved", to: "prechecked", detail: {} });
    await journal.validate();
  } finally {
    clearTimeout(timer);
    if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    await closed;
  }
});

test("F3-19 local kernel lock refuses unsafe files and releases after a failed start", async t => {
  const { acquireUpdaterLocalLockV1 } = await import("../src/updater/v1/fs-safety.mjs");
  const { chmod, link } = await import("node:fs/promises");
  const { default: childProcess } = await import("node:child_process"), { syncBuiltinESMExports } = await import("node:module");
  const root = await rootFor(t), path = join(root, "updater-state/updater.lock");
  for (const plant of [async () => { await exec("/usr/bin/mkfifo", [path]); await chmod(path, 0o600); }, () => mkdir(path), () => symlink("/dev/null", path),
    async () => { await writeFile(path, ""); await chmod(path, 0o644); },
    async () => { await writeFile(path, "", { mode: 0o600 }); await link(path, path + ".extra"); }]) {
    await plant(); const originalSpawn = childProcess.spawn; let spawned = 0;
    childProcess.spawn = (...args) => { spawned++; return originalSpawn(...args); }; syncBuiltinESMExports();
    try {
      await assert.rejects(acquireUpdaterLocalLockV1(root, "updater-state/updater.lock").then(async release => { await release(); }), /refused/u);
      assert.equal(spawned, 0, "unsafe lock custody must refuse before launching its helper");
    } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
    await rm(path, { recursive: true, force: true }); await rm(path + ".extra", { force: true });
  }
  await writeFile(path, "", { mode: 0o600 }); const getuid = process.getuid;
  try { process.getuid = () => getuid() + 1;
    await assert.rejects(acquireUpdaterLocalLockV1(root, "updater-state/updater.lock").then(async release => { await release(); }), /updater_local_lock_refused/u);
  } finally { process.getuid = getuid; }
  // R4S-13: a bad switch used to throw out of the tick, which stopped Stop, Pause and backup-now
  // from being handled and published no status at all. It is now treated as Off, so the
  // risk-reducing requests still run and the status says it needs attention.
  await writeFile(join(root, "updater-state/self-update"), "wrong");
  const damaged = await start(root); await damaged.stop();
  assert.equal(JSON.parse(await readFile(join(root, "status/status.json"), "utf8")).selfUpdate, "Off");
  await writeFile(join(root, "updater-state/self-update"), "On\n");
  const updater = await start(root); await updater.stop();
});

macGuardTest("F3-13 twenty concurrent guard callers cannot exceed the restart limit", async t => {
  const fixture = await guardFor(t);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => fixture.run()));
  assert.ok(results.some(row => row.status === "fulfilled"));
  const calls = (await readFile(fixture.log, "utf8")).trim().split("\n");
  assert.ok(calls.length >= 1 && calls.length <= 3);
  for (const row of results.filter(row => row.status === "rejected"))
    assert.ok(row.reason.code === 75 || /restart_limit/u.test(row.reason.stderr));
});

macGuardTest("F3-16 an invalid recorded rescue target refuses before stopping services", async t => {
  const fixture = await guardFor(t), file = join(fixture.root, "updater-state/rescue-intent.json");
  const intent = { schema: "control-room.rescue-intent/v1",
    from: { releaseId: "B", pgDataId: "pb", schemaDigest: `sha256:${"a".repeat(64)}` },
    to: { releaseId: "missing", pgDataId: "pa", schemaDigest: `sha256:${"a".repeat(64)}` } };
  await writeFile(file, JSON.stringify(intent));
  await assert.rejects(fixture.run("rescue"), error => /invalid_rescue_intent/u.test(error.stderr));
  intent.to.releaseId = "A"; intent.schema = "wrong"; await writeFile(file, JSON.stringify(intent));
  await assert.rejects(fixture.run("rescue"), error => /invalid_rescue_intent/u.test(error.stderr));
  assert.equal(await readFile(fixture.log, "utf8"), "");
});

test("F3-01 invalid ordinals cannot be appended", async t => {
  const root = await rootFor(t), journal = new FileStepJournalV1(root);
  for (const ordinal of [0, -1, "1", 1.5]) {
    await assert.rejects(journal.intent({ runId: "run-one", ordinal, from: "approved", to: "prechecked", detail: {} }), /updater_journal_ordinal_refused/u);
    assert.equal((await journal.validate()).entries.length, 0);
  }
  for (const runId of [null, 7]) {
    await assert.rejects(journal.intent({ runId, ordinal: 1, from: "approved", to: "prechecked", detail: {} }), /updater_journal_ordinal_refused/u);
    assert.equal((await journal.validate()).entries.length, 0);
  }
});

test("F3-11 even a broken watcher error reporter cannot stop the runner", async () => {
  let runs = 0;
  const loop = new UpdaterMainLoopV1({ stateFiles: { readSelfUpdate: async () => "On", hasRescueMarker: async () => false, writeStatus: async () => {} },
    store: memoryStore(), mode: new UpdaterModeV1(), ownerActions: {}, runner: { async runOnce() { runs++; return { status: "idle" }; } },
    watcher: { async tick() { throw new Error("offline"); } }, onError: () => { throw new Error("logging failed"); } });
  assert.equal((await loop.tick()).status, "idle"); assert.equal(runs, 1);
});

test("F3-18 composed stop closes control despite a hung heartbeat and lease release", async t => {
  const root = await rootFor(t), store = memoryStore(); let hang = false;
  const pending = [];
  store.heartbeat = async () => { if (hang) await new Promise(resolve => pending.push(resolve)); };
  store.release = () => new Promise(resolve => pending.push(resolve));
  const updater = await start(root, { store, onTimerError() {} });
  hang = true; void updater.heartbeat.beat(); await sleep(10);
  try {
    assert.equal(await Promise.race([updater.stop().then(() => "stopped"), sleep(3000).then(() => "hung")]), "stopped");
    await assert.rejects(sendControlRequestV1(join(root, "updater-state/control.sock"), request("pause")), error => error.code === "ENOENT");
    const retry = await start(root); await retry.stop();
  } finally { for (const resolve of pending) resolve(); await updater.stop(); }
});

test("F3-18 failed startup releases its local lock despite a hung store release", async t => {
  const root = await rootFor(t), store = memoryStore(); let release;
  store.release = () => new Promise(resolve => { release = resolve; });
  // A damaged switch is NO LONGER a startup failure (R4S-13), so this needs a failure it is
  // actually about. `mode.json` is read by the loop on EVERY start (the store is injected here,
  // so the database configuration is not read at all), so an unreadable one refuses the tick.
  const mode = join(root, "updater-state/mode.json");
  await writeFile(mode, JSON.stringify({ schema: "control-room.updater-mode/v1", mode: "sideways" }));
  try {
    const result = await Promise.race([start(root, { store }).then(() => "accepted", error => error.code), sleep(3000).then(() => "hung")]);
    assert.equal(result, "updater_mode_state_refused");
    await rm(mode);
    const retry = await start(root); await retry.stop();
  } finally { release?.(); }
});

test("F3-11 command output bounds refuse oversized git and classifier replies", async t => {
  const root = await rootFor(t), fake = join(root, "fake-command");
  await writeFile(fake, "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(2*1024*1024));\n", { mode: 0o700 });
  const source = new GitMirrorSourceV1({ root, origin: "https://example.invalid/repo", fromCommit: "a".repeat(40), testing: true, git: fake, commandTimeoutMs: 5000 });
  await assert.rejects(source.fetchMain(), error => error.code === "watcher_mirror_refused");
  await writeFile(fake, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({classes:['code'],payload:'x'.repeat(3*1024*1024)}));\n", { mode: 0o700 });
  const classifier = new RefereeGitClassifierV1({ node: fake, commandTimeoutMs: 5000 });
  await assert.rejects(classifier.classify({ repository: root, fromCommit: "a".repeat(40), candidateCommit: "b".repeat(40) }), error => error.code === "watcher_classification_refused");
});

test("F3-11 group-signal refusal falls back to the owned child handle", async t => {
  const root = await rootFor(t), fake = join(root, "fake-command");
  await writeFile(fake, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
  const source = new GitMirrorSourceV1({ root, origin: "https://example.invalid/repo", fromCommit: "a".repeat(40), testing: true, git: fake, commandTimeoutMs: 80 });
  const original = process.kill;
  process.kill = () => { throw Object.assign(new Error("group signal refused"), { code: "EPERM" }); };
  try { await assert.rejects(source.fetchMain(), error => error.code === "watcher_mirror_refused"); }
  finally { process.kill = original; }
});

// R4S-13: a damaged or missing self-update switch stopped the updater handling Stop/Pause/backup
// requests and publishing status — the tick threw before any owner request ran. An unreadable
// switch must count as Off (the safe direction: it cannot start an update), the tick must
// continue, and the status must say it needs attention.
test("R4S-13 a damaged self-update switch counts as Off and the loop keeps serving the owner", async t => {
  for (const [name, bytes] of Object.entries({
    empty: "", torn: "Of", garbage: "maybe\n", oversized: "Off" + " ".repeat(20) + "\n",
    lowerCase: "on\n", upperCase: "ON\n", byteOrderMark: "﻿On\n", padded: " On \r\n",
    nonBreakingSpace: " On \n", twoNewlines: "On\n\n",
  })) {
    const root = await rootFor(t);
    await writeFile(join(root, "updater-state/self-update"), bytes);
    let handled = 0, runnerCalls = 0, watcherCalls = 0;
    const stateFiles = new UpdaterStateFilesV1(root, "lease-probe");
    const loop = new UpdaterMainLoopV1({
      stateFiles, mode: new UpdaterModeV1({ read: async () => "running" }),
      store: { unhandledOwnerRequests: async () => [{ id: 1, request_kind: "stop" }],
        finishOwnerRequest: async () => {} },
      ownerActions: { handle: async () => { handled += 1; } },
      watcher: { tick: async () => { watcherCalls += 1; return { status: "idle" }; } },
      runner: { runOnce: async () => { runnerCalls += 1; return { status: "idle" }; } },
    });
    const outcome = await loop.tick();
    const status = JSON.parse(await readFile(join(root, "status/status.json"), "utf8"));
    // The risk-reducing request ran, the status was published, and nothing that could change
    // the Mac was invoked.
    assert.equal(handled, 1, `${name}: the queued stop must still be handled`);
    assert.equal(runnerCalls, 0, `${name}: a damaged switch never runs an update`);
    assert.equal(watcherCalls, 0, `${name}: a damaged switch never watches sources`);
    assert.equal(status.selfUpdate, "Off", `${name}: an unreadable switch is Off`);
    assert.equal(status.needsYou, true, `${name}: the owner must be told it needs attention`);
    assert.match(outcome.message, /could not be read|being treated as Off/u, name);
    // The published status carries no path, no newline and no control byte.
    assert.doesNotMatch(outcome.message, /[\u0000-\u001f\u007f-\u009f/\\]/u, name);
  }
  // A healthy Off switch must NOT claim it needs attention: that is the case every Mac is in.
  const root = await rootFor(t);
  await writeFile(join(root, "updater-state/self-update"), "Off\n");
  const clean = new UpdaterMainLoopV1({
    stateFiles: new UpdaterStateFilesV1(root, "lease-probe"), mode: new UpdaterModeV1({ read: async () => "running" }),
    store: { unhandledOwnerRequests: async () => [], finishOwnerRequest: async () => {} },
    ownerActions: { handle: async () => {} }, runner: { runOnce: async () => ({ status: "idle" }) },
  });
  assert.equal((await clean.tick()).message, "Self-update is Off.");
  assert.equal(JSON.parse(await readFile(join(root, "status/status.json"), "utf8")).needsYou, false);
  // A healthy On switch is still On and still runs the runner, so the fix did not turn every
  // self-update off by accident.
  await writeFile(join(root, "updater-state/self-update"), "On\n");
  let ran = 0;
  const on = new UpdaterMainLoopV1({
    stateFiles: new UpdaterStateFilesV1(root, "lease-probe"), mode: new UpdaterModeV1({ read: async () => "running" }),
    store: { unhandledOwnerRequests: async () => [], finishOwnerRequest: async () => {} },
    ownerActions: { handle: async () => {} }, runner: { runOnce: async () => { ran += 1; return { status: "idle" }; } },
  });
  await on.tick();
  assert.equal(ran, 1, "an exact On switch still runs the runner");
  assert.equal(JSON.parse(await readFile(join(root, "status/status.json"), "utf8")).selfUpdate, "On");
});

test("R4S-13 a damaged switch refuses a non-risk-reducing request rather than running it", async t => {
  const root = await rootFor(t);
  await writeFile(join(root, "updater-state/self-update"), "Of");
  const finished = [];
  const loop = new UpdaterMainLoopV1({
    stateFiles: new UpdaterStateFilesV1(root, "lease-probe"), mode: new UpdaterModeV1({ read: async () => "running" }),
    store: { unhandledOwnerRequests: async () => finished.length ? []
        : [{ id: 1, request_kind: "rollback" }, { id: 2, request_kind: "backup_now" }],
      finishOwnerRequest: async (id, outcome) => { finished.push([id, outcome]); } },
    ownerActions: { handle: async () => { handled.push(1); } }, runner: { runOnce: async () => ({ status: "idle" }) },
  });
  const handled = [];
  await loop.tick();
  // rollback is not risk-reducing, so being treated as Off refuses it; backup_now is, so it runs.
  assert.deepEqual(finished, [[1, "refused"], [2, "acted"]], "Off gating still applies to a damaged switch");
  assert.equal(handled.length, 1, "only the risk-reducing request reached the action");
});

test("int11: the owner's acknowledgement runs while self-update is Off; an update request still does not", async t => {
  const root = await rootFor(t);
  await writeFile(join(root, "updater-state/self-update"), "Off");
  const finished = [];
  const handled = [];
  const loop = new UpdaterMainLoopV1({
    stateFiles: new UpdaterStateFilesV1(root, "lease-probe"), mode: new UpdaterModeV1({ read: async () => "running" }),
    store: { unhandledOwnerRequests: async () => finished.length ? []
        : [{ id: 1, request_kind: "acknowledge_attention" }, { id: 2, request_kind: "rollback" }],
      finishOwnerRequest: async (id, outcome) => { finished.push([id, outcome]); } },
    ownerActions: { handle: async request => { handled.push(request.request_kind); } }, runner: { runOnce: async () => ({ status: "idle" }) },
  });
  await loop.tick();
  assert.deepEqual(finished, [[1, "acted"], [2, "refused"]], "acknowledging is allowed while Off; rollback is not");
  assert.deepEqual(handled, ["acknowledge_attention"]);
});
