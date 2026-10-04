import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rmdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { execGuardV1, guardScratchV1 } from "./support/updater-guard.mjs";
import { createFleetReleaseTrustForTestV1 } from "./support/fleet-release.ts";
import { createMacosLaunchDaemonBundleV1 } from "../src/installer/v1/macos-launch-daemon-bundle.ts";
import { CORE_SERVICE_ROLES_V1, POST_HEALTH_SERVICE_ROLES_V1,
  SERVICE_BATCH_ROLES_V1, SERVICE_POLICY_LABELS_V1, composeServiceBundleV1, serviceBundleDigestV1 } from
  "../src/updater/v1/services/bundle.mjs";
import { createInProcessServiceElevatedPortV1, verifyPostgresShutdownV1 } from "../src/updater/v1/services/elevated.mjs";
import { installServicesV1, recoverServicesV1, restartServicesV1, startPostHealthServicesV1, uninstallServicesV1 } from
  "../src/updater/v1/services/installer.mjs";

const exec = execGuardV1;
const absent = path => access(path).then(() => false, error => error?.code === "ENOENT");
const account = (name, id) => Object.freeze({ name, uid: id, gid: id, created: true });
const accounts = (suffix = "") => Object.freeze({ builder: account(`_crbuild${suffix}`, 300),
  database: account(`_crdb${suffix}`, 301), service: account(`_controlroom${suffix}`, 302) });
const legacyAccounts = value => Object.freeze({ schema: "control-room.accounts/v1",
  accounts: Object.freeze({ builder: value.builder.name, database: value.database.name, service: value.service.name }) });
const database = (username, password) => Object.freeze({ host: "127.0.0.1", port: 5432, database: "control_room",
  username, password, majorVersion: 17 });
// `releaseTrust` is REQUIRED of a gateway configuration and is missing here, which
// MEASURED as `fleet_gateway_configuration_refused` from three updater tests after the
// merge with cook/installer - all of which pass on that branch alone, because the
// installer was written before `captureFleetGatewayConfigurationV1` began demanding it.
//
// It comes from the release, so the fixture uses the release's own test helper rather
// than a literal: a hand-written trust object would have to keep matching
// `captureReleaseTrustV1`'s exact key set and the key-id derivation, and a test that
// keeps passing while the parser tightens is a test asserting nothing.
const { trust: fixtureReleaseTrust } = createFleetReleaseTrustForTestV1();
const fleetGateway = Object.freeze({ tenantId: "tenant:fixture",
  database: database("control_room_fleet", "fixture-fleet-password"),
  workIntakeDatabase: database("control_room_work_intake_agent", "fixture-intake-password"),
  workIntakeIntegrityKey: Buffer.alloc(32, 4).toString("base64url"),
  harnessIntegrityKey: Buffer.alloc(32, 5).toString("base64url"),
  releaseTrust: fixtureReleaseTrust });
const protectedConfiguration = (root, accountName = "_controlroom") => ["host.json", "local-owner-session.json",
  "fleet-gateway.json", "supervisor.json", "backup.json", "mac-local.json", "database-roles.json", "release-trust.json"].map(name => ({
  path: join(root, "Protected", "config", name), contents: '{"fixture":true}\n', accountName,
  groupName: accountName, fileMode: "0600",
})).concat({ path: join(root, "updater-state", "updater.json"), contents: '{"fixture":true}\n',
  accountName: "root", groupName: "wheel", fileMode: "0600" });

function input(root, roles, overrides = {}) {
  const identities = overrides.accounts ?? accounts();
  const configs = overrides.protectedConfig ?? (roles.join("\0") === CORE_SERVICE_ROLES_V1.join("\0")
    ? protectedConfiguration(root, identities.service.name) : []);
  return Object.freeze({ root, accounts: identities, roles, protectedConfig: configs,
    pgRuntime: join(root, "runtime", "pg-current", "bin", "postgres"), updaterVersion: "1.2.3-a1b2c3d4e5f6",
    ...(overrides.servicePolicy ? { servicePolicy: overrides.servicePolicy } : {}) });
}

function plists(bundle) {
  return new Map(bundle.resources.filter(resource => resource.kind === "launchd_plist")
    .map(resource => [resource.role, resource.contents]));
}

test("the dependency-free generator emits byte-identical plists to the TypeScript authority for three inputs", async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "control-room-services-equivalence-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const fixtures = [accounts(), accounts("x"), Object.freeze({ builder: account("_buildz", 390),
    database: account("_dbz", 391), service: account("_servicez", 392) })];
  for (const [index, identities] of fixtures.entries()) {
    const root = join(temporary, `install-${index}`);
    const postgres = composeServiceBundleV1(input(root, ["postgresql17"], { accounts: identities }));
    const core = composeServiceBundleV1(input(root, CORE_SERVICE_ROLES_V1, { accounts: identities }));
    const postHealth = composeServiceBundleV1(input(root, POST_HEALTH_SERVICE_ROLES_V1, { accounts: identities }));
    const generated = new Map([...plists(postgres), ...plists(core), ...plists(postHealth)]);
    const legacy = createMacosLaunchDaemonBundleV1({ installRoot: root, accounts: legacyAccounts(identities),
      postgresExecutable: join(root, "runtime", "pg-current", "bin", "postgres"), fleetGateway });
    const expected = new Map(legacy.resources.filter(resource => resource.kind === "launchd_plist").map(resource => {
      const role = legacy.services.find(service => service.plistPath === resource.path).role;
      return [role, resource.contents];
    }));
    assert.deepEqual(generated, expected);
  }
});

test("the supervisor and the gateway get RUNTIME_STATE in their environment, equal to their sandbox's writable tree", async t => {
  // MEASURED (cl-svc3): `-D RUNTIME_STATE=` parameterises only the Seatbelt profile; the
  // process never sees it. The supervisor then fell back to `Protected/runtime`, which
  // the profile denies, and exited before the web host started.
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "control-room-runtime-state-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "install"), expected = join(root, "Protected", "runtime-state");
  const generated = plists(composeServiceBundleV1(input(root, CORE_SERVICE_ROLES_V1)));
  const environment = contents => Object.fromEntries([...(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/u
    .exec(contents)?.[1] ?? "").matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/gu)].map(match => [match[1], match[2]]));
  for (const role of ["supervisor", "fleet-gateway"]) {
    const contents = generated.get(role), args = programArguments(contents);
    assert.deepEqual(environment(contents), { RUNTIME_STATE: expected }, role);
    assert.equal(args[args.indexOf(`RUNTIME_STATE=${expected}`) - 1], "-D", role);
  }
  const postgres = plists(composeServiceBundleV1(input(root, ["postgresql17"]))).get("postgresql17");
  assert.equal(Object.hasOwn(environment(postgres), "RUNTIME_STATE"), false);
});

function programArguments(contents) {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(contents)?.[1] ?? "";
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map(match => match[1]
    .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"").replaceAll("&apos;", "'"));
}

function workingDirectory(contents) {
  const encoded = /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/u.exec(contents)?.[1];
  assert.notEqual(encoded, undefined, "WorkingDirectory");
  return encoded.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"").replaceAll("&apos;", "'");
}

test("every plist has an install-tree working directory and each sandbox profile explicitly permits its own", async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "control-room-service-cwd-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bundles = SERVICE_BATCH_ROLES_V1.map(roles => composeServiceBundleV1(input(temporary, roles)));
  const rendered = new Map(bundles.flatMap(bundle => [...plists(bundle)]));
  const expected = new Map([
    ["postgresql17", join(temporary, "pg", "current")], ["supervisor", join(temporary, "current")],
    ["fleet-gateway", join(temporary, "current")], ["nightly-backup", join(temporary, "current")],
    ["updater", join(temporary, "updater", "current")], ["updater-guard", join(temporary, "guard")],
  ]);
  for (const [role, contents] of rendered) assert.equal(workingDirectory(contents), expected.get(role), role);

  for (const [role, profileRole] of [["postgresql17", "postgres"], ["supervisor", "supervisor"],
    ["fleet-gateway", "gateway"]]) {
    const contents = rendered.get(role), args = programArguments(contents);
    const parameter = args.find(value => value.startsWith("WORKING_DIRECTORY="));
    assert.equal(parameter, `WORKING_DIRECTORY=${workingDirectory(contents)}`, role);
    const profile = await readFile(join(process.cwd(), `src/updater/v1/policy/service-${profileRole}.sb`), "utf8");
    assert.match(profile, /\(allow file-read-metadata \(literal \(param "WORKING_DIRECTORY"\)\)\)/u, role);
  }
});

test("every rendered plist exposes ProgramArguments", async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "control-room-guard-parser-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bundles = SERVICE_BATCH_ROLES_V1.map(roles => composeServiceBundleV1(input(temporary, roles)));
  const rendered = bundles.flatMap(bundle => [...plists(bundle)]);
  assert.deepEqual(rendered.map(([role]) => role).sort(),
    ["fleet-gateway", "nightly-backup", "postgresql17", "supervisor", "updater", "updater-guard"]);
  for (const [role, contents] of rendered) assert.equal(programArguments(contents).length > 0, true, `${role} arguments`);
  const collectorArguments = programArguments(rendered.find(([role]) => role === "updater-guard")[1]);
  const guardArguments = collectorArguments.slice(collectorArguments.indexOf("--") + 1);
  assert.deepEqual(guardArguments.slice(-1), ["watch"]);
});

test("the Mac guard arguments pass the real script parser", {
  skip: process.platform === "darwin" ? false : "Mac rescue guard requires launchd, plutil and BSD lockf",
}, async t => {
  const temporary = await guardScratchV1(t, "parser");
  await mkdir(join(temporary, "updater-state"));
  await writeFile(join(temporary, "updater-state", "heartbeat"), "fresh\n");
  const bin = join(temporary, "fake-bin"); await mkdir(bin);
  // Script parsing and native lockf remain real; service/time commands are fake.
  for (const [name, body] of [["launchctl", "exit 91"], ["date", "echo 1000000"], ["clock", "echo test-boot 1000000"],
    ["stat", "echo 1000000"], ["sleep", "exit 91"], ["pg_controldata", "exit 91"]])
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o500 });
  const contents = plists(composeServiceBundleV1(input(temporary, POST_HEALTH_SERVICE_ROLES_V1))).get("updater-guard");
  // r7sfix runs every service under its log-custody launcher (service-output.mjs);
  // the guard's own command line is what follows "--".
  const launched = programArguments(contents), separator = launched.indexOf("--");
  assert.ok(separator > 0, "the guard runs under the log-custody launcher");
  const guardArguments = launched.slice(separator + 1);
  const realGuard = join(process.cwd(), "src/updater/v1/guard/guard.sh");
  const result = await exec(guardArguments[0], [guardArguments[1], realGuard, ...guardArguments.slice(3)], {
    env: { CONTROL_ROOM_GUARD_TESTING: "1", CONTROL_ROOM_GUARD_ROOT: temporary,
      CONTROL_ROOM_GUARD_TEST_BIN: bin }, timeout: 5_000,
  });
  assert.equal(result.stderr, "");
});

async function fakeRuntime(t, name, behavior = {}) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), `control-room-services-${name}-`)));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "install"), system = join(temporary, "system"), events = [];
  await mkdir(root, { recursive: true });
  // The installer LAYOUT's two directories the protected files land in: the batch
  // writes into them and must not create or re-own them (cl-bringup N-I).
  await mkdir(join(root, "Protected", "config"), { recursive: true, mode: 0o750 });
  await mkdir(join(root, "updater-state"), { recursive: true, mode: 0o700 });
  const pathFor = path => path.startsWith("/Library/") || path.startsWith("/etc/")
    ? join(system, path.replace(/^\/+/, "")) : path;
  let command = 0;
  const loaded = new Set();
  const runtime = {
    geteuid: () => 0, pathFor, lstat, mkdir, readFile, unlink, rmdir, enforceMetadata: false,
    open: async (path, flags, mode) => { events.push(["open", path, flags]); const handle = await open(path, flags, mode);
      handle.chown = async (uid, gid) => runtime.lchown(path, uid, gid); return handle; },
    isServiceLoaded: async label => loaded.has(label),
    lchown: async (path, uid, gid) => { events.push(["lchown", path, uid, gid]); },
    verifyPostgresShutdown: async () => { events.push(["verify-postgres"]); return behavior.postgresClean !== false; },
    async execute(file, args) {
      command += 1; events.push(["execute", file, ...args]);
      await behavior.gate?.(command, args);
      if (behavior.fail?.(command, args)) throw Object.assign(new Error("fake command failure"), { code: 1 });
      if (args[0] === "bootstrap") loaded.add(args.at(-1).split("/").at(-1).replace(/\.plist$/u, ""));
      if (args[0] === "bootout") loaded.delete(args[1].replace(/^system\//u, ""));
      if (behavior.applyThenFail?.(command, args)) throw Object.assign(new Error("fake response dropped"), { code: 1 });
      behavior.abort?.(command, args);
      return { stdout: "" };
    },
  };
  return { root, system, events, runtime, pathFor };
}

const launches = events => events.filter(event => event[0] === "execute" && event[2] === "bootstrap")
  .map(event => /xyz\.agentcontrolroom\.([a-z-]+)\.plist$/u.exec(event.at(-1))[1]);
const launchEvents = events => events.filter(event => event[0] === "execute").map(event => event.slice(2));

test("a fake launchctl installs PostgreSQL, core, then post-health roles without sudo", async t => {
  const fake = await fakeRuntime(t, "two-batches");
  const port = createInProcessServiceElevatedPortV1(fake.runtime);
  const first = await installServicesV1(input(fake.root, ["postgresql17"]), { elevatedPort: port });
  assert.deepEqual(launchEvents(fake.events), [["bootstrap", "system", "/Library/LaunchDaemons/xyz.agentcontrolroom.postgres.plist"]]);
  const second = await installServicesV1(input(fake.root, CORE_SERVICE_ROLES_V1,
    { protectedConfig: protectedConfiguration(fake.root) }), { elevatedPort: port });
  const third = await installServicesV1(input(fake.root, POST_HEALTH_SERVICE_ROLES_V1), { elevatedPort: port });
  assert.equal(first.receipt.roles.join(","), "postgresql17");
  assert.deepEqual(second.receipt.roles, CORE_SERVICE_ROLES_V1);
  assert.deepEqual(third.receipt.roles, POST_HEALTH_SERVICE_ROLES_V1);
  assert.equal(fake.events.some(event => event.includes("sudo")), false);
  assert.deepEqual(launches(fake.events), ["postgres", "supervisor", "gateway", "nightly-backup", "updater", "updater-guard"]);
  const privilegedCreates = fake.events.filter(event => event[0] === "open" && (event[2] & fsConstants.O_CREAT) !== 0);
  assert.equal(privilegedCreates.length > 0, true);
  assert.equal(privilegedCreates.every(event => (event[2] & fsConstants.O_EXCL) !== 0
    && (event[2] & fsConstants.O_NOFOLLOW) !== 0), true);

  const before = launchEvents(fake.events).length;
  const retried = await installServicesV1(input(fake.root, CORE_SERVICE_ROLES_V1,
    { protectedConfig: protectedConfiguration(fake.root) }), { elevatedPort: port });
  assert.equal(retried.receipt.receiptDigest, second.receipt.receiptDigest);
  assert.equal(launchEvents(fake.events).length, before, "a completed retry does not bootstrap twice");
  await assert.rejects(installServicesV1(input(fake.root, ["postgresql17"]), { elevatedPort: {
    install: async () => ({ outcome: "rolled_back", receipt: first.receipt }),
  } }), /services_batch_uncertain/u);
});

test("rehearsal labels and every label-derived path survive install, restart, recovery and uninstall", async t => {
  const servicePolicy = SERVICE_POLICY_LABELS_V1.map(service => ({ ...service,
    label: `xyz.agentcontrolroom.rehearsal.${service.role}`,
    plistPath: `/Library/LaunchDaemons/xyz.agentcontrolroom.rehearsal.${service.role}.plist`,
  }));
  const fake = await fakeRuntime(t, "rehearsal-policy"), port = createInProcessServiceElevatedPortV1(fake.runtime);
  const coreInput = input(fake.root, CORE_SERVICE_ROLES_V1, { servicePolicy });
  const coreBundle = composeServiceBundleV1(coreInput);
  await assert.rejects(async () => composeServiceBundleV1(input(fake.root, CORE_SERVICE_ROLES_V1, {
    servicePolicy: servicePolicy.map((service, index) => index === 0
      ? { ...service, plistPath: "/Library/LaunchDaemons/wrong.plist" } : service),
  })), /services_batch_uncertain/u);
  assert(coreBundle.services.every(service => service.label.startsWith("xyz.agentcontrolroom.rehearsal.")));
  assert(coreBundle.resources.some(resource => resource.kind === "newsyslog_config"
    && resource.path === "/etc/newsyslog.d/xyz.agentcontrolroom.rehearsal.supervisor.conf"));
  const installed = await installServicesV1(coreInput, { elevatedPort: port });
  await restartServicesV1({ root: fake.root, roles: ["supervisor"], servicePolicy }, { elevatedPort: port });
  assert(launchEvents(fake.events).some(args => args.join(" ")
    === "kickstart -k system/xyz.agentcontrolroom.rehearsal.supervisor"));
  fake.events.length = 0;
  await recoverServicesV1({ root: fake.root, roles: CORE_SERVICE_ROLES_V1, receipt: installed.receipt, servicePolicy },
    { elevatedPort: port });
  assert.deepEqual(launchEvents(fake.events).filter(args => args[0] === "bootout"), [
    ["bootout", "system/xyz.agentcontrolroom.rehearsal.fleet-gateway"],
    ["bootout", "system/xyz.agentcontrolroom.rehearsal.supervisor"],
  ]);

  const second = await fakeRuntime(t, "rehearsal-uninstall"), secondPort = createInProcessServiceElevatedPortV1(second.runtime);
  const databaseInput = input(second.root, ["postgresql17"], { servicePolicy });
  const database = await installServicesV1(databaseInput, { elevatedPort: secondPort }); second.events.length = 0;
  await uninstallServicesV1({ root: second.root, receipt: database.receipt, servicePolicy }, { elevatedPort: secondPort });
  assert.deepEqual(launchEvents(second.events)[0], ["bootout", "system/xyz.agentcontrolroom.rehearsal.postgresql17"]);
});

test("every launch position rolls back only the services already started, in reverse order", async t => {
  for (const roles of SERVICE_BATCH_ROLES_V1) {
    for (let failure = 1; failure <= roles.length; failure += 1) {
      await t.test(`${roles[0]} failure ${failure}`, async inner => {
        let bootstraps = 0;
        const fake = await fakeRuntime(inner, `rollback-${roles[0]}-${failure}`, {
          fail: (_command, args) => args[0] === "bootstrap" && ++bootstraps === failure,
        });
        const port = createInProcessServiceElevatedPortV1(fake.runtime);
        const batch = input(fake.root, roles);
        await assert.rejects(installServicesV1(batch, { elevatedPort: port }), /services_batch_rolled_back/u);
        const commands = launchEvents(fake.events), booted = commands.filter(args => args[0] === "bootout")
          .map(args => args[1].split(".").at(-1));
        const started = new Set(roles.slice(0, failure - 1));
        const expected = SERVICE_POLICY_LABELS_V1.filter(service => started.has(service.role))
          .map(service => service.label.split(".").at(-1));
        assert.deepEqual(booted, expected);
        for (const resource of composeServiceBundleV1(batch).resources) assert.equal(await absent(fake.pathFor(resource.path)), true);
      });
    }
  }
});

test("fixed complete policy labels drive receipt and planned-row recovery for every batch", async t => {
  assert.deepEqual(SERVICE_POLICY_LABELS_V1.map(service => service.role),
    ["updater-guard", "updater", "nightly-backup", "fleet-gateway", "supervisor", "postgresql17"]);
  for (const roles of SERVICE_BATCH_ROLES_V1) {
    await t.test(roles[0], async inner => {
      const fake = await fakeRuntime(inner, `recover-${roles[0]}`), port = createInProcessServiceElevatedPortV1(fake.runtime);
      const installed = await installServicesV1(input(fake.root, roles), { elevatedPort: port });
      fake.events.length = 0;
      const recovered = await recoverServicesV1({ root: fake.root, roles, receipt: installed.receipt }, { elevatedPort: port });
      assert.equal(recovered.usedReceipt, true);
      const expected = SERVICE_POLICY_LABELS_V1.filter(service => roles.includes(service.role))
        .map(service => ["bootout", `system/${service.label}`]);
      assert.deepEqual(launchEvents(fake.events), expected);
      for (const resource of installed.receipt.resources) assert.equal(await absent(fake.pathFor(resource.path)), true);

      const otherRoles = roles === SERVICE_BATCH_ROLES_V1[0] ? SERVICE_BATCH_ROLES_V1[1] : SERVICE_BATCH_ROLES_V1[0];
      await assert.rejects(recoverServicesV1({ root: fake.root, roles: otherRoles, receipt: installed.receipt },
        { elevatedPort: port }), /services_batch_uncertain/u);

      fake.events.length = 0;
      const planned = await recoverServicesV1({ root: fake.root, roles }, { elevatedPort: port });
      assert.equal(planned.usedReceipt, false);
      assert.deepEqual(launchEvents(fake.events), expected);
    });
  }
});

test("uninstall boots PostgreSQL out before clean-shutdown proof and removes only receipt files", async t => {
  const fake = await fakeRuntime(t, "uninstall");
  const port = createInProcessServiceElevatedPortV1(fake.runtime);
  const installed = await installServicesV1(input(fake.root, ["postgresql17"]), { elevatedPort: port });
  fake.events.length = 0;
  await uninstallServicesV1({ root: fake.root, receipt: installed.receipt }, { elevatedPort: port });
  assert.deepEqual(launchEvents(fake.events)[0], ["bootout", "system/xyz.agentcontrolroom.postgres"]);
  assert.equal(fake.events.findIndex(event => event[0] === "verify-postgres") >
    fake.events.findIndex(event => event[0] === "execute"), true);
  assert.equal(await absent(fake.pathFor(installed.receipt.resources[0].path)), true);
});

test("unclean PostgreSQL and changed receipt files fail closed without deletion", async t => {
  const dirty = await fakeRuntime(t, "unclean", { postgresClean: false });
  const dirtyPort = createInProcessServiceElevatedPortV1(dirty.runtime);
  const installed = await installServicesV1(input(dirty.root, ["postgresql17"]), { elevatedPort: dirtyPort });
  await assert.rejects(uninstallServicesV1({ root: dirty.root, receipt: installed.receipt }, { elevatedPort: dirtyPort }),
    /postgres_not_shut_down/u);
  assert.equal(await absent(dirty.pathFor(installed.receipt.resources[0].path)), false);

  const forged = structuredClone(installed.receipt);
  forged.resources[0].path = "/Library/LaunchDaemons/unrelated.plist";
  forged.receiptDigest = serviceBundleDigestV1({ schema: forged.schema, root: forged.root,
    bundleDigest: forged.bundleDigest, roles: forged.roles, services: forged.services, resources: forged.resources });
  await assert.rejects(uninstallServicesV1({ root: dirty.root, receipt: forged }, { elevatedPort: dirtyPort }),
    /services_batch_uncertain/u);

  const application = await fakeRuntime(t, "forged-protected");
  const applicationPort = createInProcessServiceElevatedPortV1(application.runtime);
  const applicationInstall = await installServicesV1(input(application.root, CORE_SERVICE_ROLES_V1),
    { elevatedPort: applicationPort });
  const retargeted = structuredClone(applicationInstall.receipt);
  retargeted.resources.find(resource => resource.kind === "protected_config").path = join(application.root, "unrelated");
  retargeted.receiptDigest = serviceBundleDigestV1({ schema: retargeted.schema, root: retargeted.root,
    bundleDigest: retargeted.bundleDigest, roles: retargeted.roles, services: retargeted.services,
    resources: retargeted.resources });
  await assert.rejects(uninstallServicesV1({ root: application.root, receipt: retargeted },
    { elevatedPort: applicationPort }), /services_batch_uncertain/u);

  const changed = await fakeRuntime(t, "changed-file");
  const changedPort = createInProcessServiceElevatedPortV1(changed.runtime);
  const changedInstall = await installServicesV1(input(changed.root, ["postgresql17"]), { elevatedPort: changedPort });
  const changedPath = changed.pathFor(changedInstall.receipt.resources[0].path);
  await writeFile(changedPath, "changed bytes\n");
  await assert.rejects(uninstallServicesV1({ root: changed.root, receipt: changedInstall.receipt },
    { elevatedPort: changedPort }), /services_batch_uncertain/u);
  assert.equal(await absent(changedPath), false);
});

test("restart uses kickstart -k for only the requested roles", async t => {
  const fake = await fakeRuntime(t, "restart");
  const port = createInProcessServiceElevatedPortV1(fake.runtime);
  const result = await restartServicesV1({ root: fake.root, roles: ["supervisor", "updater"] }, { elevatedPort: port });
  assert.deepEqual(result.restarted, ["supervisor", "updater"]);
  assert.deepEqual(launchEvents(fake.events), [
    ["kickstart", "-k", "system/xyz.agentcontrolroom.supervisor"],
    ["kickstart", "-k", "system/xyz.agentcontrolroom.updater"],
  ]);
});

function heartbeatRuntime(sequence, onSleep) {
  let now = 1_000, index = 0;
  return {
    now: () => now,
    sleep: async milliseconds => { now += milliseconds; onSleep?.(); },
    read: async () => {
      const value = sequence[Math.min(index, sequence.length - 1)]; index += 1;
      if (value instanceof Error) throw value;
      const at = value === "fresh" ? now : now - 1;
      return `${JSON.stringify({ schema: "control-room.updater-heartbeat/v1", at: new Date(at).toISOString() })}\n`;
    },
  };
}

test("step 27b requires health and known-good, accepts a fresh heartbeat, and bootouts on failure", async t => {
  const precondition = await fakeRuntime(t, "post-health-precondition");
  await assert.rejects(startPostHealthServicesV1(input(precondition.root, POST_HEALTH_SERVICE_ROLES_V1), {
    elevatedPort: createInProcessServiceElevatedPortV1(precondition.runtime), healthAccepted: false,
    knownGoodAccepted: true, heartbeatRuntime: heartbeatRuntime(["fresh"]),
  }), /services_batch_uncertain/u);
  await assert.rejects(startPostHealthServicesV1(input(precondition.root, POST_HEALTH_SERVICE_ROLES_V1), {
    elevatedPort: createInProcessServiceElevatedPortV1(precondition.runtime), healthAccepted: true,
    knownGoodAccepted: false, heartbeatRuntime: heartbeatRuntime(["fresh"]),
  }), /services_batch_uncertain/u);

  const accepted = await fakeRuntime(t, "post-health-accepted"), acceptedPort = createInProcessServiceElevatedPortV1(accepted.runtime);
  const result = await startPostHealthServicesV1(input(accepted.root, POST_HEALTH_SERVICE_ROLES_V1), {
    elevatedPort: acceptedPort, healthAccepted: true, knownGoodAccepted: true,
    heartbeatRuntime: heartbeatRuntime(["stale", "fresh"]), heartbeatTimeoutMs: 5, heartbeatPollMs: 1,
  });
  assert.equal(result.heartbeat.accepted, true);
  assert.equal(result.heartbeat.at, new Date(1_001).toISOString(), "a stale pre-step heartbeat is not acceptance");
  assert.deepEqual(launches(accepted.events), ["nightly-backup", "updater", "updater-guard"]);

  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const refused = await fakeRuntime(t, "post-health-refused"), refusedPort = createInProcessServiceElevatedPortV1(refused.runtime);
  const batch = input(refused.root, POST_HEALTH_SERVICE_ROLES_V1);
  await assert.rejects(startPostHealthServicesV1(batch, { elevatedPort: refusedPort, healthAccepted: true,
    knownGoodAccepted: true, heartbeatRuntime: heartbeatRuntime([missing]), heartbeatTimeoutMs: 3, heartbeatPollMs: 1,
  }), /services_heartbeat_refused/u);
  assert.deepEqual(launchEvents(refused.events).filter(args => args[0] === "bootout"), [
    ["bootout", "system/xyz.agentcontrolroom.updater-guard"],
    ["bootout", "system/xyz.agentcontrolroom.updater"],
    ["bootout", "system/xyz.agentcontrolroom.nightly-backup"],
  ]);
  for (const resource of composeServiceBundleV1(batch).resources) assert.equal(await absent(refused.pathFor(resource.path)), true);
  await startPostHealthServicesV1(batch, { elevatedPort: refusedPort, healthAccepted: true, knownGoodAccepted: true,
    heartbeatRuntime: heartbeatRuntime(["fresh"]), heartbeatTimeoutMs: 3, heartbeatPollMs: 1,
  });

  const controller = new AbortController();
  const stopped = await fakeRuntime(t, "post-health-stopped"), stoppedPort = createInProcessServiceElevatedPortV1(stopped.runtime);
  await assert.rejects(startPostHealthServicesV1(input(stopped.root, POST_HEALTH_SERVICE_ROLES_V1), {
    elevatedPort: stoppedPort, healthAccepted: true, knownGoodAccepted: true, signal: controller.signal,
    heartbeatRuntime: heartbeatRuntime([missing], () => controller.abort()), heartbeatTimeoutMs: 3, heartbeatPollMs: 1,
  }), /services_heartbeat_refused/u);
  assert.equal(launchEvents(stopped.events).filter(args => args[0] === "bootout").length, 3);
});

test("bad input, a dropped command, stop halfway and a forty-caller burst fail safely", async t => {
  const invalidRoot = await fakeRuntime(t, "bad-input");
  assert.throws(() => composeServiceBundleV1({ ...input(invalidRoot.root, ["postgresql17"]), extra: true }),
    /services_batch_uncertain/u);
  assert.throws(() => composeServiceBundleV1(input(invalidRoot.root, ["postgresql17", "supervisor"])),
    /services_batch_uncertain/u);
  assert.throws(() => composeServiceBundleV1({ ...input(invalidRoot.root, ["postgresql17"]),
    pgRuntime: join(invalidRoot.root, "current", "postgres") }), /services_batch_uncertain/u);
  assert.throws(() => composeServiceBundleV1({ ...input(invalidRoot.root, ["postgresql17"]),
    pgRuntime: join(invalidRoot.root, "current", "bin", "postgres") }), /services_batch_uncertain/u);
  assert.throws(() => composeServiceBundleV1({ ...input(invalidRoot.root, ["postgresql17"]),
    protectedConfig: protectedConfiguration(invalidRoot.root) }), /services_batch_uncertain/u);
  assert.throws(() => composeServiceBundleV1({ ...input(invalidRoot.root, CORE_SERVICE_ROLES_V1),
    protectedConfig: [] }), /services_batch_uncertain/u);

  let drop = true;
  const dropped = await fakeRuntime(t, "dropped", { fail: (_command, args) => drop && args[0] === "bootstrap" });
  const droppedPort = createInProcessServiceElevatedPortV1(dropped.runtime);
  await assert.rejects(installServicesV1(input(dropped.root, ["postgresql17"]),
    { elevatedPort: droppedPort }), /services_batch_rolled_back/u);
  drop = false;
  await installServicesV1(input(dropped.root, ["postgresql17"]), { elevatedPort: droppedPort });

  let responseDrop = true;
  const ambiguous = await fakeRuntime(t, "ambiguous", {
    applyThenFail: (_command, args) => responseDrop && args[0] === "bootstrap",
  });
  const ambiguousPort = createInProcessServiceElevatedPortV1(ambiguous.runtime);
  await assert.rejects(installServicesV1(input(ambiguous.root, ["postgresql17"]),
    { elevatedPort: ambiguousPort }), /services_batch_rolled_back/u);
  assert.equal(launchEvents(ambiguous.events).some(args => args[0] === "bootout"), true);
  responseDrop = false;
  await installServicesV1(input(ambiguous.root, ["postgresql17"]), { elevatedPort: ambiguousPort });

  const controller = new AbortController();
  const stopped = await fakeRuntime(t, "stopped", { abort: (_command, args) => {
    if (args[0] === "bootstrap") controller.abort();
  } });
  const stoppedInput = input(stopped.root, ["postgresql17"]);
  await assert.rejects(installServicesV1(stoppedInput, {
    elevatedPort: createInProcessServiceElevatedPortV1(stopped.runtime), signal: controller.signal,
  }), /services_batch_rolled_back/u);
  assert.equal(launchEvents(stopped.events).some(args => args[0] === "bootout"), true);
  for (const resource of composeServiceBundleV1(stoppedInput).resources) {
    assert.equal(await absent(stopped.pathFor(resource.path)), true);
  }

  const interrupted = await fakeRuntime(t, "interrupted-files");
  const interruptedInput = input(interrupted.root, ["postgresql17"]);
  const interruptedBundle = composeServiceBundleV1(interruptedInput), planted = interruptedBundle.resources[0];
  await mkdir(dirname(interrupted.pathFor(planted.path)), { recursive: true });
  await writeFile(interrupted.pathFor(planted.path), planted.contents, { mode: Number.parseInt(planted.mode, 8) });
  await installServicesV1(interruptedInput,
    { elevatedPort: createInProcessServiceElevatedPortV1(interrupted.runtime) });

  const corrupt = await fakeRuntime(t, "corrupt-files");
  const corruptInput = input(corrupt.root, ["postgresql17"]), corruptBundle = composeServiceBundleV1(corruptInput);
  await mkdir(dirname(corrupt.pathFor(corruptBundle.resources[0].path)), { recursive: true });
  await writeFile(corrupt.pathFor(corruptBundle.resources[0].path), "wrong bytes\n");
  await assert.rejects(installServicesV1(corruptInput,
    { elevatedPort: createInProcessServiceElevatedPortV1(corrupt.runtime) }), /services_batch_uncertain/u);

  let rollbackBootstraps = 0;
  const stuck = await fakeRuntime(t, "rollback-bootout-refused", { fail: (_command, args) => {
    if (args[0] === "bootstrap") return ++rollbackBootstraps === 2;
    return args[0] === "bootout";
  } });
  const stuckInput = input(stuck.root, CORE_SERVICE_ROLES_V1);
  await assert.rejects(installServicesV1(stuckInput,
    { elevatedPort: createInProcessServiceElevatedPortV1(stuck.runtime) }), /services_batch_uncertain/u);
  const stuckResource = composeServiceBundleV1(stuckInput).resources[0];
  assert.equal(await absent(stuck.pathFor(stuckResource.path)), false,
    "a possibly loaded daemon keeps the plist needed for recovery");

  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const atGate = new Promise(resolve => { entered = resolve; });
  const burst = await fakeRuntime(t, "burst", { gate: async (_command, args) => {
    if (args[0] === "bootstrap") { entered(); await gate; }
  } });
  const port = createInProcessServiceElevatedPortV1(burst.runtime), batch = input(burst.root, ["postgresql17"]);
  const calls = Array.from({ length: 40 }, () => installServicesV1(batch, { elevatedPort: port })
    .then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason })));
  await atGate;
  const inspectedAtGate = burst.events.filter(event => event[0] === "open").length;
  await Promise.all(Array.from({ length: 50 }, () => assert.rejects(installServicesV1(batch, { elevatedPort: port }))));
  assert.equal(burst.events.filter(event => event[0] === "open").length, inspectedAtGate,
    "rejected concurrent callers never enter privileged filesystem inspection");
  release();
  const settled = await Promise.all(calls);
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter(result => result.status === "rejected").length, 39);
});

test("the postgres shutdown check answers yes with no cluster, and still asks pg_controldata when there is one", async t => {
  // atk-fa F3: after a rollback retired the data folder (or before initdb made one), the
  // check ran pg_controldata on a cluster that did not exist and refused every retry.
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-pg-shutdown-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], execute = async (file, args) => { calls.push([file, ...args]); return { stdout: "Database cluster state:               in production\n" }; };
  await mkdir(join(root, "pg", "socket"), { recursive: true });
  assert.equal(await verifyPostgresShutdownV1({ root, execute }), true);
  await symlink("data-retired", join(root, "pg", "current"));
  assert.equal(await verifyPostgresShutdownV1({ root, execute }), true, "a dangling pg/current is no cluster");
  assert.deepEqual(calls, []);
  await mkdir(join(root, "pg", "data-retired"));
  await mkdir(join(root, "runtime/pg-current/bin"), { recursive: true });
  await writeFile(join(root, "runtime/pg-current/bin/pg_controldata"), "fixture");
  assert.equal(await verifyPostgresShutdownV1({ root, execute }), false, "a cluster pg_controldata does not call shut down");
  assert.equal(calls.length, 1);
  await writeFile(join(root, "pg", "data-retired", "postmaster.pid"), "1\n");
  assert.equal(await verifyPostgresShutdownV1({ root, execute }), false);
  await rm(join(root, "pg", "current"));
  await writeFile(join(root, "pg", "socket", ".s.PGSQL.5432"), "");
  assert.equal(await verifyPostgresShutdownV1({ root, execute }), false, "a live socket is never shut down");
});
