// THE SERVICE BRING-UP LANE (rv-9c "Missing proof"): the installed supervisor (and
// through it the web host) and the installed fleet gateway, started from a COPIED
// attended release, against a REAL PostgreSQL made by the real init and release
// phases and the real first-owner child, and judged by the installer's own health
// checks.
//
// WHY IT EXISTS: every earlier lane stopped at the database. The installer's tests
// used stand-ins for the config composer and for the services, so five separate
// reasons the installed services cannot start (rv-9c N-A to N-E) were invisible
// until a reviewer started them by hand. This lane is that hand run, kept.
//
// WHAT IS REAL, in install order (`install-steps.mjs` → `continueInstallV1`):
//   - the release: built in the attended build's working folder `<root>/build/<job>`
//     (a clone of this checkout at HEAD plus its uncommitted edits, with its own
//     `pnpm install`) by `scripts/build-vps.mjs` (what `pnpm run build` runs) and
//     `buildAttendedReleaseV1`, then COPIED to `releases/<version>-<commit12>` with
//     the staging modes (0550/0440) and `current -> releases/<id>`. The build folder
//     is then DELETED, as `closeSession` does, before any database step, and the
//     release's server bundle must not name it or this checkout (bring-up N-K):
//     everything below, the first-owner child and both services included, runs
//     without it;
//   - the installer's directory layout and modes (`installer.mjs` `createLayout`)
//     and the key files `generateKeys` writes, with its file modes, including the
//     installation release key (`generateInstallationReleaseKeyV1`) whose public trust
//     feeds the connector build and composer; the installer key signs the connector
//     before staging (C-1);
//   - the vendored PostgreSQL 17.11 runtime from the pinned archive and a pinned
//     Node at `runtime/node-current/bin/node`;
//   - the init phase with the release's production dependencies;
//   - the database service, installed by the REAL `installServicesV1` from the REAL
//     `composeServiceBundleV1` plist (socket-only, in its Seatbelt profile);
//   - the release phase with the release's production dependency set;
//   - `writeDatabaseLoginsV1`, `firstOwnerViaScriptV1` (the built `firstOwner.js`);
//   - `composeProtectedConfigPortV1` with exactly the arguments `install-services`
//     passes (every database entry is this run's `<root>/pg/socket`, N-F), and the
//     core batch installed by the REAL `installServicesV1`, so the protected files
//     land with the elevated port's own modes and ownership calls;
//   - the supervisor and the gateway started with EXACTLY the ProgramArguments,
//     WorkingDirectory, EnvironmentVariables and log paths of their plists;
//   - `checkHealthV1` with exactly the `health-check` step's input: the database
//     half on the production adapter, and on each of three samples the HMAC-tagged
//     web probe and the gateway's `/fleet/v1/health` (N-H).
//
// WHAT IS SUBSTITUTED, because the lane is not root and must not touch launchd:
//   - LAUNCHD: `launchctl bootstrap system <plist>` is answered by a stand-in that
//     reads the plist the real port just wrote and spawns its ProgramArguments in
//     their own process group with the plist's working directory, environment
//     (plus launchd's default PATH) and log files. No KeepAlive restarts: an exit is
//     reported with its logs instead. `bootout` signals that group.
//   - ACCOUNTS: every process runs as this uid. The composer and the service
//     bundle get `_crbuild`/`_crdb`/`_controlroom` with distinct stand-in ids
//     (300/301/302); the first-owner child gets this uid (it must own the data
//     dir); the database phases' peer map gets the real OS name (the sibling
//     lanes' convention). The elevated port's `lchown` is RECORDED, not performed,
//     its owner comparison of pre-existing files is off, and the lane judges the
//     INTENDED ownership with a permission model (`serviceCanReach`: layout rows,
//     `generateKeys`, recorded calls, BSD group inheritance), so a service-account
//     access bug is still caught without a second uid.
//   - MODES: the release's protected-file loaders accept a group-readable entry only
//     when root owns it. Every group-readable entry under `Protected` (root:service
//     in a real install) is therefore narrowed to owner-only right before a service
//     starts; the permission model keeps judging the installer's INTENDED mode.
//   - THE DEPLOYER PEER LINE for this uid (root's line cannot be exercised).
//   - PORTS: the cluster is the plist's own: no `-p`, socket-only, so it binds NO TCP
//     port and its socket (`.s.PGSQL.5432`) lives in this run's private `pg/socket`,
//     which is the only database endpoint the composed configuration names, so no
//     service can reach another PostgreSQL. Web and gateway ports are installer options.
//   - The T1 path assertion for the first-owner child (non-root ancestry).
//   - SEATBELT: used for real when `sandbox-exec` works here; otherwise stripped,
//     and the lane says so in its diagnostics. The install root is under
//     /private/tmp because the service profiles deny reads under /Users.
//
// It fails at the first real reason the installed services cannot start, and names
// it with the services' own logs and raw health answers.
//
// Skips without `PG_RUNTIME_ARCHIVE`, the sibling lanes' convention.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, openSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from
  "node:fs/promises";
import { connect } from "node:net";
import { userInfo } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { vendorPgRuntimeV1 } from "../src/updater/v1/pg/pg-runtime-vendor";
import { buildInitDependenciesV1, initializeDatabaseV1 } from "../src/updater/v1/pg/init-database.mjs";
import { applyReleaseSchemaV1, buildReleaseDependenciesV1, ledgerHeadV1, readReleaseLedgerV1 } from
  "../src/updater/v1/pg/apply-release-schema.mjs";
import { readRoleManifestV1 } from "../src/updater/v1/pg/database-phase-data.mjs";
import { pgHbaPeerMapV1 } from "../src/pg-runtime/v1/pg-cluster-layout";
import { writeDatabaseLoginsV1 } from "../src/updater/v1/pg/first-owner-ports.mjs";
import { firstOwnerViaScriptV1 } from "../src/updater/v1/pg/first-owner-script.mjs";
import { checkDatabaseHealthProductionV1 } from "../src/updater/v1/pg/database-health-production.mjs";
import { buildAttendedReleaseV1 } from "../src/updater/v1/build-attended-release.mjs";
import { CORE_SERVICE_ROLES_V1, DATABASE_SERVICE_ROLES_V1, FIRST_OWNER_OWNER_V1, INSTALL_DATABASE_LOGINS_V1 } from
  "../src/updater/v1/install/install-steps.mjs";
import { checkHealthV1, composeProtectedConfigPortV1 } from
  "../src/updater/v1/install/stage-one-ports.mjs";
import { checkWebHealthV1 } from "../src/updater/v1/install/health.mjs";
import { installServicesV1 } from "../src/updater/v1/services/installer.mjs";
import { signAttendedConnectorReleaseV1 } from "../src/updater/v1/install/connector-release.mjs";
import { generateInstallationReleaseKeyV1 } from "../scripts/release-signing.mjs";

const REPO = resolve(join(dirname(new URL(import.meta.url).pathname), ".."));
const ARCHIVE = process.env.PG_RUNTIME_ARCHIVE;
const needsArchive = ARCHIVE !== undefined && existsSync(ARCHIVE) ? false : "needs the pinned archive (PG_RUNTIME_ARCHIVE)";
const PORT = Number(process.env.CONTROL_ROOM_PGRT_PORT_BASE ?? 59880);
/** Lane TCP ports: the services' listeners. */
const WEB_PORT = PORT + 10, GATEWAY_PORT = PORT + 11;
/** The service profiles deny reads under /Users, and macOS `sun_path` is short. */
const LANE_ROOT = "/private/tmp";
const PG_DATA_ID = "data-A";
/** A practice install's name: the rehearsal config requires a `rehearsal` label in
 * the tailnet name, and stage one uses that name as the passkey RP ID. */
const PRACTICE_RP_ID = "bringup.rehearsal-lane.ts.net";
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const uid = process.getuid(), gid = process.getgid();
// The INTENDED identities, for the permission model. Distinct numbers stand in for
// the distinct accounts the real installer creates.
const ROOT_ID = Object.freeze({ uid: 0, gid: 0 });
const BUILDER_ID = Object.freeze({ uid: 300, gid: 300 });
const DATABASE_ID = Object.freeze({ uid: 301, gid: 301 });
const SERVICE_ID = Object.freeze({ uid: 302, gid: 302 });
const account = (name, id) => Object.freeze({ name, uid: id.uid, gid: id.gid, created: true });
/** The installer's three accounts as the service bundle and the composer see them:
 * distinct stand-in ids, so every ownership call the real elevated port makes is
 * recorded against the account it names (see the header). */
const INSTALL_ACCOUNTS = Object.freeze({ builder: account("_crbuild", BUILDER_ID),
  database: account("_crdb", DATABASE_ID), service: account("_controlroom", SERVICE_ID) });
/** The accounts a REAL child runs as: this uid, because the lane cannot change uid.
 * The first-owner child spawns as the database account and must own the data dir. */
const PROCESS_ACCOUNTS = Object.freeze({ builder: account("_crbuild", { uid, gid }),
  database: account("_crdb", { uid, gid }), service: account("_controlroom", { uid, gid }) });
/** The database phases' view: the peer map names the real OS account, and the phase
 * contract refuses a service uid equal to the database uid (the sibling lanes' pair). */
const DB_ACCOUNTS = Object.freeze({
  database: Object.freeze({ name: userInfo().username, uid, gid }),
  service: Object.freeze({ name: INSTALL_ACCOUNTS.service.name, uid: uid === 502 ? 503 : 502, gid }),
});
const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith("/");
};

// ---------------------------------------------------------------------------
// The release, exactly as the attended build makes it and the installer stages it.
// ---------------------------------------------------------------------------

/** The attended build's working folder, `<root>/build/<job>`: a clone of this
 * checkout at HEAD with its uncommitted edits laid over (so the lane tests the
 * tree it runs from), and its own `pnpm install`. The installer deletes this
 * folder after install (`attended-source.mjs` `closeSession`), and so does the
 * lane, BEFORE any service starts: a release that still names it cannot start. */
async function cloneBuildFolder(build) {
  const git = (args, cwd = REPO) => execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024 });
  const commit = git(["rev-parse", "HEAD"]).trim();
  git(["clone", "--quiet", "--shared", "--no-checkout", REPO, build], dirname(build));
  git(["checkout", "--quiet", "--detach", commit], build);
  const changed = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0").filter(Boolean)
    .map(line => line.slice(3));
  for (const path of changed) {
    if (existsSync(join(REPO, path))) {
      await mkdir(dirname(join(build, path)), { recursive: true });
      await copyFile(join(REPO, path), join(build, path));
    } else await rm(join(build, path), { force: true });
  }
  execFileSync("pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], { cwd: build, stdio: "pipe",
    env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" }, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  return commit;
}

async function buildCopiedRelease(run, root, owners, releaseTrust) {
  const build = join(root, "build", "lane-job");
  const commit = await cloneBuildFolder(build);
  execFileSync(process.execPath, [join(build, "scripts", "build-vps.mjs")], { cwd: build, stdio: "pipe",
    env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" }, timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
  const version = JSON.parse(await readFile(join(build, "package.json"), "utf8")).version;
  const assembled = join(run, "assembled");
  await mkdir(assembled);
  await buildAttendedReleaseV1({ source: build, output: assembled, commit, releaseTrust });
  await signAttendedConnectorReleaseV1({ output: assembled, commit, trust: releaseTrust,
    privateKeyPath: join(root, "updater-state", "release-signing-key.pem") }, { expectedUid: uid });
  // The id `buildReleaseV1` derives (`attended-source.mjs`).
  const releaseId = `${version}-${commit.slice(0, 12)}`;
  const target = join(root, "releases", releaseId);
  execFileSync("/bin/cp", ["-R", assembled, target], { stdio: "pipe" });
  await rm(assembled, { recursive: true, force: true });
  // `stageReleaseV1`'s modes: executables 0550, other files 0440, directories 0550,
  // every entry root:service.
  const directories = [], stagedOwner = Object.freeze({ uid: 0, gid: SERVICE_ID.gid });
  const visit = async directory => {
    directories.push(directory);
    owners.set(directory, stagedOwner);
    for (const name of await readdir(directory)) {
      const path = join(directory, name), entry = await lstat(path);
      if (entry.isDirectory()) await visit(path);
      else { await chmod(path, entry.mode & 0o100 ? 0o550 : 0o440); owners.set(path, stagedOwner); }
    }
  };
  await visit(target);
  for (const directory of directories.reverse()) await chmod(directory, 0o550);
  await symlink(`releases/${releaseId}`, join(root, "current"));
  return { releaseId, commit, build };
}

/** Every text file the release's server bundle ships, searched for a build-machine path. */
async function releaseNamesBuildPaths(release, paths) {
  const found = [];
  const visit = async directory => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name), entry = await lstat(path);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:m?js|json)$/u.test(name)) {
        const text = await readFile(path, "utf8");
        for (const needle of paths) if (text.includes(needle)) found.push(`${relative(release, path)} names ${needle}`);
      }
    }
  };
  await visit(join(release, "dist-vps", "server"));
  return found;
}

// ---------------------------------------------------------------------------
// The installer's layout and keys (`installer.mjs` `createLayout`, `generateKeys`).
// ---------------------------------------------------------------------------

/** [path, mode, intended owner], verbatim from `createLayout`'s directory rows. */
const LAYOUT_ROWS = Object.freeze([
  ["", 0o755, ROOT_ID], ["runtime", 0o555, ROOT_ID], ["updater", 0o755, ROOT_ID], ["guard", 0o555, ROOT_ID],
  ["updater-state", 0o700, ROOT_ID], ["updater-state/plans", 0o700, ROOT_ID], ["updater-state/tmp", 0o700, ROOT_ID],
  ["releases", 0o750, { uid: 0, gid: SERVICE_ID.gid }], ["Protected", 0o750, { uid: 0, gid: SERVICE_ID.gid }],
  ["Protected/service", 0o700, SERVICE_ID], ["Protected/config", 0o750, { uid: 0, gid: SERVICE_ID.gid }],
  ["Protected/runtime-state", 0o700, SERVICE_ID], ["pg", 0o755, ROOT_ID],
  ["pg/socket", 0o750, { uid: DATABASE_ID.uid, gid: SERVICE_ID.gid }], ["backups", 0o700, ROOT_ID],
  ["build", 0o755, ROOT_ID], ["logs", 0o755, ROOT_ID], ["status", 0o755, ROOT_ID],
]);

async function createInstallerLayout(root, owners) {
  for (const [name, mode, owner] of LAYOUT_ROWS) {
    const path = name ? join(root, name) : root;
    await mkdir(path, { recursive: true });
    await chmod(path, mode);
    owners.set(path, owner);
  }
}

/** `generateKeys`' files and modes; the vapid/work-intake values come from the native ports,
 * and the release key from the release's own `generateInstallationReleaseKeyV1`, exactly
 * as `generateKeys` calls it (here `expectedUid` is this uid, not root). Returns the trust. */
async function generateInstallerKeys(root, owners) {
  const { default: nativePorts } = await import("../src/updater/v1/cli/control-room-native-ports.mjs");
  const write = async (path, contents, owner) => {
    await writeFile(path, contents, { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
    owners.set(path, owner);
  };
  const vapid = await nativePorts.generateVapidKeys();
  await write(join(root, "updater-state", "vapid.json"), `${JSON.stringify(vapid)}\n`, ROOT_ID);
  await write(join(root, "Protected", "service", "vapid-public.json"), `${JSON.stringify({ publicKey: vapid.publicKey })}\n`,
    SERVICE_ID);
  const probe = `${randomBytes(32).toString("base64url")}\n`;
  await write(join(root, "updater-state", "health-probe.key"), probe, ROOT_ID);
  await write(join(root, "Protected", "service", "health-probe.key"), probe, SERVICE_ID);
  await write(join(root, "Protected", "service", "web-hmac.key"), `${randomBytes(32).toString("base64url")}\n`, SERVICE_ID);
  await write(join(root, "Protected", "service", "work-intake.json"),
    `${JSON.stringify(await nativePorts.generateWorkIntakeKeys())}\n`, SERVICE_ID);
  const releaseKey = await generateInstallationReleaseKeyV1({ protectedRoot: join(root, "Protected"),
    versionFloor: "0.0.0" }, { expectedUid: uid });
  // Written root-owned 0640 into the root:service `Protected/config` (group inherited).
  owners.set(join(root, "Protected", "config", "release-trust.json"), { uid: 0, gid: SERVICE_ID.gid });
  return releaseKey.trust;
}

/** `install-steps.mjs` `keyReferences`. */
const keyReferences = root => Object.freeze({
  vapidPrivate: join(root, "updater-state", "vapid.json"),
  vapidPublic: join(root, "Protected", "service", "vapid-public.json"),
  healthProbeRoot: join(root, "updater-state", "health-probe.key"),
  healthProbeService: join(root, "Protected", "service", "health-probe.key"),
  webHmac: join(root, "Protected", "service", "web-hmac.key"),
  workIntake: join(root, "Protected", "service", "work-intake.json"),
});

// ---------------------------------------------------------------------------
// The permission model: can the SERVICE account reach a path, given the INTENDED
// owners (layout rows, `generateKeys`, the elevated port's recorded lchown calls,
// and BSD group inheritance for anything created without an explicit owner)?
// ---------------------------------------------------------------------------

async function intendedOwner(path, owners, root) {
  if (owners.has(path)) return owners.get(path);
  // Created by root with no chown: owner root, group inherited from the parent (BSD).
  const parent = dirname(path);
  if (parent === path || !inside(root, parent)) return ROOT_ID;
  return { uid: 0, gid: (await intendedOwner(parent, owners, root)).gid };
}

async function serviceCanReach(requested, { owners, root, want, intendedModes }) {
  // Through the real path: `current` is a link into `releases/`, which is what the kernel walks.
  const path = await realpath(requested);
  const bits = async (target, mask) => {
    const entry = await lstat(target), owner = await intendedOwner(target, owners, root);
    // The mode the installer gave it, before the lane's owner-only narrowing (see the header).
    const mode = intendedModes.get(target) ?? entry.mode;
    const shift = owner.uid === SERVICE_ID.uid ? 6 : owner.gid === SERVICE_ID.gid ? 3 : 0;
    return { ok: ((mode >> shift) & mask) === mask, owner, mode: (mode & 0o777).toString(8) };
  };
  const chain = [];
  for (let current = dirname(path); inside(root, current); current = dirname(current)) {
    chain.unshift(current);
    if (current === root) break;
  }
  // Every refusal on the way, not only the first, so one report names them all.
  const failures = [];
  for (const directory of chain) {
    const result = await bits(directory, 0o1);
    if (!result.ok) failures.push(`cannot enter ${relative(root, directory) || "."} (${result.mode} ${result.owner.uid}:${result.owner.gid})`);
  }
  const result = await bits(path, want === "write" ? 0o3 : 0o4);
  if (!result.ok) failures.push(`cannot ${want} ${relative(root, path)} (${result.mode} ${result.owner.uid}:${result.owner.gid})`);
  return failures;
}

// ---------------------------------------------------------------------------
// The launchd stand-in behind the REAL elevated service port.
// ---------------------------------------------------------------------------

function plistValues(contents) {
  const unescape = value => value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'").replaceAll("&amp;", "&");
  const string = key => {
    const match = new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`, "u").exec(contents);
    return match ? unescape(match[1]) : undefined;
  };
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(contents)?.[1] ?? "";
  const programArguments = [...block.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map(match => unescape(match[1]));
  const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/u.exec(contents)?.[1] ?? "";
  const environment = Object.fromEntries([...envBlock.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/gu)]
    .map(match => [unescape(match[1]), unescape(match[2])]));
  return { label: string("Label"), programArguments, workingDirectory: string("WorkingDirectory"),
    standardOutPath: string("StandardOutPath"), standardErrorPath: string("StandardErrorPath"),
    userName: string("UserName"), environment };
}

/** One probe, in its own process group, killed in a finally: does `sandbox-exec` apply here? */
function seatbeltWorks(profile, root) {
  const result = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "-D", `RUNTIME_ROOT=${join(root, "runtime")}`,
    "-D", `RELEASE_ROOT=${join(root, "releases")}`, "-D", `UPDATER_ROOT=${join(root, "updater")}`,
    "-D", `WORKING_DIRECTORY=${root}`, "-D", `RUNTIME_STATE=${join(root, "Protected", "runtime-state")}`,
    "-D", "OUT_LOG=/dev/null", "-D", "ERR_LOG=/dev/null", "--", "/usr/bin/true"],
  { stdio: "pipe", timeout: 30_000, killSignal: "SIGKILL" });
  return { works: result.status === 0, detail: String(result.stderr ?? "").trim().slice(0, 200) };
}

class LaunchdStandIn {
  constructor({ run, root, owners, seatbelt }) {
    Object.assign(this, { run, root, owners, seatbelt });
    this.jobs = new Map();
    this.substitutions = [];
    /** path -> the mode the installer gave it, for every entry `narrowProtectedModes` changed. */
    this.intendedModes = new Map();
  }

  /** The release's protected-file loaders accept a group-readable entry only when ROOT
   * owns it (root:service 0750/0640); everything else must be owner-only. The lane
   * cannot make root the owner, so every group-readable entry under `Protected` (all
   * of them root:service in a real install) is narrowed to owner-only right before a
   * service starts, and the permission model keeps judging the INTENDED mode. */
  async narrowProtectedModes() {
    const visit = async path => {
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) return;
      if (entry.mode & 0o070) {
        if (!this.intendedModes.has(path)) this.intendedModes.set(path, entry.mode);
        await chmod(path, entry.mode & 0o707);
      }
      if (entry.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
    };
    await visit(join(this.root, "Protected"));
  }

  /** Paths outside the install root (`/Library/LaunchDaemons`, `/etc/newsyslog.d`) land under the run. */
  pathFor(path) { return inside(this.root, path) ? path : join(this.run, "system", path); }

  runtime() {
    return Object.freeze({
      geteuid: () => 0,
      // A non-root lane cannot give a file another account's uid, so the port's
      // owner/mode comparison of PRE-EXISTING files (the init phase's postgres log)
      // would compare this uid against a stand-in id. Ownership is judged by the
      // recorded `lchown` calls and the permission model instead.
      enforceMetadata: false,
      pathFor: path => this.pathFor(path),
      lchown: async (path, ownerUid, ownerGid) => {
        const real = inside(this.root, path) ? path : null;
        if (real) this.owners.set(real, { uid: ownerUid, gid: ownerGid });
      },
      execute: async (file, args) => {
        if (file !== "/bin/launchctl") throw Object.assign(new Error(`lane_refused_exec:${file}`), { code: 1 });
        if (args[0] === "bootstrap" && args[1] === "system") return this.bootstrap(this.pathFor(args[2]));
        if (args[0] === "bootout") return this.bootout(String(args[1]).replace(/^system\//u, ""));
        throw Object.assign(new Error(`lane_refused_launchctl:${args.join(" ")}`), { code: 1 });
      },
      isServiceLoaded: async label => this.jobs.get(label)?.exited === undefined && this.jobs.has(label),
      verifyPostgresShutdown: async () => [...this.jobs.values()].every(job => job.exited !== undefined),
    });
  }

  async bootstrap(plistPath) {
    const plist = plistValues(await readFile(plistPath, "utf8"));
    let argv = plist.programArguments;
    if (plist.userName !== INSTALL_ACCOUNTS.database.name) {
      await this.narrowProtectedModes();
      this.substitutions.push(`${plist.label}: group-readable Protected entries narrowed to owner-only (non-root owner)`);
    }
    if (argv[0] === "/usr/bin/sandbox-exec" && !this.seatbelt.works) {
      argv = argv.slice(argv.indexOf("--") + 1);
      this.substitutions.push(`${plist.label}: sandbox-exec stripped (${this.seatbelt.detail || "unavailable"})`);
    }
    const out = openSync(plist.standardOutPath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT, 0o600);
    const err = openSync(plist.standardErrorPath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT, 0o600);
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: plist.workingDirectory, detached: true,
        stdio: ["ignore", out, err],
        env: { PATH: LAUNCHD_PATH, ...plist.environment, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" } });
    } finally { closeSync(out); closeSync(err); }
    const job = { label: plist.label, child, plist, exited: undefined };
    child.once("exit", (code, signal) => { job.exited = { code, signal }; });
    child.once("error", error => { job.exited = { code: null, signal: null, error: error.message }; });
    this.jobs.set(plist.label, job);
    return { stdout: "", stderr: "" };
  }

  async bootout(label, signal = "SIGTERM", graceMs = 45_000) {
    const job = this.jobs.get(label);
    if (!job || job.exited !== undefined) return { stdout: "", stderr: "" };
    // Every descendant is captured BEFORE the signal: the supervisor's task host is
    // its own process group, and once the supervisor exits it is reparented away.
    const tree = descendants(job.child.pid);
    try { process.kill(-job.child.pid, signal); } catch { /* already gone */ }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && (job.exited === undefined || tree.some(alive))) await sleep(100);
    for (const pid of [job.child.pid, ...tree]) {
      if (!alive(pid)) continue;
      try { process.kill(-pid, "SIGKILL"); } catch { /* not a group leader */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    while (job.exited === undefined) await sleep(50);
    return { stdout: "", stderr: "" };
  }

  exitedJobs() { return [...this.jobs.values()].filter(job => job.exited !== undefined); }
  livePids() {
    return [...this.jobs.values()].flatMap(job => [job.child.pid, ...descendants(job.child.pid)]).filter(alive);
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

/** The process tree under one of THIS lane's pids (never a pattern match). */
function descendants(pid) {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")
    .map(line => line.trim().split(/\s+/u).map(Number));
  const found = [], queue = [pid];
  while (queue.length) {
    const parent = queue.shift();
    for (const [child, ppid] of rows) if (ppid === parent && !found.includes(child)) { found.push(child); queue.push(child); }
  }
  return found;
}

async function tail(path, bytes = 3000) {
  try { const text = await readFile(path, "utf8"); return text.slice(-bytes).trim() || "(empty)"; }
  catch (error) { return `(${error.code ?? error.message})`; }
}

function portOpen(port) {
  return new Promise(resolvePort => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = value => { socket.destroy(); resolvePort(value); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

/** Every distinct `host:port` database endpoint the composed configuration names. */
function composedDatabaseEndpoints(resources) {
  const endpoints = new Set();
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "host") && Object.hasOwn(value, "port")) endpoints.add(`${value.host}:${value.port}`);
    Object.values(value).forEach(visit);
  };
  for (const resource of resources) visit(JSON.parse(resource.contents));
  return [...endpoints];
}

// ---------------------------------------------------------------------------
// The lane.
// ---------------------------------------------------------------------------

test("the installed supervisor and fleet gateway start from a copied release on a real database and pass the installer's health checks",
  { skip: needsArchive, timeout: 2_400_000 }, async t => {
    const run = await realpath(await mkdtemp(join(LANE_ROOT, "cr-bringup-")));
    const root = join(run, "install");
    const owners = new Map();
    let launchd, step = "start";
    const progress = name => { step = name; t.diagnostic(`step: ${name}`); };
    try {
      progress("layout");
      await createInstallerLayout(root, owners);
      progress("generate-keys");
      const releaseTrust = await generateInstallerKeys(root, owners);
      // The installer builds with public trust, then signs before staging (C-1).
      progress("release");
      const { releaseId, build } = await buildCopiedRelease(run, root, owners, releaseTrust);
      // The attended build closes its session (deleting the build folder) once the
      // release is staged, before any database step: everything below runs without it.
      const buildPaths = [build, await realpath(build), REPO];
      await rm(join(root, "build", "lane-job"), { recursive: true, force: true });
      assert.equal(existsSync(build), false);
      assert.deepEqual(await releaseNamesBuildPaths(join(root, "releases", releaseId), buildPaths), [],
        "the release's server bundle must not name the build folder or this checkout");
      for (const [from, to] of [["src/updater/v1/ddl", "updater/current/ddl"],
        ["src/updater/v1/policy", "updater/current/policy"]]) {
        await mkdir(dirname(join(root, to)), { recursive: true });
        execFileSync("/bin/cp", ["-R", join(REPO, from), join(root, to)], { stdio: "pipe" });
      }
      await mkdir(join(root, "updater/current/pg"), { recursive: true });
      await copyFile(join(REPO, "src/updater/v1/pg/release-schema-digest.sql"),
        join(root, "updater/current/pg/release-schema-digest.sql"));

      progress("vendor-pg-runtime");
      await chmod(join(root, "runtime"), 0o755);
      const vendored = await vendorPgRuntimeV1({ archivePath: ARCHIVE, runtimeDirectory: join(root, "runtime", "pg-17.11"),
        opensslConf: "# fixed and empty (R9b)\n", hooks: { normaliseOwnership: false } });
      assert.equal(vendored.status, "pg_runtime_vendored", vendored.refusal);
      await symlink("pg-17.11", join(root, "runtime", "pg-current"));
      // The release's pinned Node: a COPY, because the profiles deny reads under /Users.
      const nodeDirectory = join(root, "runtime", `node-${process.versions.node}`, "bin");
      await mkdir(nodeDirectory, { recursive: true });
      await copyFile(process.execPath, join(nodeDirectory, "node"));
      await chmod(join(nodeDirectory, "node"), 0o555);
      await symlink(`node-${process.versions.node}`, join(root, "runtime", "node-current"));
      await chmod(join(root, "runtime"), 0o555);

      const seatbelt = seatbeltWorks(join(root, "updater/current/policy/service-supervisor.sb"), root);
      t.diagnostic(`seatbelt: ${seatbelt.works ? "applied for real" : `UNAVAILABLE, stripped (${seatbelt.detail})`}`);
      launchd = new LaunchdStandIn({ run, root, owners, seatbelt });

      progress("init-database");
      // The port the installed cluster really uses: the release's role manifest (the
      // plist passes no `-p`), so the phases, the child and the health check agree.
      const databasePort = (await readRoleManifestV1(join(root, "current"))).port;
      const passwords = Object.fromEntries(INSTALL_DATABASE_LOGINS_V1.map(name => [name, randomBytes(32).toString("base64url")]));
      const logins = INSTALL_DATABASE_LOGINS_V1.map(name => Object.freeze({ name, passwordStdin: true }));
      const request = Object.freeze({ schema: "control-room.database-init/v1", root, pgDataId: PG_DATA_ID,
        runtime: "runtime/pg-current", socketDir: "pg/socket", port: databasePort, accounts: DB_ACCOUNTS, logins });
      const initialized = await initializeDatabaseV1(request, passwords,
        await buildInitDependenciesV1(join(root, "current")));
      assert.equal(initialized.outcome, "initialized");

      progress("install-database-service");
      const serviceInput = (roles, protectedConfig = []) => Object.freeze({ root, accounts: INSTALL_ACCOUNTS,
        roles: Object.freeze([...roles]), protectedConfig, pgRuntime: join(root, "runtime", "pg-current", "bin", "postgres"),
        updaterVersion: "1.0.0-lane" });
      await installServicesV1(serviceInput(DATABASE_SERVICE_ROLES_V1), { runtime: launchd.runtime() });
      const socket = join(root, "pg", "socket", `.s.PGSQL.${databasePort}`);
      for (let waited = 0; !existsSync(socket); waited += 100) {
        const exited = launchd.exitedJobs();
        if (exited.length || waited > 60_000) {
          assert.fail(`the database service did not start: ${JSON.stringify(exited.map(job => job.exited))}\n`
            + `${await tail(join(root, "logs/postgresql17/err.log"))}`);
        }
        await sleep(100);
      }
      // THE DEPLOYER PEER LINE for this uid (root's `cr root control_room_deployer`).
      const data = join(root, "pg", PG_DATA_ID);
      await writeFile(join(data, "pg_ident.conf"), `${pgHbaPeerMapV1({ database: userInfo().username,
        migrator: "control_room_migrator", deployer: "control_room_deployer" })}cr ${userInfo().username} control_room_deployer\n`,
      { mode: 0o600 });
      const postmaster = [...launchd.jobs.values()][0].child.pid;
      process.kill(postmaster, "SIGHUP");
      await sleep(1_000);

      progress("apply-release-schema");
      const schema = await applyReleaseSchemaV1({ ...request, schema: "control-room.release-schema/v1", release: "current",
        expectedLedgerHead: ledgerHeadV1(await readReleaseLedgerV1(join(root, "current"))) }, passwords,
      await buildReleaseDependenciesV1(join(root, "current"), { deployerIdentity: { uid, gid } }));
      assert.equal(schema.outcome, "applied");

      progress("write-database-logins");
      const loginReceipt = await writeDatabaseLoginsV1({ root, accounts: PROCESS_ACCOUNTS, passwords });
      // As root the port hands the directory, then each file, to the service account
      // and reads the owner back (bring-up N-N); the lane is not root, so it records that.
      owners.set(loginReceipt.path, SERVICE_ID);
      for (const reference of loginReceipt.references) owners.set(reference.fileRef, SERVICE_ID);

      progress("first-owner");
      const owner = await firstOwnerViaScriptV1({ root, accounts: PROCESS_ACCOUNTS, release: "current",
        schemaDigest: schema.schemaDigest, pgDataId: PG_DATA_ID, owner: FIRST_OWNER_OWNER_V1 },
      { assertPath: async path => realpath(path) });
      assert.deepEqual(Object.keys(owner).sort(), ["provider", "subject", "tenantId", "workspaceId"]);

      progress("install-services: compose protected configuration");
      // EXACTLY `install-steps.mjs`'s call. `releaseTrust` is what `generateKeys`
      // returns and the installer forwards in its options (rv-9c N-C).
      const installerOptions = Object.freeze({ webPort: WEB_PORT, gatewayPort: GATEWAY_PORT, releaseTrust });
      const ownerCode = randomBytes(32).toString("base64url");
      const { createHash } = await import("node:crypto");
      const configuration = await composeProtectedConfigPortV1({ root, accounts: INSTALL_ACCOUNTS,
        installationId: "bringup-lane", rpId: PRACTICE_RP_ID, webPort: installerOptions.webPort,
        gatewayPort: installerOptions.gatewayPort, tenant: owner,
        ownerCodeDigest: `sha256:${createHash("sha256").update(JSON.stringify({ ownerCode })).digest("hex")}`,
        dbLogins: loginReceipt.references, keys: keyReferences(root),
        ...(installerOptions.releaseTrust === undefined ? {} : { releaseTrust: installerOptions.releaseTrust }) });

      // Every service reaches THIS run's cluster through its socket directory (the
      // installed cluster binds no TCP port), so no service can reach another PostgreSQL.
      assert.deepEqual(composedDatabaseEndpoints(configuration), [`${join(root, "pg", "socket")}:${databasePort}`]);

      progress("install-services: core batch");
      await installServicesV1(serviceInput(CORE_SERVICE_ROLES_V1, configuration), { runtime: launchd.runtime() });
      for (const note of launchd.substitutions) t.diagnostic(`substituted: ${note}`);

      // The service account must be able to read what the release's services read.
      progress("service account access");
      const readable = [
        ...configuration.filter(resource => resource.accountName === INSTALL_ACCOUNTS.service.name).map(resource => resource.path),
        join(root, "Protected", "service", "health-probe.key"),
        join(root, "Protected", "service", "web-hmac.key"),
        join(root, "Protected", "service", "work-intake.json"),
        ...loginReceipt.references.map(reference => reference.fileRef),
        join(root, "current", "dist-vps", "server", "fleetGateway.js"),
        join(root, "current", "scripts", "mac-local", "task-host-supervisor.mjs"),
      ];
      const accessFailures = [];
      for (const path of readable) {
        for (const failure of await serviceCanReach(path, { owners, root, want: "read", intendedModes: launchd.intendedModes })) {
          if (!accessFailures.includes(failure)) accessFailures.push(failure);
        }
      }
      for (const failure of await serviceCanReach(join(root, "Protected", "runtime-state"),
        { owners, root, want: "write", intendedModes: launchd.intendedModes })) {
        if (!accessFailures.includes(failure)) accessFailures.push(failure);
      }

      progress("health-check");
      const healthInput = Object.freeze({ root, expectedRelease: `releases/${releaseId}`, pgDataId: PG_DATA_ID,
        schemaDigest: schema.schemaDigest, updaterSchemaDigest: initialized.updaterSchemaDigest, webPort: WEB_PORT,
        gatewayPort: GATEWAY_PORT, samples: 3 });
      const diagnose = async reason => {
        const lines = [`step ${step}: ${reason}`];
        if (accessFailures.length) lines.push(`service account access (intended ownership): ${accessFailures.join("; ")}`);
        for (const job of launchd.jobs.values()) {
          lines.push(`${job.label}: ${job.exited ? `EXITED ${JSON.stringify(job.exited)}` : "running"}`);
        }
        lines.push(`web ${WEB_PORT} listening: ${await portOpen(WEB_PORT)}; gateway ${GATEWAY_PORT} listening: ${await portOpen(GATEWAY_PORT)}`);
        // The driver's own words for the web login, as the web host's settings name it:
        // the release maps every database refusal to `database_unavailable`.
        try {
          const { Client } = await import("pg");
          const macLocalDatabase = JSON.parse(await readFile(join(root, "Protected/config/mac-local.json"), "utf8")).database;
          const probe = new Client({ host: macLocalDatabase.host, port: macLocalDatabase.port, user: macLocalDatabase.username,
            password: macLocalDatabase.password, database: macLocalDatabase.database, ssl: false,
            options: "-c search_path=pg_catalog,\\ public -c timezone=UTC -c transaction_timeout=10000" });
          await probe.connect();
          try {
            lines.push(`web login: connected as ${(await probe.query("SELECT current_user AS u")).rows[0].u}`);
            for (const sql of ["SELECT count(*)::int AS n FROM tenants", "SELECT count(*)::int AS n FROM control_web_task_commands"]) {
              lines.push(`web login ${sql}: ${await probe.query(sql).then(r => JSON.stringify(r.rows), e => `${e.code} ${e.message}`)}`);
            }
          } finally { await probe.end(); }
        } catch (error) { lines.push(`web login probe: ${error.code ?? ""} ${error.message}`); }
        // The raw answers the installer's health step gets from the two services.
        for (const [method, url, body] of [["POST", `http://127.0.0.1:${WEB_PORT}/api/v1/local-host-health`,
          JSON.stringify({ nonce: randomBytes(32).toString("base64url") })],
        ["GET", `http://127.0.0.1:${GATEWAY_PORT}/fleet/v1/health`]]) {
          const answer = await fetch(url, { method, ...(body ? { body, headers: { origin: `http://127.0.0.1:${WEB_PORT}`,
            "content-type": "application/json" } } : {}), signal: AbortSignal.timeout(3_000) })
            .then(async r => `${r.status} ${(await r.text()).slice(0, 300)}`, e => `error ${e.message}`);
          lines.push(`${method} ${url}: ${answer}`);
        }
        for (const role of ["supervisor", "fleet-gateway"]) {
          lines.push(`--- logs/${role}/err.log\n${await tail(join(root, "logs", role, "err.log"))}`);
        }
        for (const directory of ["runtime", "runtime-state"]) {
          lines.push(`--- Protected/${directory}/task-host.log\n${await tail(join(root, "Protected", directory, "task-host.log"))}`);
        }
        return lines.join("\n");
      };
      // Wait for the web host to answer one tagged probe, failing fast on an exit.
      const deadline = Date.now() + 120_000;
      let lastError;
      for (;;) {
        try { await checkWebHealthV1(healthInput); break; } catch (error) { lastError = error; }
        if (launchd.exitedJobs().length || Date.now() > deadline) {
          assert.fail(await diagnose(`the web host never answered: ${lastError?.code ?? lastError?.message}`));
        }
        await sleep(500);
      }
      // THE INSTALLER'S `health-check` STEP, with exactly `install-steps.mjs`'s input:
      // database half on the production adapter, three samples, each with the
      // HMAC-tagged web probe and the gateway probe.
      try {
        const health = await checkHealthV1(healthInput, { checkDatabase: input => checkDatabaseHealthProductionV1(input) });
        assert.deepEqual(health, { healthy: true, samples: 3, schemaDigest: schema.schemaDigest });
      } catch (error) { assert.fail(await diagnose(`checkHealthV1 refused: ${error?.code ?? error?.message}`)); }
      assert.deepEqual(accessFailures, [], "the service account must reach every file the services read");
      assert.deepEqual(launchd.exitedJobs().map(job => job.label), [], "no service may have exited");

      // C-1: exercise the installed launcher's connector path and gateway origin,
      // through the website's real owner routes and production database logins.
      // Never execute the issued command or a bot CLI; only fetch its signed file.
      progress("connect a bot: installed release and configured gateway port");
      const webOrigin = `http://127.0.0.1:${WEB_PORT}`, gatewayOrigin = `http://127.0.0.1:${GATEWAY_PORT}`;
      const call = (path, { method = "GET", cookie, body, headers = {} } = {}) => fetch(`${webOrigin}${path}`, {
        method, signal: AbortSignal.timeout(15_000), redirect: "error",
        headers: { origin: webOrigin, ...(cookie ? { cookie } : {}), ...headers,
          ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const signedIn = await call("/api/v1/local-owner-session", { method: "POST", body: { ownerCode } });
      assert.equal(signedIn.status, 201, "the installed owner code must sign in");
      await signedIn.arrayBuffer();
      const token = /(?:^|;\s*)control_room_local_owner=([A-Za-z0-9_-]{43})(?:;|$)/u
        .exec(signedIn.headers.get("set-cookie") ?? "")?.[1];
      assert.ok(token, "the installed web host must issue the owner cookie");
      const cookie = `control_room_local_owner=${token}`;
      try {
        const board = await call("/api/v1/fleet", { cookie });
        assert.equal(board.status, 200);
        const fleet = await board.json();
        assert.equal(fleet.connectBot.available, true, "the installed launcher must load the shipped signed connector");
        const created = await call("/api/v1/projects", { method: "POST", cookie,
          headers: { "idempotency-key": "bringup-connect-bot-project" },
          body: { title: "Connector bring-up", summary: "Installed connector download proof" } });
        assert.equal(created.status, 201, "create the enrollment scope through the production web login");
        const { project } = await created.json();
        const issued = await call("/api/v1/fleet/connect-codes", { method: "POST", cookie,
          body: { botKind: "codex", name: "Bring-up bot", operatingSystem: "macos", projectIds: [project.projectId],
            capabilities: ["writing"], unattended: false, workerModel: "", workerProfile: "", workerProvider: "" } });
        assert.equal(issued.status, 201, "the installed host must issue a connect command");
        const connection = await issued.json();
        assert.deepEqual(connection.release, fleet.connectBot.release);
        assert.ok(connection.installLine.includes(`${gatewayOrigin}/fleet/v1/${connection.release.file}`),
          "the issued command must download from the configured installed gateway port");
        assert.ok(connection.installLine.includes(`--server ${gatewayOrigin}`),
          "the connector must also connect to the configured gateway port");
        const download = await fetch(`${gatewayOrigin}/fleet/v1/${connection.release.file}`, {
          signal: AbortSignal.timeout(15_000), redirect: "error" });
        assert.equal(download.status, 200, "the installed gateway must serve the named connector");
        const bytes = Buffer.from(await download.arrayBuffer());
        assert.equal(bytes.length, connection.release.size);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), connection.release.sha256);
        assert.deepEqual(bytes, await readFile(join(root, "current", "dist-vps", "server", "fleet", "release", connection.release.file)));
      } finally {
        const signedOut = await call("/api/v1/local-owner-session", { method: "DELETE", cookie });
        assert.equal(signedOut.status, 204, "the connector proof's owner session must close");
      }

      // THE PRACTICE INSTALL'S FACE ID STEP (`--authenticator software`), on the
      // services just started. The installer's passkey transaction calls these two
      // ports in this order (`runInitialPasskeyTransactionV1`): the PRODUCTION
      // `registerInitialPasskey` — deployer session over the installed socket, real
      // authority, real store — whose built-in practice phone signs in to the
      // INSTALLED web host with the owner code, reads the published options, posts a
      // real attestation through the web's own routes (so the database's owner-session
      // trigger judges a real session), and hands back the code the setup page would
      // show; then the authority verifies it and `recordPasskeyStatus` writes the file.
      progress("practice passkey: built-in software authenticator");
      const { default: nativePorts } = await import("../src/updater/v1/cli/control-room-native-ports.mjs");
      const shown = [];
      const terminal = Object.freeze({ isTTY: true, write: text => { shown.push(String(text)); }, setRawMode() {},
        readLine: async () => { throw new Error("practice mode must never wait for a typed code"); } });
      let passkey;
      try {
        passkey = await nativePorts.registerInitialPasskey({ root, config: { rpId: PRACTICE_RP_ID }, ownerCode, terminal,
          qr: Object.freeze({ ownerCodePolicy: "every-unconsumed-attempt" }), maxAttempts: 5, authenticator: "software" });
      } catch (error) {
        // The web store's own three reads, as the web login, so a refusal names the
        // statement the web host could not run (the host maps it to a bare 503).
        const lines = [];
        try {
          const { Client } = await import("pg");
          const macLocalDatabase = JSON.parse(await readFile(join(root, "Protected/config/mac-local.json"), "utf8")).database;
          const probe = new Client({ host: macLocalDatabase.host, port: macLocalDatabase.port, user: macLocalDatabase.username,
            password: macLocalDatabase.password, database: macLocalDatabase.database, ssl: false });
          await probe.connect();
          try {
            for (const sql of ["SET search_path = pg_catalog, updater, pg_temp",
              `SELECT current_user AS u, pg_has_role(current_user, 'control_room_private_web', 'MEMBER') AS is_web,
                current_setting('session_replication_role') AS replication_role`,
              "SELECT registration_digest FROM updater.passkey_open_registrations_web"]) {
              lines.push(`web login ${sql.replace(/\s+/gu, " ")}: ${await probe.query(sql)
                .then(r => JSON.stringify(r.rows), e => `${e.code} ${e.message}`)}`);
            }
          } finally { await probe.end(); }
        } catch (probeError) { lines.push(`web login probe: ${probeError.code ?? ""} ${probeError.message}`); }
        assert.fail(await diagnose(`the practice passkey step refused: ${error?.code ?? error?.message}\n${shown.join("")}`
          + `${lines.join("\n")}`));
      }
      assert.equal(passkey.status, "registered");
      assert.equal(passkey.attempts, 1, "the practice phone's code is right the first time");
      assert.match(passkey.credentialIdDigest, /^sha256:[a-f0-9]{64}$/u);
      const output = shown.join("");
      assert.match(output, /no phone is needed for Face ID/u);
      assert.match(output, /Practice passkey code: [0-9A-Z]{6} \(entered for you\)/u);
      assert.match(output, /Practice passkey registered\. No phone was used\./u);
      assert.doesNotMatch(output, /\/setup#|█/u, "practice mode prints no QR and no setup address");
      assert.deepEqual(await nativePorts.recordPasskeyStatus({ root, ...passkey }), { recorded: true, status: "registered" });
      assert.deepEqual(JSON.parse(await readFile(join(root, "status", "passkey.json"), "utf8")), {
        schema: "control-room.install-passkey-status/v1", ...passkey });
      // The authority's ledger: one ACTIVE passkey whose id digests to what the port
      // reported, ES256, and the public key the real verifier pulled out of the
      // attestation the web stored.
      const ledger = JSON.parse(await readFile(join(root, "updater-state", "passkeys.json"), "utf8"));
      assert.equal(ledger.passkeys.length, 1);
      const { createHash: hash } = await import("node:crypto");
      assert.equal(`sha256:${hash("sha256").update(ledger.passkeys[0].credentialId, "utf8").digest("hex")}`,
        passkey.credentialIdDigest);
      assert.equal(ledger.passkeys[0].alg, -7);
      assert.equal(ledger.passkeys[0].coolingOffUntil, null, "a first passkey is active at once");
      assert.deepEqual(ledger.registrations.map(item => item.status), ["used"]);
      // The database saw the web's row and the practice session closed again.
      const { Client } = await import("pg");
      const deployer = new Client({ host: join(root, "pg", "socket"), port: databasePort, user: "control_room_deployer",
        database: "control_room", ssl: false });
      await deployer.connect();
      try {
        const rows = (await deployer.query(`SELECT r.credential_id, o.consumed_at IS NOT NULL AS consumed
          FROM updater.passkey_registrations r JOIN updater.passkey_open_registrations o USING (registration_digest)`)).rows;
        assert.deepEqual(rows, [{ credential_id: ledger.passkeys[0].credentialId, consumed: true }],
          "exactly one web row, for the registered credential, on a consumed registration");
      } finally { await deployer.end(); }
      const macLocalDatabase = JSON.parse(await readFile(join(root, "Protected/config/mac-local.json"), "utf8")).database;
      const web = new Client({ host: macLocalDatabase.host, port: macLocalDatabase.port, user: macLocalDatabase.username,
        password: macLocalDatabase.password, database: macLocalDatabase.database, ssl: false });
      await web.connect();
      try {
        const sessions = (await web.query("SELECT revoked_at IS NOT NULL AS revoked FROM control_web_sessions")).rows;
        assert.deepEqual(sessions, [{ revoked: true }, { revoked: true }],
          "the connector proof and practice phone owner sessions are both signed out");
      } finally { await web.end(); }
      assert.deepEqual(launchd.exitedJobs().map(job => job.label), [], "no service exited during the practice passkey step");
    } finally {
      // Services first (the supervisor forwards to its task host), the database last.
      if (launchd) {
        const labels = [...launchd.jobs.keys()].reverse();
        for (const label of labels) {
          await launchd.bootout(label, label.endsWith(".postgres") ? "SIGINT" : "SIGTERM",
            label.endsWith(".postgres") ? 60_000 : 45_000).catch(() => undefined);
        }
        const leaked = launchd.livePids();
        assert.deepEqual(leaked, [], `the lane leaked processes: ${leaked.join(",")}`);
      }
      try { execFileSync("/bin/chmod", ["-R", "u+rwx", run]); } catch { /* best effort */ }
      await rm(run, { recursive: true, force: true }).catch(() => undefined);
    }
  });
