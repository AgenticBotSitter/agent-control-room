import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { captureFleetGatewayConfigurationV1 } from "../scripts/run-fleet-gateway.ts";
import { parseNightlyBackupConfigurationV1 } from "../src/installer/v1/nightly-backup-configuration.ts";
import { captureLocalOwnerSessionProfileV1 } from "../src/web/v1/local-owner-session.ts";
import { parsePasskeyConfigV1 } from "../src/updater/v1/passkey.mjs";
import { CORE_SERVICE_ROLES_V1, composeServiceBundleV1 } from "../src/updater/v1/services/bundle.mjs";
import { createInProcessServiceElevatedPortV1 } from "../src/updater/v1/services/elevated.mjs";
import { installServicesV1 } from "../src/updater/v1/services/installer.mjs";
import { composeProtectedConfigV1 as compose } from "../src/updater/v1/services/protected-config.mjs";
import { createFleetReleaseTrustForTestV1 } from "./support/fleet-release.ts";
import { INSTALL_DATABASE_LOGINS_V1 } from "../src/updater/v1/install/install-steps.mjs";
import { loadUpdaterConfigurationV1, startUpdaterV1 } from "../src/updater/v1/updater.mjs";

import * as releaseParsers from "../src/web/v1/mac-local-protected-loader.ts";
import { captureReleaseTrustV1 } from "../scripts/release-signing.mjs";
const composeProtectedConfigV1 = input => compose(input, { ...releaseParsers, captureReleaseTrustV1 });
const secret = byte => Buffer.alloc(32, byte).toString("base64url");
const digest = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const account = (name, id) => Object.freeze({ name, uid: id, gid: id, created: true });
const accounts = Object.freeze({ builder: account("_crbuild", 300), database: account("_crdb", 301),
  service: account("_controlroom", 302) });

async function fixture(t, name = "golden", short = false) {
  const base = await realpath(await mkdtemp(join(short ? "/private/tmp" : tmpdir(), `cr-${name}-`)));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "install");
  await mkdir(join(root, "Protected", "config"), { recursive: true, mode: 0o750 });
  await mkdir(join(root, "Protected", "service"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "Protected", "runtime-state"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "updater-state"), { recursive: true, mode: 0o700 });
  await chmod(join(root, "Protected", "config"), 0o750);
  await chmod(join(root, "Protected", "service"), 0o700);
  await chmod(join(root, "updater-state"), 0o700);
  // EXACTLY the installer's login list (`install-steps.mjs` `makeCredentials` →
  // `writeDatabaseLogins` → these references). It has no deployer: a fixture that
  // supplied one is how the composer came to require a password nobody generates.
  const loginNames = [...INSTALL_DATABASE_LOGINS_V1];
  const dbLogins = loginNames.map((login, index) => {
    const password = secret(index + 10);
    return Object.freeze({ name: login, password, passwordDigest: digest(password),
      fileRef: join(root, "Protected", "config", "database-passwords", `${login}.txt`) });
  });
  // `releaseTrust` is now a REQUIRED composer input, because the gateway's own parser
  // requires it: MEASURED, three updater tests answered `fleet_gateway_configuration_refused`
  // after the merge with cook/installer, all of which pass on that branch alone - the
  // installer was written before `captureFleetGatewayConfigurationV1` began demanding it.
  //
  // The fixture uses the RELEASE's own test helper rather than a literal, for the reason
  // the key-id derivation matters: a hand-written trust object has to keep matching
  // `captureReleaseTrustV1`'s exact key set and its key-id derivation from the public key,
  // and a fixture that keeps passing while the parser tightens asserts nothing.
  const { trust: releaseTrust } = createFleetReleaseTrustForTestV1();
  const input = Object.freeze({ root, accounts, installationId: "installation-one", rpId: "control.example.ts.net",
    webPort: 3210, gatewayPort: 8443, releaseTrust,
    tenant: Object.freeze({ tenantId: "tenant:one", workspaceId: "workspace:one", provider: "local-owner",
      subject: "owner:one" }), ownerCodeDigest: digest("owner-code"), dbLogins: Object.freeze(dbLogins),
    keys: Object.freeze({ vapidPrivate: join(root, "updater-state", "vapid.json"),
      vapidPublic: join(root, "Protected", "service", "vapid-public.json"),
      healthProbeRoot: join(root, "updater-state", "health-probe.key"),
      healthProbeService: join(root, "Protected", "service", "health-probe.key"),
      webHmac: Object.freeze({ fileRef: join(root, "Protected", "service", "web-hmac.key"), value: secret(40) }),
      workIntake: Object.freeze({ fileRef: join(root, "Protected", "service", "work-intake.json"),
        integrityKey: secret(41) }) }) });
  return { base, root, input, secrets: [...dbLogins.map(login => login.password), secret(40), secret(41)] };
}

const parsedResource = (resources, name) => JSON.parse(resources.find(resource => resource.path.endsWith(`/${name}`)).contents);

test("release parsers accept every protected golden and the composer is deterministic", async t => {
  const f = await fixture(t), first = composeProtectedConfigV1(f.input), second = composeProtectedConfigV1(f.input);
  assert.deepEqual(second, first);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(first.map(resource => resource.path), ["host.json", "local-owner-session.json", "fleet-gateway.json",
    "supervisor.json", "backup.json", "mac-local.json", "database-roles.json", "release-trust.json"].map(name => join(f.root, "Protected", "config", name))
    .concat(join(f.root, "updater-state", "updater.json")));
  assert.equal(first.every(resource => resource.fileMode === (resource.accountName === "root" && resource.groupName === accounts.service.name ? "0640" : "0600")), true);
  assert.deepEqual(parsePasskeyConfigV1(parsedResource(first, "host.json")), {
    installationId: "installation-one", rpId: "control.example.ts.net", expectedOrigin: "https://control.example.ts.net",
  });
  const owner = captureLocalOwnerSessionProfileV1(parsedResource(first, "local-owner-session.json"));
  assert.equal(owner.tenantId, "tenant:one"); assert.deepEqual(owner.remoteOrigins, ["https://control.example.ts.net"]);
  const gateway = captureFleetGatewayConfigurationV1(parsedResource(first, "fleet-gateway.json"));
  assert.equal(gateway.database.username, "control_room_fleet");
  assert.equal(gateway.workIntake.database.username, "control_room_work_intake_agent");
  assert.equal(gateway.trustedClientHeader, "none"); assert.deepEqual(gateway.trustedProxyAddresses, []);
  const backupPath = join(f.root, "Protected", "config", "backup.json");
  assert.deepEqual(parseNightlyBackupConfigurationV1(backupPath, parsedResource(first, "backup.json")),
    parsedResource(first, "backup.json"));
  assert.equal(parsedResource(first, "supervisor.json").workspaceId, "workspace:one");
});

test("every composed database entry is the install's socket directory, never TCP (cl-bringup N-F)", async t => {
  // The installed cluster is socket-only (`listen_addresses = ''`): a TCP host here
  // means no service can ever connect.
  const f = await fixture(t), resources = composeProtectedConfigV1(f.input), socket = join(f.root, "pg", "socket");
  const hosts = [];
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "host") && Object.hasOwn(value, "port")) hosts.push([value.host, value.port]);
    Object.values(value).forEach(visit);
  };
  for (const resource of resources) visit(JSON.parse(resource.contents));
  // web, the six role entries, gateway + its work-intake login, backup, updater.
  assert.ok(hosts.length >= 12, String(hosts.length));
  assert.deepEqual([...new Set(hosts.map(([host, port]) => `${host}:${port}`))], [`${socket}:5432`]);
});

test("the composer accepts exactly the installer's login list, which carries no deployer password", async t => {
  // cl-bringup: the deployer is peer-only, so `install-steps` never generates its
  // password. Requiring one refused every real install at `install-services`.
  const f = await fixture(t, "installer-logins");
  assert.equal(INSTALL_DATABASE_LOGINS_V1.includes("control_room_deployer"), false);
  const resources = composeProtectedConfigV1(f.input);
  assert.equal(JSON.parse(resources.find(resource => resource.path.endsWith("/updater.json")).contents).database.user,
    "control_room_deployer", "the updater still names the deployer, with no password");
  for (const missing of ["control_room_fleet", "control_room_migrator", "control_room_web", "control_room_work_intake_agent"]) {
    assert.throws(() => composeProtectedConfigV1({ ...f.input,
      dbLogins: f.input.dbLogins.filter(login => login.name !== missing) }), /protected_configuration_input_refused/u, missing);
  }
});

test("release web schema refuses invalid workspace identity before output", async t => {
  const f = await fixture(t, "identity-encoding");
  assert.throws(() => composeProtectedConfigV1({ ...f.input,
    tenant: { ...f.input.tenant, workspaceId: "workspace\0nul" } }), /mac_local_protected_configuration_invalid/u);
});

test("bad, missing, injected, and unknown input is refused before any output", async t => {
  const f = await fixture(t, "bad-input");
  const changes = [
    { ...f.input, extra: true },
    { ...f.input, root: "relative" },
    { ...f.input, accounts: { ...f.input.accounts, service: f.input.accounts.database } },
    { ...f.input, installationId: "installation\nother" },
    { ...f.input, rpId: "127.0.0.1" },
    { ...f.input, webPort: 80 },
    { ...f.input, ownerCodeDigest: "sha256:short" },
    { ...f.input, tenant: { ...f.input.tenant, extra: true } },
    { ...f.input, tenant: { tenantId: "tenant", workspaceId: "workspace", provider: "provider" } },
    { ...f.input, tenant: { ...f.input.tenant, subject: 42 } },
    { ...f.input, dbLogins: f.input.dbLogins.map(login => login.name === "control_room_fleet" ? f.input.dbLogins[0] : login) },
    { ...f.input, dbLogins: f.input.dbLogins.map((login, index) => index ? login : { ...login, passwordDigest: digest("wrong") }) },
    { ...f.input, dbLogins: f.input.dbLogins.map((login, index) => index ? login : { ...login, extra: true }) },
    { ...f.input, dbLogins: f.input.dbLogins.map((login, index) => index ? login : { ...login, fileRef: join(f.root, "outside") }) },
    { ...f.input, keys: { ...f.input.keys, webHmac: { ...f.input.keys.webHmac, value: "short" } } },
    { ...f.input, keys: { ...f.input.keys, vapidPublic: join(f.root, "wrong") } },
    { ...f.input, webPort: f.input.gatewayPort },
  ];
  for (const changed of changes) assert.throws(() => composeProtectedConfigV1(changed),
    /protected_configuration_input_refused/u);
});

function serviceInput(root, protectedConfig) {
  return Object.freeze({ root, accounts, roles: CORE_SERVICE_ROLES_V1, protectedConfig,
    pgRuntime: join(root, "runtime", "pg-current", "bin", "postgres"), updaterVersion: "1.2.3-a1b2c3d4e5f6" });
}

function fakeElevatedRuntime(base, chownHandle) {
  const system = join(base, "system"), loaded = new Set();
  const pathFor = path => path.startsWith("/Library/") || path.startsWith("/etc/")
    ? join(system, path.replace(/^\/+/, "")) : path;
  return Object.freeze({ geteuid: () => 0, pathFor, lstat, mkdir, readFile, unlink, rmdir,
    enforceMetadata: false, open: async (path, flags, mode) => { const handle = await open(path, flags, mode);
      handle.chown = async (uid, gid) => chownHandle?.(path, uid, gid); return handle; }, lchown: async () => {},
    isServiceLoaded: async label => loaded.has(label), verifyPostgresShutdown: async () => true,
    async execute(_file, args) {
      if (args[0] === "bootstrap") loaded.add(args.at(-1).split("/").at(-1).replace(/\.plist$/u, ""));
      if (args[0] === "bootout") loaded.delete(args[1].replace(/^system\//u, ""));
      return { stdout: "" };
    } });
}

async function regularFiles(root) {
  const output = [];
  async function walk(path) {
    for (const name of await readdir(path)) {
      const child = join(path, name), entry = await lstat(child);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) output.push({ path: child, mode: entry.mode & 0o777, contents: await readFile(child, "utf8") });
    }
  }
  await walk(root); return output;
}

test("the elevated batch writes secrets only to private or root service-readable files and scans every written file", async t => {
  const f = await fixture(t, "secret-scan"), protectedConfig = composeProtectedConfigV1(f.input);
  const port = createInProcessServiceElevatedPortV1(fakeElevatedRuntime(f.base));
  const result = await installServicesV1(serviceInput(f.root, protectedConfig), { elevatedPort: port });
  assert.equal(result.receipt.resources.length, 12);
  const written = await regularFiles(f.base);
  assert.equal(written.length >= result.receipt.resources.length, true);
  for (const file of written) {
    if (file.mode === 0o644) {
      for (const value of f.secrets) assert.equal(file.contents.includes(value), false, file.path);
    }
  }
  const protectedFiles = written.filter(file => file.path.includes("/Protected/config/")
    || file.path.endsWith("/updater-state/updater.json"));
  assert.equal(protectedFiles.length, 9); assert.equal(protectedFiles.every(file => file.mode === (file.path.includes("/Protected/config/") ? 0o640 : 0o600)), true);
});

test("a symlinked target and a group-writable target parent are refused without damage", async t => {
  const linked = await fixture(t, "symlink"), outside = join(linked.base, "outside");
  await writeFile(outside, "untouched\n", { mode: 0o600 });
  await symlink(outside, join(linked.root, "Protected", "config", "host.json"));
  await assert.rejects(installServicesV1(serviceInput(linked.root, composeProtectedConfigV1(linked.input)), {
    elevatedPort: createInProcessServiceElevatedPortV1(fakeElevatedRuntime(linked.base)),
  }));
  assert.equal(await readFile(outside, "utf8"), "untouched\n");

  const writable = await fixture(t, "writable-parent");
  await chmod(join(writable.root, "Protected", "config"), 0o770);
  await assert.rejects(installServicesV1(serviceInput(writable.root, composeProtectedConfigV1(writable.input)), {
    elevatedPort: createInProcessServiceElevatedPortV1(fakeElevatedRuntime(writable.base)),
  }), /services_batch_rolled_back/u);
  await assert.rejects(lstat(join(writable.root, "Protected", "config", "host.json")), /ENOENT/u);
});

test("the elevated batch writes protected config into the layout's directories without re-owning them (cl-bringup N-I)", async t => {
  // `Protected/config` is root:SERVICE 0750 so the service account can enter it.
  // Re-owning it root:wheel locked the web host and the gateway out of every file
  // they read; the batch may own the files it writes, never their directories.
  const f = await fixture(t, "layout-owner"), chowned = [];
  const runtime = fakeElevatedRuntime(f.base, async (path, uid, gid) => { chowned.push([path, uid, gid]); });
  await installServicesV1(serviceInput(f.root, composeProtectedConfigV1(f.input)),
    { elevatedPort: createInProcessServiceElevatedPortV1(runtime) });
  const touched = chowned.map(([path]) => path);
  for (const directory of [join(f.root, "Protected"), join(f.root, "Protected", "config"), join(f.root, "updater-state")]) {
    assert.equal(touched.includes(directory), false, `${directory} must keep the layout's owner`);
  }
  assert.ok(touched.includes(join(f.root, "Protected", "config", "fleet-gateway.json")), "the files are still owned");
  // A MISSING layout directory is a refusal, not a root:wheel directory made on the spot.
  const missing = await fixture(t, "layout-missing");
  await rm(join(missing.root, "Protected", "config"), { recursive: true });
  await assert.rejects(installServicesV1(serviceInput(missing.root, composeProtectedConfigV1(missing.input)), {
    elevatedPort: createInProcessServiceElevatedPortV1(fakeElevatedRuntime(missing.base)) }));
  await assert.rejects(lstat(join(missing.root, "Protected", "config")), /ENOENT/u);
});

test("fifty parallel pure callers produce one byte-identical golden", async t => {
  const f = await fixture(t, "parallel"), expected = composeProtectedConfigV1(f.input);
  const results = await Promise.all(Array.from({ length: 50 }, async () => composeProtectedConfigV1(f.input)));
  assert.equal(results.length, 50); for (const result of results) assert.deepEqual(result, expected);
});

class FakePgClient {
  static options = [];
  constructor(options) { this.options = options; FakePgClient.options.push(options); }
  async connect() {}
  async end() {}
  async query(statement) {
    if (/current_user AS current_user/u.test(statement)) return { rows: [{ current_user: "control_room_deployer",
      is_deployer: true, replication_role: "origin" }] };
    if (/pg_try_advisory_lock/u.test(statement)) return { rows: [{ acquired: true }] };
    if (/FROM updater\.runs WHERE finished_at IS NULL/u.test(statement)) return { rows: [] };
    if (/FROM updater\.owner_requests WHERE handled_at IS NULL/u.test(statement)) return { rows: [] };
    return { rows: [] };
  }
}

test("the daemon reads updater.json at the production-default path and ignores ambient PG settings", async t => {
  const f = await fixture(t, "daemon", true), resources = composeProtectedConfigV1(f.input);
  const updater = resources.find(resource => resource.path.endsWith("/updater-state/updater.json"));
  await writeFile(updater.path, updater.contents, { mode: 0o600 }); await chmod(updater.path, 0o600);
  await mkdir(join(f.root, "updater-state", "confirmations")); await mkdir(join(f.root, "status"));
  await writeFile(join(f.root, "updater-state", "self-update"), "Off\n", { mode: 0o600 });
  FakePgClient.options.length = 0;
  // The VAPID custody gate is NOT what this test is about, and it is genuinely
  // root-only by design: `loadUpdaterVapidV1` reads the file's OWN uid through the
  // real `lstat`, and a test fixture cannot chown to 0. So the alert sender is
  // opted out with the documented explicit `alerts: null`, which is the same
  // switch production uses to turn it off and the only one that is not the
  // "default construction" this test is exercising.
  //
  // MEASURED, and the two earlier attempts are why the comment is here: claiming
  // root through `alertRuntime` satisfies the `getuid` check and then fails
  // `updater_vapid_permissions_refused` on the file's uid, so the seam cannot make
  // a non-root fixture pass a check that reads the filesystem's owner.
  const started = await startUpdaterV1({ root: f.root, pg: { Client: FakePgClient }, alerts: null,
    env: { PGHOST: "attacker", PGDATABASE: "attacker", PGPORT: "1" } });
  try {
    assert.deepEqual(FakePgClient.options, [{ host: join(f.root, "pg", "socket"), port: 5432,
      database: "control_room", user: "control_room_deployer" }]);
  } finally { await started.stop(); }
});

test("the updater config loader refuses extra keys, unsafe values, symlinks, loose files, and writable parents", async t => {
  await assert.rejects(loadUpdaterConfigurationV1("relative-root"), /updater_configuration_refused/u);
  await assert.rejects(loadUpdaterConfigurationV1("/"), /updater_configuration_refused/u);
  const rootPath = await fixture(t, "updater-root"), rootBody = composeProtectedConfigV1(rootPath.input).at(-1).contents;
  await writeFile(join(rootPath.root, "updater-state", "updater.json"), rootBody, { mode: 0o600 });
  const noncanonicalRoot = `${rootPath.root}/../${basename(rootPath.root)}`;
  await assert.rejects(loadUpdaterConfigurationV1(noncanonicalRoot), /updater_configuration_refused/u);
  for (const [index, mutate] of [
    value => ({ ...value, extra: true }),
    value => ({ ...value, database: { ...value.database, host: `${value.database.host}\nquote\"\0` } }),
  ].entries()) {
    const f = await fixture(t, `updater-bad-${index}`), value = parsedResource(composeProtectedConfigV1(f.input), "updater.json");
    await writeFile(join(f.root, "updater-state", "updater.json"), JSON.stringify(mutate(value)), { mode: 0o600 });
    await assert.rejects(loadUpdaterConfigurationV1(f.root), /updater_configuration_refused/u);
  }
  const loose = await fixture(t, "updater-loose"), body = composeProtectedConfigV1(loose.input).at(-1).contents;
  await writeFile(join(loose.root, "updater-state", "updater.json"), body, { mode: 0o640 });
  await chmod(join(loose.root, "updater-state", "updater.json"), 0o640);
  await assert.rejects(loadUpdaterConfigurationV1(loose.root), /updater_configuration_refused/u);

  const linked = await fixture(t, "updater-link"), outside = join(linked.base, "updater-outside.json");
  const linkedBody = composeProtectedConfigV1(linked.input).at(-1).contents;
  await writeFile(outside, linkedBody, { mode: 0o600 });
  await symlink(outside, join(linked.root, "updater-state", "updater.json"));
  await assert.rejects(loadUpdaterConfigurationV1(linked.root), /updater_configuration_refused/u);

  const parent = await fixture(t, "updater-parent"), parentBody = composeProtectedConfigV1(parent.input).at(-1).contents;
  await writeFile(join(parent.root, "updater-state", "updater.json"), parentBody, { mode: 0o600 });
  await chmod(join(parent.root, "updater-state"), 0o770);
  await assert.rejects(loadUpdaterConfigurationV1(parent.root), /updater_configuration_refused/u);

  const argument = await fixture(t, "updater-argument"), argumentBody = composeProtectedConfigV1(argument.input).at(-1).contents;
  await writeFile(join(argument.root, "updater-state", "updater.json"), argumentBody, { mode: 0o600 });
  await assert.rejects(loadUpdaterConfigurationV1(argument.root, ["--configuration", outside]),
    /updater_configuration_refused/u);
});

// Real JSON, disk modes, composer, staged release parsers and release readers.
// A non-root test cannot chown: only the ownership fields use an explicit seam.
test("svc2 real composer emits the installed web files and real loaders accept 0750/0640", async t => {
  const f = await fixture(t, "svc2-roundtrip");
  const { build, stop } = await import("esbuild");
  const releasePath = join(f.root, "current/dist-vps/server/macLocalProtectedLoader.js");
  try {
    await build({ entryPoints: ["src/web/v1/mac-local-protected-loader.ts"], outfile: releasePath,
      bundle: true, platform: "node", format: "esm", packages: "bundle", logLevel: "silent",
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
  } finally { stop(); }
  // The staged artifact must import under plain Node, independently of tsx's
  // test-loader interop, before the composer round trip reaches its assertions.
  const imported = spawnSync(process.execPath, ["--input-type=module", "--eval",
    "const loaded = await import(process.argv[1]); if (typeof loaded.captureMacLocalProtectedConfigurationV1 !== 'function') process.exit(1)",
    pathToFileURL(releasePath).href], { encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr);
  // Verify the fixture with plain Node too, and close its process group when the
  // check is done. Otherwise that loader can supply the CommonJS bridge and hide a
  // broken bundle, and a plain Node child would outlive the test run.
  const child = spawn(process.execPath, ["--input-type=module", "--eval",
    "const m = await import(process.argv[1]); if (typeof m.loadMacLocalProtectedConfigurationFromRootV1 !== 'function') process.exit(78);",
    pathToFileURL(releasePath).href], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, errors);
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  await chmod(join(f.root, "Protected"), 0o750);
  const serviceRoot = join(f.root, "Protected/service");
  await writeFile(join(serviceRoot, "web-hmac.key"), `${secret(40)}\n`, { mode: 0o600 });
  await writeFile(join(serviceRoot, "work-intake.json"), JSON.stringify({ schema: "control-room.work-intake-keys/v1",
    integrityKey: secret(41) }), { mode: 0o600 });
  const { composeProtectedConfigPortV1, remintOwnerCodeV1, rollbackOwnerCodeV1 } = await import("../src/updater/v1/install/stage-one-ports.mjs");
  const input = { ...f.input, keys: { ...f.input.keys, webHmac: f.input.keys.webHmac.fileRef,
    workIntake: f.input.keys.workIntake.fileRef } };
  const resources = await composeProtectedConfigPortV1(input);
  for (const resource of resources) {
    await writeFile(resource.path, resource.contents, { mode: Number.parseInt(resource.fileMode, 8) });
    await chmod(resource.path, Number.parseInt(resource.fileMode, 8));
  }
  for (const changes of [ { accountName: accounts.service.name }, { groupName: "wheel" },
    { path: join(f.root, "updater-state", "public.json") } ]) {
    const changed = resources.map(value => value.path.endsWith("mac-local.json") ? { ...value, ...changes } : value);
    assert.throws(() => composeServiceBundleV1(serviceInput(f.root, changed)), /services_batch_uncertain/u);
  }
  assert.throws(() => compose(f.input, {}), /protected_configuration_input_refused/u);
  for (const login of input.dbLogins) {
    if (["control_room_app", "control_room_scheduler"].includes(login.name)) continue;
    await assert.rejects(composeProtectedConfigPortV1({ ...input,
      dbLogins: input.dbLogins.filter(value => value.name !== login.name) }), /protected_configuration_input_refused/u);
  }
  const protectedRoot = join(f.root, "Protected");
  const runtime = { readFile, getuid: () => 302, getgid: () => 302, getgroups: () => [],
    async lstat(path) { const stat = await lstat(path); stat.uid = 0; stat.gid = 302; return stat; } };
  const { loadMacLocalFleetReleaseTrustV1 } = await import("../src/fleet/v1/mac-local-composition.ts");
  const fleetRuntime = { ...runtime, realpath, open };
  const readers = [
    ["mac-local.json", r => releaseParsers.loadMacLocalProtectedConfigurationFromRootV1(protectedRoot, r)],
    ["database-roles.json", r => releaseParsers.loadMacLocalDatabaseRolesFromRootV1(protectedRoot, r)],
    ["release-trust.json", r => loadMacLocalFleetReleaseTrustV1(protectedRoot, { ...fleetRuntime, ...r })],
  ];
  for (const [, read] of readers) await assert.rejects(read({ ...runtime, getgid: () => 999 }));
  const mac = await readers[0][1](runtime);
  assert.equal(mac.port, input.webPort); assert.equal(mac.database.username, "control_room_web");
  assert.deepEqual(mac.enablement.workers, []);
  assert.deepEqual(mac.localOwnerSession.remoteOrigins, [`https://${input.rpId}`]);
  assert.equal((await readers[1][1](runtime)).fleetOwner.username, "control_room_fleet_owner");
  assert.deepEqual(await readers[2][1](runtime), input.releaseTrust);
  assert.equal(await releaseParsers.loadWorkIntakeServerConfigurationFromRootV1(protectedRoot, runtime), undefined);
  assert.equal(await releaseParsers.loadOwnerWebPushConfigFromRootV1(protectedRoot, runtime), undefined);
  for (const name of ["mac-local.json", "database-roles.json", "release-trust.json"]) {
    const resource = resources.find(value => value.path.endsWith(`/${name}`));
    assert.equal(resource.accountName, "root"); assert.equal(resource.groupName, accounts.service.name);
    assert.equal(resource.fileMode, "0640");
  }
  // Burst reads exercise the real files and real refusal checks together.
  const burst = await Promise.all(Array.from({ length: 50 }, () => Promise.all(readers.map(([, read]) => read(runtime)))));
  assert.equal(burst.length, 50);
  for (const [name, read] of readers) {
    const path = join(protectedRoot, "config", name);
    for (const bad of [0o660, 0o644]) {
      await chmod(path, bad); await assert.rejects(read(runtime)); await chmod(path, 0o640);
    }
    for (const [field, invalid] of [["uid", 302], ["gid", 999]]) {
      await assert.rejects(read({ ...runtime, async lstat(value) {
        const stat = await runtime.lstat(value);
        if (value === path) { stat[field] = invalid; if (field === "uid") stat.mode = 0o100600; }
        return stat;
      } }));
    }
    const contents = await readFile(path);
    await unlink(path); await symlink(join(protectedRoot, "config", "host.json"), path);
    await assert.rejects(read(runtime)); await unlink(path); await writeFile(path, contents, { mode: 0o640 });
    await writeFile(path, "{"); await assert.rejects(read(runtime)); await writeFile(path, contents);
    await unlink(path); await assert.rejects(read(runtime)); await writeFile(path, contents, { mode: 0o640 });
  }
  for (const directory of [protectedRoot, join(protectedRoot, "config")]) {
    for (const mode of [0o770, 0o755]) {
      await chmod(directory, mode);
      for (const [, read] of readers) await assert.rejects(read(runtime));
      await chmod(directory, 0o750);
    }
    for (const [field, invalid] of [["uid", 302], ["gid", 999]]) {
      const bad = { ...runtime, async lstat(path) {
        const stat = await runtime.lstat(path); if (path === directory) stat[field] = invalid; return stat;
      } };
      for (const [, read] of readers) await assert.rejects(read(bad));
    }
    if (directory.endsWith("/config")) {
      const serviceOwnedPrivate = { ...runtime, async lstat(path) {
        const stat = await runtime.lstat(path);
        if (path === directory) { stat.uid = 302; stat.mode = 0o40700; }
        return stat;
      } };
      for (const [, read] of readers) await assert.rejects(read(serviceOwnedPrivate));
    }
    const moved = `${directory}-held`;
    const { rename } = await import("node:fs/promises");
    await rename(directory, moved); await symlink(moved, directory);
    for (const [, read] of readers) await assert.rejects(read(runtime));
    await unlink(directory); await rename(moved, directory);
  }
  // Minting and undo must change the file the website actually reads, preserving 0640.
  const minted = await remintOwnerCodeV1({ root: f.root, accounts, configuration: resources,
    rpId: input.rpId, maximumRemints: 2 });
  assert.equal((await readers[0][1](runtime)).localOwnerSession.ownerCodeDigest, minted.ownerCodeDigest);
  assert.equal((await lstat(join(protectedRoot, "config/mac-local.json"))).mode & 0o777, 0o640);
  await assert.rejects(remintOwnerCodeV1({ root: f.root, accounts, configuration: resources,
    rpId: input.rpId, maximumRemints: 2 }), /owner_code_refused/u);
  await rollbackOwnerCodeV1({ root: f.root, receipt: minted.receipt });
  assert.equal((await readers[0][1](runtime)).localOwnerSession.ownerCodeDigest, input.ownerCodeDigest);
  // A repeated rollback is done, not refused (atk-fa F4: recovery replays it); the
  // receipt still refuses a file at any THIRD digest.
  assert.deepEqual(await rollbackOwnerCodeV1({ root: f.root, receipt: minted.receipt }), { restored: false });
  assert.equal((await readers[0][1](runtime)).localOwnerSession.ownerCodeDigest, input.ownerCodeDigest);
  const third = await remintOwnerCodeV1({ root: f.root, accounts, configuration: resources, rpId: input.rpId, maximumRemints: 2 });
  await assert.rejects(rollbackOwnerCodeV1({ root: f.root, receipt: minted.receipt }), /owner_code_rollback_refused/u);
  await rollbackOwnerCodeV1({ root: f.root, receipt: third.receipt });
  await assert.rejects(composeProtectedConfigPortV1({ ...input, releaseTrust: {} }));
  await assert.rejects(composeProtectedConfigPortV1({ ...input,
    dbLogins: input.dbLogins.filter(value => value.name !== "control_room_web") }));
});
