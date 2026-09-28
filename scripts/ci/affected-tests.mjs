import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { listTestFiles } from "../check-test-lane-coverage.mjs";

const sourceExtension = /\.(?:[cm]?[jt]sx?)$/;
const importPattern = /\b(?:import|export)\s+(?:type\s+)?[^;]*?\s+from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/g;
const fallbackPath = /^(?:\.github|db)(?:\/|$)|(?:^|\/)(?:migrations?|config)(?:\/|$)|(?:^|\/)(?:package\.json|pnpm-(?:lock|workspace)\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json|\.npmrc|\.nvmrc)$|(?:^|\/)(?:tsconfig[^/]*\.json|[^/]+\.config\.[cm]?[jt]s)$/;

function normalized(value) {
  return value.split(sep).join("/").replace(/^\.\//, "");
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(normalized(relative(root, path)));
    }
  };
  visit(root);
  return files;
}

function importTargets(importer, specifier, knownFiles) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return [];
  const start = specifier.startsWith("@/")
    ? specifier.slice(2)
    : normalized(join(dirname(importer), specifier));
  const candidates = extname(start)
    ? [start]
    : [start, ...[".ts", ".tsx", ".mts", ".cts", ".mjs", ".js", ".jsx"].map(extension => `${start}${extension}`),
      ...["index.ts", "index.tsx", "index.mts", "index.cts", "index.mjs", "index.js", "index.jsx"].map(file => `${start}/${file}`)];
  return candidates.filter(candidate => knownFiles.has(candidate));
}

export function requiresAll(changedFiles) {
  return changedFiles.some(file => fallbackPath.test(normalized(file)));
}

export function affectedTests(repositoryRoot, changedFiles) {
  const changed = changedFiles.map(normalized);
  if (requiresAll(changed)) return "ALL";

  const files = listFiles(repositoryRoot);
  const knownFiles = new Set([...files, ...changed]);
  const importers = new Map();
  for (const importer of files.filter(file => sourceExtension.test(file))) {
    const source = readFileSync(join(repositoryRoot, importer), "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match.slice(1).find(Boolean);
      for (const target of importTargets(importer, specifier, knownFiles)) {
        if (!importers.has(target)) importers.set(target, new Set());
        importers.get(target).add(importer);
      }
    }
  }

  const tests = new Set(listTestFiles(repositoryRoot));
  const selected = new Set(changed.filter(file => tests.has(file)));
  const pending = [...changed], visited = new Set(pending);
  while (pending.length > 0) {
    const target = pending.pop();
    for (const importer of importers.get(target) ?? []) {
      if (tests.has(importer)) selected.add(importer);
      if (!visited.has(importer)) {
        visited.add(importer);
        pending.push(importer);
      }
    }
  }
  return [...selected].sort();
}

export function changedFiles(repositoryRoot, baseRef) {
  const output = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`, "--"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return output.split(/\r?\n/).filter(Boolean);
}

export function requestedBaseRef(arguments_) {
  return arguments_.filter(argument => argument !== "--run" && argument !== "--")[0] ?? "origin/main";
}

function executeCommand(command, arguments_, root) {
  const child = spawnSync(command, arguments_, { cwd: root, stdio: "inherit" });
  if (child.error) throw child.error;
  if (child.status !== 0) return child.status ?? 1;
  return 0;
}

export function affectedTestCommands(result, tests, repositoryRoot = process.cwd()) {
  const testSources = result === "ALL"
    ? []
    : tests.map(test => readFileSync(join(repositoryRoot, test), "utf8"));
  const needsVpsBuild = result === "ALL" || testSources.some(source => source.includes("dist-vps"));
  const needsDemoBuild = result === "ALL" || testSources.some(source => source.includes("dist-contributor"));
  const preparation = [
    ...(needsVpsBuild ? [["pnpm", ["build"]]] : []),
    ...(needsDemoBuild ? [["pnpm", ["run", "build:demo"]]] : []),
  ];
  return [...preparation, [process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...tests]]];
}

export function runAffectedTests(result, tests, repositoryRoot, execute = executeCommand) {
  for (const [command, arguments_] of affectedTestCommands(result, tests, repositoryRoot)) {
    const status = execute(command, arguments_, repositoryRoot);
    if (status !== 0) return status;
  }
  return 0;
}

function main() {
  const shouldRun = process.argv.includes("--run");
  const baseRef = requestedBaseRef(process.argv.slice(2));
  const root = process.cwd();
  const result = affectedTests(root, changedFiles(root, baseRef));
  if (!shouldRun) {
    console.log(result === "ALL" ? result : result.join("\n"));
    return;
  }
  const tests = result === "ALL" ? listTestFiles(root) : result;
  if (tests.length === 0) {
    console.log("No affected tests.");
    return;
  }
  if (result === "ALL")
    console.log("Preparing generated application and contributor-demo artifacts for the complete test set.");
  console.log(`Running ${tests.length} affected test file(s).`);
  process.exitCode = runAffectedTests(result, tests, root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
