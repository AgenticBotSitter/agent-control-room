import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";
// Proves every test file is reachable from a command GitHub Actions actually runs.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseArguments } from "./ci/run-scripts-keep-going.mjs";

const testPattern = /\.test\.(?:ts|tsx|mjs|js)$/;
const packageScriptPattern = /(?:^|[\s;&|])pnpm\s+(?:run\s+)?([a-z][a-z0-9:.-]*)(?=$|[\s;&|])/g;
const testArgumentPattern = /(?:^|[\s"'=;&|])((?:\.\/)?tests\/[a-zA-Z0-9_./-]+\.test\.(?:ts|tsx|mjs|js))(?=$|[\s"';&|])/g;

function normalized(value) {
  return value.replace(/^\.\//, "").split(sep).join("/");
}

export function listTestFiles(repositoryRoot) {
  const root = join(repositoryRoot, "tests"), files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && testPattern.test(entry.name)) files.push(normalized(relative(repositoryRoot, path)));
    }
  };
  visit(root);
  return files.sort();
}

export function workflowCommands(source) {
  const lines = source.split(/\r?\n/), commands = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const indentation = match[1].length, value = match[2].trim();
    if (value !== "|" && value !== ">" && value !== "|-" && value !== ">-") {
      commands.push(value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"));
      continue;
    }
    const block = [];
    while (++index < lines.length) {
      const next = /^(\s*)(.*)$/.exec(lines[index]);
      if (!next || (next[2].trim() && next[1].length <= indentation)) { index--; break; }
      block.push(next[2]);
    }
    commands.push(block.join("\n"));
  }
  return commands;
}

function references(command) {
  const scripts = [...command.matchAll(packageScriptPattern)].map(match => match[1]);
  // The serial runner receives literal package names instead of pnpm commands.
  for (const match of command.matchAll(/(?:^|[\s;&|])node\s+scripts\/ci\/run-scripts-keep-going\.mjs\s+([^\n;&|]+)/gu)) {
    try { scripts.push(...parseArguments(match[1].trim().split(/\s+/u)).names); }
    catch { /* A runner invocation that refuses its arguments cannot cover tests. */ }
  }
  return scripts;
}

function testArguments(command) {
  return [...command.matchAll(testArgumentPattern)].map(match => normalized(match[1]));
}

export function reachableTests(scripts, commands) {
  const reached = new Set(), visited = new Set();
  const inspect = (command) => {
    for (const file of testArguments(command)) reached.add(file);
    for (const name of references(command)) {
      if (visited.has(name)) continue;
      visited.add(name);
      if (typeof scripts[name] === "string") inspect(scripts[name]);
    }
  };
  for (const command of commands) inspect(command);
  return reached;
}

// Fixed ticket inventory: adding another Darwin-only PostgreSQL file requires
// deliberately extending both this list and the literal workflow command.
const DARWIN_POSTGRES_FILES = [
  "tests/result-file-catalog-postgres.test.ts",
  "tests/result-file-download-postgres.test.ts",
  "tests/result-file-upload-race-postgres.test.ts",
  "tests/result-upload-store-postgres.test.ts",
  "tests/text-copy-derivation-postgres.test.ts",
];
const DARWIN_POSTGRES_COMMAND = "node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 tests/result-file-catalog-postgres.test.ts tests/result-file-download-postgres.test.ts tests/result-file-upload-race-postgres.test.ts tests/result-upload-store-postgres.test.ts tests/text-copy-derivation-postgres.test.ts";

function hasDarwinPostgresCommands(workflow) {
  // Inspect only the two named job blocks and compare entire command lines.
  // This is a text contract, not a claim to interpret arbitrary workflow shell.
  return ["test-updater", "full-gate"].every(job => {
    const block = workflow.split(new RegExp(`^  ${job}:\\s*$`, "mu"))[1]
      ?.split(/^  [a-zA-Z0-9_-]+:/mu)[0] ?? "";
    return block.split(/\r?\n/u).some(line => line.trim() === DARWIN_POSTGRES_COMMAND);
  });
}

export function needsMacosPostgres(source) {
  // Ignore prose and fixture-authored programs, retaining the platform literal.
  source = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gu,
    token => token === '"darwin"' || token === "'darwin'" ? token : " ");
  const postgres = /\b(?:withRealPostgres|requiresRealPostgres|PG_BIN|REAL_PG_BIN)\b/u.test(source);
  // Shared kernel/Seatbelt wrappers replace the database body on Linux with
  // a refusal proof. That refusal does not exercise the Darwin production path.
  const darwin = /process\.platform\s*(?:===|!==|==|!=)\s*['"]darwin['"](?!\s*\?)/u.test(source)
    || /['"]darwin['"]\s*(?:===|!==|==|!=)\s*process\.platform/u.test(source)
    || /\b(?:KERNEL_OPEN_LOCK_HOST_V1|kernelOpenLockTestV1|seatbeltTest)\b/u.test(source);
  return postgres && darwin;
}

export function findUncoveredTests(repositoryRoot = process.cwd()) {
  const scripts = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).scripts ?? {};
  const workflow = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const reached = reachableTests(scripts, workflowCommands(workflow));
  const darwinCommandsPresent = hasDarwinPostgresCommands(workflow);
  return listTestFiles(repositoryRoot).filter(file => {
    const source = readFileSync(join(repositoryRoot, file), "utf8");
    return !reached.has(file)
      || (needsMacosPostgres(source) && !DARWIN_POSTGRES_FILES.includes(file))
      || (DARWIN_POSTGRES_FILES.includes(file) && !darwinCommandsPresent);
  });
}

function main() {
  const tests = listTestFiles(process.cwd()), uncovered = findUncoveredTests();
  if (uncovered.length > 0) {
    console.error(`${uncovered.length} test file(s) lack required GitHub Actions execution (Darwin PostgreSQL needs macOS):`);
    for (const file of uncovered) console.error(`  ${file}`);
    console.error("\nAdd each test to a workflow-reachable lane. An unused package script is not coverage.");
    process.exitCode = 1;
    return;
  }
  console.log(`all ${tests.length} test files have required GitHub Actions execution (including macOS PostgreSQL)`);
}

if (isMainModuleV1(process.argv[1], import.meta.url)) main();
