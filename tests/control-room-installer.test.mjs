import { DiskReserveV1 } from "../src/updater/v1/actuator.mjs";
import { recordPasskeyStatusV1 } from "../src/updater/v1/pg/initial-passkey-ports.mjs";
import { createHash, createPublicKey } from "node:crypto";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { signAttendedConnectorReleaseV1 } from "../src/updater/v1/install/connector-release.mjs";
import { composeProtectedConfigV1 } from "../src/updater/v1/services/protected-config.mjs";
import { captureReleaseTrustV1 } from "../scripts/release-signing.mjs";
import { INSTALL_DATABASE_LOGINS_V1 } from "../src/updater/v1/install/install-steps.mjs";
import { verifyAttendedBuildOutputV1 } from "../src/updater/v1/attended-source.mjs";
import { FileStepJournalV1 } from "../src/updater/v1/journal.mjs";
import { remintOwnerCodeV1, rollbackOwnerCodeV1 } from "../src/updater/v1/install/stage-one-ports.mjs";
import { recoverServicesV1 } from "../src/updater/v1/services/installer.mjs";
import {
  CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1, CONTROL_ROOM_SUDOERS_V1, DEFAULT_CONTROL_ROOM_ROOT_V1,
  DEFAULT_CONTROL_ROOM_GATEWAY_PORT_V1, DEFAULT_CONTROL_ROOM_WEB_PORT_V1,
  assertInstallerRootSafetyV1, digestControlRoomCheckoutV1, installControlRoomV1,
  statusControlRoomV1, uninstallFreshControlRoomV1,
} from "../src/updater/v1/install/installer.mjs";
import { assertExclusiveServeV1, continueInstallV1, initialPasskeyUrlV1 } from "../src/updater/v1/install/install-steps.mjs";
import { assertRehearsalInvocationV1, assertNoLiveRehearsalCollisionsV1 } from "../src/updater/v1/install/rehearsal-config.mjs";
import nativePorts, { invalidateSudoTimestampV1, parseTailscaleJsonV1, readTailscaleRpIdV1,
  runTailscaleCliV1, sudoSecurePathIsActiveV1 } from "../src/updater/v1/cli/control-room-native-ports.mjs";
import { installerPortModulePathV1, parseInstallerArgumentsV1, parseInvokingArgumentsV1,
  CONTROL_ROOM_INSTALLER_CAPABILITIES_V1, canonicalJsonV1, runUpdaterCliV1 } from "../src/updater/v1/cli.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
  // Populate the disposable bare repository without issuing a push command.
  run(["fetch", checkout, "HEAD:refs/heads/main"], bare);
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

test("default root and every existing ancestor must be root-owned and not writable", async () => {
  assert.equal(DEFAULT_CONTROL_ROOM_ROOT_V1, "/Library/Application Support/Control Room");
  await assertInstallerRootSafetyV1({ root: DEFAULT_CONTROL_ROOM_ROOT_V1, ports: fakePorts() });
  const bad = fakePorts({ ownership: path => path === "/Library" ? { type: "directory", symlink: false, uid: 501, gid: 20, mode: 0o755 }
    : { type: "directory", symlink: false, uid: 0, gid: 0, mode: 0o755 } });
  await assert.rejects(assertInstallerRootSafetyV1({ root: DEFAULT_CONTROL_ROOM_ROOT_V1, ports: bad }), /install_root_ancestor_refused/u);
});

test("install creates isolated accounts, exact layout, root-only custody, secure shim, sudoers and Off flag", async t => {
  const f = await fixture(t, "happy", { groups: [{ name: "taken-gid", gid: 300 }] });
  const result = await installControlRoomV1(f.options);
  assert.equal(result.state, "installed");
  const creates = f.ports.calls.filter(call => call[0] === "create-account").map(call => call[1]);
  assert.deepEqual(creates.map(row => row.uid), [301, 302, 303]);
  assert(creates.every(row => row.uid === row.gid && row.home === "/var/empty" && row.shell === "/usr/bin/false" && row.hidden
    && row.password === "*"));
  assert.equal(await readFile(f.systemPaths.shim, "utf8"), CONTROL_ROOM_SHIM_V1);
  assert.equal((await stat(f.systemPaths.shim)).mode & 0o777, 0o555);
  assert.equal(await readFile(f.systemPaths.sudoers, "utf8"), CONTROL_ROOM_SUDOERS_V1);
  assert.equal((await stat(f.systemPaths.sudoers)).mode & 0o777, 0o440);
  assert.equal(await readFile(join(f.root, "updater-state", "self-update"), "utf8"), "Off\n");
  assert.equal(await readFile(join(f.root, "updater-state", "vapid.json"), "utf8"),
    '{"publicKey":"fixture-public","privateKey":"fixture-private"}\n');
  assert.equal(await readFile(join(f.root, "Protected", "service", "vapid-public.json"), "utf8"),
    '{"publicKey":"fixture-public"}\n');
  await assert.rejects(readFile(join(f.root, "Protected", "service", "vapid.json")), { code: "ENOENT" });
  for (const role of ["supervisor", "gateway", "postgres", "builder", "upgrader", "updater", "updater-guard"]) {
    assert.equal((await stat(join(f.root, "logs", role))).mode & 0o777, 0o755);
    assert.equal((await stat(join(f.root, "logs", role, "out.log"))).mode & 0o777, 0o600);
    assert(f.ports.calls.some(call => call[0] === "lchown" && call[1] === join(f.root, "logs", role)
      && call[2] === 0 && call[3] === 0));
  }
  assert(f.ports.calls.some(call => call[0] === "lchown" && call[1] === join(f.root, "logs/upgrader/out.log")
    && call[2] === 302 && call[3] === 302));
  await assert.rejects(lstat(join(f.root, "backups", "staging")), { code: "ENOENT" });
  await assert.rejects(lstat(join(f.root, "updater-state", "scratch")), { code: "ENOENT" });
  assert.equal(f.ports.calls.filter(call => call[0] === "sudo-K" && call[1]?.user === "fixture-owner"
    && call[1]?.uid === 501 && call[1]?.gid === 20).length, 2);
  assert.equal(typeof f.ports.calls.find(call => call[0] === "build-release")[1].spawnTrusted, "function");
});

test("release files are sealed and hardlinks refuse", async t => {
  const f = await fixture(t, "release"); await installControlRoomV1(f.options);
  const release = join(f.root, "releases", "1.2.3-aaaaaaaaaaaa");
  assert.equal((await stat(release)).mode & 0o777, 0o550);
  assert.equal((await stat(join(release, "package.json"))).mode & 0o777, 0o440);
  assert.equal((await stat(join(release, "dist", "server.mjs"))).mode & 0o777, 0o550);
  const h = await fixture(t, "hardlink", { buildResult: async input => { const source = join(input.root, "build", "job-hardlink", "output");
    const result = await makeSource(source, "2.0.0"); await link(join(source, "package.json"), join(source, "copy.json"));
    return { ...result, digest: "0".repeat(64) }; } });
  await assert.rejects(installControlRoomV1(h.options), /source_hardlink_refused/u);
});

test("a planted log symlink is refused without writing through it", async t => {
  const f = await fixture(t, "log-symlink"), outside = join(f.base, "outside.log");
  await writeFile(outside, "untouched\n");
  await mkdir(join(f.root, "logs", "supervisor"), { recursive: true });
  await symlink(outside, join(f.root, "logs", "supervisor", "out.log"));
  await assert.rejects(installControlRoomV1(f.options), /log_file_refused/u);
  assert.equal(await readFile(outside, "utf8"), "untouched\n");
});

test("sudoers failures roll back accounts, scheduler entries, shim and policy", async t => {
  for (const [name, options] of [["visudo", { validSudoers: false }], ["includedir", { includesSudoers: false }]]) {
    const f = await fixture(t, `sudoers-${name}`, options);
    await assert.rejects(installControlRoomV1(f.options), /sudoers_validation_refused/u);
    assert.equal(f.ports.users.length, 0); assert.equal(f.ports.groups.length, 0);
    await assert.rejects(lstat(f.systemPaths.shim), { code: "ENOENT" });
    await assert.rejects(lstat(f.systemPaths.sudoers), { code: "ENOENT" });
  }
});

test("every unconsumed passkey QR carries the owner code and passkey failure leaves installed", async t => {
  const f = await fixture(t, "registration-urls");
  await installControlRoomV1(f.options);
  const urls = f.ports.calls.find(call => call[0] === "passkey-urls")[1];
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => new URL(url).hash.includes("code=")));
  const failed = await fixture(t, "registration-failed", { passkeyFailure: true });
  const result = await installControlRoomV1(failed.options);
  assert.equal(result.state, "installed"); assert.equal(result.passkey.status, "stopped");
  assert.equal((await statusControlRoomV1({ root: failed.root })).state, "installed");
  assert.equal(failed.ports.calls.findLast(call => call[0] === "passkey-status")[1].status, "stopped");
});

test("a conflicting :443 handler, Funnel, or dropped activation refuses and restores only :443", async t => {
  const cases = [
    ["second-port", { serveAfter: { Web: { "fixture.ts.net:443": { Handlers: {
      "/": { Proxy: "http://127.0.0.1:4383" }, "/preview": { Proxy: "http://127.0.0.1:9999" },
    } } }, TCP: {}, AllowFunnel: {} } }, /tailscale_exclusivity_refused/u],
    ["funnel", { serveAfter: { Web: { "fixture.ts.net:443": { Handlers: {
      "/": { Proxy: "http://127.0.0.1:4383" },
    } } }, TCP: {}, AllowFunnel: { "fixture.ts.net:443": true } } }, /tailscale_exclusivity_refused/u],
    ["wrong-port", { serveAfter: { Web: { "fixture.ts.net:8443": { Handlers: {
      "/": { Proxy: "http://127.0.0.1:4383" },
    } } }, TCP: {}, AllowFunnel: {} } }, /tailscale_exclusivity_refused/u],
    ["wrong-proxy", { serveAfter: { Web: { "fixture.ts.net:443": { Handlers: {
      "/": { Proxy: "http://127.0.0.1:9999" },
    } } }, TCP: {}, AllowFunnel: {} } }, /tailscale_exclusivity_refused/u],
    ["changed-rp-id", { rpId: "before.fixture.ts.net" }, /tailscale_rp_id_changed/u],
    ["drop", { connectionDrop: true }, /connection_dropped/u],
  ];
  for (const [name, options, error] of cases) {
    const f = await fixture(t, `serve-${name}`, options);
    await assert.rejects(installControlRoomV1(f.options), error);
    assert.equal(f.ports.calls.filter(call => call[0] === "restore").length, 1);
    assert.equal(f.ports.calls.find(call => call[0] === "restore")[1].temporaryDirectory,
      join(f.root, "updater-state", "tmp"));
  }
});

test("fresh database is the default and a failed database init rolls back before retry", async t => {
  const f = await fixture(t, "db-retry", { failStep: "init-database" });
  await assert.rejects(installControlRoomV1(f.options), /fixture_step_failure/u);
  assert.equal(f.ports.calls.some(call => call[0] === "move-db"), false);
  assert.deepEqual(f.ports.calls.filter(call => ["recover-services", "kill-account-processes", "retire-database"]
    .includes(call[0])).map(call => call[0]), ["recover-services", "kill-account-processes", "retire-database"]);
  assert.equal((await statusControlRoomV1({ root: f.root })).state, "not-installed");
  const retryPorts = fakePorts({ version: "1.2.4", users: f.ports.users, groups: f.ports.groups });
  await installControlRoomV1({ ...f.options, ports: retryPorts });
  assert.equal(retryPorts.calls.some(call => call[0] === "move-db"), false);
  assert.equal((await statusControlRoomV1({ root: f.root })).current, "releases/1.2.4-aaaaaaaaaaaa");
});

test("self-update On refuses a repeat install before build effects", async t => {
  const f = await fixture(t, "self-update-on"); await installControlRoomV1(f.options);
  await writeFile(join(f.root, "updater-state", "self-update"), "On\n", { mode: 0o600 });
  const retry = fakePorts({ version: "1.2.4", users: f.ports.users, groups: f.ports.groups, idStart: 100 });
  await assert.rejects(installControlRoomV1({ ...f.options, bootstrap: undefined, ports: retry }), /self_update_enabled/u);
  assert.equal(retry.calls.some(call => call[0] === "build-release"), false);
});

test("installer journal is separate from updater journal and repeat install ignores updater records", async t => {
  const f = await fixture(t, "separate-journals"); await installControlRoomV1(f.options);
  const updaterJournal = join(f.root, "updater-state", "journal.jsonl");
  const updaterRecord = '{"schema":"control-room.updater-journal/v1","command":"update"}\n';
  await writeFile(updaterJournal, updaterRecord, { mode: 0o600 });
  const retry = fakePorts({ version: "1.2.4", users: f.ports.users, groups: f.ports.groups, idStart: 100 });
  // A different commit: re-running the installed one is refused up front (atk-fa F5).
  const result = await installControlRoomV1({ ...f.options, commit: "b".repeat(40), bootstrap: undefined, ports: retry });
  assert.equal(result.current, "releases/1.2.4-bbbbbbbbbbbb");
  assert.equal(await readFile(updaterJournal, "utf8"), updaterRecord);
  assert.notEqual(CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1, "journal.jsonl");
});

test("missing build data refuses, and a stop at a journal boundary is recovered on retry", async t => {
  const missing = await fixture(t, "missing", { buildResult: async () => null });
  await assert.rejects(installControlRoomV1(missing.options), /attended_build_result_refused/u);

  let stopped = false;
  const interrupted = await fixture(t, "interrupted", { afterJournalEntry: async record => {
    if (!stopped && record.action === "sudoers" && record.phase === "done") { stopped = true; throw new Error("stopped_halfway"); }
  } });
  await assert.rejects(installControlRoomV1(interrupted.options), /stopped_halfway/u);
  const retry = fakePorts({ version: "1.2.4", users: interrupted.ports.users, groups: interrupted.ports.groups });
  await installControlRoomV1({ ...interrupted.options, ports: retry });
  assert.equal((await statusControlRoomV1({ root: interrupted.root })).current, "releases/1.2.4-aaaaaaaaaaaa");

  let switchStopped = false;
  const switched = await fixture(t, "switch-journal-failure", { afterJournalEntry: async record => {
    if (!switchStopped && record.action === "switch-pointers" && record.phase === "done") {
      switchStopped = true; throw new Error("journal_write_failed");
    }
  } });
  await assert.rejects(installControlRoomV1(switched.options), /journal_write_failed/u);
  await assert.rejects(lstat(join(switched.root, "current")), { code: "ENOENT" });
  await assert.rejects(lstat(join(switched.root, "updater", "current")), { code: "ENOENT" });
});

test("partial pair staging and a wrong stage result fail closed, then retry cleanly", async t => {
  const partial = await fixture(t, "partial-pair-stage", { failUpdaterStage: true });
  await assert.rejects(installControlRoomV1(partial.options), /updater_stage_failed/u);
  await assert.rejects(lstat(join(partial.root, "releases", "1.2.3-aaaaaaaaaaaa")), { code: "ENOENT" });
  const retry = fakePorts({ users: partial.ports.users, groups: partial.ports.groups });
  await installControlRoomV1({ ...partial.options, ports: retry });
  assert.equal((await statusControlRoomV1({ root: partial.root })).current, "releases/1.2.3-aaaaaaaaaaaa");

  const wrong = await fixture(t, "wrong-stage-result", { badStageTarget: true });
  await assert.rejects(installControlRoomV1(wrong.options), /attended_stage_result_refused/u);
  assert.equal((await statusControlRoomV1({ root: wrong.root })).state, "not-installed");
});

test("tampered recovery account and path data is refused before any cleanup effect", async t => {
  let stopped = false;
  const f = await fixture(t, "tampered-recovery", { afterJournalEntry: async record => {
    if (!stopped && record.action === "create-accounts" && record.phase === "done") { stopped = true; throw new Error("stopped_halfway"); }
  } });
  await assert.rejects(installControlRoomV1(f.options), /stopped_halfway/u);
  const journal = join(f.root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1);
  const lines = (await readFile(journal, "utf8")).trim().split("\n");
  const records = lines.map(line => JSON.parse(line)), account = records.find(record => record.action === "create-accounts" && record.phase === "done");
  account.data.created = ["root"];
  await writeFile(journal, `${records.map(record => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
  const retry = fakePorts();
  await assert.rejects(installControlRoomV1({ ...f.options, ports: retry }), /install_journal_refused/u);
  assert.equal(retry.calls.some(call => call[0] === "delete-account"), false);

  let stageStopped = false;
  const staged = await fixture(t, "tampered-stage-recovery", { afterJournalEntry: async record => {
    if (!stageStopped && record.action === "stage" && record.phase === "done") { stageStopped = true; throw new Error("stopped_halfway"); }
  } });
  await assert.rejects(installControlRoomV1(staged.options), /stopped_halfway/u);
  const stagedJournal = join(staged.root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1);
  const stagedRecords = (await readFile(stagedJournal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const stage = stagedRecords.find(record => record.action === "stage" && record.phase === "done");
  stage.data.release.target = join(staged.root, "releases");
  await writeFile(stagedJournal, `${stagedRecords.map(record => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
  const stagedRetry = fakePorts();
  await assert.rejects(installControlRoomV1({ ...staged.options, ports: stagedRetry }), /install_journal_refused/u);
  assert.equal((await lstat(join(staged.root, "releases"))).isDirectory(), true);
  assert.equal(stagedRetry.calls.some(call => call[0] === "switch-pair"), false);
});

test("foreign records in the installer-owned journal are refused", async t => {
  const f = await fixture(t, "foreign-installer-journal");
  await mkdir(join(f.root, "updater-state"), { recursive: true });
  const foreign = { schema: "control-room.install-journal/v2", transactionId: "123e4567-e89b-42d3-a456-000000000001",
    command: "update", sequence: 1, phase: "done", action: "transaction", at: "2026-09-30T12:34:56.000Z", data: {} };
  await writeFile(join(f.root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1), `${JSON.stringify(foreign)}\n`, { mode: 0o600 });
  await assert.rejects(installControlRoomV1(f.options), /install_journal_refused/u);
});

test("twenty parallel installers serialize on the exclusive lock", async t => {
  const legacy = await fixture(t, "live-journal-marker", { processIdentity: () => "same-live-process" });
  await mkdir(legacy.root, { recursive: true });
  const markerPath = join(legacy.root, ".install.lock");
  const marker = `${JSON.stringify({ pid: process.pid, token: "legacy-live-holder", identity: "same-live-process" })}\n`;
  await writeFile(markerPath, marker, { mode: 0o600 });
  await assert.rejects(installControlRoomV1(legacy.options), /install_already_running/u);
  assert.equal(await readFile(markerPath, "utf8"), marker, "a live journal marker must never be overwritten");
  let releaseGate; const gate = new Promise(resolveGate => { releaseGate = resolveGate; });
  let enteredResolve; const entered = new Promise(resolveEntered => { enteredResolve = resolveEntered; });
  const f = await fixture(t, "parallel", { buildGate: async () => { enteredResolve(); await gate; } });
  const first = installControlRoomV1(f.options); await entered;
  const rest = Array.from({ length: 19 }, () => installControlRoomV1(f.options));
  const refused = await Promise.all(rest.map(promise => promise.then(() => "ok", error => error.message)));
  releaseGate(); await first;
  assert.deepEqual(new Set(refused), new Set(["install_already_running"]));
});

test("uninstall-fresh checks root ancestry and validates created account names before effects", async t => {
  const unsafe = await fixture(t, "uninstall-unsafe"); await installControlRoomV1(unsafe.options);
  const unsafePorts = fakePorts({ ownership: path => path === unsafe.root
    ? { type: "directory", symlink: false, uid: 501, gid: 20, mode: 0o755 }
    : { type: "directory", symlink: false, uid: 0, gid: 0, mode: 0o755 } });
  await assert.rejects(uninstallFreshControlRoomV1({ ...unsafe.options, ports: unsafePorts }), /install_root_ancestor_refused/u);
  assert.equal(unsafePorts.calls.some(call => call[0] === "remove-root-file"), false);

  const tampered = await fixture(t, "uninstall-tampered"); await installControlRoomV1(tampered.options);
  const path = join(tampered.root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1);
  const records = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  records.find(record => record.action === "create-accounts" && record.phase === "done").data.created = ["root"];
  await writeFile(path, `${records.map(record => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
  const tamperedPorts = fakePorts();
  await assert.rejects(uninstallFreshControlRoomV1({ ...tampered.options, ports: tamperedPorts }), /install_journal_refused/u);
  assert.equal(tamperedPorts.calls.some(call => call[0] === "delete-account"), false);
  assert.equal((await statusControlRoomV1({ root: tampered.root })).state, "installed");
});

test("uninstall-fresh shares the install lock under a forty-caller burst", async t => {
  const f = await fixture(t, "uninstall-lock"); await installControlRoomV1(f.options);
  let releaseGate; const gate = new Promise(resolveGate => { releaseGate = resolveGate; });
  let enteredResolve; const entered = new Promise(resolveEntered => { enteredResolve = resolveEntered; });
  let held = false;
  const owner = fakePorts({ users: f.ports.users, groups: f.ports.groups, idStart: 100,
    removeRootFileGate: async () => { if (!held) { held = true; enteredResolve(); await gate; } } });
  const first = uninstallFreshControlRoomV1({ ...f.options, ports: owner }); await entered;
  const callers = [
    ...Array.from({ length: 20 }, (_, index) => installControlRoomV1({ ...f.options, bootstrap: undefined,
      ports: fakePorts({ users: f.ports.users, groups: f.ports.groups, idStart: 200 + index }) })),
    ...Array.from({ length: 19 }, (_, index) => uninstallFreshControlRoomV1({ ...f.options,
      ports: fakePorts({ idStart: 300 + index }) })),
  ];
  const refused = await Promise.all(callers.map(promise => promise.then(() => "ok", error => error.message)));
  assert.deepEqual(new Set(refused), new Set(["install_already_running"]));
  releaseGate();
  const result = await first;
  assert.equal(result.state, "uninstalled");
  await assert.rejects(lstat(f.root), { code: "ENOENT" });
});

test("SIGKILL at every install journal boundary is recovered or leaves a completed install", { timeout: 240_000 }, async t => {
  const baseline = await fixture(t, "kill-baseline"); await installControlRoomV1(baseline.options);
  const records = (await readFile(join(baseline.root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1), "utf8")).trim().split("\n")
    .map(line => JSON.parse(line)).filter(record => record.command === "install");
  const boundaryCount = Math.max(...records.map(record => record.sequence));
  const base = await temporary("kill-matrix"); t.after(() => cleanup(base));
  const runner = join(base, "runner.mjs"), portModule = join(base, "ports.mjs");
  await writeFile(portModule, `
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
const { continueInstallV1 } = await import(pathToFileURL(process.env.CR_REPOSITORY+"/src/updater/v1/install/install-steps.mjs"));
const { DiskReserveV1 } = await import(pathToFileURL(process.env.CR_REPOSITORY+"/src/updater/v1/actuator.mjs"));
const calls = [];
const tailscale = () => { if (process.env.CR_FAIL_TAILSCALE !== "1") return;
  const result = spawnSync("tailscale", [], { env: process.env, encoding: "utf8" });
  throw new Error("fake_tailscale_invoked:"+result.status); };
const oldLink = path => lstat(path).then(entry => entry.isSymbolicLink()?readlink(path):Promise.reject(new Error("pointer")),error=>error?.code==="ENOENT"?null:Promise.reject(error));
const setLink = async (path,target) => { await rm(path,{force:true}); if(target!==null&&target!==undefined)await symlink(target,path); };
export default Object.freeze({
  diskReserve: root => new DiskReserveV1(root, { reserveBytes:4096, minimumHeadroomBytes:1024 }),
  geteuid: () => 0, now: () => "2026-09-30T12:34:56.000Z",
  randomId: randomUUID, randomBytes: size => Buffer.alloc(size, 9),
  inspectOwnership: async () => ({ type:"directory", symlink:false, uid:0, gid:0, mode:0o755 }), lchownPath: async () => {},
  readAccountInventory: async () => ({ users:[], groups:[] }), createAccount: async () => {}, deleteAccount: async () => {},
  ensureDenyEntry: async () => true, removeDenyEntry: async () => {},
  installRootFile: async (path,text,owner) => { await mkdir(new URL(".", "file://"+path).pathname,{recursive:true}); await writeFile(path,text,{mode:owner.mode}); return true; },
  removeRootFile: path => rm(path,{force:true}), validateSudoers: async () => true, sudoSecurePathIsActive: async () => true,
  assertT1Path: async path => path,
  assertRuntimeTreeRootMetadata: async () => ({entries:2}),
  assertSeatbeltApplied: async input => ({role:input.role,applied:true,skipped:false}),
  assertRehearsalOwnerDenied: async input => ({uid:input.identity.uid,operation:input.operation,denied:true}),
  verifyBootstrapSourceV1: async () => ({treeEntries:2,sourceDigest:"sha256:"+"d".repeat(64)}),
  adoptBootstrapV1: async input => {await mkdir(input.root+"/updater-state/mirror.git",{recursive:true});await writeFile(input.root+"/updater-state/github-read.token","fixture-token\\n",{mode:0o600});return {mirror:true,token:true,movedAside:[]};},
  removeAdoptedBootstrapV1: async root => {await rm(root+"/updater-state/mirror.git",{recursive:true,force:true});await rm(root+"/updater-state/github-read.token",{force:true});},
  seedUpdaterV1: async input => {const dir=input.root+"/updater/seed-"+input.commit.slice(0,12);await mkdir(dir,{recursive:true});return {dir,digest:"sha256:"+"e".repeat(64)};},
  loadInstallStepsV1: async input => ({module:"lib/install-steps.mjs",bundleDigest:input.expectedDigest,
    createStageOnePortsV1:value=>value,continueInstallV1}),
  vendorRuntime: async input => input.tools.includes("postgresql")?{installed:{postgresql:{version:"17.11"}},links:{"pg-current":"postgresql-17.11","pg-previous":"postgresql-17.11"}}:{installed:{},links:{}},
  rollbackRuntime: async () => {},
  fetchVerifiedSourceV1: async input => {await input.onSpawn?.({file:"/usr/bin/git"});return {job:input.root+"/build/job",source:process.env.CR_SOURCE,tree:{entries:2,bytes:50},mainCommit:input.commit};},
  buildReleaseV1: async input => {await input.onSpawn?.({file:"/usr/bin/git"});return {output:process.env.CR_SOURCE,releaseId:"9.9.9-"+input.commit.slice(0,12),manifestDigest:process.env.CR_DIGEST,fileCount:2,byteCount:50};},
  buildFixedBundleV1: async input => ({bundle:process.env.CR_SOURCE,uver:"9.9.9-"+input.commit.slice(0,12),bundleDigest:"sha256:"+"b".repeat(64)}),
  runningBundleDigestV1: async () => null,
  classifyAttendedSourceV1: async () => ({changedPaths:["src/fixture.mjs"],changesDatabase:false}),
  confirmAttendedV1: async input => ({planId:"plan-"+input.commit.slice(0,12),planDigest:"sha256:"+"c".repeat(64)}),
  stageReleaseV1: async input => {const target=input.root+"/releases/"+input.releaseId;await mkdir(target,{recursive:true});return {target};},
  stageUpdaterBundleV1: async input => {const target=input.root+"/updater/"+input.uver;await mkdir(target,{recursive:true});return {target};},
  switchPairV1: async input => {if(input.restore){await setLink(input.root+"/current",input.restore.oldCurrent);await setLink(input.root+"/previous",input.restore.oldPrevious);await setLink(input.root+"/updater/current",input.restore.oldUpdaterCurrent);await setLink(input.root+"/updater/previous",input.restore.oldUpdaterPrevious);return {restored:true};}const oldCurrent=await oldLink(input.root+"/current"),oldPrevious=await oldLink(input.root+"/previous"),oldUpdaterCurrent=await oldLink(input.root+"/updater/current"),oldUpdaterPrevious=await oldLink(input.root+"/updater/previous");await setLink(input.root+"/previous",oldCurrent??"releases/"+input.release.releaseId);await setLink(input.root+"/current","releases/"+input.release.releaseId);if(input.updateUpdater){await setLink(input.root+"/updater/previous",oldUpdaterCurrent??input.bundle.uver);await setLink(input.root+"/updater/current",input.bundle.uver);}return {oldCurrent,oldPrevious,oldUpdaterCurrent,oldUpdaterPrevious};},
  abortAttendedV1: async () => {}, generateVapidKeys: async () => ({publicKey:"public",privateKey:"private"}),
  generateWorkIntakeKeys: async () => ({key:"private"}), readGithubCredential: async () => "read-only",
  initializeDatabase: async input => { if (process.env.CR_REAL_RETIRE === "1" && input.phase === "init") {
    // What the real init leaves: a data directory and, LAST, pg/current naming it. A
    // pg/current that survives recovery is the real init's refusal on the retry.
    if (await lstat(input.root+"/pg/current").then(() => true, () => false)) throw new Error("database_init_current_link_target_refused");
    await mkdir(input.root+"/pg/"+input.pgDataId,{recursive:true}); await writeFile(input.root+"/pg/"+input.pgDataId+"/PG_VERSION","17\\n");
    await symlink(input.pgDataId,input.root+"/pg/current"); }
    return input.phase==="init"?{schema:"control-room.database-init-result/v1",outcome:"initialized",pgDataId:input.pgDataId,updaterSchemaDigest:"sha256:"+"3".repeat(64),clusterShutDownClean:true}:{schema:"control-room.release-schema-result/v1",outcome:"applied",schemaDigest:"sha256:"+"4".repeat(64),ledgerHead:"0238_fixture.sql"}; },
  // CR_REAL_RETIRE also takes the REAL login ports: M4's remove refuses a file it has
  // no receipt for, so recovery must hand it the journalled one (rv-9b B4).
  writeDatabaseLogins: async input => process.env.CR_REAL_RETIRE === "1"
    ? (await import(pathToFileURL(process.env.CR_REPOSITORY+"/src/updater/v1/pg/first-owner-ports.mjs"))).writeDatabaseLoginsV1(input)
    : ({path:input.root+"/Protected/service/db-logins.json",references:Object.keys(input.passwords).map(name=>({name,passwordDigest:"sha256:"+"5".repeat(64),fileRef:"Protected/service/db-logins.json"}))}),
  removeDatabaseLogins: async input => process.env.CR_REAL_RETIRE === "1"
    ? (await import(pathToFileURL(process.env.CR_REPOSITORY+"/src/updater/v1/pg/first-owner-ports.mjs"))).removeDatabaseLoginsV1(input)
    : undefined, firstOwner: async () => ({tenantId:"tenant",workspaceId:"workspace",provider:"local",subject:"owner"}),
  installGuard: async input => ({digest:"sha256:"+"6".repeat(64),target:input.target}), removeGuard: async () => {},
  composeProtectedConfig: async input => ["host.json","local-owner-session.json","fleet-gateway.json","supervisor.json","backup.json"].map(name=>({path:input.root+"/Protected/config/"+name,contents:"{}\\n",accountName:"_testsvc",groupName:"_testsvc",fileMode:"0600"})).concat([{path:input.root+"/updater-state/updater.json",contents:"{}\\n",accountName:"root",groupName:"wheel",fileMode:"0600"}]),
  installServices: async input => ({bundleDigest:"sha256:"+"7".repeat(64),receipt:{receiptDigest:"sha256:"+"8".repeat(64),roles:[...input.roles]}}),
  uninstallServices: async () => ({}), recoverServices: async () => ({outcome:"recovered"}), killAccountProcesses: async () => {},
  // CR_REAL_RETIRE: the REAL port, with the installer's uid (root, 0) as its fallback,
  // so a caller that omits accountUid is refused exactly as on install night (rv-9b B4).
  retireDatabase: async input => process.env.CR_REAL_RETIRE === "1"
    ? (await import(pathToFileURL(process.env.CR_REPOSITORY+"/src/updater/v1/pg/first-owner-ports.mjs"))).retireDatabaseV1(input, { uid: 0 })
    : undefined,
  restartServices: async () => ({}), checkHealth: async input => ({healthy:true,samples:3,schemaDigest:input.schemaDigest}),
  readTailscaleRpId: async () => {tailscale();return "fixture.ts.net";},
  captureTailscaleServe: async () => {tailscale();return {Web:{"fixture.ts.net:443":{Handlers:{"/":{Proxy:"http://127.0.0.1:7000"}}}},TCP:{},AllowFunnel:{}};},
  activateTailscaleServe: async () => {tailscale();}, inspectTailscaleServe: async () => {tailscale();return {Web:{"fixture.ts.net:443":{Handlers:{"/":{Proxy:"http://127.0.0.1:4383"}}}},TCP:{},AllowFunnel:{}};},
  recordTailscaleServe: async () => {tailscale();return {serveDigest:"sha256:"+"9".repeat(64)};}, readLiveServePort: async () => {tailscale();return 7000;},
  restoreTailscaleServe: async () => {tailscale();}, moveLiveDatabase: async () => ({}),
  seedKnownGood: async input => ({releaseId:input.releaseId,pgDataId:input.pgDataId,schemaDigest:input.schemaDigest}), removeKnownGood: async () => {},
  remintOwnerCode: async () => ({ownerCode:"owner-code-fixture-value-1234567890",ownerCodeDigest:"sha256:"+"a".repeat(64),receipt:{id:"owner"}}), rollbackOwnerCode: async () => {},
  startPostHealthServices: async input => ({bundleDigest:"sha256:"+"b".repeat(64),receipt:{receiptDigest:"sha256:"+"c".repeat(64),roles:[...input.roles]}}),
  registerInitialPasskey: async () => ({status:"registered",credentialIdDigest:"sha256:"+"d".repeat(64),attempts:1}), recordPasskeyStatus: async () => {}, cleanupBootstrap: async () => ({removed:true}),
  invalidateSudoTimestamp: async () => {}, processIdentity: async pid => "fixture-"+pid,
  afterJournalEntry: async record => { if (record.command === "install" && (record.sequence === Number(process.env.CR_KILL_SEQUENCE)
    || process.env.CR_KILL_ACTION === record.action+":"+record.phase)) process.kill(process.pid,"SIGKILL"); }
});
`);
  await writeFile(runner, `
import { pathToFileURL } from "node:url";
const repository = process.env.CR_REPOSITORY;
const installer = await import(pathToFileURL(repository+"/src/updater/v1/install/installer.mjs"));
const ports = (await import(pathToFileURL(process.env.CR_PORT_MODULE))).default;
const rehearsal = process.env.CR_REHEARSAL_CONFIG;
if (process.env.CR_UNINSTALL === "1") await installer.uninstallFreshControlRoomV1({root:process.env.CR_ROOT,
  rehearsalConfig:rehearsal,invokingUser:{user:"fixture-owner",uid:501,gid:20},ports});
else { const current = await installer.statusControlRoomV1({root:process.env.CR_ROOT});
if (current.state !== "installed" || process.env.CR_FORCE_INSTALL === "1") await installer.installControlRoomV1({root:process.env.CR_ROOT,commit:"a".repeat(40),webPort:4383,
  bootstrap:process.env.CR_BOOTSTRAP,
  invokingUser:{user:"fixture-owner",uid:501,gid:20},
  ...(rehearsal?{rehearsalConfig:rehearsal,freshDatabase:true,authenticator:"software",e2e2EvidenceLog:process.env.CR_EVIDENCE_LOG}:{}),
  accountsPolicy:{schema:"control-room.accounts/v1",accounts:{service:"_testsvc",database:"_testdb",builder:"_testbuild"}},
  systemPaths:JSON.parse(process.env.CR_SYSTEM_PATHS),ports}); }
`);
  for (let sequence = 1; sequence <= boundaryCount; sequence += 1) {
    const root = join(base, `root-${sequence}`), systemBase = join(base, `system-${sequence}`), systemPaths = await prepareSystemPaths(systemBase);
    const bootstrap = join(base, `bootstrap-${sequence}`); await mkdir(bootstrap);
    await writeFile(join(bootstrap, "node.tar.gz"), "node");
    await writeFile(join(bootstrap, "bootstrap.json"), `${JSON.stringify({schema:"control-room.bootstrap/v1",
      commit:"a".repeat(40),remoteUrl:"https://github.com/AgenticBotSitter/agent-control-room.git",
      git:"/usr/bin/git",node:{version:"fixture"}})}\n`, { mode: 0o600 });
    const source = join(root, "build", "prebuilt"); await mkdir(source, { recursive: true });
    const built = await makeSource(source, "9.9.9");
    const environment = { CR_REPOSITORY: repository, CR_PORT_MODULE: portModule, CR_ROOT: root, CR_BOOTSTRAP: bootstrap, CR_SOURCE: source,
      CR_DIGEST: built.digest, CR_SYSTEM_PATHS: JSON.stringify(systemPaths) };
    const killed = await runChild(runner, { ...environment, CR_KILL_SEQUENCE: String(sequence) });
    assert.equal(killed.signal, "SIGKILL", `boundary ${sequence}: ${killed.stderr}`);
    const recovered = await runChild(runner, { ...environment, CR_KILL_SEQUENCE: "0" });
    assert.equal(recovered.code, 0, `boundary ${sequence}: ${recovered.stderr}`);
    assert.equal((await statusControlRoomV1({ root })).current, "releases/9.9.9-aaaaaaaaaaaa");
  }

  const root = join(base, "rehearsal-root"), systemBase = join(base, "rehearsal-system"),
    systemPaths = await prepareSystemPaths(systemBase), bootstrap = join(base, "rehearsal-bootstrap");
  await mkdir(bootstrap); await writeFile(join(bootstrap, "node.tar.gz"), "node");
  await writeFile(join(bootstrap, "bootstrap.json"), `${JSON.stringify({schema:"control-room.bootstrap/v1",
    commit:"a".repeat(40),remoteUrl:"https://github.com/AgenticBotSitter/agent-control-room.git",
    git:"/usr/bin/git",node:{version:"fixture"}})}\n`, { mode: 0o600 });
  const source = join(root, "build", "prebuilt"); await mkdir(source, { recursive: true });
  const built = await makeSource(source, "9.9.9"), configPath = join(base, "rehearsal-config.json");
  await rehearsalConfig(configPath, root);
  const fakeBin = join(base, "fake-bin"), marker = join(base, "tailscale-invoked"); await mkdir(fakeBin);
  await writeFile(join(fakeBin, "tailscale"), `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 97\n`, { mode: 0o700 });
  await chmod(join(fakeBin, "tailscale"), 0o700);
  const environment = { CR_REPOSITORY: repository, CR_PORT_MODULE: portModule, CR_ROOT: root, CR_BOOTSTRAP: bootstrap,
    CR_SOURCE: source, CR_DIGEST: built.digest, CR_SYSTEM_PATHS: JSON.stringify(systemPaths),
    CR_REHEARSAL_CONFIG: configPath, CR_EVIDENCE_LOG: join(base, "e2e2-evidence.jsonl"), CR_FAIL_TAILSCALE: "1",
    PATH: `${fakeBin}:/usr/bin:/bin` };
  const killed = await runChild(runner, { ...environment, CR_KILL_SEQUENCE: "0", CR_KILL_ACTION: "activate-tailscale:done" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  const recovered = await runChild(runner, { ...environment, CR_KILL_SEQUENCE: "0", CR_FORCE_INSTALL: "1" });
  assert.equal(recovered.code, 0, recovered.stderr);
  const removed = await runChild(runner, { ...environment, CR_KILL_SEQUENCE: "0", CR_UNINSTALL: "1" });
  assert.equal(removed.code, 0, removed.stderr);
  await assert.rejects(lstat(marker), { code: "ENOENT" });

  // rv-9b B4: a kill anywhere after init-database (Ctrl-C, closed Terminal, power cut)
  // and the owner pastes the line again. Recovery runs as root, so the REAL retire port
  // is used with uid 0 as its fallback; the retry must succeed and the killed
  // transaction's data directory and pg/current link must be gone.
  for (const action of ["init-database:done", "install-database-service:done", "apply-release-schema:done", "write-database-logins:done",
    "first-owner:done", "install-guard:done", "health-check:done"]) {
    const label = action.replace(/[^a-z]/gu, "-"), root = join(base, `b4-${label}`);
    const systemPaths = await prepareSystemPaths(join(base, `b4-system-${label}`)), bootstrap = join(base, `b4-bootstrap-${label}`);
    await mkdir(bootstrap); await writeFile(join(bootstrap, "node.tar.gz"), "node");
    await writeFile(join(bootstrap, "bootstrap.json"), `${JSON.stringify({schema:"control-room.bootstrap/v1",
      commit:"a".repeat(40),remoteUrl:"https://github.com/AgenticBotSitter/agent-control-room.git",
      git:"/usr/bin/git",node:{version:"fixture"}})}\n`, { mode: 0o600 });
    const source = join(root, "build", "prebuilt"); await mkdir(source, { recursive: true });
    const built = await makeSource(source, "9.9.9");
    const environment = { CR_REPOSITORY: repository, CR_PORT_MODULE: portModule, CR_ROOT: root, CR_BOOTSTRAP: bootstrap,
      CR_SOURCE: source, CR_DIGEST: built.digest, CR_SYSTEM_PATHS: JSON.stringify(systemPaths), CR_REAL_RETIRE: "1" };
    const killed = await runChild(runner, { ...environment, CR_KILL_SEQUENCE: "0", CR_KILL_ACTION: action });
    assert.equal(killed.signal, "SIGKILL", `${action}: ${killed.stderr}`);
    const killedData = (await readdir(join(root, "pg"))).filter(name => name.startsWith("data-"));
    assert.equal(killedData.length, 1, `${action}: the killed init left its data directory`);
    // FORCED, as the owner's pasted line is: status alone may already read the
    // half-installed root as installed, which would skip recovery entirely.
    const recovered = await runChild(runner, { ...environment, CR_KILL_SEQUENCE: "0", CR_FORCE_INSTALL: "1" });
    assert.equal(recovered.code, 0, `${action}: ${recovered.stderr}`);
    assert.equal((await statusControlRoomV1({ root })).current, "releases/9.9.9-aaaaaaaaaaaa");
    const after = (await readdir(join(root, "pg"))).filter(name => name.startsWith("data-"));
    assert.equal(after.length, 1, `${action}: ${after}`);
    assert.notEqual(after[0], killedData[0], `${action}: the killed run's data directory must be retired`);
    assert.equal(await readlink(join(root, "pg", "current")), after[0]);
    assert.equal((await readdir(join(root, "Protected", "config", "database-passwords"))).length > 0, true,
      `${action}: the retry wrote its own logins after recovery removed the killed run's`);
  }
});

test("bad input, non-root calls, live port reuse, source flag, backup and upgrade fail closed", async t => {
  const f = await fixture(t, "bad-input", { euid: 501 });
  await assert.rejects(installControlRoomV1(f.options), /root_required/u);
  assert.throws(() => parseInstallerArgumentsV1("install", ["--source", "/tmp/bundle"], {
    invokingUser: f.options.invokingUser }), /arguments_refused/u);
  assert.throws(() => parseInstallerArgumentsV1("backup", []), /arguments_refused/u);
  assert.throws(() => parseInstallerArgumentsV1("upgrade", []), /arguments_refused/u);
  assert.throws(() => parseInstallerArgumentsV1("install", ["--rehearsal-config", "relative.json"], {
    invokingUser: f.options.invokingUser }), /arguments_refused/u);
  assert.throws(() => parseInstallerArgumentsV1("install", ["--fresh-database", "no"], {
    invokingUser: f.options.invokingUser }), /arguments_refused/u);
  assert.throws(() => parseInstallerArgumentsV1("uninstall-fresh", ["--rehearsal-config", "relative.json"], {
    invokingUser: f.options.invokingUser }), /arguments_refused/u);
  await assert.rejects(installControlRoomV1({ ...f.options, ports: fakePorts({ livePort: 7864 }), webPort: 7864 }), /service_port_refused/u);
  await assert.rejects(installControlRoomV1({ ...f.options, ports: fakePorts(), gatewayPort: f.options.webPort }),
    /service_port_refused/u);
});

test("the capability probe is JSON-only and requires no root, ports, filesystem or Tailscale", async () => {
  let output = "";
  const code = await runUpdaterCliV1(["--print-capabilities"], {
    stdout: text => { output += text; }, getuid: () => { throw new Error("root_probe_ran"); },
    installerPorts: new Proxy({}, { get() { throw new Error("installer_port_loaded"); } }),
  });
  const expected = {
    schema: "control-room.installer-capabilities/v1", version: 1,
    rehearsal: {
      config: "control-room.e2e2-rehearsal-config/v1", freshDatabase: true,
      softwareAuthenticator: "es256-fixed-v1", evidence: "control-room.e2e2-evidence/v1",
      ownerReadableEvidence: true,
      tailscale: { mutationAllowed: false, capture: "skipped (rehearsal)", activate: "skipped (rehearsal)",
        restore: "skipped (rehearsal)" },
    },
  };
  assert.equal(code, 0); assert.deepEqual(CONTROL_ROOM_INSTALLER_CAPABILITIES_V1, expected);
  assert.deepEqual(JSON.parse(output), expected); assert.equal(output, `${JSON.stringify(expected)}\n`);
});

test("rehearsal invocation checks each required option independently", () => {
  const rehearsal = { root: "/private/tmp/rehearsal-fixture", webPort: 4383, authenticator: "software" };
  const options = { ...rehearsal, freshDatabase: true, e2e2EvidenceLog: "/private/tmp/e2e2-evidence.jsonl" };
  assert.equal(assertRehearsalInvocationV1(rehearsal, options), rehearsal);
  for (const [field, value] of [["root", "/private/tmp/other"], ["webPort", 4384],
    ["freshDatabase", false], ["authenticator", "other"], ["e2e2EvidenceLog", undefined]]) {
    assert.throws(() => assertRehearsalInvocationV1(rehearsal, { ...options, [field]: value }),
      /rehearsal_invocation_refused/u, field);
  }
  assert.throws(() => assertRehearsalInvocationV1(undefined, options), /rehearsal_invocation_refused/u);
  assert.throws(() => assertRehearsalInvocationV1(rehearsal, { ...options, moveLiveDatabase: true }),
    /rehearsal_move_live_database_refused/u);
  assert.equal(assertRehearsalInvocationV1(rehearsal, options), rehearsal, "a refused invocation does not poison retry");
});

test("rehearsal identity is checked before mutation and binds recovery, services, tailnet and uninstall", async t => {
  const stopped = { value: false };
  const f = await fixture(t, "rehearsal-identity", {
    rpId: "fixture-rehearsal.ts.net",
    serveAfter: { Web: { "fixture-rehearsal.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4383" } } } },
      TCP: {}, AllowFunnel: {} },
    afterJournalEntry: async record => {
      if (!stopped.value && record.action === "activate-tailscale" && record.phase === "done") {
        stopped.value = true; throw new Error("controlled_rehearsal_stop");
      }
    },
  });
  const configPath = join(f.base, "rehearsal.json"); await rehearsalConfig(configPath, f.root);
  const evidenceLog = join(f.base, "e2e2-evidence.jsonl");
  const rehearsalOptions = { ...f.options, rehearsalConfig: configPath, freshDatabase: true,
    authenticator: "software", e2e2EvidenceLog: evidenceLog };
  await assert.rejects(installControlRoomV1({ ...f.options, rehearsalConfig: configPath }),
    /rehearsal_invocation_refused/u);
  assert.deepEqual(f.ports.calls, [], "fresh-database must be explicit before even sudo timestamp invalidation");
  await assert.rejects(installControlRoomV1({ ...rehearsalOptions, moveLiveDatabase: true }),
    /rehearsal_move_live_database_refused/u);
  assert.deepEqual(f.ports.calls, [], "move-live refusal precedes even sudo timestamp invalidation");
  await assert.rejects(installControlRoomV1(rehearsalOptions), /controlled_rehearsal_stop/u);

  const otherEvidenceDirectory = join(f.base, "other-evidence"); await mkdir(otherEvidenceDirectory, { mode: 0o700 });
  await assert.rejects(installControlRoomV1({ ...rehearsalOptions,
    e2e2EvidenceLog: join(otherEvidenceDirectory, "e2e2-evidence.jsonl") }), /rehearsal_identity_mismatch/u);

  const wrongIdentityPorts = fakePorts({ users: f.ports.users, groups: f.ports.groups });
  await assert.rejects(installControlRoomV1({ ...f.options, ports: wrongIdentityPorts }), /rehearsal_identity_mismatch/u);
  assert.equal(wrongIdentityPorts.calls.some(call => call[0] === "recover-services"), false,
    "recovery cannot fall back to default labels");

  const retry = fakePorts({ users: f.ports.users, groups: f.ports.groups, rpId: "fixture-rehearsal.ts.net",
    serveAfter: { Web: { "fixture-rehearsal.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4383" } } } },
      TCP: {}, AllowFunnel: {} } });
  await installControlRoomV1({ ...rehearsalOptions, ports: retry });
  const expectedLabels = (await rehearsalConfig(join(f.base, "identity-copy.json"), f.root)).launchdLabels;
  const expectedPolicy = Object.entries(expectedLabels).map(([role, label]) => ({ role, label,
    plistPath: `/Library/LaunchDaemons/${label}.plist` }));
  const serviceCalls = retry.calls.filter(call => call[0] === "install-services");
  assert.equal(serviceCalls.length, 2, "recovery resumes with the database and application service batches");
  for (const call of serviceCalls) assert.deepEqual(call[1].servicePolicy, expectedPolicy);
  assert(retry.calls.filter(call => call[0] === "recover-services")
    .every(call => call[1].servicePolicy?.length === 6));
  assert.equal(retry.calls.find(call => call[0] === "compose-protected-config")[1].gatewayPort, 4384);
  assert.equal(retry.calls.some(call => ["read-live-serve-port", "read-tailscale-rp-id", "capture", "activate", "restore", "record-serve"]
    .includes(call[0])), false, "rehearsal never enters a Tailscale port");
  assert.equal(retry.calls.find(call => call[0] === "compose-protected-config")[1].rpId, "fixture-rehearsal.ts.net");
  assert.equal(retry.calls.find(call => call[0] === "register-passkey")[1].authenticator, "software");
  const ownerEvidence = (await readFile(evidenceLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(ownerEvidence.filter(row => row.kind === "passkey").map(row => row.status), ["registered"]);
  assert.deepEqual(ownerEvidence.filter(row => row.kind === "runtime-root-metadata").map(row => row.tree),
    ["node", "pnpm", "esbuild", "postgresql"]);
  assert.deepEqual(ownerEvidence.filter(row => row.kind === "seatbelt").map(row => row.role), ["postgres", "supervisor"]);
  assert.deepEqual(ownerEvidence.filter(row => row.kind === "tailscale-step").map(row => [row.step, row.outcome]), [
    ["capture", "skipped (rehearsal)"], ["activate", "skipped (rehearsal)"], ["restore", "skipped (rehearsal)"],
  ]);
  assert.deepEqual(ownerEvidence.filter(row => row.kind === "spawn-t1").map(row => row.spawnId), ["spawn-1", "spawn-2"]);
  assert.deepEqual(ownerEvidence.find(row => row.kind === "spawn-count")?.expected, 2);
  assert(retry.calls.filter(call => call[0] === "t1" && call[2]?.executable === true).length >= 2,
    "every rehearsed spawn requires an executable T1 path");
  assert.deepEqual(ownerEvidence.find(row => row.kind === "owner-uid")?.uid, 501);
  assert.deepEqual(ownerEvidence.filter(row => row.kind === "p0-denial").map(row => row.operation), ["read", "write", "signal"]);
  assert.deepEqual(ownerEvidence.find(row => row.kind === "health")?.samples, 3);
  const ownerJournal = (await readFile(join(f.base, CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert(ownerJournal.every(row => row.transactionId === ownerEvidence[0].transactionId
    && row.root === f.root && row.commit === "a".repeat(40)));

  const withoutIdentity = fakePorts({ users: retry.users, groups: retry.groups });
  await assert.rejects(uninstallFreshControlRoomV1({ ...f.options, ports: withoutIdentity }), /rehearsal_identity_mismatch/u);
  assert.equal(withoutIdentity.calls.some(call => call[0] === "recover-services"), false);
  const uninstall = fakePorts({ users: retry.users, groups: retry.groups });
  const removed = await uninstallFreshControlRoomV1({ ...f.options, rehearsalConfig: configPath, ports: uninstall });
  assert.match(removed.retained, /\.uninstalled-/u);
  assert(uninstall.calls.filter(call => call[0] === "recover-services")
    .every(call => call[1].servicePolicy?.length === 6));
  assert.equal(uninstall.calls.some(call => call[0] === "restore"), false,
    "rehearsal uninstall never restores Tailscale");
});

test("rehearsal exports a stopped passkey result even when installation completed", async t => {
  const f = await fixture(t, "rehearsal-stopped-passkey", { rpId: "fixture-rehearsal.ts.net", passkeyFailure: true });
  const configPath = join(f.base, "rehearsal.json"), evidenceLog = join(f.base, "e2e2-evidence.jsonl");
  await rehearsalConfig(configPath, f.root);
  const result = await installControlRoomV1({ ...f.options, rehearsalConfig: configPath, freshDatabase: true,
    authenticator: "software", e2e2EvidenceLog: evidenceLog });
  assert.equal(result.state, "installed");
  assert.equal(result.passkey.status, "stopped");
  const rows = (await readFile(evidenceLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.filter(row => row.kind === "passkey").map(row => row.status), ["stopped"]);
});

test("rehearsal metadata, T1, Seatbelt, and owner-denial probes fail closed at their check points", async t => {
  for (const [name, portOptions, error] of [
    ["metadata", { failMetadata: "node" }, /metadata_refused/u],
    ["t1", { failT1Executable: true }, /t1_refused/u],
    ["seatbelt", { failSeatbelt: "postgres" }, /seatbelt_refused/u],
    ["owner-denial", { failOwnerDenial: "signal" }, /owner_denial_refused/u],
  ]) {
    const f = await fixture(t, `rehearsal-probe-${name}`, portOptions);
    const configPath = join(f.base, "rehearsal.json"); await rehearsalConfig(configPath, f.root);
    await assert.rejects(installControlRoomV1({ ...f.options, rehearsalConfig: configPath, freshDatabase: true,
      authenticator: "software", e2e2EvidenceLog: join(f.base, "e2e2-evidence.jsonl") }), error);
    assert.equal((await statusControlRoomV1({ root: f.root })).state, "not-installed", name);
    if (name === "t1") assert.equal(f.ports.calls.some(call => call[0] === "build-release"), false);
  }
});

test("a rehearsal config colliding with a live default is refused before every mutation", async t => {
  const f = await fixture(t, "rehearsal-collision");
  const configPath = join(f.base, "collision.json"), valid = await rehearsalConfig(configPath, f.root);
  const colliding = [
    { ...valid, root: DEFAULT_CONTROL_ROOM_ROOT_V1 },
    { ...valid, accounts: { ...valid.accounts, service: "_controlroom" } },
    { ...valid, launchdLabels: { ...valid.launchdLabels, supervisor: "xyz.different.production.supervisor" } },
    { ...valid, ports: { web: DEFAULT_CONTROL_ROOM_WEB_PORT_V1, gateway: 4384 } },
    { ...valid, tailscale: { ...valid.tailscale, mutationAllowed: true } },
    { ...valid, tailscale: { ...valid.tailscale, expectedStepOutcome: "skipped" } },
  ];
  for (const value of colliding) {
    await writeFile(configPath, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await chmod(configPath, 0o600);
    await assert.rejects(installControlRoomV1({ ...f.options, rehearsalConfig: configPath, freshDatabase: true }),
      /rehearsal_config_refused/u);
    assert.deepEqual(f.ports.calls, []);
  }

  const liveRoot = join(f.base, "live"), liveConfig = join(liveRoot, "Protected/config/supervisor.json");
  await mkdir(dirname(liveConfig), { recursive: true });
  await writeFile(liveConfig, JSON.stringify({ installRoot: valid.root, serviceAccount: valid.accounts.service }));
  await assert.rejects(assertNoLiveRehearsalCollisionsV1(valid, liveRoot), /rehearsal_config_refused/u);
});

test("authenticator and E2E-2 evidence flags are rehearsal-only and exact", async t => {
  const f = await fixture(t, "rehearsal-only-flags");
  assert.throws(() => parseInstallerArgumentsV1("install", ["--authenticator", "face-id"], {
    invokingUser: f.options.invokingUser }), /arguments_refused/u);
  assert.throws(() => parseInstallerArgumentsV1("install", ["--e2e2-evidence-log", "relative.jsonl"], {
    invokingUser: f.options.invokingUser }), /arguments_refused/u);
  for (const path of ["/private/tmp/evidence\n.jsonl", "/private/tmp/evidence\u200b.jsonl"]) {
    assert.throws(() => parseInstallerArgumentsV1("install", ["--e2e2-evidence-log", path], {
      invokingUser: f.options.invokingUser }), /arguments_refused/u);
  }
  assert.equal(parseInstallerArgumentsV1("install", ["--e2e2-evidence-log", "/private/tmp/e2e2-evidence.jsonl"], {
    invokingUser: f.options.invokingUser }).e2e2EvidenceLog, "/private/tmp/e2e2-evidence.jsonl");
  await assert.rejects(installControlRoomV1({ ...f.options, authenticator: "software" }),
    /rehearsal_only_argument_refused/u);
  await assert.rejects(installControlRoomV1({ ...f.options, e2e2EvidenceLog: join(f.base, "e2e2-evidence.jsonl") }),
    /rehearsal_only_argument_refused/u);
  const configPath = join(f.base, "rehearsal.json"); await rehearsalConfig(configPath, f.root);
  await assert.rejects(installControlRoomV1({ ...f.options, rehearsalConfig: configPath, freshDatabase: true,
    authenticator: "software", e2e2EvidenceLog: join(f.base, "wrong-name.jsonl") }),
  /rehearsal_evidence_path_refused/u);
  const insecure = join(f.base, "insecure-evidence"); await mkdir(insecure, { mode: 0o755 });
  await assert.rejects(installControlRoomV1({ ...f.options, rehearsalConfig: configPath, freshDatabase: true,
    authenticator: "software", e2e2EvidenceLog: join(insecure, "e2e2-evidence.jsonl") }),
  /rehearsal_evidence_path_refused/u);
  assert.deepEqual(f.ports.calls, [], "real installs refuse both rehearsal-only flags before mutation");
});

test("a bundle install on a non-installed root requires the install-night line", async t => {
  const f = await fixture(t, "line-required");
  await assert.rejects(installControlRoomV1({ ...f.options, bootstrap: undefined }), error => {
    assert.equal(error.code, "install_night_required");
    assert.equal(error.message, "run the install-night line again"); return true;
  });
  await assert.rejects(lstat(f.root), { code: "ENOENT" });
});

test("an installed Mac refuses a bootstrap replay and points to passkey add", async t => {
  const f = await fixture(t, "installed-bootstrap-refusal"); await installControlRoomV1(f.options);
  await assert.rejects(installControlRoomV1({ ...f.options, commit: "b".repeat(40) }), error =>
    error?.code === "installed_bootstrap_refused" && /passkey add/u.test(error.userMessage));
});

test("a retry succeeds after failure at every C4 stage-zero boundary", async t => {
  for (const boundary of ["verify", "adopt", "runtime", "seed", "load"]) {
    const f = await fixture(t, `c4-retry-${boundary}`, { failC4: boundary });
    await assert.rejects(installControlRoomV1(f.options));
    const retry = fakePorts({ users: f.ports.users, groups: f.ports.groups, version: "1.2.4" });
    const result = await installControlRoomV1({ ...f.options, ports: retry });
    assert.equal(result.current, "releases/1.2.4-aaaaaaaaaaaa", boundary);
  }
});

test("shim strips caller-controlled variables and printed sudo guidance is absolute", async t => {
  assert.match(CONTROL_ROOM_SHIM_V1, /^#!\/bin\/sh -p/mu);
  assert.match(CONTROL_ROOM_SHIM_V1, /cd \/ \|\| exit 1/u);
  assert.match(CONTROL_ROOM_SHIM_V1, /\/usr\/bin\/env -i PATH=\/usr\/bin:\/bin HOME=\/var\/root/u);
  assert.match(CONTROL_ROOM_SHIM_V1, /--invoking-user "\$INVOKING_USER" --invoking-uid "\$INVOKING_UID"/u);
  assert.doesNotMatch(CONTROL_ROOM_SHIM_V1, /NODE_OPTIONS|BASH_ENV|\$HOME/u);
  const base = await temporary("shim-environment"); t.after(() => cleanup(base));
  const root = join(base, "install"), node = join(root, "runtime", "node-current", "bin", "node"), shim = join(base, "control-room");
  await mkdir(dirname(node), { recursive: true });
  await writeFile(node, "#!/bin/sh\n/usr/bin/env\n", { mode: 0o700 });
  await writeFile(shim, CONTROL_ROOM_SHIM_V1.replace(DEFAULT_CONTROL_ROOM_ROOT_V1, root), { mode: 0o700 });
  const result = await runProgram("/bin/sh", ["-p", shim, "status"], {
    PATH: "/no-caller-binaries", HOME: "/hostile-home", NODE_OPTIONS: "hostile-value", BASH_ENV: "/hostile-env",
    ENV: "/hostile-env", DYLD_INSERT_LIBRARIES: "/hostile-library", CONTROL_ROOM_CALLER_MARKER: "hostile-marker",
    SUDO_USER: undefined, SUDO_UID: undefined, SUDO_GID: undefined,
  });
  assert.equal(result.code, 0, result.stderr);
  const environment = Object.fromEntries(result.stdout.trim().split("\n").map(line => {
    const separator = line.indexOf("="); return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  assert.equal(environment.PATH, "/usr/bin:/bin");
  assert.equal(environment.HOME, "/var/root");
  for (const name of ["NODE_OPTIONS", "BASH_ENV", "ENV", "DYLD_INSERT_LIBRARIES", "CONTROL_ROOM_CALLER_MARKER"])
    assert.equal(Object.hasOwn(environment, name), false, `${name} must not reach the executable`);
  const matches = spawnSync("/usr/bin/git", ["grep", "-l", "--fixed-strings", "--untracked", "--exclude-standard",
    "\"$R/runtime/node-current/bin/node\"", "--", ".", ":(exclude)node_modules/**", ":(exclude)dist-vps/**",
    ":(exclude)tests/**", ":(exclude)mutation-checks/**"], {
    cwd: repository, encoding: "utf8", env: { ...process.env, PATH: "/no-caller-binaries" },
  });
  assert.equal(matches.status, 0, matches.stderr);
  assert.deepEqual(matches.stdout.trim().split("\n"), ["src/updater/v1/bin/control-room"]);
  const packageManifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  assert.equal(packageManifest.bin["control-room"], "src/updater/v1/cli.mjs");
  await assert.rejects(lstat(join(repository, "scripts/install/control-room.mjs")), { code: "ENOENT" });
  await assert.rejects(lstat(join(repository, "bin/control-room")), { code: "ENOENT" });
  const text = await readFile(join(repository, "src/updater/v1/cli.mjs"), "utf8");
  for (const match of text.matchAll(/Run this with ([^\n"]+)/gu)) assert.match(match[1], /^sudo \/usr\/local\/bin\/control-room/u);
});

test("the shim carries only a validated invoking identity across env -i", async t => {
  const base = await temporary("shim-identity"); t.after(() => cleanup(base));
  const root = join(base, "install"), node = join(root, "runtime", "node-current", "bin", "node"), shim = join(base, "control-room");
  await mkdir(dirname(node), { recursive: true });
  await writeFile(node, "#!/bin/sh\n/usr/bin/env\nprintf 'ARG<%s>\\n' \"$@\"\n", { mode: 0o755 });
  await chmod(node, 0o755);
  await writeFile(shim, CONTROL_ROOM_SHIM_V1.replace(DEFAULT_CONTROL_ROOM_ROOT_V1, root), { mode: 0o755 });
  await chmod(shim, 0o755);
  const withoutSudo = { SUDO_USER: undefined, SUDO_UID: undefined, SUDO_GID: undefined };
  const status = await runProgram("/bin/sh", [shim, "status"], withoutSudo);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /ARG<status>/u);
  assert.doesNotMatch(status.stdout, /ARG<--invoking-/u);
  const install = await runProgram("/bin/sh", [shim, "install"], withoutSudo);
  assert.equal(install.code, 64);
  assert.equal(install.stdout, "");
  const result = await runProgram("/bin/sh", [shim, "status"], {
    SUDO_USER: "fixture-owner", SUDO_UID: "501", SUDO_GID: "20", NODE_OPTIONS: "hostile-value", HOME: "/hostile-home",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /hostile-value|hostile-home|SUDO_USER/u);
  assert.match(result.stdout, /ARG<--invoking-user>\nARG<fixture-owner>\nARG<--invoking-uid>\nARG<501>\nARG<--invoking-gid>\nARG<20>/u);
  for (const identity of [
    { SUDO_USER: "", SUDO_UID: "", SUDO_GID: "" },
    { SUDO_USER: "bad user", SUDO_UID: "501", SUDO_GID: "20" },
    { SUDO_USER: "fixture-owner", SUDO_UID: "", SUDO_GID: "20" },
    { SUDO_USER: "fixture-owner", SUDO_UID: "5x1", SUDO_GID: "20" },
    { SUDO_USER: "fixture-owner", SUDO_UID: "501", SUDO_GID: "" },
    { SUDO_USER: "fixture-owner", SUDO_UID: "501", SUDO_GID: "2x" },
  ]) {
    const bad = await runProgram("/bin/sh", [shim, "status"], identity);
    assert.equal(bad.code, 64);
    assert.equal(bad.stdout, "");
  }
  const boundary = await runProgram("/bin/sh", [shim, "status"], {
    SUDO_USER: "a".repeat(64), SUDO_UID: "501", SUDO_GID: "20",
  });
  assert.equal(boundary.code, 0, boundary.stderr);
  assert.match(boundary.stdout, new RegExp(`ARG<${"a".repeat(64)}>`));
  const tooLong = await runProgram("/bin/sh", [shim, "status"], {
    SUDO_USER: "a".repeat(65), SUDO_UID: "501", SUDO_GID: "20",
  });
  assert.equal(tooLong.code, 64);
  assert.equal(tooLong.stdout, "");
});

test("invoking identity is complete and sudo -K runs as that uid with no incompatible options", async () => {
  const invocation = parseInvokingArgumentsV1(["install", "--commit", "a".repeat(40), "--web-port", "4383",
    "--invoking-user", "fixture-owner", "--invoking-uid", "501", "--invoking-gid", "20"]);
  const parsed = parseInstallerArgumentsV1(invocation.args[0], invocation.args.slice(1), invocation);
  assert.deepEqual(parsed.invokingUser, { user: "fixture-owner", uid: 501, gid: 20 });
  assert.equal(parseInstallerArgumentsV1("install", ["--commit", "a".repeat(40)], invocation).webPort,
    DEFAULT_CONTROL_ROOM_WEB_PORT_V1);
  for (const bad of [
    ["--invoking-user", "fixture-owner"],
    ["--invoking-user", "bad user", "--invoking-uid", "501", "--invoking-gid", "20"],
    ["--invoking-user", "root", "--invoking-uid", "0", "--invoking-gid", "0"],
  ]) assert.throws(() => parseInvokingArgumentsV1(
    ["install", "--commit", "a".repeat(40), "--web-port", "4383", ...bad]),
    /invoking_user_refused|arguments_refused/u);

  const calls = [];
  const fakeSudo = async (file, args, options) => {
    if (file !== "/usr/bin/sudo" || args.length !== 1 || args[0] !== "-K") throw new Error("sudo_usage_error");
    calls.push({ file, args, options });
  };
  await invalidateSudoTimestampV1(parsed.invokingUser, fakeSudo);
  assert.deepEqual(calls, [{ file: "/usr/bin/sudo", args: ["-K"], options: { uid: 501, gid: 20 } }]);
  await assert.rejects(invalidateSudoTimestampV1({ user: "root", uid: 0, gid: 0 }, fakeSudo), /invoking_user_refused/u);
});

test("central invoking suffix parsing rejects malformed identity and installer options for every verb", () => {
  const suffix = ["--invoking-user", "fixture-owner", "--invoking-uid", "501", "--invoking-gid", "20"];
  assert.deepEqual(parseInvokingArgumentsV1(["confirm", "one", "two", "three", "four", "five", "six", ...suffix]), {
    args: ["confirm", "one", "two", "three", "four", "five", "six"],
    invokingUser: { user: "fixture-owner", uid: 501, gid: 20 },
  });
  for (const bad of [
    ["status", "--invoking-user"],
    ["status", ...suffix, "--invoking-user", "again"],
    ["status", "--invoking-user", "fixture-owner", "--invoking-uid", "0", "--invoking-gid", "20"],
    ["status", "--invoking-user", "bad user", "--invoking-uid", "501", "--invoking-gid", "20"],
  ]) assert.throws(() => parseInvokingArgumentsV1(bad), /invoking_user_refused/u);
  assert.throws(() => parseInvokingArgumentsV1(["status", "bad\0value"]), /arguments_refused/u);
  const invokingUser = { user: "fixture-owner", uid: 501, gid: 20 };
  for (const args of [["--commit", "short"], ["--web-port", "nope"],
    ["--i-am-replacing-live", "no"], ["--commit", "a".repeat(40), "--commit", "b".repeat(40)]]) {
    assert.throws(() => parseInstallerArgumentsV1("install", args, { invokingUser }), /arguments_refused/u);
  }
  assert.throws(() => parseInstallerArgumentsV1("install", ["--commit", "a".repeat(40)]), /invoking_user_refused/u);
  assert.throws(() => parseInstallerArgumentsV1("uninstall-fresh", []), /invoking_user_refused/u);
});

test("sudoers validation asks sudo for the exact active secure_path", async () => {
  const calls = [];
  const exact = async (file, args) => { calls.push([file, args]); return {
    stdout: "Value to override user's $PATH with: /usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\n",
  }; };
  assert.equal(await sudoSecurePathIsActiveV1(exact), true);
  assert.deepEqual(calls, [["/usr/bin/sudo", ["-V"]]]);
  assert.equal(await sudoSecurePathIsActiveV1(async () => ({
    stdout: "Value to override user's $PATH with: /usr/bin:/bin:/usr/sbin:/sbin\n",
  })), false);
  assert.equal(await sudoSecurePathIsActiveV1(async () => { throw new Error("sudo failed"); }), false);
});

test("account names live only in the one policy file", async () => {
  const installer = await readFile(join(repository, "src/updater/v1/install/installer.mjs"), "utf8");
  for (const literal of ["_controlroom", "_crdb", "_crbuild"]) assert.equal(installer.includes(literal), false);
  const policy = JSON.parse(await readFile(join(repository, "src", "updater", "v1", "policy", "accounts.json"), "utf8"));
  assert.deepEqual(Object.keys(policy.accounts).sort(), ["builder", "database", "service"]);
});

test("fresh recovery follows bootstrap re-verification", async () => {
  const installer = await readFile(join(repository, "src/updater/v1/install/installer.mjs"), "utf8");
  const start = installer.indexOf("export async function installControlRoomV1"),
    verification = installer.indexOf("await ports.verifyBootstrapSourceV1", start),
    recovery = installer.indexOf("await recoverInterruptedInstall", start);
  assert(start >= 0 && verification > start && recovery > verification,
    "fresh bootstrap source must be re-verified before recovery effects");
});

test("no owner sign-in, clipboard, release CLI fallback, or obsolete scratch directories remain", async () => {
  const files = [join(repository, "src/updater/v1/install/installer.mjs"),
    join(repository, "src/updater/v1/cli.mjs"),
    join(repository, "src", "updater", "v1", "cli", "control-room-native-ports.mjs")];
  const text = (await Promise.all(files.map(path => readFile(path, "utf8")))).join("\n");
  assert.doesNotMatch(text, /owner-sign-in\.txt|pbcopy|current\/scripts\/control-room\.mjs|backups\/staging|updater-state\/scratch/u);
});

test("the real account inventory parser accepts a real Mac's dscl listing, including nobody -2 and nogroup -1", async () => {
  const { parseDirectoryRowsV1 } = await import("../src/updater/v1/cli/control-room-native-ports.mjs");
  const users = parseDirectoryRowsV1("_aonsensed               300\nnobody                   -2\nroot                     0\n_mds_stores              308\n", "uid");
  assert.deepEqual(users.map(row => [row.name, row.uid]), [["_aonsensed", 300], ["nobody", -2], ["root", 0], ["_mds_stores", 308]]);
  const groups = parseDirectoryRowsV1("nobody                           -2\nnogroup                          -1\ncom.apple.access_ssh             399\n", "gid");
  assert.deepEqual(groups.map(row => row.gid), [-2, -1, 399]);
  assert.throws(() => parseDirectoryRowsV1("two words 12\n", "uid"), /account_inventory_refused/u);
  assert.throws(() => parseDirectoryRowsV1("big 12345678901\n", "uid"), /account_inventory_refused/u);
});

test("an installed commit runs only build, fixed bundle, stage, flip, restart and health", async t => {
  const f = await fixture(t, "installed-commit"); await installControlRoomV1(f.options);
  assert.match(f.ports.calls.find(call => call[0] === "confirm")[1].inventoryDigest, /^sha256:[a-f0-9]{64}$/u);
  const next = fakePorts({ version: "1.2.4", users: f.ports.users, groups: f.ports.groups });
  await installControlRoomV1({ ...f.options, bootstrap: undefined, ports: next, commit: "b".repeat(40) });
  assert.match(next.calls.find(call => call[0] === "confirm")[1].inventoryDigest, /^sha256:[a-f0-9]{64}$/u);
  for (const forbidden of ["create-account", "vendor-runtime", "bootstrap-owner", "install-services", "capture", "activate", "move-db"])
    assert.equal(next.calls.some(call => call[0] === forbidden), false, forbidden);
  assert.deepEqual(next.calls.filter(call => ["fetch-source", "build-release", "build-updater-bundle", "confirm",
    "stage-release", "stage-updater", "switch-pair", "restart-services", "health"].includes(call[0])).map(call => call[0]),
  ["fetch-source", "build-release", "build-updater-bundle", "confirm", "stage-release", "stage-updater",
    "switch-pair", "restart-services", "health"]);
  assert.equal((await statusControlRoomV1({ root: f.root })).current, "releases/1.2.4-bbbbbbbbbbbb");
  const freshAgain = fakePorts({ users: f.ports.users, groups: f.ports.groups });
  await assert.rejects(installControlRoomV1({ ...f.options, commit: undefined, ports: freshAgain }), /installed_transaction_exists/u);
  assert.equal(freshAgain.calls.some(call => call[0] === "build-release"), false);
});

test("an unchanged fixed bundle advances only the release pair", async t => {
  const f = await fixture(t, "unchanged-updater"); await installControlRoomV1(f.options);
  const updaterBefore = await readlink(join(f.root, "updater/current"));
  const next = fakePorts({ version: "1.2.4", runningBundleDigest: `sha256:${"b".repeat(64)}`,
    users: f.ports.users, groups: f.ports.groups });
  await installControlRoomV1({ ...f.options, bootstrap: undefined, ports: next, commit: "b".repeat(40) });
  assert.equal(next.calls.some(call => call[0] === "stage-updater"), false);
  assert.equal(await readlink(join(f.root, "updater/current")), updaterBefore);
  assert.equal((await statusControlRoomV1({ root: f.root })).current, "releases/1.2.4-bbbbbbbbbbbb");
});

test("a repeat whose verified diff touches db is refused before confirmation or staging", async t => {
  const f = await fixture(t, "repeat-db-refusal"); await installControlRoomV1(f.options);
  const next = fakePorts({ changesDatabase: true, users: f.ports.users, groups: f.ports.groups });
  await assert.rejects(installControlRoomV1({ ...f.options, bootstrap: undefined, commit: "b".repeat(40), ports: next }),
    /attended_database_change_requires_upgrader/u);
  assert.equal(next.calls.some(call => call[0] === "confirm"), false);
  assert.equal(next.calls.some(call => call[0] === "stage-release"), false);
});

test("the single CLI sends install --commit through the installer repeat journal and never the retired attended entry", async t => {
  const f = await fixture(t, "single-cli-repeat");
  await installControlRoomV1(f.options);
  const next = fakePorts({ version: "1.2.4", users: f.ports.users, groups: f.ports.groups });
  let retiredCalls = 0;
  const output = [];
  await runUpdaterCliV1(["install", "--commit", "b".repeat(40),
    "--invoking-user", "fixture-owner", "--invoking-uid", "501", "--invoking-gid", "20"], {
    root: f.root, getuid: () => 0, installerPorts: next, install: async () => { retiredCalls += 1; },
    installerOptions: { accountsPolicy: accountPolicy, systemPaths: f.systemPaths }, stdout: text => output.push(text),
  });
  const rows = (await readFile(join(f.root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  const repeat = rows.filter(row => row.data?.commit === "b".repeat(40) || row.transactionId === rows.at(-1).transactionId);
  assert.ok(repeat.some(row => row.action === "transaction" && row.phase === "planned"
    && row.data.commit === "b".repeat(40)), "repeat install has installer-owned transaction rows");
  assert.ok(repeat.some(row => row.action === "build-release" && row.phase === "done"));
  assert.equal(retiredCalls, 0, "the CLI has no installAttendedCommitV1 dispatch seam");
  assert.equal(typeof next.calls.find(call => call[0] === "confirm")[1].terminal?.readLine, "function");
  assert.match(output.join(""), /release 1\.2\.4-b{12} is current/u);
});

test("a failed installed health check restores and restarts the old release, then retry succeeds", async t => {
  const f = await fixture(t, "installed-health-retry"); await installControlRoomV1(f.options);
  const failed = fakePorts({ version: "1.2.4", users: f.ports.users, groups: f.ports.groups, failHealth: true });
  await assert.rejects(installControlRoomV1({ ...f.options, bootstrap: undefined, ports: failed, commit: "b".repeat(40) }), /health_failed/u);
  assert.equal((await statusControlRoomV1({ root: f.root })).current, "releases/1.2.3-aaaaaaaaaaaa");
  assert.equal(failed.calls.filter(call => call[0] === "restart-services").length, 2);
  const retry = fakePorts({ version: "1.2.5", users: f.ports.users, groups: f.ports.groups });
  await installControlRoomV1({ ...f.options, bootstrap: undefined, ports: retry, commit: "c".repeat(40) });
  assert.equal((await statusControlRoomV1({ root: f.root })).current, "releases/1.2.5-cccccccccccc");
});

test("three repeat installs keep the fresh account transaction and never recreate accounts", async t => {
  const f = await fixture(t, "three-repeats"); await installControlRoomV1(f.options);
  const installed = [];
  for (const [index, version] of ["1.2.4", "1.2.4", "1.2.5"].entries()) {
    const ports = fakePorts({ version, users: f.ports.users, groups: f.ports.groups });
    await installControlRoomV1({ ...f.options, bootstrap: undefined, commit: String(index + 2).repeat(40), ports });
    assert.equal(ports.calls.some(call => call[0] === "create-account"), false);
    const current = `releases/${version}-${String(index + 2).repeat(12)}`;
    assert.equal((await statusControlRoomV1({ root: f.root })).current, current); installed.push(current);
  }
  assert.equal(new Set(installed).size, 3, "same-version commits receive distinct release ids");
});

test("a repeat restart that throws part-way restores pointers and restarts the old release", async t => {
  const f = await fixture(t, "restart-part-way"); await installControlRoomV1(f.options);
  const ports = fakePorts({ version: "1.2.4", users: f.ports.users, groups: f.ports.groups, failRestart: true });
  await assert.rejects(installControlRoomV1({ ...f.options, bootstrap: undefined, commit: "b".repeat(40), ports }), /restart_failed_part_way/u);
  assert.equal((await statusControlRoomV1({ root: f.root })).current, "releases/1.2.3-aaaaaaaaaaaa");
  const restarts = ports.calls.filter(call => call[0] === "restart-services");
  assert.equal(restarts.length, 2);
});

test("Off exists before services and service rollback precedes account deletion", async t => {
  let f;
  f = await fixture(t, "service-rollback", { failServices: true });
  await assert.rejects(installControlRoomV1(f.options), /services_failed/u);
  assert.equal(await readFile(join(f.root, "updater-state", "self-update"), "utf8"), "Off\n");
  const uninstall = f.ports.calls.findIndex(call => ["uninstall-services", "recover-services"].includes(call[0]));
  const deletion = f.ports.calls.findIndex(call => call[0] === "delete-account");
  assert(uninstall >= 0 && deletion > uninstall);
  assert.deepEqual(f.ports.calls[uninstall][1].roles, ["postgresql17"]);
  assert.equal(f.ports.calls.filter(call => call[0] === "sudo-K").length, 2);
});

test("database recovery is bootout then uid sweep then data retirement", async t => {
  let stopped = false;
  const f = await fixture(t, "database-recovery-order", { afterJournalEntry: async record => {
    if (!stopped && record.action === "install-database-service" && record.phase === "done") {
      stopped = true; throw new Error("stop_after_database_service");
    }
  } });
  await assert.rejects(installControlRoomV1(f.options), /stop_after_database_service/u);
  const effects = f.ports.calls.map(call => call[0]);
  const bootout = effects.lastIndexOf("recover-services"), sweep = effects.lastIndexOf("kill-account-processes"),
    retire = effects.lastIndexOf("retire-database");
  assert.ok(bootout >= 0 && bootout < sweep && sweep < retire, effects.join(","));
});

test("the install step refuses an unproved service-batch result before continuing", async t => {
  const f = await fixture(t, "service-result-guard", { serviceResult: { outcome: "completed" } });
  await assert.rejects(installControlRoomV1(f.options), /services_batch_uncertain/u);
  const effects = f.ports.calls.map(call => call[0]);
  assert.equal(effects.includes("capture"), false);
  assert(effects.indexOf("delete-account") >= 0);
  assert.equal(effects.includes("capture"), false);
});

test("Serve exclusivity is scoped to :443 and accepts the real two-entry shape", () => {
  const serve = { TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } }, Web: {
    "fixture.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4383" } } },
    "fixture.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3310" } } },
  }, AllowFunnel: { "fixture.ts.net:8443": true }, Foreground: { preview: {} }, FutureSurface: {} };
  assert.equal(assertExclusiveServeV1(serve, 4383), serve);
  assert.throws(() => assertExclusiveServeV1({ ...serve,
    AllowFunnel: { ...serve.AllowFunnel, "fixture.ts.net:443": true } }, 4383), /tailscale_exclusivity_refused/u);
  assert.throws(() => assertExclusiveServeV1({ Web: { "fixture.ts.net:443": { Handlers: {
    "/": { Proxy: "http://127.0.0.1:3210" }, "/extra": { Proxy: "http://127.0.0.1:3210" },
  } } } }, 3210), /tailscale_exclusivity_refused/u);
});

test("rerun key reads refuse a symlink without following or blocking", async t => {
  const f = await fixture(t, "key-rerun", { failC4: "seed" });
  await assert.rejects(installControlRoomV1(f.options), /c4_seed_failed/u);
  const publicPath = join(f.root, "Protected/service/vapid-public.json"), outside = join(f.base, "outside.json");
  await writeFile(outside, '{"publicKey":"fixture-public"}\n'); await rm(publicPath); await symlink(outside, publicPath);
  const retry = fakePorts({ users: f.ports.users, groups: f.ports.groups });
  await assert.rejects(installControlRoomV1({ ...f.options, ports: retry }), /existing_key_refused/u);
  assert.equal(await readFile(outside, "utf8"), '{"publicKey":"fixture-public"}\n');

  const fifo = join(f.base, "planted-key-fifo");
  const made = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const module = pathToFileURL(join(repository, "src/updater/v1/install/installer.mjs")).href;
  const script = `import { readRegularFileNoFollowV1 } from ${JSON.stringify(module)};
    try { await readRegularFileNoFollowV1(${JSON.stringify(fifo)}); process.exitCode = 2; }
    catch (error) { if (error?.message !== "existing_file_refused") throw error; }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const outcome = await new Promise(resolveOutcome => {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 750);
    child.once("close", code => { clearTimeout(timer); resolveOutcome({ code, timedOut }); });
  });
  assert.equal(outcome.timedOut, false, "FIFO read blocked without O_NONBLOCK");
  assert.equal(outcome.code, 0);
});

test("attended source must be owner-sealed before root snapshots it", async t => {
  const f = await fixture(t, "writable-source", { buildResult: async input => {
    const value = await makeSource(join(input.root, "build/job-writable/output"));
    await chmod(join(value.source, "package.json"), 0o664);
    return { ...value, digest: await digestControlRoomCheckoutV1(value.source) };
  } });
  await assert.rejects(installControlRoomV1(f.options), /source_ownership_refused/u);
});

test("unsafe ACLs, privileged adopted accounts and a reused lock pid fail closed", async t => {
  const acl = fakePorts({ ownership: path => ({ type: "directory", symlink: false, uid: 0, gid: 0, mode: 0o755,
    acl: path === "/Library" ? ["0: group:staff allow writesecurity"] : [] }) });
  await assert.rejects(assertInstallerRootSafetyV1({ root: DEFAULT_CONTROL_ROOM_ROOT_V1, ports: acl }), /install_root_ancestor_refused/u);

  const adopted = { name: "_testsvc", uid: 300, gid: 300, home: "/var/empty", shell: "/usr/bin/false", hidden: true,
    password: "*", memberships: ["staff"] };
  const f = await fixture(t, "privileged-adopt", { users: [adopted], groups: [{ name: "_testsvc", gid: 300 }] });
  await assert.rejects(installControlRoomV1(f.options), /account_state_refused/u);

  const reused = await fixture(t, "reused-pid", { processIdentity: () => "new-process" });
  await mkdir(reused.root, { recursive: true });
  await writeFile(join(reused.root, ".install.lock"), `${JSON.stringify({ pid: process.pid, token: "old", identity: "old-process" })}\n`,
    { mode: 0o600 });
  await installControlRoomV1(reused.options);
  assert.equal((await statusControlRoomV1({ root: reused.root })).state, "installed");
});

test("uninstall boots services out, restores Serve, then deletes accounts and drops sudo twice", async t => {
  const f = await fixture(t, "uninstall-order"); await installControlRoomV1(f.options);
  const ports = fakePorts({ users: f.ports.users, groups: f.ports.groups });
  await uninstallFreshControlRoomV1({ ...f.options, ports });
  const effects = ports.calls.map(call => call[0]);
  assert(effects.indexOf("recover-services") >= 0);
  assert(effects.indexOf("recover-services") < effects.indexOf("restore"));
  assert(effects.indexOf("restore") < effects.indexOf("delete-account"));
  assert.equal(effects.filter(name => name === "sudo-K").length, 2);
});

test("E2E-1 fake-root install night completes against a local bare GitHub, repeats, recovers and uninstalls",
  { timeout: 240_000 }, async t => {
  assert.equal(DEFAULT_CONTROL_ROOM_WEB_PORT_V1, 3210, "install night reserves the reviewed live web port");
  assert.equal(DEFAULT_CONTROL_ROOM_GATEWAY_PORT_V1, 3211, "protected config reserves the reviewed fleet gateway port");
  const originalServe = { Web: {
    "fixture.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7864" } } },
    "fixture.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3310" } } },
  }, TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } }, AllowFunnel: {} };
  const f = await fixture(t, "install-night-journey", { initialServe: originalServe, livePort: 7864 });
  const github = await makeBareGithub(f.base);
  f.ports = fakePorts({ initialServe: originalServe, livePort: 7864, bareRepository: github.bare });
  f.options = { ...f.options, commit: github.commit, ports: f.ports, webPort: undefined };
  await writeFile(join(f.bootstrap, "bootstrap.json"), `${JSON.stringify({ schema: "control-room.bootstrap/v1",
    commit: github.commit, remoteUrl: "https://github.com/AgenticBotSitter/agent-control-room.git",
    git: "/usr/bin/git", node: { version: "fixture" } })}\n`, { mode: 0o600 });
  let daemons = false;
  const bindDaemonState = ports => {
    const install = ports.installServices.bind(ports), uninstall = ports.uninstallServices.bind(ports),
      recover = ports.recoverServices.bind(ports);
    ports.installServices = async value => { const result = await install(value); daemons = true; return result; };
    ports.uninstallServices = async value => { const result = await uninstall(value); daemons = false; return result; };
    ports.recoverServices = async value => { const result = await recover(value); daemons = false; return result; };
    return ports;
  };
  bindDaemonState(f.ports);
  await installControlRoomV1(f.options);
  assert.equal(daemons, true);
  assert.equal(f.ports.calls.some(call => call[0] === "curl"), true, "runtime downloads use the injected curl boundary");
  assert.equal(f.ports.calls.filter(call => call[0] === "create-account").length, 3, "fake dscl creates only policy accounts");
  assert.equal(f.ports.calls.some(call => call[0] === "install-services"), true, "fake launchctl batches ran");
  assert.equal(f.ports.calls.some(call => call[0] === "activate"), true, "fake Tailscale activation ran");
  assert.equal(f.ports.calls.find(call => call[0] === "activate")[1].webPort, DEFAULT_CONTROL_ROOM_WEB_PORT_V1);
  assert.equal(f.ports.serveState().Web["fixture.ts.net:8443"].Handlers["/"].Proxy, "http://127.0.0.1:3310");
  const protectedInput = f.ports.calls.find(call => call[0] === "compose-protected-config")[1];
  assert.equal(protectedInput.webPort, DEFAULT_CONTROL_ROOM_WEB_PORT_V1);
  assert.equal(protectedInput.gatewayPort, DEFAULT_CONTROL_ROOM_GATEWAY_PORT_V1);
  assert.equal(protectedInput.rpId, "fixture.ts.net");
  assert.equal(protectedInput.installationId.length, 36);
  assert.deepEqual(Object.keys(protectedInput.keys).sort(), ["healthProbeRoot", "healthProbeService", "vapidPrivate",
    "vapidPublic", "webHmac", "workIntake"]);
  assert.deepEqual(f.ports.calls.filter(call => call[0] === "owner-prompt").map(call => call[1]),
    ["token", "six-words", "six-character-code"]);
  const confirmationInput = f.ports.calls.find(call => call[0] === "confirm")[1];
  assert.match(confirmationInput.inventoryDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(typeof confirmationInput.terminal?.readLine, "function");
  assert.equal(f.ports.calls.find(call => call[0] === "adopt-bootstrap")[1].remoteUrl,
    "https://github.com/AgenticBotSitter/agent-control-room.git");
  assert(f.ports.calls.filter(call => call[0] === "verify-bootstrap-source")
    .every(call => call[1].gitPath === "/usr/bin/git"));
  assert.equal(await readFile(join(f.root, "updater-state", "self-update"), "utf8"), "Off\n");
  const handoffCalls = f.ports.calls.map(call => call[0]);
  assert(handoffCalls.indexOf("load-install-steps") < handoffCalls.indexOf("continue-install"));
  assert(handoffCalls.indexOf("continue-install") < handoffCalls.indexOf("install-services"));

  const second = bindDaemonState(fakePorts({ version: "1.2.4", users: f.ports.users, groups: f.ports.groups }));
  await installControlRoomV1({ ...f.options, bootstrap: undefined, commit: "b".repeat(40), ports: second });
  assert.match(second.calls.find(call => call[0] === "confirm")[1].inventoryDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal((await statusControlRoomV1({ root: f.root })).current, "releases/1.2.4-bbbbbbbbbbbb");

  const failed = bindDaemonState(fakePorts({ version: "1.2.5", users: f.ports.users, groups: f.ports.groups,
    failHealth: true }));
  await assert.rejects(installControlRoomV1({ ...f.options, bootstrap: undefined, commit: "c".repeat(40), ports: failed }), /health_failed/u);
  assert.equal((await statusControlRoomV1({ root: f.root })).current, "releases/1.2.4-bbbbbbbbbbbb");
  assert.equal(await readFile(join(f.root, "updater-state", "self-update"), "utf8"), "Off\n");

  const records = (await readFile(join(f.root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  const transactions = [...new Set(records.filter(record => record.command === "install").map(record => record.transactionId))];
  const completedActions = id => records.filter(record => record.transactionId === id && record.phase === "done")
    .map(record => record.action);
  assert.deepEqual(completedActions(transactions[0]), ["verify-bootstrap-source", "create-accounts", "deny-builder-schedulers", "create-layout",
    "self-update-off", "adopt-bootstrap", "vendor-tool-runtime", "generate-keys", "sudoers", "seed-updater", "fetch-source", "build-release",
    "build-updater-bundle", "confirm", "stage", "switch-pointers", "load-install-steps", "vendor-pg-runtime", "init-database",
    "install-database-service", "fresh-database", "apply-release-schema", "write-database-logins", "first-owner", "install-guard", "install-services",
    "capture-tailscale", "activate-tailscale", "record-serve", "health-check", "seed-known-good", "mint-owner-session",
    "install-post-health-services", "transaction"]);
  assert.deepEqual(completedActions(transactions[1]), ["fetch-source", "build-release", "build-updater-bundle", "confirm",
    "stage", "switch-pointers", "restart-services", "health-check", "transaction"]);
  assert.deepEqual(completedActions(transactions[2]), ["fetch-source", "build-release", "build-updater-bundle", "confirm",
    "stage", "switch-pointers", "restart-services"]);
  const passkeyTransaction = records.find(record => record.command === "passkey")?.transactionId;
  assert.deepEqual(completedActions(passkeyTransaction), ["register-passkey", "cleanup-bootstrap", "transaction"]);

  const uninstall = bindDaemonState(fakePorts({ users: f.ports.users, groups: f.ports.groups,
    initialServe: f.ports.serveState() }));
  const result = await uninstallFreshControlRoomV1({ ...f.options, ports: uninstall });
  assert.equal(daemons, false, "uninstall-fresh leaves no fake daemon loaded");
  assert.deepEqual(uninstall.serveState(), originalServe, "uninstall-fresh restores the pre-install Serve snapshot");
  assert.equal(await readFile(join(result.retained, "updater-state", "self-update"), "utf8"), "Off\n");
  assert.equal(uninstall.calls.some(call => call[0] === "recover-services"), true);

  const failureActions = ["verify-bootstrap-source", "create-accounts", "deny-builder-schedulers", "create-layout",
    "self-update-off", "adopt-bootstrap", "vendor-tool-runtime", "generate-keys", "sudoers", "seed-updater",
    "fetch-source", "build-release", "build-updater-bundle", "confirm", "stage", "switch-pointers", "load-install-steps",
    "vendor-pg-runtime", "init-database", "install-database-service", "fresh-database", "apply-release-schema", "write-database-logins",
    "first-owner", "install-guard", "install-services", "capture-tailscale", "activate-tailscale", "record-serve",
    "health-check", "seed-known-good", "mint-owner-session", "install-post-health-services"];
  for (const action of failureActions) {
    let injected = false;
    const failedInstall = await fixture(t, `e2e-failure-${action}`, { initialServe: originalServe, livePort: 7864,
      afterJournalEntry: async record => {
        if (!injected && record.command === "install" && record.action === action && record.phase === "done") {
          injected = true; throw new Error(`injected_after_${action}`);
        }
      } });
    await assert.rejects(installControlRoomV1(failedInstall.options), new RegExp(`injected_after_${action}`, "u"));
    assert.equal(failedInstall.ports.users.length, 0, `${action}: account survived`);
    await assert.rejects(lstat(failedInstall.systemPaths.shim), { code: "ENOENT" });
    await assert.rejects(lstat(failedInstall.systemPaths.sudoers), { code: "ENOENT" });
    assert.deepEqual(failedInstall.ports.serveState(), originalServe, `${action}: Serve was not restored`);
    for (const path of [join(failedInstall.root, "current"), join(failedInstall.root, "guard/guard.sh"),
      join(failedInstall.root, "Protected/config/host.json"), join(failedInstall.root, "Protected/service/db-logins.json")]) {
      await assert.rejects(lstat(path), { code: "ENOENT" }, `${action}: ${path} survived`);
    }
    const retry = fakePorts({ users: failedInstall.ports.users, groups: failedInstall.ports.groups,
      initialServe: originalServe, livePort: 7864, version: "1.2.4" });
    const retried = await installControlRoomV1({ ...failedInstall.options, ports: retry });
    assert.equal(retried.state, "installed", `${action}: retry did not complete`);
  }
});

// THE REHEARSAL TAILSCALE SKIP, PROVEN AT THE EXEC BOUNDARY.
//
// The port-level proof above is real but it is a fake: `fakePorts` ANSWERS the
// Tailscale calls, so it would keep answering them if the production path started
// calling them again — the assertion above would still pass while the owner sat
// behind a rehearsal that quietly touched their real tailnet.
//
// WHAT THE WITNESS IS, AND WHY IT IS NOT `PATH`. The obvious witness — a fake
// `tailscale` earlier on `PATH` — is WORTHLESS here, and it took reading the
// production code to see why. `runTailscaleCliV1` executes the ABSOLUTE path
// `/Applications/Tailscale.app/Contents/MacOS/Tailscale`
// (`control-room-native-ports.mjs:61`), and `buildTrustedEnvironment` builds a
// fixed `{LANG, LC_ALL}` environment with NO `PATH` at all
// (`trusted-runtime.mjs:15,57`). So a program on `PATH` is unreachable from that
// path: putting one there would make this test pass forever, including against a
// tree that talks to the owner's real tailnet. A test that cannot fail is not a
// test, so the witness is the boundary that is actually reachable.
//
// So the witness is the PRODUCTION port adapter, rebound in place of the fake,
// and the assertion is that no Tailscale port is entered at all. `nativePorts`
// is the real implementation, so if rehearsal ever reaches one of these it
// executes the real Tailscale binary as the real owner — which on this machine is
// exactly what must not happen, and the test asserts the call list before that
// can take effect. The two halves of the claim are both asserted: the ports are
// the production ones, and none of them is called.
//
// The three phases the owner will actually hit, in order, because each is a
// separate path into the same skip decision:
//   1. a KILLED install and its recovery — recovery re-reads the journal, and the
//      journal is where the skip lives, so a recovery that rebuilt the install
//      from the plan without the skip would land in the Tailscale ports here,
//   2. uninstall-fresh, which restores Serve, and restoring Serve is the one
//      Tailscale action that could plausibly have been left out of the skip.
//
// A CLEAN install is not a third phase, and the reason is worth stating because
// it cost this test a rewrite: a clean install leaves a COMPLETED transaction, so
// the recovery cannot follow it on the same root (`this Mac is already
// installed`). The kill is therefore in the first run, and the recovery it
// provokes covers the same code as a clean run for the Tailscale question.
test("a rehearsal never enters a Tailscale port: install, recovery after a kill, and uninstall-fresh",
  { timeout: 180_000 }, async t => {
    const base = await temporary("rehearsal-no-tailscale");
    t.after(() => cleanup(base));
    const root = join(base, "install"), bootstrap = join(base, "bootstrap");
    const systemPaths = await prepareSystemPaths(base);
    await mkdir(bootstrap); await writeFile(join(bootstrap, "node.tar.gz"), "node");
    await writeFile(join(bootstrap, "bootstrap.json"), `${JSON.stringify({ schema: "control-room.bootstrap/v1",
      commit: "a".repeat(40), remoteUrl: "https://github.com/AgenticBotSitter/agent-control-room.git",
      git: "/usr/bin/git", node: { version: "fixture" } })}\n`, { mode: 0o600 });
    const evidenceLog = join(base, "e2e2-evidence.jsonl");
    const configPath = join(base, "rehearsal.json");
    await rehearsalConfig(configPath, root);
    // The production adapter, in place of the fake, for every Tailscale port
    // except `restoreTailscaleServe` (rehearsal never restores Serve, and the
    // port assertion below covers it) and `readLiveServePort` (a read, not a
    // mutation, and rehearsal has no live install to read).
    const wirePorts = ports => {
      for (const name of ["readTailscaleRpId", "captureTailscaleServe", "activateTailscaleServe",
        "recordTailscaleServe"]) {
        const production = nativePorts[name];
        assert.equal(typeof production, "function", `the production ${name} port must exist for this test to mean anything`);
        ports[name] = async input => { ports.calls.push([name, input]); return production(input); };
      }
      return ports;
    };
    // The call list records the PORT names, so the list is the port names. The
    // re-bound ports push their own name (camelCase) and `fakePorts` pushes the
    // hyphenated names it used already, so BOTH spellings are listed: a
    // regression that reached the fake's own wrapper would otherwise be invisible.
    const TAILSCALE_PORTS = ["readTailscaleRpId", "read-tailscale-rp-id", "readLiveServePort",
      "read-live-serve-port", "captureTailscaleServe", "capture", "activateTailscaleServe", "activate",
      "restoreTailscaleServe", "restore", "recordTailscaleServe", "record-serve"];
    const entered = ports => ports.calls.filter(call => TAILSCALE_PORTS.includes(call[0])).map(call => call[0]);
    const neverCalled = (ports, phase) => assert.deepEqual(entered(ports), [],
      `${phase} entered a Tailscale port: ${entered(ports).join(", ")}`);
    const makePorts = extra => wirePorts(fakePorts({ rpId: "fixture-rehearsal.ts.net", ...extra }));
    const install = (ports, extra = {}) => installControlRoomV1({ root, commit: "a".repeat(40), webPort: 4383,
      replacingLive: false, bootstrap, invokingUser: { user: "fixture-owner", uid: 501, gid: 20 },
      accountsPolicy: accountPolicy, systemPaths, ports, rehearsalConfig: configPath, freshDatabase: true,
      authenticator: "software", e2e2EvidenceLog: evidenceLog, ...extra,
      terminal: { write() {}, async readLine() { return "ABC234"; }, isTTY: true, setRawMode() {} } });

    // 1. A KILLED INSTALL, THEN ITS RECOVERY. This is the first phase rather than
    //    the second on purpose: a clean install leaves a COMPLETED transaction, and
    //    a second install on the same root is refused `this Mac is already
    //    installed`, so "clean install then recovery" cannot be staged in that
    //    order. The kill is injected right after the journal entry that records
    //    `install-services` as done — the state a SIGKILLed phase leaves, and the
    //    state recovery exists for.
    const stopped = { value: false };
    const killed = makePorts({
      afterJournalEntry: async record => {
        if (!stopped.value && record.command === "install" && record.action === "install-services"
            && record.phase === "done") { stopped.value = true; throw new Error("controlled_rehearsal_kill"); }
      },
    });
    await assert.rejects(install(killed), /controlled_rehearsal_kill/u);
    neverCalled(killed, "the killed install");

    // 2. THE RECOVERY, and it is the path most likely to rebuild the install from
    //    the plan and lose the skip, so it is called out in its own message.
    const recovery = makePorts({ users: killed.users, groups: killed.groups });
    await install(recovery);
    assert.equal(recovery.calls.some(call => call[0] === "recover-services"), true,
      "the second install must have recovered, or this phase proved nothing");
    neverCalled(recovery, "RECOVERY");
    // And the recovery really is the one the rehearsal recorded: a rehearsal
    // recovered as a LIVE install would be a much worse bug than a Tailscale
    // call, and it is the same code path.
    assert.equal(recovery.calls.filter(call => call[0] === "install-services").length, 2,
      "recovery resumes with the database and application service batches, under the rehearsal's labels");

    // 3. UNINSTALL-FRESH. Restoring Serve is the one Tailscale action that could
    //    plausibly have been missed.
    const uninstall = makePorts({ users: recovery.users, groups: recovery.groups });
    const removed = await uninstallFreshControlRoomV1({ root, commit: "a".repeat(40), webPort: 4383,
      replacingLive: false, bootstrap, invokingUser: { user: "fixture-owner", uid: 501, gid: 20 },
      accountsPolicy: accountPolicy, systemPaths, ports: uninstall, rehearsalConfig: configPath });
    assert.match(removed.retained, /\.uninstalled-/u);
    assert.equal(uninstall.calls.some(call => call[0] === "recover-services"), true,
      "uninstall-fresh must boot services out, or its Tailscale skip is untested");
    neverCalled(uninstall, "a rehearsal uninstall-fresh");
  });

test("root entry ignores an environment-selected port module and Tailscale always receives a non-root uid", async () => {
  const native = await readFile(join(repository, "src/updater/v1/cli/control-room-native-ports.mjs"), "utf8");
  const installer = await readFile(join(repository, "src/updater/v1/install/installer.mjs"), "utf8");
  assert.equal(installerPortModulePathV1({ CONTROL_ROOM_INSTALLER_PORT_MODULE: "/owner/module.mjs" }, () => 0), undefined);
  assert.equal(installerPortModulePathV1({ CONTROL_ROOM_INSTALLER_PORT_MODULE: "/owner/module.mjs" }, () => 501),
    "/owner/module.mjs");
  assert.match(native, /identity\.uid < 1/u);
  assert.match(native, /uid: owner\.uid, gid: owner\.gid/u);
  assert.equal([...native.matchAll(/command\(TAILSCALE/gu)].length, 0);
  assert.match(native, /handle\.chmod\(mode\)/u);
  assert.match(native, /setTailscaleServe443V1/u);
  assert.doesNotMatch(native, /serve", "set-config", "--all/u);
  assert.doesNotMatch(native, /serve", "get-config", "--all/u);
  assert.doesNotMatch(native, /lchown\(path, owner\.uid/u);
  assert.match(native, /process\.stdin\.setRawMode\(true\)/u);
  assert.doesNotMatch(native, /web-push/u);
  assert.doesNotMatch(native,
    /dependencyUnavailable\("daemon_adapter"\)|dependencyUnavailable\("services_recovery"\)|dependencyUnavailable\("post_health_services"\)|dependencyUnavailable\("runtime_rollback"\)/u);
  for (const name of ["installServicesV1", "uninstallServicesV1", "recoverServicesV1", "restartServicesV1",
    "startPostHealthServicesV1"]) assert.match(native, new RegExp(`\\b${name}\\b`, "u"));
  assert.doesNotMatch(native, /rm\(directory, \{ recursive: true/u);
  assert.match(installer, /handle\.chmod\(mode\)/u);
  assert.match(installer, /O_RDONLY \| fsConstants\.O_NOFOLLOW \| fsConstants\.O_NONBLOCK/u);
  const calls = [];
  await runTailscaleCliV1({ uid: 501, gid: 20 }, ["serve", "status", "--json"], async (...args) => { calls.push(args);
    return { stdout: "{}", stderr: "" }; });
  assert.equal(calls[0][0], "/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  assert.deepEqual(calls[0][2], { uid: 501, gid: 20, maxBuffer: 1024 * 1024 });
  assert.equal(await readTailscaleRpIdV1({ uid: 501, gid: 20 }, async () => ({
    stdout: '{"Self":{"DNSName":"fixture.ts.net."}}', stderr: "",
  })), "fixture.ts.net");
  await assert.rejects(readTailscaleRpIdV1({ uid: 501, gid: 20 }, async () => ({
    stdout: '{"Self":{"DNSName":""}}', stderr: "",
  })), /tailscale_rp_id_refused/u);
  await assert.rejects(runTailscaleCliV1({ uid: 0, gid: 0 }, [], async () => ({})), /tailscale_identity_refused/u);
  assert.deepEqual(parseTailscaleJsonV1('{"Web":{}}'), { Web: {} });
  assert.throws(() => parseTailscaleJsonV1(`{"x":"${"a".repeat(1024 * 1024)}"}`), /tailscale_json_refused/u);
  assert.throws(() => parseTailscaleJsonV1("[]"), /tailscale_json_refused/u);
});

test("the archived installer entry and native ports load without node_modules", async t => {
  const base = await temporary("bare-archive"); t.after(() => cleanup(base));
  const archive = join(base, "source.tar"), source = join(base, "source"); await mkdir(source);
  const index = join(base, "archive.index"), gitEnvironment = { ...process.env, GIT_INDEX_FILE: index };
  const readTree = spawnSync("/usr/bin/git", ["read-tree", "HEAD"], { cwd: repository, env: gitEnvironment, encoding: "utf8" });
  assert.equal(readTree.status, 0, readTree.stderr);
  const addTree = spawnSync("/usr/bin/git", ["add", "-A"], { cwd: repository, env: gitEnvironment, encoding: "utf8" });
  assert.equal(addTree.status, 0, addTree.stderr);
  const snapshot = spawnSync("/usr/bin/git", ["write-tree"], { cwd: repository, env: gitEnvironment, encoding: "utf8" });
  assert.equal(snapshot.status, 0, snapshot.stderr);
  const packed = spawnSync("/usr/bin/git", ["archive", "--format=tar", `--output=${archive}`,
    snapshot.stdout.trim() || "HEAD"], { cwd: repository, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const extracted = spawnSync("/usr/bin/tar", ["-xf", archive, "-C", source], { encoding: "utf8" });
  assert.equal(extracted.status, 0, extracted.stderr);
  await assert.rejects(lstat(join(source, "node_modules")), { code: "ENOENT" });
  const status = spawnSync(process.execPath, [join(source, "src/updater/v1/cli.mjs"), "status", "--root",
    join(base, "not-installed")], { cwd: source, env: { LANG: "C", LC_ALL: "C" }, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /not-installed/u);
  const install = spawnSync(process.execPath, [join(source, "src/updater/v1/cli.mjs"), "install"], {
    cwd: source, env: { LANG: "C", LC_ALL: "C" }, encoding: "utf8",
  });
  assert.equal(install.status, 1, install.stderr);
  assert.match(install.stderr, /root_required/u);
  assert.doesNotMatch(install.stderr, /module-not-found|ERR_MODULE_NOT_FOUND/iu);
  // The import shape is `--eval` with the URL written INTO the program, so
  // `process.argv[1]` is absent and the shared entry guard answers `false`. The
  // older spelling, `--eval "await import(process.argv[1])" <file: URL>`, put a
  // `file:` URL in `argv[1]`; that is a refusal now, because `realpathSync` on a
  // URL string is ENOENT and `node <a file: URL>` fails with `Cannot find module
  // '<cwd>/file:/…'` — so a real entry is never spelled that way. The
  // `a file: URL in argv[1] refuses` case in `invoked-directly.test.mjs` is where
  // that spelling is now covered.
  const portsUrl = pathToFileURL(join(source, "src/updater/v1/cli/control-room-native-ports.mjs")).href;
  const imported = spawnSync(process.execPath, ["--input-type=module", "--eval",
    `await import(${JSON.stringify(portsUrl)});`],
  { cwd: source, env: { LANG: "C", LC_ALL: "C" }, encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr);
  assert.doesNotMatch(imported.stderr, /direct_entry_guard_refused/u);
});

test("svc2 generate-keys supplies persisted release trust and retry refuses tampered custody", async t => {
  const f = await fixture(t, "svc2-key-retry", { failC4: "seed" });
  await assert.rejects(installControlRoomV1(f.options), /c4_seed_failed/u);
  const keyPath = join(f.root, "updater-state/release-signing-key.pem");
  const trustPath = join(f.root, "Protected/config/release-trust.json");
  const key = await readFile(keyPath), trustBytes = await readFile(trustPath);
  const trust = JSON.parse(trustBytes);
  assert.equal((await lstat(keyPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(trustPath)).mode & 0o777, 0o640);
  assert.equal(createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url"), trust.publicKey);
  const retry = fakePorts({ users: f.ports.users, groups: f.ports.groups });
  await installControlRoomV1({ ...f.options, ports: retry });
  assert.deepEqual(await readFile(keyPath), key); assert.deepEqual(await readFile(trustPath), trustBytes);
  assert.deepEqual(retry.calls.find(call => call[0] === "compose-protected-config")[1].releaseTrust, trust);
  // Isolated failures after key generation leave custody for a refusal test.
  for (const damage of ["bytes", "mode", "link", "hardlink"]) {
    const broken = await fixture(t, `svc2-key-${damage}`, { failC4: "seed" });
    await assert.rejects(installControlRoomV1(broken.options), /c4_seed_failed/u);
    const path = join(broken.root, "updater-state/release-signing-key.pem");
    const original = await readFile(path);
    if (damage === "bytes") await writeFile(path, "tampered\n");
    if (damage === "mode") await chmod(path, 0o640);
    if (damage === "link") { const other = join(broken.base, "held.pem"); await rename(path, other); await symlink(other, path); }
    if (damage === "hardlink") await link(path, join(broken.base, "held.pem"));
    const next = fakePorts({ users: broken.ports.users, groups: broken.ports.groups });
    await assert.rejects(installControlRoomV1({ ...broken.options, ports: next }), /release_signing_refused/u);
    assert.deepEqual(await readFile(path), damage === "bytes" ? Buffer.from("tampered\n") : original);
    assert.equal(next.calls.some(call => call[0] === "compose-protected-config"), false);
  }
});

// The installer ports simulate OS effects; release assembly, signing and loading
// are real. The installed loader below comes from the shipped release itself.
test("connrel installer ships a trusted connector and Connect a bot can make its install line", { timeout: 120_000 }, async t => {
  // Release assembly requires compiled inputs even when this file runs alone.
  const compiled = await runChild(join(repository, "scripts/build-vps.mjs"),
    { CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" });
  assert.equal(compiled.code, 0, compiled.stderr);
  const f = await fixture(t, "connector-release", { buildResult: async input => {
    assert.ok(input.releaseTrust, "generate-keys must supply the build's installation trust");
    const output = join(input.job, "output"); await mkdir(output, { recursive: true });
    const built = await runChild(join(repository, "src/updater/v1/build-attended-release.mjs"), {},
      ["--source", repository, "--output", output, "--commit", input.commit,
        "--release-trust-json", JSON.stringify(input.releaseTrust)]);
    assert.equal(built.code, 0, built.stderr);
    const manifest = JSON.parse(await readFile(join(output, "RELEASE_MANIFEST.json")));
    const signingInput = { output, commit: input.commit, trust: input.releaseTrust,
      privateKeyPath: join(input.root, "updater-state/release-signing-key.pem") };
    await signAttendedConnectorReleaseV1(signingInput, { expectedUid: process.geteuid() });
    await verifyAttendedBuildOutputV1(output, { commit: input.commit });
    const first = await readFile(join(output, "RELEASE_MANIFEST.json"));
    await signAttendedConnectorReleaseV1(signingInput, { expectedUid: process.geteuid() });
    assert.deepEqual(await readFile(join(output, "RELEASE_MANIFEST.json")), first);
    return { source: output, version: manifest.version, digest: await digestControlRoomCheckoutV1(output) };
  } });
  const installed = await installControlRoomV1(f.options);
  const releaseRoot = join(f.root, installed.current);
  const loader = await import(pathToFileURL(join(releaseRoot, "dist-vps/server/macLocalFleet.js")).href);
  const trust = JSON.parse(await readFile(join(f.root, "Protected/config/release-trust.json"), "utf8"));
  const releaseParsers = await tsImport("../src/web/v1/mac-local-protected-loader.ts", import.meta.url);
  const portInput = f.ports.calls.find(call => call[0] === "compose-protected-config")[1];
  const value = Buffer.alloc(32, 1).toString("base64url");
  const composed = composeProtectedConfigV1({ ...portInput,
    dbLogins: INSTALL_DATABASE_LOGINS_V1.map(name => ({ name, password: value,
      passwordDigest: `sha256:${createHash("sha256").update(value).digest("hex")}`,
      fileRef: join(f.root, "Protected/config/database-passwords", `${name}.txt`) })),
    keys: { ...portInput.keys,
      webHmac: { fileRef: portInput.keys.webHmac, value },
      workIntake: { fileRef: portInput.keys.workIntake, integrityKey: value } },
  }, { ...releaseParsers, captureReleaseTrustV1 });
  const composedTrust = JSON.parse(composed.find(item => item.path.endsWith("/release-trust.json")).contents);
  assert.deepEqual(composedTrust, trust);
  const connectorRoot = join(releaseRoot, "dist-vps/server/fleet/release");
  const loaded = await loader.loadMacLocalFleetConnectorReleaseV1(connectorRoot, composedTrust);
  assert.ok(loaded, "the real installed loader must not report unavailable");
  assert.equal(loaded.manifest.builtFrom, f.options.commit);
  const { fleetJoinCommandsV1 } = await tsImport("../src/web/v1/fleet-owner-http.ts", import.meta.url);
  const commands = fleetJoinCommandsV1("https://fixture.ts.net", `crj_${"A".repeat(43)}`, "codex",
    loaded.manifest, { displayName: "Fixture", workerId: `fleet-worker:${"a".repeat(32)}` });
  assert.ok(commands.unix.includes(`/fleet/v1/${loaded.manifest.file}`));
  assert.ok(commands.unix.includes(loaded.manifest.sha256));
  for (const name of [loaded.manifest.file, "manifest.json", "connector-release.json"]) {
    assert.equal((await stat(join(connectorRoot, name))).mode & 0o777, 0o440);
  }
  const manifestPath = join(connectorRoot, "manifest.json"), original = await readFile(manifestPath);
  await chmod(manifestPath, 0o640);
  const altered = Buffer.from(original); altered[0] ^= 1; await writeFile(manifestPath, altered);
  await assert.rejects(loader.loadMacLocalFleetConnectorReleaseV1(connectorRoot, trust));
  await writeFile(manifestPath, original); await chmod(manifestPath, 0o440);
  const { createFleetReleaseTrustForTestV1 } = await tsImport("./support/fleet-release.ts", import.meta.url);
  await assert.rejects(loader.loadMacLocalFleetConnectorReleaseV1(connectorRoot, createFleetReleaseTrustForTestV1().trust));
  assert.deepEqual(await readFile(manifestPath), original);
});


test("A2-01 rehearsal loader refuses overlapping, folded and filesystem-aliased roots", async t => {
  const base = await temporary("root-overlap"); t.after(() => cleanup(base));
  const { loadRehearsalConfigV1, LIVE_ROOT_V1 } = await import("../src/updater/v1/install/rehearsal-config.mjs");
  const path = join(base, "config.json"), liveRoot = join(base, "live");
  await mkdir(liveRoot);
  const load = async root => {
    await rehearsalConfig(path, root);
    return loadRehearsalConfigV1(path, { liveRoot });
  };
  for (const root of [LIVE_ROOT_V1, `${LIVE_ROOT_V1}/practice`, dirname(LIVE_ROOT_V1),
    LIVE_ROOT_V1.toLowerCase(), `${liveRoot}/new/child`, liveRoot.toUpperCase(), base]) {
    await assert.rejects(load(root), error => error.code === "rehearsal_config_refused", root);
  }
  const alias = join(base, "alias"); await symlink(liveRoot, alias);
  for (const root of [alias, join(alias, "not-created/child")])
    await assert.rejects(load(root), error => error.code === "rehearsal_config_refused");
  const dangling = join(base, "dangling"); await symlink(join(liveRoot, "not-created"), dangling);
  await assert.rejects(load(join(dangling, "child")), /rehearsal_config_refused/u);
  // The injected live root can itself be an alias; compare both canonical roots.
  await rehearsalConfig(path, join(liveRoot, "future"));
  await assert.rejects(loadRehearsalConfigV1(path, { liveRoot: alias }), /rehearsal_config_refused/u);
  assert.equal((await load(`${LIVE_ROOT_V1} Rehearsal`)).root, `${LIVE_ROOT_V1} Rehearsal`);
  assert.equal((await load(join(base, "live-sibling"))).root, join(base, "live-sibling"));
  const directory = join(liveRoot, "Protected/config"); await mkdir(directory, { recursive: true });
  const alternate = join(base, "Alternate-Café"); await mkdir(alternate);
  await writeFile(join(directory, "host.json"), JSON.stringify({ nested: { root: alternate } }));
  for (const root of [alternate.toLowerCase(), join(alternate.normalize("NFD"), "child")])
    await assert.rejects(load(root), /rehearsal_config_refused/u);
  const loop = join(base, "loop"); await symlink(loop, loop);
  await assert.rejects(load(join(loop, "child")), /rehearsal_config_refused/u);
});

test("A2-10 rehearsal live identity traversal refuses excessive depth and node count with a typed error", async t => {
  const base = await temporary("live-depth"); t.after(() => cleanup(base));
  const liveRoot = join(base, "live"), directory = join(liveRoot, "Protected/config");
  await mkdir(directory, { recursive: true });
  const path = join(base, "config.json");
  const value = await rehearsalConfig(path, join(base, "practice"));
  for (const text of ['{"a":'.repeat(100) + '0' + '}'.repeat(100),
    '{"a":'.repeat(15000) + '0' + '}'.repeat(15000),
    JSON.stringify({ a: Array(100001).fill(0) })]) {
    await writeFile(join(directory, "host.json"), text, { mode: 0o600 });
    await assert.rejects(assertNoLiveRehearsalCollisionsV1(value, liveRoot),
      error => error.code === "rehearsal_config_refused" && !(error instanceof RangeError));
  }
  await writeFile(join(directory, "host.json"), JSON.stringify({ nested: [{ webPort: 4383 }] }));
  await assert.rejects(assertNoLiveRehearsalCollisionsV1(value, liveRoot), /rehearsal_config_refused/u);
  await writeFile(join(directory, "host.json"), '{}');
  assert.equal(await assertNoLiveRehearsalCollisionsV1(value, liveRoot), value);
});

test("A2-03 installer CLI refuses unsafe ports before returning options", () => {
  const options = { invokingUser: { user: "fixtureowner", uid: 501, gid: 20 } };
  for (const port of ["0", "1023", "65536", "9".repeat(400), "00013210", "12x"])
    assert.throws(() => parseInstallerArgumentsV1("install", ["--web-port", port], options), /arguments_refused/u);
  for (const port of ["1024", "13210", "65535"])
    assert.equal(parseInstallerArgumentsV1("install", ["--web-port", port], options).webPort, Number(port));
});

// R4S-15: the parser accepted relative, empty, "/", ".." and newline paths for --root and
// --bootstrap. The installer's own `absolute()` refused them further down, so this was tidiness
// rather than a hole — but a parser that accepts a value the installer will refuse is a trap.
test("R4S-15 installer CLI refuses relative, empty, root, dot-dot and control-character paths", () => {
  const options = { invokingUser: { user: "fixtureowner", uid: 501, gid: 20 } };
  const commit = ["--commit", "a".repeat(40)];
  // A control case first: an ordinary absolute path must still parse, or every refusal below
  // would pass for the wrong reason.
  assert.equal(parseInstallerArgumentsV1("install", [...commit, "--root", "/private/tmp/cr"], options).root,
    "/private/tmp/cr");
  assert.equal(parseInstallerArgumentsV1("install", [...commit, "--bootstrap", "/var/root/cr-boot.x"], options).bootstrap,
    "/var/root/cr-boot.x");
  for (const bad of ["relative/install", "", "/", "/Library/../tmp/x", "/Library/./x", "/private/tmp/cr\n/tmp",
    "/private/tmp/cr\troot", "/private/tmp/\0cr", "/private/tmp/cr/", "/private/tmp/./cr"])
    for (const flag of ["--root", "--bootstrap", "--rehearsal-config", "--e2e2-evidence-log"]) {
      const args = flag === "--bootstrap" ? [...commit, flag, bad] : [flag, bad, ...commit];
      assert.throws(() => parseInstallerArgumentsV1("install", args, options), /arguments_refused/u,
        `${flag} ${JSON.stringify(bad)}`);
    }
  // The same rule on the status and uninstall-fresh verbs, which take a root too.
  for (const verb of ["status", "uninstall-fresh"])
    for (const bad of ["relative/install", "", "/", "/Library/../tmp/x", "/private/tmp/cr\n/tmp"])
      assert.throws(() => parseInstallerArgumentsV1(verb, ["--root", bad], options), /arguments_refused/u,
        `${verb} --root ${JSON.stringify(bad)}`);
  // A refused root never reaches the caller, so the flag cannot be smuggled past the parser.
  assert.equal(parseInstallerArgumentsV1("install", [...commit, "--root", "/private/tmp/ok"], options).root,
    "/private/tmp/ok");
});

test("A2-06 installer rehearsal JSON refuses duplicate decoded keys in configuration and live inputs", async t => {
  const base = await temporary("duplicate-json"); t.after(() => cleanup(base));
  const { loadRehearsalConfigV1 } = await import("../src/updater/v1/install/rehearsal-config.mjs");
  const path = join(base, "config.json"), liveRoot = join(base, "live");
  const value = await rehearsalConfig(path, join(base, "practice"));
  const valid = JSON.stringify(value);
  for (const text of [valid.replace('"ports":{', '"ports":{"web":1,'),
    valid.replace('"root":', '"ro\\u006ft":"/neutral/ignored","root":')]) {
    await writeFile(path, text, { mode: 0o600 });
    await assert.rejects(loadRehearsalConfigV1(path, { liveRoot }), /rehearsal_config_refused/u);
  }
  await writeFile(path, valid);
  const directory = join(liveRoot, "Protected/config"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "host.json"), '{"webPort":4383,"webPort":12345}', { mode: 0o600 });
  await assert.rejects(loadRehearsalConfigV1(path, { liveRoot }), /rehearsal_config_refused/u);
  await writeFile(join(directory, "host.json"), '{}');
  const results = await Promise.all(Array.from({ length: 50 }, () => loadRehearsalConfigV1(path, { liveRoot })));
  assert.equal(results.length, 50);
});

// Synthetic diagnostics only: no database process or SQL is needed.
test("A2-11 PostgreSQL failure lines contain bounded printable diagnostics", async () => {
  // The shipped phase is bundled to JavaScript; source tests need the loader
  // for its shared TypeScript cluster layout, including on Node 22.13.
  const { pgFailureLineV1 } = await tsImport("../src/updater/v1/pg/init-database.mjs", import.meta.url);
  for (const text of ['FATAL: bad\u001b[2J\u001b[Hforged\rstatus',
    'PANIC: \u0000\u0007\t\u007f\u0085\u009b', 'ERROR: ' + 'x'.repeat(500)]) {
    const line = pgFailureLineV1(text);
    assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/u);
    assert.ok(line.length <= 200); assert.match(line, /^(FATAL|PANIC|ERROR):/u);
  }
  assert.equal(pgFailureLineV1('noise\nFATAL: readable detail\ntrailer'), 'FATAL: readable detail');
});

test("A2-11 CLI failure output strips terminal controls before writing stderr", async t => {
  const base = await temporary("cli-diagnostic"); t.after(() => cleanup(base));
  for (const [index, code] of ['FATAL: bad\u001b[2J\rforged\u009b', 'FATAL: ' + 'x'.repeat(500)].entries()) {
    const modulePath = join(base, `failing-ports-${index}.mjs`);
    await writeFile(modulePath, `throw Object.assign(new Error("fixture"), {code: ${JSON.stringify(code)}});\n`);
    const result = spawnSync(process.execPath, [join(repository, "src/updater/v1/cli.mjs"), "install"], {
      env: { ...process.env, CONTROL_ROOM_INSTALLER_PORT_MODULE: modulePath }, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FATAL: /u);
    const lines = result.stderr.trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /Do not retry.*show the lead after reopening Claude/u);
    assert.match(lines[1], /^FATAL: /u);
    for (const line of lines) {
      assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/u);
      assert.ok(line.length <= 200);
    }
  }
});

test("the installer's journal.key is the updater's own hex format, so the installed updater can journal", async t => {
  // atk-fa F7: 32 raw bytes were written; the updater accepts only 64 hex characters.
  const f = await fixture(t, "journal-key-format");
  assert.equal((await installControlRoomV1(f.options)).state, "installed");
  const key = await readFile(join(f.root, "updater-state/journal.key"), "utf8");
  assert.match(key, /^[a-f0-9]{64}\n$/u);
  const journal = new FileStepJournalV1(f.root, { ownerUid: process.getuid() });
  await journal.intent({ runId: "run-1", ordinal: 1, step: "fetch" });
  await journal.refusal({ planId: "plan-1", reason: "any_reason", count: 1 });
});

test("a stop inside generate-keys leaves no partial key, and the retry installs with one probe key", async t => {
  // atk-fa F12: a stop between a key's create and its chown, or between a pair of key
  // files, left a file every retry refused, or a probe key root and the service disagreed on.
  for (const victim of ["updater-state/journal.key", "updater-state/vapid.json", "Protected/service/vapid-public.json",
    "updater-state/health-probe.key", "Protected/service/health-probe.key", "Protected/service/web-hmac.key"]) {
    const f = await fixture(t, "partial-keys");
    let calls = 0, armed = true;
    f.ports.randomBytes = size => { calls += 1; return Buffer.alloc(size, calls); };
    const chown = f.ports.lchownPath;
    f.ports.lchownPath = async (path, uid, gid) => {
      // The victim's own name or its temporary: whichever the writer chowns first.
      if (armed && dirname(path) === join(f.root, dirname(victim)) && path.split("/").at(-1).includes(victim.split("/").at(-1))) {
        armed = false; throw Object.assign(new Error("stopped_here"), { code: "stopped_here" });
      }
      return chown(path, uid, gid);
    };
    await assert.rejects(installControlRoomV1(f.options), /stopped_here/u, victim);
    assert.equal(armed, false, victim);
    assert.equal((await installControlRoomV1(f.options)).state, "installed", victim);
    assert.equal(await readFile(join(f.root, "Protected/service/health-probe.key"), "utf8"),
      await readFile(join(f.root, "updater-state/health-probe.key"), "utf8"), victim);
    assert.match(await readFile(join(f.root, "updater-state/journal.key"), "utf8"), /^[a-f0-9]{64}\n$/u, victim);
    assert.deepEqual((await readdir(join(f.root, "updater-state"))).filter(name => name.endsWith(".installing")), [], victim);
  }
  // A zero-byte key never held a key and is replaced; a key with other wrong content is refused.
  const empty = await fixture(t, "empty-journal-key");
  await mkdir(join(empty.root, "updater-state"), { recursive: true, mode: 0o700 });
  await writeFile(join(empty.root, "updater-state/journal.key"), "", { mode: 0o600 });
  assert.equal((await installControlRoomV1(empty.options)).state, "installed");
  assert.match(await readFile(join(empty.root, "updater-state/journal.key"), "utf8"), /^[a-f0-9]{64}\n$/u);
  const wrong = await fixture(t, "wrong-journal-key");
  await mkdir(join(wrong.root, "updater-state"), { recursive: true, mode: 0o700 });
  await writeFile(join(wrong.root, "updater-state/journal.key"), "not-a-key\n", { mode: 0o600 });
  await assert.rejects(installControlRoomV1(wrong.options), /existing_key_refused/u);
  assert.equal(await readFile(join(wrong.root, "updater-state/journal.key"), "utf8"), "not-a-key\n");
});

test("a failed identity probe or an empty lock never blocks the next install", async t => {
  // atk-fa F9: the lock was created, then the identity probed, then written; a probe
  // failure or a kill in between left a zero-byte lock that every later run refused.
  let fail = true;
  const f = await fixture(t, "lock-identity", { processIdentity: pid => {
    if (fail) { fail = false; return ""; } return `fixture-process-${pid}`; } });
  await assert.rejects(installControlRoomV1(f.options), /install_lock_refused/u);
  await assert.rejects(lstat(join(f.root, ".install.lock")), { code: "ENOENT" });
  assert.equal((await installControlRoomV1(f.options)).state, "installed");
  assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith(".install.lock")), []);
  const empty = await fixture(t, "lock-empty");
  await mkdir(empty.root, { recursive: true }); await writeFile(join(empty.root, ".install.lock"), "", { mode: 0o600 });
  assert.equal((await installControlRoomV1(empty.options)).state, "installed");
  const garbage = await fixture(t, "lock-garbage");
  await mkdir(garbage.root, { recursive: true }); await writeFile(join(garbage.root, ".install.lock"), "{", { mode: 0o600 });
  await assert.rejects(installControlRoomV1(garbage.options), /install_lock_refused/u);
});

test("installers started together on a stale lock admit exactly one holder", { timeout: 120_000 }, async t => {
  // atk-fa F10: check-then-unlink let several installers each remove the stale lock,
  // and each other's fresh lock, and all enter the exclusive section at once.
  for (let round = 0; round < 3; round += 1) {
    const f = await fixture(t, `stale-lock-race-${round}`);
    await mkdir(f.root, { recursive: true });
    await writeFile(join(f.root, ".install.lock"),
      `${JSON.stringify({ pid: 2147483000, token: "dead-holder", identity: "dead" })}\n`, { mode: 0o600 });
    let inside = 0, most = 0;
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => {
      const ports = fakePorts({ idStart: 100_000 * (round + 1) + index * 1000, buildGate: async () => {
        inside += 1; most = Math.max(most, inside); await new Promise(resolveTimer => setTimeout(resolveTimer, 200)); inside -= 1;
      } });
      const probe = ports.processIdentity;
      ports.processIdentity = async pid => { await new Promise(resolveTimer => setTimeout(resolveTimer, index % 5 * 4)); return probe(pid); };
      return installControlRoomV1({ ...f.options, ports }).then(() => "ok", error => error.message);
    }));
    assert.equal(most, 1, `round ${round}: ${JSON.stringify(results)}`);
    assert.equal(results.filter(result => result === "ok").length, 1, JSON.stringify(results));
    assert.deepEqual(new Set(results.filter(result => result !== "ok")), new Set(["install_already_running"]));
  }
});

test("a torn last journal line is cut off under the lock and the retry recovers and installs", async t => {
  // atk-fa F11: a power cut or full disk mid-append left a last line without a
  // newline, and every retry refused install_journal_refused.
  let count = 0;
  const f = await fixture(t, "torn-journal", { afterJournalEntry: () => {
    count += 1; if (count === 9) throw Object.assign(new Error("stopped_here"), { code: "stopped_here" }); } });
  await assert.rejects(installControlRoomV1(f.options), /stopped_here/u);
  const path = join(f.root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1);
  const before = await readFile(path, "utf8");
  await writeFile(path, before.slice(0, -25), { mode: 0o600 });
  f.ports.afterJournalEntry = undefined;
  assert.equal((await installControlRoomV1({ ...f.options, ports: f.ports })).state, "installed");
  const after = await readFile(path, "utf8");
  assert.ok(after.endsWith("\n"));
  for (const line of after.trim().split("\n")) JSON.parse(line);
  // A malformed FINAL newline-terminated line is also treated as unwritten.
  const malformed = await fixture(t, "malformed-final-journal");
  await mkdir(join(malformed.root, "updater-state"), { recursive: true, mode: 0o700 });
  await writeFile(join(malformed.root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1), '{"torn\n', { mode: 0o600 });
  assert.equal((await installControlRoomV1(malformed.options)).state, "installed");
  // Malformed and blank MIDDLE lines must refuse.

  const garbled = await fixture(t, "garbled-journal");
  await mkdir(join(garbled.root, "updater-state"), { recursive: true, mode: 0o700 });
  await writeFile(join(garbled.root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1), "{\"torn\n{}\n", { mode: 0o600 });
  await assert.rejects(installControlRoomV1(garbled.options), /install_journal_refused/u);
  await writeFile(join(garbled.root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1), "\n{}\n", { mode: 0o600 });
  await assert.rejects(installControlRoomV1(garbled.options), /install_journal_refused/u);
});

test("once the installed record is durable nothing rolls the install back", async t => {
  // atk-fa F15: an error after the record's bytes were durable rolled everything back
  // while the journal said installed, and every retry refused installed_bootstrap_refused.
  const late = record => record.command === "install" && record.action === "transaction" && record.phase === "done";
  let armed = true;
  const f = await fixture(t, "installed-then-error", { afterJournalEntry: record => {
    if (armed && late(record)) { armed = false; throw Object.assign(new Error("late_journal_failure"), { code: "late_journal_failure" }); } } });
  const result = await installControlRoomV1(f.options);
  assert.equal(result.state, "installed"); assert.equal(armed, false);
  assert.equal(result.passkey.status, "registered");
  assert.equal((await statusControlRoomV1({ root: f.root })).state, "installed");
  assert.equal(f.ports.users.length, 3);
  assert.equal(f.ports.calls.some(call => call[0] === "delete-account" || call[0] === "uninstall-services"), false);
  // The repeat path commits the same way: a late error does not flip the pointers back.
  armed = true;
  const repeat = await installControlRoomV1({ ...f.options, commit: "b".repeat(40), bootstrap: undefined }).catch(error => error);
  assert.equal(armed, false);
  assert.equal(repeat.state, "installed", repeat?.stack);
  assert.equal(f.ports.calls.filter(call => call[0] === "restart-services" && call[1].rollback).length, 0);
  // A refused append OF the installed record (nothing durable) still rolls back.
  const early = await fixture(t, "installed-not-written");
  const journal = join(early.root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1);
  early.ports.afterJournalEntry = async record => {
    if (record.action === "install-post-health-services" && record.phase === "done") await chmod(journal, 0o644);
  };
  await assert.rejects(installControlRoomV1(early.options), /install_journal_refused/u);
  assert.equal(early.ports.users.length, 0);
});

test("after a clean rollback past init-database or post-health services, the retry recovers and installs", async t => {
  // atk-fa F3/F4: recovery replays every undo after a CLEAN in-process rollback, so each
  // replayed port must be repeatable. The postgres shutdown check ran pg_controldata on
  // the retired cluster (ENOENT), and the owner-code rollback refused a file the core
  // services rollback had already removed - every retry, until root's journal was edited.
  const notLoaded = { geteuid: () => 0, execute: async file => {
    if (file === "/bin/launchctl") throw Object.assign(new Error("not loaded"), { code: 3 });
    throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  } };
  for (const failStep of ["health-check", "install-post-health-services"]) {
    const f = await fixture(t, `retry-${failStep}`, { failStep });
    const ports = f.ports, fakeRecover = ports.recoverServices;
    // The real database-batch recovery (bootout + shutdown check) with launchctl answering "not loaded".
    ports.recoverServices = async input => input.roles[0] === "postgresql17"
      ? recoverServicesV1({ root: input.root, roles: input.roles }, { runtime: notLoaded }) : fakeRecover(input);
    ports.composeProtectedConfig = async input => ["host.json", "local-owner-session.json", "fleet-gateway.json",
      "supervisor.json", "backup.json"].map(name => ({ path: join(input.root, "Protected/config", name),
      contents: name === "local-owner-session.json" ? `${JSON.stringify({ ownerCodeDigest: input.ownerCodeDigest })}\n` : "{}\n",
      accountName: accountPolicy.accounts.service, groupName: accountPolicy.accounts.service, fileMode: "0600" }))
      .concat([{ path: join(input.root, "updater-state/updater.json"), contents: "{}\n", accountName: "root",
        groupName: "wheel", fileMode: "0600" }]);
    ports.remintOwnerCode = async ({ servicePolicy, ...input }) => remintOwnerCodeV1(input);
    ports.rollbackOwnerCode = async ({ servicePolicy, ...input }) => rollbackOwnerCodeV1(input);
    await assert.rejects(installControlRoomV1(f.options), /health_failed|fixture_step_failure/u, failStep);
    await assert.rejects(lstat(join(f.root, "Protected/config/local-owner-session.json")), { code: "ENOENT" });
    ports.checkHealth = async input => ({ healthy: true, samples: 3, schemaDigest: input.schemaDigest });
    ports.startPostHealthServices = async input => ({ bundleDigest: `sha256:${"b".repeat(64)}`, receipt: {
      schema: "control-room.services-receipt/v1", receiptDigest: `sha256:${"c".repeat(64)}`, roles: [...input.roles] } });
    const retried = await installControlRoomV1(f.options);
    assert.equal(retried.state, "installed", failStep);
    const journal = (await readFile(join(f.root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    assert.ok(journal.some(row => row.command === "recovery" && row.data.state === "recovered"), failStep);
  }
});

test("re-running the installed commit is refused up front and never renames a live release or updater", async t => {
  // atk-fa F5: the refused re-run left `stage` planned, and the next install's recovery
  // renamed every releases/ and updater/ folder ending in the commit - the live ones.
  const f = await fixture(t, "repeat-same-commit");
  await installControlRoomV1(f.options);
  const resolves = async name => realpath(join(f.root, name)).then(() => true, () => false);
  const journalPath = join(f.root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1);
  const before = await readFile(journalPath, "utf8");
  await assert.rejects(installControlRoomV1({ ...f.options, bootstrap: undefined }), { code: "commit_already_installed" });
  assert.equal(await readFile(journalPath, "utf8"), before, "refused before any journal record");
  const realFetch = f.ports.fetchVerifiedSourceV1;
  f.ports.fetchVerifiedSourceV1 = async input => { await realpath(input.toolRoot); return realFetch(input); };
  assert.equal((await installControlRoomV1({ ...f.options, commit: "b".repeat(40), bootstrap: undefined })).state, "installed");
  for (const name of ["current", "previous", "updater/current", "updater/previous"]) assert.equal(await resolves(name), true, name);

  // A stage that REUSES an identical existing folder (the real stage does) for the
  // `previous` commit, then a later failure: the undo must not rename the live folder.
  const exists = path => lstat(path).then(() => true, () => false);
  const stage = f.ports.stageReleaseV1, stageUpdater = f.ports.stageUpdaterBundleV1;
  f.ports.stageReleaseV1 = async input => await exists(join(input.root, "releases", input.releaseId))
    ? { target: join(input.root, "releases", input.releaseId) } : stage(input);
  f.ports.stageUpdaterBundleV1 = async input => await exists(join(input.root, "updater", input.uver))
    ? { target: join(input.root, "updater", input.uver) } : stageUpdater(input);
  f.ports.checkHealth = async () => { throw Object.assign(new Error("health_web_refused"), { code: "health_web_refused" }); };
  await assert.rejects(installControlRoomV1({ ...f.options, bootstrap: undefined }), /health_web_refused/u);
  for (const name of ["current", "previous", "updater/current", "updater/previous"]) assert.equal(await resolves(name), true, name);
  assert.equal(await readlink(join(f.root, "previous")), `releases/1.2.3-${"a".repeat(12)}`);
  // And the recovery a later run replays for it renames nothing live either.
  f.ports.checkHealth = async input => ({ healthy: true, samples: 3, schemaDigest: input.schemaDigest });
  await assert.rejects(installControlRoomV1({ ...f.options, commit: "b".repeat(40), bootstrap: undefined }), { code: "commit_already_installed" });
  for (const name of ["current", "previous", "updater/current", "updater/previous"]) assert.equal(await resolves(name), true, name);
});

test("uninstall-fresh puts the re-minted owner code back before the core batch checks its receipt", async t => {
  // atk-fa F6: the core receipt holds the installed digests of local-owner-session.json;
  // the install then re-minted the owner code, so uninstall-fresh's core batch refused
  // services_batch_uncertain on every attempt, after booting the services out.
  const f = await fixture(t, "uninstall-after-remint"), ports = f.ports, installed = new Map();
  ports.composeProtectedConfig = async input => ["host.json", "local-owner-session.json", "fleet-gateway.json",
    "supervisor.json", "backup.json"].map(name => ({ path: join(input.root, "Protected/config", name),
    // The composer's own serialization (`protected-config.mjs`), which the rollback writes back byte for byte.
    contents: name === "local-owner-session.json" ? `${JSON.stringify({ ownerCodeDigest: input.ownerCodeDigest }, null, 2)}\n` : "{}\n",
    accountName: accountPolicy.accounts.service, groupName: accountPolicy.accounts.service, fileMode: "0600" }))
    .concat([{ path: join(input.root, "updater-state/updater.json"), contents: "{}\n", accountName: "root",
      groupName: "wheel", fileMode: "0600" }]);
  ports.remintOwnerCode = async ({ servicePolicy, ...input }) => remintOwnerCodeV1(input);
  ports.rollbackOwnerCode = async input => { ports.calls.push(["rollback-owner-code", input]);
    const { servicePolicy, ...value } = input; return rollbackOwnerCodeV1(value); };
  const install = ports.installServices, recover = ports.recoverServices;
  ports.installServices = async input => {
    for (const resource of input.protectedConfig) installed.set(resource.path, resource.contents);
    return install(input);
  };
  // As the real elevated port does: a receipt's protected file whose bytes changed is refused.
  ports.recoverServices = async input => {
    if (input.receipt && input.roles.includes("supervisor")) {
      for (const [path, contents] of installed) {
        const current = await readFile(path, "utf8").catch(() => null);
        if (current !== null && current !== contents) {
          throw Object.assign(new Error("services_batch_uncertain"), { code: "services_batch_uncertain" });
        }
      }
    }
    return recover(input);
  };
  assert.equal((await installControlRoomV1(f.options)).state, "installed");
  const result = await uninstallFreshControlRoomV1({ ...f.options, ports });
  assert.equal(result.state, "uninstalled");
  const order = ports.calls.map(call => call[0] === "recover-services" ? `recover:${call[1].roles[0]}` : call[0])
    .filter(name => name === "rollback-owner-code" || name.startsWith("recover:"));
  assert.deepEqual(order.slice(-4), ["recover:nightly-backup", "rollback-owner-code", "recover:supervisor", "recover:postgresql17"]);
});

test("the install line never says Ready when the Face ID step stopped", async t => {
  // atk-fa F8: the CLI printed "Ready" whatever the passkey result, so nothing told the
  // owner there was no passkey.
  for (const [name, portOptions, expected, absent] of [
    ["stopped", { passkeyFailure: true }, /^Not ready: Face ID is NOT set up \(the passkey step stopped: passkey_terminal_required\)\. .*show this to the lead after reopening Claude/u, /Ready:/u],
    ["registered", {}, /^Ready: Control Room release 1\.2\.3-a{12} is current\. Self-update is Off\.\n$/u, /Not ready/u]]) {
    const f = await fixture(t, `cli-passkey-${name}`, portOptions);
    const output = [];
    const code = await runUpdaterCliV1(["install", "--commit", "a".repeat(40), "--bootstrap", f.bootstrap,
      "--invoking-user", "fixture-owner", "--invoking-uid", "501", "--invoking-gid", "20"], {
      root: f.root, getuid: () => 0, installerPorts: f.ports, terminal: f.options.terminal,
      installerOptions: { accountsPolicy: accountPolicy, systemPaths: f.systemPaths, webPort: 4383 }, stdout: text => output.push(text),
    });
    assert.equal(code, 0, name);
    const line = output.join("").split("\n").filter(Boolean).at(-1) + "\n";
    assert.match(line, expected, name); assert.doesNotMatch(line, absent, name);
  }
});

test("R5G three early Enters report completed fixture rollback before the refusal code", async t => {
  const f = await fixture(t, "owner-word-recovery"), output = [];
  f.ports.confirmAttendedV1 = async input => {
    const plan = { planId: "owner-recovery", kind: "updater", artifact: { commit: input.commit } };
    const planDigest = `sha256:${createHash("sha256").update(canonicalJsonV1(plan)).digest("hex")}`;
    await mkdir(join(f.root, "updater-state/plans"), { recursive: true });
    await writeFile(join(f.root, "updater-state/plans/owner-recovery.json"), JSON.stringify(plan));
    await writeFile(join(f.root, "updater-state/open-confirmation.json"), JSON.stringify({ planId: plan.planId, planDigest }));
    await input.authorize();
    throw new Error("three empty words should refuse");
  };
  await assert.rejects(runUpdaterCliV1(["install", "--commit", "a".repeat(40), "--bootstrap", f.bootstrap,
    "--invoking-user", "fixture-owner", "--invoking-uid", "501", "--invoking-gid", "20"], {
    root: f.root, getuid: () => 0, installerPorts: f.ports, terminal: f.options.terminal,
    stdinLine: async () => "", stdout() {}, stderr: text => output.push(text),
    installerOptions: { accountsPolicy: accountPolicy, systemPaths: f.systemPaths, webPort: 4383 },
  }), /updater_confirm_words_refused/u);
  assert.equal(f.ports.users.length, 0);
  assert.match(output.join(""), /The attempted install was undone\..*Do not retry/u);
});

test("rehearsal evidence appends recover a torn tail and refuse corrupt middle lines", async t => {
  for (const tail of ['{"torn"', '{"torn"\n', '{"complete":true}']) {
    let injected = false;
    const f = await fixture(t, "rehearsal-torn-evidence", { rpId: "fixture-rehearsal.ts.net", afterJournalEntry: async record => {
      if (injected || record.action !== "transaction" || record.phase !== "planned") return;
      injected = true;
      await writeFile(join(f.root, "updater-state/e2e2-evidence.jsonl"), tail, { mode: 0o600 });
    } });
    const configPath = join(f.base, "rehearsal.json"), evidenceLog = join(f.base, "e2e2-evidence.jsonl");
    await rehearsalConfig(configPath, f.root);
    const result = await installControlRoomV1({ ...f.options, rehearsalConfig: configPath, freshDatabase: true,
      authenticator: "software", e2e2EvidenceLog: evidenceLog });
    assert.equal(result.state, "installed"); assert.equal(injected, true);
    const rows = (await readFile(evidenceLog, "utf8")).trimEnd().split("\n").map(JSON.parse);
    assert.ok(rows.length > 3); assert.ok(rows.every(row => row.schema === "control-room.e2e2-evidence/v1"));
  }
  for (const damaged of ['{"torn"\n{}\n', '{}\n', 'null\n']) {
    const f = await fixture(t, "rehearsal-corrupt-evidence", { rpId: "fixture-rehearsal.ts.net", afterJournalEntry: async record => {
      if (record.command === "install" && record.action === "transaction" && record.phase === "planned")
        await writeFile(join(f.root, "updater-state/e2e2-evidence.jsonl"), damaged, { mode: 0o600 });
    } });
    const configPath = join(f.base, "rehearsal.json"); await rehearsalConfig(configPath, f.root);
    await assert.rejects(installControlRoomV1({ ...f.options, rehearsalConfig: configPath, freshDatabase: true,
      authenticator: "software", e2e2EvidenceLog: join(f.base, "e2e2-evidence.jsonl") }), /rehearsal_evidence_refused/u);
  }
});
