import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runFirstOwnerEntryV1, firstOwnerViaScriptV1 } from "../src/updater/v1/pg/first-owner-script.mjs";
import { FIRST_OWNER_OWNER_V1 } from "../src/updater/v1/install/install-steps.mjs";
import { writeDatabaseLoginsV1 } from "../src/updater/v1/pg/first-owner-ports.mjs";
import { runInstalledFleetGatewayV1 } from "../src/fleet/v1/gateway-entry.ts";
import { loadMacLocalFleetConnectorReleaseV1 } from "../src/fleet/v1/mac-local-composition.ts";
import { createFleetReleaseTrustForTestV1 } from "./support/fleet-release.ts";
import { runtimePaths } from "../scripts/mac-local/stack.mjs";
import { RotatingHostLog, readHostState, superviseTaskHost } from "../scripts/mac-local/task-host-supervisor.mjs";
import { loadMacLocalTaskProviderFromRootV1, MAC_LOCAL_TASK_PROVIDER_V1,
  MAC_LOCAL_THREE_AGENT_KINDS_V1 } from "../src/web/v1/mac-local-task-provider.ts";
import { measureMacLocalArtifactStorageV1 } from "../src/web/v1/mac-local-storage-telemetry.ts";

const accounts = { database: { uid: 601, gid: 601 }, service: { gid: 602 } };
const entryInput = { executable: "/fixture/node", entry: "/fixture/firstOwner.js", cwd: "/fixture/current",
  accounts, request: { schema: "fixture" }, timeoutMs: 1000 };
function fakeSpawn(observed, mode = "ok") {
  return (executable, args, options) => {
    observed.push({ executable, args, options });
    const child = new EventEmitter(); child.pid = 4242;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = signal => { queueMicrotask(() => child.emit("close", null, signal)); return true; };
    child.stdin.on("finish", () => queueMicrotask(() => {
      if (mode === "hang") return;
      if (mode === "fail") { child.emit("close", 1); return; }
      child.stdout.emit("data", Buffer.from("{}\n")); child.emit("close", 0);
    }));
    return child;
  };
}

test("N-A: first-owner spawn keeps database uid and uses the service gid, including 50 parallel calls", async () => {
  const observed = [];
  await Promise.all(Array.from({ length: 50 }, () => runFirstOwnerEntryV1(entryInput, fakeSpawn(observed))));
  assert.equal(observed.length, 50);
  for (const { options } of observed) {
    assert.equal(options.uid, accounts.database.uid);
    assert.equal(options.gid, accounts.service.gid);
    assert.equal(options.shell, false);
  }
  await assert.rejects(runFirstOwnerEntryV1(entryInput, fakeSpawn([], "fail")), /first_owner_script_failed/);
  await assert.rejects(runFirstOwnerEntryV1({ ...entryInput, timeoutMs: 5 }, fakeSpawn([], "hang")),
    /first_owner_script_timeout/);
  assert.equal(await runFirstOwnerEntryV1(entryInput, fakeSpawn([])), "{}\n", "retry after failure still spawns");
});

test("N-A: absent, root, fractional and unsafe service gids refuse before any database or child access", async () => {
  for (const gid of [undefined, 0, -1, 1.5, "602", Number.MAX_SAFE_INTEGER + 1, NaN]) {
    const badAccounts = { ...accounts, service: { gid } };
    await assert.rejects(firstOwnerViaScriptV1({ root: "/fixture", accounts: badAccounts, release: "current",
      schemaDigest: `sha256:${"1".repeat(64)}`, pgDataId: "data-a", owner: FIRST_OWNER_OWNER_V1 }),
      /^Error: first_owner_input_refused$/);
    assert.throws(() => runFirstOwnerEntryV1({ ...entryInput, accounts: badAccounts }, () => assert.fail("spawned")),
      /first_owner_input_refused/);
  }
  await assert.rejects(firstOwnerViaScriptV1({ root: "/fixture", accounts: { database: accounts.database },
    release: "current", schemaDigest: `sha256:${"1".repeat(64)}`, pgDataId: "data-a", owner: FIRST_OWNER_OWNER_V1 }),
    /^Error: first_owner_input_refused$/);
});

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "svc1-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

test("N-B: the installed gateway starts web-only with a genuinely missing release and closes on stop", async t => {
  const base = await fixture(t), { trust } = createFleetReleaseTrustForTestV1();
  const configuration = { schema: "control-room.fleet-gateway/v1", tenantId: "tenant:local", port: 3212,
    database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_fleet",
      password: "fixture-only", majorVersion: 17 }, releaseTrust: trust };
  const signals = [process.rawListeners("SIGINT"), process.rawListeners("SIGTERM")];
  t.after(() => {
    for (const [index, name] of ["SIGINT", "SIGTERM"].entries()) {
      for (const listener of process.rawListeners(name)) if (!signals[index].includes(listener)) process.removeListener(name, listener);
    }
  });
  let started = 0, closed = 0, prepared = 0;
  const runtime = {
    readProtectedConfigurationFileV1: async () => JSON.stringify(configuration),
    loadMacLocalFleetConnectorReleaseV1: (_, releaseTrust) => loadMacLocalFleetConnectorReleaseV1(join(base, "missing"), releaseTrust),
    createPrivatePostgresDatabase: () => assert.fail("no database should be opened in this unit"),
    prepareInstalledMacLocalFleetGatewayV1: async input => {
      prepared += 1; assert.equal(input.connectorRelease, undefined);
      return { start: async () => { started += 1; }, close: async () => { closed += 1; } };
    },
  };
  await runInstalledFleetGatewayV1("/fixture/config.json", runtime);
  assert.equal(started, 1);
  const stop = process.listeners("SIGTERM").at(-1);
  stop(); stop(); await Promise.resolve(); assert.equal(closed, 1);
  await assert.rejects(runInstalledFleetGatewayV1(undefined, runtime), /fleet_gateway_usage_refused/);
  await assert.rejects(runInstalledFleetGatewayV1("/fixture/config.json", { ...runtime,
    readProtectedConfigurationFileV1: async () => "{" }), /fleet_gateway_configuration_refused/);
  await mkdir(join(base, "missing")); await writeFile(join(base, "missing", "manifest.json"), "{}");
  await assert.rejects(runInstalledFleetGatewayV1("/fixture/config.json", runtime), /fleet_connector_release_refused/);
  assert.equal(prepared, 1, "malformed releases still refuse before service preparation");
  await rm(join(base, "missing"), { recursive: true });
  await assert.rejects(runInstalledFleetGatewayV1("/fixture/config.json", { ...runtime,
    prepareInstalledMacLocalFleetGatewayV1: async () => ({ start: async () => { throw new Error("start_failed"); },
      close: async () => { closed += 1; } }) }), /start_failed/);
  assert.equal(closed, 2);
  await runInstalledFleetGatewayV1("/fixture/config.json", runtime);
  assert.equal(started, 2, "retry starts after the failed attempt was closed");
});

test("N-E: supervisor and installed runtime readers agree on runtime-state; dev keeps runtime", async t => {
  const root = await fixture(t), previous = process.env.RUNTIME_STATE;
  delete process.env.RUNTIME_STATE;
  t.after(() => { if (previous === undefined) delete process.env.RUNTIME_STATE; else process.env.RUNTIME_STATE = previous; });
  assert.equal(runtimePaths(root).runtime, join(root, "runtime"));
  const runtime = join(root, "runtime-state");
  process.env.RUNTIME_STATE = runtime;
  await mkdir(runtime, { mode: 0o700 });
  const paths = runtimePaths(root);
  assert.equal(paths.runtime, runtime);
  for (const [name, path] of Object.entries(paths)) if (name !== "runtime") assert.equal(path.startsWith(`${runtime}/`), true, name);
  const log = await RotatingHostLog.open(paths.hostLog); await log.write("runtime-state proof\n"); await log.close();
  assert.match(await readFile(paths.hostLog, "utf8"), /runtime-state proof/);
  // A process double lets the actual supervisor write running/stopped state without launching a host.
  const signals = new EventEmitter();
  assert.equal(await superviseTaskHost(root, { signals, spawn: fakeSpawn([], "hang"),
    onStarted: () => signals.emit("SIGTERM") }), 0);
  assert.equal((await readHostState(paths.hostState)).state, "stopped");
  const seen = [];
  const provider = { schema: MAC_LOCAL_TASK_PROVIDER_V1, workerKinds: MAC_LOCAL_THREE_AGENT_KINDS_V1,
    createTaskApplication: async () => ({ operations: {}, isReady: () => true, close: async () => {} }) };
  await loadMacLocalTaskProviderFromRootV1(root, {
    lstat: async path => { seen.push(path); return { isDirectory: () => path !== paths.provider,
      isFile: () => path === paths.provider, isSymbolicLink: () => false, mode: 0o700, size: 100 }; },
    load: async path => { assert.equal(path, paths.provider); return provider; },
  });
  assert.deepEqual(seen, [root, runtime, paths.provider]);
  const measured = await measureMacLocalArtifactStorageV1(root, async path => {
    assert.equal(path, join(runtime, "artifacts")); return { bavail: 1n, bsize: 4096n };
  });
  assert.deepEqual(measured, { quality: "observed", value: 4096 });
  const source = await readFile("src/web/v1/mac-local-default-task-provider.ts", "utf8");
  assert.match(source, /runtimeDirectory = macLocalRuntimeDirectoryV1\(protectedRoot\)/);
  for (const name of ["artifacts", "result-files", "work-hermes", "work-claude", "work-codex"])
    assert.equal(source.includes(`join(runtimeDirectory, "${name}")`), true, name);
});

test("N-N: as root, the password directory is handed to the service account before any password lands in it", async t => {
  const base = await fixture(t), root = join(base, "install");
  await mkdir(join(root, "Protected", "config"), { recursive: true });
  const directory = join(root, "Protected", "config", "database-passwords");
  const service = { uid: 602, gid: 603 };
  const passwords = { control_room_web: Buffer.alloc(32, 7).toString("base64url"),
    control_room_migrator: Buffer.alloc(32, 8).toString("base64url") };
  const input = { root, accounts: { service: { name: "_controlroom", ...service } }, passwords };
  // A root stand-in: `lchown` records the owner, `lstat` reports it, so the
  // port's own ownership read-back is what decides.
  const asRoot = (calls, { applies = true, fails = false } = {}) => {
    const owners = new Map();
    return { getuid: () => 0,
      lchown: async (path, uid, gid) => { calls.push([path, uid, gid]); if (fails) throw new Error("EPERM");
        if (applies) owners.set(path, { uid, gid }); },
      lstat: async path => { const entry = await lstat(path), owner = owners.get(path) ?? { uid: 0, gid: 0 };
        return Object.assign(Object.create(Object.getPrototypeOf(entry)), entry, owner); } };
  };
  const calls = [];
  const written = await writeDatabaseLoginsV1(input, asRoot(calls));
  assert.equal(written.references.length, 2);
  assert.deepEqual(calls[0], [directory, service.uid, service.gid], "the directory is chowned first");
  assert.deepEqual(calls.slice(1).map(([path, uid, gid]) => [path.startsWith(`${directory}/`), uid, gid]),
    [[true, service.uid, service.gid], [true, service.uid, service.gid]]);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  // A chown that silently did not take, or failed, is a refusal, not a directory the
  // installer believes it handed over.
  for (const options of [{ applies: false }, { fails: true }]) {
    const refusedCalls = [];
    await assert.rejects(writeDatabaseLoginsV1(input, asRoot(refusedCalls, options)), /database_logins_write_refused/u);
    assert.equal(refusedCalls.length, 1, "no password file is touched once the directory is refused");
  }
  // A widened directory is refused for every caller, root or not.
  await chmod(directory, 0o750);
  await assert.rejects(writeDatabaseLoginsV1(input, { getuid: () => 501, lchown: async () => assert.fail("no chown") }),
    /database_logins_write_refused/u);
  await chmod(directory, 0o700);
  // Not root: no ownership calls at all (a rehearsal runs as the service account).
  const plain = await writeDatabaseLoginsV1(input, { getuid: () => 501, lchown: async () => assert.fail("no chown") });
  assert.equal(plain.references.length, 2);
});
