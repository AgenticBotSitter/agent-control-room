import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
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
const isRegularGitMode = mode => /^100[0-7]{3}$/.test(mode);

function migrationDirectory(root) {
  return join(root, "db", "migrations");
}

function scanMigrationDirectory(root) {
  const directory = migrationDirectory(root);
  const violations = [];
  let directoryStat;
  try {
    directoryStat = lstatSync(directory);
  } catch (error) {
    violations.push(`cannot inspect db/migrations: ${error instanceof Error ? error.message : String(error)}`);
    return violations;
  }
  if (!directoryStat.isDirectory()) {
    violations.push("db/migrations must be a real directory");
    return violations;
  }

  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name);
      const relative = entryPath.slice(root.length + 1);
      const stat = lstatSync(entryPath);
      if (!stat.isFile()) violations.push(`${relative} is not a regular file (symlinks and directories are forbidden in db/migrations)`);
    }
  };
  visit(directory);
  return violations;
}

function scanBaseMigrationTree(base, runGit) {
  const entries = runGit(["ls-tree", "-r", "-z", base, "--", "db/migrations"]).split("\0").filter(Boolean);
  return entries.flatMap(entry => {
    const [metadata, path] = entry.split("\t");
    const [mode] = metadata.split(" ");
    return isRegularGitMode(mode) ? [] : [`${base}:${path} is not a regular file (symlinks are forbidden in db/migrations)`];
  });
}

function resolveRegularMigrationFiles(paths, root) {
  return paths.map(path => {
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    return realpathSync(absolute);
  });
}

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

export function checkMigrations({ base = "origin/main", runGit = git, runSquawk, cwd = process.cwd() } = {}) {
  const mergeBase = runGit(["merge-base", base, "HEAD"]).trim();
  const violations = [...scanMigrationDirectory(cwd), ...scanBaseMigrationTree(base, runGit)];
  if (violations.length > 0) return { violations, lint: [] };
  const changes = parseNameStatus(runGit(["diff", "--name-status", "-z", `${mergeBase}...HEAD`, "--", "db/migrations"]));
  const existsOnBase = path => {
    const listing = runGit(["ls-tree", "-z", mergeBase, "--", path]);
    const entry = listing.split("\0").filter(Boolean)[0];
    return Boolean(entry && isRegularGitMode(entry.split("\t", 1)[0].split(" ", 1)[0]));
  };
  const result = classifyMigrationChanges(changes, existsOnBase);
  if (result.violations.length > 0) return result;
  if (result.lint.length > 0) {
    const resolvedFiles = resolveRegularMigrationFiles(result.lint, cwd);
    const lint = runSquawk
      ? runSquawk(resolvedFiles)
      : spawnSync(squawkBin, ["--config", join(repositoryRoot, ".squawk.toml"), ...resolvedFiles],
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
