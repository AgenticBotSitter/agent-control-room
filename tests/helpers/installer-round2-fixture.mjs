import { DiskReserveV1 } from "../../src/updater/v1/actuator.mjs";
import { recordPasskeyStatusV1 } from "../../src/updater/v1/pg/initial-passkey-ports.mjs";
import { createHash, createPublicKey } from "node:crypto";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { signAttendedConnectorReleaseV1 } from "../../src/updater/v1/install/connector-release.mjs";
import { composeProtectedConfigV1 } from "../../src/updater/v1/services/protected-config.mjs";
import { captureReleaseTrustV1 } from "../../scripts/release-signing.mjs";
import { INSTALL_DATABASE_LOGINS_V1 } from "../../src/updater/v1/install/install-steps.mjs";
import { verifyAttendedBuildOutputV1 } from "../../src/updater/v1/attended-source.mjs";
import { FileStepJournalV1 } from "../../src/updater/v1/journal.mjs";
import { remintOwnerCodeV1, rollbackOwnerCodeV1 } from "../../src/updater/v1/install/stage-one-ports.mjs";
import { recoverServicesV1 } from "../../src/updater/v1/services/installer.mjs";
import {
  CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1, CONTROL_ROOM_SUDOERS_V1, DEFAULT_CONTROL_ROOM_ROOT_V1,
  DEFAULT_CONTROL_ROOM_GATEWAY_PORT_V1, DEFAULT_CONTROL_ROOM_WEB_PORT_V1,
  assertInstallerRootSafetyV1, digestControlRoomCheckoutV1, installControlRoomV1,
  statusControlRoomV1, uninstallFreshControlRoomV1,
} from "../../src/updater/v1/install/installer.mjs";
import { assertExclusiveServeV1, continueInstallV1, initialPasskeyUrlV1 } from "../../src/updater/v1/install/install-steps.mjs";
import { assertNoLiveRehearsalCollisionsV1 } from "../../src/updater/v1/install/rehearsal-config.mjs";
import nativePorts, { invalidateSudoTimestampV1, parseTailscaleJsonV1, readTailscaleRpIdV1,
  runTailscaleCliV1, sudoSecurePathIsActiveV1 } from "../../src/updater/v1/cli/control-room-native-ports.mjs";
import { installerPortModulePathV1, parseInstallerArgumentsV1, parseInvokingArgumentsV1,
  CONTROL_ROOM_INSTALLER_CAPABILITIES_V1, runUpdaterCliV1 } from "../../src/updater/v1/cli.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONTROL_ROOM_SHIM_V1 = await readFile(join(repository, "src/updater/v1/bin/control-room"), "utf8");
const accountPolicy = Object.freeze({ schema: "control-room.accounts/v1",
  accounts: { service: "_testsvc", database: "_testdb", builder: "_testbuild" } });
let fakePortSequence = 0;

async function temporary(name) { return realpath(await mkdtemp(join(tmpdir(), `control-room-installer-${name}-`))); }
async function cleanup(path) {
  async function thaw(current) {
    const entry = await lstat(current).catch(() => null);
    if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) return;
    await chmod(current, 0o700).catch(() => {});
    for (const name of await readdir(current).catch(() => [])) await thaw(join(current, name));
  }
  await thaw(path); await rm(path, { recursive: true, force: true });
}

async function makeSource(path, version = "1.2.3") {
  await mkdir(join(path, "dist"), { recursive: true });
  await writeFile(join(path, "package.json"), `${JSON.stringify({ name: "control-room", version })}\n`);
  await writeFile(join(path, "dist", "server.mjs"), "export const ready = true;\n", { mode: 0o755 });
  return { kind: "checkout", source: path, version, digest: await digestControlRoomCheckoutV1(path) };
}

async function makeBareGithub(path) {
  const bare = join(path, "github.git"), checkout = join(path, "github-checkout");
  const run = (args, cwd) => {
    const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  run(["init", "--bare", bare]); run(["init", checkout]);
  run(["config", "user.name", "Fixture Owner"], checkout); run(["config", "user.email", "fixture@example.invalid"], checkout);
  await writeFile(join(checkout, "package.json"), '{"name":"control-room","version":"1.2.3"}\n');
  await mkdir(join(checkout, "src")); await writeFile(join(checkout, "src/fixture.mjs"), "export const ready=true;\n");
  run(["add", "."], checkout); run(["commit", "-m", "fixture"], checkout);
  const commit = run(["rev-parse", "HEAD"], checkout);
  run(["remote", "add", "origin", bare], checkout); run(["push", "origin", "HEAD:main"], checkout);
  return { bare, commit };
}

function paths(base) {
  return { shim: join(base, "system", "usr-local-bin", "control-room"),
    sudoers: join(base, "system", "sudoers.d", "control-room"), sudoersMain: join(base, "system", "sudoers"),
    cronDeny: join(base, "system", "cron.deny"), atDeny: join(base, "system", "at.deny") };
}
async function prepareSystemPaths(base) {
  const value = paths(base);
  for (const path of [value.shim, value.sudoers, value.cronDeny, value.atDeny]) await mkdir(dirname(path), { recursive: true });
  await writeFile(value.sudoersMain, "#includedir /private/etc/sudoers.d\n");
  await writeFile(value.cronDeny, "daemon\n"); await writeFile(value.atDeny, "daemon\n");
  return value;
}

function fakePorts(options = {}) {
  const calls = [], users = [...(options.users ?? [])], groups = [...(options.groups ?? [])], deny = new Map();
  let id = options.idStart ?? ++fakePortSequence * 1000;
  let serve = structuredClone(options.initialServe ?? { Web: { "fixture.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4383" } } } },
    TCP: {}, AllowFunnel: {} });
  async function validateOutput(path) {
    for (const name of await readdir(path)) {
      const child = join(path, name), entry = await lstat(child);
      if (entry.isDirectory()) await validateOutput(child);
      else if (!entry.isFile() || entry.nlink !== 1) throw new Error("source_hardlink_refused");
      else if ((entry.mode & 0o022) !== 0) throw new Error("source_ownership_refused");
    }
  }
  async function seal(path) {
    for (const name of await readdir(path)) {
      const child = join(path, name), entry = await lstat(child);
      if (entry.isDirectory()) { await seal(child); await chmod(child, 0o550); }
      else await chmod(child, (entry.mode & 0o111) !== 0 ? 0o550 : 0o440);
    }
    await chmod(path, 0o550);
  }
  async function oldLink(path) {
    return lstat(path).then(entry => entry.isSymbolicLink() ? readlink(path) : Promise.reject(new Error("release_pointer_refused")),
      error => error?.code === "ENOENT" ? null : Promise.reject(error));
  }
  async function setLink(path, target) {
    await rm(path, { force: true }); if (target !== null && target !== undefined) await symlink(target, path);
  }
  async function markServices(root, roles, protectedConfig = []) {
    await mkdir(join(root, "fake-plists"), { recursive: true });
    for (const role of roles) await writeFile(join(root, "fake-plists", role), "loaded\n");
    for (const resource of protectedConfig) {
      await mkdir(dirname(resource.path), { recursive: true }); await writeFile(resource.path, resource.contents);
    }
  }
  async function clearServices(root, roles) {
    for (const role of roles) await rm(join(root, "fake-plists", role), { force: true });
    if (roles.includes("supervisor")) {
      for (const name of ["host.json", "local-owner-session.json", "fleet-gateway.json", "supervisor.json", "backup.json"])
        await rm(join(root, "Protected/config", name), { force: true });
      await rm(join(root, "updater-state/updater.json"), { force: true });
    }
  }
  function serve443() {
    const entries = Object.entries(serve.Web ?? {}).filter(([key]) => key.endsWith(":443"));
    return entries.length === 1 ? entries[0] : undefined;
  }
  function setServe443(target) {
    const current = serve443(), web = { ...(serve.Web ?? {}) };
    if (current) delete web[current[0]];
    if (target !== null) web[current?.[0] ?? "fixture.ts.net:443"] = { Handlers: { "/": { Proxy: target } } };
    serve = { ...serve, Web: web };
  }
  return {
    diskReserve: root => new DiskReserveV1(root, { reserveBytes: 4096, minimumHeadroomBytes: 1024 }),
    calls, users, groups, serveState: () => structuredClone(serve),
    geteuid: () => options.euid ?? 0,
    now: () => "2026-09-30T12:34:56.000Z", randomId: () => `123e4567-e89b-42d3-a456-${String(++id).padStart(12, "0")}`,
    randomBytes: size => Buffer.alloc(size, 7),
    inspectOwnership: async path => options.ownership?.(path) ?? { type: "directory", symlink: false, uid: 0, gid: 0, mode: 0o755 },
    lchownPath: async (path, uid, gid) => { calls.push(["lchown", path, uid, gid]); },
    readAccountInventory: async () => ({ users: structuredClone(users), groups: structuredClone(groups) }),
    async createAccount(input) {
      calls.push(["create-account", input]);
      if (options.failAccount === input.name) throw new Error("account_create_failed");
      users.push({ name: input.name, uid: input.uid, gid: input.gid, home: input.home, shell: input.shell, hidden: input.hidden,
        password: input.password, memberships: [] });
      groups.push({ name: input.name, gid: input.gid });
    },
    async deleteAccount(name) {
      calls.push(["delete-account", name]);
      const user = users.findIndex(row => row.name === name), group = groups.findIndex(row => row.name === name);
      if (user >= 0) users.splice(user, 1); if (group >= 0) groups.splice(group, 1);
    },
    async ensureDenyEntry(path, name) { calls.push(["deny-add", path, name]); const key = `${path}\0${name}`;
      const added = !deny.has(key); deny.set(key, true); return added; },
    async removeDenyEntry(path, name) { calls.push(["deny-remove", path, name]); deny.delete(`${path}\0${name}`); },
    async installRootFile(path, text, owner) { calls.push(["install-root-file", path, text, owner]);
      const current = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (current) {
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
          || (current.mode & 0o777) !== owner.mode || await readFile(path, "utf8") !== text) throw new Error("existing_root_file_refused");
        return false;
      }
      await writeFile(path, text, { mode: owner.mode }); await chmod(path, owner.mode); return true; },
    async removeRootFile(path) { calls.push(["remove-root-file", path]); await options.removeRootFileGate?.(path); await rm(path, { force: true }); },
    validateSudoers: async () => options.validSudoers !== false,
    sudoSecurePathIsActive: async () => options.includesSudoers !== false,
    assertT1Path: async (path, policy = {}) => { calls.push(["t1", path, policy]);
      if (options.failT1Executable && policy.executable === true) throw new Error("t1_refused"); return path; },
    assertRuntimeTreeRootMetadata: async input => { calls.push(["runtime-root-metadata", input]);
      if (options.failMetadata === input.tree) throw new Error("metadata_refused"); return { entries: 2 }; },
    assertSeatbeltApplied: async input => { calls.push(["seatbelt", input]);
      if (options.failSeatbelt === input.role) throw new Error("seatbelt_refused");
      return { role: input.role, applied: true, skipped: false }; },
    assertRehearsalOwnerDenied: async input => { calls.push(["owner-denial", input]);
      if (options.failOwnerDenial === input.operation) throw new Error("owner_denial_refused");
      return { uid: input.identity.uid, operation: input.operation, denied: true }; },
    async verifyBootstrapSourceV1(input) { calls.push(["verify-bootstrap-source", input]);
      if (options.failC4 === "verify") throw new Error("c4_verify_failed");
      return { treeEntries: 3, sourceDigest: `sha256:${"d".repeat(64)}` }; },
    async adoptBootstrapV1(input) { calls.push(["adopt-bootstrap", input]);
      calls.push(["owner-prompt", "token"]);
      if (options.failC4 === "adopt") throw new Error("c4_adopt_failed");
      await mkdir(join(input.root, "updater-state"), { recursive: true });
      const mirror = join(input.root, "updater-state", "mirror.git");
      if (await lstat(mirror).then(() => true, () => false)) await rename(mirror, `${mirror}.old-${input.transactionId}`);
      await mkdir(mirror); await writeFile(join(input.root, "updater-state", "github-read.token"), "fixture-token\n", { mode: 0o600 });
      await writeFile(join(input.root, "updater-state", "source.json"), `${JSON.stringify({
        schema: "control-room.attended-source/v1", remoteUrl: input.remoteUrl })}\n`, { mode: 0o600 });
      return { mirror: true, token: true, source: true, movedAside: [] }; },
    async removeAdoptedBootstrapV1(root) { calls.push(["remove-adopted-bootstrap", root]);
      await rm(join(root, "updater-state", "mirror.git"), { recursive: true, force: true });
      await rm(join(root, "updater-state", "github-read.token"), { force: true });
      await rm(join(root, "updater-state", "source.json"), { force: true }); },
    async seedUpdaterV1(input) { calls.push(["seed-updater", input]);
      if (options.failC4 === "seed") throw new Error("c4_seed_failed");
      const dir = join(input.root, "updater", `seed-${input.commit.slice(0, 12)}`); await mkdir(dir, { recursive: true });
      return { dir, digest: `sha256:${"e".repeat(64)}` }; },
    async loadInstallStepsV1(input) { calls.push(["load-install-steps", input]);
      if (options.failInstallSteps || options.failC4 === "load") throw new Error("install_steps_refused");
      return { module: "lib/install-steps.mjs", bundleDigest: input.expectedDigest, createStageOnePortsV1: value => value,
        continueInstallV1: async context => {
        calls.push(["continue-install", context]); return continueInstallV1(context);
      } }; },
    async vendorRuntime(input) { calls.push(["vendor-runtime", input]);
      calls.push(["curl", [...input.tools]]);
      if (options.failC4 === "runtime") throw new Error("c4_runtime_failed");
      if (input.tools.includes("postgresql")) {
        if (options.failStep === "vendor-pg-runtime") throw new Error("fixture_step_failure");
        return { installed: { postgresql: { version: "17.11", dir: "postgresql-17.11",
          archiveSha256: `sha256:${"1".repeat(64)}`, executableSha256: `sha256:${"2".repeat(64)}` } },
        links: { "pg-current": "postgresql-17.11", "pg-previous": "postgresql-17.11" } };
      }
      assert.deepEqual(input.tools, ["node", "pnpm", "esbuild"]); return { installed: {}, links: {}, undo: {} }; },
    async rollbackRuntime(input) { calls.push(["rollback-runtime", input]); },
    async fetchVerifiedSourceV1(input) { calls.push(["fetch-source", input]);
      await input.onSpawn?.({ file: "/usr/bin/git" });
      if (options.bareRepository) {
        const checked = spawnSync("/usr/bin/git", ["--git-dir", options.bareRepository, "cat-file", "-e", `${input.commit}^{commit}`],
          { encoding: "utf8" });
        if (checked.status !== 0) throw new Error("updater_fetch_refused");
      }
      const job = join(input.root, "build", `job-${input.commit.slice(0, 12)}`);
      return { job, source: join(job, "src"),
        tree: { entries: 3, bytes: 100 }, mainCommit: input.commit }; },
    async buildReleaseV1(input) { calls.push(["build-release", input]); await options.buildGate?.();
      await input.onSpawn?.({ file: "/usr/bin/git" });
      const built = options.buildResult ? await options.buildResult(input)
        : await makeSource(join(input.job, "output"), options.version ?? "1.2.3");
      if (!built) throw new Error("attended_build_result_refused");
      await validateOutput(built.source);
      const version = built.version ?? options.version ?? "1.2.3";
      return { output: built.source, releaseId: `${version}-${input.commit.slice(0, 12)}`,
        manifestDigest: built.digest, fileCount: 2, byteCount: 50 }; },
    async buildFixedBundleV1(input) { calls.push(["build-updater-bundle", input]);
      const bundle = join(input.job, "fixed-updater", "bundle"); await mkdir(bundle, { recursive: true });
      await writeFile(join(bundle, "updater.mjs"), "export const ready=true;\n", { mode: 0o500 });
      return { bundle, uver: `${options.version ?? "1.2.3"}-${input.commit.slice(0, 12)}`, bundleDigest: `sha256:${"b".repeat(64)}` }; },
    async runningBundleDigestV1() { return options.runningBundleDigest ?? null; },
    async classifyAttendedSourceV1(input) { calls.push(["classify-source", input]);
      return { changedPaths: options.changesDatabase ? ["db/migrations/fixture.sql"] : ["src/fixture.mjs"],
        changesDatabase: options.changesDatabase === true }; },
    async confirmAttendedV1(input) { calls.push(["confirm", input]);
      calls.push(["owner-prompt", "six-words"]);
      return { planId: `plan-${input.commit.slice(0, 12)}`, planDigest: `sha256:${"c".repeat(64)}` }; },
    async stageReleaseV1(input) { calls.push(["stage-release", input]);
      if (options.badStageTarget) return { target: join(input.root, "updater-state", "wrong-target") };
      const target = join(input.root, "releases", input.releaseId);
      if (await lstat(target).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error)))
        throw new Error("updater_install_target_exists");
      await cp(input.output, target, { recursive: true }); await seal(target); return { target }; },
    async stageUpdaterBundleV1(input) { calls.push(["stage-updater", input]);
      if (options.failUpdaterStage) throw new Error("updater_stage_failed");
      const target = join(input.root, "updater", input.uver);
      if (await lstat(target).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error)))
        throw new Error("updater_install_target_exists");
      await cp(input.bundle.bundle, target, { recursive: true }); await seal(target); return { target }; },
    async switchPairV1(input) { calls.push(["switch-pair", input]);
      if (input.restore) {
        await setLink(join(input.root, "current"), input.restore.oldCurrent);
        await setLink(join(input.root, "previous"), input.restore.oldPrevious);
        await setLink(join(input.root, "updater/current"), input.restore.oldUpdaterCurrent);
        await setLink(join(input.root, "updater/previous"), input.restore.oldUpdaterPrevious);
        return { restored: true };
      }
      const oldCurrent = await oldLink(join(input.root, "current")), oldPrevious = await oldLink(join(input.root, "previous"));
      const oldUpdaterCurrent = await oldLink(join(input.root, "updater/current"));
      const oldUpdaterPrevious = await oldLink(join(input.root, "updater/previous"));
      await setLink(join(input.root, "previous"), oldCurrent ?? `releases/${input.release.releaseId}`);
      await setLink(join(input.root, "current"), `releases/${input.release.releaseId}`);
      if (input.updateUpdater) {
        await setLink(join(input.root, "updater/previous"), oldUpdaterCurrent ?? input.bundle.uver);
        await setLink(join(input.root, "updater/current"), input.bundle.uver);
      }
      await cleanup(dirname(input.release.output));
      return { oldCurrent, oldPrevious, oldUpdaterCurrent, oldUpdaterPrevious }; },
    async abortAttendedV1(input) { calls.push(["abort-attended", input]); await cleanup(input.job); },
    generateVapidKeys: async () => ({ publicKey: "fixture-public", privateKey: "fixture-private" }),
    generateWorkIntakeKeys: async () => ({ schema: "fixture", signingKey: "fixture-private-value" }),
    readGithubCredential: async () => "fixture-read-only-credential",
    async initializeDatabase(input) { calls.push(["database-phase", input]);
      if (options.failStep === (input.phase === "init" ? "init-database" : "apply-release-schema")) throw new Error("fixture_step_failure");
      if (input.phase === "init") { await mkdir(join(input.root, "pg", input.pgDataId), { recursive: true });
        await writeFile(join(input.root, "pg", input.pgDataId, "PG_VERSION"), "17\n"); }
      return input.phase === "init" ? { schema: "control-room.database-init-result/v1", outcome: "initialized",
        pgDataId: input.pgDataId, updaterSchemaDigest: `sha256:${"3".repeat(64)}`, clusterShutDownClean: true }
        : { schema: "control-room.release-schema-result/v1", outcome: "applied",
          schemaDigest: `sha256:${"4".repeat(64)}`, ledgerHead: "0238_updater_health_counts.sql" }; },
    async writeDatabaseLogins(input) { calls.push(["write-database-logins", input]);
      await mkdir(join(input.root, "Protected/service"), { recursive: true });
      await writeFile(join(input.root, "Protected/service/db-logins.json"), "{}\n");
      return { path: join(input.root, "Protected/service/db-logins.json"), references: Object.keys(input.passwords)
        .map(name => ({ name, passwordDigest: `sha256:${"5".repeat(64)}`, fileRef: "Protected/service/db-logins.json" })) }; },
    async removeDatabaseLogins(input) { calls.push(["remove-database-logins", input]);
      await rm(join(input.root, "Protected/service/db-logins.json"), { force: true }); },
    async firstOwner(input) { calls.push(["first-owner", input]); if (options.failStep === "first-owner") throw new Error("fixture_step_failure");
      return { tenantId: "tenant-fixture", workspaceId: "workspace-fixture", provider: "local", subject: "owner-fixture" }; },
    async installGuard(input) { calls.push(["install-guard", input]); if (options.failStep === "install-guard") throw new Error("fixture_step_failure");
      return { digest: `sha256:${"6".repeat(64)}`, target: input.target }; },
    async removeGuard(input) { calls.push(["remove-guard", input]); await rm(join(input.root, "guard/guard.sh"), { force: true }); },
    async composeProtectedConfig(input) { calls.push(["compose-protected-config", input]);
      return ["host.json", "local-owner-session.json", "fleet-gateway.json", "supervisor.json", "backup.json"]
        .map(name => ({ path: join(input.root, "Protected/config", name), contents: name === "fleet-gateway.json" ? `${JSON.stringify({ healthProbeKeyFile: join(input.root, "Protected/service/health-probe.key") })}\n` : "{}\n",
          accountName: accountPolicy.accounts.service, groupName: accountPolicy.accounts.service, fileMode: "0600" }))
        .concat([{ path: join(input.root, "updater-state/updater.json"), contents: "{}\n",
          accountName: "root", groupName: "wheel", fileMode: "0600" }]); },
    async installServices(input) { calls.push(["install-services", input]); if (options.failServices || options.failStep ===
      (input.roles[0] === "postgresql17" ? "install-database-service" : "install-services")) throw new Error("services_failed");
      if (!options.serviceResult) await markServices(input.root, input.roles, input.protectedConfig);
      const result = { bundleDigest: `sha256:${"7".repeat(64)}`, receipt: { schema: "control-room.services-receipt/v1",
        receiptDigest: `sha256:${"8".repeat(64)}`, roles: [...input.roles] } };
      return options.serviceResult ?? result; },
    async uninstallServices(input) { calls.push(["uninstall-services", input]);
      await clearServices(input.root, input.receipt?.roles ?? []); return { removed: true }; },
    async recoverServices(input) { calls.push(["recover-services", input]);
      await clearServices(input.root, input.roles); return { outcome: "recovered" }; },
    async killAccountProcesses(input) { calls.push(["kill-account-processes", input]); },
    async retireDatabase(input) { calls.push(["retire-database", input]);
      await rm(join(input.root, "pg", input.pgDataId), { recursive: true, force: true }); },
    async restartServices(input) { calls.push(["restart-services", input]);
      if (options.failRestart && !input.rollback) throw new Error("restart_failed_part_way"); return { restarted: true }; },
    async readTailscaleRpId(input) { calls.push(["read-tailscale-rp-id", input]); return options.rpId ?? "fixture.ts.net"; },
    async captureTailscaleServe(input) { calls.push(["capture", input]); return { schema: "control-room.tailscale-serve-443/v1",
      target: serve443()?.[1]?.Handlers?.["/"]?.Proxy ?? null }; },
    async activateTailscaleServe(input) { calls.push(["activate", input]); if (options.connectionDrop) throw new Error("connection_dropped");
      if (options.serveAfter) serve = structuredClone(options.serveAfter);
      else setServe443(`http://127.0.0.1:${input.webPort}`); },
    inspectTailscaleServe: async () => structuredClone(serve),
    async recordTailscaleServe(input) { calls.push(["record-serve", input]);
      await writeFile(join(input.root, "updater-state/serve.json"), `${JSON.stringify(input.serve)}\n`);
      return { serveDigest: `sha256:${"9".repeat(64)}` }; },
    async readLiveServePort(input) { calls.push(["read-live-serve-port", input]); return options.livePort ?? 7864; },
    async restoreTailscaleServe(input) { calls.push(["restore", input]); setServe443(input.snapshot.target); },
    async moveLiveDatabase(input) { calls.push(["move-db", input]); if (options.failDatabaseMove) throw new Error("database_move_failed");
      return { verified: true }; },
    async checkHealth(input) { calls.push(["health", input]); if (options.failHealth || options.failStep === "health-check") throw new Error("health_failed");
      return { healthy: true, samples: 3, schemaDigest: input.schemaDigest }; },
    async seedKnownGood(input) { calls.push(["seed-known-good", input]); if (options.failStep === "seed-known-good") throw new Error("fixture_step_failure");
      await writeFile(join(input.root, "updater-state/known-good"), "fixture\n");
      return { releaseId: input.releaseId, pgDataId: input.pgDataId, schemaDigest: input.schemaDigest }; },
    async removeKnownGood(input) { calls.push(["remove-known-good", input]); await rm(join(input.root, "updater-state/known-good"), { force: true }); },
    async remintOwnerCode(input) { calls.push(["mint-owner-session", input]); if (options.failStep === "mint-owner-session") throw new Error("fixture_step_failure");
      const ownerCode = "owner-code-fixture-value-1234567890";
      return { ownerCode, ownerCodeDigest: `sha256:${"a".repeat(64)}`, receipt: { id: "owner-session-fixture" } }; },
    async rollbackOwnerCode(input) { calls.push(["rollback-owner-code", input]); },
    async startPostHealthServices(input, proof) { calls.push(["post-health-services", input, proof]);
      assert.deepEqual(proof, { healthAccepted: true, knownGoodAccepted: true });
      if (options.failStep === "install-post-health-services") throw new Error("fixture_step_failure");
      await markServices(input.root, input.roles);
      return { bundleDigest: `sha256:${"b".repeat(64)}`, receipt: { schema: "control-room.services-receipt/v1",
        receiptDigest: `sha256:${"c".repeat(64)}`, roles: [...input.roles] } }; },
    async registerInitialPasskey(input) { calls.push(["register-passkey", input]);
      calls.push(["owner-prompt", "six-character-code"]);
      assert.equal(input.qr.ownerCodePolicy, "every-unconsumed-attempt");
      assert.equal(typeof input.terminal?.write, "function"); assert.equal(typeof input.terminal?.readLine, "function");
      if (options.passkeyFailure) throw Object.assign(new Error("passkey_terminal_required"), { code: "passkey_terminal_required" });
      const urls = ["registration-secret-one", "registration-secret-two"].map(registrationSecret => initialPasskeyUrlV1({
        rpId: "fixture.ts.net", ownerCode: input.ownerCode, registrationSecret }));
      calls.push(["passkey-urls", urls]);
      return { status: "registered", credentialIdDigest: `sha256:${"d".repeat(64)}`, attempts: 1 }; },
    async recordPasskeyStatus(input) { calls.push(["passkey-status", input]); return recordPasskeyStatusV1(input); },
    async cleanupBootstrap(input) { calls.push(["cleanup-bootstrap", input]); return { removed: true }; },
    async invalidateSudoTimestamp(user) { calls.push(["sudo-K", user]); },
    async processIdentity(pid) { return options.processIdentity?.(pid) ?? `fixture-process-${pid}`; },
    afterJournalEntry: options.afterJournalEntry,
  };
}

async function fixture(t, name, portOptions = {}, installOptions = {}) {
  const base = await temporary(name); t.after(() => cleanup(base));
  const root = join(base, "install"), bootstrap = join(base, "bootstrap"), systemPaths = await prepareSystemPaths(base), ports = fakePorts(portOptions);
  await mkdir(bootstrap); await writeFile(join(bootstrap, "node.tar.gz"), "node");
  await writeFile(join(bootstrap, "bootstrap.json"), `${JSON.stringify({ schema: "control-room.bootstrap/v1",
    commit: "a".repeat(40), remoteUrl: "https://github.com/AgenticBotSitter/agent-control-room.git",
    git: "/usr/bin/git", node: { version: "fixture" } })}\n`, { mode: 0o600 });
  const options = { root, commit: "a".repeat(40), webPort: 4383, replacingLive: false,
    bootstrap, invokingUser: { user: "fixture-owner", uid: 501, gid: 20 }, accountsPolicy: accountPolicy, systemPaths, ports, ...installOptions };
  options.terminal ??= Object.freeze({ write() {}, async readLine() { return "ABC234"; }, isTTY: true, setRawMode() {} });
  return { base, root, bootstrap, systemPaths, ports, options };
}

async function rehearsalConfig(path, root, overrides = {}) {
  const labels = {
    postgresql17: "xyz.agentcontrolroom.rehearsal.postgres",
    supervisor: "xyz.agentcontrolroom.rehearsal.supervisor",
    "fleet-gateway": "xyz.agentcontrolroom.rehearsal.gateway",
    "nightly-backup": "xyz.agentcontrolroom.rehearsal.nightly-backup",
    updater: "xyz.agentcontrolroom.rehearsal.updater",
    "updater-guard": "xyz.agentcontrolroom.rehearsal.updater-guard",
  };
  const value = {
    schema: "control-room.e2e2-rehearsal-config/v1", root,
    accounts: { service: "_controlroom_rehearsal", database: "_crdb_rehearsal", builder: "_crbuild_rehearsal" },
    launchdLabels: labels,
    ports: { web: 4383, gateway: 4384 }, tailnetName: "fixture-rehearsal.ts.net",
    tailscale: { mode: "skip", expectedStepOutcome: "skipped (rehearsal)", mutationAllowed: false },
    database: { mode: "fresh" }, authenticator: { kind: "software", userVerification: "required" },
    installerArgumentTemplate: [], observedInstallerFlags: [], missingInstallerFlags: [], ...overrides,
  };
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await chmod(path, 0o600);
  return value;
}

function runProgram(file, args, environment) {
  return new Promise((resolveResult, reject) => {
    const env = { ...process.env, ...environment };
    for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
    const child = spawn(file, args, { cwd: repository, env,
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}
async function runChild(file, environment, args = []) {
  const env = { ...process.env, ...environment };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  let child;
  try {
    return await new Promise((resolveResult, reject) => {
      child = spawn(process.execPath, [file, ...args], { cwd: repository, env, detached: true,
        stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
    });
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
  }
}

export { fixture, fakePorts, cleanup, rehearsalConfig };
