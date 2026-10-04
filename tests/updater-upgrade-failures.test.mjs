import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { DiskReserveV1, RESERVE_BYTES_V1, UpdaterActuatorV1 } from "../src/updater/v1/actuator.mjs";
import { createLayoutV1, installControlRoomV1 } from "../src/updater/v1/install/installer.mjs";
import { fixture } from "./helpers/installer-round2-fixture.mjs";
import { UpdaterRunnerV1 } from "../src/updater/v1/runner.mjs";
import { UpdaterMainLoopV1, UpdaterModeV1, UpdaterStateFilesV1 } from "../src/updater/v1/runtime.mjs";
import { NEXT_ACTIONS_V1, publicStatusV1 } from "../src/updater/v1/contracts.mjs";
import { createUpdaterHomeStatusReaderV1 } from "../src/web/v1/updater-home-status.ts";
import { readUpdaterHomeStatusV1 } from "../src/web/v1/updater-home-status-browser.ts";
import { acquireKernelFileLockV1 } from "../src/installer/shared/private-process-lock.mjs";

async function scratch(t) {
  await mkdir(".test-tmp", { recursive: true });
  const root = await realpath(await mkdtemp(join(process.cwd(), ".test-tmp/r7u-failure-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["updater-state", "status", "releases/r1", "pg/data-p1"]) await mkdir(join(root, path), { recursive: true });
  await symlink("releases/r1", join(root, "current")); await symlink("data-p1", join(root, "pg/current"));
  await writeFile(join(root, "updater-state/self-update"), "On\n");
  return root;
}
const pathOf = root => join(root, "rescue-reserve.bin");
const rebuildOf = root => join(root, "updater-state/reserve-rebuild.json");
const read = async path => JSON.parse(await readFile(path, "utf8"));
const reserve = (root, options = {}) => new DiskReserveV1(root, { reserveBytes: 4096, minimumHeadroomBytes: 1024,
  diskFree: async () => 1_000_000, ...options });
const noSpace = () => Object.assign(new Error("disk full"), { code: "ENOSPC" });

test("D01/D05: installer layout allocates and verifies the reserve with a production size of 2 GiB", async t => {
  const root = await scratch(t), accounts = Object.fromEntries(["service", "database", "builder"]
    .map(role => [role, { uid: 501, gid: 20 }]));
  assert.equal(RESERVE_BYTES_V1, 2 * 1024 ** 3);
  const owners = [];
  const ports = { lchownPath: async (...args) => owners.push(args) };
  // Keep permanent regressions small; allocation and custody checks are real.
  const productionReserve = reserve(root);
  await createLayoutV1(root, accounts, ports, productionReserve);
  const entry = await productionReserve.assertIntact();
  assert.equal(entry.size, 4096); assert.ok(entry.blocks * 512 >= 4096);
  assert.equal(entry.mode & 0o777, 0o600); assert.equal(entry.nlink, 1);
  assert.ok(owners.some(([path, uid, gid]) => path === pathOf(root) && uid === 0 && gid === 0));
  // An existing damaged reserve must not be replaced or silently accepted.
  await truncate(pathOf(root), 2048);
  await assert.rejects(createLayoutV1(root, accounts, ports, productionReserve), { code: "updater_rescue_reserve_refused" });
});

test("D04: the install transaction provisions the reserve before staging", { timeout: 30_000 }, async t => {
  const f = await fixture(t, "r7u-reserve"), real = f.ports.stageReleaseV1;
  f.options.reserve = reserve(f.root);
  let checked = false;
  f.ports.stageReleaseV1 = async input => { await f.options.reserve.assertIntact(); checked = true; return real(input); };
  assert.equal((await installControlRoomV1(f.options)).state, "installed"); assert.equal(checked, true);
});

async function refusedOutcome(root, disk) {
  const from = { releaseId: "r1", pgDataId: "p1", schemaDigest: `sha256:${"1".repeat(64)}` };
  const run = { run_id: "run-one", state: "approved", lease_token: "lease-one", detail: { actuator: {
    from, to: { ...from, releaseId: "r2" }, releaseBytes: 1024 } } };
  const records = [], stateFiles = new UpdaterStateFilesV1(root, "lease-one"), mode = new UpdaterModeV1(stateFiles);
  await mode.initialize();
  const store = { acquire: async () => ({ status: "acquired", run, leaseToken: run.lease_token }), liveRun: async () => run,
    events: async () => [], transition: async (_id, _lease, state, detail) => {
      Object.assign(run, { state, detail }); records.push({ state, detail }); return { ...run }; } };
  const actuator = new UpdaterActuatorV1({ root, reserve: disk, schemaDigest: async () => from.schemaDigest,
    services: {}, artifacts: { verifySource: async () => {} }, health: async () => true });
  const runner = new UpdaterRunnerV1({ store, effects: actuator, mode, stateFiles,
    journal: { intent: async () => {}, done: async () => {}, validate: async () => {} },
    referee: { assertPlanAllowed: async () => {} } });
  const result = await runner.runOnce();
  assert.equal(result.status, "refused"); assert.equal(records.at(-1).state, "refused");
  return result;
}

test("D02/D06: missing, short, wrong-size and genuinely low disk have distinct owner sentences", async t => {
  const messages = [];
  for (const kind of ["missing", "short", "wrong_size", "low_disk"]) await t.test(kind, async t => {
    const root = await scratch(t);
    if (kind !== "missing") await writeFile(pathOf(root), Buffer.alloc(kind === "short" ? 2048 : kind === "wrong_size" ? 8192 : 4096));
    const result = await refusedOutcome(root, reserve(root, { diskFree: async () => 0 }));
    assert.equal(result.code, kind === "low_disk" ? "updater_disk_reserve_low" : "updater_rescue_reserve_refused");
    assert.match(result.message, kind === "low_disk" ? /too little free disk space/u : /missing.*disk safety margin/u);
    assert.match(result.message, /Mac/u); assert.doesNotMatch(result.message, /ENOENT|\.test-tmp|\/Users\//u);
    if (kind !== "low_disk") assert.equal(result.run.detail.reserveIssue, kind);
    messages.push(result.message);
  });
  assert.equal(new Set(messages).size, 4);
});

test("D03: a failed rebuild is durable and a new precheck restores it before refusing", async t => {
  for (const code of ["ENOSPC", "EPOWER", "EIO"]) await t.test(code, async t => {
    const root = await scratch(t); await writeFile(pathOf(root), Buffer.alloc(4096));
    await assert.rejects(reserve(root, { createReserve: async () => { throw Object.assign(new Error("rebuild interrupted"), { code }); } })
      .finishWithReserve(async () => { throw noSpace(); }), { code: "ENOSPC" });
    assert.deepEqual(await read(rebuildOf(root)), { schema: "control-room.reserve-rebuild/v1", state: "needs_attention",
      reason: "updater_rescue_reserve_rebuild_failed" });
    assert.equal((await reserve(root).preflight({ releaseBytes: 1024 })).requiredBytes, 3072);
    await reserve(root).assertIntact(); assert.equal((await read(rebuildOf(root))).state, "resolved");
  });
});

test("D03: success with a failed rebuild stays recorded; a partial injected rebuild cannot pass", async t => {
  for (const bytes of [0, 2048]) await t.test(String(bytes), async t => {
    const root = await scratch(t); await writeFile(pathOf(root), Buffer.alloc(4096)); let calls = 0;
    const disk = reserve(root, { createReserve: async () => {
      if (bytes) await writeFile(pathOf(root), Buffer.alloc(bytes));
      throw noSpace();
    } });
    assert.equal(await disk.finishWithReserve(async () => { if (!calls++) throw noSpace(); return "recovered"; }), "recovered");
    assert.equal((await read(rebuildOf(root))).state, "needs_attention");
    if (bytes) await assert.rejects(reserve(root).preflight({ releaseBytes: 1024 }), { code: "updater_rescue_reserve_refused" });
    else await reserve(root).preflight({ releaseBytes: 1024 });
  });
});

test("reserve rebuild failures during precheck are durable and retryable", async t => {
  const root = await scratch(t);
  await assert.rejects(reserve(root, { createReserve: async () => { throw noSpace(); } }).preflight({ releaseBytes: 1024 }),
    { code: "updater_rescue_reserve_refused", reserveIssue: "missing" });
  assert.equal((await read(rebuildOf(root))).state, "needs_attention");
  await reserve(root).preflight({ releaseBytes: 1024 });
  await assert.rejects(reserve(root).preflight({ releaseBytes: -1 }), { code: "updater_disk_measurement_refused" });
  await assert.rejects(reserve(root).preflight({ releaseBytes: Number.MAX_SAFE_INTEGER }), { code: "updater_disk_measurement_refused" });
});

test("D03: SIGKILL after spending the reserve is repaired by the next process's precheck", { timeout: 10_000 }, async t => {
  const root = await scratch(t); await writeFile(pathOf(root), Buffer.alloc(4096));
  const module = new URL("../src/updater/v1/actuator.mjs", import.meta.url).href;
  const program = `import {DiskReserveV1} from ${JSON.stringify(module)};
let calls=0; const reserve=new DiskReserveV1(process.argv[1],{reserveBytes:4096});
await reserve.finishWithReserve(async()=>{if(!calls++)throw Object.assign(new Error('full'),{code:'ENOSPC'});
process.stdout.write('spent\\n'); process.stdin.resume(); process.stdin.once('end',()=>process.exit(0)); await new Promise(()=>{});});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program, root], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise(resolve => child.once("close", resolve)); let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("reserve_spend_timeout")), 5000);
      child.once("error", reject); child.stdout.once("data", bytes => bytes.toString().includes("spent") ? resolve() : reject(new Error("unexpected_child_output")));
    });
    child.kill("SIGKILL"); await closed;
    assert.equal(child.signalCode, "SIGKILL"); await assert.rejects(lstat(pathOf(root)), { code: "ENOENT" });
    assert.equal((await read(rebuildOf(root))).state, "needs_attention");
    await reserve(root).preflight({ releaseBytes: 1024 }); assert.equal((await read(rebuildOf(root))).state, "resolved");
  } finally { clearTimeout(timer); child.kill("SIGKILL"); await closed; child.stdin.destroy(); }
});

test("reserve rebuilding admits 50 concurrent prechecks without replacing or truncating the published file", async t => {
  const root = await scratch(t);
  await Promise.all(Array.from({ length: 50 }, () => reserve(root).preflight({ releaseBytes: 1024 })));
  const before = await lstat(pathOf(root));
  await Promise.all(Array.from({ length: 50 }, () => reserve(root).preflight({ releaseBytes: 1024 })));
  const after = await reserve(root).assertIntact(); assert.equal(after.ino, before.ino); assert.equal(after.size, 4096);
});

test("the reserve writer completes short writes and refuses a zero-byte write without hanging", async t => {
  for (const zero of [false, true]) await t.test(String(zero), async t => {
    const root = await scratch(t), handle = await open(join(root, "prototype"), "wx");
    const prototype = Object.getPrototypeOf(handle), original = prototype.write; await handle.close(); let writes = 0;
    prototype.write = async function(buffer, offset, length, position) {
      if (zero && !writes++) return { bytesWritten: 0, buffer };
      return original.call(this, buffer, offset, Math.min(length, 257), position);
    };
    try {
      if (zero) await assert.rejects(reserve(root).ensureIntact(), { code: "updater_rescue_reserve_refused" });
      else assert.equal((await reserve(root).ensureIntact()).size, 4096);
    } finally { prototype.write = original; }
    assert.equal((await readdir(root)).filter(name => /^rescue-reserve\.bin\..*\.tmp$/u.test(name)).length, 0);
  });
});

test("interrupted allocation files and publication aliases are reclaimed; unrelated or unsafe entries remain", async t => {
  const root = await scratch(t), orphan = join(root, "rescue-reserve.bin.11111111-1111-4111-8111-111111111111.tmp"),
    unsafe = join(root, "rescue-reserve.bin.22222222-2222-4222-8222-222222222222.tmp");
  await writeFile(orphan, Buffer.alloc(2048), { mode: 0o600 }); await writeFile(unsafe, "leave", { mode: 0o644 });
  await writeFile(join(root, "unrelated.tmp"), "leave", { mode: 0o600 });
  await reserve(root).preflight({ releaseBytes: 1024 }); await assert.rejects(lstat(orphan), { code: "ENOENT" });
  assert.equal(await readFile(unsafe, "utf8"), "leave"); assert.equal(await readFile(join(root, "unrelated.tmp"), "utf8"), "leave");
  await link(pathOf(root), orphan); assert.equal((await lstat(pathOf(root))).nlink, 2);
  assert.equal((await reserve(root).ensureIntact()).nlink, 1);
  await assert.rejects(lstat(orphan), { code: "ENOENT" });
});

test("allocation cleanup preserves symlinks, foreign owners and hard links to unrelated files", async t => {
  const root = await scratch(t), name = number => join(root, `rescue-reserve.bin.${number.repeat(8)}-${number.repeat(4)}-4${number.repeat(3)}-8${number.repeat(3)}-${number.repeat(12)}.tmp`);
  const foreign = name("1"), alias = name("2"), symbolic = name("3");
  await writeFile(foreign, "foreign", { mode: 0o600 }); await writeFile(join(root, "unrelated"), "keep", { mode: 0o600 });
  await link(join(root, "unrelated"), alias); await symlink("unrelated", symbolic);
  const original = filesystem.lstat;
  filesystem.lstat = async (...args) => {
    const entry = await original(...args);
    if (args[0] === foreign) entry.uid = process.getuid() + 1;
    if (args[0] === symbolic) entry.mode = (entry.mode & ~0o777) | 0o600;
    return entry;
  };
  syncBuiltinESMExports();
  try { await reserve(root).ensureIntact(); }
  finally { filesystem.lstat = original; syncBuiltinESMExports(); }
  assert.equal(await readFile(foreign, "utf8"), "foreign"); assert.equal((await lstat(alias)).nlink, 2);
  assert.equal((await lstat(symbolic)).isSymbolicLink(), true);
});

test("a second allocator refuses while the kernel lock is held, then rebuilds on retry", async t => {
  const root = await scratch(t), lock = await acquireKernelFileLockV1(join(root, "updater-state/reserve-allocation.lock"));
  try { await assert.rejects(reserve(root).preflight({ releaseBytes: 1024 }), { code: "updater_rescue_reserve_refused" }); }
  finally { await lock.release(); }
  await reserve(root).preflight({ releaseBytes: 1024 }); await reserve(root).assertIntact();
});

test("a sparse or multiply linked reserve cannot be a verified disk safety margin", async t => {
  const root = await scratch(t), handle = await open(pathOf(root), "wx");
  try { await handle.truncate(4096); } finally { await handle.close(); }
  await assert.rejects(reserve(root).assertIntact(), { code: "updater_rescue_reserve_refused" });
  await unlink(pathOf(root)); await writeFile(pathOf(root), Buffer.alloc(4096)); await link(pathOf(root), join(root, "second-link"));
  await assert.rejects(reserve(root).assertIntact(), { code: "updater_rescue_reserve_refused" });
});

async function loop(root, outcome) {
  const stateFiles = new UpdaterStateFilesV1(root, "lease-one"), mode = new UpdaterModeV1(stateFiles); await mode.initialize();
  return { stateFiles, value: new UpdaterMainLoopV1({ stateFiles, mode, runner: { runOnce: outcome },
    store: { unhandledOwnerRequests: async () => [] }, ownerActions: { handle: async () => {} } }) };
}

test("O05/E04: each attention state publishes its fixed action through status, web and browser", async t => {
  for (const [state, action] of [["uncertain", "check_and_continue"], ["needs_attention", "review_recovery"],
    ["attended_upgrade_required", "upgrade_on_mac"]]) await t.test(state, async t => {
    const root = await scratch(t), { value } = await loop(root, async () => ({ status: state }));
    for (let poll = 0; poll < 2; poll++) {
      await value.tick(); const status = await read(join(root, "status/status.json"));
      assert.equal(status.state, state); assert.equal(status.nextAction, action); assert.equal(status.needsYou, true);
      const home = await createUpdaterHomeStatusReaderV1({ root }).read(); assert.equal(home.state, "needs_owner");
      assert.equal(home.nextAction, action);
      const browser = await readUpdaterHomeStatusV1(async () => Response.json(home)); assert.equal(browser.nextAction, action);
    }
  });
});

test("public actions are a bounded allowlist, and every other extra field still fails closed", async t => {
  assert.ok(Object.keys(NEXT_ACTIONS_V1).every(key => key.length <= 64));
  for (const nextAction of ["run_shell", "<img>", "toString", "__proto__", "x".repeat(1000), {}, 3]) {
    assert.throws(() => publicStatusV1({ state: "uncertain", nextAction }), { code: "updater_status_next_action_refused" });
  }
  const root = await scratch(t), path = join(root, "status/status.json");
  await writeFile(path, JSON.stringify({ ...publicStatusV1({ selfUpdate: "On" }), nextAction: "run_shell" }));
  assert.equal((await createUpdaterHomeStatusReaderV1({ root }).read()).state, "attention");
  await writeFile(path, JSON.stringify({ ...publicStatusV1({ selfUpdate: "On", nextAction: "rescue_resolved" }), message: "unbounded" }));
  assert.equal((await createUpdaterHomeStatusReaderV1({ root }).read()).state, "attention");
  for (const extra of [{ nextAction: "run_shell" }, { nextAction: "toString" }, { message: "unbounded" }])
    assert.equal((await readUpdaterHomeStatusV1(async () => Response.json({ schema: "control-room.updater-home-status/v1", state: "healthy", ...extra }))).state, "attention");
});

test("O05/E05: clearing rescue publishes a one-time resolved confirmation across a loop restart", async t => {
  for (const method of ["owner_action", "manual_clear"]) await t.test(method, async t => {
    const root = await scratch(t); await writeFile(join(root, "updater-state/rescued.json"), "{}");
    const first = await loop(root, async () => ({ status: "idle" })); await first.value.tick();
    assert.equal((await read(join(root, "status/status.json"))).nextAction, "review_rescue_on_mac");
    if (method === "owner_action") await first.stateFiles.removeRescueMarker(); else await unlink(join(root, "updater-state/rescued.json"));
    const restarted = await loop(root, async () => ({ status: "idle" })); await restarted.value.tick();
    assert.equal((await read(join(root, "status/status.json"))).nextAction, "rescue_resolved");
    assert.equal((await createUpdaterHomeStatusReaderV1({ root }).read()).nextAction, "rescue_resolved");
    await restarted.value.tick(); assert.equal((await read(join(root, "status/status.json"))).nextAction, undefined);
  });
});

test("guard recovery stays owner-visible across idle polls and updater restarts", async t => {
  const root = await scratch(t);
  await writeFile(join(root, "updater-state/selfupgrade.json"), JSON.stringify({ schema: "control-room.selfupgrade/v1",
    phase: "reverted", state: "needs_attention", reason: "updater_selfupgrade_reverted" }));
  for (let restart = 0; restart < 3; restart++) {
    const { value } = await loop(root, async () => ({ status: "idle" })); await value.tick();
    const status = await read(join(root, "status/status.json"));
    assert.equal(status.state, "needs_attention"); assert.equal(status.needsYou, true); assert.equal(status.nextAction, "review_recovery");
  }
});

test("clearing a rescue before its first poll still publishes a durable one-time confirmation", async t => {
  const root = await scratch(t); await writeFile(join(root, "updater-state/rescued.json"), "{}");
  const files = new UpdaterStateFilesV1(root, "lease-one"); await files.removeRescueMarker();
  const { value } = await loop(root, async () => ({ status: "idle" })); await value.tick();
  assert.equal((await read(join(root, "status/status.json"))).nextAction, "rescue_resolved");
  await value.tick(); assert.equal((await read(join(root, "status/status.json"))).nextAction, undefined);
});

test("a guard recovery recorded during a poll wins over the earlier idle facts", async t => {
  const root = await scratch(t), { value, stateFiles } = await loop(root, async () => ({ status: "idle" }));
  const original = stateFiles.publicFacts.bind(stateFiles); let reads = 0;
  stateFiles.publicFacts = async () => {
    if (++reads === 2) await writeFile(join(root, "updater-state/selfupgrade.json"), JSON.stringify({
      schema: "control-room.selfupgrade/v1", phase: "reverting", state: "needs_attention", reason: "updater_selfupgrade_reverted" }));
    return original();
  };
  await value.tick(); const status = await read(join(root, "status/status.json"));
  assert.equal(status.state, "needs_attention"); assert.equal(status.needsYou, true); assert.equal(status.nextAction, "review_recovery");
});
