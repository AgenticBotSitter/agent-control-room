import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { listTestFiles } from "../check-test-lane-coverage.mjs";

const sourceExtension = /\.(?:[cm]?[jt]sx?)$/;
const importPattern = /\b(?:import|export)\s+(?:type\s+)?[^;]*?\s+from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/g;
const fallbackPath = /^(?:\.github|db)(?:\/|$)|(?:^|\/)(?:migrations?|config)(?:\/|$)|(?:^|\/)(?:package\.json|pnpm-(?:lock|workspace)\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json|\.npmrc|\.nvmrc)$|(?:^|\/)(?:tsconfig[^/]*\.json|[^/]+\.config\.[cm]?[jt]s)$/;
const documentationPath = /^docs\//;
const documentationReadPattern = /["'](docs\/[^"'\\]+)["']/g;
const postgresTestMarker = /(?:requiresRealPostgres|\bPG_BIN\b|\binitdb\b|\bpg_ctl\b|CONTROL_ROOM_PG17_UPGRADE_REHEARSAL|CONTROL_ROOM_PG_CONCURRENCY_GATE|CONTROL_ROOM_TEST_PG_URL_)/;
const squawkTestMarker = /\bsquawk\b/iu;
// This list is deliberately small and each entry has an execution reason.
// Exemptions run separately and their allowed skips are logged below.
export const skippedTestExemptions = new Map([
  ["tests/automatic-claim-controller.test.mjs", "requires ACR_MAIN_CHECKOUT pointing at a current main checkout"],
  ["tests/codex-owner-trusted-local-exec.test.ts", "requires CONTROL_ROOM_REAL_CODEX_SANDBOX_EXECUTABLE; CI has no qualified real Codex sandbox binary"],
  // These suites require a non-root macOS host and its native toolchain.
  ["tests/claude-code-macos-process-host-ports.test.ts", "requires a non-root macOS host and native toolchain"],
  ["tests/claude-code-native-process.test.mjs", "requires a non-root macOS host and native toolchain"],
  ["tests/hermes-021-macos-pinned-executable-image.test.mjs", "requires a non-root macOS host and native toolchain"],
  ["tests/macos-claude-code-process-native-sidecar.test.mjs", "requires a non-root macOS host and native toolchain"],
  ["tests/macos-hermes-native-launch-custodian.test.ts", "requires a non-root macOS host and native toolchain"],
  ["tests/macos-installation-journal-native-sidecar.test.mjs", "requires a non-root macOS host and native toolchain"],
  ["tests/macos-installed-configuration-native-sidecar.test.mjs", "requires a non-root macOS host and native toolchain"],
  ["tests/macos-service-native-sidecar.test.mjs", "requires a non-root macOS host and native toolchain"],
  ["tests/private-installation-journal-native-session.test.ts", "requires a non-root macOS host and native toolchain"],
  ["tests/private-installed-configuration-native-host.test.ts", "requires a non-root macOS host and native toolchain"],
  ["tests/private-macos-claude-code-qualification-route.test.ts", "requires a non-root macOS host and native toolchain"],
  ["tests/private-macos-service-native-host.test.ts", "requires a non-root macOS host and native toolchain"],
  ["tests/private-protected-root-native-directory.test.ts", "requires a non-root macOS host and native toolchain"],
  ["tests/mac-local-pg17-rehearsal.test.mjs", "runs in the full-mac-local-rehearsal job, which provides CONTROL_ROOM_MAC_REHEARSAL_ROOT (see PR #429)"],
]);

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

function addImporter(importers, target, importer) {
  if (!importers.has(target)) importers.set(target, new Set());
  importers.get(target).add(importer);
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
        addImporter(importers, target, importer);
      }
    }
    // A literal docs input can be runtime-significant even though it is not an import.
    for (const match of source.matchAll(documentationReadPattern)) {
      const target = normalized(match[1]);
      if (knownFiles.has(target)) addImporter(importers, target, importer);
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

const postgresEnvironmentNames = [
  "CONTROL_ROOM_PG17_UPGRADE_REHEARSAL",
  "CONTROL_ROOM_PG_CONCURRENCY_GATE",
  "CONTROL_ROOM_TEST_PG_URL_A",
  "CONTROL_ROOM_TEST_PG_URL_B",
];

function withoutPostgresTestEnvironment() {
  const environment = { ...process.env };
  for (const name of postgresEnvironmentNames) delete environment[name];
  return environment;
}

function executeCommand(command, arguments_, root, environment = process.env) {
  const child = spawnSync(command, arguments_, { cwd: root, stdio: "inherit", env: environment });
  if (child.error) throw child.error;
  if (child.status !== 0) return child.status ?? 1;
  return 0;
}

function executeCommandCapturingOutput(command, arguments_, root, environment = process.env) {
  const env = { ...environment };
  // A focused guard test invokes this runner from node:test. Its child is the
  // actual test process, not a recursive discovery run.
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(command, arguments_, { cwd: root, encoding: "utf8", env });
  if (child.error) throw child.error;
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  return { status: child.status ?? 1, output: `${child.stdout ?? ""}${child.stderr ?? ""}` };
}

function testSources(tests, repositoryRoot) {
  return tests.map(test => readFileSync(join(repositoryRoot, test), "utf8"));
}

function postgresTests(result, tests, repositoryRoot) {
  if (result !== "ALL" && !(result instanceof Array)) return [];
  return tests.filter(test => postgresTestMarker.test(readFileSync(join(repositoryRoot, test), "utf8")));
}

function nodeTestCommand(tests, repositoryRoot) {
  // Without this, a test that hangs (a missing await, a wait on a resource this
  // lane never provisions) runs until the job's 45-minute limit kills it, and
  // everything after it in this single-file TAP stream goes silent with it.
  // 180000 matches the existing test:attack-kit lane's bound for the same
  // node:test runner; a test that legitimately needs longer already overrides
  // it per-test (see tests/work-batch-assignment-gate.test.ts).
  const nodeArguments = ["--import", "tsx", "--test", "--test-concurrency=1", "--test-timeout=180000", "--test-reporter=tap", ...tests];
  if (testSources(tests, repositoryRoot).some(source => squawkTestMarker.test(source)))
    return ["npm", ["exec", "--yes", "--package=squawk-cli@2.61.0", "--", process.execPath, ...nodeArguments]];
  return [process.execPath, nodeArguments];
}

export function affectedTestCommands(result, tests, repositoryRoot = process.cwd()) {
  const sources = result === "ALL" ? [] : testSources(tests, repositoryRoot);
  const needsVpsBuild = result === "ALL" || sources.some(source => source.includes("dist-vps"));
  const needsDemoBuild = result === "ALL" || sources.some(source => source.includes("dist-contributor"));
  const preparation = [
    ...(needsVpsBuild ? [["pnpm", ["build"]]] : []),
    ...(needsDemoBuild ? [["pnpm", ["run", "build:demo"]]] : []),
  ];
  const exemptTests = tests.filter(test => skippedTestExemptions.has(test));
  const guardedTests = tests.filter(test => !skippedTestExemptions.has(test));
  const pgTests = postgresTests(result, guardedTests, repositoryRoot);
  const nonPgTests = guardedTests.filter(test => !pgTests.includes(test));
  return [...preparation,
    ...(nonPgTests.length > 0 ? [nodeTestCommand(nonPgTests, repositoryRoot)] : []),
    // Keep PostgreSQL tests in a dedicated TAP stream so they retain their
    // database environment without leaking it to ordinary tests.
    ...(pgTests.length > 0 ? [nodeTestCommand(pgTests, repositoryRoot)] : []),
    ...exemptTests.map(test => nodeTestCommand([test], repositoryRoot))];
}

export function requiresPostgres(result, tests, repositoryRoot = process.cwd()) {
  return postgresTests(result, tests, repositoryRoot).length > 0;
}

export function postgresBinariesAvailable(directory = process.env.PG_BIN ?? "/usr/lib/postgresql/17/bin") {
  return ["initdb", "pg_ctl", "postgres", "psql"].every(binary => existsSync(join(directory, binary)));
}

export function noTestsAffectedMessage() {
  return "No test files affected: documentation-only change; no tests run.";
}

// A change that genuinely touches everything (package.json, a lockfile, a CI
// workflow, ...) already gets full coverage from the path-routed lanes and
// full-gate — see docs/ci-budget-security-review.md and
// scripts/check-test-lane-coverage.mjs, which proves every test file is
// reachable from one of those lanes regardless of what this planner selects.
// Re-running the same hundreds of files here a second time, inside a 45-minute
// job, is pure duplicate cost with a hard cutoff. The absolute floor keeps
// this from firing on the small fixtures unit tests use, and the ratio keeps
// it meaningful as the real suite grows.
export const DEFER_MINIMUM_TEST_COUNT = 100;
export const DEFER_TEST_RATIO = 0.5;

export function shouldDeferToFullSuite(result, totalTestCount) {
  if (result === "ALL") return true;
  if (result === "DOCS_ONLY") return false;
  return result.length >= DEFER_MINIMUM_TEST_COUNT && result.length >= totalTestCount * DEFER_TEST_RATIO;
}

export function deferralMessage(result, selectedCount, totalTestCount) {
  const affected = result === "ALL" ? `all ${totalTestCount}` : `${selectedCount} of ${totalTestCount}`;
  return `This change affects ${affected} test file(s). The fast lane is skipping direct execution here: ` +
    "the full-suite lanes (test-demo, test-server, test-components, test-articles, full-gate) already run " +
    "the complete suite, so re-running it in this 45-minute lane would only duplicate that coverage.";
}

export function selectionOutputs(result, tests, repositoryRoot = process.cwd()) {
  const defer = shouldDeferToFullSuite(result, listTestFiles(repositoryRoot).length);
  return [
    `all=${result === "ALL"}`,
    `needs-pg=${!defer && requiresPostgres(result, tests, repositoryRoot)}`,
    `docs-only=${result === "DOCS_ONLY"}`,
    `defer-to-full-suite=${defer}`,
  ].join("\n");
}

export function runSelectedTests(result, tests, repositoryRoot = process.cwd(), execute = executeCommand,
  postgresAvailable = postgresBinariesAvailable, executeCapturingOutput = executeCommandCapturingOutput) {
  if (result === "DOCS_ONLY") {
    console.log(noTestsAffectedMessage());
    return 0;
  }
  const totalTestCount = listTestFiles(repositoryRoot).length;
  if (shouldDeferToFullSuite(result, totalTestCount)) {
    console.log(deferralMessage(result, tests.length, totalTestCount));
    return 0;
  }
  console.log(`Running ${tests.length} affected test file(s).`);
  return runAffectedTests(result, tests, repositoryRoot, execute, postgresAvailable, executeCapturingOutput);
}

function hasSkippedTests(output) {
  // A test can intentionally spawn a child TAP process to exercise this
  // detector. Only this command's final summary describes the lane result.
  const summaries = [...output.matchAll(/^#\s+(?:skipped|skip)\s+(\d+)\b/gmu)];
  return Number(summaries.at(-1)?.[1] ?? 0) > 0;
}

export function runAffectedTests(result, tests, repositoryRoot, execute = executeCommand,
  postgresAvailable = postgresBinariesAvailable, executeCapturingOutput = executeCommandCapturingOutput) {
  if (result === "DOCS_ONLY") return 0;
  if (requiresPostgres(result, tests, repositoryRoot) && !postgresAvailable()) {
    console.error("Selected test plan requires PostgreSQL 17 binaries, but PG_BIN does not contain initdb, pg_ctl, postgres, and psql.");
    return 1;
  }
  const guardedTests = tests.filter(test => !skippedTestExemptions.has(test));
  const pgTests = postgresTests(result, guardedTests, repositoryRoot);
  const testCommands = [
    ...(guardedTests.filter(test => !pgTests.includes(test)).length > 0
      ? [{ tests: guardedTests.filter(test => !pgTests.includes(test)), environment: withoutPostgresTestEnvironment(), exempt: false }] : []),
    ...(pgTests.length > 0 ? [{ tests: pgTests, environment: process.env, exempt: false }] : []),
    ...tests.filter(test => skippedTestExemptions.has(test)).map(test => ({ tests: [test], environment: withoutPostgresTestEnvironment(), exempt: true })),
  ];
  const commands = affectedTestCommands(result, tests, repositoryRoot);
  const preparationCount = commands.length - testCommands.length;
  for (const [index, [command, arguments_]] of commands.entries()) {
    if (index < preparationCount) {
      const status = execute(command, arguments_, repositoryRoot, withoutPostgresTestEnvironment());
      if (status !== 0) return status;
      continue;
    }
    const testCommand = testCommands[index - preparationCount];
    const execution = executeCapturingOutput(command, arguments_, repositoryRoot, testCommand.environment);
    const status = typeof execution === "number" ? execution : execution.status;
    if (status !== 0) return status;
    const output = typeof execution === "number" ? "" : execution.output;
    if (testCommand.exempt && hasSkippedTests(output)) {
      console.log(`Allowing skipped test exemption: ${testCommand.tests[0]} — ${skippedTestExemptions.get(testCommand.tests[0])}`);
    }
    if (!testCommand.exempt && hasSkippedTests(output)) {
      console.error("Selected test plan reported skipped tests; merge-gated tests must run or fail unless explicitly exempted.");
      return 1;
    }
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
  process.exitCode = runSelectedTests(result, tests, root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
