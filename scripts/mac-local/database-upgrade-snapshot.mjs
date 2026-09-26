/** VPS-local, read-only snapshot for an offline Mac grant plan. No password or
 * host identity is included. Run as root from a clean main checkout. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { macDatabaseUpgradeReadOnlySqlV1 } from "./provision-database.mjs";

export const MAC_DATABASE_UPGRADE_SNAPSHOT_V1 = "control-room.mac-database-upgrade-snapshot/v1";
const root = fileURLToPath(new URL("../../", import.meta.url));

function mainCommit() {
  const run = args => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000 }).trim();
  const commit = run(["rev-parse", "HEAD"]);
  if (commit !== run(["rev-parse", "refs/remotes/origin/main"])
    || !["main", ""].includes(run(["branch", "--show-current"])) || run(["status", "--porcelain"])
    || !/^[a-f0-9]{40}$/u.test(commit)) throw new Error("upgrade_main_checkout_refused");
  return commit;
}

export function captureMacUpgradeSnapshotV1(mainCommitSha, raw) {
  if (!/^[a-f0-9]{40}$/u.test(mainCommitSha)) throw new Error("upgrade_main_commit_refused");
  const line = raw.split(/\r?\n/u).find(item => item.startsWith("{"));
  if (!line) throw new Error("upgrade_snapshot_output_refused");
  const snapshot = JSON.parse(line);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    throw new Error("upgrade_snapshot_output_refused");
  return { schema: MAC_DATABASE_UPGRADE_SNAPSHOT_V1, mainCommit: mainCommitSha, snapshot };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).join(" ") !== "--print") throw new Error("upgrade_snapshot_usage_refused");
    const commit = mainCommit();
    const raw = execFileSync("runuser", ["-u", "postgres", "--", "psql", "-X", "-A", "-t",
      "-v", "ON_ERROR_STOP=1", "-d", "control_room"], {
      input: macDatabaseUpgradeReadOnlySqlV1(), encoding: "utf8", timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"],
    });
    process.stdout.write(`${JSON.stringify(captureMacUpgradeSnapshotV1(commit, raw))}\n`);
  } catch (error) {
    const code = error instanceof Error && /^upgrade_[a-z0-9_]+$/u.test(error.message)
      ? error.message : "upgrade_snapshot_refused";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
