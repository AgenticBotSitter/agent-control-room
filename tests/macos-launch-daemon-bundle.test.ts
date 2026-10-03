import { releaseSourceFixtureV1 } from "./support/release-source-fixture.mjs";
import assert from "node:assert/strict";
import { assertReleaseImportGraphV1, assertShippedReleaseEntryPointsLoadV1, releaseProgramsV1 }
  from "./support/release-import-graph.mjs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build as buildWithEsbuild } from "esbuild";
import { assembleLocalReleaseV1 } from "../src/installer/v1/local-release-assembly.mjs";
import { stageLocalReleaseV1 } from "../src/installer/v1/local-release-stager.mjs";
import { createFleetReleaseTrustForTestV1 } from "./support/fleet-release.ts";
import { createMacosLaunchDaemonBundleV1, type MacosLaunchDaemonBundleV1,
  type MacosServiceAccountsV1 } from "../src/installer/v1/macos-launch-daemon-bundle";
import { MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1, createMacosLaunchDaemonInstallerV1,
  type MacosLaunchDaemonElevatedBatchRequestV1, type MacosLaunchDaemonElevatedPortV1 } from
  "../src/installer/v1/macos-launch-daemon-installer";
import { acquireNightlyBackupLockV1, inspectNightlyBackupPathV1, nightlyBackupConfigurationPathV1, readNightlyBackupCredentialV1,
  runNightlyBackupV1 } from "../src/installer/v1/nightly-backup";
import { mainNightlyBackupV1 } from "../src/installer/v1/nightly-backup-entry";
import { createNightlyBackupConfigurationV1, nightlyBackupConfigurationFileV1 } from
  "../src/installer/v1/nightly-backup-configuration";
import { macosFleetGatewayConfigurationFileV1 } from "../src/installer/v1/macos-fleet-gateway-configuration";

const execFileAsync = promisify(execFile);
const INSTALL_ROOT = "/opt/control-room-test";
const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_URL = new URL("../src/updater/v1/policy/accounts.json", import.meta.url);
const ACCOUNTS = JSON.parse(await readFile(POLICY_URL, "utf8")) as MacosServiceAccountsV1;
const localDatabase = (username: string, password: string) => Object.freeze({ host: "127.0.0.1", port: 5432,
  database: "control_room", username, password, majorVersion: 17 as const });
const FLEET_GATEWAY = Object.freeze({ tenantId: "tenant:mac-local",
  database: localDatabase("control_room_fleet", "fixture-fleet-password"),
  workIntakeDatabase: localDatabase("control_room_work_intake_agent", "fixture-intake-password"),
  workIntakeIntegrityKey: Buffer.alloc(32, 7).toString("base64url"),
  harnessIntegrityKey: Buffer.alloc(32, 9).toString("base64url"),
  // `releaseTrust` is REQUIRED of a gateway configuration: `captureReleaseTrustV1`
  // rejects a missing one, and the bundle's own parser is strict about its keys, so a
  // fixture without it fails `fleet_gateway_configuration_refused` before reaching any
  // assertion about launchd. MEASURED as 15 of 19 tests failing on exactly that.
  //
  // It is built by the shared helper rather than hand-written because the trust's `keyId`
  // must equal the digest of its own public key, which a literal cannot satisfy.
  releaseTrust: createFleetReleaseTrustForTestV1().trust });

function bundle(overrides: Record<string, unknown> = {}): MacosLaunchDaemonBundleV1 {
  return createMacosLaunchDaemonBundleV1({ installRoot: INSTALL_ROOT, accounts: ACCOUNTS,
    postgresExecutable: `${INSTALL_ROOT}/runtime/pg-current/bin/postgres`, fleetGateway: FLEET_GATEWAY, ...overrides });
}

function inventory(request: MacosLaunchDaemonElevatedBatchRequestV1) {
  return request.resources.map(({ kind, path, sha256 }) => ({ kind, path, sha256 }));
}

const NIGHTLY_IDENTITY_DIGEST = `sha256:${"b".repeat(64)}`;
const NIGHTLY_LEDGER_DIGEST = `sha256:${"d".repeat(64)}`;
const NIGHTLY_LEDGER_HEAD = Object.freeze({ filename: "0001_initial.sql", digest: `sha256:${"e".repeat(64)}`,
  ledger_order: 1, pre_schema_digest: null, post_schema_digest: `sha256:${"f".repeat(64)}` });

/**
 * Write a generation that is BOUND, the way the production backup producer does.
 *
 * R4B-01 made `readGeneratedGeneration` part of every run: a generation whose
 * manifest does not describe its own bytes is refused before it can count as
 * this night's backup. Three tests here stub `backup` with a function that writes
 * a dump and nothing else, and each of them started failing with
 * `nightly_backup_unbound_generation` — which is the guard working, not the guard
 * being wrong.
 *
 * So the stubs write what production writes. The alternative — overriding
 * `readGeneratedGeneration` to always say `true` — would have left the tests
 * exercising a run shape production cannot produce.
 */
async function writeBoundNightlyGenerationV1(out: string, dump: Buffer, identityDigest = NIGHTLY_IDENTITY_DIGEST) {
  // `mkdir -p`, not `mkdir`: several of these tests stub `prepareBackup` to a
  // no-op, so the generation folder does not exist yet when `backup` is called,
  // and a bare `mkdir` on a missing parent would fail the run with
  // `nightly_backup_execution_failed` — a refusal about the fixture, not about
  // the behaviour under test.
  //
  // It still cannot create `/opt/control-room-test`, which does not exist and
  // must not: `INSTALL_ROOT` is a fixture path, not a directory this suite may
  // make. A test that uses it for argument-validation and lock semantics
  // therefore overrides `readGeneratedGeneration` instead, which is what those
  // tests are actually about. See `boundByDeclaration` below.
  await mkdir(out, { recursive: true, mode: 0o700 });
  await writeFile(join(out, "database.dump"), dump, { mode: 0o600 });
  const metadata = `${JSON.stringify({
    version: 1, identity: { identityDigest }, ledgerDigest: NIGHTLY_LEDGER_DIGEST,
    evidence: { ledger: [NIGHTLY_LEDGER_HEAD], roles: [{ rolname: "control_room_reader" }] },
  })}\n`;
  await writeFile(join(out, "metadata.json"), metadata, { mode: 0o600 });
  await writeFile(join(out, "manifest.json"), `${JSON.stringify({
    schema: "control-room.verified-database-backup/v1", createdAt: new Date().toISOString(),
    dumpDigest: `sha256:${createHash("sha256").update(dump).digest("hex")}`,
    metadataDigest: `sha256:${createHash("sha256").update(metadata).digest("hex")}`,
    restoreIdentityDigest: identityDigest,
    ledger: { digest: NIGHTLY_LEDGER_DIGEST, head: { order: NIGHTLY_LEDGER_HEAD.ledger_order,
      file: NIGHTLY_LEDGER_HEAD.filename, digest: NIGHTLY_LEDGER_HEAD.digest } },
    requiredTables: [],
  })}\n`, { mode: 0o600 });
  return { planned: false, identityDigest };
}

/**
 * `readGeneratedGeneration` for a test whose install root is a path that does
 * not exist and must not be created (`/opt/control-room-test`).
 *
 * These two tests are about argument validation and lock semantics, not about
 * the file contract, and R4B-01's own-generation check is the one thing in a run
 * that would insist on real bytes on disk. Stating the binding here — rather
 * than writing a generation — keeps the rest of the run's real code paths intact
 * and says plainly which fact is being declared rather than observed.
 *
 * The bound-generation behaviour has its own tests, in
 * `tests/nightly-backup-round4b.test.mjs`, against a real temporary root.
 */
const boundByDeclaration = Object.freeze({
  readGeneratedGeneration: async () => Object.freeze({ bound: true }),
});

function successfulPort() {
  const requests: MacosLaunchDaemonElevatedBatchRequestV1[] = [];
  let installed = false;
  const port: MacosLaunchDaemonElevatedPortV1 = { async invokeBatch(request) {
    requests.push(request);
    const wasInstalled = installed;
    installed = request.action === "install";
    return { schema: MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1, requestDigest: request.requestDigest,
      outcome: wasInstalled === installed ? "unchanged" : "completed",
      inventory: installed ? inventory(request) : [] };
  } };
  return { port, requests };
}

const plist = (generated: MacosLaunchDaemonBundleV1, role: string) => generated.resources.find(resource =>
  resource.kind === "launchd_plist" && resource.path.endsWith(`.${role}.plist`))!.contents;
const protectedConfig = (generated: MacosLaunchDaemonBundleV1, name = "backup.json") => generated.resources.find(resource =>
  resource.kind === "protected_config" && resource.path.endsWith(`/${name}`)) as
  Extract<MacosLaunchDaemonBundleV1["resources"][number], { kind: "protected_config" }>;

test("generates the realigned per-account daemon set while retaining the pre-19a backup", async () => {
  const generated = bundle();
  assert.deepEqual(generated.services.map(service => service.role),
    ["postgresql17", "supervisor", "fleet-gateway", "nightly-backup", "updater", "updater-guard"]);
  assert.equal(generated.resources.filter(resource => resource.kind === "launchd_plist").length, 6);
  assert.equal(generated.resources.filter(resource => resource.kind === "newsyslog_config").length, 1);
  assert.equal(generated.resources.filter(resource => resource.kind === "protected_config").length, 2);
  assert.equal(generated.services.some(service => service.role === "host" as never), false);
  assert.equal(generated.resources.filter(resource => resource.contents.includes("task-host-supervisor.mjs")).length, 1);

  assert.match(plist(generated, "postgres"), new RegExp(`<string>${ACCOUNTS.accounts.database}</string>`, "u"));
  for (const role of ["supervisor", "gateway", "nightly-backup"])
    assert.match(plist(generated, role), new RegExp(`<string>${ACCOUNTS.accounts.service}</string>`, "u"));
  for (const role of ["updater", "updater-guard"]) assert.doesNotMatch(plist(generated, role), /<key>UserName<\/key>/u);
  const expectedWorkingDirectories = new Set([`${INSTALL_ROOT}/pg/current`, `${INSTALL_ROOT}/current`,
    `${INSTALL_ROOT}/updater/current`, `${INSTALL_ROOT}/guard`]);
  for (const resource of generated.resources.filter(resource => resource.kind === "launchd_plist")) {
    assert.doesNotMatch(resource.contents, /invoking_owner/u);
    const workingDirectory = /<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/u.exec(resource.contents)?.[1];
    assert.equal(expectedWorkingDirectories.has(workingDirectory ?? ""), true, workingDirectory);
    assert.match(resource.contents, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/u);
    assert.match(resource.contents, /<key>Umask<\/key>\s*<integer>63<\/integer>/u);
    assert.doesNotMatch(resource.contents, /<key>PATH<\/key>/u);
  }

  const keepAliveRoles = generated.services.filter(service =>
    /<key>KeepAlive<\/key>\s*<true\/>/u.test(plist(generated, service.label.split(".").at(-1)!))).map(service => service.role);
  assert.deepEqual(keepAliveRoles, ["postgresql17", "supervisor", "updater"]);
  assert.match(plist(generated, "gateway"),
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/u);
  assert.match(plist(generated, "updater-guard"), /<key>StartInterval<\/key>\s*<integer>60<\/integer>/u);
  assert.doesNotMatch(plist(generated, "updater-guard"), /<key>KeepAlive<\/key>/u);
  assert.match(plist(generated, "nightly-backup"),
    /<key>StartCalendarInterval<\/key>[\s\S]*<integer>2<\/integer>[\s\S]*<integer>30<\/integer>/u);
  const backup = protectedConfig(generated);
  assert.equal(backup.path, `${INSTALL_ROOT}/Protected/config/backup.json`);
  assert.deepEqual({ accountName: backup.accountName, groupName: backup.groupName, fileMode: backup.fileMode },
    { accountName: ACCOUNTS.accounts.service, groupName: ACCOUNTS.accounts.service, fileMode: "0600" });
  const backupValue = JSON.parse(backup.contents);
  assert.deepEqual(backupValue, createNightlyBackupConfigurationV1(INSTALL_ROOT));
  assert.equal(Object.hasOwn(backupValue.database, "password"), false);
  assert.match(backupValue.database.passwordFile, /^\/opt\/control-room-test\/Protected\//u);
  assert.equal(backupValue.outputRoot, `${INSTALL_ROOT}/backups/nightly`);
  assert.equal(backupValue.lockFile, `${INSTALL_ROOT}/Protected/runtime-state/nightly-backup/run.lock`);
  assert.equal(backupValue.database.login, "control_room_migrator");
  assert.equal(backupValue.retention.dailyBackups, 14);
  assert.deepEqual(backupValue.requiredTables, ["tenants", "workspaces", "projects", "control_web_task_commands",
    "control_harness_runs", "control_harness_run_events"]);
  // The ledger digest is READ FROM THE LEDGER, not pinned as a second literal here.
  //
  // MEASURED: this assertion carried `sha256:393289da…` — the installer stream's pin —
  // which matched NO ledger in this tree, so every nightly-backup parse answered
  // `nightly_backup_configuration_refused`. A second hard-coded copy of a digest that
  // `tests/updater-ledger-pin.test.mjs` already checks against the ledger is a third
  // place to forget. This reads the same source of truth, so it asserts that the BUNDLE
  // agrees with the ledger rather than that two literals are equal.
  const ledger = JSON.parse(await readFile(new URL('../deploy/postgres/migration-ledger.json', import.meta.url), 'utf8'));
  // The ledger stores its digest BARE and the pin carries the `sha256:` algorithm
  // prefix, so the comparison composes both rather than silently dropping one side.
  assert.equal(backupValue.ledgerDigest, `sha256:${ledger.digest}`);

  const gateway = protectedConfig(generated, "fleet-gateway.json");
  assert.equal(gateway.path, macosFleetGatewayConfigurationFileV1(INSTALL_ROOT));
  assert.deepEqual({ accountName: gateway.accountName, groupName: gateway.groupName, fileMode: gateway.fileMode },
    { accountName: ACCOUNTS.accounts.service, groupName: ACCOUNTS.accounts.service, fileMode: "0600" });
  const gatewayValue = JSON.parse(gateway.contents);
  assert.equal(gatewayValue.database.username, "control_room_fleet");
  assert.equal(gatewayValue.workIntake.database.username, "control_room_work_intake_agent");
  assert.equal(gatewayValue.database.host, "127.0.0.1");
  assert.equal(gatewayValue.trustedClientHeader, "none");
  assert.deepEqual(gatewayValue.trustedProxyAddresses, []);

  const sources = await Promise.all(["macos-launch-daemon-bundle.ts", "macos-launch-daemon-installer.ts"]
    .map(name => readFile(new URL(`../src/installer/v1/${name}`, import.meta.url), "utf8")));
  for (const account of [ACCOUNTS.accounts.service, ACCOUNTS.accounts.database, ACCOUNTS.accounts.builder])
    assert.equal(sources.some(source => source.includes(account)), false, `account ${account} must come only from policy`);

  const interfaceContract = await readFile(new URL("../docs/UPDATER_DAEMON_INSTALLER_INTERFACE.md", import.meta.url), "utf8");
  assert.match(interfaceContract, /item 4 must[\s\S]*reject a name, UID or GID collision/u);
  assert.match(interfaceContract,
    /## BRANCH_ALIGNMENT[\s\S]*exactly six plists[\s\S]*removed only[\s\S]*item 19a/u);

  const supervisorSources = await Promise.all(["task-host-supervisor.mjs", "stack.mjs", "start-task-host.mjs"]
    .map(name => readFile(new URL(`../scripts/mac-local/${name}`, import.meta.url), "utf8")));
  for (const source of supervisorSources) {
    assert.doesNotMatch(source, /--import["',\s]+tsx|from\s+["'][^"']+\.tsx?["']/u);
  }
});

test("every shipped program in the assembled release starts, not just the launchd ones",
  { skip: process.env.CONTROL_ROOM_SKIP_DAEMON_RELEASE_STAGE === "1" ? "mutation guard subset" : false }, async t => {
  // The closure guard above only loads the four launchd programs (`releaseProgramsV1`),
  // which is why m-rvint6's finding 1 survived it: the four signing programs ship and
  // import `src/installer/shared/strict-json.mjs`, and it was not in the policy.
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-shipped-entry-release-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseDirectory = join(root, "release"), installRoot = join(root, "install");
  await mkdir(installRoot);
  const report = await assembleLocalReleaseV1({ releaseRoot: REPOSITORY, outputDirectory: releaseDirectory });
  const staged = await stageLocalReleaseV1({ ownerAttended: true, releaseDirectory, installRoot });
  const versionRoot = join(installRoot, "versions", staged.version);
  // The release's runtime packages come from the SAME frozen production install the
  // installer prepares (`pnpm install --prod --frozen-lockfile`), linked rather than
  // fabricated, so `pg`/`pg-boss` resolve as they do on a prepared install.
  await symlink(join(REPOSITORY, "node_modules"), join(versionRoot, "node_modules"), "dir");
  const { entryPoints } = await assertShippedReleaseEntryPointsLoadV1(versionRoot);
  assert.ok(entryPoints.includes("scripts/release-signing.mjs"));
  assert.ok(entryPoints.includes("src/installer/shared/strict-json.mjs"),
    "the shared strict JSON reader is part of the shipped program surface");
  assert.ok(entryPoints.length >= 40,
    `the guard covers the whole shipped surface, not a sample (found ${entryPoints.length})`);
  // The four signing programs are the ones finding 1 named. They must start.
  for (const program of ["scripts/release-signing.mjs", "scripts/verify-signed-release.mjs",
    "scripts/generate-installation-release-key.mjs", "src/installer/v1/signed-release-verifier.mjs"]) {
    assert.ok(entryPoints.includes(program), `${program} ships`);
    await execFileAsync(process.execPath, ["--input-type=module", "-e",
      `await import(${JSON.stringify(pathToFileURL(join(versionRoot, program)).href)});`], { cwd: versionRoot });
  }
  assert.equal(report.fileCount, staged.fileCount);
});

test("every current program argument exists in an exactly staged release",
  { skip: process.env.CONTROL_ROOM_SKIP_DAEMON_RELEASE_STAGE === "1" ? "mutation guard subset" : false }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-daemon-release-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseDirectory = join(root, "release"), installRoot = join(root, "install");
  await mkdir(installRoot);
  const source = await releaseSourceFixtureV1(REPOSITORY, join(root, "source"));
  await assembleLocalReleaseV1({ releaseRoot: source, outputDirectory: releaseDirectory });
  const staged = await stageLocalReleaseV1({ ownerAttended: true, releaseDirectory, installRoot });
  await symlink(join(installRoot, "versions", staged.version), join(installRoot, "current"), "dir");
  const generated = bundle({ installRoot,
    postgresExecutable: join(installRoot, "runtime", "pg-current", "bin", "postgres") });
  const prefix = `${installRoot}/current/`;
  const currentArguments = generated.resources.flatMap(resource =>
    [...resource.contents.matchAll(/<string>([^<]+)<\/string>/gu)].map(match => match[1]!)
      .filter(value => value.startsWith(prefix)));
  assert.deepEqual(currentArguments.sort(), [
    join(installRoot, "current", "dist-vps", "server", "fleetGateway.js"),
    join(installRoot, "current", "dist-vps", "server", "nightlyBackup.js"),
    join(installRoot, "current", "scripts", "mac-local", "task-host-supervisor.mjs"),
  ].sort());
  await Promise.all(currentArguments.map(path => access(path)));
  await assertReleaseImportGraphV1(REPOSITORY, join(installRoot, "current"), releaseProgramsV1(installRoot));
  const importedSupervisor = await execFileAsync(process.execPath, ["--input-type=module", "-e",
    `const module = await import(${JSON.stringify(pathToFileURL(join(installRoot, "current", "scripts/mac-local/task-host-supervisor.mjs")).href)}); console.log(typeof module.superviseTaskHost);`]);
  assert.equal(importedSupervisor.stdout.trim(), "function", "the staged supervisor carries every shared dependency");
  const entry = join(installRoot, "current", "dist-vps", "server", "nightlyBackup.js");
  const help = await execFileAsync(process.execPath, [entry, "--help"]);
  assert.match(help.stdout, /^Usage: nightlyBackup\.js --configuration ABSOLUTE_PATH\nRuns one protected database backup/u);
  assert.equal(help.stderr, "");
  const version = await execFileAsync(process.execPath, [entry, "--version"]);
  assert.match(version.stdout, /^nightlyBackup\.js \d+\.\d+\.\d+/u);
  assert.equal(version.stderr, "");

  const configResource = protectedConfig(generated);
  await assert.rejects(execFileAsync(process.execPath, [entry, "--configuration", configResource.path]), error => {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return failure.code === 1 && failure.stdout === ""
      && failure.stderr === "nightly database backup failed: nightly_backup_configuration_refused\n"
      && !/Error:|at\s/u.test(failure.stderr);
  });
  await mkdir(dirname(configResource.path), { recursive: true });
  await writeFile(configResource.path, configResource.contents, { mode: 0o600 });
  const config = JSON.parse(configResource.contents);
  await mkdir(dirname(config.database.passwordFile), { recursive: true });
  await writeFile(config.database.passwordFile, "fixture-credential\n", { mode: 0o600 });
  await mkdir(config.outputRoot, { recursive: true, mode: 0o770 });
  await mkdir(dirname(config.lockFile), { recursive: true, mode: 0o770 });
  await mkdir(config.pgBin, { recursive: true });
  const fakeDump = join(config.pgBin, "pg_dump");
  await writeFile(fakeDump, "#!/bin/sh\n/bin/mkdir -p \"$1\"\n/usr/bin/printf 'fake dump' > \"$1/database.dump\"\n", { mode: 0o700 });
  await chmod(fakeDump, 0o700);
  const programBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u
    .exec(plist(generated, "nightly-backup"))![1]!;
  const nightlyPlistArguments = [...programBlock.matchAll(/<string>([^<]+)<\/string>/gu)]
    .map(match => match[1]!);
  assert.deepEqual(nightlyPlistArguments.slice(0, 9), [
    join(installRoot, "runtime", "node-current", "bin", "node"),
    join(installRoot, "updater", "current", "service-output.mjs"),
    "--out", join(installRoot, "logs", "nightly-backup", "out.log"),
    "--err", join(installRoot, "logs", "nightly-backup", "err.log"), "--shutdown-ms", "115000", "--",
  ]);
  const childArguments = nightlyPlistArguments.slice(9);
  assert.deepEqual(childArguments, [
    join(installRoot, "runtime", "node-current", "bin", "node"), entry, "--configuration", configResource.path,
  ]);
  const built = await import(`${pathToFileURL(entry).href}?integration=${Date.now()}`) as {
    mainNightlyBackupV1: (args: readonly string[], runtime: unknown,
      io: { stdout: (text: string) => void; stderr: (text: string) => void }) => Promise<number>;
  };
  const output: string[] = [], errors: string[] = [];
  const code = await built.mainNightlyBackupV1(childArguments.slice(2), {
    readConfiguration: (path: string) => readFile(path, "utf8"),
    readPassword: (path: string) => readFile(path, "utf8"),
    backup: async (value: Record<string, unknown>) => {
      await execFileAsync(join(String(value.pgBin), "pg_dump"), [String(value.out)]);
      // The fake pg_dump above wrote only `database.dump`; the real producer also
      // writes metadata.json and the manifest that binds them. See
      // `writeBoundNightlyGenerationV1` for why the stub has to be honest.
      await writeBoundNightlyGenerationV1(String(value.out), Buffer.from("fake dump"));
      return { planned: false, identityDigest: NIGHTLY_IDENTITY_DIGEST };
    },
    listBackups: async (path: string) => (await readdir(path, { withFileTypes: true })).map(item => ({
      name: item.name, directory: item.isDirectory(), symbolicLink: item.isSymbolicLink(),
    })),
    removeBackup: (path: string) => rm(path, { recursive: true }),
    now: () => "2026-09-30T08:30:00.000Z",
  }, { stdout: text => output.push(text), stderr: text => errors.push(text) });
  assert.equal(code, 0);
  assert.deepEqual(output, ["nightly database backup completed\n"]);
  assert.deepEqual(errors, []);
  assert.equal(await readFile(join(config.outputRoot, "2026-09-30T08-30-00-000Z", "database.dump"), "utf8"), "fake dump");

  await assert.rejects(execFileAsync(process.execPath, [entry]), error => {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return failure.code === 64 && failure.stdout === ""
      && failure.stderr === "nightly database backup failed: nightly_backup_usage_refused\n"
      && !/Error:|at\s/u.test(failure.stderr);
  });
});

test("focused compiled nightly entry executes and reports bounded CLI results", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-nightly-entry-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  const entry = join(root, "nightlyBackup.js");
  await buildWithEsbuild({
    entryPoints: [join(REPOSITORY, "src", "installer", "v1", "nightly-backup-entry.ts")],
    outfile: entry, bundle: true, platform: "node", format: "esm", logLevel: "silent",
  });
  const help = await execFileAsync(process.execPath, [entry, "--help"]);
  assert.match(help.stdout, /^Usage: nightlyBackup\.js --configuration ABSOLUTE_PATH\nRuns one protected database backup/u);
  assert.equal(help.stderr, "");
  const version = await execFileAsync(process.execPath, [entry, "--version"]);
  assert.match(version.stdout, /^nightlyBackup\.js \d+\.\d+\.\d+/u);
  assert.equal(version.stderr, "");
  await assert.rejects(execFileAsync(process.execPath, [entry]), error => {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return failure.code === 64 && failure.stdout === ""
      && failure.stderr === "nightly database backup failed: nightly_backup_usage_refused\n";
  });
  const built = await import(`${pathToFileURL(entry).href}?focused=${Date.now()}`) as {
    mainNightlyBackupV1: (args: readonly string[], runtime: unknown,
      io: { stdout: (text: string) => void; stderr: (text: string) => void }) => Promise<number>;
  };
  const configuration = createNightlyBackupConfigurationV1(INSTALL_ROOT), errors: string[] = [];
  const code = await built.mainNightlyBackupV1(["--configuration", nightlyBackupConfigurationFileV1(INSTALL_ROOT)], {
    readConfiguration: async () => JSON.stringify(configuration), readPassword: async () => "protected-credential",
    inspectPath: async (inspected: string) => ({ directory: inspected === configuration.outputRoot,
      file: inspected === configuration.database.passwordFile, symbolicLink: false }),
    acquireLock: async () => async () => {}, prepareBackup: async () => {},
    backup: async () => { throw new Error("nightly_backup_dependency_missing"); },
    listBackups: async () => [], removeBackup: async () => {}, now: () => "2026-09-30T02:30:00.000Z",
  }, { stdout: () => {}, stderr: text => errors.push(text) });
  assert.equal(code, 1);
  assert.deepEqual(errors, ["nightly database backup failed: nightly_backup_dependency_missing\n"]);
});

test("nightly backup accepts only its fixed config form and requires a completed dump", async () => {
  const path = nightlyBackupConfigurationFileV1(INSTALL_ROOT);
  assert.equal(nightlyBackupConfigurationPathV1(["--configuration", path]), path);
  for (const args of [[], ["--configuration"], ["--configuration", "relative"],
    ["--configuration", path, "extra"], ["--other", path]]) {
    assert.equal(nightlyBackupConfigurationPathV1(args), undefined);
  }
  const configuration = createNightlyBackupConfigurationV1(INSTALL_ROOT);
  type Runtime = NonNullable<Parameters<typeof runNightlyBackupV1>[1]>;
  const runtime = (overrides: Partial<Runtime> = {}): Runtime => ({
    ...boundByDeclaration,
    readConfiguration: async () => JSON.stringify(configuration), readPassword: async () => "protected-credential\n",
    inspectPath: async inspected => ({ directory: inspected === configuration.outputRoot,
      file: inspected === configuration.database.passwordFile, symbolicLink: false }),
    acquireLock: async () => async () => {}, prepareBackup: async () => {},
    backup: async () => ({ planned: false, identityDigest: NIGHTLY_IDENTITY_DIGEST }),
    listBackups: async () => [{ name: "2026-09-30T02-30-00-000Z", directory: true, symbolicLink: false, completed: true }],
    removeBackup: async () => {}, now: () => "2026-09-30T02:30:00.000Z", ...overrides,
  });
  let received: unknown;
  await runNightlyBackupV1(path, runtime({ backup: async value => { received = value;
    return { planned: false, identityDigest: NIGHTLY_IDENTITY_DIGEST }; } }));
  assert.deepEqual(received, { source: { host: `${INSTALL_ROOT}/pg/socket`, port: 5432, database: "control_room",
    user: "control_room_migrator", password: "protected-credential" },
  out: `${INSTALL_ROOT}/backups/nightly/2026-09-30T02-30-00-000Z`,
  pgBin: `${INSTALL_ROOT}/runtime/pg-current/bin`, ledgerDigest: configuration.ledgerDigest,
  requiredTables: [...configuration.requiredTables], release: "mac-local-nightly" });
  let bypassedConfigurationRead = false, bypassedMissingPath = false;
  await assert.rejects(runNightlyBackupV1(undefined, runtime({
    readConfiguration: async () => { bypassedConfigurationRead = true; return JSON.stringify(configuration); },
    backup: async () => { bypassedMissingPath = true;
    return { planned: false, identityDigest: `sha256:${"b".repeat(64)}` }; } })), /configuration_refused/u);
  assert.equal(bypassedConfigurationRead, false);
  assert.equal(bypassedMissingPath, false);
  for (const value of [[], { ...configuration, outputRoot: "/private/tmp/out" },
    { ...configuration, database: { ...configuration.database, login: "control_room_app" } },
    { ...configuration, retention: { dailyBackups: 0 } }, { ...configuration, extra: true }]) {
    await assert.rejects(runNightlyBackupV1(path, runtime({ readConfiguration: async () => JSON.stringify(value),
      backup: async () => { throw new Error("must not run"); } })), /configuration_refused/u);
  }
  await assert.rejects(runNightlyBackupV1(`${INSTALL_ROOT}/Protected/config/other.json`, runtime()),
    /configuration_refused/u);
  await assert.rejects(runNightlyBackupV1(path, runtime({ readPassword: async () => { throw new Error("missing"); } })),
    /credential_refused/u);
  await assert.rejects(runNightlyBackupV1(path, runtime({ readPassword: async () => "\n" })), /credential_refused/u);
  await assert.rejects(runNightlyBackupV1(path, runtime({ now: () => "not-a-time" })), /clock_refused/u);
  await assert.rejects(runNightlyBackupV1(path, runtime({ backup: async () => ({ planned: true }) })),
    /nightly_backup_incomplete/u);
  await assert.rejects(runNightlyBackupV1(path, runtime({ backup: async () => {
    throw new Error("nightly_backup_dependency_missing");
  } })), /nightly_backup_dependency_missing/u);
  const boundedErrors: string[] = [];
  assert.equal(await mainNightlyBackupV1(["--configuration", path], runtime({ backup: async () => {
    throw new Error("nightly_backup_dependency_missing");
  } }), { stdout: () => {}, stderr: text => boundedErrors.push(text) }), 1);
  assert.deepEqual(boundedErrors, ["nightly database backup failed: nightly_backup_dependency_missing\n"]);
  await assert.rejects(runNightlyBackupV1(path, runtime({ inspectPath: async inspected => ({
    directory: inspected === configuration.outputRoot, file: inspected === configuration.database.passwordFile,
    symbolicLink: inspected === configuration.outputRoot,
  }) })), /nightly_backup_output_refused/u);
  await assert.rejects(runNightlyBackupV1(path, runtime({ inspectPath: async inspected => ({
    directory: inspected === configuration.outputRoot, file: inspected === configuration.database.passwordFile,
    symbolicLink: inspected === configuration.database.passwordFile,
  }) })), /nightly_backup_credential_refused/u);

  const names = Array.from({ length: 16 }, (_, index) =>
    `2026-09-${String(index + 15).padStart(2, "0")}T02-30-00-000Z`);
  const removed: string[] = [];
  await runNightlyBackupV1(path, runtime({ listBackups: async () => names.map(name => ({
    name, directory: true, symbolicLink: false, completed: true })), removeBackup: async retired => { removed.push(retired); } }));
  assert.deepEqual(removed, names.slice(0, 2).map(name => `${configuration.outputRoot}/${name}`));
  await assert.rejects(runNightlyBackupV1(path, runtime({ listBackups: async () => [
    { name: "2026-09-30T02-30-00-000Z", directory: false, symbolicLink: true },
  ] })), /unsafe_generation/u);
  const unsafeErrors: string[] = [];
  assert.equal(await mainNightlyBackupV1(["--configuration", path], runtime({ listBackups: async () => [
    { name: "2026-09-30T02-30-00-000Z", directory: false, symbolicLink: true },
  ] }), { stdout: () => {}, stderr: text => unsafeErrors.push(text) }), 1);
  assert.deepEqual(unsafeErrors, ["nightly database backup failed: unsafe_generation\n"]);
});

test("nightly backup refuses a burst, releases its gate after failure, and never retains a partial attempt", async () => {
  const path = nightlyBackupConfigurationFileV1(INSTALL_ROOT);
  const configuration = createNightlyBackupConfigurationV1(INSTALL_ROOT);
  type Runtime = NonNullable<Parameters<typeof runNightlyBackupV1>[1]>;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolveEntered => { enter = resolveEntered; });
  const held = new Promise<void>(resolveHeld => { release = resolveHeld; });
  let backupCalls = 0;
  const base: Runtime = { ...boundByDeclaration,
    readConfiguration: async () => JSON.stringify(configuration),
    readPassword: async () => "protected-credential", now: () => "2026-09-30T02:30:00.000Z",
    inspectPath: async inspected => ({ directory: inspected === configuration.outputRoot,
      file: inspected === configuration.database.passwordFile, symbolicLink: false }),
    acquireLock: async () => async () => {}, prepareBackup: async () => {},
    backup: async () => { backupCalls += 1; enter(); await held;
      return { planned: false, identityDigest: `sha256:${"c".repeat(64)}` }; },
    listBackups: async () => [], removeBackup: async () => {} };
  const burst = Array.from({ length: 50 }, () => runNightlyBackupV1(path, base));
  await entered;
  release();
  const settled = await Promise.allSettled(burst);
  assert.equal(backupCalls, 1);
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter(result => result.status === "rejected"
    && /concurrent_refused/u.test(String(result.reason))).length, 49);

  let retentionCalls = 0;
  await assert.rejects(runNightlyBackupV1(path, { ...base,
    backup: async () => { throw new Error("dropped connection"); },
    listBackups: async () => { retentionCalls += 1; return []; } }), /execution_failed/u);
  assert.equal(retentionCalls, 0);
  await runNightlyBackupV1(path, { ...base, backup: async () => ({ planned: false,
    identityDigest: `sha256:${"d".repeat(64)}` }) });
});

test("nightly backup refuses runtime symlinks and fifty processes produce one dump", async t => {
  const installRoot = await realpath(await mkdtemp(join(tmpdir(), "control-room-nightly-lock-")));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  const configuration = createNightlyBackupConfigurationV1(installRoot);
  const configurationPath = nightlyBackupConfigurationFileV1(installRoot);
  await mkdir(dirname(configurationPath), { recursive: true });
  await writeFile(configurationPath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  await mkdir(dirname(configuration.database.passwordFile), { recursive: true });
  await mkdir(dirname(configuration.lockFile), { recursive: true, mode: 0o770 });
  await mkdir(dirname(configuration.outputRoot), { recursive: true });
  const outside = join(installRoot, "outside"), outsidePassword = join(installRoot, "outside-password");
  await mkdir(outside);
  await symlink(outside, configuration.outputRoot, "dir");
  await writeFile(configuration.database.passwordFile, "fixture-credential\n", { mode: 0o600 });
  await assert.rejects(runNightlyBackupV1(configurationPath, {
    backup: async () => ({ planned: false, identityDigest: `sha256:${"e".repeat(64)}` }),
  }), /nightly_backup_output_refused/u);

  await rm(configuration.outputRoot);
  await mkdir(configuration.outputRoot, { recursive: true, mode: 0o770 });
  const racedOutput = join(installRoot, "raced-output"), displacedOutput = join(installRoot, "displaced-output");
  await mkdir(racedOutput, { mode: 0o770 });
  await assert.rejects(inspectNightlyBackupPathV1(racedOutput, async () => {
    await rename(racedOutput, displacedOutput);
    await symlink(displacedOutput, racedOutput, "dir");
  }), "O_NOFOLLOW must refuse an output symlink swapped in after lstat");
  await rm(configuration.database.passwordFile);
  await writeFile(outsidePassword, "fixture-credential\n", { mode: 0o600 });
  await symlink(outsidePassword, configuration.database.passwordFile);
  await assert.rejects(readNightlyBackupCredentialV1(configuration.database.passwordFile),
    "O_NOFOLLOW must refuse a symlinked password file");
  await assert.rejects(runNightlyBackupV1(configurationPath, {
    backup: async () => ({ planned: false, identityDigest: `sha256:${"e".repeat(64)}` }),
  }), /nightly_backup_credential_refused/u);

  await rm(configuration.database.passwordFile);
  await writeFile(configuration.database.passwordFile, "fixture-credential\n", { mode: 0o600 });
  const releaseLiveLock = await acquireNightlyBackupLockV1(configuration.lockFile);
  try {
    await assert.rejects(runNightlyBackupV1(configurationPath, {
      backup: async () => ({ planned: false, identityDigest: `sha256:${"e".repeat(64)}` }),
    }), /nightly_backup_concurrent_refused/u);
  } finally { await releaseLiveLock(); }
  await writeFile(configuration.lockFile, `${JSON.stringify({ version: 1, pid: 2_147_483_647 })}\n`, { mode: 0o600 });
  // This install root is a REAL temporary directory, so the generation is
  // really written and really bound -- no declaration needed.
  await runNightlyBackupV1(configurationPath, {
    now: () => "2026-09-29T02:30:00.000Z",
    backup: async value => writeBoundNightlyGenerationV1(String(value.out), Buffer.from("dump")),
  });
  await assert.rejects(access(configuration.lockFile));

  const marker = join(installRoot, "dump-marker"), workerSource = join(installRoot, "worker.ts"),
    worker = join(installRoot, "worker.mjs"), ready = join(installRoot, "ready"), start = join(installRoot, "start");
  await mkdir(ready);
  const moduleSpecifier = relative(dirname(workerSource),
    join(REPOSITORY, "src", "installer", "v1", "nightly-backup.ts"));
  await writeFile(workerSource, `import { access, appendFile, writeFile } from "node:fs/promises";\n`
    + `import { createHash } from "node:crypto";\n`
    + `import { join } from "node:path";\n`
    + `import { runNightlyBackupV1 } from ${JSON.stringify(moduleSpecifier)};\n`
    + `const [configurationPath, marker, ready, start, id] = process.argv.slice(2);\n`
    + `const identity = "sha256:${"f".repeat(64)}";\n`
    + `// The same BOUND generation the production producer writes. A worker that\n`
    + `// wrote only a dump would be refused by R4B-01's own-generation check, and\n`
    + `// this test is about the LOCK, so a refusal here would read as a lock bug.\n`
    + `const bind = async (out) => {\n`
    + `  const dump = Buffer.from("dump");\n`
    + `  const metadata = JSON.stringify({ version: 1, identity: { identityDigest: identity } }) + "\\n";\n`
    + `  await writeFile(join(out, "database.dump"), dump);\n`
    + `  await writeFile(join(out, "metadata.json"), metadata);\n`
    + `  await writeFile(join(out, "manifest.json"), JSON.stringify({\n`
    + `    schema: "control-room.verified-database-backup/v1",\n`
    + `    dumpDigest: "sha256:" + createHash("sha256").update(dump).digest("hex"),\n`
    + `    metadataDigest: "sha256:" + createHash("sha256").update(metadata).digest("hex"),\n`
    + `    restoreIdentityDigest: identity }) + "\\n");\n`
    + `};\n`
    + `await writeFile(ready + "/" + id, "ready\\n");\n`
    + `while (true) { try { await access(start); break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); } }\n`
    + `try { await runNightlyBackupV1(configurationPath, { backup: async (c) => { await appendFile(marker, "dump\\n"); await new Promise(resolve => setTimeout(resolve, 200)); await bind(c.out); return { planned: false, identityDigest: identity }; }, listBackups: async () => [], now: () => "2026-09-30T02:30:00.000Z" }); process.exitCode = 0; } catch (error) { process.exitCode = error instanceof Error && error.message === "nightly_backup_concurrent_refused" ? 2 : 3; }\n`,
  { mode: 0o600 });
  await buildWithEsbuild({ entryPoints: [workerSource], outfile: worker, bundle: true, platform: "node", format: "esm",
    logLevel: "silent" });
  const processes = Array.from({ length: 50 }, (_, index) => execFileAsync(process.execPath,
    [worker, configurationPath, marker, ready, start, String(index)])
    .then(() => 0, error => Number((error as { code?: unknown }).code)));
  const deadline = Date.now() + 10_000;
  while ((await readdir(ready)).length !== 50) {
    if (Date.now() > deadline) assert.fail("cross-process backup workers did not reach the start barrier");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await writeFile(start, "start\n", { flag: "wx" });
  const exitCodes = await Promise.all(processes);
  assert.equal(exitCodes.filter(code => code === 0).length, 1);
  assert.equal(exitCodes.filter(code => code === 2).length, 49);
  assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1);
  await assert.rejects(access(configuration.lockFile));
});

test("wraps postgres, supervisor and gateway in Seatbelt and binds PG runtime configuration", () => {
  const generated = bundle(), postgres = plist(generated, "postgres");
  for (const [role, profile] of [["postgres", "service-postgres.sb"], ["supervisor", "service-supervisor.sb"],
    ["gateway", "service-gateway.sb"]] as const) {
    const contents = plist(generated, role);
    assert.match(contents, /<string>\/usr\/bin\/sandbox-exec<\/string>/u);
    assert.match(contents, new RegExp(profile.replace(".", "\\."), "u"));
    assert.match(contents, /<string>--<\/string>[\s\S]*runtime\/[^<]+<\/string>/u);
    assert.match(contents, /<string>RELEASE_ROOT=\/opt\/control-room-test\/releases<\/string>/u);
    assert.match(contents, /<string>UPDATER_ROOT=\/opt\/control-room-test\/updater<\/string>/u);
    assert.doesNotMatch(contents, /<string>RELEASE_ROOT=[^<]*\/current<\/string>/u);
    assert.doesNotMatch(contents, /<string>UPDATER_ROOT=[^<]*\/current<\/string>/u);
  }
  assert.match(postgres, /runtime\/pg-current\/bin\/postgres/u);
  assert.match(postgres, /<string>-D<\/string>\s*<string>\/opt\/control-room-test\/pg\/current<\/string>/u);
  assert.match(postgres, /<string>-k<\/string>\s*<string>\/opt\/control-room-test\/pg\/socket<\/string>/u);
  assert.match(postgres, /<key>ExitTimeOut<\/key>\s*<integer>120<\/integer>/u);
  assert.match(postgres, /launchctl bootout first/u);
  assert.match(postgres, /ssl = off/u);
  for (const name of ["OPENSSL_CONF", "OPENSSL_MODULES", "KRB5_CONFIG", "KRB5_KDC_PROFILE"])
    assert.match(postgres, new RegExp(`<key>${name}</key>`, "u"));
  assert.match(postgres, /runtime\/pg-current\/etc\/openssl\.cnf/u);
  assert.match(postgres, /runtime\/pg-current\/lib\/ossl-modules/u);
  assert.doesNotMatch(postgres, /<string>ssl(?:=|\s)/u);
});

test("describes root-owned log directories and service-owned files without exposing creation", () => {
  const generated = bundle();
  assert.equal(generated.logFiles.length, 12);
  for (const log of generated.logFiles) {
    assert.deepEqual({ owner: log.directoryOwner, group: log.directoryGroup, directoryMode: log.directoryMode,
      fileMode: log.fileMode }, { owner: "root", group: "wheel", directoryMode: "0755", fileMode: "0600" });
    assert.match(log.path, /^\/opt\/control-room-test\/logs\/[^/]+\/(?:out|err)\.log$/u);
  }
  const rotation = generated.resources.find(resource => resource.kind === "newsyslog_config")!;
  assert.equal(rotation.contents.split("\n").filter(line => line && !line.startsWith("#")).length, 0);
  for (const service of generated.services) {
    const contents = generated.resources.find(resource => resource.path === service.plistPath)!.contents;
    assert.match(contents, /service-output\.mjs/u);
    assert.match(contents, /<key>StandardOutPath<\/key>\s*<string>\/dev\/null<\/string>/u);
    assert.match(contents, /<key>StandardErrorPath<\/key>\s*<string>\/dev\/null<\/string>/u);
  }
});

test("the install request makes every daemon output writable by the account that runs it", () => {
  const generated = bundle();
  const permissionBits = (mode: string, ownerMatches: boolean, groupMatches: boolean) => {
    const bits = Number.parseInt(mode, 8), shift = ownerMatches ? 6 : groupMatches ? 3 : 0;
    return (bits >> shift) & 0o7;
  };
  for (const service of generated.services) {
    const files = generated.logFiles.filter(file => file.path === service.standardOutPath
      || file.path === service.standardErrorPath);
    assert.equal(files.length, 2);
    assert.equal(files.every(file => file.accountName === service.accountName && file.groupName === service.groupName
      && (permissionBits(file.fileMode, true, true) & 0o2) === 0o2), true,
    `${service.role} must write its pre-created log files`);
  }
  const nightly = generated.services.find(service => service.role === "nightly-backup")!;
  assert.deepEqual(generated.writableDirectories.map(directory => directory.purpose),
    ["nightly_backup_parent", "nightly_backup_output", "nightly_backup_lock"]);
  for (const directory of generated.writableDirectories) {
    assert.equal(directory.directoryOwner, "root");
    assert.equal(directory.createWith, "mkdir_lchown_nofollow");
    assert.equal(directory.accountName, nightly.accountName);
    assert.equal(directory.directoryGroup, nightly.groupName);
    const required = directory.purpose === "nightly_backup_parent" ? 0o1 : 0o3;
    assert.equal((permissionBits(directory.directoryMode, false, directory.directoryGroup === nightly.groupName) & required), required,
      `simulated ${nightly.accountName} must write ${directory.purpose}`);
  }
});

test("generated plist files pass native plutil only from a disposable root", { skip: process.platform !== "darwin" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "control-room-daemon-plists-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const resource of bundle().resources.filter(resource => resource.kind === "launchd_plist")) {
    const path = join(root, resource.path.split("/").at(-1)!);
    await writeFile(path, resource.contents, { mode: 0o600 });
    const result = await execFileAsync("/usr/bin/plutil", ["-lint", path]);
    assert.match(result.stdout, /OK/u);
  }
});

test("refuses unsafe accounts, paths, unknown input, external PG binaries and known secret bytes", () => {
  for (const changed of [
    { accounts: { ...ACCOUNTS, accounts: { ...ACCOUNTS.accounts, service: "root" } } },
    { accounts: { ...ACCOUNTS, accounts: { ...ACCOUNTS.accounts, database: "staff" } } },
    { installRoot: "relative" }, { installRoot: "/opt/../tmp/control-room" },
    { postgresExecutable: "/opt/homebrew/bin/postgres" },
    { postgresExecutable: `${INSTALL_ROOT}/current/bin/postgres` }, { extra: true },
  ]) assert.throws(() => bundle(changed));
  assert.throws(() => bundle({ installRoot: "/opt/control-room-secret-value", postgresExecutable:
    "/opt/control-room-secret-value/runtime/pg-current/bin/postgres", secretValues: ["secret-value"] }), /secret_refused/u);
});

test("one elevated request binds ordering, logs and bootout-first clean PG stop proof", async () => {
  const fake = successfulPort(), installer = createMacosLaunchDaemonInstallerV1(bundle(), fake.port);
  const first = await installer.install(new AbortController().signal);
  const second = await installer.install(new AbortController().signal);
  assert.deepEqual([first.outcome, second.outcome], ["completed", "unchanged"]);
  assert.equal(fake.requests.length, 2);
  const request = fake.requests[0]!;
  assert.equal(request.resources.length, 9);
  assert.deepEqual(request.resources.find(resource => resource.kind === "protected_config"
    && resource.path.endsWith("/backup.json")), {
    kind: "protected_config", path: `${INSTALL_ROOT}/Protected/config/backup.json`,
    sha256: protectedConfig(bundle()).sha256, contents: protectedConfig(bundle()).contents,
    accountName: ACCOUNTS.accounts.service, groupName: ACCOUNTS.accounts.service, fileMode: "0600",
  });
  assert.equal(request.services.length, 6);
  assert.equal(request.logFiles.length, 12);
  assert.deepEqual(request.writableDirectories, bundle().writableDirectories);
  assert.equal(request.lockName, "xyz.agentcontrolroom.install");
  assert.deepEqual(request.ordering.installBootstrap.slice(0, 2),
    ["xyz.agentcontrolroom.postgres", "xyz.agentcontrolroom.updater"]);
  assert.deepEqual(request.ordering.installRollbackBootout.slice(0, 2),
    ["xyz.agentcontrolroom.updater-guard", "xyz.agentcontrolroom.updater"]);
  assert.deepEqual(request.ordering.uninstallBootout.slice(-2),
    ["xyz.agentcontrolroom.updater-guard", "xyz.agentcontrolroom.updater"]);
  assert.equal(request.postgresShutdown.strategy, "launchctl_bootout_first");
  assert.equal(request.postgresShutdown.requirePostmasterPidAbsent, true);
  assert.equal(request.postgresShutdown.requireSocketClosed, true);
  assert.equal(request.postgresShutdown.requireControlDataShutDown, true);
  assert.deepEqual(request.postgresConfiguration, {
    path: `${INSTALL_ROOT}/pg/current/postgresql.conf`, listenAddresses: "", ssl: "off" });
});

test("a fake privileged implementation uses only its temp root and no nested sudo", async t => {
  const root = await mkdtemp(join(tmpdir(), "control-room-daemon-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commands: string[] = [];
  const port: MacosLaunchDaemonElevatedPortV1 = { async invokeBatch(request) {
    for (const account of [ACCOUNTS.accounts.service, ACCOUNTS.accounts.database, ACCOUNTS.accounts.builder]) commands.push(`dscl:${account}`);
    for (const resource of request.resources) {
      const target = join(root, resource.path.replace(/^\/+/, ""));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, resource.contents!, { mode: 0o600 });
      if (resource.kind === "launchd_plist" && process.platform === "darwin") {
        await execFileAsync("/usr/bin/plutil", ["-lint", target]); commands.push("plutil");
      }
    }
    for (const log of request.logFiles) commands.push(`chown:${log.accountName}`, `mkdir:${log.directoryOwner}`);
    for (const directory of request.writableDirectories) {
      const target = join(root, directory.path.replace(/^\/+/, ""));
      await mkdir(target, { recursive: true, mode: Number.parseInt(directory.directoryMode, 8) });
      commands.push(`mkdir:${directory.path}`, `lchown:${directory.directoryOwner}:${directory.directoryGroup}`);
    }
    for (const label of request.ordering.installBootstrap) commands.push(`launchctl:${label}`);
    return { schema: MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1, requestDigest: request.requestDigest,
      outcome: "completed", inventory: inventory(request) };
  } };
  const result = await createMacosLaunchDaemonInstallerV1(bundle(), port).install(new AbortController().signal);
  assert.equal(result.outcome, "completed");
  assert.equal(commands.some(command => command.startsWith("dscl:")), true);
  assert.equal(commands.some(command => command.startsWith("chown:")), true);
  assert.equal(commands.some(command => command.startsWith("lchown:")), true);
  assert.equal(commands.some(command => command.startsWith("launchctl:")), true);
  assert.equal(commands.some(command => command.startsWith("sudo:")), false);
});

test("rollback and uninstall remove only exact receipt inventory", async () => {
  for (const action of ["rollback", "uninstall"] as const) {
    const files = new Set(["/Library/LaunchDaemons/unrelated.plist", "/etc/newsyslog.d/unrelated.conf"]);
    const calls: MacosLaunchDaemonElevatedBatchRequestV1[] = [];
    const port: MacosLaunchDaemonElevatedPortV1 = { async invokeBatch(request) {
      calls.push(request);
      if (request.action === "install") for (const resource of request.resources) files.add(resource.path);
      else for (const resource of request.resources) files.delete(resource.path);
      return { schema: MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1, requestDigest: request.requestDigest,
        outcome: "completed", inventory: request.action === "install" ? inventory(request) : [] };
    } };
    const installer = createMacosLaunchDaemonInstallerV1(bundle(), port);
    const installed = await installer.install(new AbortController().signal);
    assert.ok(installed.receipt);
    assert.equal((await installer[action](installed.receipt, new AbortController().signal)).outcome, "completed");
    assert.deepEqual([...files].sort(), ["/Library/LaunchDaemons/unrelated.plist", "/etc/newsyslog.d/unrelated.conf"]);
    assert.deepEqual(calls[1]!.resources.map(resource => resource.path).sort(),
      installed.receipt.inventory.map(resource => resource.path).sort());
  }
});

test("missing or changed receipts and forged bundles are refused before elevation", async () => {
  const fake = successfulPort(), installer = createMacosLaunchDaemonInstallerV1(bundle(), fake.port);
  await assert.rejects(installer.uninstall(undefined, new AbortController().signal));
  const installed = await installer.install(new AbortController().signal);
  assert.ok(installed.receipt);
  await assert.rejects(installer.rollback({ ...installed.receipt, inventory: [] }, new AbortController().signal), /receipt_refused/u);
  const generated = bundle(), forged = { ...generated, resources: generated.resources.map((resource, index) => index === 0
    ? { ...resource, path: "/Library/LaunchDaemons/unrelated.plist" } : resource) };
  assert.throws(() => createMacosLaunchDaemonInstallerV1(forged as never, successfulPort().port), /bundle_refused/u);
  assert.equal(fake.requests.length, 1);
});

test("an installer without the shared elevated port is refused", () => {
  assert.throws(() => createMacosLaunchDaemonInstallerV1(bundle(), {} as never), /installer_refused/u);
});

test("a burst of forty concurrent callers admits one batch and refuses thirty-nine", async () => {
  let release!: () => void, entered!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const port: MacosLaunchDaemonElevatedPortV1 = { async invokeBatch(request) {
    calls += 1; entered(); await gate;
    return { schema: MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1, requestDigest: request.requestDigest,
      outcome: "completed", inventory: inventory(request) };
  } };
  const installer = createMacosLaunchDaemonInstallerV1(bundle(), port);
  const first = installer.install(new AbortController().signal);
  await started;
  const burst = await Promise.all(Array.from({ length: 39 }, () => installer.install(new AbortController().signal)));
  assert.equal(burst.every(result => result.outcome === "refused" && result.elevatedCalls === 0), true);
  assert.equal(calls, 1); release(); assert.equal((await first).outcome, "completed");
});

test("halfway rollback is retryable and dropped, malformed or substituted replies fail closed", async () => {
  let calls = 0;
  const retryPort: MacosLaunchDaemonElevatedPortV1 = { async invokeBatch(request) {
    calls += 1;
    return { schema: MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1, requestDigest: request.requestDigest,
      outcome: calls === 1 ? "rolled_back" : "completed", inventory: calls === 1 ? [] : inventory(request) };
  } };
  const installer = createMacosLaunchDaemonInstallerV1(bundle(), retryPort);
  assert.equal((await installer.install(new AbortController().signal)).outcome, "rolled_back");
  assert.equal((await installer.install(new AbortController().signal)).outcome, "completed");

  for (const mode of ["throw", "wrong-request", "wrong-inventory", "malformed"] as const) {
    const port: MacosLaunchDaemonElevatedPortV1 = { async invokeBatch(request) {
      if (mode === "throw") throw new Error("connection dropped");
      if (mode === "malformed") return { changed: true } as never;
      return { schema: MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1,
        requestDigest: mode === "wrong-request" ? request.bundleDigest : request.requestDigest,
        outcome: "completed", inventory: mode === "wrong-inventory" ? [] : inventory(request) };
    } };
    assert.equal((await createMacosLaunchDaemonInstallerV1(bundle(), port)
      .install(new AbortController().signal)).outcome, "uncertain", mode);
  }
});

test("bad input, pre-abort and a stop during a slow helper never retry", async () => {
  const fake = successfulPort(), before = createMacosLaunchDaemonInstallerV1(bundle(), fake.port);
  const preAborted = new AbortController(); preAborted.abort();
  assert.equal((await before.install(preAborted.signal)).outcome, "refused");
  assert.equal(fake.requests.length, 0);
  const controller = new AbortController(); let calls = 0;
  const port: MacosLaunchDaemonElevatedPortV1 = { async invokeBatch(request) {
    calls += 1; await new Promise(resolve => setTimeout(resolve, 25)); controller.abort();
    return { schema: MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1, requestDigest: request.requestDigest,
      outcome: "completed", inventory: inventory(request) };
  } };
  assert.equal((await createMacosLaunchDaemonInstallerV1(bundle(), port).install(controller.signal)).outcome, "uncertain");
  assert.equal(calls, 1);
});


test("database executable paths must name bin/postgres inside the trusted runtime", () => {
  for (const path of [`${INSTALL_ROOT}/runtime`, `${INSTALL_ROOT}/runtime/pg-current`, `${INSTALL_ROOT}/runtime/pg-current/bin`])
    assert.throws(() => bundle({ postgresExecutable: path }), /executable_refused/u);
  assert.ok(bundle());
});
