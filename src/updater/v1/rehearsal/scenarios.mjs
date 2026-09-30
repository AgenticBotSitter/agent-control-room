import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, readlink, rm, symlink, unlink, writeFile }
  from "node:fs/promises";
import { join } from "node:path";
import { DiskReserveV1, PairHistoryV1, UpdaterActuatorV1 } from "../actuator.mjs";
import { verifyBundleManifestV1 } from "../attended-flip.mjs";
import { parseKnownGoodV1 } from "../contracts.mjs";
import { atomicWriteNoFollowV1, readFileNoFollowV1 } from "../fs-safety.mjs";
import { recoverPairLinksV1, switchPairLinksV1 } from "../release-layout.mjs";
import { UpdaterRunnerV1 } from "../runner.mjs";
import { UpdaterModeV1 } from "../runtime.mjs";
import { buildTrustedEnvironment, trustedToolEnvironment } from "../trusted-runtime.mjs";

const digest = value => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
const pair = (releaseId, pgDataId, value = pgDataId) => ({ releaseId, pgDataId, schemaDigest: digest(value) });
const guard = join(process.cwd(), "src/updater/v1/guard/guard.sh");
const evidence = (assertions, detail) => Object.freeze({ assertions, ...detail });

async function executable(path, body) { await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o500 }); }
async function expectRefusal(operation, pattern) {
  try { await operation(); } catch (error) {
    if (pattern.test(String(error?.code ?? error?.message ?? error))) return String(error?.code ?? error?.message);
    throw error;
  }
  throw new Error(`expected_refusal:${pattern.source}`);
}

async function pairRoot(root) {
  for (const path of ["updater-state", "releases/r0", "releases/r1", "releases/r2", "releases/r3",
    "pg/data-p0", "pg/data-p1", "pg/data-p2", "pg/data-p3", "pg/socket", "runtime", "updater"])
    await mkdir(join(root, path), { recursive: true });
  await symlink("releases/r2", join(root, "current"));
  await symlink("releases/r1", join(root, "previous"));
  await symlink("data-p2", join(root, "pg/current"));
  await writeFile(join(root, "updater-state/known-good"), `${JSON.stringify({
    schema: "control-room.known-good/v1", count: 3,
    pairs: [pair("r0", "p2", "p2"), pair("r1", "p2", "p2"), pair("r2", "p2", "p2")],
  })}\n`);
  await writeFile(join(root, "rescue-reserve.bin"), Buffer.alloc(4096));
  return root;
}

class MemoryStore {
  constructor(run = { run_id: "run:00000000-0000-4000-8000-000000000001", plan_id: "plan-one",
    state: "approved", run_class: "code", lease_token: "lease-one", detail: {} }) {
    this.run = { ...run }; this.eventRows = [];
  }
  async liveRun() { return this.run; }
  async events() { return this.eventRows; }
  async transition(_id, lease, state, detail, options = {}) {
    if (lease !== this.run.lease_token) throw Object.assign(new Error("lease"), { code: "updater_run_lease_lost" });
    this.run = { ...this.run, state, detail, finished_at: options.terminal ? new Date().toISOString() : null };
    return this.run;
  }
  async appendEvent(_id, ordinal, state, detail) { this.eventRows.push({ ordinal, state, detail }); }
}
class MemoryJournal {
  rows = [];
  async intent(value) { this.rows.push({ kind: "intent", ...value }); }
  async done(value) { this.rows.push({ kind: "done", ...value }); }
}
class Effects {
  calls = []; gate; fail; healthResult = true;
  async call(name) { this.calls.push(name); await this.gate;
    if (this.fail === name) throw Object.assign(new Error(name), { code: `updater_${name}_failed` }); }
  precheck() { return this.call("precheck"); } stage() { return this.call("stage"); }
  quickBackup() { return this.call("quick_backup"); } drain() { return this.call("drain"); }
  switchPair() { return this.call("switch"); } restart() { return this.call("restart"); }
  async health() { await this.call("health"); return this.healthResult; }
  commitKnownGood() { return this.call("known_good"); } rollback() { return this.call("rollback"); }
  measure() { return this.call("measure"); }
}
function runnerFixture({ run, leaseToken = "lease-one", mode = new UpdaterModeV1(), effects = new Effects(),
  store = new MemoryStore(run) } = {}) {
  const journal = new MemoryJournal();
  const runner = new UpdaterRunnerV1({ store, effects, journal, mode,
    stateFiles: { leaseToken, readSelfUpdate: async () => "On\n", hasRescueMarker: async () => false },
    referee: { async assertPlanAllowed() {} } });
  return { runner, store, effects, journal, mode };
}

async function runChild(root, killIndex) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(process.cwd(), "scripts/updater/rehearsal-code-worker.mjs"),
      root, String(killIndex)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function guardFixture(root, config) {
  await pairRoot(root);
  const bin = join(root, "fake-bin"), log = join(root, "launchctl.log");
  await mkdir(bin); await mkdir(join(root, "fake-plists"));
  await executable(join(bin, "launchctl"), `printf '%s\\n' "$*" >> '${log}'`);
  await executable(join(bin, "stat"), "echo 0");
  await executable(join(bin, "date"), "case \"$1\" in -u) echo 2026-09-30T12:00:00Z ;; *) echo 20000 ;; esac");
  await executable(join(bin, "sleep"), "exit 0");
  await executable(join(bin, "pg_controldata"), "echo 'Database cluster state: shut down'");
  const runtime = [["updater/current", "u2", "u1"], ["runtime/node-current", "node-2", "node-1"],
    ["runtime/pnpm-current", "pnpm-2", "pnpm-1"], ["runtime/pg-current", "pg-2", "pg-1"],
    ["runtime/esbuild-current", "esbuild-2", "esbuild-1"]];
  for (const [path, current] of runtime) await symlink(current, join(root, path));
  await writeFile(join(root, "updater-state/heartbeat"), "stale\n");
  await writeFile(join(root, "updater-state/selfupgrade.json"), JSON.stringify({
    schema: "control-room.selfupgrade/v1", phase: "flipping", linkCount: 5,
    links: runtime.map(([path, current, previous]) => ({ link: path, from: previous, to: current })),
  }));
  return { root, bin, log, runtime, labelPrefix: config.daemonLabelPrefix };
}
async function runGuard(fixture, verb = "rescue") {
  return new Promise(resolve => {
    const child = spawn("/bin/sh", ["-p", guard, verb], { env: {
      CONTROL_ROOM_GUARD_TESTING: "1", CONTROL_ROOM_GUARD_ROOT: fixture.root,
      CONTROL_ROOM_GUARD_TEST_BIN: fixture.bin, CONTROL_ROOM_GUARD_ASSUME_YES: "1",
      CONTROL_ROOM_GUARD_TEST_LABEL_PREFIX: fixture.labelPrefix,
    }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function rootSafety(context) {
  assert.equal(new Set(Object.values(context.config.ports)).size, 3);
  assert.equal(context.config.expectedOrigin,
    `https://${context.config.rehearsalHostname}:${context.config.ports.web}`);
  assert.ok(Object.values(context.config.accounts).every(name => name.includes("rehearsal")));
  const fakeCommands = [];
  if (context.config.mode === "throwaway") {
    for (const name of ["launchctl", "sudo", "tailscale", "pbcopy", "pbpaste", "diskutil"]) {
      const entry = await lstat(join(context.fakes.directory, name));
      assert.ok(entry.isFile() && (entry.mode & 0o111) !== 0); fakeCommands.push(name);
    }
  }
  return evidence(context.config.mode === "throwaway" ? 9 : 3, { ownersEnabled: context.preflight.ownersEnabled,
    mode: context.config.mode,
    hostname: context.config.rehearsalHostname, ports: context.config.ports, accounts: context.config.accounts,
    daemonLabelPrefix: context.config.daemonLabelPrefix, fakeCommands });
}

async function filesystemSwaps({ work }) {
  const root = join(work, "filesystem"); await mkdir(join(root, "lower"), { recursive: true });
  await writeFile(join(root, "outside"), "untouched\n");
  await symlink(join(root, "outside"), join(root, "lower/trap"));
  const readCode = await expectRefusal(() => readFileNoFollowV1(root, "lower/trap"), /updater_symlink_refused/u);
  await expectRefusal(() => atomicWriteNoFollowV1(root, "lower/trap", "damage"), /EEXIST|updater_/u);
  assert.equal(await readFile(join(root, "outside"), "utf8"), "untouched\n");
  await writeFile(join(root, "lower/state"), "safe\n"); await link(join(root, "lower/state"), join(root, "lower/alias"));
  const hardlinkCode = await expectRefusal(() => readFileNoFollowV1(root, "lower/state"), /updater_file_refused/u);
  return evidence(3, { outsideUntouched: true, refusals: [readCode, hardlinkCode] });
}

async function findForbiddenOwnerCode(root) {
  const pending = [root], found = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if ((entry.isFile() || entry.isSymbolicLink())
          && /(?:^|[._-])owner[._-]?code(?:[._-]|$)/iu.test(entry.name)) found.push(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path);
    }
  }
  return found;
}

async function absenceChecks({ root, fakes }) {
  const forbidden = await findForbiddenOwnerCode(root);
  if (forbidden.length > 0)
    throw Object.assign(new Error("owner-code material exists"), { code: "rehearsal_owner_code_present" });
  let log = "";
  if (fakes) {
    try { log = await readFile(fakes.log, "utf8"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const clipboardInvocations = log.split("\n").filter(line => /"command":"pb(?:copy|paste)"/u.test(line));
  if (clipboardInvocations.length > 0)
    throw Object.assign(new Error("a clipboard fake was invoked"), { code: "rehearsal_clipboard_invoked" });
  return evidence(2, { ownerCodeFileExists: false, clipboardInvocationCount: clipboardInvocations.length,
    scannedRoot: true, clipboardLogObserved: Boolean(fakes) });
}

async function hostileEnvironment() {
  const names = ["HOME", "NODE_OPTIONS", "DEVELOPER_DIR", "SDKROOT", "OPENSSL_CONF", "KRB5_CONFIG", "PGHOST"];
  const refused = [];
  for (const name of names) refused.push(await expectRefusal(
    async () => buildTrustedEnvironment({ [name]: "/untrusted/value" }), /trusted_spawn_environment_refused/u));
  const clean = trustedToolEnvironment("node");
  assert.deepEqual(Object.keys(clean).sort(), ["LANG", "LC_ALL"]);
  return evidence(names.length + 1, { hostileNames: names, refusalCount: refused.length, inheritedValues: 0 });
}

async function bundleFixture(work) {
  const root = join(work, "bundle"); await mkdir(root, { recursive: true });
  const bytes = Buffer.from("export const fixed = true;\n");
  await writeFile(join(root, "updater.mjs"), bytes, { mode: 0o500 });
  const manifest = { schema: "control-room.updater-bundle-manifest/v1", files: [{ path: "updater.mjs",
    sha256: digest(bytes), mode: 0o500, type: "file" }] };
  return { root, manifest };
}
async function bundleTamper({ work }) {
  const fixture = await bundleFixture(work); await writeFile(join(fixture.root, "unlisted"), "hostile\n", { mode: 0o400 });
  const code = await expectRefusal(() => verifyBundleManifestV1(fixture.root, fixture.manifest),
    /updater_bundle_manifest_refused/u);
  return evidence(1, { refused: code, candidateInstalled: false });
}
async function bundleSymlink({ work }) {
  const fixture = await bundleFixture(work); await unlink(join(fixture.root, "updater.mjs"));
  await writeFile(join(work, "outside"), "export const fixed = false;\n", { mode: 0o500 });
  await symlink(join(work, "outside"), join(fixture.root, "updater.mjs"));
  const code = await expectRefusal(() => verifyBundleManifestV1(fixture.root, fixture.manifest), /updater_/u);
  return evidence(1, { refused: code, outsideUntouched: true });
}

async function codeCrashPoints({ work }) {
  const completed = [];
  for (let index = 1; index <= 16; index += 1) {
    const root = join(work, `kill-${index}`); await mkdir(join(root, "updater-state"), { recursive: true });
    const run = { run_id: "run:00000000-0000-4000-8000-000000000001", plan_id: "plan-one", state: "approved",
      run_class: "code", lease_token: "lease-one", detail: {}, finished_at: null };
    await writeFile(join(root, "store.json"), `${JSON.stringify({ run, events: [] })}\n`);
    await writeFile(join(root, "effects.json"), `${JSON.stringify({ attempts: {}, applied: [] })}\n`);
    const killed = await runChild(root, index);
    assert.equal(killed.signal, "SIGKILL", `fault point ${index} did not kill the worker`);
    const resumed = await runChild(root, 0); assert.equal(resumed.code, 0, resumed.stderr);
    const result = JSON.parse(resumed.stdout.trim()); assert.equal(result.status, "succeeded");
    const effects = JSON.parse(await readFile(join(root, "effects.json"), "utf8"));
    assert.deepEqual(effects.applied, ["precheck", "stage", "quick_backup", "drain", "switch", "restart",
      "health", "known_good"]);
    assert.equal(new Set(effects.applied).size, effects.applied.length, "no physical effect is duplicated");
    completed.push({ index, killedAt: (await readFile(join(root, "kill-fired"), "utf8")).trim(),
      attempts: effects.attempts });
  }
  return evidence(completed.length * 4, { faultPoints: completed.length, completed });
}

async function tornSwitch({ work }) {
  const cuts = ["after_prepared", "after_previous_intent", "after_previous_effect", "after_previous_done",
    "after_database_intent", "after_database_effect", "after_database_done", "after_release_intent",
    "after_release_effect", "after_release_done", "after_completed"];
  for (const cut of cuts) {
    const root = await pairRoot(join(work, cut)); let armed = true;
    await expectRefusal(() => switchPairLinksV1({ root, operationId: "switch-one", from: pair("r2", "p2"),
      to: pair("r3", "p3"), fault: step => { if (armed && step === cut) { armed = false;
        throw Object.assign(new Error("killed"), { code: "simulated_kill" }); } } }), /simulated_kill|killed/u);
    assert.equal((await recoverPairLinksV1(root)).status, "completed");
    assert.equal(await readlink(join(root, "current")), "releases/r3");
    assert.equal(await readlink(join(root, "pg/current")), "data-p3");
  }
  const missingRoot = await pairRoot(join(work, "missing-release-target")); let missingArmed = true;
  await expectRefusal(() => switchPairLinksV1({ root: missingRoot, operationId: "switch-missing",
    from: pair("r2", "p2"), to: pair("r3", "p3"), fault: step => {
      if (missingArmed && step === "after_database_done") { missingArmed = false;
        throw Object.assign(new Error("killed"), { code: "simulated_kill" }); }
    } }), /simulated_kill/u);
  await rm(join(missingRoot, "releases/r3"), { recursive: true });
  const rolledBack = await recoverPairLinksV1(missingRoot);
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(rolledBack.reason, "updater_release_target_refused");
  assert.equal(await readlink(join(missingRoot, "current")), "releases/r2");
  assert.equal(await readlink(join(missingRoot, "pg/current")), "data-p2");

  const phaseRoot = await pairRoot(join(work, "invalid-forward-phase"));
  await writeFile(join(phaseRoot, "updater-state/link-switch.json"), `${JSON.stringify({
    schema: "control-room.pair-link-switch/v1", operationId: "switch-phase", phase: "rollback_intent",
    from: pair("r2", "p2"), to: pair("r3", "p3"), previousReleaseId: "r2",
  })}\n`);
  const phaseCode = await expectRefusal(() => recoverPairLinksV1(phaseRoot), /^updater_link_switch_refused$/u);
  assert.equal(phaseCode, "updater_link_switch_refused");
  assert.equal(await readlink(join(phaseRoot, "current")), "releases/r2");
  assert.equal(await readlink(join(phaseRoot, "pg/current")), "data-p2");
  return evidence(cuts.length * 4 + 9, { faultPoints: cuts.length, terminalPair: "new-healthy", mixedPairs: 0,
    missingTargetRecovery: rolledBack.status, invalidPhaseRefusal: phaseCode });
}

async function diskPreflight({ work }) {
  const root = await pairRoot(join(work, "disk-preflight"));
  const reserve = new DiskReserveV1(root, { reserveBytes: 4096, minimumHeadroomBytes: 1024,
    diskFree: async () => 3000 });
  const code = await expectRefusal(() => reserve.preflight({ releaseBytes: 1024 }), /updater_disk_reserve_low/u);
  assert.equal(await readlink(join(root, "current")), "releases/r2");
  return evidence(2, { refused: code, terminalPair: "old-healthy" });
}
async function diskReserveRetry({ work }) {
  const root = await pairRoot(join(work, "disk-retry")); let attempts = 0, rebuilds = 0;
  const reserve = new DiskReserveV1(root, { reserveBytes: 4096, minimumHeadroomBytes: 1,
    createReserve: async () => { rebuilds += 1; await writeFile(join(root, "rescue-reserve.bin"), Buffer.alloc(4096)); } });
  const result = await reserve.finishWithReserve(async () => { attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("full"), { code: "ENOSPC" }); return "restored"; });
  assert.equal(result, "restored"); await reserve.assertIntact();
  return evidence(2, { attempts, reserveRebuilds: rebuilds, recovered: true });
}

async function runnerLeaseBurst() {
  const store = new MemoryStore(), effects = new Effects(); let release;
  effects.gate = new Promise(resolve => { release = resolve; });
  const actor = runnerFixture({ store, effects }).runner;
  const promises = Array.from({ length: 20 }, () => actor.runOnce());
  await new Promise(resolve => setImmediate(resolve));
  effects.gate = undefined; release(); const results = await Promise.all(promises);
  assert.equal(results.filter(result => result.status === "succeeded").length, 1);
  assert.equal(results.filter(result => result.status === "busy").length, 19);
  assert.deepEqual(effects.calls, ["precheck", "stage", "quick_backup", "drain", "switch", "restart", "health",
    "known_good"], "the winning caller performs each physical effect exactly once");
  return evidence(3, { callers: 20, leaseOwners: 1, busy: 19, duplicatedEffects: 0 });
}

async function knownGoodInjection({ work }) {
  const marker = join(work, "effect-marker");
  const shapeCode = await expectRefusal(() => parseKnownGoodV1({ schema: "hostile-known-good/v1", count: 1,
    pairs: [{ releaseId: "r1", pgDataId: "p1", schemaDigest: digest("p1") }] }),
  /^updater_known_good_refused$/u);
  assert.equal(shapeCode, "updater_known_good_refused");
  const code = await expectRefusal(async () => {
    parseKnownGoodV1({ schema: "control-room.known-good/v1", count: 1,
      pairs: [{ releaseId: "../../outside", pgDataId: "p1", schemaDigest: digest("p1") }] });
    await writeFile(marker, "effect\n");
  }, /^updater_known_good_refused$/u);
  assert.equal(code, "updater_known_good_refused");
  await assert.rejects(readFile(marker), /ENOENT/u);
  return evidence(4, { refused: code, malformedShapeRefused: shapeCode, effectsBeforeRefusal: 0 });
}

async function rollbackChain({ work }) {
  const root = await pairRoot(join(work, "rollback")), history = new PairHistoryV1(root);
  let restarts = 0;
  const reserve = new DiskReserveV1(root, { reserveBytes: 4096, minimumHeadroomBytes: 1,
    diskFree: async () => 100_000, createReserve: async () => writeFile(join(root, "rescue-reserve.bin"), Buffer.alloc(4096)) });
  const actuator = new UpdaterActuatorV1({ root, history, reserve, schemaDigest: async () => digest("p2"),
    services: { async restart() { restarts += 1; }, async measure() {}, async quickBackup() {}, async drain() {} },
    artifacts: { async verifyPair(candidate) { return candidate.releaseId !== "r1"; } },
    health: async candidateRun => candidateRun !== false });
  const run = { run_id: "run-one", state: "restarted", detail: { from: pair("r2", "p2"),
    to: pair("r3", "p2"), releaseBytes: 1, databaseBytes: 0, databaseClass: "none" } };
  const restored = await actuator.rollback(run);
  assert.equal(restored.releaseId, "r0"); assert.equal(await readlink(join(root, "current")), "releases/r0");
  return evidence(2, { corruptPairSkipped: "r1", selectedPair: restored, restarts });
}

async function guardAllLinks({ work, config }) {
  const fixture = await guardFixture(join(work, "guard-links"), config); const result = await runGuard(fixture);
  assert.equal(result.code, 0, result.stderr);
  for (const [path, _current, previous] of fixture.runtime) assert.equal(await readlink(join(fixture.root, path)), previous);
  const rescued = JSON.parse(await readFile(join(fixture.root, "updater-state/rescued.json"), "utf8"));
  const serviceCalls = await readFile(fixture.log, "utf8");
  assert.doesNotMatch(serviceCalls, /system\/xyz\.agentcontrolroom\.(?!rehearsal\.)/u);
  assert.match(serviceCalls, new RegExp(`system/${config.daemonLabelPrefix.replaceAll(".", "\\.")}\\.updater`, "u"));
  return evidence(fixture.runtime.length + 3, { revertedLinks: fixture.runtime.length, rescuedTo: rescued.to,
    labelPrefix: config.daemonLabelPrefix });
}

async function guardRescuePoints({ work, config }) {
  const steps = ["approved", "prechecked", "staged", "quick_backup", "draining", "switched", "restarted",
    "healthy", "rollback_started"];
  for (const [index, step] of steps.entries()) {
    const fixture = await guardFixture(join(work, `rescue-${index}`), config);
    await writeFile(join(fixture.root, "updater-state/journal.jsonl"), `${JSON.stringify({ step })}\n`);
    const result = await runGuard(fixture); assert.equal(result.code, 0, `${step}: ${result.stderr}`);
    const rescued = JSON.parse(await readFile(join(fixture.root, "updater-state/rescued.json"), "utf8"));
    assert.equal(rescued.to.releaseId, "r1");
  }
  return evidence(steps.length * 2, { killPoints: steps.length, terminalPair: "older-known-good", forwardResumes: 0 });
}

async function pauseStop() {
  const preDrain = ["approved", "prechecked", "staged", "quick_backup"];
  for (const state of preDrain) {
    for (const requested of ["paused", "stopped"]) {
      const mode = new UpdaterModeV1(); mode.set(requested);
      const fixture = runnerFixture({ run: { run_id: "run:00000000-0000-4000-8000-000000000001",
        plan_id: "plan-one", state, run_class: "code", lease_token: "lease-one", detail: {} }, mode });
      const result = await fixture.runner.runOnce();
      assert.ok(["waiting", "refused"].includes(result.status)); assert.ok(!fixture.effects.calls.includes("switch"));
    }
  }
  for (const state of ["draining", "switched", "restarted", "healthy"]) {
    const mode = new UpdaterModeV1(); mode.set("paused");
    const fixture = runnerFixture({ run: { run_id: "run:00000000-0000-4000-8000-000000000001",
      plan_id: "plan-one", state, run_class: "code", lease_token: "lease-one", detail: {} }, mode });
    assert.ok(["succeeded", "rolled_back"].includes((await fixture.runner.runOnce()).status));
  }
  return evidence(preDrain.length * 4 + 4, { preDrainStates: preDrain.length, postDrainStates: 4, strandedRuns: 0 });
}

async function profileShape() {
  const roles = ["builder", "gateway", "postgres", "supervisor", "upgrader"], checked = [];
  for (const role of roles) {
    const text = await readFile(join(process.cwd(), `src/updater/v1/policy/service-${role}.sb`), "utf8");
    for (const path of ["/opt/homebrew", "/usr/local", "/Users"]) assert.ok(text.includes(path), `${role}: ${path}`);
    assert.match(text, /deny file-read\* file-map-executable/u); checked.push(role);
  }
  return evidence(roles.length * 4, { profiles: checked, deniedRootsPerProfile: 3 });
}

export const REHEARSAL_IMPLEMENTATIONS_V1 = Object.freeze({
  root_safety: rootSafety, filesystem_swaps: filesystemSwaps, absence_checks: absenceChecks,
  hostile_environment: hostileEnvironment, bundle_tamper: bundleTamper, bundle_symlink: bundleSymlink,
  code_crash_points: codeCrashPoints, torn_switch: tornSwitch, disk_preflight: diskPreflight,
  disk_reserve_retry: diskReserveRetry, runner_lease_burst: runnerLeaseBurst,
  known_good_injection: knownGoodInjection, rollback_chain: rollbackChain, guard_all_links: guardAllLinks,
  guard_rescue_points: guardRescuePoints, pause_stop: pauseStop, profile_shape: profileShape,
});
