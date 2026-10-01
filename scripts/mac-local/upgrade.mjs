import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
/**
 * Owner-attended Mac half of the two-command database upgrade. It deliberately
 * delegates start, stop, and login handling to the existing guarded commands.
 * The only durable state is a private, non-secret recovery record.
 */
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPrivatePostgresDatabase } from "../../src/web/v1/private-postgres";
import { readPrivateWebSchemaDigest } from "../../src/web/v1/private-database-preflight";
import { loadMacLocalDatabaseRolesFromRootV1 } from "../../src/web/v1/mac-local-protected-loader";
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
    || Object.keys(value).sort().join("|") !== "ledgerHead|previousCommit|schema|targetCommit"
    || value.schema !== RECORD_SCHEMA || !commitPattern.test(value.previousCommit ?? "") || !commitPattern.test(value.targetCommit ?? ""))
    failure("upgrade_recovery_record_refused");
  const head = value.ledgerHead;
  if (!head || typeof head !== "object" || Array.isArray(head) || Object.keys(head).sort().join("|") !== "digest|file|order"
    || !Number.isSafeInteger(head.order) || head.order < 1 || typeof head.file !== "string" || !/^db\/migrations\/\d{4}_[a-z0-9_]+\.sql$/u.test(head.file)
    || !digestPattern.test(head.digest ?? "")) failure("upgrade_recovery_record_refused");
  return Object.freeze({ schema: RECORD_SCHEMA, previousCommit: value.previousCommit, targetCommit: value.targetCommit,
    ledgerHead: Object.freeze({ order: head.order, file: head.file, digest: head.digest }) });
}

async function readPrivateRecord(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > 4096)
      failure("upgrade_recovery_record_refused");
    return captureRecord(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && error.message === "upgrade_recovery_record_refused") throw error;
    failure("upgrade_recovery_record_refused");
  }
}

async function gitCommand(args, cwd = repoRoot) {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  return stdout.trim();
}

async function runPnpm(args) {
  return await new Promise(resolve => {
    const child = spawn("pnpm", args, { cwd: repoRoot, env: process.env, stdio: "inherit" });
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
  const roles = await loadMacLocalDatabaseRolesFromRootV1(protectedRoot);
  const database = createPrivatePostgresDatabase(roles.web);
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
  const git = options.git ?? (args => gitCommand(args, options.repositoryRoot ?? repoRoot));
  const run = options.run ?? runPnpm, write = options.write ?? (line => process.stdout.write(`${line}\n`));
  const readLedgerHead = options.readLedgerHead ?? readMacUpgradeLedgerHeadV1;
  const prepare = options.prepare ?? prepareMacLocalDatabaseUpgradeV1, finish = options.finish ?? finishMacLocalDatabaseUpgradeV1;
  const wait = options.wait ?? waitForOwner, writeRecord = options.writeRecord ?? (record => writePrivateJson(runtime.upgradePrevious, record));
  const readRecord = options.readRecord ?? (() => readPrivateRecord(runtime.upgradePrevious));

  if (options.rollback) {
    const record = await readRecord();
    const [current, head] = await Promise.all([assertCleanMain(git), readLedgerHead(protectedRoot)]);
    if (current !== record.targetCommit) failure("upgrade_rollback_target_refused");
    if (!sameHead(record.ledgerHead, head)) failure("upgrade_rollback_ledger_moved_refused");
    write("1/4 rollback: the database was not changed; restoring the previous app code");
    if (await run(["mac:down", "--", "--protected-root", protectedRoot]) !== 0) failure("upgrade_rollback_stop_failed");
    try { await git(["switch", "--detach", record.previousCommit]); }
    catch { failure("upgrade_rollback_checkout_failed"); }
    await command(run, ["build"], "upgrade_rollback_build_failed")();
    await command(run, ["mac:up", "--", "--protected-root", protectedRoot], "upgrade_rollback_start_failed")();
    if (await run(["mac:status", "--", "--protected-root", protectedRoot]) !== 0) failure("upgrade_rollback_health_failed");
    write("4/4 rollback complete: the earlier app code is running. To try the upgrade again, switch back to main first.");
    return { rolledBack: true, previousCommit: record.previousCommit };
  }

  const previousCommit = await assertCleanMain(git);
  try { await git(["fetch", "origin", "main"]); }
  catch { failure("upgrade_fetch_failed"); }
  try { await git(["merge", "--ff-only", "origin/main"]); }
  catch { failure("upgrade_fast_forward_failed"); }
  const targetCommit = await assertCleanMain(git);
  if (targetCommit !== await git(["rev-parse", "origin/main"])) failure("upgrade_main_moved_refused");
  const ledgerHead = await readLedgerHead(protectedRoot);
  await privateDirectory(runtime.runtime);
  await writeRecord(captureRecord({ schema: RECORD_SCHEMA, previousCommit, targetCommit, ledgerHead }));

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
    write("Control Room did not become healthy. It remains stopped or unhealthy; do not retry blindly.");
    write("If the VPS did not migrate the database, you can run this safe rollback: pnpm mac:upgrade -- --rollback --protected-root <your protected root>");
    throw error;
  }
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

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  try { await runMacUpgradeV1(parseMacUpgradeArgumentsV1(process.argv.slice(2))); }
  catch (error) {
    const code = error instanceof Error && /^upgrade_[a-z_]+$/u.test(error.message) ? error.message : "upgrade_failed";
    process.stderr.write(`mac:upgrade REFUSED ${code}\n`);
    process.exitCode = 1;
  }
}
