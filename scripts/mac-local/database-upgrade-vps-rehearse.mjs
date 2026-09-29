/** The isolated half of `cr-db-upgrade --rehearse`. It selects the newest
 * intact bound backup, restores it into a fresh socket-only PostgreSQL cluster,
 * and runs the same plan/apply code as a real upgrade. Nothing accepts or even
 * receives the live connection target. The verification helper owns teardown
 * on every exit path. */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { postgresScramVerifierV1 } from "./database-upgrade-scram.mjs";
import { runMacDatabaseUpgradeVpsStepV1 } from "./database-upgrade-vps-step.mjs";
import { readBoundMacLocalDatabaseBackupV1, verifyMacLocalDatabaseBackupV1 } from "../ops/verify-database-backup.mjs";

const sha256 = value => /^sha256:[a-f0-9]{64}$/u.test(value ?? "");
const isCommit = value => /^[a-f0-9]{40}$/u.test(value ?? "");

async function newestBoundBackup(backupRoot) {
  if (typeof backupRoot !== "string" || !isAbsolute(backupRoot) || resolve(backupRoot) !== backupRoot)
    throw new Error("upgrade_rehearse_backup_root_refused");
  let entries;
  try { entries = await readdir(backupRoot); } catch { throw new Error("upgrade_rehearse_no_verified_backup"); }
  for (const name of entries.sort().reverse()) {
    const candidate = join(backupRoot, name);
    try {
      if (!(await lstat(candidate)).isDirectory()) continue;
      await readBoundMacLocalDatabaseBackupV1(candidate);
      return candidate;
    } catch { /* An old or damaged backup is not a rehearsal candidate. */ }
  }
  throw new Error("upgrade_rehearse_no_verified_backup");
}

const temporaryLoginCode = plan => JSON.stringify(Object.fromEntries(plan.createRoles
  .filter(item => /(^|\s)LOGIN(\s|$)/u.test(item.attributes ?? ""))
  .map(item => [item.role, postgresScramVerifierV1(randomBytes(32).toString("base64url"))])));

async function requireFreeThrowawayPort(port) {
  const probe = createServer();
  try {
    await new Promise((resolveProbe, rejectProbe) => {
      probe.once("error", rejectProbe);
      probe.listen(port, "127.0.0.1", resolveProbe);
    });
  } catch (error) {
    if (error?.code === "EADDRINUSE") throw new Error("upgrade_rehearse_port_busy");
    throw new Error("upgrade_rehearse_port_refused");
  } finally { if (probe.listening) await new Promise(resolveClose => probe.close(() => resolveClose())); }
}

/**
 * @param {{ commit: string, backupRoot: string, pgBin: string, port: number,
 *   diskFactor?: number, write?: (text: string) => void }} options
 */
export async function runMacDatabaseUpgradeVpsRehearseV1({ commit, backupRoot, pgBin, port,
  diskFactor = 2, write = text => process.stdout.write(text) }) {
  if (!isCommit(commit) || typeof pgBin !== "string" || !isAbsolute(pgBin) || !Number.isInteger(port)
    || port < 1024 || port > 65535 || !(diskFactor >= 1)) throw new Error("upgrade_rehearse_input_refused");
  await requireFreeThrowawayPort(port);
  const backup = await newestBoundBackup(backupRoot);
  const short = commit.slice(0, 7);
  write(`Rehearsing ${short} from the latest verified backup (${basename(backup)}) in a throwaway database …\n`);
  let result;
  await verifyMacLocalDatabaseBackupV1({ backup, port, pgBin, portRange: { min: port, max: port },
    afterRestore: async ({ target, root }) => {
      const rehearsalBackupRoot = join(root, "upgrade-backup");
      await mkdir(rehearsalBackupRoot, { mode: 0o700 });
      const targetText = `host=${target.host} port=${target.port} dbname=${target.database} user=${target.user}`;
      const common = [commit, targetText, rehearsalBackupRoot, pgBin, String(diskFactor)];
      const plan = await runMacDatabaseUpgradeVpsStepV1({ args: ["plan", ...common], write });
      if (plan.nothingToDo) {
        result = { nothingToDo: true, head: undefined };
        return;
      }
      if (!sha256(plan.digest)) throw new Error("upgrade_rehearse_plan_refused");
      // New roles in a rehearsal need valid verifiers but must never need the
      // Mac's real code. These values exist only in the disposable cluster and
      // its cleanup-owned directory; neither is retained or printed.
      const code = temporaryLoginCode(plan.plan);
      const applied = await runMacDatabaseUpgradeVpsStepV1({ args: ["apply", ...common, plan.digest],
        readCode: async () => code, write });
      result = { nothingToDo: false, head: applied.head };
    } });
  write(result?.nothingToDo ? `REHEARSAL DONE ${short} — no database changes were needed.\n`
    : `REHEARSAL DONE ${short}·${result?.head ?? "????"} — the throwaway database was removed.\n`);
  return Object.freeze({ backup: basename(backup), ...result });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let stage = "rehearse";
  try {
    const [commit, backupRoot, pgBin, port, factor] = process.argv.slice(2);
    await runMacDatabaseUpgradeVpsRehearseV1({ commit, backupRoot, pgBin, port: Number(port), diskFactor: Number(factor),
      write: text => process.stdout.write(text) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = /^upgrade_(?:rehearse|disk_space_low|backup_failed|plan_changed_refused|convergence_refused)[a-z0-9_]*$/u.test(message)
      ? message : "upgrade_rehearse_failed";
    process.stderr.write(`upgrade_error:${code} stage=${stage}\n`);
    if (code === "upgrade_rehearse_no_verified_backup")
      process.stderr.write("Refused: there is no intact verified backup to rehearse. Create and verify a backup first. Nothing was changed.\n");
    else if (code === "upgrade_rehearse_port_busy")
      process.stderr.write("Refused: the throwaway database port is busy. Nothing was changed.\n");
    else if (code === "upgrade_rehearse_failed")
      process.stderr.write("Refused: the throwaway rehearsal did not complete. Nothing was changed on the live database.\n");
    process.exitCode = 1;
  }
}
