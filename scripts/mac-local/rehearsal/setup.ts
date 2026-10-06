// Local rehearsal database: a throwaway PostgreSQL 17 cluster on 127.0.0.1 with the full
// migration ledger, the five Mac-local roles, and a protected root pointing at it.
// Never points at the VPS. Usage: pnpm mac:rehearsal up|down ABSOLUTE_DIR [--port 15499]
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { PgBoss, getConstructionPlans } from "pg-boss";
import { existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../../../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../../../deploy/postgres/evidence.mjs";
import { sha256Digest } from "../../../src/security/canonical-digest";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1, captureMacLocalProtectedConfigurationV1 } from "../../../src/web/v1/mac-local-protected-configuration";
import { captureMacLocalDatabaseRolesV1, MAC_LOCAL_DATABASE_ROLES_V1 } from "../../../src/web/v1/mac-local-database-roles";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../../../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../../../src/harness/v1/owner-trusted-local-enablements";
import { readPinnedMacExecutableVersion } from "../bot-executable-inspection.mjs";
import { ensureHealthProbeKeyV1 } from "../provision-database.mjs";
import { captureReleaseTrustV1, releaseKeyIdV1, RELEASE_TRUST_SCHEMA_V1 } from "../../release-signing.mjs";
// The shared disposable-cluster teardown. `.mjs` because
// `scripts/ops/verify-database-backup.mjs` imports it with bare `node`, and a
// `.ts` module could not be imported by one of its own callers.
import { createClusterTeardown } from "../../dev/postgres-cluster-lifecycle.mjs";
import { captureWorkIntakeClientConfigurationV1, captureWorkIntakeServerConfigurationV1,
  workIntakeClientFileNameV1, workIntakeIdentityIdV1,
  WORK_INTAKE_CLIENT_CONFIGURATION_V1, WORK_INTAKE_SERVER_CONFIGURATION_V1 } from
  "../../../src/work-intake/v1/installed-configuration";

const [action, dir] = process.argv.slice(2);
const portIndex = process.argv.indexOf("--port");
const port = portIndex === -1 ? 15499 : Number(process.argv[portIndex + 1]);
const webPortIndex = process.argv.indexOf("--web-port");
const webPort = webPortIndex === -1 ? 3217 : Number(process.argv[webPortIndex + 1]);
const soakOwned = process.argv.includes("--soak-owned");
if (soakOwned && !process.argv.includes("--fake-executables")) throw new Error("soak_requires_fake_executables");
let ownedPostgres: ReturnType<typeof spawn> | undefined;
let ownedPostgresClosed: Promise<void> | undefined;
let ownerGone = false;
if (soakOwned) {
  process.stdin.resume();
  process.stdin.once("end", () => { ownerGone = true; ownedPostgres?.kill("SIGQUIT"); });
}
const fakeExecutables = process.argv.includes("--fake-executables");
if (!["up", "down"].includes(action) || !dir || !isAbsolute(dir) || !Number.isInteger(port)
  || !Number.isInteger(webPort) || webPort < 1024 || webPort > 65534 || webPort === port || webPort + 1 === port) {
  console.error("usage: pnpm mac:rehearsal up|down ABSOLUTE_DIR [--port 15499] [--web-port 3217] [--fake-executables]");
  process.exit(2);
}
const locale = process.platform === "linux" ? "C.UTF-8" : "en_US.UTF-8";
const env = { ...process.env, LC_ALL: process.env.LC_ALL || locale, LANG: process.env.LANG || locale };
const pgBin = process.env.PG_BIN;
if (pgBin !== undefined && (!isAbsolute(pgBin) || resolve(pgBin) !== pgBin)) {
  throw new Error("rehearsal_pg_bin_must_be_absolute");
}
const pgExecutable = (name: string) => pgBin ? join(pgBin, name) : name;
const pg = join(dir, "pg");
const bounded = { env, stdio: "ignore" as const, timeout: 120_000, killSignal: "SIGKILL" as const };
const pgctl = (...args: string[]) => execFileSync(pgExecutable("pg_ctl"), ["-D", pg, ...args], bounded);

// The shared teardown, created BEFORE initdb. That ordering is the fix.
//
// This script's own signal handlers ran `pg_ctl stop -m fast` with the error
// SWALLOWED, and its `exit` hook had the same shape. Two consequences on a
// machine with 32 SysV shared-memory segments in total, one per postmaster:
// a `pg_ctl` that failed left a live postmaster holding its 56-byte segment
// with a dead creator, and a start that forked and then failed left one too,
// because `clusterStarted` was only set AFTER `pg_ctl start` returned. The
// shared teardown registers first, asks for the stop in the order that
// RELEASES the segment, and refuses to report success when the postmaster
// survives.
//
// `keepCluster` is honoured here rather than inside the teardown: this
// rehearsal intentionally leaves a running cluster for the owner's browser
// session, and the teardown is released rather than stopped in that case.
const teardown = createClusterTeardown({ dataDirectory: pg, runDirectory: dir, port, pgBin,
  removeDirectories: false });
let clusterStarted = false;
let keepCluster = false;

function stopStartedCluster() {
  if (!clusterStarted) return;
  clusterStarted = false;
  // Not awaited: this is the synchronous teardown path (`process.on("exit")` and
  // a signal handler), and the teardown's own hook has already run the bounded
  // cooperative stop by the time this is reached. The rejection is the original
  // setup or signal failure, which must reach the caller.
  void teardown.stop().catch(() => { /* Preserve the original setup or signal failure. */ });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  keepCluster = false;
  stopStartedCluster();
  process.exit(signal === "SIGINT" ? 130 : 143);
});
process.once("exit", () => { if (!keepCluster) stopStartedCluster(); });

if (action === "down") {
  if (existsSync(pg)) {
    let running = false;
    try { pgctl("status"); running = true; }
    catch { /* An already-stopped disposable cluster is the requested state. */ }
    if (running) pgctl("stop", "-m", "fast");
  }
  console.log("rehearsal database stopped (data kept; delete the directory to discard)");
  process.exit(0);
}

const fresh = !existsSync(pg);
if (soakOwned && !fresh) throw new Error("soak_requires_fresh_cluster");
try {
  if (fresh) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync(pgExecutable("initdb"), ["-D", pg, "-U", "postgres", "--auth=trust", "-E", "UTF8"], bounded);
    writeFileSync(join(pg, ".control-room-disposable-postgres.json"), `${JSON.stringify({
      schema: "control-room.disposable-postgres/v1", createdBy: "mac-local-rehearsal",
    })}\n`, { mode: 0o600, flag: "wx" });
    writeFileSync(join(pg, "pg_hba.conf"), "host all postgres 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 scram-sha-256\n");
  }
  if (soakOwned) {
    if (ownerGone) throw new Error("soak_owner_gone");
    // Foreground postmaster inherits the setup child's process group. Never pg_ctl start.
    ownedPostgres = spawn(pgExecutable("postgres"), ["-D", pg, "-p", String(port), "-k", "",
      "-c", "listen_addresses=127.0.0.1"], { env, stdio: ["ignore", "ignore", "ignore"] });
    ownedPostgresClosed = new Promise<void>(done => ownedPostgres!.once("close", () => done()));
    let spawnFailed = false;
    ownedPostgres.once("error", () => { spawnFailed = true; });
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (ownerGone || spawnFailed || ownedPostgres.exitCode !== null || ownedPostgres.signalCode !== null)
        throw new Error("soak_postgres_start_failed");
      try { pgctl("status"); break; } catch { /* wait for this postmaster's PID */ }
      if (Date.now() > deadline) throw new Error("soak_postgres_start_timeout");
      await new Promise(done => setTimeout(done, 100));
    }
  } else pgctl("-l", join(dir, "pg.log"), "-w", "-o", `-p ${port} -k '' -c listen_addresses=127.0.0.1`, "start");
  clusterStarted = true;
  // Retained while the cluster is up, so a teardown reached from a signal or the
  // exit hook has a pid even when the rest of setup is about to throw.
  await teardown.capturePostmasterPid();
  if (!fresh) {
    keepCluster = true;
    // The cluster is deliberately handed to the owner's session, so the hooks
    // are disarmed. They were armed at startup anyway, which is what protects
    // the window before this point: a failure there still stops the cluster.
    teardown.release();
    console.log(`rehearsal database running on 127.0.0.1:${port}; protected root ${join(dir, "protected")}`);
    process.exit(0);
  }

if (soakOwned) {
  const identityClient = connectTarget(`host=127.0.0.1 port=${port} dbname=postgres user=postgres`);
  try {
    await identityClient.connect();
    const identity = (await identityClient.query("SELECT current_setting('data_directory') AS directory,current_user,current_setting('server_version_num')::int AS version")).rows[0];
    if (resolve(identity.directory) !== resolve(pg) || identity.current_user !== "postgres"
      || Math.floor(identity.version / 10000) !== 17) throw new Error("soak_database_identity_refused");
  } finally { await identityClient.end(); }
}
execFileSync(pgExecutable("psql"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "dbname=control_room",
  "-f", fileURLToPath(new URL("../../../deploy/postgres/provision-database.sql", import.meta.url))], bounded);
const pw = () => randomBytes(24).toString("base64url");
const secrets = { migrator: pw(), application: pw(), scheduler: pw(), workIntake: pw() };
const local: Record<string, string> = { control_room_web: pw(), control_room_coordinator: pw(),
  control_room_results: pw(), control_room_publisher: pw(), control_room_agent_reviewer_login: pw(),
  control_room_queue_worker: pw(), control_room_fleet: pw(), control_room_fleet_owner: pw() };
const bootstrapTarget = `host=127.0.0.1 port=${port} dbname=control_room user=postgres`;
await applyMigrations({ target: bootstrapTarget, rootDir: process.cwd(),
  ledgerPath: fileURLToPath(new URL("../../../deploy/postgres/migration-ledger.json", import.meta.url)),
  bootstrapTarget,
  migrateTarget: `host=127.0.0.1 port=${port} dbname=control_room user=control_room_migrator password=${secrets.migrator}`,
  env: { NODE_ENV: "test", CONTROL_ROOM_MIGRATOR_PASSWORD: secrets.migrator,
    CONTROL_ROOM_APP_PASSWORD: secrets.application, CONTROL_ROOM_SCHEDULER_PASSWORD: secrets.scheduler,
    CONTROL_ROOM_WORK_INTAKE_PASSWORD: secrets.workIntake } });
const psql = (database: string, file: string) => execFileSync(pgExecutable("psql"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", database,
  "-v", "ON_ERROR_STOP=1", "-f", fileURLToPath(new URL(file, import.meta.url))], bounded);
// Match the reviewed package-5 sequence against this fresh disposable cluster.
// applyMigrations installs the production roles as part of bootstrap; rerunning
// this idempotent file here makes the rehearsal's ordering explicit.
psql("control_room", "../../../db/roles/production_roles.sql");
// The fixed pg-boss schema/queue is installed offline before either queue role.
const queueClient = connectTarget(bootstrapTarget); await queueClient.connect();
try {
  await queueClient.query(getConstructionPlans("control_room_queue"));
  const boss = new PgBoss({ db: { executeSql: (sql, values) => queueClient.query(sql, values) },
    schema: "control_room_queue", backend: "postgres", migrate: false, createSchema: false,
    supervise: false, schedule: false, useListenNotify: false });
  await boss.start();
  try { await boss.createQueue("native-task-delivery", { retryLimit: 0 }); }
  finally { await boss.stop({ graceful: false }); }
} finally { await queueClient.end(); }
psql("control_room", "../../../db/roles/private_web_database.sql");
for (const file of ["private_web_roles.sql", "task_coordinator_roles.sql", "native_queue_producer_roles.sql",
  "native_results_roles.sql", "local_result_publisher_roles.sql", "native_queue_worker_roles.sql", "agent_reviewer_roles.sql",
  "fleet_gateway_roles.sql"])
  psql("control_room", `../../../db/roles/${file}`);
const membership = connectTarget(bootstrapTarget); await membership.connect();
try {
  const roleByLogin: Record<string, string> = { control_room_web: "control_room_private_web",
    control_room_coordinator: "control_room_task_coordinator", control_room_results: "control_room_native_results",
    control_room_publisher: "control_room_local_result_publisher",
    control_room_agent_reviewer_login: "control_room_agent_reviewer",
    control_room_queue_worker: "control_room_native_queue_worker",
    control_room_fleet: "control_room_fleet_gateway",
    control_room_fleet_owner: "control_room_fleet_owner_authority" };
  for (const [login, password] of Object.entries(local)) {
    await membership.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${membership.escapeLiteral(password)}`);
    await membership.query(`GRANT ${roleByLogin[login]} TO ${login}`);
  }
} finally { await membership.end(); }

let paths: Readonly<Record<"codex" | "claude-code" | "hermes", string>>;
if (fakeExecutables) {
  const fakeRoot = join(dir, "setup-fake-workers");
  mkdirSync(fakeRoot, { recursive: true, mode: 0o700 });
  paths = Object.freeze({ codex: join(fakeRoot, "codex"), "claude-code": join(fakeRoot, "claude"), hermes: join(fakeRoot, "hermes") });
  for (const [kind, path] of Object.entries(paths)) {
    writeFileSync(path, `#!/bin/sh\n[ "$1" = "--version" ] || exit 64\nprintf '%s\\n' '${kind} 1.0.0'\n`, { mode: 0o700, flag: "wx" });
    chmodSync(path, 0o700);
  }
} else {
  if (process.platform !== "darwin") throw new Error("rehearsal_real_executables_require_macos");
  const home = homedir(), claudeRoot = join(home, "Library/Application Support/Claude/claude-code");
  const claudeVersion = readdirSync(claudeRoot).filter(v => /^\d+\.\d+\.\d+$/u.test(v))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  const codexCandidates = ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex"];
  const codexPath = codexCandidates.find(path => existsSync(path));
  if (!codexPath) throw new Error("rehearsal_codex_executable_missing");
  paths = Object.freeze({ codex: codexPath,
    "claude-code": join(claudeRoot, claudeVersion ?? "missing", "claude.app/Contents/MacOS/claude"),
    hermes: join(home, ".hermes/hermes-agent/venv/bin/hermes") });
}
const workers = [];
for (const kind of ["codex", "claude-code", "hermes"] as const)
  workers.push({ workerId: `worker:${kind === "claude-code" ? "claude" : kind}:mac-1`, kind, executablePath: paths[kind],
    recordedVersion: await readPinnedMacExecutableVersion(paths[kind]) });

const root = join(dir, "protected"), config = join(root, "config");
mkdirSync(config, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700); chmodSync(config, 0o700);
const database = { host: "127.0.0.1", port, database: "control_room", username: "control_room_web", password: local.control_room_web, majorVersion: 17 };
const role = (username: string) => ({ ...database, username, password: local[username] });
const roles = { schema: MAC_LOCAL_DATABASE_ROLES_V1, web: role("control_room_web"), coordinator: role("control_room_coordinator"),
  results: role("control_room_results"), publisher: role("control_room_publisher"),
  agentReviewer: role("control_room_agent_reviewer_login"), queueWorker: role("control_room_queue_worker"),
  fleetGateway: role("control_room_fleet"), fleetOwner: role("control_room_fleet_owner") };
captureMacLocalDatabaseRolesV1(roles);
const ownerCode = pw() + pw();
const macLocal = { schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: webPort, workspaceId: "workspace:mac-local",
  localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: `http://127.0.0.1:${webPort}`, tenantId: "tenant:mac-local",
    provider: "local-owner", subject: "owner:local", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 28_800 },
  database, enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers },
  workIntakeProjectIds: ["*"] };
captureMacLocalProtectedConfigurationV1(JSON.parse(JSON.stringify(macLocal)));
const clients = workers.map(worker => ({ worker, client: captureWorkIntakeClientConfigurationV1({
  schema: WORK_INTAKE_CLIENT_CONFIGURATION_V1, origin: `http://127.0.0.1:${webPort + 1}`,
  bearerSecret: randomBytes(32).toString("base64url") }) }));
const credentialStart=new Date(),credentialEnd=new Date(credentialStart.getTime()+8*60*60*1000);
const workIntake = captureWorkIntakeServerConfigurationV1({ schema: WORK_INTAKE_SERVER_CONFIGURATION_V1,
  port: webPort + 1, database: { ...database, username: "control_room_work_intake_agent", password: secrets.workIntake },
  integrityKey: randomBytes(32).toString("base64url"), queueDepthLimit: 10,
  credentials: clients.map(({ worker, client }) => ({ workerId:worker.workerId,workerKind:worker.kind,
    credentialDigest: sha256Digest(client.bearerSecret),
    principal: { tenantId: "tenant:mac-local",
      identityId: workIntakeIdentityIdV1("tenant:mac-local",worker.workerId), actorType: "agent",
      authenticatedAt: credentialStart.toISOString(), expiresAt: credentialEnd.toISOString() } })) });
for (const [file, body] of [["mac-local.json", JSON.stringify(macLocal)], ["database-roles.json", JSON.stringify(roles)],
  ["work-intake-server.json", JSON.stringify(workIntake)], ["owner-sign-in.txt", ownerCode]])
  writeFileSync(join(config, file), `${body}\n`, { mode: 0o600 });
// The fleet connector release build (scripts/build-fleet-connector.mjs, driven by `pnpm mac:up`)
// and loadMacLocalFleetReleaseTrustV1 both require this file at the fixed path below; without it
// `mac:up` refuses at its "fleet connector release" step and the host never starts.
const { publicKey: fleetPublicKey, privateKey: fleetPrivateKey } = generateKeyPairSync("ed25519");
const fleetPublicKeyB64 = fleetPublicKey.export({ format: "der", type: "spki" }).toString("base64url");
const releaseTrust = captureReleaseTrustV1({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: 1,
  keyId: releaseKeyIdV1(fleetPublicKeyB64), publicKey: fleetPublicKeyB64, versionFloor: "0.0.1", revokedKeyIds: [] });
writeFileSync(join(config, "release-trust.json"), `${JSON.stringify(releaseTrust)}\n`, { mode: 0o600 });
// The installed Mac is connector-only: its bots are fleet connector workers and
// reach work only through the fleet gateway, which refuses to start without a
// SIGNED connector release. A real install signs one with its installation key
// (src/updater/v1/install/connector-release.mjs). The rehearsal keeps its own
// throwaway key OUTSIDE the protected root, so `sign-connector-release.ts` can
// do the same and the rehearsal runs the gateway the owner's Mac runs.
writeFileSync(join(dir, "rehearsal-release-signing.pem"),
  fleetPrivateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
// The independent host-readiness probe key. `mac:up` and the task host both
// refuse to start without it (loadHealthProbeKeyV1 in start-web-host.mjs), and
// until afc636354 only the VPS provisioner created it -- so a rehearsal root,
// and therefore the phone preview and any other `mac:rehearsal up` user, could
// never start a host. This rehearsal builds a complete protected root, so it
// must create the same key the provisioner does, through the provisioner's own
// function so the format, mode and EEXIST-preserves-identity behaviour cannot
// drift between the two paths.
const service = join(root, "service");
mkdirSync(service, { recursive: true, mode: 0o700 }); chmodSync(service, 0o700);
await ensureHealthProbeKeyV1(root);
const clientRoot=join(config,"work-intake-clients"); mkdirSync(clientRoot,{recursive:true,mode:0o700});
for(const {worker,client} of clients) writeFileSync(join(clientRoot,workIntakeClientFileNameV1(worker.workerId)),`${JSON.stringify(client)}\n`,{mode:0o600});
// An owner price table, present for every rehearsal run: this is the only
// end-to-end proof that the real production provider (mac-local-default-task-provider.ts)
// actually loads `usage-prices.json` and carries it through the full
// composition into the started host's own HTTP responses (Control Room #412
// review finding 3 -- the untested provider hop). Prices cover both the
// default and `--model-allowlists` journeys; unmatched entries are inert.
const usagePriceTable = { schema: "control-room.usage-price-table/v1", tableId: "rehearsal-usage-prices",
  recordedAt: "2026-01-01T00:00:00.000Z", entries: [
    { entryId: "rehearsal-hermes-default", harness: "hermes", model: "default",
      billing: { kind: "token", inputNanoUsdPerToken: "1000", outputNanoUsdPerToken: "2000" } },
    { entryId: "rehearsal-claude-default", harness: "claude", model: "default",
      billing: { kind: "token", inputNanoUsdPerToken: "1000", outputNanoUsdPerToken: "2000" } },
    { entryId: "rehearsal-codex-default", harness: "codex", model: "default",
      billing: { kind: "token", inputNanoUsdPerToken: "1000", outputNanoUsdPerToken: "2000" } },
    { entryId: "rehearsal-hermes-allowlist", harness: "hermes", model: "model-rehearsal",
      billing: { kind: "token", inputNanoUsdPerToken: "1000", outputNanoUsdPerToken: "2000" } },
    { entryId: "rehearsal-claude-allowlist", harness: "claude", model: "sonnet-rehearsal",
      billing: { kind: "token", inputNanoUsdPerToken: "1000", outputNanoUsdPerToken: "2000" } },
    { entryId: "rehearsal-codex-allowlist", harness: "codex", model: "gpt-rehearsal",
      billing: { kind: "token", inputNanoUsdPerToken: "1000", outputNanoUsdPerToken: "2000" } },
  ] };
writeFileSync(join(root, "usage-prices.json"), `${JSON.stringify(usagePriceTable)}\n`, { mode: 0o600 });
console.log(`rehearsal database ready on 127.0.0.1:${port}; protected root ${root}`);
console.log(`next: pnpm mac:bootstrap-owner ${root} && pnpm mac:check-database ${root}`);
  if (soakOwned) {
    if (ownerGone) throw new Error("soak_owner_gone");
    console.log("SOAK_SETUP_READY");
    await new Promise<void>(done => {
      process.stdin.once("end", done);
      ownedPostgres!.once("exit", () => { ownerGone = true; done(); });
    });
    if (!ownerGone) throw new Error("soak_owner_gone");
  } else keepCluster = true;
  // Deliberate hand-off, as above: the hooks are disarmed so a later Ctrl-C in
  // the owner's shell does not stop a database the rehearsal was asked to leave
  // running. `pnpm mac:rehearsal down` is what stops it.
  if (!soakOwned) teardown.release();
} finally {
  if (!keepCluster && !soakOwned) stopStartedCluster();
  if (soakOwned) {
    await teardown.stop();
    await ownedPostgresClosed;
  }
}
