import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const squawkBin = "squawk";

function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout;
}

export function parseNameStatus(value) {
  const fields = value.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    if (/^[RC]/.test(status)) changes.push({ status, paths: [fields[index++], fields[index++]] });
    else changes.push({ status, paths: [fields[index++]] });
  }
  return changes;
}

const isMigration = path => typeof path === "string" && /^db\/migrations\/[^/]+\.sql$/.test(path);

export function classifyMigrationChanges(changes, existsOnBase) {
  const violations = [];
  const lint = new Set();
  for (const change of changes) {
    const migrationPaths = change.paths.filter(isMigration);
    if (migrationPaths.length === 0) continue;
    const shipped = migrationPaths.filter(existsOnBase);
    if (shipped.length > 0) {
      for (const path of shipped) violations.push(`${change.status} ${path} exists on main; add a new migration instead`);
      continue;
    }
    const destination = change.paths.at(-1);
    if (/^A/.test(change.status) && isMigration(destination)) lint.add(destination);
  }
  return { violations, lint: [...lint].sort() };
}

export function checkMigrations({ base = "origin/main", runGit = git, runSquawk } = {}) {
  const mergeBase = runGit(["merge-base", base, "HEAD"]).trim();
  const changes = parseNameStatus(runGit(["diff", "--name-status", "-z", `${mergeBase}...HEAD`, "--", "db/migrations"]));
  const existsOnBase = path => {
    const result = spawnSync("git", ["cat-file", "-e", `${mergeBase}:${path}`], { stdio: "ignore" });
    return result.status === 0;
  };
  const result = classifyMigrationChanges(changes, existsOnBase);
  if (result.violations.length > 0) return result;
  if (result.lint.length > 0) {
    const lint = runSquawk
      ? runSquawk(result.lint)
      : spawnSync(squawkBin, ["--config", join(repositoryRoot, ".squawk.toml"), ...result.lint],
        { stdio: "inherit", env: process.env });
    if ((lint.status ?? lint) !== 0) result.violations.push("Squawk rejected a changed migration");
  }
  return result;
}

function main() {
  const baseIndex = process.argv.indexOf("--base");
  const base = baseIndex >= 0 ? process.argv[baseIndex + 1] : process.env.MIGRATION_BASE_REF || "origin/main";
  try {
    const result = checkMigrations({ base });
    if (result.violations.length > 0) {
      for (const violation of result.violations) console.error(violation);
      process.exitCode = 1;
      return;
    }
    console.log(result.lint.length === 0 ? "no changed migrations to lint" : `Squawk passed ${result.lint.length} new migration(s)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
