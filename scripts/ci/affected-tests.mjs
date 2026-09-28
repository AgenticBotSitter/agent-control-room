import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { listTestFiles } from "../check-test-lane-coverage.mjs";

const sourceExtension = /\.(?:[cm]?[jt]sx?)$/;
const importPattern = /\b(?:import|export)\s+(?:type\s+)?[^;]*?\s+from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/g;
const fallbackPath = /^(?:\.github|db)(?:\/|$)|(?:^|\/)(?:migrations?|config)(?:\/|$)|(?:^|\/)(?:package\.json|pnpm-(?:lock|workspace)\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json|\.npmrc|\.nvmrc)$|(?:^|\/)(?:tsconfig[^/]*\.json|[^/]+\.config\.[cm]?[jt]s)$/;
const documentationPath = /^docs\//;
const postgresTestMarker = /(?:requiresRealPostgres|\bPG_BIN\b|\binitdb\b|\bpg_ctl\b)/;

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

export function isDocumentationOnly(changedFiles) {
  return changedFiles.length > 0 && changedFiles.every(file => documentationPath.test(normalized(file)));
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
  const result = [...selected].sort();
  if (result.length > 0) return result;
  // Static imports cannot see assets served from public/, generated inputs, or
  // arbitrary file reads. A non-documentation zero is uncertainty, not proof
  // that no test is affected.
  return isDocumentationOnly(changed) ? "DOCS_ONLY" : "ALL";
}

export function changedFiles(repositoryRoot, baseRef) {
  const output = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`, "--"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return output.split(/\r?\n/).filter(Boolean);
}

export function requestedBaseRef(arguments_) {
  return arguments_.filter(argument => argument !== "--run" && argument !== "--github-output" && argument !== "--")[0] ?? "origin/main";
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

export function requiresPostgres(result, tests, repositoryRoot = process.cwd()) {
  return result === "ALL" || tests.some(test => postgresTestMarker.test(readFileSync(join(repositoryRoot, test), "utf8")));
}

export function postgresBinariesAvailable(directory = process.env.PG_BIN ?? "/usr/lib/postgresql/17/bin") {
  return ["initdb", "pg_ctl", "postgres"].every(binary => existsSync(join(directory, binary)));
}

export function noTestsAffectedMessage() {
  return "No test files affected: documentation-only change; no tests run.";
}

export function selectionOutputs(result, tests, repositoryRoot = process.cwd()) {
  return [
    `all=${result === "ALL"}`,
    `needs-pg=${requiresPostgres(result, tests, repositoryRoot)}`,
    `docs-only=${result === "DOCS_ONLY"}`,
  ].join("\n");
}

export function runAffectedTests(result, tests, repositoryRoot, execute = executeCommand, postgresAvailable = postgresBinariesAvailable) {
  if (result === "DOCS_ONLY") return 0;
  if (requiresPostgres(result, tests, repositoryRoot) && !postgresAvailable()) {
    console.error("Selected test plan requires PostgreSQL 17 binaries, but PG_BIN does not contain initdb, pg_ctl, and postgres.");
    return 1;
  }
  for (const [command, arguments_] of affectedTestCommands(result, tests, repositoryRoot)) {
    const status = execute(command, arguments_, repositoryRoot);
    if (status !== 0) return status;
  }
  return 0;
}

function main() {
  const shouldRun = process.argv.includes("--run");
  const githubOutput = process.argv.includes("--github-output");
  const baseRef = requestedBaseRef(process.argv.slice(2));
  const root = process.cwd();
  const result = affectedTests(root, changedFiles(root, baseRef));
  const tests = result === "ALL" ? listTestFiles(root) : result === "DOCS_ONLY" ? [] : result;
  if (githubOutput) {
    if (!process.env.GITHUB_OUTPUT) throw new Error("--github-output requires GITHUB_OUTPUT");
    appendFileSync(process.env.GITHUB_OUTPUT, `${selectionOutputs(result, tests, root)}\n`);
    return;
  }
  if (!shouldRun) {
    console.log(result === "ALL" ? result : result.join("\n"));
    return;
  }
  if (result === "DOCS_ONLY") {
    console.log(noTestsAffectedMessage());
    return;
  }
  if (result === "ALL")
    console.log("Preparing generated application and contributor-demo artifacts for the complete test set.");
  console.log(`Running ${tests.length} affected test file(s).`);
  process.exitCode = runAffectedTests(result, tests, root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
