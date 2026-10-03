import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
/**
 * Owner-attended Mac half of the two-command database upgrade. It deliberately
 * delegates start, stop, and login handling to the existing guarded commands.
 * The only durable state is a private, non-secret recovery record.
 */
import { acquirePrivateProcessLockV1 } from "../../src/installer/shared/private-process-lock.mjs";
import { directoryCustodyV1 } from "../../src/installer/shared/file-custody.mjs";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPrivatePostgresDatabase } from "../../src/web/v1/private-postgres";
import { readPrivateWebSchemaDigest } from "../../src/web/v1/private-database-preflight";
import { loadMacLocalWebRoleFromRootV1 } from "../../src/web/v1/mac-local-protected-loader";
import { finishMacLocalDatabaseUpgradeV1, prepareMacLocalDatabaseUpgradeV1 } from "./provision-database.mjs";
import { protectedRootFromArguments, repoRoot, runtimePaths } from "./stack.mjs";

const exec = promisify(execFile);
const RECORD_SCHEMA = "control-room.mac-upgrade-recovery/v1";
const commitPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const migrationLedgerPath = fileURLToPath(new URL("../../deploy/postgres/migration-ledger.json", import.meta.url));

const failure = code => { throw new Error(code); };
const privateDirectory = async path => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await directoryCustodyV1(path);
  await chmod(path, 0o700);
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) failure("upgrade_runtime_directory_refused");
};

async function writePrivateJson(path, value) {
  const temporary = `${path}.new-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally { await unlink(temporary).catch(() => {}); }
}

function captureRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !["ledgerHead|previousCommit|schema|targetCommit", "ledgerHead|phase|previousCommit|schema|targetCommit"].includes(Object.keys(value).sort().join("|"))
    || value.phase !== undefined && !["checkout_pending", "upgrading", "upgraded", "rolling_back", "rolled_back"].includes(value.phase)
    || value.schema !== RECORD_SCHEMA || !commitPattern.test(value.previousCommit ?? "") || !commitPattern.test(value.targetCommit ?? ""))
    failure("upgrade_recovery_record_refused");
  const head = value.ledgerHead;
  if (!head || typeof head !== "object" || Array.isArray(head) || Object.keys(head).sort().join("|") !== "digest|file|order"
    || !Number.isSafeInteger(head.order) || head.order < 1 || typeof head.file !== "string" || !/^db\/migrations\/\d{4}_[a-z0-9_]+\.sql$/u.test(head.file)
    || !digestPattern.test(head.digest ?? "")) failure("upgrade_recovery_record_refused");
  return Object.freeze({ schema: RECORD_SCHEMA, phase: value.phase ?? "upgrading", previousCommit: value.previousCommit, targetCommit: value.targetCommit,
    ledgerHead: Object.freeze({ order: head.order, file: head.file, digest: head.digest }) });
}

async function readPrivateRecord(path, { optional = false } = {}) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > 4096)
      failure("upgrade_recovery_record_refused");
    return captureRecord(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    if (error instanceof Error && error.message === "upgrade_recovery_record_refused") throw error;
    failure("upgrade_recovery_record_refused");
  }
}

async function gitCommand(args, cwd = repoRoot) {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  return stdout.trim();
}

async function runPnpm(args, lockFd) {
  return await new Promise(resolve => {
    // The child retains exclusion if the coordinator dies during this effect.
    const child = spawn("pnpm", args, { cwd: repoRoot, env: process.env, stdio: ["inherit", "inherit", "inherit", lockFd] });
    child.once("error", () => resolve(1));
    child.once("close", code => resolve(code ?? 1));
  });
}

async function waitForOwner() {
  if (!process.stdin.isTTY) failure("upgrade_terminal_required");
  process.stdout.write("When the VPS prints DONE, press Enter here to continue.\n");
  await new Promise(resolve => process.stdin.once("data", () => resolve()));
}

/** This build's own executable ledger head. No database call: it is the
 * migration ledger for whatever commit is checked out right now, read the
 * same source-integrity way `database-upgrade-remote.mjs` does. */
async function localTargetLedgerHeadV1() {
  const ledger = JSON.parse(await readFile(migrationLedgerPath, "utf8"));
  const last = ledger.entries.filter(entry => (entry.kind ?? "migrate") === "migrate").at(-1);
  if (!last || typeof last.file !== "string" || typeof last.sha256 !== "string" || !Number.isSafeInteger(last.order))
    failure("upgrade_ledger_head_refused");
  return { file: last.file, order: last.order, digest: `sha256:${last.sha256}` };
}

/** Reads the web login out of the protected role record, and reports every
 * way that can fail as one recognisable upgrade refusal.
 *
 * Without this, a protected-record problem surfaced as
 * `mac_local_database_roles_root_invalid` escaping the whole command, which the
 * CLI collapsed to the opaque `upgrade_failed` -- an owner who fixed the file
 * and re-ran got the same opaque line, because the reason was never named. Each
 * refusal here is still a refusal; only the reason is now one the owner can
 * act on, and it names no path, no username and no secret. */
async function loadMacUpgradeWebRoleV1(protectedRoot) {
  try { return await loadMacLocalWebRoleFromRootV1(protectedRoot); }
  catch { failure("upgrade_ledger_head_refused"); }
}

/** Reads the non-secret migration identity with the already-configured web
 * login: this build's own ledger head (above, no database access) paired with
 * the live schema's structural digest. The migration ledger table itself
 * grants the web login no row access at all — `db/roles/production_table_grants.sql`
 * revokes it as a least-privilege denial proof, and real-PostgreSQL tests pin
 * that denial — so this never selects from that table directly. The catalog
 * digest is read the same permission-free way `mac:up`'s own hard schema
 * check already does, and changes whenever the VPS actually migrates. */
export async function readMacUpgradeLedgerHeadV1(protectedRoot) {
  const target = await localTargetLedgerHeadV1();
  // Only the `web` login is read, and only the `web` login is opened. The
  // full six-role record is what a COMPLETED install writes, so requiring it
  // here refused the command on every install that had not yet run `--finish`
  // -- which is every install this command exists to upgrade. The narrower
  // reader is the same protected file under the same checks.
  const web = await loadMacUpgradeWebRoleV1(protectedRoot);
  const database = createPrivatePostgresDatabase(web);
  try {
    const schemaDigest = await readPrivateWebSchemaDigest(database.client);
    if (typeof schemaDigest !== "string" || !/^[a-f0-9]{64}$/u.test(schemaDigest)) failure("upgrade_ledger_head_refused");
    return captureRecord({ schema: RECORD_SCHEMA, previousCommit: "0".repeat(40), targetCommit: "0".repeat(40),
      ledgerHead: { file: target.file, order: target.order, digest: `sha256:${schemaDigest}` } }).ledgerHead;
  } catch (error) {
    if (error instanceof Error && error.message === "upgrade_ledger_head_refused") throw error;
    failure("upgrade_ledger_head_refused");
  } finally { await database.close().catch(() => {}); }
}

async function assertCleanMain(git) {
  const [branch, dirty, head] = await Promise.all([git(["branch", "--show-current"]), git(["status", "--porcelain"]), git(["rev-parse", "HEAD"])]);
  if (branch !== "main" || dirty || !commitPattern.test(head)) failure("upgrade_main_checkout_refused");
  return head;
}

const command = (run, args, code) => async () => { if (await run(args) !== 0) failure(code); };
const sameHead = (left, right) => left.order === right.order && left.file === right.file && left.digest === right.digest;

/**
 * Injectable orchestration seam: tests use fake git, process, wait and database
 * readers, while the CLI always supplies the fixed production implementations.
 */
export async function runMacUpgradeV1(options) {
  const protectedRoot = options.protectedRoot;
  if (!isAbsolute(protectedRoot ?? "") || resolve(protectedRoot) !== protectedRoot) failure("upgrade_protected_root_required");
  const runtime = runtimePaths(protectedRoot);
  await privateDirectory(runtime.runtime);
  const custody = await directoryCustodyV1(runtime.runtime);
  const lock = acquirePrivateProcessLockV1(join(runtime.runtime, "upgrade.lock"),
    { busyCode: "upgrade_busy", unusableCode: "upgrade_lock_unusable" });
  try {
    await custody();
    return await runLockedMacUpgradeV1(options, runtime, lock.fd);
  } finally {
    // Keep the macOS kernel-lock inode: unlinking it admits two owners on
    // different inodes. A crash releases the descriptor automatically.
    if (process.platform === "darwin") lock.close(); else lock.release();
  }
}

async function runLockedMacUpgradeV1(options, runtime, lockFd) {
  const protectedRoot = options.protectedRoot;
  const git = options.git ?? (args => gitCommand(args, options.repositoryRoot ?? repoRoot));
  const run = options.run ?? (args => runPnpm(args, lockFd)), write = options.write ?? (line => process.stdout.write(`${line}\n`));
  const readLedgerHead = options.readLedgerHead ?? readMacUpgradeLedgerHeadV1;
  const prepare = options.prepare ?? prepareMacLocalDatabaseUpgradeV1, finish = options.finish ?? finishMacLocalDatabaseUpgradeV1;
  const wait = options.wait ?? waitForOwner, writeRecord = options.writeRecord ?? (record => writePrivateJson(runtime.upgradePrevious, record));
  const readRecord = options.readRecord ?? (() => readPrivateRecord(runtime.upgradePrevious, { optional: !options.rollback }));
  const existing = await readRecord();

  if (options.rollback) {
    const record = captureRecord(existing);
    const [branch, dirty, current, head] = await Promise.all([git(["branch", "--show-current"]),
      git(["status", "--porcelain"]), git(["rev-parse", "HEAD"]), readLedgerHead(protectedRoot)]);
    if (dirty || !commitPattern.test(current)) failure("upgrade_main_checkout_refused");
    const resuming = ["rolling_back", "rolled_back"].includes(record.phase)
      && branch === "" && current === record.previousCommit;
    if (!resuming && branch !== "main") failure("upgrade_main_checkout_refused");
    if (!resuming && current !== record.targetCommit) failure("upgrade_rollback_target_refused");
    // On the previous checkout its executable ledger order/file may be older.
    // The catalog digest still has to match the schema saved before upgrade.
    if (resuming ? record.ledgerHead.digest !== head.digest : !sameHead(record.ledgerHead, head))
      failure("upgrade_rollback_ledger_moved_refused");
    await writeRecord(captureRecord({ ...record, phase: "rolling_back" }));
    write("1/4 rollback: the database was not changed; restoring the previous app code");
    if (await run(["mac:down", "--", "--protected-root", protectedRoot]) !== 0) failure("upgrade_rollback_stop_failed");
    try { await git(["switch", "--detach", record.previousCommit]); }
    catch { failure("upgrade_rollback_checkout_failed"); }
    await command(run, ["build"], "upgrade_rollback_build_failed")();
    await command(run, ["mac:up", "--", "--protected-root", protectedRoot], "upgrade_rollback_start_failed")();
    if (await run(["mac:status", "--", "--protected-root", protectedRoot]) !== 0) failure("upgrade_rollback_health_failed");
    await writeRecord(captureRecord({ ...record, phase: "rolled_back" }));
    write("4/4 rollback complete: the earlier app code is running. To try the upgrade again, switch back to main first.");
    return { rolledBack: true, previousCommit: record.previousCommit };
  }

  const current = await assertCleanMain(git);
  const prior = existing ? captureRecord(existing) : null;
  if (prior?.phase === "rolling_back") failure("upgrade_rollback_pending_refused");
  try { await git(["fetch", "origin", "main"]); }
  catch { failure("upgrade_fetch_failed"); }
  const targetCommit = await git(["rev-parse", "origin/main"]);
  if (!commitPattern.test(targetCommit)) failure("upgrade_main_moved_refused");
  const resume = prior && prior.phase !== "rolled_back" && prior.targetCommit === targetCommit
    && [prior.previousCommit, prior.targetCommit].includes(current);
  if (["checkout_pending", "upgrading"].includes(prior?.phase) && !resume) failure("upgrade_transaction_pending_refused");
  let record = resume ? captureRecord({ ...prior, phase: prior.phase === "checkout_pending" ? "checkout_pending" : "upgrading" })
    : captureRecord({ schema: RECORD_SCHEMA, phase: "checkout_pending", previousCommit: current, targetCommit,
      ledgerHead: await readLedgerHead(protectedRoot) });
  // Publish the original identity BEFORE moving the checkout. Retry uses this
  // record even if the VPS step has already changed the schema.
  await writeRecord(record);
  try { await git(["merge", "--ff-only", "origin/main"]); }
  catch { failure("upgrade_fast_forward_failed"); }
  if (targetCommit !== await assertCleanMain(git)) failure("upgrade_main_moved_refused");
  if (record.phase === "checkout_pending") {
    const targetHead = await readLedgerHead(protectedRoot);
    record = captureRecord({ ...record, phase: "upgrading",
      ledgerHead: { ...targetHead, digest: record.ledgerHead.digest } });
    await writeRecord(record);
  }
  const { previousCommit, ledgerHead } = record;

  write("1/7 stop: stopping Control Room before replacing its files");
  await command(run, ["mac:down", "--", "--protected-root", protectedRoot], "upgrade_stop_failed")();
  write("2/7 install: checking the locked dependencies");
  await command(run, ["install", "--frozen-lockfile"], "upgrade_install_failed")();
  write("3/7 build: making the new app");
  await command(run, ["build"], "upgrade_build_failed")();
  write("4/7 handoff: prepare the VPS database step");
  const prepared = await prepare({ protectedRoot, mainCommit: targetCommit });
  if (!prepared || prepared.mainCommit !== targetCommit) failure("upgrade_prepare_refused");
  const reference = `${targetCommit.slice(0, 7)}·${String(ledgerHead.order).padStart(4, "0")}`;
  write(`Now run this on the VPS: cr-db-upgrade ${targetCommit.slice(0, 7)}`);
  write(`Upgrade reference: ${reference}`);
  if (typeof prepared.code === "string") write(`VPS login code (not a password; paste only at its prompt): ${prepared.code}`);
  write("Resume point if interrupted: run this same mac:upgrade command again; it will safely repeat the stopped steps.");
  write("5/7 wait: complete the VPS step, then return here");
  await wait();
  write("6/7 finish: checking any newly added database login");
  const finished = await finish({ protectedRoot, mainCommit: targetCommit });
  if (!finished || finished.mainCommit !== targetCommit) failure("upgrade_finish_refused");
  write("7/7 start: starting Control Room and checking its health");
  try {
    await command(run, ["mac:up", "--", "--protected-root", protectedRoot], "upgrade_start_failed")();
    if (await run(["mac:status", "--", "--protected-root", protectedRoot]) !== 0) failure("upgrade_health_failed");
  } catch (error) {
    // Reaching this point means every earlier step succeeded: the build is the
    // new code, the VPS database step was completed by the owner, and `finish`
    // already minted any new database logins. So this is NOT an ambiguous
    // "maybe the database moved" situation -- and saying so is what stops the
    // owner re-running the upgrade blind, which would stop the host again and
    // leave them exactly where they are.
    //
    // The rollback below is the guarded one: it refuses by itself if the
    // database ledger moved, which is what makes it safe to offer here rather
    // than after more hedging. Both outcomes are named, so neither requires
    // the owner to guess which one they are in.
    write(`Control Room did not start (or started unhealthy) at ${reference}. It is stopped or unhealthy now.`);
    write("The database was already upgraded on the VPS, and this rollback will refuse if the database moved since.");
    write("To go back to the previous app code, run exactly:");
    write(`  pnpm mac:upgrade -- --rollback --protected-root ${protectedRoot}`);
    write("If it refuses with upgrade_rollback_ledger_moved_refused, the database has moved on: that is the safer state, "
      + "and the previous app code must not be run against it.");
    write("To see the current state before deciding: pnpm mac:status");
    throw error;
  }
  await writeRecord(captureRecord({ ...record, phase: "upgraded" }));
  write(`Upgrade complete: Control Room is healthy at ${reference}.`);
  return { upgraded: true, previousCommit, targetCommit, ledgerHead };
}

export function parseMacUpgradeArgumentsV1(args) {
  const supplied = args[0] === "--" ? args.slice(1) : args;
  const rollback = supplied.includes("--rollback"), root = protectedRootFromArguments(supplied);
  const allowed = new Set(["--rollback", "--protected-root"]);
  for (let index = 0; index < supplied.length; index += 1) {
    if (!allowed.has(supplied[index]) || (supplied[index] === "--protected-root" && (!supplied[++index] || supplied[index].startsWith("--"))))
      failure("upgrade_arguments_refused");
  }
  if (!root) failure("upgrade_protected_root_required");
  return { protectedRoot: root, rollback };
}

/**
 * What the rollback refusals mean, for the owner who reaches them from the
 * guidance a failed start prints.
 *
 * These three are the ones that end the "get me back" attempt, and until now
 * each printed a bare code. Every other code keeps its bare name: the in-command
 * guidance already covers those, and a paragraph nobody needs is noise. Each
 * line says what happened, that nothing was changed, and what to do instead.
 */
export const ROLLBACK_GUIDANCE = Object.freeze({
  upgrade_rollback_ledger_moved_refused:
    "The database has changed since this upgrade started, so the earlier app code is not safe to run against "
    + "it. Nothing was changed. Keep the current database and investigate the failed start instead "
    + "(pnpm mac:status, then the service log).",
  upgrade_rollback_target_refused:
    "This is not the commit the failed upgrade was on, so it cannot roll that upgrade back safely. Nothing was "
    + "changed. Check out that commit on main and run the same rollback command again.",
  upgrade_recovery_record_refused:
    "The upgrade's recovery record is missing or unreadable, so there is no safe way back. Nothing was changed. "
    + "Do not guess: check the service log for why the new code did not start.",
  upgrade_rollback_stop_failed:
    "The rollback could not stop Control Room, so it changed nothing and stopped there. Control Room may still be "
    + "running the new code. Stop it (pnpm mac:down -- --protected-root <root>) and run the rollback again.",
  upgrade_rollback_checkout_failed:
    "The rollback could not check out the previous commit, so it changed nothing. Your checkout is untouched. "
    + "Free the working tree, then run the rollback again.",
  upgrade_rollback_build_failed:
    "The rollback checked out the previous commit but could not build it, so it changed nothing you can run. "
    + "Your checkout is now on the previous commit: run pnpm build and read the build error.",
  upgrade_rollback_start_failed:
    "The rollback built the previous code but could not start it, so there is no running Control Room. Nothing was "
    + "restored. Read the service log; the previous code is checked out and built.",
  upgrade_rollback_health_failed:
    "The rollback started the previous code but it is not healthy, so it is not a working installation. Nothing was "
    + "further changed. Read the service log; pnpm mac:status shows the current state.",
});

/**
 * What the CLI prints for a refusal: the code, then the guidance when there is
 * any.
 *
 * Exported so the PRINTING is testable and not just the table. A test that
 * asserts on `ROLLBACK_GUIDANCE` alone cannot catch the line that emits it
 * being deleted, and that line is the entire owner-visible behaviour: a table
 * nothing prints is exactly the bare-code defect this slice closes.
 *
 * @param {unknown} error
 * @returns {string[]} the lines to write to stderr, in order
 */
export function macUpgradeRefusalLinesV1(error) {
  const code = error instanceof Error && /^upgrade_[a-z_]+$/u.test(error.message) ? error.message : "upgrade_failed";
  const guidance = ROLLBACK_GUIDANCE[code];
  return [`mac:upgrade REFUSED ${code}`, ...(guidance ? [guidance] : [])];
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  try { await runMacUpgradeV1(parseMacUpgradeArgumentsV1(process.argv.slice(2))); }
  catch (error) {
    for (const line of macUpgradeRefusalLinesV1(error)) process.stderr.write(`${line}\n`);
    process.exitCode = 1;
  }
}
