/** The database half of `cr-db-upgrade` (deploy/vps/cr-db-upgrade). The root
 * wrapper runs it only as the `postgres` account, from a clean staged clone of
 * the approved commit. `plan` is read-only. `apply` checks again, refuses a
 * changed plan or a missing login code, takes a backup, and only then writes.
 * A login code arrives on stdin and is never printed or written to a file. */
import { mkdir, rm, statfs, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { connectTarget, readSchemaDigest } from "../../deploy/postgres/evidence.mjs";
import { invokedDirectlyV1 } from "../dev/invoked-directly.mjs";
import { createMacLocalDatabaseBackupV1 } from "../ops/backup-database.mjs";
import { databaseRoleManifestV1 as manifest } from "./database-role-manifest.mjs";
import { macRolePlan } from "./database-upgrade-grants.mjs";
import { applyPendingMacMigrationsV1, inspectMacDatabaseUpgradeV1, macDatabaseUpgradePlanDigestV1,
  parseMacDatabaseLoginCodesV1, runMacDatabaseUpgradeCommandV1, sanitizedMacDatabaseUpgradeFailureV1 }
  from "./database-upgrade-remote.mjs";

const macLogins = Object.keys(macRolePlan);
const isLogin = role => Object.hasOwn(manifest.logins, role);
const number = file => /\/(\d{4})_/u.exec(file)?.[1] ?? "????";

export function plainMacDatabaseUpgradePlanWordsV1(plan) {
  const pending = plan.pendingMigrations, logins = plan.createRoles.map(item => item.role).filter(isLogin);
  return [pending.length === 0 ? "migrations: none" : pending.length === 1 ? `1 migration: ${number(pending[0])}`
    : `${pending.length} migrations: ${number(pending[0])}…${number(pending.at(-1))}`,
  `queue tables: ${plan.installQueueSchema ? "install" : "in place"}`,
  `new groups: ${plan.createRoles.length - logins.length}`,
  `new logins: ${logins.length}${logins.length ? ` (${logins.join(", ")})` : ""}`,
  `membership changes: ${plan.membership.grant.length + plan.membership.revoke.length}`,
  `permission changes: ${plan.grants.extra.length + plan.grants.missing.length}`].join(" · ");
}

export const macDatabaseUpgradePlanIsEmptyV1 = plan => !plan.pendingMigrations.length && !plan.installQueueSchema
  && !plan.createRoles.length && !plan.membership.grant.length && !plan.membership.revoke.length
  && !plan.grants.extra.length && !plan.grants.missing.length;

const refusal = (code, plain) => Object.assign(new Error(code), { plain });

/** Read-only checks that must hold before a plan is shown and again before a write. */
async function checkLiveState(client, { backupRoot, spaceFactor }) {
  const connected = (await client.query(`SELECT DISTINCT usename FROM pg_stat_activity
    WHERE usename=ANY($1::text[]) ORDER BY 1`, [macLogins])).rows.map(row => row.usename);
  if (connected.length) throw refusal("upgrade_mac_login_connected", `Refused: the Mac is still connected as `
    + `${connected.join(", ")}. Stop Control Room on the Mac first, then run this again. Nothing was changed.`);
  const [last] = (await client.query(`SELECT post_schema_digest FROM control_room_schema_migrations
    ORDER BY ledger_order DESC LIMIT 1`)).rows;
  if (last && last.post_schema_digest !== await readSchemaDigest(client)) throw refusal("upgrade_schema_drift_refused",
    "Refused: the live tables differ from what the applied migrations made. Nothing was changed.");
  const size = Number((await client.query("SELECT pg_database_size(current_database()) AS size")).rows[0].size);
  const disk = await statfs(backupRoot);
  if (disk.bavail * disk.bsize < spaceFactor * size) throw refusal("upgrade_disk_space_low",
    `Refused: the backup disk needs ${Math.ceil(spaceFactor * size / 1e6)} MB free (twice the database). `
    + "Nothing was changed.");
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 8192) throw new Error("upgrade_verifier_input_refused");
  }
  return input;
}

export async function runMacDatabaseUpgradeVpsStepV1({ args, readCode = readStdin, write = text => process.stdout.write(text),
  onStage = () => {}, now = () => new Date() }) {
  const [action, commit, target, backupRoot, pgBin, factor, digest] = args;
  const spaceFactor = Number(factor);
  if (!["plan", "apply"].includes(action) || !/^[a-f0-9]{40}$/u.test(commit ?? "") || typeof target !== "string"
    || !isAbsolute(backupRoot ?? "") || !isAbsolute(pgBin ?? "") || !(spaceFactor >= 1)
    || (action === "apply") !== /^sha256:[a-f0-9]{64}$/u.test(digest ?? "")) throw new Error("upgrade_input_refused");
  const short = commit.slice(0, 7);
  const client = connectTarget(target);
  await client.connect();
  let plan, code = "";
  try {
    onStage("check");
    await checkLiveState(client, { backupRoot, spaceFactor });
    onStage("plan");
    plan = await inspectMacDatabaseUpgradeV1({ client });
    const head = number((await client.query(`SELECT filename FROM control_room_schema_migrations
      ORDER BY ledger_order DESC LIMIT 1`)).rows[0]?.filename ?? "");
    const planned = plan.createRoles.map(item => item.role).filter(isLogin);
    if (action === "plan") {
      const nothingToDo = macDatabaseUpgradePlanIsEmptyV1(plan);
      const summary = { commit, digest: macDatabaseUpgradePlanDigestV1(plan), nothingToDo,
        needsLoginCode: planned.length > 0, plan };
      write(nothingToDo ? `Nothing to do — the database already matches ${short}·${head}.\n`
        : `Plan for ${short}: ${plainMacDatabaseUpgradePlanWordsV1(plan)}\nPlan digest: ${summary.digest}\n`);
      write(`${JSON.stringify(summary)}\n`);
      return summary;
    }
    if (macDatabaseUpgradePlanDigestV1(plan) !== digest) throw refusal("upgrade_plan_changed_refused", "Refused: "
      + "the database changed after the plan was approved. Nothing was changed. Run cr-db-upgrade again.");
    if (planned.length) {
      code = await readCode();
      const codes = parseMacDatabaseLoginCodesV1(code);
      if (planned.some(role => !codes[role])) throw refusal(`upgrade_new_login_needs_verifier:${planned.join(",")}`,
        `Refused: the login code from the Mac does not cover every new login (${planned.join(", ")}). Nothing was changed.`);
    }
  } finally { await client.end(); }
  onStage("backup");
  const stamp = now().toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
  const out = join(backupRoot, `pre-${short}-${stamp}`);
  write(`Backing up to ${out} …\n`);
  let created = false;
  try {
    await mkdir(out, { mode: 0o700 });
    created = true;
    await createMacLocalDatabaseBackupV1({ source: target, out, pgBin });
  } catch (cause) {
    if (created) await rm(out, { recursive: true, force: true });
    throw Object.assign(refusal("upgrade_backup_failed", "Refused: the backup failed. Nothing was changed."), { cause });
  }
  await writeFile(join(out, "plan.json"), `${JSON.stringify({ commit, digest, plan })}\n`, { mode: 0o600, flag: "wx" });
  write("Applying …\n");
  await runMacDatabaseUpgradeCommandV1({ args: ["--apply", "--expected-main", commit, "--expected-plan-digest", digest],
    readVerifier: async () => code, openClient: () => connectTarget(target),
    applyPending: () => applyPendingMacMigrationsV1(target), onStage });
  onStage("verify");
  const verify = connectTarget(target);
  await verify.connect();
  try {
    if (!macDatabaseUpgradePlanIsEmptyV1(await inspectMacDatabaseUpgradeV1({ client: verify })))
      throw new Error("upgrade_convergence_refused");
    const head = number((await verify.query(`SELECT filename FROM control_room_schema_migrations
      ORDER BY ledger_order DESC LIMIT 1`)).rows[0]?.filename ?? "");
    write(`DONE ${short}·${head}\nThe backup and the plan are kept at ${out}\n`);
    return { done: true, head, backup: out };
  } finally { await verify.end(); }
}

if (invokedDirectlyV1(process.argv[1], import.meta.url)) {
  let stage = "plan";
  try {
    await runMacDatabaseUpgradeVpsStepV1({ args: process.argv.slice(2), onStage: next => { stage = next; } });
  } catch (error) {
    process.stderr.write(`${sanitizedMacDatabaseUpgradeFailureV1(error, stage)}\n`);
    if (typeof error?.plain === "string") process.stderr.write(`${error.plain}\n`);
    process.exitCode = 1;
  }
}
