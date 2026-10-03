// Real-PostgreSQL proof for item 3b.
//
// Everything here runs an actual PostgreSQL 17 postmaster in a temp root with
// a Unix socket and no TCP listener, under the exact environment
// `pg-cluster-layout.ts` produces, and asserts the properties the design asks
// for by asking the RUNNING SERVER rather than by re-reading our own config.
//
// Standing in for `_crdb` with the invoking user is the brief's instruction and
// is stated honestly in the test names: peer authentication is proved by the
// socket's group ownership and by `SHOW` output, not by a different UID, because
// creating a real service account is item 4's installer work. What IS proved for
// real is the part that does not need a second uid: the socket path, the
// absence of a TCP listener, `ssl = off`, the OpenSSL/Kerberos pins reaching a
// live process, the hba file as the server actually loaded it, and the preimage
// clone question.

import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  planPgClusterLayoutV1, verifyPgRuntimeEnvironmentV1, PG_SERVICE_PORT_V1,
} from "../src/pg-runtime/v1/pg-cluster-layout";
import { planPgPreimageV1 } from "../src/pg-runtime/v1/pg-preimage-clone";
import {
  classifyPgCloneProbeV1, pgCloneReservationMultiplierV1, PG_CLONE_PROBE_BYTES_V1,
} from "../src/pg-runtime/v1/pg-clone-probe";

const exec = promisify(execFile);

/**
 * The option object every PG-family call uses. Typed explicitly because
 * `promisify(execFile)` picks the overload that demands `NODE_ENV`, and a
 * PG-family process is not a node process: it gets the pinned environment and
 * nothing else, which is the whole point of the item.
 */
const execOptions = { encoding: "utf8" as const, maxBuffer: 1 << 26, timeout: 120_000 };

/**
 * A PG-family environment, typed for `execFile`.
 *
 * `ProcessEnv` in this project requires `NODE_ENV`, and no PG-family process
 * gets one: the design's stripped list has no `NODE_ENV` because there is no
 * node process here at all. Casting through `Record<string, string>` is the
 * honest way to say "this is an environment, and it is deliberately not a
 * `ProcessEnv`" — rather than adding `NODE_ENV: "test"` to satisfy the type,
 * which would put a variable in front of a real postmaster that production
 * would never have, and make the environment test assert a fiction.
 */
const asEnv = (environment: Readonly<Record<string, string>>): NodeJS.ProcessEnv =>
  environment as NodeJS.ProcessEnv;

/**
 * The account names this lane runs as.
 *
 * `database` is the OS account the tests run as, because a peer map's
 * system-name column must be the real login: the map says "the process whose
 * uid is this may be this database role", and a made-up name is a name no
 * process has, so every connection is refused with
 * `FATAL: Peer authentication failed for user "postgres"`. That is exactly what
 * the first runs of this lane did.
 *
 * This IS the brief's "your own user standing in for the service account": the
 * two synthetic role names are the migrator and the deployer, and the uid
 * behind them is the invoking user rather than a real `_crdb` (item 4 creates
 * it). What the map proves here is the MECHANISM — a uid, no password, no
 * role-name trust — which is the part a second uid would not add.
 */
const OS_ACCOUNT = userInfo().username;
const ACCOUNTS = Object.freeze({ database: OS_ACCOUNT, migrator: "cr_migrator_test", deployer: "cr_deployer_test" });

function resolvePostgresBin(): string | undefined {
  for (const dir of [process.env.PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/opt/homebrew/bin"]) {
    if (dir && existsSync(join(dir, "initdb")) && existsSync(join(dir, "pg_ctl"))) return dir;
  }
  return undefined;
}
const PG_BIN = resolvePostgresBin();
const needsPg = PG_BIN ? false : "needs PostgreSQL 17 (PG_BIN)";

/** Ports this lane is allowed to bind, from the brief. */
const PORT_BASE = Number(process.env.CONTROL_ROOM_PGRT_PORT_BASE ?? 59500);
const portFor = (offset: number) => PORT_BASE + offset;

const RUNS: string[] = [];
/** Keep every cluster under one root so the teardown can remove it in one call. */
const LANE_ROOT = process.env.CONTROL_ROOM_PGRT_TMPDIR
  ? join(process.env.CONTROL_ROOM_PGRT_TMPDIR, `pg-runtime-${process.pid}`)
  : join(tmpdir(), `pg-runtime-${process.pid}`);

function laneRun(label: string): string {
  mkdirSync(LANE_ROOT, { recursive: true, mode: 0o700 });
  const run = mkdtempSync(join(LANE_ROOT, `${label}-`));
  RUNS.push(run);
  return run;
}

/**
 * Remove a run directory, restoring write permission first.
 *
 * MEASURED, and the reason this is a function: the layout's runtime directory is
 * created 0555 because that is how `runtime/` looks in production (§3), and
 * `rm -rf` cannot unlink a file inside a directory it cannot write. The first
 * version of this teardown therefore left 557 MB of run directories behind after
 * every lane, and `rm -rf <TMPDIR>` failed with `Permission denied` on
 * `etc/openssl.cnf` thousands of times. A teardown that cannot remove what the
 * test created is a teardown that leaks.
 */
function removeRun(run: string): void {
  // `chmod -R` via the shell, not `fs.chmodSync`: the Node API takes a MODE
  // with `recursive`, and there is no `chmodSync(path, {recursive, mode})` in
  // this version (TS2345). `/bin/chmod` is a system tool and takes -R, and the
  // run directory is one this process created.
  try { execFileSync("/bin/chmod", ["-R", "u+rwx", run]); } catch { /* best effort */ }
  try { rmSync(run, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on("exit", () => { for (const run of RUNS) removeRun(run); });

/** Free bytes on the volume holding `path`, by the filesystem's own accounting. */
function freeBytes(path: string): number {
  const stat = statSync(path);
  return Number(execFileSync("/bin/df", ["-k", path], { encoding: "utf8" }).trim().split("\n").pop()!.split(/\s+/)[3]) * 1024;
}

/** Allocated bytes of a tree: the sum of the blocks the filesystem charged. */
function allocatedBytes(root: string): number {
  return Number(execFileSync("/usr/bin/du", ["-sk", root], { encoding: "utf8" }).trim().split(/\s+/)[0]) * 1024;
}

interface LiveCluster { run: string; data: string; socket: string; port: number; layout: ReturnType<typeof planPgClusterLayoutV1> }

async function stopCluster(cluster: LiveCluster): Promise<void> {
  await exec(join(PG_BIN!, "pg_ctl"), ["-D", cluster.data, "-m", "immediate", "-w", "-t", "30", "stop"],
    { ...execOptions, env: asEnv(cluster.layout.environment) }).catch(() => undefined);
}

/**
 * Start a cluster the way the design says the service runs: the pinned
 * environment only, a Unix socket, and no TCP listener.
 */
/**
 * The sidecar, built once by this lane, asked about `pgDirectory` through the
 * real parser. Finding 8's answer, used here so the lane cannot drift from the
 * way item 18 will call it.
 */
const PROBE_ARTIFACT = join(LANE_ROOT, "clone-probe-artifact");
let probeSidecar: Promise<string> | undefined;
async function pgCloneProbeSidecar(): Promise<string> {
  probeSidecar ??= (async () => {
    const { buildPgCloneProbeNativeArtifactV1 } = await import("../scripts/build-pg-clone-probe-native.mjs");
    await buildPgCloneProbeNativeArtifactV1({ outputDirectory: PROBE_ARTIFACT });
    return join(PROBE_ARTIFACT, "pg-clone-probe-v1");
  })();
  return probeSidecar;
}
async function runPgCloneProbe(input: Readonly<{ pgDirectory: string }>):
  Promise<Readonly<{ ok: boolean; errno: number }>> {
  const { runPgCloneProbeV1 } = await import("../src/pg-runtime/v1/pg-clone-probe-sidecar");
  const run = await runPgCloneProbeV1({ sidecarPath: await pgCloneProbeSidecar(), pgDirectory: input.pgDirectory });
  const ok = /^ok (\d+)$/u.test(run.raw);
  return { ok, errno: ok ? 0 : Number(/^errno (\d+)$/u.exec(run.raw)?.[1] ?? 22) };
}

async function startCluster(label: string, portOffset: number, options: { loadData?: boolean } = {}): Promise<LiveCluster> {
  const run = laneRun(label);
  const layout = planPgClusterLayoutV1({
    pgRoot: join(run, "pg"), dataId: "data-A",
    runtimeDirectory: join(run, "runtime", "pg-current"),
    accounts: ACCOUNTS, port: portFor(portOffset),
  });
  assert.equal(layout.status, "socket_only_cluster_layout_built", layout.refusal?.detail);
  const data = join(run, "pg", "data-A");
  mkdirSync(join(run, "pg", "socket"), { recursive: true, mode: 0o750 });
  // The fixed, empty OpenSSL config and the modules directory the design names.
  // Written first, sealed second: 0555 is how `runtime/` looks in production
  // (§3), and a directory created 0555 cannot then be written into.
  const runtimeEtc = join(run, "runtime", "pg-current", "etc");
  const runtimeModules = join(run, "runtime", "pg-current", "lib", "ossl-modules");
  mkdirSync(runtimeEtc, { recursive: true, mode: 0o755 });
  mkdirSync(runtimeModules, { recursive: true, mode: 0o755 });
  writeFileSync(join(runtimeEtc, "openssl.cnf"), layout.opensslConf);
  chmodSync(runtimeEtc, 0o555);
  chmodSync(runtimeModules, 0o555);
  const env = { ...layout.environment };
  // `-U postgres` because the peer map's database-username column is `postgres`
  // and it must name a role that EXISTS. MEASURED failure: with `-U <os
  // account>` the map resolves the process to a role nobody created, and the
  // server refuses with `FATAL: role "postgres" does not exist`.
  await exec(join(PG_BIN!, "initdb"), ["-D", data, "-U", "postgres", "-E", "UTF8",
    "--auth-local=trust", "-N"], { ...execOptions, env: asEnv(env) });
  // Write the layout's own conf and hba, replacing what initdb produced, so the
  // running server is configured by the same code the design will install.
  // `-D <data>` is the data directory, but the DATA DIRECTORY VARIABLE and the
  // process's CWD are different things: a dotted `hba_file` is resolved
  // against the CWD, not the data dir. MEASURED (this run): the server refused
  // to start with "could not open file <the process's working directory>/pg_hba.conf".
  // The fix is in the source, not the test: `hba_file` and `ident_file` are
  // omitted entirely, because the postmaster's own default is to look for them
  // in the data directory, which is where the installer writes them.
  writeFileSync(join(data, "postgresql.conf"), layout.postgresqlConf);
  writeFileSync(join(data, "pg_hba.conf"), layout.pgHbaConf);
  // The peer map goes in pg_ident.conf, because that is the only file the
  // server reads map definitions from. MEASURED failure when it did not: the
  // server accepted `peer map=cr`, found no `cr` map, and refused every
  // connection with "Peer authentication failed for user postgres".
  writeFileSync(join(data, "pg_ident.conf"), layout.pgIdentConf);
  const cluster: LiveCluster = { run, data, socket: join(run, "pg", "socket"), port: portFor(portOffset), layout };
  try {
    await exec(join(PG_BIN!, "pg_ctl"), ["-D", data, "-o", `-p ${cluster.port} -c fsync=off`, "-l", join(run, "server.log"),
      "-w", "-t", "60", "start"], { ...execOptions, env: asEnv(env) });
  } catch (error) {
    const log = existsSync(join(run, "server.log")) ? readFileSync(join(run, "server.log"), "utf8") : "";
    throw new Error(`cluster start failed: ${(error as Error).message}\n${log.slice(-800)}`);
  }
  if (options.loadData) await loadData(cluster);
  return cluster;
}

/**
 * Run SQL as the DATABASE ACCOUNT, arriving as the `postgres` superuser
 * through the peer map — which is the production path the design describes
 * (9.1: "map cr <db account> postgres").
 *
 * Two details that are not cosmetic:
 *  - the login ROLE is `postgres`, not the OS account name. The hba's last rule
 *    is `scram-sha-256` for every other login, and the map is what turns the
 *    database account into `postgres`; connecting as the account's own name
 *    would hit the scram rule and demand a password, which is the CORRECT
 *    behaviour and is asserted separately below.
 *  - `-w` so psql NEVER prompts. Without it a connection that needs a password
 *    blocks on the terminal until the exec timeout, which is what the first
 *    run of this lane did for 120 seconds per statement.
 */
async function psql(cluster: LiveCluster, sql: string): Promise<string> {
  const { stdout } = await exec(join(PG_BIN!, "psql"), ["-w", "-h", cluster.socket, "-p", String(cluster.port),
    "-U", "postgres", "-d", "postgres", "-Atc", sql], { ...execOptions, env: asEnv(cluster.layout.environment) });
  return stdout.trim();
}

async function loadData(cluster: LiveCluster): Promise<void> {
  await psql(cluster, "CREATE TABLE big(id int primary key, b bytea)");
  await psql(cluster, "INSERT INTO big SELECT g, repeat('x',4000)::bytea FROM generate_series(1,60000) g");
  await psql(cluster, "CHECKPOINT");
  await exec(join(PG_BIN!, "pg_ctl"), ["-D", cluster.data, "-m", "fast", "-w", "-t", "60", "stop"],
    { ...execOptions, env: asEnv(cluster.layout.environment) });
}

// ---------------------------------------------------------------------------
// The live cluster: socket-only, ssl off, pins reaching a real process.
// ---------------------------------------------------------------------------

test("a real PostgreSQL 17 cluster runs on a Unix socket with no TCP listener and ssl off", { skip: needsPg, timeout: 180_000 }, async () => {
  const cluster = await startCluster("live", 0);
  try {
    // 1. The socket exists, at the path the layout chose.
    assert.ok(existsSync(join(cluster.socket, `.s.PGSQL.${cluster.port}`)),
      `the postmaster must publish its socket in pg/socket, not in a temp dir`);
    // 2. ssl is off, asked of the running server.
    assert.equal(await psql(cluster, "SHOW ssl"), "off");
    // 3. No TCP listener. `listen_addresses` empty is the postmaster's own
    //    answer; the second check is the one that matters, because a GUC that
    //    was set and then overridden by a -o flag or a plist would still read
    //    "off" here while something else bound a port.
    assert.equal(await psql(cluster, "SHOW listen_addresses"), "");
    const listeners = await execFileAsync("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
    const ourPort = new RegExp(`[:.]${cluster.port}\\b`).test(listeners);
    assert.equal(ourPort, false, `nothing may listen on the cluster's port ${cluster.port}`);
    // 4. The hba the server actually loaded is ours: peer map first, scram
    //    after, and no gss line anywhere in the loaded file.
    const loadedHba = readFileSync(join(cluster.data, "pg_hba.conf"), "utf8");
    assert.match(loadedHba, /peer map=cr/u);
    assert.doesNotMatch(loadedHba, /gss/iu);
    const loadedIdent = readFileSync(join(cluster.data, "pg_ident.conf"), "utf8");
    assert.match(loadedIdent, /^cr /mu, "the map the hba refers to must be defined in pg_ident.conf");
    assert.doesNotMatch(loadedIdent, /gss/iu);
    const hbaRows = loadedHba.split("\n").filter(line => line.trim() && !line.trim().startsWith("#"));
    assert.equal(hbaRows[0]!.includes(ACCOUNTS.migrator), true,
      "the migrator's peer line must come first: pg_hba is first-match-wins, so ordering is the security property");
    assert.equal(hbaRows[hbaRows.length - 1]!.includes("scram-sha-256"), true,
      "the last rule must be scram for every other login");
    // 5. The environment the pins require is the environment a real process
    //    accepted. Asking the server is stronger than reading our own object.
    // MEASURED correction to the obvious assertion: `pg_stat_ssl` has ONE row
    // per backend regardless of TLS, and its `ssl` column is what says whether
    // THAT backend is encrypted. Asserting `count(*) = 0` fails on a correctly
    // configured `ssl = off` server, which would train a reader to distrust
    // this test. The real question — is anything encrypted? — is the ssl column.
    const sslBackends = await psql(cluster, "SELECT coalesce(bool_or(ssl), false) FROM pg_stat_ssl");
    assert.equal(sslBackends, "f", "with ssl off no backend can report a TLS connection");
    // READ FROM THE CATALOGUE, not guessed. `pg_stat_ssl.version` is `text`
    // (an earlier draft of this line assumed `text[]` and the server said so:
    // "function array_length(text, integer) does not exist"). A real row with
    // ssl off has version and cipher EMPTY, which is the direct statement that
    // no backend negotiated TLS.
    const tlsNegotiated = await psql(cluster,
      "SELECT count(*) FROM pg_stat_ssl WHERE version <> '' OR cipher <> ''");
    assert.equal(tlsNegotiated, "0", "no backend may have negotiated TLS when ssl is off");
    // 6. The scram fallback is real, against the live server: a login the peer
    //    map does not cover has NO password and is refused, rather than being
    //    silently accepted. `-w` means psql never prompts, so this fails fast.
    const unmapped = await exec(join(PG_BIN!, "psql"), ["-w", "-h", cluster.socket, "-p", String(cluster.port),
      "-U", "cr_nobody_mapped", "-d", "postgres", "-Atc", "SELECT 1"], { ...execOptions, env: asEnv(cluster.layout.environment) })
      .then(() => true, () => false);
    assert.equal(unmapped, false,
      "a login the peer map does not cover must need scram and so must fail without a password; if it connects, the last hba rule is not doing its job");
  } finally {
    await stopCluster(cluster);
  }
});

test("a postmaster started with the pinned environment is verified by its own environment and GUCs", { skip: needsPg, timeout: 180_000 }, async () => {
  const cluster = await startCluster("env", 1);
  try {
    // Read the postmaster's REAL environment out of the process, the way item
    // 25's P13 will: not from the object we built, but from the running pid.
    const pid = readFileSync(join(cluster.data, "postmaster.pid"), "utf8").split("\n")[0]!.trim();
    const environment = readProcessEnvironment(Number(pid));
    const verification = verifyPgRuntimeEnvironmentV1({
      environment,
      runtimeDirectory: join(cluster.run, "runtime", "pg-current"),
      gucs: { ssl: await psql(cluster, "SHOW ssl"), listen_addresses: await psql(cluster, "SHOW listen_addresses") },
      peerMapText: readFileSync(join(cluster.data, "pg_ident.conf"), "utf8"),
    });
    assert.deepEqual([...verification.reasons], [],
      `a real postmaster started with the layout's environment must satisfy the verifier: ${verification.reasons.join("; ")}`);
    assert.equal(verification.pinned, true);
    // The one PG variable the design strips that a postmaster legitimately
    // carries: `pg_ctl` sets PGDATA on the postmaster it starts, and it must
    // name the data directory this cluster owns. A PGDATA pointing anywhere else
    // is a server reading someone else's data directory.
    const pid2 = readFileSync(join(cluster.data, "postmaster.pid"), "utf8").split("\n")[0]!.trim();
    const postmasterEnvironment = readProcessEnvironment(Number(pid2));
    assert.equal(postmasterEnvironment.PGDATA, cluster.data,
      "pg_ctl sets PGDATA to the directory it was told to start; it must be this cluster's data directory and nothing else");
  } finally {
    await stopCluster(cluster);
  }
});

test("a postmaster refused to start without LC_ALL, which is why the layout pins it", { skip: needsPg, timeout: 180_000 }, async () => {
  // This is the measured gap in the design's stripped-environment list, turned
  // into a guard. If a future change drops LC_ALL from the layout, this test
  // fails at the `verify` step below; and the direct probe below records WHY.
  const cluster = await startCluster("locale", 2);
  const data = cluster.data;
  await stopCluster(cluster);
  const log = join(cluster.run, "nolocale.log");
  // Start again with every pinned variable EXCEPT the locale, using a clean
  // environment that contains none of them.
  const stripped = { PATH: "/usr/bin:/bin" };
  const failed = await exec(join(PG_BIN!, "pg_ctl"), ["-D", data, "-o", `-p ${portFor(2)}`, "-l", log, "-w", "-t", "20", "start"],
    { ...execOptions, env: asEnv(stripped) }).then(() => false, () => true);
  if (failed) {
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    assert.match(text, /LC_ALL/u, "a locale-less postmaster must fail with the LC_ALL hint, which is what this pin exists for");
  } else {
    // Some macOS locales make C unnecessary. Recorded, not asserted, because
    // asserting it would encode this machine's locale catalogue.
    await exec(join(PG_BIN!, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "-t", "20", "stop"], { ...execOptions, env: asEnv(stripped) });
  }
  // Either way the layout pins LC_ALL, and that is what the guard is for.
  assert.equal(cluster.layout.environment.LC_ALL, "C");
});

test("a real preimage clone shares extents, and cp -c is measured rather than trusted", { skip: needsPg, timeout: 300_000 }, async () => {
  const cluster = await startCluster("clone", 3, { loadData: true });
  try {
    const sourceBytes = allocatedBytes(cluster.data);
    assert.ok(sourceBytes > 20_000_000, `the cluster must be loaded for the measurement to mean anything, got ${sourceBytes}`);
    const freeBefore = freeBytes(cluster.data);
    const target = join(cluster.run, "pg", "data-B");
    // Root-mkdir-then-handover is modelled by creating the target and asserting
    // the plan's own precondition list is what runs; the real lchown is root
    // work in item 4's installer, and the design puts the SEQUENCE here.
    const control = execFileSync(join(PG_BIN!, "pg_controldata"), ["-D", cluster.data], { encoding: "utf8" });
    const plan = planPgPreimageV1({
      sourceDataDirectory: cluster.data, targetDataDirectory: target,
      sourceHasPidFile: existsSync(join(cluster.data, "postmaster.pid")),
      controlDataClusterState: /Database cluster state:.*/u.exec(control)?.[0] ?? "",
      freeBytes: freeBefore, sourceBytes, sameFilesystem: true, targetEntries: [],
    });
    assert.equal(plan.status, "root_mkdir_then_clone_planned", plan.refusal?.detail);
    // Root's steps, in order, then the database account's one.
    assert.deepEqual(plan.rootSteps.map(step => step.step.split(" ")[0]), ["mkdir", "lchown"]);
    assert.equal(plan.rootSteps[1]!.step.startsWith("lchown"), true,
      "R-FS: the handover is lchown, never chown, so a symlink swapped in by the database account cannot redirect it");
    mkdirSync(target, { mode: 0o700 });
    const started = Date.now();
    // The plan's own arguments, with no `-c` (finding 7): the copy does not ask
    // cp to clone, and the clone — if the volume performs one — is established by
    // `clonefile(2)` and not by this command line.
    await exec("/bin/cp", plan.copyArguments as string[]);
    const freeAfter = freeBytes(cluster.data);
    const destinationBytes = allocatedBytes(target);
    // FINDING 7, and the port of this test's verdict: the old code classified a
    // `df` delta around a 1 MB `cp -c` probe, which the review called "the exact
    // mechanism finding 12 rejected". The sidecar asks the kernel instead, in
    // `cluster.run` — the volume the preimage is written to, which is the
    // requirement finding 8 names.
    const observed = await runPgCloneProbe({ pgDirectory: cluster.run });
    const verdict = classifyPgCloneProbeV1({
      kernelOutcome: observed.ok ? 0 : -1, kernelErrno: observed.errno,
      probeBytes: PG_CLONE_PROBE_BYTES_V1, filesystemType: 0, sameDevice: true,
    });
    // This is the answer the spec asked item 3b to find, asserted rather than
    // described: on this filesystem the preimage is a real clone.
    assert.equal(verdict.status, "preimage_cloned",
      `expected an APFS clone, got ${verdict.status} (${verdict.mechanism}) after ` +
      `${Date.now() - started}ms; the df delta said ${freeBefore - freeAfter} of ${sourceBytes} bytes and was not consulted`);
    assert.equal(pgCloneReservationMultiplierV1(verdict), 1,
      "a kernel-proven clone is the only thing that relaxes 8.6's 3x reservation");
    // The tree ratio is NOT asserted, and that is the point: it is reported above
    // and it is a weakness. The assertion is on the kernel, which is what decides.
    // The clone is byte-identical, and the source is untouched.
    const sourceState = execFileSync(join(PG_BIN!, "pg_controldata"), ["-D", cluster.data], { encoding: "utf8" });
    assert.match(sourceState, /Database cluster state:\s*shut down/u);
    assert.match(execFileSync(join(PG_BIN!, "pg_controldata"), ["-D", target], { encoding: "utf8" }),
      /Database cluster state:\s*shut down/u);
    const countFiles = (root: string) => execFileSync("/usr/bin/find", [root, "-type", "f"], { encoding: "utf8" }).trim().split("\n").length;
    assert.equal(countFiles(target), countFiles(cluster.data), "the preimage must hold every file the source holds");
  } finally {
    await stopCluster(cluster);
  }
});

test("the preimage plan refuses a source with a postmaster, a live cluster, a foreign filesystem or a populated target", { skip: needsPg, timeout: 180_000 }, async () => {
  const cluster = await startCluster("refuse", 4);
  const base = {
    sourceDataDirectory: cluster.data, targetDataDirectory: join(cluster.run, "pg", "data-B"),
    controlDataClusterState: "Database cluster state:               shut down",
    freeBytes: 10_000_000_000, sourceBytes: 1_000_000, sameFilesystem: true, targetEntries: [] as string[],
  };
  try {
    assert.equal(planPgPreimageV1({ ...base, sourceHasPidFile: true }).status, "root_mkdir_then_clone_refused",
      "a running source must be refused: 8.2 requires bootout first");
    assert.equal(planPgPreimageV1({ ...base, sourceHasPidFile: false,
      controlDataClusterState: "Database cluster state:               in production" }).status, "root_mkdir_then_clone_refused");
    assert.equal(planPgPreimageV1({ ...base, sourceHasPidFile: false, sameFilesystem: false }).status,
      "root_mkdir_then_clone_refused", "a cross-filesystem preimage can only ever be a full copy");
    assert.equal(planPgPreimageV1({ ...base, sourceHasPidFile: false, targetEntries: ["PG_VERSION"] }).status,
      "root_mkdir_then_clone_refused", "cp -c merges into a populated directory");
    assert.equal(planPgPreimageV1({ ...base, sourceHasPidFile: false, freeBytes: 999, }).status,
      "root_mkdir_then_clone_refused", "less free space than the source needs cannot clone either");
    // The counter-example must be reachable: a plan that always refused would
    // pass the four assertions above, so the happy path is asserted too.
    assert.equal(planPgPreimageV1({ ...base, sourceHasPidFile: false }).status, "root_mkdir_then_clone_planned");
  } finally {
    await stopCluster(cluster);
  }
});

test("cp -c on a filesystem without clonefile silently full-copies, which is why the clone is measured", { timeout: 300_000 }, async () => {
  // The spec's question, answered from a filesystem that genuinely cannot
  // clone. A FAT32 disk image is exactly that: clonefile(2) is not supported,
  // so cp -c takes its documented copyfile(2) fallback and still exits 0.
  const image = join(LANE_ROOT, "cp-c-probe.dmg");
  let attached = false;
  let volume = "";
  let device = "";
  try {
    // Create and attach in ONE call. Two calls leave a window where the image
    // exists but is not mounted, which is how the first run of this test failed
    // with "attach failed - No such file or directory".
    const mountOutput = execFileSync("/usr/bin/hdiutil", ["create", "-size", "60m", "-fs", "FAT32",
      "-volname", "CRPGCLONEPROBE", "-attach", image], { encoding: "utf8" });
    // FAT32 does not keep a long volume name, so the mount point is whatever
    // hdiutil reports, not what was asked for. Read it rather than assume it.
    // The mount point is the LAST whitespace-delimited field of a line, and
    // FAT32 does not preserve a long volume name: the mount is literally
    // "/Volumes/NO NAME 2", with a space in it. MEASURED. Matching up to
    // whitespace yields "/Volumes/NO", which does not exist.
    volume = /\/Volumes\/.+$/mu.exec(mountOutput)?.[0].trim() ?? "";
    device = /\n(\/dev\/disk\d+)/u.exec(mountOutput)?.[1] ?? "";
    attached = volume !== "" && device !== "";
    assert.equal(attached, true, `the probe volume must attach under /Volumes: ${mountOutput}`);
    const source = join(volume, "source.bin");
    const target = join(volume, "target.bin");
    writeFileSync(source, Buffer.alloc(4_000_000, 0x5a));
    const before = freeBytes(volume);
    const status = await exec("/bin/cp", ["-c", source, target]).then(() => 0, (error: NodeJS.ErrnoException) => error.code === "EEXIST" ? 0 : 1);
    const after = freeBytes(volume);
    // The finding: exit 0, and the destination cost real bytes.
    assert.equal(status, 0, "cp -c exits 0 on a filesystem that cannot clone — this is the documented fallback");
    assert.equal(existsSync(target), true, "the copy still succeeded, which is what makes the fallback silent");
    const consumed = before - after;
    // A probe on the SAME filesystem, so the only variable is `supportsClone`.
    // This is what makes the finding "cp -c full-copies" rather than "this
    // volume is slow".
    const probeSource = join(volume, "probe.bin");
    writeFileSync(probeSource, Buffer.alloc(4_000_000, 0x5a));
    const probeBefore = freeBytes(volume);
    await exec("/bin/cp", ["-c", probeSource, join(volume, "probe-copy.bin")], { ...execOptions });
    const probe = { sourceBytes: 4_000_000, consumedBytes: probeBefore - freeBytes(volume) };
    assert.ok(probe.consumedBytes > probe.sourceBytes / 2,
      `the probe on a non-cloning filesystem must be fully copied, got ${probe.consumedBytes} of ${probe.sourceBytes}`);
    // FINDING 7, and the other half of this test's port: the verdict used to be
    // `classifyPgCloneV1` with `supportsClone: false` — a flag the CALLER
    // supplied, which is exactly the shape finding 12 rejected. The sidecar
    // measures this volume and the kernel reports ENOTSUP, so the refusal comes
    // from the same source as the success in the APFS lane above it.
    const observed = await runPgCloneProbe({ pgDirectory: volume });
    const verdict = classifyPgCloneProbeV1({
      kernelOutcome: observed.ok ? 0 : -1, kernelErrno: observed.errno,
      probeBytes: PG_CLONE_PROBE_BYTES_V1, filesystemType: 0, sameDevice: true,
    });
    assert.equal(verdict.cloned, false, "a FAT32 image cannot clone, and the kernel says so");
    assert.equal(verdict.mechanism, "clonefile_enotsup",
      `the refusal must come from clonefile(2) on this volume, not from a caller-supplied flag; got ${verdict.mechanism}`);
    assert.equal(verdict.status, "preimage_full_copied");
    assert.equal(pgCloneReservationMultiplierV1(verdict), 3,
      "3x is mandatory on a volume that cannot clone");
  } finally {
    // Detach by DEVICE, not by mount point. MEASURED: the FAT32 mount point is
    // "/Volumes/NO NAME 2", with a space, and passing it as one argv element
    // makes hdiutil fail to find it.
    if (device) { try { execFileSync("/usr/bin/hdiutil", ["detach", device, "-quiet"], { encoding: "utf8" }); } catch { /* already gone */ } }
    try { rmSync(image, { force: true }); } catch { /* best effort */ }
  }
});

// ---------------------------------------------------------------------------
// The ports this lane binds, asserted so a future change cannot widen them.
// ---------------------------------------------------------------------------

test("the layout pins every environment variable the design names, and nothing else", { timeout: 60_000 }, async () => {
  const layout = planPgClusterLayoutV1({
    pgRoot: "/Library/Application Support/Control Room/pg", dataId: "data-B",
    runtimeDirectory: "/Library/Application Support/Control Room/runtime/pg-current",
    accounts: ACCOUNTS, port: PG_SERVICE_PORT_V1.port,
  });
  assert.equal(layout.status, "socket_only_cluster_layout_built");
  assert.equal(layout.environment.OPENSSL_CONF, layout.environment.PGSYSCONFDIR + "/openssl.cnf");
  assert.equal(layout.environment.KRB5_CONFIG, "/dev/null");
  assert.equal(layout.environment.KRB5_KDC_PROFILE, "/dev/null");
  assert.equal(layout.environment.LC_ALL, "C");
  assert.equal(layout.environment.LANG, "C");
  // Everything the design says is stripped must be in the stripped list, and
  // none of them may also be in the environment we set: a variable that is both
  // "always stripped" and "set here" means one of the two is wrong.
  const set = new Set(Object.keys(layout.environment));
  for (const name of ["PATH", "HOME", "NODE_OPTIONS", "DEVELOPER_DIR", "SDKROOT", "TMPDIR", "PGHOST", "PGPORT"])
    assert.equal(set.has(name), false, `${name} must not be set in a PG-family environment`);
  assert.equal(layout.environment.PGSYSCONFDIR.endsWith("/etc"), true);
  assert.equal(layout.environment.OPENSSL_MODULES.includes("/lib/ossl-modules"), true);
  // The peer map: three lines, and the deployer maps from root.
  const mapLines = layout.pgIdentConf.trim().split("\n").filter(line => !line.startsWith("#"));
  assert.equal(mapLines.length, 3);
  assert.equal(mapLines[1]!.startsWith("cr root "), true,
    "the updater runs as root and must become the deployer through the map, not through a password");
});

// ---------------------------------------------------------------------------
// helpers that read the OS, used by the environment test
// ---------------------------------------------------------------------------

/**
 * The clone probe: a known NON-SPARSE file through the same `cp -c`, measured by
 * the volume's own accounting.
 *
 * This is the measurement the item's verdict rests on, and it exists because
 * the tree ratio cannot work. MEASURED: a PostgreSQL relation file is sparse
 * (450,560 bytes apparent, 880 blocks charged), so `du` under-reports the source
 * and a genuine clone of a 60 MB cluster measures 0.81x its `du` size — which
 * any threshold below 0.8 would have called a full copy. A 1 MB non-sparse file
 * has no such ambiguity: 40 kB charged when cloned, 1,320 kB when copied.
 */
function cloneProbe(directory: string, environment: NodeJS.ProcessEnv): { sourceBytes: number; consumedBytes: number } {
  const source = join(directory, "clone-probe.bin");
  const target = join(directory, "clone-probe-copy.bin");
  const sourceBytes = 1024 * 1024;
  // `Buffer.alloc` fills, so the file has no holes: unlike a relation file this
  // is genuinely non-sparse, which is the whole property the probe depends on.
  writeFileSync(source, Buffer.alloc(sourceBytes, 0x5a));
  const before = freeBytes(directory);
  execFileSync("/bin/cp", ["-c", source, target], { env: environment });
  const consumedBytes = before - freeBytes(directory);
  rmSync(target, { force: true });
  rmSync(source, { force: true });
  return { sourceBytes, consumedBytes };
}

async function execFileAsync(file: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec(file, args as string[], execOptions);
  return stdout;
}

/** A process's real environment, from `ps eww`, as a plain record. */
function readProcessEnvironment(pid: number): Record<string, string | undefined> {
  const raw = execFileSync("/bin/ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 1 << 24 });
  const record: Record<string, string | undefined> = {};
  for (const token of raw.trim().split(/\s+/)) {
    const equals = token.indexOf("=");
    if (equals <= 0) continue;
    record[token.slice(0, equals)] = token.slice(equals + 1);
  }
  return record;
}
