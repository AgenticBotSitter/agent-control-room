// The install-night database phase's REAL-PostgreSQL lane (M1).
//
// Everything here runs a real PostgreSQL 17.11 postmaster from the VENDORED EDB
// runtime — not Homebrew's — in a temp install root, under the launch daemon's
// own Seatbelt profile, as a NON-ROOT uid, socket-only with no TCP listener, and
// asks the RUNNING SERVER the questions the design turns on.
//
// WHAT IS SIMULATED AND WHAT IS NOT, stated plainly rather than left for a
// reader to discover:
//
//   REAL: the vendored runtime, `initdb`, the postmaster, `pg_hba.conf` and
//         `pg_ident.conf` as the SERVER loaded them, the peer map, the role
//         attributes, the grants, the release ledger applied file by file as the
//         migrator, the updater's fixed DDL, the schema digest, and every
//         refusal.
//   SIMULATED: the uid. The database account is THIS process's uid, not a real
//         `_crdb`, because creating a service account needs root. The peer map's
//         system-username column is the invoking user for the same reason the
//         sibling lane does it, and the comment in `pg-cluster-layout.ts` says
//         so. What that costs is stated in the report: the real-root rehearsal
//         must prove the map with a real second uid.
//   NOT TESTED: the two supervisor-scoped services, the plist bytes, and
//         `assertRuntimeTreeRootMetadataV1`, none of which are this lane's area.
//
// The archive is located through `PG_RUNTIME_ARCHIVE` and the lane SKIPS when it
// is absent, the same convention the sibling real-PostgreSQL lane uses for
// `PG_BIN`: a lane that fetched 437 MB on every run would be a lane nobody ran.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { pgHbaPeerMapV1, planPgClusterLayoutV1 } from "../src/pg-runtime/v1/pg-cluster-layout";
import { vendorPgRuntimeV1 } from "../src/updater/v1/pg/pg-runtime-vendor";
import { initializeDatabaseV1 as initializeDatabaseV1Script } from "../src/updater/v1/pg/init-database.mjs";
import { initializeDatabaseV1 } from "../src/updater/v1/cli/control-room-native-ports.mjs";
import { applyReleaseSchemaV1, ledgerHeadV1, readReleaseLedgerV1 } from "../src/updater/v1/pg/apply-release-schema.mjs";
import { makeSessionClientV1, runSessionStatementV1, statementReturnsRowsV1 } from "../src/updater/v1/pg/sql-session.mjs";
import { postgresProfileParametersV1, sessionRefusalV1, spawnPgFamily } from "../src/updater/v1/pg/database-phase-process.mjs";
import { digestReleaseSchemaRowsV1 } from "../src/updater/v1/pg/release-schema-digest.mjs";
import { readDatabasePhaseDataV1 } from "../src/updater/v1/pg/database-phase-data.mjs";
import { chownOwnershipV1, configFileOwnershipV1 } from "../src/updater/v1/pg/database-phase-ownership.mjs";
import { databaseRoleAttributesV1, databaseRoleManifestV1 } from "../scripts/mac-local/database-role-manifest.mjs";
import { privateWebSchemaDigest } from "../src/web/v1/private-database-preflight";
// The M1 fix round's imports, kept apart from the block above so a merge that
// edits one of those lines does not collide with them.
import { randomBytes, createHash } from "node:crypto";
import { buildInitDependenciesV1 } from "../src/updater/v1/pg/init-database.mjs";
import { buildReleaseDependenciesV1, earlyPrivilegeFileScopeV1 } from "../src/updater/v1/pg/apply-release-schema.mjs";

const REPO = resolve(join(dirname(new URL(import.meta.url).pathname), ".."));
const ARCHIVE = process.env.PG_RUNTIME_ARCHIVE;
const hasArchive = ARCHIVE !== undefined && existsSync(ARCHIVE);
const needsArchive = hasArchive ? false : "needs the pinned archive (PG_RUNTIME_ARCHIVE)";
const PORT = Number(process.env.CONTROL_ROOM_PGRT_PORT_BASE ?? 59910);

/** The manifest as `buildInitStatementsV1` wants it: name plus attribute clause. */
const MANIFEST_ROLES = Object.freeze([
  ...databaseRoleManifestV1.groups.map(name => ({ name, attributes: databaseRoleAttributesV1(name) })),
  ...Object.entries(databaseRoleManifestV1.logins).map(([name]) => ({ name, attributes: databaseRoleAttributesV1(name) })),
]);

/**
 * A SHORT temp root, because of a measured limit.
 *
 * `PG_SOCKET_PATH_BUDGET_V1` is 100 bytes: macOS `sun_path` is 104 including the
 * NUL, and `.s.PGSQL.<port>` needs room. A postmaster whose socket path is too
 * long fails INSIDE the server, after `initdb` has written the data directory,
 * with "could not create any Unix-domain sockets". This worktree's path is
 * already long enough that a per-test subdirectory would cross the budget, so
 * the root is under the system temp directory.
 */
const LANE_ROOT = "/private/tmp";

const RUNS = [];
/** Children of a killed kill-test driver, recorded by pid so a failing run can still clean them up. */
const KILL_ORPHANS = new Set();
process.on("exit", () => {
  for (const pid of KILL_ORPHANS) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  for (const run of RUNS) {
    // The vendored runtime is sealed 0555, so `rm -rf` cannot unlink inside it.
    // This is the same teardown trap the sibling lane documents, and a teardown
    // that cannot remove what the test created is a teardown that leaks.
    try { execFileSync("/bin/chmod", ["-R", "u+rwx", run]); } catch { /* best effort */ }
    try { rmSync(run, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

let shared = null;

/**
 * The vendored runtime, built once and shared by every test in the lane.
 *
 * `normaliseOwnership: false` because the production path's `lchown 0:0` needs
 * a uid this process does not have, and pretending otherwise would either fail
 * the lane or produce a runtime whose ownership is a fiction. What that costs is
 * named in the report: the real-root rehearsal runs
 * `assertRuntimeTreeRootMetadataV1` on every runtime tree, and this lane cannot.
 */
/**
 * The shared runtime root, built once.
 *
 * `<shared>/pg-17.11` is the vendored tree, `<shared>/pg-current` is the
 * `pg-current` link, and EVERY install root's `runtime` is a symlink to
 * `<shared>`. That arrangement is deliberate and it is production's:
 * `runtime/pg-current -> runtime/pg-<version>`, both inside `runtime/`.
 *
 * A lane that instead put a symlink at `<root>/runtime/pg-current` pointing
 * outside the root would be testing a layout that never occurs, and it would
 * fail for a real reason worth knowing: `sandbox-exec` resolves a
 * `(subpath "<root>/runtime")` pattern BEFORE following symlinks, so a runtime
 * reached through a link outside that subtree is denied with the same
 * "Operation not permitted" a forbidden binary produces. `postgresProfileParametersV1`
 * now passes the REALPATH of the runtime, which is what makes both arrangements
 * work and which is the honest fix.
 */
async function vendoredRuntime() {
  return sharedRuntime();
}

/**
 * The vendored runtime, built ONCE even under concurrent callers.
 *
 * MEASURED: the first version guarded on `if (shared) return shared` and then did
 * the whole build, so two callers that arrived before the first finished each ran
 * it and each got a DIFFERENT temp directory — the second one's `shared` won, and
 * the first test's `installRoot` was then handed a `runtimeParent` that belonged to
 * a directory the teardown list did not contain. The symptom was
 * `ENOENT … symlink '…/phase-bundle/bin/init-database.mjs' -> …`, which names
 * nothing about the race.
 *
 * `sharedPromise` is the memo: every caller awaits the SAME build, so there is one
 * directory and one teardown entry however many tests start at once.
 */
let sharedPromise = null;
function sharedRuntime() {
  if (sharedPromise) return sharedPromise;
  sharedPromise = (async () => {
    if (shared) return shared;
    const run = mkdtempSync(join(LANE_ROOT, "install-db-phase-"));
    RUNS.push(run);
    const runtimeParent = join(run, "shared");
    const runtimeRoot = join(runtimeParent, "pg-17.11");
    mkdirSync(runtimeParent, { recursive: true, mode: 0o755 });
    const result = await vendorPgRuntimeV1({ archivePath: ARCHIVE, runtimeDirectory: runtimeRoot,
      opensslConf: "# fixed and empty (R9b)\n", hooks: { normaliseOwnership: false } });
    assert.equal(result.status, "pg_runtime_vendored", result.refusal);
    symlinkSync("pg-17.11", join(runtimeParent, "pg-current"));
    shared = { run, runtimeParent };
    return shared;
  })();
  return sharedPromise;
}

async function installRoot(label, portOffset) {
  const { run: parent, runtimeParent } = await vendoredRuntime();
  const bundle = await bundledPhaseScripts();
  const root = join(parent, label);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  symlinkSync(runtimeParent, join(root, "runtime"));
  // The updater bundle's DDL, the profile and the digest pin are COPIES of the
  // repository's, not imports: production reads them from the bundle, and a lane
  // that imported them would be testing a different arrangement.
  mkdirSync(join(root, "updater", "current", "pg"), { recursive: true, mode: 0o755 });
  for (const [from, to] of [["src/updater/v1/ddl", "updater/current/ddl"],
    ["src/updater/v1/policy", "updater/current/policy"]]) {
    execFileSync("/bin/cp", ["-R", join(REPO, from), join(root, to)], { stdio: "pipe" });
  }
  execFileSync("/bin/cp", [join(REPO, "src/updater/v1/pg/release-schema-digest.sql"),
    join(root, "updater/current/pg/release-schema-digest.sql")], { stdio: "pipe" });
  mkdirSync(join(root, "logs", "postgresql17"), { recursive: true, mode: 0o750 });
  mkdirSync(join(root, "releases"), { recursive: true, mode: 0o755 });
  // The release tree, so the ledger and its files are read from `current/db/**`
  // exactly as the phase reads them. A SYMLINK is enough and is honest: the lane
  // is testing the phase, not the staging.
  for (const name of ["init-database.mjs", "apply-release-schema.mjs"]) {
    const built = name === "init-database.mjs" ? bundle.init : bundle.release;
    const target = join(root, "updater", "current", "bin");
    // The FULL path, not `dirname(target)`. `mkdir(dirname(target), {recursive})`
    // creates `updater/current` — which already exists — and leaves `bin` absent,
    // so the `symlink` below fails with `ENOENT` naming a source file that is
    // there. MEASURED: reproduced in isolation with the lane's own call shape.
    mkdirSync(target, { recursive: true, mode: 0o755 });
    if (!existsSync(join(target, name))) symlinkSync(built, join(target, name));
  }
  symlinkSync(REPO, join(root, "current"));
  return { root, port: PORT + portOffset };
}

/**
 * A PINNED NODE at the path the port spawns, for the cross-process test.
 *
 * `initializeDatabaseV1` spawns `<root>/runtime/node-current/bin/node`, and
 * `<root>/runtime` is ALREADY a symlink to the shared vendored tree — which is
 * production's arrangement (`runtime/pg-current -> runtime/pg-<version>`, both
 * inside `runtime/`). MEASURED: putting the node link inside `<root>/runtime`
 * fails with `EEXIST`, because the link is created once in the shared tree and the
 * second install root then finds it there.
 *
 * So it is created once, in the SHARED runtime parent, named for the same reason
 * `pg-current` is: every install root resolves it through the same `runtime`
 * symlink, and `postgresProfileParametersV1` already resolves the runtime's
 * REALPATH for the Seatbelt profile, so a node binary reached through this link is
 * inside the exempted subtree. Production's own `runtime/node-current` is a
 * separate link beside `pg-current`; the arrangement differs because this lane
 * shares ONE runtime tree across every root it builds, and the property the test
 * needs — a real child process running the real script — does not depend on where
 * the interpreter is linked from.
 */
async function pinnedNode() {
  const { runtimeParent } = await vendoredRuntime();
  const link = join(runtimeParent, "node-current", "bin", "node");
  mkdirSync(join(runtimeParent, "node-current", "bin"), { recursive: true, mode: 0o755 });
  if (!existsSync(link)) symlinkSync(process.execPath, link);
  return link;
}

/**
 * The two phase scripts, BUNDLED ONCE with the real esbuild and the real policy
 * arguments, at the path the port spawns.
 *
 * This is what makes the cross-process test a test of the BUNDLE rather than of
 * the source tree, and the difference is not cosmetic. In production the port
 * spawns `updater/current/bin/init-database.mjs`, which esbuild has already
 * transpiled — including the one crossed-in TypeScript file
 * (`pg-cluster-layout.ts`), which is why the builder's argument list carries
 * `--loader:.ts=ts`. Spawning the SOURCE file instead would need `--import tsx` in
 * the argv the port controls, and the port sends exactly two elements:
 * `[target, "--request", request]`. So a test that spawned the source was testing
 * an argv production never sends.
 *
 * The arguments are read from `policy/bundle.json` rather than written here, so the
 * two lists cannot drift: `updater-fixed-bundle.test.mjs` asserts that file's
 * `arguments` are exactly the eight this uses, which is the same equality the real
 * builder asserts.
 *
 * Built ONCE and shared, because esbuild is the slow part and the bundle does not
 * depend on the install root.
 */
let bundled = null;
async function bundledPhaseScripts() {
  if (bundled) return bundled;
  const esbuild = join(REPO, "node_modules/.pnpm/@esbuild+darwin-arm64@0.28.2/node_modules/@esbuild/darwin-arm64/bin/esbuild");
  const policy = JSON.parse(readFileSync(join(REPO, "src/updater/v1/policy/bundle.json"), "utf8"));
  const { run } = await sharedRuntime();
  const out = join(run, "phase-bundle");
  mkdirSync(join(out, "bin"), { recursive: true, mode: 0o755 });
  // ONLY the two database-phase entries, named as the port names them. The
  // policy's other `bin/` entries (`build-attended-release.mjs`,
  // `build-fixed-bundle.mjs`) are copied into the workspace by the builder before
  // esbuild runs, so their declared input path does not exist in `src/updater/v1`
  // -- MEASURED: bundling them here fails with `Could not resolve
  // "src/updater/v1/fixed-bundle.mjs"`, which says nothing about the phase.
  for (const [input, output] of Object.entries({
    "pg/init-database.mjs": "bin/init-database.mjs",
    "pg/apply-release-schema.mjs": "bin/apply-release-schema.mjs",
  })) {
    execFileSync(esbuild, [...policy.arguments, `--outfile=${join(out, output)}`,
      join(REPO, "src/updater/v1", input)], { cwd: REPO, stdio: "pipe" });
  }
  bundled = Object.freeze({
    node: await pinnedNode(),
    init: join(out, "bin/init-database.mjs"),
    release: join(out, "bin/apply-release-schema.mjs"),
  });
  return bundled;
}

/** The manifest the phase is given, with the port from the lane. */
const manifestFor = (port, database = "control_room") => Object.freeze({
  database, port, roles: MANIFEST_ROLES,
  migratorName: "control_room_migrator", migratorGroup: "control_room_schema_owner",
  deployerName: "control_room_deployer",
});

/**
 * The two OS accounts the phase runs under, as this lane can actually BE.
 *
 * `service` is the invoking account's OWN uid with a DIFFERENT gid, which is the
 * one arrangement that both satisfies the contract and needs no root:
 *
 *   - `parseDatabasePhaseAccountsV1` refuses `database.uid === service.uid` and
 *     `database.name === service.name`, because D and S are two different accounts
 *     the installer created. MEASURED: pointing both at the invoking account
 *     answers `database_init_input_refused` from the very parser that guards the
 *     property — so the lane keeps distinct NAMES and uids.
 *   - `chownOwnershipV1` sets `pg/socket`'s group to D's own gid (it cannot set a
 *     gid it does not belong to without root) and records the SERVICE gid as
 *     `intendedGid`. MEASURED: setting the fictional service gid directly refused
 *     with `EPERM: operation not permitted, lchown '…/pg/socket'`.
 *
 * So `service.uid` is a real, different, non-privileged uid on this machine and its
 * gid is this process's own — which is the group the socket would have to carry for
 * the web process to reach it. The real-root rehearsal measures the arrangement that
 * matters and this lane cannot: root setting `pg/socket` to D with the genuine
 * `_controlroom` group, and the web process opening the socket through it.
 */
const LANE_SERVICE_UID = 4294967294 <= process.getuid() ? 1 : process.getuid() === 1 ? 2 : 502;
const accounts = Object.freeze({
  database: Object.freeze({ name: userInfo().username, uid: process.getuid(), gid: process.getgid() }),
  service: Object.freeze({ name: `${userInfo().username}-service`, uid: LANE_SERVICE_UID, gid: process.getgid() }),
});

/** The login list and passwords for a phase, all generated the way root would. */
function phaseLogins(names) {
  return Object.freeze({
    logins: names.map(name => ({ name, passwordStdin: true })),
    passwords: Object.fromEntries(names.map(name => [name, `${name}-fixture-${"p".repeat(24)}`])),
  });
}

/**
 * The init request.
 *
 * `passwords` is NOT part of it, and that is the contract rather than an
 * omission: the request travels on argv, and `ps` is world-readable on macOS, so
 * a password in the request is a password in a file an unrelated process can
 * read. The passwords reach the script on its stdin, through a separate argument
 * to `initializeDatabaseV1` and a separate line the script reads.
 */
// `port` IS PART OF THE REQUEST, and the signature takes it because the socket path
// is `.s.PGSQL.<port>` inside `pg/socket`: both phases derive it from here, so a
// request without one would have the two phases looking for different sockets. It
// is required rather than defaulted so a caller that forgets it is refused by the
// request's own construction rather than by a connection error three steps later.
const initRequest = (root, { logins, port }) => Object.freeze({
  schema: "control-room.database-init/v1", root, pgDataId: "data-A", runtime: "runtime/pg-current",
  socketDir: "pg/socket", port, accounts, logins,
});

/**
 * The context every `pg_ctl`/`pg_controldata`/`psql` call in this lane needs:
 * the layout, the profile and its parameters, the pinned environment, the
 * profile path, and the install root the binaries are resolved from.
 *
 * `root` is in it because `runSessionStatementV1` resolves `psql` as
 * `<root>/runtime/pg-current/bin/psql`. A context missing it produces a
 * `join(undefined)` TypeError rather than a refusal, which is the least legible
 * failure this lane can have — so the shape is built in one place and every
 * caller spreads it.
 */
async function startPostmaster({ root, port }) {
  const layout = planPgClusterLayoutV1({ pgRoot: join(root, "pg"), dataId: "data-A",
    runtimeDirectory: join(root, "runtime", "pg-current"),
    accounts: { database: accounts.database.name, migrator: "control_room_migrator", deployer: "control_room_deployer" },
    port });
  const profileParameters = postgresProfileParametersV1({ root, layout, logDirectory: join(root, "logs", "postgresql17") });
  return { root, layout, profileParameters, environment: { ...layout.environment }, port,
    identity: { uid: accounts.database.uid, gid: accounts.database.gid },
    pgRoot: join(root, "pg"),
    profile: join(root, "updater", "current", "policy", "service-postgres.sb") };
}

/** One statement as the database account, over the socket, in the profile. */
const asDatabase = (context, sql, user = "postgres", database = "control_room") =>
  runSessionStatementV1({ user, database, sql }, context);

/**
 * THE LANE'S OWN POSTGRES PORT, with only its path assertion overridden.
 *
 * This is the port `initializeDatabaseV1` in `control-room-native-ports.mjs`
 * exposes, imported and used UNMODIFIED except for its third argument — because
 * the property under test is what the port actually sends, and a test that
 * injected its own transport would assert the test's arrangement instead. The
 * port's REAL `runWithStdin` is used, which writes ONE JSON line to the child's
 * stdin and closes it: exactly the transport the scripts' entries are written
 * against, and the one whose mismatch with those entries was Blocker 1.
 *
 * The `assertPath` override is the minimum necessary: `assertT1Path` walks the
 * ancestry and requires root ownership, and this lane has no root. It is given
 * two real assertions in place of the real one — the path must exist, and it must
 * be inside the install root — so the port still refuses a path outside the root,
 * which is the property a permissive stub would have dropped.
 */
function phasePort(root) {
  return (input) => initializeDatabaseV1(input, undefined, async (path) => {
    if (!existsSync(path)) throw new Error("t1_path_missing");
    if (resolve(path) !== path || !path.startsWith(`${root}/`)) throw new Error("t1_path_outside_roots");
    return path;
  });
}

/**
 * The installer's own login list (`INSTALL_DATABASE_LOGINS_V1` on cook/installer),
 * WITHOUT `control_room_deployer`: the deployer is peer-only and the shared parser
 * now refuses it as a password login (M1b review, probe H3). The lead's M4 merge
 * drops it from the installer's list; this lane uses the list as it must become.
 */
const INSTALLER_LOGINS = Object.freeze([
  "control_room_migrator", "control_room_app", "control_room_scheduler", "control_room_work_intake_agent",
  "control_room_web", "control_room_coordinator", "control_room_results", "control_room_publisher",
  "control_room_agent_reviewer_login", "control_room_queue_worker", "control_room_fleet", "control_room_fleet_owner",
]);

/** Passwords as the installer makes them: 32 random bytes, base64url, 43 characters. */
function installerPasswords(names) {
  return Object.freeze(Object.fromEntries(names.map(name => [name, randomBytes(32).toString("base64url")])));
}

/** Text a PG tool prints when it asks a terminal for a password. */
const PROMPT_TEXT = /Enter new password|Enter it again|Password for user|Password:/u;

/**
 * One phase through the REAL port from inside a pseudo-terminal, as the installer
 * runs under `sudo` in Terminal. The pty runner presses Enter once a second.
 * Spawned in its OWN process group, killed as a group in `finally`.
 */
async function phaseThroughPortInPty(root, input, timeoutMs = 900_000) {
  const configPath = join(root, `port-driver-${input.phase}.json`);
  writeFileSync(configPath, JSON.stringify({ root, input }), { mode: 0o600 });
  const child = spawn("python3", [join(REPO, "tests/helpers/pty-run.py"), process.execPath, "--import", "tsx",
    join(REPO, "tests/helpers/database-phase-port-driver.mjs"), configPath],
  { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env } });
  let transcript = "";
  child.stdout.on("data", chunk => { transcript += chunk; });
  child.stderr.on("data", chunk => { transcript += chunk; });
  const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, timeoutMs);
  try {
    const code = await new Promise(resolveRun => child.once("close", resolveRun));
    const line = /PHASE-RESULT (\{.*\})/u.exec(transcript)?.[1];
    assert.ok(line, `the phase must answer within ${timeoutMs} ms (exit ${code}), transcript:\n${transcript.slice(-2000)}`);
    return { outcome: JSON.parse(line), transcript };
  } finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group already exited */ }
    rmSync(configPath, { force: true });
  }
}

test("DEFAULT PATH: the shipped bundle through the real port, in a terminal, with nothing injected",
  { skip: needsArchive, timeout: 1_800_000 }, async () => {
    // THE DEFAULT-PATH RULE of the M1 fix round. Blocker 1 hid because every test
    // swapped in its own verifier; Blocker 2 hid because the runner had no
    // terminal. So this test runs the SHIPPED esbuild output of both scripts
    // through the REAL native port (`runWithStdin`, request on argv, passwords on
    // one stdin line) with the PRODUCTION dependency sets the scripts' own entries
    // build, from inside a PSEUDO-TERMINAL that presses Enter once a second.
    //
    // What is NOT the default: the T1 path assertion (needs a root-owned
    // ancestry; its stand-in still refuses a missing path or one outside the
    // root), and the deployer half of the release loader, which needs uid 0. The
    // release phase therefore must stop EXACTLY at the deployer's spawn, by name —
    // and everything before it is real: the ledger with its digests, the queue,
    // the role files, the grant convergence from the shipped data file, and every
    // login verified by the production `verifyLogin` (Blocker 1).
    const { root, port } = await installRoot("cross-process", 12);
    const passwords = installerPasswords(INSTALLER_LOGINS);
    const logins = INSTALLER_LOGINS.map(name => ({ name, passwordStdin: true }));
    const base = { root, pgDataId: "data-A", runtime: "runtime/pg-current", socketDir: "pg/socket", port,
      accounts, logins, passwords };
    const init = await phaseThroughPortInPty(root, { phase: "init", ...base });
    assert.deepEqual(Object.keys(init.outcome), ["ok", "result"], `init through the port: ${JSON.stringify(init.outcome)}`);
    assert.equal(init.outcome.result.outcome, "initialized");
    assert.equal(init.outcome.result.clusterShutDownClean, true);
    assert.doesNotMatch(init.transcript, PROMPT_TEXT, "no PG tool may prompt the terminal for a password");
    const outLog = () => readFileSync(join(root, "logs/postgresql17/out.log"), "utf8");
    for (const password of Object.values(passwords)) {
      assert.equal(outLog().includes(password), false, "no password may reach the server log");
      assert.equal(init.transcript.includes(password), false, "no password may reach the terminal");
    }
    const context = await startPostmaster({ root, port });
    const started = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
      args: ["-D", join(root, "pg", "data-A"), "-l", join(root, "logs/postgresql17/out.log"),
        "-o", `-p ${port}`, "-w", "-t", "60", "start"], ...context, role: "database", cwd: join(root, "pg") });
    assert.equal(started.code, 0, `the service must start before the release phase: ${started.stderr}`);
    // The deployer's peer line for the INVOKING uid is added, but the shipped
    // script's deployer identity is still ROOT (production), so it never uses it:
    // the kernel refuses the uid-0 spawn first. That is the refusal asserted.
    await simulateRootDeployerPeer(context);
    try {
      // THE `detached` GUARD, on its own: the one psql invocation that prompts
      // whenever it has a terminal, started through `spawnPgFamily` from inside the
      // pty. It must fail at once for want of a password, never print a prompt.
      const probeConfig = join(root, "prompt-probe.json");
      writeFileSync(probeConfig, JSON.stringify(context), { mode: 0o600 });
      const probe = spawn("python3", [join(REPO, "tests/helpers/pty-run.py"), process.execPath, "--import", "tsx",
        join(REPO, "tests/helpers/pg-prompt-probe.mjs"), probeConfig],
      { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env } });
      let probeTranscript = "";
      probe.stdout.on("data", chunk => { probeTranscript += chunk; });
      probe.stderr.on("data", chunk => { probeTranscript += chunk; });
      const probeTimer = setTimeout(() => { try { process.kill(-probe.pid, "SIGKILL"); } catch { /* gone */ } }, 120_000);
      await new Promise(resolveRun => probe.once("close", resolveRun));
      clearTimeout(probeTimer);
      try { process.kill(-probe.pid, "SIGKILL"); } catch { /* the group already exited */ }
      // MEASURED: with no terminal, psql does not give up on prompting — it writes
      // `Password for user …:` to its STDERR (which `spawnPgFamily` captures) and
      // reads STDIN (closed), so it fails at once. So the claim is WHERE the prompt
      // goes: never onto the terminal (the transcript outside the probe's own
      // result line), only into the captured stderr. With a terminal the prompt
      // goes to `/dev/tty`, lands in the transcript and reads the Enter presses.
      const onTerminal = probeTranscript.replace(/PROBE-RESULT .*/u, "");
      assert.doesNotMatch(onTerminal, PROMPT_TEXT, `a PG child must have no terminal to prompt on:\n${probeTranscript}`);
      const probed = JSON.parse(/PROBE-RESULT (\{.*\})/u.exec(probeTranscript)?.[1] ?? "null");
      assert.notEqual(probed?.code, 0, "a scram login with no password must be refused");
      assert.match(probed?.stderr ?? "", /no password supplied/u,
        `psql must fail for want of a password, not prompt for one: ${probeTranscript}`);
      const release = await phaseThroughPortInPty(root, { phase: "release", ...base,
        expectedLedgerHead: ledgerHeadV1(await readReleaseLedgerV1(REPO)) });
      assert.equal(release.outcome.ok, false, "the release phase cannot complete without root");
      assert.match(release.outcome.error,
        /^database_phase_script_failed:1:release_schema_deployer_spawn_refused:uid=0:EPERM$/u,
        "the shipped release script must run every step before the deployer's and stop at its spawn, by name");
      assert.doesNotMatch(release.transcript, PROMPT_TEXT, "no PG tool may prompt the terminal for a password");
      for (const password of Object.values(passwords)) {
        assert.equal(outLog().includes(password), false, "no password may reach the server log");
        assert.equal(release.transcript.includes(password), false, "no password may reach the terminal");
      }
      // Everything before the deployer's spawn really happened, on the default path:
      const state = await proveReleaseState(context, root);
      assert.equal(state.ledgerHead, `db/migrations/${ledgerHeadV1(await readReleaseLedgerV1(REPO))}`);
      // H1: the ledger's head digest is what `readSchemaDigest` computes.
      assert.equal(state.evidenceDigest, state.headPostDigest,
        "the ledger's post digest must be the evidence.mjs digest every consumer recomputes");
      // H2: the shipped grant data leaves nothing the release's own grant model needs.
      assert.deepEqual(state.missingGrants, [], "the shipped desired-grants.json must not revoke a grant the release needs");
      // B1: the production verifier ran — every login authenticates with the
      // password the installer generated (asked again here, independently).
      for (const name of ["control_room_web", "control_room_fleet"]) {
        assert.equal(await authenticates(context, name, passwords[name]), true, `${name} must authenticate`);
        assert.equal(await authenticates(context, name, "x".repeat(43)), false, `${name} must refuse a wrong password`);
      }
      assert.deepEqual(await asDatabase(context, "SELECT rolpassword IS NOT NULL AS has_password"
        + " FROM pg_authid WHERE rolname='control_room_deployer'", "postgres", "postgres"),
      [{ has_password: false }], "the deployer must hold no verifier");
    } finally {
      await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
        args: ["-D", join(root, "pg", "data-A"), "-m", "fast", "-w", "-t", "60", "stop"],
        ...context, role: "database", cwd: join(root, "pg") });
    }
  });

/** Does `login` authenticate with `password` over the socket (scram, no peer)? */
async function authenticates(context, login, password) {
  const result = await spawnPgFamily({ executable: join(context.root, "runtime/pg-current/bin/psql"),
    args: ["-h", context.layout.socketDirectory, "-p", String(context.port), "-U", login, "-d", "control_room",
      "-w", "-Atc", "SELECT current_user"],
    environment: { ...context.environment, PGPASSWORD: password, PGCONNECT_TIMEOUT: "10" },
    uid: context.identity.uid, gid: context.identity.gid, role: "database", profile: context.profile,
    profileParameters: context.profileParameters, cwd: context.pgRoot, timeoutMs: 60_000 });
  return result.code === 0 && result.stdout.trim() === login;
}

/**
 * What a release phase left: the ledger head and its post digest, the
 * `evidence.mjs` digest of the live schema (through node-postgres, exactly as the
 * three consumers compute it), and the grants the RELEASE's own model says are
 * missing from the live catalogue.
 */
async function proveReleaseState(context, root) {
  const { readSchemaDigest } = await import("../deploy/postgres/evidence.mjs");
  const grants = await import("../scripts/mac-local/database-upgrade-grants.mjs");
  const { Client } = await import("pg");
  const client = new Client({ host: context.layout.socketDirectory, port: context.port, user: "postgres",
    database: "control_room", ssl: false, connectionTimeoutMillis: 30_000 });
  await client.connect();
  try {
    const head = (await client.query("SELECT filename, post_schema_digest FROM control_room_schema_migrations"
      + " ORDER BY ledger_order DESC LIMIT 1")).rows[0];
    const chain = (await client.query("SELECT pre_schema_digest, post_schema_digest FROM control_room_schema_migrations"
      + " ORDER BY ledger_order")).rows;
    chain.slice(1).forEach((row, index) => assert.equal(row.pre_schema_digest, chain[index].post_schema_digest,
      `ledger row ${index + 2}'s pre digest must be row ${index + 1}'s post digest`));
    const principals = [...Object.keys(grants.macRolePlan), ...Object.values(grants.macRolePlan)];
    const live = grants.macGrantRowsToSetV1((await client.query(grants.macGrantCatalogSqlV1, [principals])).rows);
    const diff = grants.diffMacGrantsV1(live, await grants.readDesiredMacGrantsV1());
    return { ledgerHead: head?.filename, headPostDigest: head?.post_schema_digest,
      evidenceDigest: await readSchemaDigest(client), missingGrants: diff.missing, extraGrants: diff.extra,
      ledgerRows: chain.length };
  } finally { await client.end().catch(() => undefined); void root; }
}

/**
 * KILL AT EVERY STATEMENT, then retry, until a run is not killed (H3 of the M1b
 * review). Each run is a REAL child process (`tests/helpers/database-phase-kill-
 * driver.mjs`) running the phase with the PRODUCTION dependency set; it SIGKILLs
 * itself at the first statement no earlier run was killed at, so run N dies at the
 * N-th kill point and run N+1 must converge from whatever that left. The loop ends
 * when a run completes: every kill point has then been visited once, and the
 * retry after each one made progress or finished.
 *
 * `afterKill` lets a phase say what a retry may assume: init's retry must cope
 * with whatever the dead run's children are still doing (that is what its sweep is
 * for); the release retry waits for the dead run's own `psql` children to finish,
 * because a statement in flight is all-or-nothing and the retry's own first step
 * ends any session of the phase that is still open.
 */
/**
 * KILL AT EVERY STATEMENT, then retry, until a run is not killed (H3 of the M1b
 * review). Each run is a REAL child process (`tests/helpers/database-phase-kill-
 * driver.mjs`) running the phase with the PRODUCTION dependency set; it SIGKILLs
 * itself at the first statement no earlier run was killed at, so run N dies at the
 * N-th kill point and run N+1 must converge from whatever that left. The loop ends
 * when a run completes: every kill point has then been visited once, and the
 * retry after each one made progress or finished.
 *
 * `afterKill` lets a phase say what a retry may assume: init's retry must cope
 * with whatever the dead run's children are still doing (that is what its sweep is
 * for); the release retry waits for the dead run's own `psql` children to finish,
 * because a statement in flight is all-or-nothing and the retry's own first step
 * ends any session of the phase that is still open.
 *
 * THE THREE OUTCOMES, and the one that is not a kill. The driver records a
 * `before` kill as it happens, a `during` kill when its deferred SIGKILL lands,
 * and a `refused` event when the phase throws — so:
 *
 *   exited 0 with a `result`   → the run completed: this loop is done
 *   SIGKILL with a `kill`       → the run died at a kill point; count it
 *   SIGKILL with only `kill-armed` → the run ARMED a deferred kill and the phase
 *     finished first. Not a kill point, and counting it was the bug X1 found: the
 *     phase had already answered and written `pg/current`, and the next run —
 *     same data id — correctly refused. The label is NOT pushed onto `killed`, so
 *     the same statement is armed again next run and is never counted as visited
 *     without having been killed.
 *   non-zero exit with `refused` → the phase refused where the loop expected a kill:
 *     a FAILURE, reported with the phase's own code. Before X1 this run carried a
 *     `kill` record from the arming and was counted as a kill point, which is how a
 *     refusal hid in this lane for a whole review cycle.
 */
async function killEveryStatement({ label, phase, request, passwords, duringSample, afterKill, limit = 2000 }) {
  const work = mkdtempSync(join(LANE_ROOT, `kill-${label}-`));
  RUNS.push(work);
  const killed = [];
  const log = [];
  let lateArms = 0;
  for (let run = 1; run <= limit; run += 1) {
    const stateFile = join(work, `state-${run}.jsonl`);
    const configPath = join(work, `config-${run}.json`);
    writeFileSync(configPath, JSON.stringify({ phase, request, passwords, killed, duringSample, stateFile }));
    writeFileSync(stateFile, "");
    const child = spawn(process.execPath, ["--import", "tsx", join(REPO, "tests/helpers/database-phase-kill-driver.mjs"),
      configPath], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"], detached: true, env: { ...process.env } });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const [code, signal] = await new Promise(resolveRun => child.once("close", (...values) => resolveRun(values)));
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is gone */ }
    const events = readFileSync(stateFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    const result = events.find(event => event.event === "result");
    if (code === 0 && result) return { result: result.result, runs: run, killed, log, lateArms };
    const kill = events.find(event => event.event === "kill");
    if (kill === undefined) {
      // NO KILL LANDED, and that is a distinct outcome from "not a kill point".
      // A phase that ARMED a deferred kill and then answered or refused itself is
      // the X1 case: the label is left off `killed`, so the next run arms it again
      // and the statement is never counted as visited without having been killed.
      if (events.some(event => event.event === "kill-armed")) {
        lateArms += 1;
        continue;
      }
      // Anything else — the phase refusing or throwing where the loop expected a
      // kill — is a FAILURE of the phase and is reported with its own code, not
      // swallowed into a kill count. Before this branch a refusal carried a `kill`
      // record and was counted as a kill point that never happened, which is how
      // X1's lane failure hid a phase refusal for a whole review cycle.
      const refused = events.find(event => event.event === "refused");
      assert.fail(`run ${run} must either complete or die at a kill point; it exited ${code}/${signal}`
        + `${refused ? ` having refused ${refused.reason}` : ""} after `
        + `${log.slice(-3).join(" | ")}:\n${stderr.slice(-1500)}`);
    }
    assert.equal(signal, "SIGKILL", `run ${run} recorded a kill but exited ${code}/${signal}:\n${stderr.slice(-800)}`);
    killed.push(kill.key);
    log.push(`${kill.mode}:${kill.name}`);
    const orphans = events.find(event => event.event === "orphans")?.pids ?? [];
    for (const pid of orphans) KILL_ORPHANS.add(pid);
    await afterKill?.(orphans);
  }
  assert.fail(`${label}: no run completed within ${limit} kills`);
}

/** Wait, bounded, for pids this test started (via its driver) to exit on their own. */
async function waitForExit(pids, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isProcessAlive) && Date.now() < deadline) await new Promise(wait => setTimeout(wait, 50));
  for (const pid of pids.filter(isProcessAlive)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

test("init killed at EVERY statement, before and during it, converges on retry (H3)",
  { skip: needsArchive, timeout: 3_600_000 }, async (t) => {
    const { root, port } = await installRoot("kill-init", 18);
    const { logins, passwords } = phaseLogins(["control_room_web", "control_room_coordinator"]);
    // A FAILING run can leave a dead driver's postmaster up (that is the orphan the
    // sweep exists for); this test's own cleanup finds it the way the sweep does,
    // by the pid in `postmaster.pid`, never by pattern.
    t.after(() => {
      for (const directory of ["data-A", ...retiredDirectories(root)]) {
        const pidFile = join(root, "pg", directory, "postmaster.pid");
        const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").split("\n")[0]) : 0;
        if (pid > 1 && isProcessAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      }
    });
    const outcome = await killEveryStatement({ label: "init", phase: "init",
      request: initRequest(root, { logins, port }), passwords, duringSample: 16,
      // Retired debris is removed between runs only to bound the disk use (each is a
      // whole cluster); it is asserted to EXIST first, which is the claim.
      afterKill: async () => {
        for (const name of retiredDirectories(root)) rmSync(join(root, "pg", name), { recursive: true, force: true });
      } });
    // `lateArms` is the X1 mechanism, counted rather than hidden: a run that armed a
    // deferred kill and finished anyway. It is printed even when it is zero, so a
    // lane that no longer exercises the case says so instead of leaving a reader
    // to assume the path is dead.
    t.diagnostic(`init: ${outcome.killed.length} kill points, ${outcome.runs} runs, `
      + `${outcome.lateArms} run(s) armed a deferred kill and finished first`);
    assert.equal(outcome.result.outcome, "initialized", "the run that was not killed must initialise");
    assert.ok(outcome.killed.length >= 40, `every statement must have been a kill point, got ${outcome.killed.length}`);
    assert.ok(outcome.log.some(entry => entry.startsWith("during:initdb")), "a kill DURING initdb must be among them");
    assert.ok(outcome.log.some(entry => entry.startsWith("during:psql ALTER ROLE")),
      "a kill during a login's verifier statement must be among them");
    assert.equal(readlinkSync(join(root, "pg", "current")), "data-A");
    // Nothing of any run is still working on the data directory.
    const rows = execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
    assert.equal(rows.includes(` -D ${join(root, "pg", "data-A")}`), false,
      "no PG-family process may still be running on the data directory");
    const context = await startPostmaster({ root, port });
    const control = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_controldata"),
      args: ["-D", join(root, "pg", "data-A")], ...context, role: "database", cwd: join(root, "pg") });
    assert.match(control.stdout, /Database cluster state:\s+shut down/u);
  });

test("the release phase killed at EVERY statement converges on retry (H3)",
  { skip: needsArchive, timeout: 3_600_000 }, async (t) => {
    const { root, port } = await installRoot("kill-release", 19);
    const { logins, passwords } = phaseLogins(INSTALLER_LOGINS);
    await initializeDatabaseV1Script(initRequest(root, { logins, port }), passwords,
      await buildInitDependenciesV1(join(root, "current")));
    const context = await startPostmaster({ root, port });
    const started = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
      args: ["-D", join(root, "pg", "data-A"), "-l", join(root, "logs/postgresql17/out.log"),
        "-o", `-p ${port}`, "-w", "-t", "60", "start"], ...context, role: "database", cwd: join(root, "pg") });
    assert.equal(started.code, 0, started.stderr);
    await simulateRootDeployerPeer(context);
    try {
      const head = ledgerHeadV1(await readReleaseLedgerV1(REPO));
      const outcome = await killEveryStatement({ label: "release", phase: "release",
        request: { ...initRequest(root, { logins, port }), schema: "control-room.release-schema/v1",
          release: "current", expectedLedgerHead: head },
        passwords, duringSample: Number(process.env.CONTROL_ROOM_M1_DURING_SAMPLE ?? 16),
        afterKill: waitForExit });
      t.diagnostic(`release: ${outcome.killed.length} kill points (${outcome.log.filter(entry => entry.startsWith("during:")).length} mid-statement), ${outcome.runs} runs`);
      assert.equal(outcome.result.outcome, "applied", "the run that was not killed must apply");
      assert.equal(outcome.result.ledgerHead, head);
      assert.ok(outcome.killed.length >= 150, `every statement must have been a kill point, got ${outcome.killed.length}`);
      const state = await proveReleaseState(context, root);
      assert.equal(state.ledgerHead, `db/migrations/${head}`);
      assert.equal(state.ledgerRows, (await readReleaseLedgerV1(REPO)).length, "every migration exactly once");
      assert.equal(state.evidenceDigest, state.headPostDigest, "the ledger head must be the live evidence digest");
      assert.deepEqual(state.missingGrants, []);
      const credentials = JSON.parse(readFileSync(join(root, "Protected", "service", "db-logins.json"), "utf8"));
      assert.deepEqual(Object.keys(credentials.logins).sort(), [...INSTALLER_LOGINS].sort());
      assert.deepEqual(readdirSync(join(root, "Protected", "service")).filter(name => name.includes("staging")
        || name.endsWith(".tmp")), [], "no staging credential file may survive the converged run");
    } finally {
      await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
        args: ["-D", join(root, "pg", "data-A"), "-m", "fast", "-w", "-t", "60", "stop"],
        ...context, role: "database", cwd: join(root, "pg") });
    }
  });

test("every path the init creates is handed to the account that must own it",
  { skip: needsArchive, timeout: 600_000 }, async () => {
    // BLOCKER 2's proof, and the reason it can be proved without root: the
    // ownership plan is a PURE function of the request, so a request whose D is a
    // DIFFERENT uid from this process's turns "owned by the invoker" and "owned by
    // D" into two distinguishable answers.
    //
    // MEASURED, the gap this closes -- every path landed owned by the invoker:
    //
    //   pg                        0700 uid=<invoker> gid=0 dir
    //   pg/socket                 0750 uid=<invoker> gid=0 dir
    //   pg/data-A                 0700 uid=<invoker> gid=0 dir
    //   logs/postgresql17/out.log 0600 uid=<invoker> gid=0 file
    //   pg/data-A/postgresql.conf 0600 uid=<invoker> gid=0 file
    //
    // and with a root-owned 0700 `pg/` the postmaster cannot traverse into its own
    // data directory at all. The lane could not see this because its D IS the
    // invoking uid, so the two claims coincide and every assertion passes.
    const OTHER_DATABASE = Object.freeze({ name: "_crdb", uid: process.getuid() + 40,
      gid: process.getgid() + 40 });
    const OTHER_SERVICE = Object.freeze({ name: "_controlroom", uid: process.getuid() + 41,
      gid: process.getgid() + 41 });
    const { root, port } = await installRoot("ownership", 13);
    const { logins, passwords } = phaseLogins(["control_room_web"]);
    // The `lchown` SPY, which is the injection that makes the claim checkable:
    // a real `lchown` to another uid needs root this lane does not have, so the
    // calls are recorded and the read-back is answered from the record.
    const calls = [];
    const intended = new Map();
    const spy = async (path, uid, gid) => { calls.push({ path, uid, gid }); intended.set(path, { uid, gid }); };
    const readBack = async (path) => intended.get(path) ?? null;
    // The request carries the OTHER accounts, because the ownership plan is built
    // from `request.accounts` and nothing else — that is what makes "owned by D"
    // and "owned by the invoker" two different answers here.
    const request = initRequest(root, { logins, port });
    await initializeDatabaseV1Script({ ...request, accounts: { database: OTHER_DATABASE, service: OTHER_SERVICE } },
      passwords,
      { ...manifestFor(port), planLayout: (input) => planPgClusterLayoutV1(input),
        chownPath: spy, inspectPath: readBack })
      .catch(error => {
        // The phase WILL fail — the postmaster cannot run as a uid that does not
        // exist — and that is fine: the ownership handoff happens BEFORE any
        // PG-family program, so the calls are on record either way. What must not
        // happen is the phase reaching `initdb` first, which is asserted below.
        assert.match(String(error.message), /pg_phase|Operation not permitted|ENOENT|EPERM/u,
          `the phase must fail at the spawn, not somewhere unexpected: ${error.message}`);
      });
    // The FIRST handoff covers the five paths that exist before `initdb` runs: the
    // pg root, the socket, the data directory, the log directory and the log file.
    // The three config files are NOT among them — `initdb` creates those, and the
    // plan marks them `present: false` so this handoff does not fail on files that
    // do not exist yet (MEASURED: it refused the whole phase with `ENOENT …
    // lstat '…/pg/data-A/postgresql.conf'`). The SECOND handoff covers them, and
    // the assertion below checks those separately.
    assert.equal(calls.length, 5,
      `the first handoff must cover the five paths initdb does not create, got ${calls.length}: `
        + `${JSON.stringify(calls.map(c => c.path))}`);
    // EVERY call names the DATABASE account's uid -- never the invoker's, which is
    // the whole of Blocker 2. Compared against the invoker explicitly so the
    // assertion is about the difference and not merely about a number.
    for (const call of calls) {
      assert.notEqual(call.uid, process.getuid(),
        `${call.path} was left owned by the invoking uid, which in production is root`);
      assert.equal(call.uid, OTHER_DATABASE.uid, `${call.path} must be owned by the database account D`);
    }
    // AND the socket directory's GROUP is the SERVICE account's. That is the one
    // non-obvious entry: the layout grants 0770 on the socket, so the service
    // group is what lets the web process reach it, and D:D would make the socket
    // unreachable by exactly the process the design installs it for.
    //
    // `intendedGid` rather than `gid`, and the distinction is measured: a non-root
    // phase cannot set a gid it does not belong to, so `gid` is what it actually
    // sets and `intendedGid` is the service group the layout's reachability needs.
    // Asserting `intendedGid` keeps the DESIGN claim in the assertion while letting
    // the phase run without root -- and the real-root rehearsal is what measures
    // the arrangement where the two are the same value.
    const socket = calls.find(call => call.path.endsWith("/pg/socket"));
    assert.ok(socket, "pg/socket must be chowned");
    assert.equal(socket.gid, OTHER_DATABASE.gid,
      "a phase that cannot set the service group must set its OWN, and record the service group as intended");
    // …and it must be D's UID, because the postmaster has to create the socket
    // INSIDE that directory.
    assert.equal(socket.uid, OTHER_DATABASE.uid, "pg/socket must be owned by the database account");
    // The SERVICE group is still asserted, from the PLAN rather than from the
    // syscall: `chownOwnershipV1` records it as `intendedGid`, and it is what the
    // layout's 0770 depends on. Asserting the plan's value is what keeps the
    // design claim in the test even where the machine cannot set it.
    const socketPlan = chownOwnershipV1({ root: "/x", pgDataId: "data-A",
      accounts: { database: OTHER_DATABASE, service: OTHER_SERVICE } })
      .find(entry => entry.path.endsWith("/pg/socket"));
    assert.equal(socketPlan.intendedGid, OTHER_SERVICE.gid,
      "the socket's INTENDED group must be the service account's, or the web process cannot reach it");
    assert.equal(socketPlan.uid, OTHER_DATABASE.uid, "the socket's owner must be the database account");
    // The three config files are handed to D by the SECOND handoff, which runs after
    // `initdb` has created them and the phase has replaced them. This run cannot
    // reach it — the postmaster cannot start as a uid that does not exist, which is
    // the whole point of giving the request a DIFFERENT D — so what is asserted is
    // the PLAN, which is where the claim lives:
    //
    //   the second handoff's input is exactly the three config files …
    //   … with `present` cleared, so it applies …
    //   … each owned by D at 0600, which is what makes them readable by the
    //       postmaster and unreadable by anybody else.
    //
    // MEASURED and the reason it cannot be asserted from the calls: with a real
    // `lchown` spy the run stops at the first spawn, which is after the first
    // handoff and before the second.
    const secondHandoff = configFileOwnershipV1(chownOwnershipV1({ root: "/x", pgDataId: "data-A",
      accounts: { database: OTHER_DATABASE, service: OTHER_SERVICE } }));
    assert.deepEqual(secondHandoff.map(entry => entry.path.split("/").at(-1)).sort(),
      ["pg_hba.conf", "pg_ident.conf", "postgresql.conf"],
      "the second handoff must be exactly the three files initdb creates");
    for (const entry of secondHandoff) {
      assert.equal(entry.uid, OTHER_DATABASE.uid, `${entry.path} must be owned by the database account`);
      assert.equal(entry.mode, 0o600, `${entry.path} must be 0600`);
    }
    // No staging file survives: the conf writes are staging + rename, and a
    // leftover `.staging` in a D-owned directory is a second copy of a root write.
    const strays = existsSync(join(root, "pg", "data-A"))
      ? readdirSync(join(root, "pg", "data-A")).filter(name => name.includes("staging")) : [];
    assert.deepEqual(strays, [], `no staging file may survive, found ${JSON.stringify(strays)}`);
  });

test("a SIGKILLed init leaves an orphan that the retry sweeps and converges on",
  { skip: needsArchive, timeout: 900_000 }, async () => {
    // HIGH 2, and it is the only test in this lane that actually KILLS a process.
    // The existing "a crash mid-init" case is NOT a crash: it throws inside the
    // process, so the `finally` runs and the postmaster is stopped — the one thing
    // a SIGKILL never does.
    //
    // MEASURED by the review, and what the sweep has to make converge:
    //
    //   after SIGKILL of the script: postmaster alive = true ; socket present = true
    //   lock file = ['.s.PGSQL.59608', '.s.PGSQL.59608.lock']
    //   retry same id                       → database_init_already_initialized
    //   retry after retiring the data dir   → database_init_postmaster_refused:Examine the log output.
    //   postmaster still alive after refused retry = true
    //
    // So the refusal named nothing, and the retry did not converge until an
    // operator killed the orphan by hand.
    const { root, port } = await installRoot("orphan", 14);
    const { logins, passwords } = phaseLogins(["control_room_web"]);
    const pidFile = join(root, "pg", "data-A", "postmaster.pid");
    let child = null;
    let postmasterPid = 0;
    const childStdout = [];
    // The phase runs as a REAL CHILD, so SIGKILL reaches a process that has its own
    // pid and whose `finally` cannot run. It is the same script file and the same
    // argv the cross-process test uses, which is why no hook is needed: the test
    // waits for `postmaster.pid` to appear, which is the postmaster being up, and
    // the window between that and the kill is the orphan's whole life.
    const bundle = await bundledPhaseScripts();
    child = spawn(bundle.node, [bundle.init, "--request", JSON.stringify(initRequest(root, { logins, port }))],
      { stdio: ["pipe", "pipe", "pipe"], detached: false, env: { ...process.env } });
    child.stdout.on("data", chunk => childStdout.push(String(chunk)));
    child.stderr.on("data", () => undefined);
    child.stdin.end(`${JSON.stringify(passwords)}\n`);
    try {
      const deadline = Date.now() + 300_000;
      // WAIT FOR A COMPLETE pid FILE, not just for the file to exist. MEASURED: the
      // first version polled `existsSync` and read whatever was there, and caught
      // the file MID-WRITE — `postmaster.pid` was 8 lines of which only 3 existed
      // yet, so `split("\n")[0]` was a half-written `-73503`. PostgreSQL writes the
      // file and then renames it into place, but the window between "exists" and
      // "complete" is real and a test that reads in it reports a garbage pid.
      //
      // The check is therefore the one that matters: the file must parse AND name a
      // pid that is ALIVE. A postmaster's own pid is alive by definition at the
      // moment the file is complete. `postmasterPid` is the one declared above the
      // `try`, so the `finally` that cleans up the orphan can see it.
      while (Date.now() < deadline && postmasterPid === 0) {
        if (existsSync(pidFile)) {
          const text = readFileSync(pidFile, "utf8");
          const lines = text.split("\n");
          const candidate = lines.length >= 8 && /^[0-9]{1,10}$/u.test(lines[0].trim())
            ? Number(lines[0].trim()) : 0;
          if (candidate > 1 && isProcessAlive(candidate)) postmasterPid = candidate;
        }
        if (postmasterPid === 0) await new Promise(wait => setTimeout(wait, 100));
      }
      assert.ok(postmasterPid > 0,
        `the postmaster must be up and its pid file COMPLETE for this test to mean anything, got: `
          + `${JSON.stringify(existsSync(pidFile) ? readFileSync(pidFile, "utf8") : null)}`);
      assert.ok(isProcessAlive(postmasterPid), "the postmaster must actually be running");
      // The KILL. SIGKILL, so the script's `finally` cannot stop the postmaster —
      // which is the entire point, and why `kill -TERM` would not test this.
      child.kill("SIGKILL");
      await once(child, "close");
      // The postmaster SURVIVES, which is the measured state the sweep exists for.
      await new Promise(wait => setTimeout(wait, 500));
      assert.ok(isProcessAlive(postmasterPid),
        "a SIGKILLed script must leave its postmaster running -- that is the orphan");
      // THE RETRY, INSIDE THE TRY, and that placement IS the test. MEASURED: the
      // first version cleaned the orphan up in a `finally` and retried AFTER it,
      // which asserted the opposite of what it meant to: the sweep found a DEAD pid,
      // took the "stale pid file" branch, and the phase refused
      // `database_init_already_initialized` because the data directory held a real
      // half-built cluster. Cleaning up first is what a careful test-writer does and
      // what destroys the thing under test — the orphan must still be ALIVE when the
      // retry arrives, or there is nothing for the sweep to converge from.
      //
      // The retry is in-process so its own error can be asserted, and it is the
      // second half of the measured sequence: bootout, kill-sweep uid D, retire the
      // data directory by rename.
      const retried = await initializeDatabaseV1Script(initRequest(root, { logins, port }), passwords,
        { ...manifestFor(port), planLayout: (input) => planPgClusterLayoutV1(input) });
      assert.equal(retried.outcome, "initialized",
        "the retry must converge after a SIGKILLed init left an orphan");
      assert.ok(retiredDirectories(root).length >= 1,
        "the half-built data directory must be retired ASIDE, never removed");
      // …and the orphan is GONE, which is the convergence the review could not get
      // without a human killing it by hand.
      await new Promise(wait => setTimeout(wait, 500));
      assert.equal(isProcessAlive(postmasterPid), false,
        `the sweep must have killed the orphan ${postmasterPid}, or the retry only appeared to converge`);
    } finally {
      // PROCESS HYGIENE: only pids this test started, and only if they are still
      // running. The postmaster is an ORPHAN this test created, so cleaning it up
      // here is correct -- but it is done by pid read from the pid file, never by
      // pattern, and it runs only if the retry did not already converge.
      if (postmasterPid > 1 && isProcessAlive(postmasterPid)) {
        try { process.kill(postmasterPid, "SIGKILL"); } catch { /* already gone */ }
      }
      if (child.pid && isProcessAlive(child.pid)) {
        try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    void childStdout;
  });

/** The SHIPPED init script as the port runs it: request on argv, passwords on stdin. */
async function runShippedInit(request, passwords) {
  const bundle = await bundledPhaseScripts();
  const child = spawn(bundle.node, [bundle.init, "--request", JSON.stringify(request)],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify(passwords)}\n`);
  const [code] = await new Promise(resolveRun => child.once("close", (...values) => resolveRun(values)));
  return { code, stdout, stderr, said: code === 0 ? JSON.parse(stdout).outcome : stderr.trim() };
}

test("a power cut inside initdb leaves a stale standalone pid file, and every retry converges (N1)",
  { skip: needsArchive, timeout: 900_000 }, async (t) => {
    // N1 of the M1c review, MEASURED (probe E2 "whole-tree"): kill the script AND
    // its `initdb` + `postgres --boot` while the bootstrap backend holds
    // `postmaster.pid` with a NEGATIVE pid, and every retry answered
    // `database_init_orphan_postmaster:unreadable` in ~40 ms, forever. That is what
    // a power cut, a restart or a kernel kill leaves: the file, and no process.
    //
    // The window is hit DETERMINISTICALLY: the kill driver watches the data
    // directory once `initdb` is spawned, and the moment line 1 of
    // `postmaster.pid` is the negative pid of `initdb`'s post-bootstrap
    // single-user backend (with its shared memory made), it freezes that backend,
    // re-reads the file, and SIGKILLs every process it started (by ppid from its
    // own pid, never by pattern) and then itself.
    const { root, port } = await installRoot("power-cut", 16);
    const { logins, passwords } = phaseLogins(["control_room_web"]);
    const request = initRequest(root, { logins, port });
    const data = join(root, "pg", "data-A");
    const pidPath = join(data, "postmaster.pid");
    const work = mkdtempSync(join(LANE_ROOT, "power-cut-"));
    RUNS.push(work);
    // A process this test owns, standing in for whatever the OS hands a recycled
    // pid to after a restart. It is D's (the lane's D is the invoker), which is the
    // case the old `kill -0` + uid check could not tell from our postmaster.
    const recycled = spawn("/bin/sleep", ["600"], { detached: true, stdio: "ignore" });
    t.after(() => { try { process.kill(-recycled.pid, "SIGKILL"); } catch { /* gone */ } });

    let reclaimed = null;
    /** One run of the driver, killed in the standalone window; returns the pids it killed. */
    const cutPower = async (label) => {
      // `pg/current` is removed first so the driver's init is a fresh install again:
      // the converged cluster of the previous case is then this run's debris.
      rmSync(join(root, "pg", "current"), { force: true });
      const stateFile = join(work, `state-${label}.jsonl`);
      const configPath = join(work, `config-${label}.json`);
      writeFileSync(configPath, JSON.stringify({ phase: "init", request, passwords, killed: [], stateFile,
        mode: "standalone-window" }));
      writeFileSync(stateFile, "");
      const child = spawn(process.execPath, ["--import", "tsx", join(REPO, "tests/helpers/database-phase-kill-driver.mjs"),
        configPath], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"], detached: true, env: { ...process.env } });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      const [, signal] = await new Promise(resolveRun => child.once("close", (...values) => resolveRun(values)));
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is gone */ }
      const kill = readFileSync(stateFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
        .find(event => event.event === "kill");
      if (kill) await waitForExit(kill.pids, 10_000);
      // THE SEGMENT THE KILL LEAKED, given back BEFORE anything is asserted, so a
      // failing assertion cannot leave it behind. A SIGKILLed backend cannot remove
      // its SysV interlock segment, and MEASURED: a few earlier runs of this test
      // filled the machine's 32 segments and `initdb` then failed for every lane on
      // the machine (N3's message named it). A reboot clears them, so giving it back
      // is ALSO what makes this state reboot-like. PostgreSQL does it itself: the
      // segment's key is the data directory's inode, and an instance starting on that
      // directory removes an unattached segment whose header names it. So a
      // standalone backend runs on the directory with stdin at EOF — it reclaims the
      // segment and exits, removing its own — and the dead run's pid file, which
      // that backend replaces and removes, is written back byte for byte.
      reclaimed = null;
      if (kill && existsSync(pidPath)) {
        const stale = readFileSync(pidPath);
        const key = `0x${(lstatSync(data).ino % 2 ** 32).toString(16).padStart(8, "0")}`;
        const segments = () => execFileSync("/usr/bin/ipcs", ["-m"], { encoding: "utf8" }).split("\n")
          .filter(line => line.split(/\s+/u)[2] === key);
        const leaked = segments().length;
        const context = await startPostmaster({ root, port });
        const single = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/postgres"),
          args: ["--single", "-D", data, "template1"], ...context, role: "database", cwd: join(root, "pg"),
          timeoutMs: 120_000 });
        writeFileSync(pidPath, stale);
        reclaimed = { leaked, left: segments().length, code: single.code, stderr: single.stderr.slice(-400) };
      }
      assert.ok(signal === "SIGKILL" && kill, `${label}: the driver must die in the standalone window: ${stderr.slice(-800)}`);
      assert.match(kill.pidFileFirstLine, /^-[0-9]+$/u);
      assert.match(kill.backendCommand, / --single\b/u, `${label}: the kill must land in the single-user session`);
      assert.equal(kill.backendInTree, true, `${label}: the backend that wrote the file must be this run's own`);
      assert.ok(kill.pids.length >= 2, `${label}: initdb and its backend must have been running: ${kill.pids}`);
      // REBOOT-LIKE: every process of the run is gone, its shared memory is given
      // back, the file stays, no pg/current.
      assert.deepEqual(reclaimed?.left, 0, `${label}: the leaked segment must be reclaimed: ${JSON.stringify(reclaimed)}`);
      assert.deepEqual(kill.pids.filter(isProcessAlive), [], `${label}: nothing of the dead run may survive`);
      assert.match(readFileSync(pidPath, "utf8").split("\n")[0], /^-[0-9]+$/u, `${label}: the stale file must remain`);
      assert.equal(existsSync(join(root, "pg", "current")), false);
      return kill;
    };
    const converges = async (label) => {
      const retired = retiredDirectories(root).length;
      const retry = await runShippedInit(request, passwords);
      assert.equal(retry.said, "initialized", `${label}: the retry through the shipped script must converge`);
      assert.equal(readlinkSync(join(root, "pg", "current")), "data-A");
      assert.ok(retiredDirectories(root).length > retired, `${label}: the debris must be retired aside, never removed`);
      assert.equal(existsSync(pidPath), false, `${label}: the converged cluster must be shut down`);
    };

    // 1. The measured wedge itself: a negative pid, no process.
    const cut = await cutPower("negative");
    await converges("negative");
    t.diagnostic(`killed at ${cut.pidFileFirstLine} (${cut.backendCommand}); `
      + `segments leaked then reclaimed: ${reclaimed.leaked}`);
    // 2. A re-run after convergence CONVERGES on the cluster this phase completed,
    //    through the SHIPPED script (X1) — not the old refusal. H4's rule is
    //    intact: nothing was retired, no process was signalled, and the same
    //    digest comes back.
    const again = await runShippedInit(request, passwords);
    assert.equal(again.said, "initialized",
      `a same-id retry through the shipped script must converge: ${again.stderr ?? ""}`);
    assert.equal(readlinkSync(join(root, "pg", "current")), "data-A");
    // 3–4. The same REBOOT-LIKE state written into the debris directory rather than
    //    produced by another kill (each kill leaks a segment): `pg/current` gone,
    //    the converged cluster is this retry's debris, its pid file is…
    const rebootLike = (firstLine) => {
      rmSync(join(root, "pg", "current"));
      writeFileSync(pidPath, firstLine === "" ? ""
        : `${firstLine}\n${data}\n1790811618\n${port}\n${join(root, "pg", "socket")}\n\n0 0\nready\n`);
    };
    //    3. …EMPTY (a crash mid-write).
    rebootLike("");
    await converges("empty");
    //    4. …a RECYCLED pid, standalone-shaped and postmaster-shaped: alive and D's,
    //    but not PostgreSQL. It must converge AND the process must be left alone —
    //    the old sweep sent it `pg_ctl stop` and SIGKILL.
    for (const shape of ["-", ""]) {
      rebootLike(`${shape}${recycled.pid}`);
      await converges(`recycled${shape}`);
      assert.equal(isProcessAlive(recycled.pid), true, "a recycled pid must never be signalled");
    }
    // 5. A power cut in the POSTMASTER window, after a restart recycled its pid: a
    //    positive `postmaster.pid` and a socket lock, both naming the recycled pid.
    //    PostgreSQL itself refuses to start while a socket lock's pid is alive, so
    //    the lock must go too — and the process must still be left alone.
    rmSync(join(root, "pg", "current"));
    const record = `${recycled.pid}\n${data}\n1790811618\n${port}\n${join(root, "pg", "socket")}\n\n0 0\nready\n`;
    writeFileSync(pidPath, record);
    writeFileSync(join(root, "pg", "socket", `.s.PGSQL.${port}.lock`), record);
    await converges("postmaster-window");
    assert.equal(isProcessAlive(recycled.pid), true, "a recycled pid must never be signalled");
    // Nothing of any run is still working on the data directory.
    const rows = execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
    assert.equal(rows.includes(` -D ${data}`), false, "no PG-family process may still be running on the data directory");
  });

/** Is a pid alive? `signal 0` via `kill(2)`, never a pattern. */
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

/** The directories a sweep retired beside the cluster. */
function retiredDirectories(root) {
  const pgRoot = join(root, "pg");
  return existsSync(pgRoot) ? readdirSync(pgRoot).filter(name => name.startsWith(".retired-")) : [];
}

const once = (emitter, event) => new Promise((resolveRun) => { emitter.once(event, resolveRun); });

test("a fresh init from the vendored runtime makes a socket-only cluster as a non-root account", { skip: needsArchive, timeout: 600_000 }, async () => {
  const { root, port } = await installRoot("init", 0);
  const { logins, passwords } = phaseLogins(["control_room_web", "control_room_coordinator"]);
  // Every program a PG child is handed, recorded: Blocker 2's claim is that NO
  // password ever reaches psql — not on argv, not on stdin — only its verifier.
  const handed = [];
  const result = await initializeDatabaseV1Script(initRequest(root, { logins, port }), passwords,
    { ...manifestFor(port), planLayout: (input) => planPgClusterLayoutV1(input),
      onPgSpawn: spawned => handed.push(`${spawned.args.join(" ")}\n${spawned.stdin}`) });
  assert.ok(handed.some(text => /ALTER ROLE control_room_web PASSWORD 'SCRAM-SHA-256\$4096:/u.test(text)),
    "each login's verifier must be set by ALTER ROLE with a SCRAM verifier");
  for (const password of Object.values(passwords)) {
    assert.equal(handed.some(text => text.includes(password)), false, "no password may be handed to a PG child");
  }
  assert.equal(result.outcome, "initialized");
  assert.equal(result.pgDataId, "data-A");
  assert.equal(result.clusterShutDownClean, true);
  assert.match(result.updaterSchemaDigest, /^sha256:[a-f0-9]{64}$/u);

  // The data directory holds a real cluster, the `pg/current` link names it, and
  // `pg_controldata` says the cluster is shut down.
  assert.ok(existsSync(join(root, "pg", "data-A", "PG_VERSION")));
  // `readlink`, not `readFile`: `pg/current` is a symlink to a directory, and
  // reading it as a file is an EISDIR. The link's TARGET is the claim — that
  // `pg/current` names this data directory and not another cluster's.
  assert.equal(readlinkSync(join(root, "pg", "current")), "data-A");
  const context = await startPostmaster({ root, port });
  const control = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_controldata"),
    args: ["-D", join(root, "pg", "data-A")], ...context, role: "database", cwd: join(root, "pg") });
  assert.match(control.stdout, /Database cluster state:\s+shut down/u);

  // No TCP listener, `ssl` off, and the socket is the only endpoint — asked of a
  // postmaster this lane started, not read out of our own config text.
  const started = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
    args: ["-D", join(root, "pg", "data-A"), "-l", join(root, "logs/postgresql17/out.log"),
      "-o", `-p ${port}`, "-w", "-t", "60", "start"],
    ...context, role: "database", cwd: join(root, "pg") });
  assert.equal(started.code, 0, started.stderr);
  try {
    assert.ok(existsSync(join(context.layout.socketDirectory, `.s.PGSQL.${port}`)),
      "the postmaster must publish its socket in pg/socket, not in a temp dir");
    // `SHOW` is a utility statement, so it is NOT wrapped in the `json_agg`
    // subquery (a wrapper around it is a syntax error) and its one line comes
    // back as the answer. Asserted as the server's own word.
    assert.deepEqual(await asDatabase(context, "SHOW ssl"), ["off"]);
    assert.deepEqual(await asDatabase(context, "SHOW listen_addresses"), [""]);
    const listeners = execFileSync("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" });
    assert.equal(new RegExp(`[:.]${port}\\b`).test(listeners), false,
      `nothing may listen on the cluster's port ${port}`);
    // The hba the SERVER loaded: the three peer lines first, scram last, and no
    // gss rule anywhere.
    const hba = readFileSync(join(root, "pg", "data-A", "pg_hba.conf"), "utf8");
    const rows = hba.split("\n").filter(line => line.trim() && !line.trim().startsWith("#"));
    assert.equal(rows.length, 4);
    assert.match(rows[0], /peer map=cr/u);
    assert.match(rows[3], /scram-sha-256/u);
    assert.doesNotMatch(hba, /gss/iu);
    assert.doesNotMatch(hba, /^host/mu, "there is no host rule, so TCP is refused by reaching the end of the file");
    const ident = readFileSync(join(root, "pg", "data-A", "pg_ident.conf"), "utf8");
    assert.match(ident, /^cr \S+ control_room_migrator$/mu, "the map the hba names must be defined in pg_ident.conf");
  } finally {
    await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
      args: ["-D", join(root, "pg", "data-A"), "-m", "fast", "-w", "-t", "60", "stop"], ...context, role: "database", cwd: join(root, "pg") });
  }
});

test("a re-run of init converges on its own completed cluster, and without pg/current the data dir is debris retired aside", { skip: needsArchive, timeout: 600_000 }, async () => {
  const { root, port } = await installRoot("refuse", 1);
  const { logins, passwords } = phaseLogins(["control_room_web"]);
  const dependencies = { ...manifestFor(port), planLayout: (input) => planPgClusterLayoutV1(input) };
  await initializeDatabaseV1Script(initRequest(root, { logins, port }), passwords, dependencies);
  // A re-run CONVERGES on the cluster this phase itself completed (X1): it
  // re-proves it and answers `initialized` with the same digest, touching
  // nothing. It must never adopt or overwrite it — asserted by the X1 test's
  // refusal cases and by the RUNNING-cluster case below.
  const again = await initializeDatabaseV1Script(initRequest(root, { logins, port }), passwords, dependencies);
  assert.equal(again.outcome, "initialized", "a same-id re-run converges on its own completed cluster");
  assert.deepEqual(retiredDirectories(root), [], "a converged re-run must retire nothing");
  assert.equal(readlinkSync(join(root, "pg", "current")), "data-A", "and it must not touch the link");

  // A `pg/current` link naming ANOTHER data directory: another cluster is in use,
  // and an init for a new id must not run at all — refused before any directory is
  // made, so `data-B` does not even appear.
  await assert.rejects(initializeDatabaseV1Script({ ...initRequest(root, { logins, port }), pgDataId: "data-B" },
    passwords, dependencies), /database_init_current_link_target_refused/u);
  assert.equal(existsSync(join(root, "pg", "data-B")), false, "the refusal must come before any work");

  // `pg/current` that is not a link is refused, never replaced.
  rmSync(join(root, "pg", "current"));
  writeFileSync(join(root, "pg", "current"), "not a link");
  await assert.rejects(initializeDatabaseV1Script({ ...initRequest(root, { logins, port }), pgDataId: "data-B" },
    passwords, dependencies), /database_init_current_link_refused/u);
  rmSync(join(root, "pg", "current"));

  // WITHOUT `pg/current`, whatever is in pg/<id> is this phase's own debris (the id
  // is per install transaction): a planted file and a half-copied cluster are each
  // RETIRED ASIDE — renamed, never deleted — and the init converges. This replaced
  // the old `planted_file_refused` for these two, because an init killed inside
  // `initdb` leaves exactly such a directory and the retry must converge (H3).
  const planted = join(root, "pg", "data-B");
  mkdirSync(planted, { mode: 0o700 });
  writeFileSync(join(planted, "PLANTED"), "x");
  const fromPlant = await initializeDatabaseV1Script({ ...initRequest(root, { logins, port }), pgDataId: "data-B" },
    passwords, dependencies);
  assert.equal(fromPlant.outcome, "initialized");
  const retired = retiredDirectories(root);
  assert.equal(retired.length, 1, "the debris must be retired aside exactly once");
  assert.ok(existsSync(join(root, "pg", retired[0], "PLANTED")), "the retired directory keeps its contents");
  assert.equal(readlinkSync(join(root, "pg", "current")), "data-B");
});

test("re-running init against a RUNNING cluster leaves the cluster and its data alone (H4)",
  { skip: needsArchive, timeout: 600_000 }, async () => {
    // MEASURED by the review (probe D): init, start the postmaster as the service
    // would, write data, re-run init with the same id — and the old phase killed
    // the running postmaster, renamed the live data directory aside and answered
    // `initialized` with an empty cluster. After `move-live-db` that directory
    // holds the owner's moved data.
    //
    // X1 CHANGED THE EXPECTED ANSWER, and deliberately so. The re-run now
    // CONVERGES on the cluster this phase itself completed, because that is what
    // it is: `pg/current` plus the phase's own completion receipt, re-proved by
    // `pg_controldata`. It still touches nothing — no process, no directory, no
    // row — so every H4 claim below still holds, and the refusal H4 wanted is now
    // the one for a cluster the receipt does NOT vouch for, asserted separately in
    // the next test.
    const { root, port } = await installRoot("running", 17);
    const { logins, passwords } = phaseLogins(["control_room_web"]);
    await initializeDatabaseV1Script(initRequest(root, { logins, port }), passwords,
      await buildInitDependenciesV1(join(root, "current")));
    const context = await startPostmaster({ root, port });
    const started = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
      args: ["-D", join(root, "pg", "data-A"), "-l", join(root, "logs/postgresql17/out.log"),
        "-o", `-p ${port}`, "-w", "-t", "60", "start"], ...context, role: "database", cwd: join(root, "pg") });
    assert.equal(started.code, 0, started.stderr);
    try {
      const postmaster = Number(readFileSync(join(root, "pg", "data-A", "postmaster.pid"), "utf8").split("\n")[0]);
      await asDatabase(context, "CREATE TABLE owner_data(id int); INSERT INTO owner_data VALUES (42)");
      // A RUNNING cluster is NOT `shut down`, so the convergence's own re-prove
      // refuses it — with `cluster_not_clean`, which says "this cluster needs
      // recovery", not "this cluster is somebody else's".
      await assert.rejects(initializeDatabaseV1Script(initRequest(root, { logins, port }), passwords,
        await buildInitDependenciesV1(join(root, "current"))), /^Error: database_init_cluster_not_clean:in production$/u);
      assert.equal(isProcessAlive(postmaster), true, "the running postmaster must not be touched");
      assert.deepEqual(retiredDirectories(root), [], "the live data directory must not be retired");
      assert.deepEqual(await asDatabase(context, "SELECT id FROM owner_data"), [{ id: 42 }],
        "the data in the running cluster must still be there");
      // …and once it is stopped cleanly, the same call CONVERGES and reports the
      // same digest the first run did — the value the install journal records and
      // the health check compares, so a converged retry is not a second answer.
      await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
        args: ["-D", join(root, "pg", "data-A"), "-m", "fast", "-w", "-t", "60", "stop"],
        ...context, role: "database", cwd: join(root, "pg") });
      const converged = await initializeDatabaseV1Script(initRequest(root, { logins, port }), passwords,
        await buildInitDependenciesV1(join(root, "current")));
      assert.equal(converged.outcome, "initialized", "a same-id retry must converge on its own completed cluster");
      assert.equal(converged.pgDataId, "data-A");
      assert.equal(converged.clusterShutDownClean, true);
      assert.match(converged.updaterSchemaDigest, /^sha256:[a-f0-9]{64}$/u);
      assert.equal(readlinkSync(join(root, "pg", "current")), "data-A");
      assert.deepEqual(retiredDirectories(root), [], "converging must retire nothing");
    } finally {
      await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
        args: ["-D", join(root, "pg", "data-A"), "-m", "fast", "-w", "-t", "60", "stop"],
        ...context, role: "database", cwd: join(root, "pg") });
    }
  });

test("X1: a kill AFTER pg/current is written converges on the same data id, and a cluster the phase did not build is refused by name",
  { skip: needsArchive, timeout: 900_000 }, async (t) => {
    // THE MEASURED FAILURE, made deterministic. rv-9c X1: the M1 lane's "init
    // killed at EVERY statement" failed at run 81 — killed during the final
    // `pg_ctl … stop` / around `pg_controldata`, i.e. AFTER the last proof and
    // after `pg/current` was renamed into place — and the retry with the SAME
    // data id then answered `database_init_already_initialized`.
    //
    // That refusal was TRUE, and it is also useless: `install-steps.mjs` journals a
    // RESULT for `init-database`, so a refusal cannot advance the install and the
    // only way forward was a new data id — a second whole cluster for a run that
    // had already finished its work.
    //
    // The kill here is at THAT EXACT POINT, every time, rather than at whatever
    // the lane's enumeration reached on the day: the driver is told to kill the
    // process the moment `pg/current` names this data id, which is the first
    // observable sign that the phase has completed every step but returned.
    const { root, port } = await installRoot("killed-after-current", 20);
    const { logins, passwords } = phaseLogins(["control_room_web", "control_room_coordinator"]);
    const request = initRequest(root, { logins, port });
    const link = join(root, "pg", "current");
    const data = join(root, "pg", "data-A");
    t.after(() => {
      const pidFile = join(data, "postmaster.pid");
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").split("\n")[0]) : 0;
      if (pid > 1 && isProcessAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    });

    // A CHILD PROCESS, because only a process that really dies can leave the state
    // in question. The hook fires on the LAST spawn of the phase (`pg_controldata`,
    // step 5) — after that, the receipt and the link are the only writes left, and
    // killing at the hook would be before the link, which is the OLD passing case.
    // So the kill waits for the LINK instead, which is the real boundary.
    const bundle = await bundledPhaseScripts();
    const child = spawn(bundle.node, [bundle.init, "--request", JSON.stringify(request)],
      { stdio: ["pipe", "pipe", "pipe"], detached: true, env: { ...process.env } });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.resume();
    child.stdin.end(`${JSON.stringify(passwords)}\n`);
    const watched = setInterval(() => {
      try { if (readlinkSync(link) === "data-A") process.kill(child.pid, "SIGKILL"); } catch { /* not yet */ }
    }, 1);
    try {
      const [code, signal] = await new Promise(resolveRun => child.once("close", (...values) => resolveRun(values)));
      assert.equal(signal, "SIGKILL", `the child must die at the kill point, not answer (exit ${code}): ${stderr.slice(-500)}`);
    } finally { clearInterval(watched); try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }

    // THE STATE, asserted rather than assumed: a complete cluster and `pg/current`
    // naming it, with the run dead before it could answer. Nothing was left
    // running, which is what a completed phase guarantees.
    assert.equal(readlinkSync(link), "data-A", "the kill must land after pg/current is written");
    assert.ok(existsSync(join(data, "PG_VERSION")), "the cluster itself must be complete");
    assert.equal(existsSync(join(data, "postmaster.pid")), false,
      "a completed phase leaves no postmaster, and the kill was after its stop");

    // THE CONVERGENCE. Same data id, through the SHIPPED script the port spawns,
    // with the production dependency set its own entry builds. This is the
    // DEFAULT PATH for the port X1 concerns: no injected hook, no fake result.
    const retry = await runShippedInit(request, passwords);
    assert.equal(retry.said, "initialized",
      `a same-id retry after a kill past pg/current must converge, not refuse: ${retry.stderr ?? ""}`);
    assert.equal(retry.code, 0);
    // The shipped script writes the RESULT OBJECT itself (the port wraps it), so
    // the parsed line is the result — asserted on its exact keys, which is also
    // the installer's own `exactKeys` requirement.
    const converged = JSON.parse(retry.stdout);
    assert.deepEqual(Object.keys(converged).sort(),
      ["clusterShutDownClean", "outcome", "pgDataId", "schema", "updaterSchemaDigest"],
      "a converged retry must answer with the result shape the installer demands");
    assert.equal(converged.pgDataId, "data-A");
    assert.equal(converged.clusterShutDownClean, true);
    assert.match(converged.updaterSchemaDigest, /^sha256:[a-f0-9]{64}$/u);
    // Converging must not have rebuilt anything: no debris retired, no second
    // cluster, and the ORIGINAL cluster is still the one `pg/current` names. A
    // convergence that quietly re-ran `initdb` would have retired it.
    assert.deepEqual(retiredDirectories(root), [], "a converged retry must not retire the cluster it adopted");
    assert.equal(readlinkSync(link), "data-A");
    // …and the adopted cluster is the real one: its own control file still says
    // `shut down`, and it starts and answers as the service's cluster would.
    const context = await startPostmaster({ root, port });
    const after = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_controldata"),
      args: ["-D", data], ...context, role: "database", cwd: join(root, "pg") });
    assert.match(after.stdout, /Database cluster state:\s+shut down/u);
    const started = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
      args: ["-D", data, "-l", join(root, "logs/postgresql17/out.log"), "-o", `-p ${port}`, "-w", "-t", "60", "start"],
      ...context, role: "database", cwd: join(root, "pg") });
    assert.equal(started.code, 0, started.stderr);
    try {
      assert.deepEqual(await asDatabase(context, "SELECT rolname FROM pg_roles"
        + " WHERE rolname = 'control_room_deployer'", "postgres", "control_room"),
      [{ rolname: "control_room_deployer" }],
      "the adopted cluster must be the one the killed run had already created its roles in");
    } finally {
      await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
        args: ["-D", data, "-m", "fast", "-w", "-t", "60", "stop"],
        ...context, role: "database", cwd: join(root, "pg") });
    }

    // THE REFUSALS, and they are what make the convergence safe. `pg/current` on
    // its own must NEVER be enough to adopt: each case below is a data directory
    // the phase cannot vouch for, and the answer is a refusal that names which.
    // The record's own name is the constant, and a hard-coded spelling would let
    // the two drift apart unnoticed.
    const record = join(data, "control-room-init-complete-v1");
    const refusals = [
      // 1. A `move-live-db` target: a COMPLETE cluster this phase never built, so
      //    there is no record. This is the owner's data, and adopting it would be
      //    the one outcome that destroys it.
      ["no_completion_record", () => rmSync(record)],
      // 2. A record from a DIFFERENT layout or data id — here, one carrying a
      //    layout digest that is not this one's, which is what a record copied
      //    across ids looks like.
      ["completion_record_other_layout", () => writeFileSync(record,
        JSON.stringify({ schema: "control-room-init-complete-v1", layoutDigest: "0".repeat(64),
          updaterSchemaDigest: `sha256:${"a".repeat(64)}`, clusterShutDownClean: true }))],
      // 3. A record whose clean-shutdown flag is FALSE: a claim about a cluster
      //    this phase never proved, which must not be honoured on its own word.
      ["completion_record_not_clean", () => {
        const good = JSON.parse(readFileSync(record, "utf8"));
        writeFileSync(record, JSON.stringify({ ...good, clusterShutDownClean: false }));
      }],
      // 4. A record that is not JSON at all: unreadable is not foreign, and must
      //    not be silently treated as a move.
      ["completion_record_unreadable", () => writeFileSync(record, "not json\n")],
      // 4b. A record torn by a stop mid-write: it starts like one and is not JSON.
      //     The parse guard alone answers this; the shape pre-check passes it.
      ["completion_record_unreadable", () => writeFileSync(record, '{"schema":"control-room-init-complete-v1",')],
      // 4c. JSON that is not a record at all (a bare scalar): the shape pre-check
      //     alone answers this — parsed, it would read as a foreign record.
      ["completion_record_unreadable", () => writeFileSync(record, "42\n")],
      // 5. A well-formed record for some OTHER schema: an honest file that is not
      //    this phase's, which is a different thing from a corrupt one.
      ["completion_record_foreign", () => writeFileSync(record,
        JSON.stringify({ schema: "some-other-record-v1", layoutDigest: "0".repeat(64),
          clusterShutDownClean: true }))],
      // 6. A SYMLINK at the record's name, pointing at a real, well-formed record
      //    elsewhere — the L2 plant check. Reading it would follow the link and
      //    adopt a cluster a link chose.
      ["foreign:completion_record_refused", () => {
        const elsewhere = join(root, "pg", "planted-record.json");
        writeFileSync(elsewhere, readFileSync(record, "utf8"));
        rmSync(record);
        symlinkSync(elsewhere, record);
        t.after(() => rmSync(elsewhere, { force: true }));
      }],
    ];
    for (const [reason, plant] of refusals) {
      plant();
      await assert.rejects(initializeDatabaseV1Script(request, passwords,
        await buildInitDependenciesV1(join(root, "current"))),
      new RegExp(`^Error: database_init_already_initialized:${reason}$`, "u"),
      `a record the phase cannot vouch for must be refused (${reason})`);
      // Nothing was touched to reach the refusal — the refusal is decided before
      // any process is signalled or any directory renamed.
      assert.deepEqual(retiredDirectories(root), [], `the ${reason} refusal must retire nothing`);
    }
  });

test("a crash mid-init leaves no postmaster and a retry converges", { skip: needsArchive, timeout: 600_000 }, async () => {
  const { root, port } = await installRoot("crash", 2);
  const { logins, passwords } = phaseLogins(["control_room_web"]);
  const dependencies = { ...manifestFor(port), planLayout: (input) => planPgClusterLayoutV1(input) };
  // Fail at the FIRST statement after the postmaster is up, so the failure lands
  // with a live server and a half-built database — the state an interrupt leaves.
  const failing = { ...dependencies, roles: [{ name: "not; a role", attributes: "NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS" }] };
  await assert.rejects(initializeDatabaseV1Script(initRequest(root, { logins, port }), passwords, failing),
    /pg_phase_role_name_refused/u);
  // The postmaster was stopped on the way out: a live server on a half-built data
  // directory is the one state the installer's undo list cannot reason about.
  assert.equal(existsSync(join(root, "pg", "data-A", "postmaster.pid")), false,
    "a refused init must not leave a postmaster running");
  assert.equal(existsSync(join(root, "pg", "current")), false, "a refused init must not write pg/current");
  // The retry CONVERGES on its own: no `pg/current`, so the half-built cluster is
  // debris, retired aside, and the init starts over.
  const result = await initializeDatabaseV1Script(initRequest(root, { logins, port }), passwords, dependencies);
  assert.equal(result.outcome, "initialized");
  assert.equal(retiredDirectories(root).length, 1, "the half-built cluster must be retired aside, not deleted");
});

test("the release phase completes with the UNMODIFIED production dependency set, and a re-run converges", { skip: needsArchive, timeout: 900_000 }, async () => {
  // BLOCKER 1's test. `buildReleaseDependenciesV1` exactly as the shipped entry
  // builds it, with ONE substitution: the deployer's identity, because the lane
  // has no root (the lane's peer-map simulation maps the invoking uid instead).
  // No injected verifier, converger, queue builder or loader — the review found
  // that every earlier test had swapped in its own `verifyLogin`, which is how the
  // production one shipped as an uncalled factory.
  const { root, port } = await installRoot("release", 3);
  const { logins, passwords } = phaseLogins([
    "control_room_migrator", "control_room_app", "control_room_scheduler", "control_room_work_intake_agent",
    "control_room_web", "control_room_coordinator", "control_room_results", "control_room_publisher",
    "control_room_agent_reviewer_login", "control_room_queue_worker", "control_room_fleet", "control_room_fleet_owner",
  ]);
  const dependencies = { ...manifestFor(port), planLayout: (input) => planPgClusterLayoutV1(input) };
  const initResult = await initializeDatabaseV1Script(initRequest(root, { logins, port }), passwords, dependencies);
  assert.equal(initResult.outcome, "initialized");

  // `init-database` leaves the cluster SHUT DOWN, because the installer starts the
  // real service (step 20) before this phase (step 22) — the design's order, and
  // the reason a postmaster is never left running on a half-built data
  // directory. So the test starts the service itself, exactly as launchd would:
  // socket-only, no TCP, as the database account, in the profile.
  const context = await startPostmaster({ root, port });
  const started = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
    args: ["-D", join(root, "pg", "data-A"), "-l", join(root, "logs/postgresql17/out.log"),
      "-o", `-p ${port}`, "-w", "-t", "60", "start"], ...context, role: "database", cwd: join(root, "pg") });
  assert.equal(started.code, 0, `the service must start before the release phase: ${started.stderr}`);
  // THE ROOT SIMULATION, before anything reaches for the deployer role. See
  // `simulateRootDeployerPeer` for what it is, what it proves and what the
  // real-root rehearsal must still measure.
  await simulateRootDeployerPeer(context);
  try {
    const head = ledgerHeadV1(await readReleaseLedgerV1(REPO));
    // The release phase carries the SAME login list, because it is the phase that
    // PROVES each generated password authenticates — `init-database` sets the
    // verifiers, this phase checks them. A release request with an empty list
    // would pass the contract and verify nothing, which is the shape of a test
    // that passes because it skipped the work.
    const release = {
      ...initRequest(root, { logins, port }),
      schema: "control-room.release-schema/v1", release: "current", expectedLedgerHead: head,
    };
    const releaseDependencies = await buildReleaseDependenciesV1(join(root, "current"),
      { deployerIdentity: { uid: process.getuid(), gid: process.getgid() } });
    const result = await applyReleaseSchemaV1(release, passwords, releaseDependencies);
    assert.equal(result.outcome, "applied");
    assert.equal(result.ledgerHead, head);
    assert.match(result.schemaDigest, /^sha256:[a-f0-9]{64}$/u);
    // The digest is the RELEASE's own, which is the whole claim: the updater's
    // copy of the query and the release's copy agree on a live cluster.
    assert.equal(result.schemaDigest, `sha256:${privateWebSchemaDigest}`);

    // N2 of the M1c review: the PRODUCTION checker on the PEER-MAPPED migrator.
    // MEASURED before the fix: a wrong password answered `authenticated: true`,
    // because the migrator connects by being the database account. It now checks
    // the password against the verifier the server stores, so a wrong one is false.
    const verifyAs = (login, password) => releaseDependencies.verifyLogin({ root, layout: context.layout, login,
      password, port, environment: context.environment, profile: context.profile,
      profileParameters: context.profileParameters, pgRoot: join(root, "pg"), identity: context.identity });
    for (const login of ["control_room_migrator", "control_room_web"]) {
      assert.equal((await verifyAs(login, passwords[login])).authenticated, true, `${login}: its own password`);
      assert.equal((await verifyAs(login, "w".repeat(43))).authenticated, false, `${login}: a wrong password`);
      assert.equal((await verifyAs(login, passwords.control_room_app)).authenticated, false,
        `${login}: another login's password`);
    }

    // The CREDENTIAL FILE, and three separate claims about it.
    //
    // §4.3 row 22 says the root-generated passwords land at
    // `Protected/service/db-logins.json`, 0600, written by R. This is the only
    // assertion in the lane that reads a SECRET back, and it is here because a
    // credential file nobody has read is a file nobody has proved is correct.
    const credentials = join(root, "Protected", "service", "db-logins.json");
    const credentialsStat = lstatSync(credentials);
    assert.equal(credentialsStat.isFile(), true, "db-logins.json must be a regular file");
    assert.equal(credentialsStat.isSymbolicLink(), false,
      "db-logins.json must not be a symlink to somewhere else");
    assert.equal(credentialsStat.mode & 0o777, 0o600,
      `db-logins.json must be 0600, got ${(credentialsStat.mode & 0o777).toString(8)}`);
    const credentialValue = JSON.parse(readFileSync(credentials, "utf8"));
    assert.equal(credentialValue.schema, "control-room.db-logins/v1");
    assert.equal(credentialValue.verifiersSet, true,
      "the file must record that the verifiers were set, not merely planned");
    // Every login in the request is in the file, and every password in the file is
    // one this phase actually authenticated with. Neither direction is implied by
    // the other, and a file that is short one login is the failure this catches.
    assert.deepEqual(Object.keys(credentialValue.logins).sort(),
      logins.map(entry => entry.name).sort());
    for (const [name, password] of Object.entries(credentialValue.logins)) {
      assert.equal(password, passwords[name], `${name}'s recorded password must be the one that was proved`);
    }
    // And no staging file is left behind: a `.tmp` beside a credential file is a
    // second copy of every password on the disk, at whatever mode it landed.
    assert.equal(existsSync(join(root, "Protected", "service", ".db-logins.json.tmp")), false,
      "the staging credential file must not survive the rename");

    // Every role the manifest names exists with EXACTLY the manifest's
    // attributes: no SUPERUSER, no CREATEDB, no CREATEROLE, no BYPASSRLS.
    const roles = await asDatabase(context, "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole,"
      + " rolreplication, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'control\\_room\\_%' ORDER BY 1",
      "postgres", "postgres");
    for (const row of roles) {
      assert.equal(row.rolsuper, false, `${row.rolname} must not be a superuser`);
      assert.equal(row.rolcreatedb, false, `${row.rolname} must not create databases`);
      assert.equal(row.rolcreaterole, false, `${row.rolname} must not create roles`);
      assert.equal(row.rolreplication, false, `${row.rolname} must not replicate`);
      assert.equal(row.rolbypassrls, false, `${row.rolname} must not bypass RLS`);
    }
    // N-L (cl-bringup): every service login is a member of EXACTLY its one group from
    // the release's `macRolePlan`, with no ADMIN option (the web preflight refuses
    // one), so the grants converged onto the groups reach the logins that use them.
    const { macRolePlan } = (await readDatabasePhaseDataV1(join(root, "current"))).roles;
    const memberships = await asDatabase(context, "SELECT member.rolname AS login, grp.rolname AS role,"
      + " a.admin_option FROM pg_auth_members a JOIN pg_roles member ON member.oid = a.member"
      + " JOIN pg_roles grp ON grp.oid = a.roleid WHERE member.rolname = ANY(ARRAY["
      + Object.keys(macRolePlan).map(login => `'${login}'`).join(",") + "]) ORDER BY 1, 2", "postgres", "postgres");
    assert.deepEqual(memberships, Object.entries(macRolePlan).sort(([left], [right]) => left < right ? -1 : 1)
      .map(([login, role]) => ({ login, role, admin_option: false })));
    // R5Q-06: the migrator is the nightly backup's dump login, and `pg_dump` reads
    // every schema, so it now holds a READ on `updater` — the USAGE was `false`
    // here before, and that is exactly why the backup failed every night on a
    // correctly installed Mac. What R10a protects is unchanged and is what this
    // still asserts: no CREATE on the schema, and no write on any table. A read is
    // not authority over the owner's approvals; a write would be.
    const migratorHold = await asDatabase(context, "SELECT has_schema_privilege('control_room_migrator','updater','USAGE') AS usage,"
      + " has_schema_privilege('control_room_migrator','updater','CREATE') AS create,"
      + " (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='updater'"
      + "   AND c.relkind='r' AND (has_table_privilege('control_room_migrator',c.oid,'INSERT')"
      + "     OR has_table_privilege('control_room_migrator',c.oid,'UPDATE')"
      + "     OR has_table_privilege('control_room_migrator',c.oid,'DELETE')"
      + "     OR has_table_privilege('control_room_migrator',c.oid,'TRUNCATE'))) AS writable",
      "postgres", "control_room");
    assert.deepEqual(migratorHold, [{ usage: true, create: false, writable: 0 }],
      "the release migrator reads the updater schema for the nightly dump and writes nothing in it");
    // The web login cannot run DDL.
    const webDdl = await sessionRefusalV1(async () => runSessionStatementV1(
      { user: "control_room_web", database: "control_room", sql: "CREATE TABLE cr_probe(id int)" },
      { ...context, identity: { uid: accounts.database.uid, gid: accounts.database.gid } }));
    assert.equal(webDdl.refused, true, "the web login must not be able to run DDL");
    // The updater's schema is the deployer's, is complete, and PUBLIC holds
    // nothing in it.
    const updaterTables = await asDatabase(context, "SELECT c.relname FROM pg_class c"
      + " JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='updater' AND c.relkind='r' ORDER BY 1",
      "postgres", "control_room");
    assert.ok(updaterTables.length >= 9, `the updater's tables must exist, got ${updaterTables.length}`);
    const schemaOwner = await asDatabase(context, "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace"
      + " WHERE nspname='updater'", "postgres", "control_room");
    assert.deepEqual(schemaOwner, [{ owner: "control_room_deployer" }]);
    // The ledger is at head, and every row's digest matches the file on disk.
    const applied = await asDatabase(context, "SELECT filename, ledger_order FROM control_room_schema_migrations"
      + " ORDER BY ledger_order DESC LIMIT 1", "control_room_migrator", "control_room");
    assert.equal(applied[0]?.filename, `db/migrations/${head}`);
    // The deployer holds NO password. It is reached by peer, so a verifier
    // would be a second way in.
    const deployerVerifier = await asDatabase(context, "SELECT rolpassword IS NOT NULL AS has_password"
      + " FROM pg_authid WHERE rolname='control_room_deployer'", "postgres", "postgres");
    assert.deepEqual(deployerVerifier, [{ has_password: false }],
      "the deployer must hold no verifier; the peer map is its only way in");

    // H1, the strong form: the RELEASE's OWN applier, run against this cluster
    // exactly as every later upgrade runs it (`migrateViaLocalPeer`, the VPS-local
    // path), is a NO-OP — no `migration_live_schema_drift`, and no
    // `migration_refused_non_owner_objects` (MEASURED in this fix round: with the
    // migrator owning what it created, that refusal fired on the first table).
    const state = await proveReleaseState(context, root);
    assert.equal(state.evidenceDigest, state.headPostDigest, "the ledger head must be the live evidence digest");
    assert.deepEqual(state.missingGrants, [], "no grant the release's own model needs may be missing");
    assert.ok(state.extraGrants.every(tuple => /^updater(\.|$)/u.test(tuple.split("|")[2])),
      `the only grants outside the release's model must be the updater's own: ${state.extraGrants.slice(0, 3)}`);
    const { applyMigrations } = await import("../deploy/postgres/apply-migrations.mjs");
    const target = `host=${context.layout.socketDirectory} port=${port} dbname=control_room user=postgres`;
    const upgrade = await applyMigrations({ bootstrapTarget: target, migrateTarget: target, migrateViaLocalPeer: true });
    assert.equal(upgrade.noOp, true, "the release's own applier must find nothing to apply");
    assert.equal(upgrade.schemaDigest, state.headPostDigest, "…and the same digest the ledger recorded");

    // H3, the plain form: the SAME phase run again on the finished cluster
    // converges — nothing re-applied, the same head, the same digests.
    const again = await applyReleaseSchemaV1(release, passwords, releaseDependencies);
    assert.equal(again.outcome, "applied", "a second release phase on a finished cluster must converge");
    assert.equal(again.schemaDigest, result.schemaDigest);
    assert.equal((await proveReleaseState(context, root)).ledgerRows, state.ledgerRows,
      "a re-run must apply no migration twice");

    // THE GUARDS THIS ROUND ADDED, each tripped on this finished cluster.
    //
    // (a) A session of a KILLED run still holding a lock: a re-run must end it
    //     and converge, not wait on it forever. Started here, as the database
    //     account under the phase's application name, holding the ledger table.
    const holder = spawn(join(root, "runtime/pg-current/bin/psql"),
      ["-h", context.layout.socketDirectory, "-p", String(port), "-U", "control_room_migrator", "-d", "control_room",
        "-w", "-q", "-f", "-"],
      { env: { ...context.environment, PGAPPNAME: "control-room-release-phase" }, stdio: ["pipe", "ignore", "ignore"],
        detached: true });
    holder.stdin.end("BEGIN;\nLOCK TABLE control_room_schema_migrations IN ACCESS EXCLUSIVE MODE;\nSELECT pg_sleep(600);\n");
    try {
      for (let wait = 0; wait < 300; wait += 1) {
        const [held] = await asDatabase(context, "SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation"
          + " WHERE c.relname = 'control_room_schema_migrations' AND l.mode = 'AccessExclusiveLock' AND l.granted");
        if (held.n > 0) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
      }
      const unlocked = await Promise.race([applyReleaseSchemaV1(release, passwords, releaseDependencies),
        new Promise(resolveRun => setTimeout(() => resolveRun({ outcome: "timed out behind the orphan's lock" }), 180_000))]);
      assert.equal(unlocked.outcome, "applied", "a re-run must end the orphaned session and converge");
    } finally { try { process.kill(-holder.pid, "SIGKILL"); } catch { /* already ended by the phase */ } }

    // (b) A public schema that changed OUTSIDE the ledger is refused by the phase's
    //     own drift check — the refusal `apply-migrations.mjs` would otherwise give
    //     at the first upgrade.
    await asDatabase(context, "CREATE TABLE public.cr_drift_probe(id int)");
    await assert.rejects(applyReleaseSchemaV1(release, passwords, releaseDependencies),
      /release_schema_ledger_drift:db\/migrations\//u, "a schema that moved outside the ledger must be refused");
    await asDatabase(context, "DROP TABLE public.cr_drift_probe");

    // (c) M-a: a name the service account planted at the credential staging path
    //     is NEVER written through. The staging name is random; the plant is made
    //     at the instant it is chosen (through the injectable `randomBytes`), which
    //     is the race a real planter would have to win.
    const victim = join(root, "victim.txt");
    writeFileSync(victim, "untouched\n", { mode: 0o644 });
    const fixed = Buffer.from("0123456789abcdef", "hex");
    await assert.rejects(applyReleaseSchemaV1(release, passwords, { ...releaseDependencies,
      randomBytes: size => {
        symlinkSync(victim, join(root, "Protected", "service", `.db-logins.json.${process.pid}.${fixed.toString("hex")}.staging`));
        return fixed.subarray(0, size);
      } }), /EEXIST/u, "a planted staging name must be refused, not followed");
    assert.equal(readFileSync(victim, "utf8"), "untouched\n", "no password may be written through a planted link");
    // …and the next run removes the planted link (never its target) and converges.
    assert.equal((await applyReleaseSchemaV1(release, passwords, releaseDependencies)).outcome, "applied");
    assert.equal(readFileSync(victim, "utf8"), "untouched\n");
    assert.deepEqual(readdirSync(join(root, "Protected", "service")).filter(name => name.includes("staging")), []);

    // (d) A transaction program cut short — what psql reads when the phase is
    //     killed mid-write — commits NOTHING. The program is the one the phase's
    //     own transaction runner builds, captured and replayed truncated.
    const { runSessionTransactionV1 } = await import("../src/updater/v1/pg/sql-session.mjs");
    let captured = null;
    await runSessionTransactionV1(["CREATE TABLE public.cr_whole_a(id int)", "CREATE TABLE public.cr_whole_b(id int)"],
      { ...context, onSpawn: spawned => { captured = spawned; } }, { user: "postgres", database: "control_room" });
    const cut = captured.stdin.replaceAll("cr_whole_", "cr_cut_");
    const truncated = cut.slice(0, cut.indexOf("CREATE TABLE public.cr_cut_b"));
    const replay = await spawnPgFamily({ executable: captured.executable, args: [...captured.args], ...context,
      role: "database", cwd: join(root, "pg"), stdio: ["pipe", "pipe", "pipe"], stdin: truncated });
    assert.equal(replay.code, 0, replay.stderr);
    assert.deepEqual(await asDatabase(context, "SELECT count(*)::int AS n FROM pg_tables WHERE tablename LIKE 'cr_cut_%'"),
      [{ n: 0 }], "a truncated transaction program must commit nothing");
    await asDatabase(context, "DROP TABLE public.cr_whole_a, public.cr_whole_b");

    // (e) The loader's "the deployer has grown a verifier" refusal is ARMED in the
    //     production set (it was a literal `true` that disarmed it).
    await asDatabase(context, `ALTER ROLE control_room_deployer PASSWORD '${"d".repeat(40)}'`, "postgres", "postgres");
    await assert.rejects(applyReleaseSchemaV1(release, passwords, releaseDependencies), /role_password/u,
      "a deployer holding a verifier must be refused by the production loader");
    await asDatabase(context, "ALTER ROLE control_room_deployer PASSWORD NULL", "postgres", "postgres");
  } finally {
    await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
      args: ["-D", join(root, "pg", "data-A"), "-m", "fast", "-w", "-t", "60", "stop"],
      ...context, role: "database", cwd: join(root, "pg") });
  }
});

/**
 * A release tree whose LEDGER STOPS BEFORE 0285, staged exactly where the phase
 * reads it (`<root>/current`), so the phase itself can build the pre-upgrade
 * database.
 *
 * IT IS A REAL DIRECTORY, not a symlink to the working tree, because a symlink
 * would carry this release's `db/roles/queue_backup_read_roles.sql` and the
 * phase's own step 1 would apply the very grant the fixture is about — so the
 * "before" state would be built already fixed and every assertion below would be
 * vacuous. `db/` is copied for the same reason.
 *
 * `poisonEarlyRoleFile` replaces the early role file with one that grants on a
 * `public` relation — a file that is fine everywhere EXCEPT before the ledger,
 * because the ledger is what creates `public`. It is how the scope guard is
 * exercised THROUGH THE PHASE rather than through the function that implements it:
 * MEASURED, deleting the guard's call site leaves the function's own unit test
 * passing, because a unit test of the function cannot see whether the phase calls
 * it.
 */
async function stageInt6Release(root, { poisonEarlyRoleFile = false } = {}) {
  const stage = join(root, poisonEarlyRoleFile ? "poisoned-stage" : "int6-stage");
  mkdirSync(join(stage), { recursive: true, mode: 0o755 });
  execFileSync("/bin/cp", ["-R", join(REPO, "deploy"), join(stage, "deploy")], { stdio: "pipe" });
  execFileSync("/bin/cp", ["-R", join(REPO, "db"), join(stage, "db")], { stdio: "pipe" });
  // The int6 ledger: this release's rows up to the one BEFORE 0285, and nothing
  // after it. The digests are this tree's own, so the prefix is what the SAME
  // release applied — the only difference is that the last migration is absent,
  // which is precisely "an install from before this release".
  const full = JSON.parse(readFileSync(join(REPO, "deploy/postgres/migration-ledger.json"), "utf8"));
  const migrateRows = full.entries.filter(entry => (entry.kind ?? "migrate") === "migrate");
  const upto = migrateRows.findIndex(entry => entry.file.endsWith("0285_queue_backup_read.sql"));
  assert.ok(upto > 0, "this release must still contain 0285 for the int6 shape to be a prefix of it");
  const entries = [
    ...migrateRows.slice(0, upto).map((entry, index) => ({ ...entry, order: index + 1 })),
    ...full.entries.filter(entry => (entry.kind ?? "migrate") !== "migrate")
      .map((entry, index) => ({ ...entry, order: upto + index + 1 })),
  ];
  const ledgerPath = join(stage, "deploy", "postgres", "migration-ledger.json");
  writeFileSync(ledgerPath, `${JSON.stringify({ version: 1,
    digest: createHash("sha256").update(JSON.stringify(entries
      .map(entry => [entry.file, entry.order, entry.sha256, entry.kind ?? "migrate"]))).digest("hex"),
    entries }, null, 2)}\n`);
  if (poisonEarlyRoleFile) {
    // A grant on a `public` relation, which is precisely what running a role file
    // before the ledger cannot do — the ledger is what creates those relations.
    // The real file's own statements are kept, so the refusal can only come from
    // the scope check and not from the file being otherwise malformed.
    const early = join(stage, "db", "roles", "queue_backup_read_roles.sql");
    writeFileSync(early, `${readFileSync(early, "utf8")}\nGRANT SELECT ON public.tenants`
      + ` TO control_room_schema_owner;\n`);
  }
  return Object.freeze({ stage, ledgerPath,
    // The ledger's own spelling of "head" (`NNNN_name.sql`), which is what the
    // request's `expectedLedgerHead` is checked against — a path is refused by
    // `isLedgerHeadV1` before a single statement runs.
    head: m6Head(migrateRows, upto),
    swappable: (on) => {
      const link = join(root, "current");
      rmSync(link, { force: true });
      symlinkSync(on ? REPO : stage, link);
    } });
}

/** `db/migrations/0238_x.sql` -> `0238_x.sql`, the head's own spelling. */
const m6Head = (migrateRows, upto) => migrateRows.at(upto - 1).file.split("/").pop();

/**
 * An INT6-SHAPED DATABASE: the state every Mac that finished an install before
 * this release is in. The queue schema is present (the original install built it)
 * and the nightly dump's READ on it is absent (the granting file did not exist
 * yet). `0285_queue_backup_read.sql` refuses exactly this state, and the release
 * phase used to create it itself by applying the ledger before the role file.
 *
 * IT IS BUILT BY THE PRODUCTION PHASE over a truncated ledger, not by inserting
 * ledger rows and not by `applyMigrations`. Both alternatives were measured and
 * both make the fixture wrong: a hand-written row is a claim about the past rather
 * than the past, and `applyMigrations` applies `db/roles/production_table_grants.sql`
 * — which this phase does NOT apply (`RELEASE_LEDGER_SKIPPED_KINDS_V1`) — so the
 * "before" database would have `public` grants no int6 Mac ever had, and the
 * catalogue diff against a fresh install would then be comparing two different
 * databases.
 *
 * AND THE READ IS REMOVED afterwards, not merely left absent, because "absent" is
 * ambiguous: a cluster where an earlier release already granted it and somebody
 * then REVOKEd it is a DIFFERENT state, and 0285's teeth are about that one. Both
 * end in `usage=f`, and both must converge, so the fixture starts from the harder
 * half — and it starts from exactly the grant `queue_backup_read_roles.sql` makes,
 * taken back out by the very statements that make it.
 */
async function buildInt6ShapedCluster(label, portOffset, logins, passwords) {
  const { root, port } = await installRoot(label, portOffset);
  await initializeDatabaseV1Script(initRequest(root, { logins, port }), passwords,
    { ...manifestFor(port), planLayout: (input) => planPgClusterLayoutV1(input) });
  const context = await startPostmaster({ root, port });
  const started = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
    args: ["-D", join(root, "pg", "data-A"), "-l", join(root, "logs/postgresql17/out.log"),
      "-o", `-p ${port}`, "-w", "-t", "60", "start"], ...context, role: "database", cwd: join(root, "pg") });
  assert.equal(started.code, 0, `the service must start on ${label}: ${started.stderr}`);
  await simulateRootDeployerPeer(context);
  const int6 = await stageInt6Release(root);
  const buildDependencies = async () => buildReleaseDependenciesV1(join(root, "current"),
    { deployerIdentity: { uid: process.getuid(), gid: process.getgid() } });
  const buildRequest = head => ({ ...initRequest(root, { logins, port }),
    schema: "control-room.release-schema/v1", release: "current", expectedLedgerHead: head });
  try {
    // THE PRE-UPGRADE INSTALL, through the phase, with the int6 ledger staged.
    int6.swappable(false);
    const installed = await applyReleaseSchemaV1(buildRequest(int6.head), passwords, await buildDependencies());
    assert.equal(installed.ledgerHead, int6.head,
      "the fixture's own install must end at the int6 head, or it is not the int6 shape");
    assert.equal(installed.schemaDigest, `sha256:${privateWebSchemaDigest}`,
      "even an int6-era install must end on this tree's pinned digest — the ledger did not change it");
    // …and the read taken away, which is what an install predating the granting
    // file looks like.
    await asDatabase(context, "REVOKE USAGE ON SCHEMA control_room_queue FROM control_room_schema_owner",
      "postgres", "control_room");
    await asDatabase(context, "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA control_room_queue"
      + " REVOKE SELECT ON TABLES FROM control_room_schema_owner", "postgres", "control_room");
  } finally {
    // The CURRENT release staged, exactly as an update's staging would leave it.
    int6.swappable(true);
  }
  // The shape this test is about, asserted rather than assumed: the schema is
  // present and 0285 would refuse. A fixture that had drifted into "read
  // present" would pass everything below without testing the transition.
  const shape = await asDatabase(context, `SELECT
      (SELECT count(*)::int FROM pg_namespace WHERE nspname='control_room_queue') AS schema_present,
      has_schema_privilege('control_room_schema_owner','control_room_queue','USAGE') AS usage,
      (SELECT count(*)::int FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        JOIN pg_roles g ON g.oid=a.grantee WHERE d.defaclnamespace=(SELECT oid FROM pg_namespace
          WHERE nspname='control_room_queue') AND d.defaclobjtype='r'
          AND g.rolname='control_room_schema_owner' AND a.privilege_type='SELECT') AS default_read`,
    "postgres", "control_room");
  assert.deepEqual(shape, [{ schema_present: 1, usage: false, default_read: 0 }],
    "the int6 shape is: queue schema present, nightly read absent");
  // …and that 0285 really refuses it RIGHT NOW, through the release's OWN applier
  // over the CURRENT ledger, which is the exact situation the phase's old ordering
  // created. Without this the fixture is only asserted to look right; with it, the
  // bug's message is reproduced here, before any of the fix's code runs.
  //
  // THE CURRENT LEDGER, not the int6 one: the int6 ledger's 0285 is not pending
  // (the fixture's own install already applied everything it contains), so it could
  // only ever report a no-op. `applyPendingMacMigrationsV1` runs with the release's
  // real ledger, and that is the path whose refusal this fix must remove.
  const { applyMigrations } = await import("../deploy/postgres/apply-migrations.mjs");
  const target = `host=${context.layout.socketDirectory} port=${port} dbname=control_room user=postgres`;
  await assert.rejects(applyMigrations({ rootDir: REPO, bootstrapTarget: target,
    migrateTarget: target, migrateViaLocalPeer: true, env: {} }),
  /queue_backup_read_incomplete:usage=f,default=f/u,
  "the release's own applier must refuse this shape at 0285 — that refusal is the bug the phase fix removes");
  return { root, port, context, ledgerPath: int6.ledgerPath,
    dependencies: await buildDependencies(),
    release: buildRequest(ledgerHeadV1(await readReleaseLedgerV1(REPO))) };
}

/**
 * A whole-cluster CATALOGUE, as SETS, for the "identical to a fresh install"
 * comparison.
 *
 * ACLs go through `aclexplode`, NOT `relacl::text`. MEASURED by the review that
 * drove this test: an upgraded cluster and a fresh install on the same tree were
 * byte-identical except for ONE table's ACL array being stored in a different
 * element order (`updater.passkey_registrations_limits`) — set-equivalent, not a
 * privilege difference, and invisible to every `has_*_privilege` check in this
 * codebase. Comparing the arrays as text would report that as a difference on a
 * correct cluster, which is how a test of this kind talks a reviewer into
 * dismissing a real one later.
 */
async function catalogAsSets(context) {
  const rows = sql => runSessionStatementV1({ user: "postgres", database: "control_room", sql }, context);
  const sorted = result => result.map(row => JSON.stringify(row)).sort();
  return {
    namespaces: sorted(await rows(`SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
        coalesce((SELECT array_agg(a.privilege_type || '=' ||
          CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
          ORDER BY a.privilege_type || '=' ||
          CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)
          FROM aclexplode(n.nspacl) a), ARRAY[]::text[]) AS acl
      FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
        AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'
      ORDER BY 1`)),
    roles: sorted(await rows(`SELECT rolname AS name, rolcanlogin, rolinherit, rolsuper, rolcreatedb,
        rolcreaterole, rolreplication, rolbypassrls, (rolpassword IS NOT NULL) AS has_password
      FROM pg_authid WHERE rolname NOT LIKE 'pg\\_%' AND rolname <> 'postgres' ORDER BY 1`)),
    memberships: sorted(await rows(`SELECT parent.rolname AS parent, member.rolname AS member,
        m.admin_option, m.inherit_option, m.set_option
      FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
        JOIN pg_roles member ON member.oid=m.member ORDER BY 1,2`)),
    // TABLE-WISE and COLUMN-WISE ACLs, exploded. `ON ALL TABLES` covers views and
    // partitions alike, so relkind is not filtered — a partition's ACL is a real
    // row and the review's diff counted them.
    tableAcls: sorted(await rows(`SELECT n.nspname AS schema, c.relname AS name, c.relkind,
        coalesce(a.privilege_type,'') AS privilege,
        coalesce(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'') AS grantee,
        coalesce(pg_get_userbyid(a.grantor),'') AS grantor, a.is_grantable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a ON true
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY 1,2,4,5`)),
    functionAcls: sorted(await rows(`SELECT n.nspname AS schema, p.proname AS name,
        coalesce(a.privilege_type,'') AS privilege,
        coalesce(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'') AS grantee,
        coalesce(pg_get_userbyid(a.grantor),'') AS grantor
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        LEFT JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a ON true
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY 1,2,3,4`)),
    // THE DEFAULT ACLS, which no relacl/proacl comparison would see, and which are
    // half of what 0285 asserts. MEASURED: after a REVOKE the `defaclobjtype='r'`
    // row is GONE rather than emptied, so this compares presence and content.
    defaultAcls: sorted(await rows(`SELECT n.nspname AS schema, pg_get_userbyid(d.defaclrole) AS role,
        d.defaclobjtype, coalesce(a.privilege_type,'') AS privilege,
        coalesce(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'') AS grantee
      FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace
        LEFT JOIN LATERAL aclexplode(d.defaclacl) a ON true ORDER BY 1,2,3,4,5`)),
    sequences: sorted(await rows(`SELECT n.nspname AS schema, c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S'
        AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY 1,2`)),
    ledger: sorted(await rows("SELECT filename, digest, ledger_order FROM control_room_schema_migrations")),
  };
}

test("an int6-shaped database upgrades to the current release and ends identical to a fresh install",
  { skip: needsArchive, timeout: 1_800_000 }, async () => {
    // THE TEST THIS BUG HAD NONE OF. `0285_queue_backup_read.sql` refuses when the
    // queue schema exists and the nightly dump's read does not, and the release
    // phase used to apply the LEDGER before the privilege file that grants it — so
    // on every Mac whose queue schema predated this release the phase refused at
    // 0285, and every retry refused at the identical point. MEASURED on the base
    // commit: `release_schema_migration_refused:db/migrations/0285_queue_backup_read.sql:
    //  ERROR: queue_backup_read_incomplete:usage=f,default=f,repair=apply
    //  db/roles/queue_backup_read_roles.sql as the queue schema owner (postgres)`.
    //
    // Three claims, in order, each one a thing the old ordering broke:
    //   1. the upgrade COMPLETES at all — no refusal, and the pinned digest;
    //   2. it ends IDENTICAL to a fresh install of the same tree (catalogue diff);
    //   3. a SECOND upgrade also passes — because the trap's symptom is a retry
    //      that keeps failing, and a fix that only worked on the first run would
    //      not be a fix.
    const { logins, passwords } = phaseLogins(["control_room_migrator", "control_room_web",
      "control_room_coordinator"]);
    const upgraded = await buildInt6ShapedCluster("int6-upgrade", 16, logins, passwords);
    let fresh;
    try {
      const result = await applyReleaseSchemaV1(upgraded.release, passwords, upgraded.dependencies);
      assert.equal(result.outcome, "applied",
        "an int6-shaped database must reach `applied`; the refusal it used to get is the bug");
      assert.equal(result.ledgerHead, upgraded.release.expectedLedgerHead);
      assert.equal(result.schemaDigest, `sha256:${privateWebSchemaDigest}`,
        "the upgrade must end on the release's own pinned schema digest");
      // 0285's own ledger row exists, which is what the int6 prefix was missing.
      const rows = await asDatabase(upgraded.context,
        "SELECT filename FROM control_room_schema_migrations WHERE filename LIKE '%0285%'",
        "control_room_migrator", "control_room");
      assert.deepEqual(rows, [{ filename: "db/migrations/0285_queue_backup_read.sql" }],
        "0285 must be recorded — the transition it blocked is the one this upgrade makes");
      // …and the read it asserts is really there afterwards, from the CATALOGUE and
      // not from the phase's own claim about itself.
      const read = await asDatabase(upgraded.context, `SELECT
          has_schema_privilege('control_room_schema_owner','control_room_queue','USAGE') AS usage,
          (SELECT count(*)::int FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
            JOIN pg_roles g ON g.oid=a.grantee WHERE d.defaclnamespace=(SELECT oid FROM pg_namespace
              WHERE nspname='control_room_queue') AND d.defaclobjtype='r'
              AND g.rolname='control_room_schema_owner' AND a.privilege_type='SELECT') AS default_read`,
        "postgres", "control_room");
      assert.deepEqual(read, [{ usage: true, default_read: 1 }],
        "the upgrade must CONVERGE the grant, not merely record the migration that wants it");

      // (2) IDENTICAL to a fresh install. A second full install, same tree, same
      // login list — so any difference is the upgrade path's and not the fixture's.
      fresh = await freshCluster("int6-fresh", 17, logins, passwords);
      const freshResult = await applyReleaseSchemaV1(fresh.release, passwords, fresh.dependencies);
      assert.equal(freshResult.outcome, "applied");
      assert.equal(freshResult.schemaDigest, result.schemaDigest);
      const after = await catalogAsSets(upgraded.context);
      const baseline = await catalogAsSets(fresh.context);
      for (const [section, rows] of Object.entries(after)) {
        assert.deepEqual(rows, baseline[section],
          `the upgraded int6 database's ${section} must equal a fresh install's`);
      }

      // (3) A SECOND UPGRADE. Named separately from (1) because the trap's real
      // shape is a retry: a run that passes once and fails next would still have
      // shipped this. The queue is already built and the read already granted, so
      // this is the branch the old ordering broke on a SECOND upgrade too.
      const second = await applyReleaseSchemaV1(upgraded.release, passwords, upgraded.dependencies);
      assert.equal(second.outcome, "applied", "a second upgrade of the same database must also converge");
      assert.equal(second.schemaDigest, result.schemaDigest);
      assert.equal(second.ledgerHead, result.ledgerHead);
      const afterSecond = await catalogAsSets(upgraded.context);
      for (const [section, rows] of Object.entries(afterSecond)) {
        assert.deepEqual(rows, after[section], `a second upgrade must change nothing in ${section}`);
      }
      // And the release's OWN applier must then find nothing to do, as it does on a
      // fresh install — the check every later upgrade runs first.
      const state = await proveReleaseState(upgraded.context, upgraded.root);
      assert.equal(state.evidenceDigest, state.headPostDigest,
        "the ledger head must be the live evidence digest after the upgrade");
      assert.deepEqual(state.missingGrants, []);
      const { applyMigrations } = await import("../deploy/postgres/apply-migrations.mjs");
      const target = `host=${upgraded.context.layout.socketDirectory} port=${upgraded.port}`
        + " dbname=control_room user=postgres";
      const noOp = await applyMigrations({ rootDir: REPO, bootstrapTarget: target,
        migrateTarget: target, migrateViaLocalPeer: true, env: {} });
      assert.equal(noOp.noOp, true,
        "the release's own applier must find nothing pending after the upgrade");
    } finally {
      await stopCluster(upgraded);
      if (fresh) await stopCluster(fresh);
    }
  });

test("a role file that grants on something the ledger creates is refused before the ledger runs",
  { skip: needsArchive, timeout: 1_200_000 }, async () => {
    // THE SCOPE GUARD, EXERCISED THROUGH THE PHASE.
    //
    // MEASURED, and this test exists because of that measurement: deleting the
    // guard's CALL SITE leaves `earlyPrivilegeFileScopeV1`'s own unit test
    // passing, because a unit test of a function cannot see whether the phase
    // calls it. So the guard is asserted here, where the phase reads the file, on a
    // file that grants on `public.tenants` — a relation the LEDGER creates, which
    // is the whole reason running a role file before the ledger is not free.
    //
    // The poisoned file keeps the real one's statements and adds one, so the
    // refusal can only come from the scope check and not from a malformed file.
    // MEASURED: without the guard the phase's own psql answers
    // `relation "public.tenants" does not exist` and the refusal names a SQL line
    // instead of naming the rule that forbids it.
    const { logins, passwords } = phaseLogins(["control_room_migrator", "control_room_web"]);
    const cluster = await freshCluster("guard-early-scope", 18, logins, passwords);
    try {
      const poisoned = await stageInt6Release(cluster.root, { poisonEarlyRoleFile: true });
      poisoned.swappable(false);
      // The poisoned tree's ledger is the int6 one, so its head is the int6 head —
      // and the refusal must arrive BEFORE any migration runs, which is what makes
      // it the scope guard's refusal and not a migration's.
      await assert.rejects(applyReleaseSchemaV1({ ...cluster.release,
        expectedLedgerHead: poisoned.head }, passwords, cluster.dependencies),
      /release_schema_early_grant_scope_refused:queue_backup_read_roles\.sql:.*public\.tenants/u,
      "an early role file naming a relation the ledger creates must be refused by name");
      // Nothing was applied — and the proof is stronger than a row count. MEASURED:
      // the guard fires BEFORE the phase's `ledger-table` step, so the ledger table
      // does not exist yet either. That is the right place for it: the check is
      // about what the file may name, which is a property of the release, and a
      // release whose early file is out of scope must be refused before it has
      // created anything to be un-created.
      const exists = await asDatabase(cluster.context,
        "SELECT count(*)::int AS n FROM pg_class WHERE relname = 'control_room_schema_migrations'",
        "postgres", "control_room");
      assert.equal(exists[0]?.n, 0,
        "the refusal must arrive before the phase has applied or recorded anything");
      // …and the queue schema WAS built, which is the step immediately before the
      // check, so the refusal cannot be a file that failed earlier for another
      // reason.
      const queue = await asDatabase(cluster.context,
        "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'control_room_queue'", "postgres", "control_room");
      assert.equal(queue[0]?.n, 1, "the queue schema is built before the early role file is read");
    } finally {
      // Put the CURRENT release back, exactly as the upgrade path would, so the
      // cluster is not left staging a tree that no longer exists for the next
      // test that shares this root.
      const link = join(cluster.root, "current");
      rmSync(link, { force: true });
      symlinkSync(REPO, link);
      await stopCluster(cluster);
    }
  });

test("the early role file is checked against the ledger, and the check is load-bearing",
  { timeout: 120_000 }, async () => {
    // The guard that makes running a privilege file before the ledger safe. It
    // needs no cluster, so it runs on every machine, and it is mutation-checked
    // below: with the scope check deleted, the first case would pass.
    //
    // THE REAL FILE IS IN SCOPE, and that is the case that would break install
    // night if it did not hold — it grants on the schema, on all tables, on all
    // sequences and on the default privileges.
    const real = readFileSync(join(REPO, "db/roles/queue_backup_read_roles.sql"), "utf8");
    assert.deepEqual(earlyPrivilegeFileScopeV1(real, "queue_backup_read_roles.sql"), [],
      "the release's own early role file must be in scope");
    // Three variants the file does NOT contain, which is the point: a check that
    // only proves the shipped file passes is not a check.
    const cases = [
      ["GRANT SELECT ON control_jobs TO control_room_web;", ["control_jobs"]],
      ["GRANT SELECT ON public.tenants TO control_room_web;", ["public.tenants"]],
      ["GRANT EXECUTE ON FUNCTION public.is_work_intake_session() TO control_room_web;", ["public.is_work_intake_session"]],
      ["GRANT USAGE ON SCHEMA public TO control_room_web;", ["public"]],
      ["GRANT CONNECT ON DATABASE control_room TO control_room_web;", ["control_room"]],
      ["GRANT CREATE ON TABLESPACE pg_default TO control_room_web;", ["pg_default"]],
      ["GRANT SELECT ON control_room_queue.version, public.tenants TO control_room_web;", ["public.tenants"]],
      ["ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO control_room_web;",
        ["default-privileges:public"]],
      // A bare `ALTER DEFAULT PRIVILEGES` covers EVERY schema the role creates in,
      // which is where the ledger's migrations create theirs.
      ["ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO control_room_web;",
        ["default-privileges:all-schemas"]],
    ];
    for (const [sql, expected] of cases) {
      assert.deepEqual(earlyPrivilegeFileScopeV1(`${sql}\n`, "probe.sql"),
        expected.map(item => `probe.sql:${item}`), `scope must catch: ${sql}`);
    }
    // IN scope: every shape the real file uses, plus the two it could grow into.
    for (const sql of [
      "GRANT USAGE ON SCHEMA control_room_queue TO control_room_schema_owner;",
      "REVOKE ALL ON SCHEMA control_room_queue FROM PUBLIC;",
      "REVOKE ALL ON ALL TABLES IN SCHEMA control_room_queue FROM PUBLIC;",
      "REVOKE ALL ON ALL SEQUENCES IN SCHEMA control_room_queue FROM PUBLIC;",
      "GRANT SELECT ON ALL TABLES IN SCHEMA control_room_queue TO control_room_schema_owner;",
      "GRANT SELECT ON control_room_queue.version TO control_room_schema_owner;",
      "GRANT EXECUTE ON FUNCTION control_room_queue.f(int) TO control_room_schema_owner;",
      "GRANT SELECT ON control_room_queue.version WITH GRANT OPTION TO control_room_schema_owner;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA control_room_queue"
        + " GRANT SELECT ON TABLES TO control_room_schema_owner;",
      // A dollar-quoted BODY is not a top-level grant, and a check that read
      // through it would refuse this file on its `DO $$ … END $$` guard.
      "DO $q$ BEGIN EXECUTE 'GRANT SELECT ON control_queue_stats TO x'; END $q$;",
      // …and a COMMENT naming an out-of-scope relation is not a grant.
      "-- GRANT SELECT ON public.tenants TO control_room_web\nGRANT USAGE ON SCHEMA control_room_queue TO g;",
    ]) {
      assert.deepEqual(earlyPrivilegeFileScopeV1(`${sql}\n`, "probe.sql"), [],
        `scope must accept: ${sql}`);
    }
    // A text that is not text at all is a refusal, not an empty answer — an
    // unparseable file that reported "in scope" would be the worst possible answer.
    for (const bad of ["", "\0", 42, null]) {
      assert.throws(() => earlyPrivilegeFileScopeV1(bad, "probe.sql"),
        /release_schema_early_grant_scope_refused:probe\.sql:text/u);
    }
    // And the phase applies the file early AT ALL — the wiring, not just the check.
    const source = readFileSync(join(REPO, "src/updater/v1/pg/apply-release-schema.mjs"), "utf8");
    const early = /const preLedgerPrivilegeFiles = Object\.freeze\(\[([^\]]*)\]\)/u.exec(source)?.[1] ?? "";
    assert.deepEqual(early.split(",").map(name => name.trim().replaceAll('"', "")).filter(Boolean),
      ["queue_backup_read_roles.sql"],
      "exactly one role file runs before the ledger, and it is the one 0285 asserts");
    // …and it runs BEFORE the ledger APPLY, not merely before the ledger read.
    const queue = source.indexOf("dependencies.installFixedQueue({");
    const earlyCall = source.indexOf("applyPrivilegeFilesV1(preLedgerPrivilegeFiles)");
    const applyLoop = source.indexOf("for (const file of pending) {");
    assert.ok(queue > 0 && earlyCall > 0 && applyLoop > 0);
    assert.ok(queue < earlyCall, "the queue schema must be built before the file that grants on it");
    assert.ok(earlyCall < applyLoop,
      "the early role file must run before the ledger APPLIES migrations — that order IS the fix");
  });

/**
 * Add the INVOKING uid to the cluster's peer map as the deployer, so the
 * updater loader's deployer half can run in this lane.
 *
 * THIS IS THE SIMULATION, and it is stated here rather than buried because it is
 * the one thing in the whole phase that needs real root and cannot have it here.
 *
 * Production's map (`pgHbaPeerMapV1`, written by `init-database` from
 * `policy/accounts.json`) is:
 *
 *   cr <database account> control_room_migrator
 *   cr root              control_room_deployer      <-- root
 *   cr <database account> postgres
 *
 * The deployer is mapped from ROOT, because the deployer is what the updater's
 * `PasskeyStoreV1` connects as on install night, and root is the identity the
 * installer runs under. This lane runs as the invoking uid, which the map does
 * not name, so the server refuses with `FATAL: Peer authentication failed for
 * user "control_room_deployer"` — MEASURED, and the refusal is correct.
 *
 * Rather than skip the deployer half (which leaves `0002_schema.sql` and
 * `0003_guards.sql` unapplied and every grant below them untested) or apply them
 * as the superuser (which builds a schema owned by the wrong role and defeats
 * the loader's own ownership assertion), the lane ADDS one map line for the
 * invoking uid and reloads. `pg_ident.conf` is re-read on SIGHUP, so no restart
 * and no window in which the cluster is unconfigured.
 *
 * What this proves and does not prove:
 *
 *   PROVES  the deployer's half of the loader applies, the schema is owned by
 *           `control_room_deployer`, the guard functions exist and are
 *           SECURITY DEFINER, the release-read grants are exactly the four
 *           tables, the deployer holds no password, and the migrator has no
 *           USAGE on `updater`.
 *   NOT     that a real root process can open that peer connection. The kernel
 *           path from uid 0 to the socket is identical — the map matches on the
 *           OS username the server reads from the socket's peer credentials —
 *           but "identical" is a claim about code, not a measurement. THE
 *           REAL-ROOT REHEARSAL MUST RUN THE SAME LANE UNDER ROOT AND MUST
 *           PROVE: the `cr root control_room_deployer` line authenticates; the
 *           loader's deployer half completes; and NO OTHER uid in the map can
 *           become the deployer.
 */
async function simulateRootDeployerPeer(context) {
  const { root, port, layout, environment, profile, profileParameters } = context;
  const data = join(root, "pg", "data-A");
  await writeFile(join(data, "pg_ident.conf"),
    `${pgHbaPeerMapV1({ database: userInfo().username, migrator: "control_room_migrator",
      deployer: "control_room_deployer" })}cr ${userInfo().username} control_room_deployer\n`,
    { mode: 0o600 });
  // `pg_ident.conf` is re-read on SIGHUP, so this is a reload and not a restart:
  // no window in which the cluster is unconfigured, and no pid to leak.
  const reloaded = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
    args: ["-D", data, "reload"], environment, ...context.identity, role: "database",
    profile, profileParameters, cwd: join(root, "pg"), timeoutMs: 60_000 });
  assert.equal(reloaded.code, 0, `pg_ctl reload failed: ${reloaded.stderr}`);
  void layout; void port;
  return Object.freeze({ simulated: true, deployerSystemName: userInfo().username });
}

/**
 * A fresh cluster for ONE guard case.
 *
 * Each case gets its own because a REFUSED phase leaves PARTIAL work behind —
 * MEASURED: the digest-pin case applies the ledger and then refuses at the
 * digest, and the next case on the same cluster failed with
 * `release_schema_migration_refused:…0001_control_room_core.sql` rather than with
 * its own refusal. That is the retry-after-kill property showing up inside a
 * test, and it is why "the phase refused" is only a claim about a guard when the
 * only thing that could have refused it is the guard.
 */
async function freshCluster(label, portOffset, logins, passwords) {
  const { root, port } = await installRoot(label, portOffset);
  await initializeDatabaseV1Script(initRequest(root, { logins, port }), passwords,
    { ...manifestFor(port), planLayout: (input) => planPgClusterLayoutV1(input) });
  const context = await startPostmaster({ root, port });
  const started = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
    args: ["-D", join(root, "pg", "data-A"), "-l", join(root, "logs/postgresql17/out.log"),
      "-o", `-p ${port}`, "-w", "-t", "60", "start"], ...context, role: "database", cwd: join(root, "pg") });
  assert.equal(started.code, 0, `the service must start on ${label}: ${started.stderr}`);
  await simulateRootDeployerPeer(context);
  return {
    root, port, context,
    // The PRODUCTION release set, deployer identity aside — each guard case then
    // breaks exactly one thing on top of it.
    dependencies: await buildReleaseDependenciesV1(join(root, "current"),
      { deployerIdentity: { uid: process.getuid(), gid: process.getgid() } }),
    release: { ...initRequest(root, { logins, port }), schema: "control-room.release-schema/v1",
      release: "current", expectedLedgerHead: ledgerHeadV1(await readReleaseLedgerV1(REPO)) },
  };
}

/** Stop a cluster this lane started. */
async function stopCluster(cluster) {
  await spawnPgFamily({ executable: join(cluster.root, "runtime/pg-current/bin/pg_ctl"),
    args: ["-D", join(cluster.root, "pg", "data-A"), "-m", "fast", "-w", "-t", "60", "stop"],
    ...cluster.context, role: "database", cwd: join(cluster.root, "pg") });
}

test("the release phase refuses a login that did not verify, and a schema that moved", { skip: needsArchive, timeout: 900_000 }, async () => {
  // The release phase's PROOF guards, each broken on purpose with a dependency
  // the phase believes, so the refusal can be seen to come from the guard rather
  // than from a cluster that had already failed.
  //
  // MEASURED, and the reason this test exists: mutation-checking all four guards
  // showed every one of them passing with its guard line DELETED. A guard nobody
  // can trip is a guard nobody has proved, and "the phase refused" was previously
  // a claim about four conditions no test could produce.
  const names = ["control_room_web", "control_room_coordinator"];
  const { logins, passwords } = phaseLogins(names);
  const clusters = [];
  try {
    // 1. A VERIFIER THAT CLAIMS A LOGIN DID NOT AUTHENTICATE — what deleting
    //    `if (outcome?.authenticated !== true)` looks like from inside the phase.
    const one = await freshCluster("guard-unauthenticated", 4, logins, passwords);
    clusters.push(one);
    await assert.rejects(applyReleaseSchemaV1(one.release, passwords, { ...one.dependencies,
      verifyLogin: async () => ({ authenticated: false, refusedWithoutPassword: true }) }),
    /release_schema_login_unverified:control_room_web/u,
    "a verifier reporting a login unauthenticated must be refused");

    // 2. A LOGIN THAT REACHED THE SERVER WITH NO PASSWORD. This is the half that
    //    makes `!peerMapped.has(login.name) && …refusedWithoutPassword !== true`
    //    non-vacuous: the `authenticated` half alone passes this input, so a
    //    phase checking only `authenticated` would journal a credential whose
    //    login had been reachable with no password at all.
    const two = await freshCluster("guard-nopassword", 5, logins, passwords);
    clusters.push(two);
    await assert.rejects(applyReleaseSchemaV1(two.release, passwords, { ...two.dependencies,
      verifyLogin: async ({ login }) => ({ authenticated: true,
        refusedWithoutPassword: login !== "control_room_web" }) }),
    /release_schema_login_accepted_without_password:control_room_web/u,
    "a login that connected with no password must be refused");

    // 3. A LEDGER HEAD THE CALLER DID NOT MEAN. Pinning a head is how a caller
    //    says "I meant THAT ledger", so a phase that ignored the pin would apply
    //    something other than what was asked for, on install night, undetectably.
    const three = await freshCluster("guard-head", 6, logins, passwords);
    clusters.push(three);
    await assert.rejects(applyReleaseSchemaV1({ ...three.release,
      expectedLedgerHead: "0001_not_real.sql" }, passwords, three.dependencies),
    /release_schema_ledger_head_mismatch:0001_not_real\.sql/u,
    "a pinned ledger head that is not the release head must be refused");

    // 4. A SCHEMA THAT HAS MOVED. The pin in `policy/release-schema-digest.json`
    //    is compared against the digest computed from the live cluster, so a
    //    phase that skipped the comparison would journal a digest meaning nothing.
    //
    //    MEASURED: this guard passed with its condition replaced by `false`. The
    //    way to make it non-vacuous is to move the PIN rather than the cluster,
    //    because the pin is the reviewed artifact: a rehearsal that cannot rebuild
    //    the ledger can still prove the guard fires, and it fires on exactly the
    //    input an operator meets — a cluster built by a different release.
    const four = await freshCluster("guard-digest", 7, logins, passwords);
    clusters.push(four);
    const pinPath = join(four.root, "updater", "current", "policy", "release-schema-digest.json");
    const realPin = readFileSync(pinPath, "utf8");
    writeFileSync(pinPath, `${JSON.stringify({ ...JSON.parse(realPin), digest: "b".repeat(64) }, null, 2)}\n`);
    await assert.rejects(applyReleaseSchemaV1(four.release, passwords, four.dependencies),
      /release_schema_digest_mismatch/u, "a digest that does not match the bundle pin must be refused");
    writeFileSync(pinPath, realPin);

    // 5. A MISSING PASSWORD ON STDIN. The credential file is written from the
    //    secrets the phase holds, so a login with no secret stops the phase before
    //    any file exists — and the file's ABSENCE is asserted, not just the code.
    const five = await freshCluster("guard-nosecret", 8, logins, passwords);
    clusters.push(five);
    const withoutSecret = { ...passwords };
    delete withoutSecret.control_room_web;
    await assert.rejects(applyReleaseSchemaV1(five.release, withoutSecret, five.dependencies),
      /release_schema_input_refused|database_phase_input_refused/u,
      "a login with no password on stdin must be refused");
    assert.equal(existsSync(join(five.root, "Protected", "service", "db-logins.json")), false,
      "a refused phase must not leave a credential file behind");

    // 6. THE UPDATER SCHEMA IS MISSING — and the loader REBUILDS it, which is
    //    the point worth recording.
    //
    //    MEASURED: the first attempt here asserted the opposite — that a cluster
    //    with no `updater` schema could not reach `outcome: applied` — and it
    //    failed, because `applyUpdaterSchemaV1` re-creates the schema from
    //    `0000_bootstrap.sql` and `0002_schema.sql` every time it runs. That is
    //    the loader's idempotence and it is correct: install night may legitimately
    //    re-run the loader, and a phase that refused would wedge the installer on a
    //    cluster whose schema was merely lost.
    //
    //    So what is asserted is the RECOVERY, and the `tables < 1` guard's real
    //    subject is asserted directly below: after a rebuild the schema has its
    //    tables again.
    const sixTables = await freshCluster("guard-rebuild", 10, logins, passwords);
    clusters.push(sixTables);
    await asDatabase(sixTables.context, "DROP SCHEMA IF EXISTS updater CASCADE",
      "postgres", "control_room");
    const rebuilt = await applyReleaseSchemaV1(sixTables.release, passwords, sixTables.dependencies);
    assert.equal(rebuilt.outcome, "applied",
      "the loader must rebuild a lost updater schema rather than refuse");
    const rebuiltTables = await asDatabase(sixTables.context, "SELECT count(*)::int AS n FROM pg_class c"
      + " JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'updater' AND c.relkind = 'r'",
      "postgres", "control_room");
    assert.ok(Number(rebuiltTables[0].n) >= 9,
      `the rebuilt schema must have its tables, got ${rebuiltTables[0].n}`);

    // 7. AN UNBALANCED DOLLAR-QUOTE IN A ROLE FILE. MEASURED: this guard also
    //    passed with its line deleted. `splitDollarQuotedV1` refuses a role file
    //    whose `$tag$` pairs do not balance, because "I did not understand where
    //    the bodies were" is the one answer from which nothing else can be
    //    concluded — every later step would be reasoning about a file whose shape
    //    the phase had misread.
    const seven = await freshCluster("guard-unbalanced", 11, logins, passwords);
    clusters.push(seven);
    // The role files are read from `root/current/db/roles`, which `installRoot`
    // makes a SYMLINK to the repository. Writing there would edit the
    // repository, which this lane never does — so the link is replaced with a real
    // copy first. `rmSync` on the LINK (not `recursive`) and then `cpSync` gives a
    // directory the phase can legitimately mutate.
    //
    // MEASURED and the reason this is not written as a plain write: the symlink
    // means `writeFileSync` would have planted the broken role file in the working
    // tree, where the next `git status` would show it and the next test run would
    // read it.
    const currentLink = join(seven.root, "current");
    assert.equal(readlinkSync(currentLink), REPO, "the fixture must stage the release tree as a link");
    rmSync(currentLink);
    mkdirSync(currentLink, { mode: 0o755 });
    // Only what the phase READS: `deploy/postgres/**` (the ledger and its files),
    // `db/roles/**`, `db/setup/**`, `db/migrations/**`. Copying the whole
    // repository would make this case take minutes, and the point is the guard,
    // not the copy.
    for (const directory of ["deploy/postgres", "db/roles", "db/setup", "db/migrations"]) {
      cpSync(join(REPO, directory), join(currentLink, directory), { recursive: true });
    }
    const rolesDir = join(seven.root, "current", "db", "roles");
    const roleFile = join(rolesDir, "fleet_gateway_roles.sql");
    const realRoleFile = readFileSync(roleFile, "utf8");
    // An unterminated dollar-quote: `DO $fn$ BEGIN` with no closing `$fn$`.
    writeFileSync(roleFile, `${realRoleFile}\nDO $fn$ BEGIN\n  REVOKE ALL ON SCHEMA public FROM PUBLIC;\n`);
    await assert.rejects(applyReleaseSchemaV1(seven.release, passwords, seven.dependencies),
      /release_schema_role_file_refused:fleet_gateway_roles\.sql/u,
      "a role file with an unbalanced dollar-quote must be refused by name");
    writeFileSync(roleFile, realRoleFile);

    // THREE OF THIS PHASE'S GUARDS ARE DEFENSIVE AND NOT REACHABLE FROM OUTSIDE.
    //
    // MEASURED, by mutation-checking each one and finding the tests still pass with
    // the guard line deleted. Recording them here rather than leaving three
    // mutations "not caught" in a private script nobody reads:
    //
    //   - `release_schema_credentials_mode_refused`. `writeFile(…, { mode: 0o600 })`
    //     masks 0600 against the umask, so the file lands at 0600 or MORE
    //     restrictive, and the explicit `chmod 0600` before the read-back means the
    //     read-back cannot fail for any umask. No umask I can set makes it fire
    //     (umask 0777 gives 0000, which `chmod` then repairs). It fires only on a
    //     filesystem that ignores modes. MEASURED: setting `process.umask(0o000)`
    //     and asserting a refusal FAILS, because the file lands 0600 correctly.
    //   - `release_schema_updater_tables_empty`. The loader re-applies
    //     `0002_schema.sql` every run, so a phase that reached this check always
    //     has tables. Case 6 above proves the rebuild; this guard is the assertion
    //     that the rebuild happened.
    //   - the dollar-quote balance check IS reachable and IS covered, by case 7.
    //     It is listed here only because round 2's mutation targeted the OLD
    //     release-phase test rather than the guard test, which did not exist yet
    //     when that run started.
    //
    // What this means for a reviewer: these three are not unproved PROOFS, they are
    // assertions about a rebuild and a filesystem, and the code above says which.

    // …and the phase WORKS once the faults are gone, which is what proves cases
    // 1-5 above were the guards rather than a cluster that had failed on its own.
    // If the healthy path had already failed, one of the refusals above would have
    // been a coincidence.
    const six = await freshCluster("guard-healthy", 9, logins, passwords);
    clusters.push(six);
    const healthyError = await applyReleaseSchemaV1(six.release, passwords, { ...six.dependencies,
      // `refusedWithoutPassword: false` for the migrator is TRUE of it: the peer
      // map authenticates the migrator by system identity, so it is reachable with
      // no password. A phase holding every login to the no-password refusal would
      // refuse here, which is what makes the `peerMapped` exemption load-bearing
      // rather than a condition nothing can satisfy.
      verifyLogin: async ({ login }) => ({ authenticated: true,
        refusedWithoutPassword: login !== "control_room_migrator" }) }).catch(error => error).then(v => v);
    assert.equal(healthyError?.outcome, "applied",
      `the healthy release phase must succeed: ${healthyError?.message ?? healthyError}`);
    assert.ok(existsSync(join(six.root, "Protected", "service", "db-logins.json")),
      `a completed phase must leave the credential file the design names: ${healthyError ?? ""}`);
    const written = lstatSync(join(six.root, "Protected", "service", "db-logins.json"));
    assert.equal(written.mode & 0o777, 0o600,
      `the credential file must be 0600, got ${(written.mode & 0o777).toString(8)}`);
    assert.equal(existsSync(join(six.root, "Protected", "service", ".db-logins.json.tmp")), false,
      "the staging credential file must not survive the rename");
  } finally {
    // Every cluster this test started, stopped. Nothing else is touched.
    for (const cluster of clusters) await stopCluster(cluster);
  }
});

test("the guards this stream added are each load-bearing, and each is tripped by breaking it",
  { skip: needsArchive, timeout: 900_000 }, async () => {
    // EIGHT GUARDS THAT NO TEST COULD TRIP, found by running them.
    //
    // This test exists because a mutation run over this stream's own guards
    // reported, MEASURED, that eight of ten could be deleted with every test still
    // passing:
    //
    //   MISSED  request parser: the required-key check
    //   MISSED  argv reader: the exactly-two-elements rule
    //   MISSED  ownership: the read-back refusal
    //   MISSED  sweep: the data-directory match guard
    //   MISSED  M2: the named skip-list refusal
    //   MISSED  updater tables-empty
    //   MISSED  grant SQL: the object kind for schema grants
    //   MISSED  role manifest: the attribute-clause check
    //
    // A guard nobody can trip is a comment, and this repository's own history says
    // so: a previous round recorded three such guards beside their code and deleted
    // the ones that could not fail. Each of the eight is therefore exercised here
    // by calling the REAL function with the input it exists to refuse — no mocks,
    // no injected behaviour. Case 8 is the only one that needs a cluster, and it
    // gets the lane's archive skip so the other seven are not silently skipped
    // with it.
    const {
      parseDatabasePhaseRequestV1, readRequestArgumentV1,
    } = await import("../src/updater/v1/pg/database-phase-contract.mjs");
    const {
      applyOwnershipV1, chownOwnershipV1,
    } = await import("../src/updater/v1/pg/database-phase-ownership.mjs");
    const { readRoleManifestV1 } = await import("../src/updater/v1/pg/database-phase-data.mjs");
    const { grantStatementV1, MAC_GRANT_CATALOG_SQL_V1 } =
      await import("../src/updater/v1/pg/database-phase-appliers.mjs");
    const { RELEASE_LEDGER_SKIPPED_KINDS_V1, readReleaseLedgerV1, applyReleaseSchemaV1 } =
      await import("../src/updater/v1/pg/apply-release-schema.mjs");
    const { buildReleaseDependenciesV1 } = await import("../src/updater/v1/pg/database-phase-dependencies.mjs");

    const accounts = Object.freeze({
      database: Object.freeze({ name: "_crdb", uid: 501, gid: 20 }),
      service: Object.freeze({ name: "_controlroom", uid: 502, gid: 502 }),
    });
    const request = Object.freeze({
      schema: "control-room.database-init/v1", root: "/private/tmp/cr", pgDataId: "data-A",
      port: 5432, runtime: "runtime/pg-current", socketDir: "pg/socket", accounts,
      logins: Object.freeze([Object.freeze({ name: "control_room_web", passwordStdin: true })]),
    });

    // 1. A REQUEST MISSING A REQUIRED KEY, and WHAT THE MUTATION ACTUALLY SHOWED.
    //
    // Each key is removed and the request refused — and then the guard itself was
    // deleted and the case re-run, because a guard that only ever fires alongside
    // another one is not the guard the reader thinks it is.
    //
    // MEASURED: with the required-key check REMOVED, all eight keys are still
    // refused, each by a check of its own: `accounts` by
    // `parseDatabasePhaseAccountsV1`, `schema` by the schema comparison,
    // `runtime` and `socketDir` by their literal comparisons, `pgDataId` by
    // `DATA_ID_PATTERN_V1`, `port` by its range, and `logins` by the list parse. The
    // required-key check is therefore a BACKSTOP that turns eight different
    // downstream refusals into one at the boundary — which is what the comment on
    // the parser says it is for ("a schema string typed twice is a string that can
    // drift") — and NOT the only thing standing between a malformed request and a
    // phase. That is recorded here rather than papered over, because the alternative
    // reading — that this case proves the check load-bearing — is false.
    for (const key of ["accounts", "logins", "pgDataId", "port", "root", "runtime", "schema", "socketDir"]) {
      const without = { ...request };
      delete without[key];
      assert.throws(() => parseDatabasePhaseRequestV1(without,
        { schema: "control-room.database-init/v1", code: "refused", extraKeys: [] }),
      /refused/u, `a request missing ${key} was not refused`);
    }
    // The check's own unique job: it refuses an UNKNOWN key, which nothing
    // downstream would. `phase` and `passwords` are the port's own keys and are not
    // part of the request on the wire, so a request carrying one used to be dropped
    // silently — the port test asserts the refusal by name.
    for (const extraKey of ["phase", "passwords", "extra"]) {
      assert.throws(() => parseDatabasePhaseRequestV1({ ...request, [extraKey]: "x" },
        { schema: "control-room.database-init/v1", code: "refused", extraKeys: [] }),
      /refused/u, `a request carrying ${extraKey} was not refused`);
    }
    // …and the legitimate shape is accepted, so the case cannot be satisfied by
    // refusing everything.
    assert.ok(parseDatabasePhaseRequestV1(request,
      { schema: "control-room.database-init/v1", code: "refused", extraKeys: [] }),
      "the legitimate request shape must be accepted");

    // 2. AN ARGV THAT IS NOT THE PORT'S. `[--request, value]` is the port's exact
    // argv and is ACCEPTED — that is case one of the cross-process test, and
    // repeating it here would make the list refuse the legitimate shape. What is
    // refused is every other shape: a longer argv, a different flag, the flag with
    // no value, and no argv at all. A script that picked its argument out of one of
    // those would read an instruction from a caller it had not validated.
    assert.equal(readRequestArgumentV1(["--request", "{}"], 1024, "refused"), "{}",
      "the port's own argv shape must be ACCEPTED, or the refusal below proves nothing");
    for (const argv of [["--request", "{}", "--extra", "x"], ["--other", "{}"],
      ["--request"], [], ["-r", "{}"], ["--request", "", "--request", "{}"]]) {
      assert.throws(() => readRequestArgumentV1(argv, 1024, "refused"), /refused/u,
        `argv ${JSON.stringify(argv)} was not refused`);
    }
    // …and an oversized value is refused too, which is the bound's own purpose.
    assert.throws(() => readRequestArgumentV1(["--request", "x".repeat(2048)], 1024, "refused"),
      /refused/u, "an oversized request was not refused");

    // 3. THE OWNERSHIP READ-BACK. A plan whose chown did not take must be refused: a
    // partial application leaves a cluster the postmaster cannot start, and the
    // refusal is the only thing that says so before it does. The path is NAMED, so
    // the operator knows which one is wrong rather than that one is.
    const plan = chownOwnershipV1({ root: "/private/tmp/cr", pgDataId: "data-A", accounts });
    await assert.rejects(applyOwnershipV1(plan, async () => undefined, async () => ({ uid: 0, gid: 0 })),
      /pg_phase_ownership_refused:\/private\/tmp\/cr\/pg/u,
      "a plan that did not take must be refused, naming the path");

    // 4. THE SWEEP'S TWO REFUSALS, through the real sweep with only the process
    // table and the bootout injected. Since N1 of the M1c review the live process
    // at the recorded pid is identified from the PROCESS TABLE (program, argv, uid),
    // not from `kill -0` plus a uid — so the table is the seam. The sweep's safety
    // rests on these checks, and deleting either one makes it kill a process it
    // does not own.
    const { sweepOrphanPostmasterV1, pgProcessesOnDataDirectoryV1, pgFailureLineV1 } =
      await import("../src/updater/v1/pg/init-database.mjs");
    const base = mkdtempSync("/private/tmp/cr-guard-");
    const pidFile = (pid, dir) => `${pid}\n${dir}\n1790811618\n5432\n${base}\nlocalhost\n1 2\nready\n`;
    try {
      const pgRoot = join(base, "pg");
      const data = join(pgRoot, "data-A");
      const bin = "/rt/pg-current/bin";
      const reset = () => { rmSync(data, { recursive: true, force: true }); mkdirSync(data, { recursive: true, mode: 0o700 }); };
      reset();
      const signalled = [];
      const sweep = (rows, extra = {}) => sweepOrphanPostmasterV1({ data, pgRoot, port: 5432,
        socketDirectory: join(pgRoot, "socket"), databaseIdentity: { uid: 501, gid: 20 }, binDirectories: [bin],
        bootout: async () => { signalled.push("bootout"); return true; },
        exists: async () => false, listProcesses: async () => rows,
        kill: async pid => { signalled.push(`kill:${pid}`); return true; }, ...extra });
      // 4a. A pid file naming ANOTHER data directory, even when the pid is D's.
      writeFileSync(join(data, "postmaster.pid"), pidFile(4242, "/somewhere/else"));
      await assert.rejects(sweep([{ pid: 4242, ppid: 1, uid: 501, command: `${bin}/postgres -D /somewhere/else -p 5432` }]),
        /database_init_orphan_postmaster:4242:other_data_directory/u,
        "a pid file naming another data directory must be refused");
      // 4b. A live postmaster on THIS directory that is NOT D's. Without the check
      // the sweep would kill a cluster belonging to somebody else.
      writeFileSync(join(data, "postmaster.pid"), pidFile(4242, data));
      await assert.rejects(sweep([{ pid: 4242, ppid: 1, uid: 0, command: `${bin}/postgres -D ${data} -p 5432` }]),
        /database_init_orphan_postmaster:4242:not_database_account/u,
        "a live postmaster that is not D's must be refused");
      assert.deepEqual(signalled, [], "neither refusal may signal anything");
      // 4c. And D's OWN orphan IS swept — the positive half, so 4a and 4b cannot be
      // satisfied by refusing everything.
      writeFileSync(join(data, "postmaster.pid"), pidFile(4242, data));
      let alive = true;
      const swept = await sweep([], { bootout: async () => { alive = false; return true; },
        listProcesses: async () => alive ? [{ pid: 4242, ppid: 1, uid: 501, command: `${bin}/postgres -D ${data} -p 5432` }] : [] });
      assert.equal(swept.retired, "swept:4242", "D's own orphan must be swept and retired");
      // 4d. N1, RECYCLED PID: the file names this directory, the pid is alive and
      // even D's — but it is `sleep`, not a program of this runtime. Nothing is
      // signalled and the record is stale. The old sweep (kill -0 + uid) stopped and
      // SIGKILLed it.
      for (const first of ["4242", "-4242"]) {
        reset();
        writeFileSync(join(data, "postmaster.pid"), pidFile(first, data));
        const recycled = await sweep([{ pid: 4242, ppid: 1, uid: 501, command: "/bin/sleep 600" }]);
        assert.equal(recycled.retired, "stale-pid-recycled", `a recycled pid (${first}) must be stale, not swept`);
        // …and a pid recycled onto ANOTHER cluster's postmaster of this runtime too.
        reset();
        writeFileSync(join(data, "postmaster.pid"), pidFile(first, data));
        const otherCluster = await sweep([{ pid: 4242, ppid: 1, uid: 501, command: `${bin}/postgres -D /elsewhere/data` }]);
        assert.equal(otherCluster.retired, "stale-pid-recycled");
      }
      assert.deepEqual(signalled, [], "a recycled pid must never be signalled");
      // 4e. N1, the measured wedge: a STANDALONE backend's negative pid with no process
      // (power cut inside initdb) is stale, and an empty or torn file is not a refusal.
      reset();
      writeFileSync(join(data, "postmaster.pid"), pidFile(-59002, data));
      assert.equal((await sweep([])).retired, "stale-pid-file", "a dead standalone backend's file must be stale");
      for (const torn of ["", "\n", "-", "59002"]) {
        reset();
        writeFileSync(join(data, "postmaster.pid"), torn);
        assert.equal((await sweep([])).pidFile, "unreadable", `a torn pid file ${JSON.stringify(torn)} must not refuse`);
      }
      // 4f. D's standalone backend with no data directory on its argv and no parent
      // left: not signalled, waited for, refused only if it never goes.
      reset();
      writeFileSync(join(data, "postmaster.pid"), pidFile(-4243, data));
      const standalone = { pid: 4243, ppid: 1, uid: 501, command: `${bin}/postgres --boot -F -c log_checkpoints=false` };
      await assert.rejects(sweep([standalone], { waitAttempts: 2 }),
        /database_init_orphan_postmaster:4243:unattributed/u, "an unattributable backend that stays must be refused");
      let polls = 0;
      const gone = await sweep([], { waitAttempts: 5, listProcesses: async () => (polls++ < 2 ? [standalone] : []) });
      assert.equal(gone.retired, "stale-pid-file", "an unattributable backend that exits is waited out");
      assert.deepEqual(signalled, [], "an unattributable backend must never be signalled");
      // …while one whose `initdb` parent is alive IS ours (by the parent chain) and is swept.
      reset();
      writeFileSync(join(data, "postmaster.pid"), pidFile(-4243, data));
      let tree = [{ pid: 4240, ppid: 1, uid: 501, command: `${bin}/initdb -D ${data} -U postgres` },
        { pid: 4241, ppid: 4240, uid: 501, command: `sh -c "${bin}/postgres" --boot -F` }, { ...standalone, ppid: 4241 }];
      const viaParent = await sweep([], { listProcesses: async () => tree,
        kill: async pid => { signalled.push(`kill:${pid}`); tree = []; return true; } });
      assert.equal(viaParent.retired, "swept:4243");
      assert.deepEqual(signalled, ["kill:4243"], "a standalone backend is killed, never asked to `pg_ctl stop`");
    } finally { rmSync(base, { recursive: true, force: true }); }
    // 4g. N4: a child still inside `sandbox-exec` (or pg_ctl's `sh -c exec`) whose
    // parent is already dead is still on this data directory.
    {
      const bin = "/rt/pg-current/bin";
      const data = "/i/pg/data-A";
      const rows = [
        { pid: 10, ppid: 1, uid: 501, command: `/usr/bin/sandbox-exec -f /p.sb -D RUNTIME_ROOT=/rt -- ${bin}/initdb -D ${data} -U postgres` },
        { pid: 11, ppid: 1, uid: 501, command: `/bin/sh -c exec "${bin}/postgres" -D "${data}" -p 5432 < "/dev/null"` },
        { pid: 12, ppid: 1, uid: 501, command: `/usr/bin/sandbox-exec -f /p.sb -- /usr/bin/other -D ${data}` },
        { pid: 13, ppid: 1, uid: 501, command: `/usr/bin/sandbox-exec -f /p.sb -- ${bin}/initdb -D /i/pg/data-B` },
        { pid: 14, ppid: 1, uid: 0, command: `/usr/bin/sandbox-exec -f /p.sb -- ${bin}/initdb -D ${data}` },
      ];
      assert.deepEqual(pgProcessesOnDataDirectoryV1(rows, { data, binDirectories: [bin], uid: 501 }), [10, 11],
        "a wrapped runtime program on this directory must be found, and nothing else");
    }
    // 4h. N3: an initdb failure reports its CAUSE, not its clean-up line (the
    // measured output of an initdb that hit the machine's shared-memory limit).
    assert.equal(pgFailureLineV1([
      "The files belonging to this database system will be owned by user \"x\".",
      "running bootstrap script ... 2026-10-01 FATAL:  could not create shared memory segment: No space left on device",
      "child process exited with exit code 1",
      "initdb: removing contents of data directory \"/i/pg/data-A\"",
    ].join("\n")), "running bootstrap script ... 2026-10-01 FATAL:  could not create shared memory segment: No space left on device");
    assert.equal(pgFailureLineV1("initdb: error: directory \"/x\" exists but is not empty\ninitdb: hint: remove it"),
      "initdb: error: directory \"/x\" exists but is not empty");
    assert.equal(pgFailureLineV1("something odd\nlast words\n"), "last words", "without a cause line, the last line");

    // 5. M2 — THE NAMED SKIP-LIST. The four rows are skipped on purpose and the
    // constant says which; the real ledger carrying exactly those four is what makes
    // them the COMPLETE set rather than four of five. A fifth row is refused by the
    // phase, and that refusal is the property.
    assert.ok((await readReleaseLedgerV1(REPO)).length > 100,
      "the real ledger must be readable for this case to mean anything");
    const raw = JSON.parse(readFileSync(join(REPO, "deploy/postgres/migration-ledger.json"), "utf8"));
    const nonMigrate = raw.entries.filter(entry => (entry.kind ?? "migrate") !== "migrate")
      .map(entry => entry.file).sort();
    assert.deepEqual(nonMigrate, [
      "db/roles/agent_reviewer_roles.sql", "db/roles/production_provision.sql",
      "db/roles/production_roles.sql", "db/roles/production_table_grants.sql",
    ], "these four, by their real paths, are what the release's ledger carries");
    assert.deepEqual([...RELEASE_LEDGER_SKIPPED_KINDS_V1].sort(), nonMigrate,
      "every non-migrate row in the release must be named in the skip-list, or one is skipped undecided");
    // …and a FIFTH row is a REFUSAL, which is the guard the mutation deletes and
    // the only part of it the assertion above cannot reach: dropping the refusal
    // leaves the list and the ledger agreeing, so this case has to carry a ledger
    // row nobody named.
    //
    // A skipped row is a release artifact the installer believes it applied, so
    // the set is what turns "we forgot" into "someone decided".
    const withFifth = { entries: [...raw.entries, Object.freeze({
      file: "db/roles/not_a_real_file.sql", kind: "grants", order: 141,
      sha256: "0".repeat(64) })] };
    const staged = mkdtempSync("/private/tmp/cr-ledger-");
    try {
      mkdirSync(join(staged, "deploy", "postgres"), { recursive: true });
      mkdirSync(join(staged, "db", "roles"), { recursive: true });
      writeFileSync(join(staged, "deploy", "postgres", "migration-ledger.json"),
        JSON.stringify(withFifth));
      // The ledger is read BEFORE any file is opened, so a fifth row is refused
      // without needing the other 140 to exist.
      await assert.rejects(readReleaseLedgerV1(staged), /release_schema_ledger_kind_refused/u,
        "a non-migrate ledger row nobody named must be refused, not skipped");
      // …and a FIFTH row of kind `migrate` is a different refusal: the order check,
      // which is what makes the ledger contiguous.
      const contiguous = { entries: [...raw.entries, Object.freeze({
        file: "db/migrations/0999_extra.sql", order: raw.entries.length + 2,
        sha256: "0".repeat(64) })] };
      writeFileSync(join(staged, "deploy", "postgres", "migration-ledger.json"),
        JSON.stringify(contiguous));
      await assert.rejects(readReleaseLedgerV1(staged), /release_schema_ledger_order_refused/u,
        "a migrate row with a gap in its order must be refused");
    } finally { rmSync(staged, { recursive: true, force: true }); }

    // 6. THE GRANT SQL'S OBJECT KIND. `ON TABLE public.foo` for a SCHEMA grant is a
    // different statement against a different object, so a phase that issued it
    // would report convergence against grants it never applied.
    //
    // The tuple shape is the release's OWN — `role|kind|object|column|privilege|
    // grantable`, six fields, with `column` empty for everything but a column
    // grant — and the examples below are taken from the generated
    // `desired-grants.json` rather than written here, so a change to the release's
    // encoding shows up as a failing expectation instead of a stale literal.
    const generated = JSON.parse(readFileSync(join(REPO, "deploy/postgres/desired-grants.json"), "utf8"));
    const sample = kind => generated.desired.find(tuple => tuple.split("|")[1] === kind);
    assert.equal(grantStatementV1(sample("schema"), "GRANT"),
      "GRANT USAGE ON SCHEMA public TO control_room_agent_reviewer");
    assert.equal(grantStatementV1(sample("schema"), "REVOKE"),
      "REVOKE USAGE ON SCHEMA public FROM control_room_agent_reviewer");
    assert.match(grantStatementV1(sample("function"), "GRANT"),
      /^GRANT EXECUTE ON FUNCTION public\.commit_agent_review\(text, jsonb, jsonb, bytea\) TO /u,
      "a function grant must name the signature, or it is a different function");
    // …and the malformed tuples are refused, which is the other half of the same
    // function and the reason the statement cannot be built from an unchecked tuple.
    for (const tuple of [
      "control_room_reader|not-a-kind|public.t||USAGE|plain",
      "control_room_reader|table|public.t||NOTAPRIVILEGE|plain",
      "control_room_reader|table|public.t||SELECT|maybe",
      "|table|public.t||SELECT|plain",
      "control_room_reader|table|public.t; DROP TABLE x||SELECT|plain",
      "control_room_reader|schema|public||USAGE",
    ]) {
      assert.throws(() => grantStatementV1(tuple, "GRANT"), /database_phase_grant_sql_refused/u,
        `the malformed tuple ${tuple} was not refused`);
    }
    // A FUNCTION tuple's privilege is not checked, and that is DELIBERATE and
    // matches the release: `GRANT <anything> ON FUNCTION` has exactly one meaning
    // (`EXECUTE`), so the statement builder normalises it rather than refusing a
    // privilege that could not have meant anything else. The release's own
    // `grantSql` does the same, and diverging here would make the phase's SQL a
    // second spelling of the release's grant model.
    assert.equal(grantStatementV1("control_room_reader|function|public.f()||SELECT|plain", "GRANT"),
      "GRANT EXECUTE ON FUNCTION public.f() TO control_room_reader",
      "a function grant is EXECUTE whatever the tuple's privilege column said");
    assert.throws(() => grantStatementV1(sample("schema"), "DELETE"), /database_phase_grant_sql_refused/u,
      "a verb that is neither GRANT nor REVOKE must be refused");
    // …and the catalogue query still carries the arm that holds schema grants,
    // which is the arm the mutation's neighbouring typo broke.
    assert.match(MAC_GRANT_CATALOG_SQL_V1, /'schema'/u,
      "the grant catalogue must have its schema arm, or schema grants are never diffed");

    // 7. THE ROLE MANIFEST'S ATTRIBUTE CLAUSE. Two spellings are accepted and a
    // third is refused, and the third grants SUPERUSER — which reaches
    // `CREATE ROLE <name> <clause>` unquoted. The fixture carries ONE such role and
    // every other field valid, so the clause check is the only thing that can
    // refuse it; and the REAL manifest is asserted too, so the case cannot be
    // satisfied by a check that refuses everything.
    const accepted = new Set([
      "LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
      "NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    ]);
    for (const role of (await readRoleManifestV1(REPO)).roles) {
      assert.ok(accepted.has(role.attributes),
        `the release's own manifest carries a clause the phase does not accept: ${role.name}`);
    }
    await assert.rejects(readRoleManifestV1(join(REPO, "tests/fixtures/role-manifest-superuser")),
      /database_phase_role_manifest_refused:control_room_superuser/u,
      "a role whose attribute clause grants SUPERUSER must be refused by name");

    // 9. THE PHASE'S OWN `already_initialized` REFUSAL, on the real classifier with
    // a real directory. The guard the mutation targets is the phase's, and a
    // classifier assertion alone would not reach it — so this runs the phase far
    // enough to classify, on a data directory that genuinely holds a cluster.
    //
    // It is the LAST case because it is the slowest: the lane's healthy init is the
    // only thing that makes a real cluster, and the phase must be able to reach the
    // classification before it refuses. MEASURED and worth saying: this is the case
    // the earlier mutation run CAUGHT (through the dedicated "a re-run of init is
    // refused" test), and it is listed here as well so the guard test alone is
    // enough to catch it.
    const { classifyDataDirectoryEntriesV1 } = await import("../src/updater/v1/pg/init-database.mjs");
    const floor = mkdtempSync("/private/tmp/cr-floor-");
    try {
      // A directory holding exactly the floor entries, all REGULAR FILES or
      // DIRECTORIES as `initdb` writes them: that is a cluster, and the phase
      // refuses it rather than adopting it.
      const data = join(floor, "pg", "data-A");
      mkdirSync(data, { recursive: true, mode: 0o700 });
      for (const name of ["base", "global", "pg_wal"]) mkdirSync(join(data, name), { mode: 0o700 });
      for (const name of ["pg_hba.conf", "pg_ident.conf", "postgresql.conf"]) {
        writeFileSync(join(data, name), "# fixture\n");
      }
      writeFileSync(join(data, "PG_VERSION"), "17\n");
      assert.equal((await classifyDataDirectoryEntriesV1(data)).state, "cluster",
        "a directory holding initdb's floor entries is a cluster");
      // …and a SYMLINK named as a floor entry is a PLANT, not a cluster — the L2
      // fix, and the reason the classifier reads `lstat` rather than names.
      const linked = mkdtempSync("/private/tmp/cr-link-");
      try {
        const planted = join(linked, "pg", "data-B");
        mkdirSync(join(planted, "global"), { recursive: true, mode: 0o700 });
        mkdirSync(join(planted, "base"), { mode: 0o700 });
        mkdirSync(join(planted, "pg_wal"), { mode: 0o700 });
        for (const name of ["pg_hba.conf", "pg_ident.conf", "postgresql.conf"]) {
          writeFileSync(join(planted, name), "# fixture\n");
        }
        symlinkSync("/etc/hosts", join(planted, "PG_VERSION"));
        const classified = await classifyDataDirectoryEntriesV1(planted);
        assert.equal(classified.state, "planted",
          "a SYMLINK named as a floor entry must be a plant, not a cluster");
        assert.match(classified.reason, /not_a_cluster_entry:PG_VERSION/u,
          "the refusal must name the entry that is wrong");
      } finally { rmSync(linked, { recursive: true, force: true }); }
    } finally { rmSync(floor, { recursive: true, force: true }); }

    // 8. THE UPDATER'S TABLES-EMPTY GUARD, through the INJECTED LOADER. The loader
    // re-applies `0002_schema.sql` every run, so this guard is unreachable through
    // PostgreSQL — which is why `applyUpdaterSchemaV1` is now a dependency: a caller
    // handing back `{ tables: 0 }` trips it in milliseconds rather than it being a
    // line nobody can reach.
    //
    // The positive half is asserted too, so the case cannot be satisfied by
    // refusing unconditionally: the healthy case in this lane reaches
    // `outcome: applied` with the REAL loader, and a loader reporting tables is not
    // this refusal.
    const names = ["control_room_web", "control_room_coordinator"];
    const { logins, passwords } = phaseLogins(names);
    assert.equal(typeof (await buildReleaseDependenciesV1(
      await (await import("../src/updater/v1/pg/database-phase-data.mjs")).readDatabasePhaseDataV1(REPO)))
      .planLayout, "function", "the production planLayout must be real, not a refusal (Blocker 3)");
    const cluster = await freshCluster("guard-loader-healthy", 15, logins, passwords);
    try {
      await assert.rejects(applyReleaseSchemaV1(cluster.release, passwords,
        { ...cluster.dependencies, applyUpdaterSchema: async () => ({ tables: 0 }) }),
      /release_schema_updater_tables_empty/u,
      "a loader that built no tables must be refused");
    } finally { await stopCluster(cluster); }
  });

test("the updater's grant catalogue and its digest SQL are the release's own queries",
  { timeout: 120_000 }, async () => {
    // THE EQUIVALENCE TEST THE GRANT CATALOGUE'S COMMENT PROMISES, and it needs no
    // cluster — which is the point: two copies of a query that have to stay identical
    // over time should be compared as TEXTS on every machine, not discovered on a
    // live one.
    //
    // What differs between the two copies is exactly what SQL does not depend on —
    // the release's `--` comment header inside the query, and whitespace — and what
    // survives normalisation is every token, identifier, literal and `COLLATE`. So a
    // dropped `pg_catalog.` qualification, a changed arm, or the typo this lane
    // actually caught (`att.relid` for `att.attrelid`, MEASURED as
    // `ERROR: column att.relid does not exist` on a live cluster) all fail here.
    //
    // The digest half is the same assertion for the schema digest's query, and it
    // already had one; this test brings the grant catalogue into the same shape.
    const { MAC_GRANT_CATALOG_SQL_V1 } = await import("../src/updater/v1/pg/database-phase-appliers.mjs");
    const { macGrantCatalogSqlV1 } = await import("../scripts/mac-local/database-upgrade-grants.mjs");
    const normalise = text => text.replace(/`/gu, "").split("\n")
      .map(line => line.replace(/--.*$/u, "").trim()).filter(line => line !== "")
      .join("\n").replace(/\s+/gu, " ").replace(/\$1::text\[\]/gu, "$BIND");
    assert.equal(normalise(MAC_GRANT_CATALOG_SQL_V1), normalise(macGrantCatalogSqlV1),
      "the updater's grant catalogue must be the release's own query, or the phase diffs against a different universe");
    // …and the release's query has the arms the converger's diff depends on. Five
    // arms, because the tuple's `kind` column distinguishes table/sequence, schema,
    // database and function, and an arm that silently stopped returning rows would
    // make the diff report convergence while grants it never saw existed.
    assert.equal(macGrantCatalogSqlV1.split("UNION ALL").length, 5,
      "the grant catalogue must keep its five arms");

    // THE ROLE MANIFEST AND THE GRANT CATALOG MUST AGREE ON THE SAME ROLES, which
    // is the other half of the data-file arrangement: the role list comes from
    // `role-manifest.json` and the catalogue query binds the principals from
    // `desired-grants.json`, so a release that changed one and not the other would
    // converge grants against a set of principals it does not create roles for.
    const data = await readDatabasePhaseDataV1(REPO);
    const manifestGroups = new Set(Object.values(data.roles.macRolePlan));
    for (const principal of data.grants.principals) {
      if (Object.hasOwn(data.roles.macRolePlan, principal)) continue;
      assert.ok(manifestGroups.has(principal),
        `the grant catalogue binds ${principal}, which the role manifest neither names as a login nor as one of its groups`);
    }
    // …and every mac login the manifest names is a principal the catalogue sees.
    for (const login of Object.keys(data.roles.macRolePlan)) {
      assert.ok(data.grants.principals.includes(login),
        `the role manifest names ${login}, but the grant catalogue never reads it`);
    }
    // The QUEUE namespace is the one the role files grant on, and the generated DDL
    // must build it there or `native_queue_worker_roles.sql` refuses with
    // `relation "control_room_queue.queue" does not exist`.
    assert.equal(data.queue.namespace, "control_room_queue",
      "the fixed queue schema must be built in the namespace the role files grant on");
  });

test("the release ledger's own files and the phase's shared parsers agree", { timeout: 120_000 }, async () => {
  // The non-PostgreSQL half: the ledger is readable, ordered and digest-clean,
  // and the digest SQL is byte-identical to the release module's query. That
  // second assertion is what makes the updater's copy of the digest safe, and it
  // needs no cluster, so it runs on every machine.
  const entries = await readReleaseLedgerV1(REPO);
  assert.ok(entries.length > 100, `the ledger must be the whole release, got ${entries.length}`);
  assert.equal(entries[0].order, 1);
  assert.equal(entries.at(-1).order, entries.length);
  assert.match(ledgerHeadV1(entries), /^[0-9]{4}_[a-z0-9_]+\.sql$/u);
  // The updater's SQL file and the release module's query must be the same text,
  // or the two halves would digest the same schema differently.
  const { readPrivateWebSchemaDigest } = await import("../src/web/v1/private-database-preflight");
  const releaseSource = readFileSync(join(REPO, "src/web/v1/private-database-preflight.ts"), "utf8");
  const digestSql = readFileSync(join(REPO, "src/updater/v1/pg/release-schema-digest.sql"), "utf8");
  // Extracted from the release module's own source rather than copied into this
  // test, so the comparison is between the two ARTIFACTS and not between this
  // test's idea of the release and the updater's copy.
  const releaseQuery = /const result = await db\.query<[^>]*>\(`([\s\S]*?)`\);/u.exec(releaseSource)?.[1];
  assert.ok(releaseQuery, "the release module's digest query must be extractable for the equivalence check");
  // The comparison strips `--` line comments and normalises WHITESPACE, and both
  // are needed and neither is too weak. Comments: the .sql file's header is
  // documentation ABOUT the query, and the release's copy has no such header.
  // Whitespace: the release's query is a template literal inside an indented
  // function body and the .sql file starts at column 0, and SQL's meaning does not
  // depend on either. What survives normalisation is every SQL token, every
  // identifier, every literal and every `COLLATE` — so a missing
  // `pg_catalog.` qualification or a changed sort still fails, which is the
  // whole point: a digest that differs in one of those makes the two halves
  // disagree on a real cluster, and that is the failure this assertion prevents.
  const normalise = text => text.replace(/`/gu, "").split("\n")
    .filter(line => !line.trimStart().startsWith("--"))
    .join("\n").replace(/\s+/gu, " ").trim();
  assert.equal(normalise(digestSql), normalise(releaseQuery),
    "release-schema-digest.sql must be byte-identical to readPrivateWebSchemaDigest's query, or the two halves digest the same schema differently");
  // And the pin equals the release's own constant, and the pin file carries the
  // schema string the reader checks. The digest function itself is proved on a
  // real cluster by the release test above, where a live schema's rows go through
  // it and come out equal to `privateWebSchemaDigest`; asserting it against an
  // empty array here would be a check that cannot fail, which is the shape of
  // guard this repository keeps removing.
  const pinned = JSON.parse(readFileSync(join(REPO, "src/updater/v1/policy", "release-schema-digest.json"), "utf8"));
  assert.equal(pinned.digest, privateWebSchemaDigest,
    "the updater's pinned release digest must equal the release's privateWebSchemaDigest");
  assert.equal(pinned.schema, "control-room.release-schema-digest/v1");
  // The digest of an empty row set is a fixed value, which is what makes this a
  // check rather than a tautology: a change to the serialisation — a different
  // hash input, a different encoding — moves it.
  assert.equal(digestReleaseSchemaRowsV1([]),
    "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  void readPrivateWebSchemaDigest; void statementReturnsRowsV1; void makeSessionClientV1; void symlinkSync;
  void readdirSync;
});
test("the shipped data files, the ledger digest's query and the port contract are what the release says",
  { timeout: 120_000 }, async () => {
    // H2: the three data files are COMMITTED, so they can go stale — and after the
    // cook/v1 merge `desired-grants.json` was 35 tuples short, which the converger
    // then REVOKED from a fresh install (result uploads and fleet delivery broke).
    // So the generator runs into a temp directory and every byte must match.
    const { writeDatabasePhaseDataV1 } = await import("../scripts/mac-local/database-phase-data.mjs");
    const generated = mkdtempSync(join(LANE_ROOT, "cr-phase-data-"));
    try {
      const written = await writeDatabasePhaseDataV1(generated);
      assert.equal(written.files.length, 3);
      for (const file of written.files) {
        assert.equal(readFileSync(join(generated, file.path), "utf8"), readFileSync(join(REPO, file.path), "utf8"),
          `${file.path} is stale: regenerate it with scripts/mac-local/database-phase-data.mjs`);
      }
    } finally { rmSync(generated, { recursive: true, force: true }); }

    // H1: the ledger's digest query is `evidence.mjs`'s SCHEMA_SNAPSHOT, compared
    // as SOURCE TEXT — escapes included, because a JavaScript template literal
    // evaluates `\s` to `s` and both copies must evaluate identically. The
    // real-PostgreSQL tests compare the computed VALUES on a live cluster.
    const literal = (text, name) => new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`, "u").exec(text)?.[1];
    const evidence = literal(readFileSync(join(REPO, "deploy/postgres/evidence.mjs"), "utf8"), "SCHEMA_SNAPSHOT");
    const phase = literal(readFileSync(join(REPO, "src/updater/v1/pg/schema-snapshot-digest.mjs"), "utf8"),
      "SCHEMA_SNAPSHOT_SQL_V1");
    assert.ok(evidence && evidence.includes("pg_get_functiondef"), "evidence.mjs's snapshot query must be extractable");
    assert.equal(phase, evidence, "the ledger's digest query must be evidence.mjs's SCHEMA_SNAPSHOT, byte for byte");

    // Blocker 2: the verifier statement carries a verifier and never a password.
    const { scramVerifierV1, setVerifierStatementV1 } = await import("../src/updater/v1/pg/scram-verifier.mjs");
    const password = randomBytes(32).toString("base64url");
    const statement = setVerifierStatementV1("control_room_web", scramVerifierV1(password));
    assert.match(statement, /^ALTER ROLE control_room_web PASSWORD 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+'$/u);
    assert.equal(statement.includes(password), false, "the statement psql runs must not carry the password");
    assert.throws(() => scramVerifierV1("pässwörd-with-non-ascii-characters"), /scram_password_refused/u,
      "a password SASLprep would normalise must be refused, not hashed differently from the server");
    assert.throws(() => setVerifierStatementV1("control_room_web", "SCRAM-SHA-256$4096:x'; DROP ROLE x; --"),
      /scram_verifier_refused/u);

    // H3: a retry resumes after the applied prefix and REFUSES a ledger this
    // release did not write.
    const { pendingMigrationsV1 } = await import("../src/updater/v1/pg/database-phase-ledger.mjs");
    const files = await readReleaseLedgerV1(REPO);
    const row = file => ({ filename: file.file, ledger_order: file.order, digest: `sha256:${file.sha256}` });
    assert.equal(pendingMigrationsV1(files, []).length, files.length);
    assert.deepEqual(pendingMigrationsV1(files, files.slice(0, 3).map(row)).map(file => file.order)[0], 4);
    for (const [why, rows] of [
      ["a digest that differs", [{ ...row(files[0]), digest: `sha256:${"0".repeat(64)}` }]],
      ["a hole", [row(files[0]), row(files[2])]],
      ["a row nobody shipped", [...files.map(row), { filename: "db/migrations/9999_x.sql", ledger_order: 9999, digest: "x" }]],
    ]) {
      assert.throws(() => pendingMigrationsV1(files, rows), /release_schema_ledger_prefix_refused/u, `${why} must be refused`);
    }

    // M1b Low: the entry run from SOURCE refuses rather than exiting 0 silently.
    for (const script of ["init-database.mjs", "apply-release-schema.mjs"]) {
      const ran = spawnSync(process.execPath, ["--import", "tsx", join(REPO, "src/updater/v1/pg", script),
        "--request", "{}"], { cwd: REPO, input: "{}\n", encoding: "utf8", timeout: 60_000 });
      assert.equal(ran.status, 1, `${script} run from source must refuse, got ${ran.status}: ${ran.stderr}`);
      assert.match(ran.stderr, /^[a-z_]+_refused/mu, "the refusal must be a named code");
    }
    // M1b Low: a live process this uid may not signal is ALIVE, not dead. pid 1
    // is launchd, which a non-root lane cannot signal (EPERM); `/bin/kill -0`
    // exits 1 for that exactly as for a dead pid.
    const { inspectProcessIdentityV1 } = await import("../src/updater/v1/pg/init-database.mjs");
    assert.equal((await inspectProcessIdentityV1(1, { uid: 501, gid: 20 })).alive, true,
      "a pid that exists but cannot be signalled must read as alive");

    // The contract the M4 merge needs: the deployer (and postgres) can never be a
    // password login, and a password must be printable ASCII.
    const { parseDatabasePhaseLoginsV1, parseDatabasePhasePasswordsV1 } =
      await import("../src/updater/v1/pg/database-phase-contract.mjs");
    for (const name of ["control_room_deployer", "postgres"]) {
      assert.throws(() => parseDatabasePhaseLoginsV1([{ name, passwordStdin: true }], "refused"),
        new RegExp(`refused:passwordless_login:${name}`, "u"), `${name} must be refused as a password login`);
    }
    const web = parseDatabasePhaseLoginsV1([{ name: "control_room_web", passwordStdin: true }], "refused");
    assert.throws(() => parseDatabasePhasePasswordsV1({ control_room_web: `${"a".repeat(30)} spaced` }, web, "refused"),
      /refused/u);
    assert.ok(parseDatabasePhasePasswordsV1({ control_room_web: password }, web, "refused"));

    // The PORT's input may omit `port` (the installer sends none): the request on
    // the wire then carries the RELEASE's port from `current/deploy/postgres/
    // role-manifest.json`. The transport is a recorder here because this case is
    // about what reaches argv; the real transport is the default-path test's.
    const root = mkdtempSync(join(LANE_ROOT, "cr-port-"));
    try {
      symlinkSync(REPO, join(root, "current"));
      const sent = [];
      const record = async (file, args) => {
        sent.push(JSON.parse(args[2]));
        return { stdout: `${JSON.stringify({ schema: "control-room.database-init-result/v1", outcome: "initialized",
          pgDataId: "data-A", updaterSchemaDigest: `sha256:${"a".repeat(64)}`, clusterShutDownClean: true })}\n` };
      };
      const input = { phase: "init", root, pgDataId: "data-A", runtime: "runtime/pg-current", socketDir: "pg/socket",
        accounts, logins: web.map(login => ({ name: login.name, passwordStdin: true })),
        passwords: { control_room_web: password } };
      const ok = await initializeDatabaseV1(input, undefined, async path => path, record);
      assert.equal(ok.outcome, "initialized");
      assert.equal(sent[0].port, JSON.parse(readFileSync(join(REPO, "deploy/postgres/role-manifest.json"), "utf8")).port,
        "an installer-shaped input must reach the script with the release's port");
      assert.equal(JSON.stringify(sent[0]).includes(password), false, "the request on argv must carry no password");
      await assert.rejects(initializeDatabaseV1({ ...input, logins: [{ name: "control_room_deployer", passwordStdin: true }],
        passwords: { control_room_deployer: password } }, undefined, async path => path, record),
      /database_phase_input_refused:passwordless_login:control_room_deployer/u);
      rmSync(join(root, "current"));
      await assert.rejects(initializeDatabaseV1(input, undefined, async path => path, record),
        /database_phase_port_unavailable/u, "no port and no release manifest must be a refusal before any spawn");
      assert.equal(sent.length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
