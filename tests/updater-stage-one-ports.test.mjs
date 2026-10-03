import * as releaseParsers from "../src/web/v1/mac-local-protected-loader.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFleetReleaseTrustForTestV1 } from "./support/fleet-release.ts";
import {
  PASSWORDLESS_LOGINS_V1, parseDatabasePhaseLoginsV1,
} from "../src/updater/v1/pg/database-phase-contract.mjs";
import { INSTALL_DATABASE_LOGINS_V1 } from "../src/updater/v1/install/install-steps.mjs";
import {
  checkHealthDatabaseV1, cleanupBootstrapV1, composeProtectedConfigPortV1, createStageOnePortsV1, firstOwnerV1,
  initializeDatabaseV1, installGuardV1, killAccountProcessesV1, recordPasskeyStatusV1, recordTailscaleServeV1,
  registerInitialPasskeyV1, removeDatabaseLoginsV1, removeGuardV1, removeKnownGoodV1, remintOwnerCodeV1,
  retireDatabaseV1, rollbackOwnerCodeV1, seedKnownGoodV1, writeDatabaseLoginsV1,
} from "../src/updater/v1/install/stage-one-ports.mjs";
import { registerInitialPasskeyProductionV1 } from "../src/updater/v1/pg/initial-passkey-production.mjs";

const digest = value => `sha256:${value.repeat(64)}`;
async function fixture(t, name) {
  const base = await mkdtemp(join(tmpdir(), `stage-one-${name}-`));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  await mkdir(join(root, "updater-state"), { recursive: true });
  return { base, root };
}

const STAGE_ONE_DATABASE_SYSTEM_V1 = ["initializeDatabase", "retireDatabase", "firstOwner", "writeDatabaseLogins",
  "removeDatabaseLogins", "registerInitialPasskey", "recordPasskeyStatus", "checkDatabaseHealth"];

test("the verified bundle replaces archive stage-one implementations and leaves only system adapters", async t => {
  const unavailable = async () => { throw new Error("archive_port_used"); };
  const system = Object.fromEntries(["installServices", "uninstallServices", "recoverServices", "restartServices",
    "startPostHealthServices", "readTailscaleRpId", "captureTailscaleServe", "activateTailscaleServe",
    "inspectTailscaleServe", "restoreTailscaleServe", "moveLiveDatabase", "randomBytes"].map(name => [name, unavailable]));
  system.installGuard = unavailable;
  // rv-9b B1: the database ports are the SYSTEM's real implementations, never this
  // module's `database_port_not_yet_supplied` stubs, and a system object without
  // them is refused rather than silently backfilled with a stub.
  assert.throws(() => createStageOnePortsV1(system), /stage_one_system_ports_refused/u);
  for (const name of STAGE_ONE_DATABASE_SYSTEM_V1) system[name] = async () => ({ system: name });
  const ports = createStageOnePortsV1(system);
  assert.notEqual(ports.installGuard, unavailable);
  assert.equal(ports.installServices, unavailable);
  for (const [name, stub] of [["initializeDatabase", initializeDatabaseV1], ["retireDatabase", retireDatabaseV1],
    ["firstOwner", firstOwnerV1], ["writeDatabaseLogins", writeDatabaseLoginsV1], ["removeDatabaseLogins", removeDatabaseLoginsV1],
    // cl-pkwire: the install-night passkey status record is the system's too.
    ["recordPasskeyStatus", recordPasskeyStatusV1]]) {
    assert.equal(ports[name], system[name], `${name} must be the system's port`);
    assert.notEqual(ports[name], stub, `${name} must not be the not-yet-supplied stub`);
  }
  // atk-fa F2: the Face ID port is stage one's OWN production port - in the fixed
  // bundle, the copy with `pg` inlined - never the system's (the git-archive copy,
  // which cannot load `pg`) and never the not-yet-supplied stub.
  assert.equal(ports.registerInitialPasskey, registerInitialPasskeyProductionV1);
  assert.notEqual(ports.registerInitialPasskey, system.registerInitialPasskey);
  assert.notEqual(ports.registerInitialPasskey, registerInitialPasskeyV1);
  delete system.registerInitialPasskey;
  assert.equal(createStageOnePortsV1(system).registerInitialPasskey, registerInitialPasskeyProductionV1);
  // checkHealth's database half is the system's too: a health check reaches it
  // (after input validation) rather than the stub's refusal.
  const f = await fixture(t, "db-system");
  await symlink("releases/1.0.0-a", join(f.root, "current"));
  let reached = null;
  system.checkDatabaseHealth = async input => { reached = input; throw new Error("system_database_half_reached"); };
  await assert.rejects(createStageOnePortsV1(system).checkHealth({ root: f.root, expectedRelease: "releases/1.0.0-a",
    pgDataId: "data-a", schemaDigest: digest("1"), updaterSchemaDigest: digest("2"), samples: 3 }),
  /system_database_half_reached/u);
  assert.deepEqual(reached, { root: f.root, pgDataId: "data-a", schemaDigest: digest("1"), updaterSchemaDigest: digest("2") });
});

test("every database-authority default port has one typed not-yet-supplied contract", () => {
  const root = join(tmpdir(), "stage-one-db-contract");
  const ports = new Map([
    ["initializeDatabase", initializeDatabaseV1], ["retireDatabase", retireDatabaseV1], ["firstOwner", firstOwnerV1],
    ["writeDatabaseLogins", writeDatabaseLoginsV1], ["removeDatabaseLogins", removeDatabaseLoginsV1],
    ["registerInitialPasskey.pg", registerInitialPasskeyV1], ["recordPasskeyStatus", recordPasskeyStatusV1],
    ["checkHealth.database", checkHealthDatabaseV1],
  ]);
  for (const [port, implementation] of ports) {
    assert.throws(() => implementation({ root }), error => error?.code === "database_port_not_yet_supplied"
      && error.port === port && error.schema === "control-room.database-port-not-yet-supplied/v1"
      && Array.isArray(error.contract?.inputKeys));
  }
});

test("the installer's login list asks for a password for nobody the phase refuses", () => {
  // The two lists are written by different people for different reasons, and the
  // collision is silent from either side. `INSTALL_DATABASE_LOGINS_V1` is the
  // installer's list of logins to CREATE WITH a password;
  // `PASSWORDLESS_LOGINS_V1` is the one parser both phase scripts share, and it
  // refuses any login in that list as a password login. If the installer ever
  // names a passwordless login again, `makeCredentials` builds a request the
  // phase refuses at step 0 — the install dies before the loader's own, later and
  // more specific refusal, with a code that names neither cause. This asserts the
  // two agree through the production parser, not through a copy of its list.
  for (const name of INSTALL_DATABASE_LOGINS_V1) {
    const logins = [{ name, passwordStdin: true }];
    const code = "database_phase_input_refused";
    if (PASSWORDLESS_LOGINS_V1.includes(name)) {
      assert.throws(() => parseDatabasePhaseLoginsV1(logins, code), error => error?.code === `${code}:passwordless_login:${name}`,
        `${name} is peer-only, so the installer must not ask for a password for it`);
    } else {
      assert.equal(parseDatabasePhaseLoginsV1(logins, code).length, 1, `${name} must stay a normal password login`);
    }
  }
  // And the other half of the same fact: a passwordless login IS refused, so this
  // test would notice a `PASSWORDLESS_LOGINS_V1` emptied out from under it.
  assert.throws(() => parseDatabasePhaseLoginsV1([{ name: "control_room_deployer", passwordStdin: true }],
    "database_phase_input_refused"),
  /passwordless_login:control_room_deployer/u);
});

test("initial passkey wiring renders a fresh owner-bound QR and reads the code through the shared TTY on every retry", async () => {
  let began = 0, completed = 0; const writes = [], raw = [], lines = ["WRONG1", "ABC234"];
  const terminal = { isTTY: true, write: value => writes.push(value), readLine: async () => lines.shift(),
    setRawMode: value => raw.push(value) };
  const authority = {
    async beginRegistration({ mode, authenticator }) { assert.equal(mode, "initial"); assert.equal(authenticator, "software"); began += 1;
      return { registrationSecret: `${began}`.repeat(43), config: { rpId: "control.example.ts.net" } }; },
    async completeRegistration({ typedCode }) { completed += 1;
      if (completed === 1) throw Object.assign(new Error("wrong"), { code: "updater_passkey_code_refused" });
      assert.equal(typedCode, "ABC234"); return { credentialId: "credential-one" }; },
  };
  const input = { root: "/private/tmp/control-room-passkey", config: { rpId: "control.example.ts.net" },
    ownerCode: "O".repeat(43), terminal, qr: { ownerCodePolicy: "every-unconsumed-attempt" }, maxAttempts: 5,
    authenticator: "software" };
  const result = await registerInitialPasskeyV1(input, { authority });
  assert.equal(result.status, "registered"); assert.equal(result.attempts, 2);
  assert.equal(began, 2); assert.deepEqual(raw, [true, false, true, false]);
  const output = writes.join("");
  assert.match(output, /#code=O{43}&reg=1{43}/u); assert.match(output, /#code=O{43}&reg=2{43}/u);
  let nonTtyBegan = false;
  assert.throws(() => registerInitialPasskeyV1({ ...input, terminal: { ...terminal, isTTY: false } }, {
    authority: { ...authority, async beginRegistration() { nonTtyBegan = true; } },
  }), /passkey_registration_input_refused/u);
  assert.throws(() => registerInitialPasskeyV1({ ...input, authenticator: "face-id" }, { authority }),
    /passkey_registration_input_refused/u);
  assert.equal(nonTtyBegan, false);
});

test("guard install is no-follow, idempotent, digest-bound and removable on its default path", async t => {
  const f = await fixture(t, "guard"), source = join(f.root, "updater/current/guard.sh"), target = join(f.root, "guard/guard.sh");
  await mkdir(join(f.root, "updater/current"), { recursive: true }); await writeFile(source, "#!/bin/sh\nexit 0\n");
  const first = await installGuardV1({ root: f.root, source, target }), second = await installGuardV1({ root: f.root, source, target });
  assert.deepEqual(second, first); assert.equal((await lstat(target)).mode & 0o777, 0o555);
  await chmod(target, 0o755); await assert.rejects(installGuardV1({ root: f.root, source, target }), /guard_install_refused/u);
  await chmod(target, 0o755); await writeFile(target, "changed\n"); await chmod(target, 0o555);
  await assert.rejects(removeGuardV1({ root: f.root, receipt: first }), /guard_remove_refused/u);
  await chmod(target, 0o755); await writeFile(target, "#!/bin/sh\nexit 0\n"); await chmod(target, 0o555);
  await removeGuardV1({ root: f.root, receipt: first });
  await assert.rejects(lstat(target), { code: "ENOENT" });
});

test("rehearsal guard embeds only its configured root, labels and plist paths", async t => {
  const f = await fixture(t, "rehearsal-guard"), source = join(f.root, "updater/current/guard.sh"), target = join(f.root, "guard/guard.sh");
  await mkdir(join(f.root, "updater/current"), { recursive: true });
  await writeFile(source, await readFile(join(process.cwd(), "src/updater/v1/guard/guard.sh")));
  const roles = ["updater-guard", "updater", "nightly-backup", "fleet-gateway", "supervisor", "postgresql17"];
  const servicePolicy = roles.map(role => ({ role, label: `xyz.agentcontrolroom.rehearsal.${role}`,
    plistPath: `/Library/LaunchDaemons/xyz.agentcontrolroom.rehearsal.${role}.plist` }));
  await installGuardV1({ root: f.root, source, target, servicePolicy });
  const installed = await readFile(target, "utf8");
  assert.match(installed, new RegExp(`ROOT='${f.root.replaceAll("/", "\\/")}'`, "u"));
  for (const service of servicePolicy) {
    assert.match(installed, new RegExp(service.label.replaceAll(".", "\\."), "u"));
    assert.match(installed, new RegExp(service.plistPath.replaceAll("/", "\\/").replaceAll(".", "\\."), "u"));
  }
  assert.doesNotMatch(installed, /system\/xyz\.agentcontrolroom\.updater(?:\s|$)/u);
  const bad = await fixture(t, "rehearsal-guard-unbound"), badSource = join(bad.root, "updater/current/guard.sh");
  await mkdir(join(bad.root, "updater/current"), { recursive: true }); await writeFile(badSource, "#!/bin/sh\nexit 0\n");
  await assert.rejects(installGuardV1({ root: bad.root, source: badSource,
    target: join(bad.root, "guard/guard.sh"), servicePolicy }), /guard_install_refused/u);
});

test("Serve and known-good records use their production default paths and refuse mismatched undo", async t => {
  const f = await fixture(t, "records"), serve = { Web: {}, TCP: {} };
  const receipt = await recordTailscaleServeV1({ root: f.root, serve, webPort: 3210 });
  assert.match(receipt.serveDigest, /^sha256:/u);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, "updater-state/serve.json"), "utf8")), serve);
  const known = await seedKnownGoodV1({ root: f.root, releaseId: "1.2.3-aaaaaaaaaaaa", pgDataId: "data-abc",
    schemaDigest: digest("a") });
  await assert.rejects(seedKnownGoodV1({ root: f.root, ...known, releaseId: "1.2.4-bbbbbbbbbbbb" }),
    /known_good_seed_refused/u);
  await assert.rejects(removeKnownGoodV1({ root: f.root, expected: { ...known, schemaDigest: digest("b") } }),
    /known_good_remove_refused/u);
  await removeKnownGoodV1({ root: f.root, expected: known });
  await assert.rejects(lstat(join(f.root, "updater-state/known-good")), { code: "ENOENT" });
});

test("protected configuration captures the default protected key files before calling the pure composer", async t => {
  const f = await fixture(t, "protected"), service = join(f.root, "Protected/service"); await mkdir(service, { recursive: true });
  const secret = "A".repeat(43), integrityKey = "B".repeat(43);
  await writeFile(join(service, "web-hmac.key"), `${secret}\n`, { mode: 0o600 });
  await writeFile(join(service, "work-intake.json"), `${JSON.stringify({ schema: "control-room.work-intake-keys/v1", integrityKey })}\n`, { mode: 0o600 });
  const names = INSTALL_DATABASE_LOGINS_V1;
  const dbLogins = names.map((name, index) => { const password = String.fromCharCode(67 + index).repeat(43); return {
    name, password, passwordDigest: `sha256:${createHash("sha256").update(password).digest("hex")}`,
    fileRef: join(f.root, "Protected/config/database-passwords", `${name}.txt`),
  }; });
  const result = await composeProtectedConfigPortV1({ root: f.root,
    accounts: { builder: { name: "_builder", uid: 300, gid: 300, created: true },
      database: { name: "_database", uid: 301, gid: 301, created: true },
      service: { name: "_service", uid: 302, gid: 302, created: true } },
    installationId: "installation-one", rpId: "fixture.example.ts.net", webPort: 3210, gatewayPort: 3211,
    tenant: { tenantId: "tenant", workspaceId: "workspace", provider: "local", subject: "owner" },
    // `releaseTrust` is REQUIRED of the composer: the gateway's own parser demands it,
    // so the fixture supplies one from the release's test helper rather than a literal.
    releaseTrust: createFleetReleaseTrustForTestV1().trust,
    ownerCodeDigest: digest("d"), dbLogins, keys: { vapidPrivate: join(f.root, "updater-state/vapid.json"),
      vapidPublic: join(service, "vapid-public.json"), healthProbeRoot: join(f.root, "updater-state/health-probe.key"),
      healthProbeService: join(service, "health-probe.key"), webHmac: join(service, "web-hmac.key"),
      workIntake: join(service, "work-intake.json") } }, { loadReleaseParsers: async () => releaseParsers });
  assert.equal(result.length, 9);
  assert.equal(JSON.parse(result.find(value => value.path.endsWith("fleet-gateway.json")).contents).harnessIntegrityKey, secret);
});

test("owner-code remint and rollback update only the default protected session file", async t => {
  const f = await fixture(t, "owner"), path = join(f.root, "Protected/config/local-owner-session.json");
  await mkdir(join(f.root, "Protected/config"), { recursive: true });
  const original = { schema: "control-room.local-owner-session/v1", ownerCodeDigest: digest("c") };
  await writeFile(path, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  const input = { root: f.root, accounts: {}, configuration: [{ path, contents: `${JSON.stringify(original)}\n` }],
    rpId: "fixture.example.test", maximumRemints: 2 };
  await writeFile(path, `${JSON.stringify({ ...original, ownerCodeDigest: digest("b") })}\n`);
  await assert.rejects(remintOwnerCodeV1(input), /owner_code_refused/u);
  await writeFile(path, `${JSON.stringify(original)}\n`);
  const result = await remintOwnerCodeV1(input);
  assert.equal(JSON.parse(await readFile(path, "utf8")).ownerCodeDigest, result.ownerCodeDigest);
  await rollbackOwnerCodeV1({ root: f.root, receipt: result.receipt });
  assert.equal(JSON.parse(await readFile(path, "utf8")).ownerCodeDigest, original.ownerCodeDigest);
});

test("stage-one owner-code apply and undo restart the supervisor with the roles contract", async t => {
  const f = await fixture(t, "owner-restart"), path = join(f.root, "Protected/config/local-owner-session.json");
  await mkdir(join(f.root, "Protected/config"), { recursive: true });
  const original = { schema: "control-room.local-owner-session/v1", ownerCodeDigest: digest("c") };
  await writeFile(path, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  const restarts = [], unavailable = async () => { throw new Error("unused_system_port"); };
  const system = Object.fromEntries(["installServices", "uninstallServices", "recoverServices", "startPostHealthServices",
    "readTailscaleRpId", "captureTailscaleServe", "activateTailscaleServe", "inspectTailscaleServe",
    "restoreTailscaleServe", "moveLiveDatabase", "randomBytes", ...STAGE_ONE_DATABASE_SYSTEM_V1].map(name => [name, unavailable]));
  system.restartServices = async input => { restarts.push(input); return { restarted: true }; };
  const ports = createStageOnePortsV1(system), input = { root: f.root, accounts: {},
    configuration: [{ path, contents: `${JSON.stringify(original)}\n` }], rpId: "fixture.example.test", maximumRemints: 2 };
  const minted = await ports.remintOwnerCode(input);
  await ports.rollbackOwnerCode({ root: f.root, receipt: minted.receipt });
  assert.deepEqual(restarts, [{ root: f.root, roles: ["supervisor"] }, { root: f.root, roles: ["supervisor"] }]);
});

test("owner-code rollback is repeatable: absent or already-restored files are done, a third digest refuses", async t => {
  // atk-fa F4: recovery replays the rollback after the in-process undo already restored
  // the digest and the core-services rollback removed the file; that refused every retry.
  const f = await fixture(t, "owner-repeat"), path = join(f.root, "Protected/config/local-owner-session.json");
  await mkdir(join(f.root, "Protected/config"), { recursive: true });
  const original = { schema: "control-room.local-owner-session/v1", ownerCodeDigest: digest("c") };
  await writeFile(path, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  const restarts = [], unavailable = async () => { throw new Error("unused_system_port"); };
  const system = Object.fromEntries(["installServices", "uninstallServices", "recoverServices", "startPostHealthServices",
    "readTailscaleRpId", "captureTailscaleServe", "activateTailscaleServe", "inspectTailscaleServe",
    "restoreTailscaleServe", "moveLiveDatabase", "randomBytes", ...STAGE_ONE_DATABASE_SYSTEM_V1].map(name => [name, unavailable]));
  system.restartServices = async input => { restarts.push(input); return { restarted: true }; };
  const ports = createStageOnePortsV1(system);
  const minted = await ports.remintOwnerCode({ root: f.root, accounts: {},
    configuration: [{ path, contents: `${JSON.stringify(original)}\n` }], rpId: "fixture.example.test", maximumRemints: 2 });
  assert.deepEqual(await ports.rollbackOwnerCode({ root: f.root, receipt: minted.receipt }), { restored: true });
  assert.deepEqual(await ports.rollbackOwnerCode({ root: f.root, receipt: minted.receipt }), { restored: false });
  await rm(path);
  assert.deepEqual(await ports.rollbackOwnerCode({ root: f.root, receipt: minted.receipt }), { restored: false });
  assert.deepEqual(await ports.rollbackOwnerCode({ root: f.root }), { removed: false });
  // Only the two writes that changed something restarted the supervisor (remint, first rollback).
  assert.equal(restarts.length, 2);
  await writeFile(path, `${JSON.stringify({ ...original, ownerCodeDigest: digest("e") })}\n`, { mode: 0o600 });
  await assert.rejects(ports.rollbackOwnerCode({ root: f.root, receipt: minted.receipt }), /owner_code_rollback_refused/u);
});

test("bootstrap cleanup accepts only a private disjoint directory and is retry-safe", async t => {
  const f = await fixture(t, "cleanup"), bootstrapRoot = join(f.base, "bootstrap");
  await mkdir(bootstrapRoot, { mode: 0o700 }); await chmod(bootstrapRoot, 0o700);
  await writeFile(join(bootstrapRoot, "one"), "fixture");
  assert.deepEqual(await cleanupBootstrapV1({ root: f.root, bootstrapRoot }), { removed: true });
  assert.deepEqual(await cleanupBootstrapV1({ root: f.root, bootstrapRoot }), { removed: false });
  await assert.rejects(cleanupBootstrapV1({ root: f.root, bootstrapRoot: join(f.root, "nested") }),
    /bootstrap_cleanup_refused/u);
});

test("account sweep is bounded, verifies the builder launch domain, retries after failure and handles 32 callers", async () => {
  const calls = [];
  const execute = async (file, args) => { calls.push([file, args]);
    if (file === "/bin/launchctl") throw Object.assign(new Error("not found"), { code: 113 });
    return { stdout: file === "/bin/ps" ? "0\n501\n" : "" }; };
  await killAccountProcessesV1({ uid: 399, checkLaunchDomain: true }, { execute });
  assert.deepEqual(calls.map(call => call[0]), ["/usr/bin/pkill", "/bin/ps", "/bin/launchctl"]);
  await assert.rejects(killAccountProcessesV1({ uid: 399, checkLaunchDomain: true }, {
    execute: async file => ({ stdout: file === "/bin/ps" ? "0\n" : "" }),
  }), /builder_launch_domain_refused/u);
  await assert.rejects(killAccountProcessesV1({ uid: 501 }, { execute }), /account_process_sweep_refused/u);
  const burst = await Promise.all(Array.from({ length: 32 }, (_, index) => killAccountProcessesV1({ uid: 600 + index }, {
    execute: async file => ({ stdout: file === "/bin/ps" ? "0\n" : "" }),
  })));
  assert.equal(burst.length, 32);
});

