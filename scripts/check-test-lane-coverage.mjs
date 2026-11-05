import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";
// Proves every test file is reachable from a command GitHub Actions actually runs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseArguments } from "./ci/run-scripts-keep-going.mjs";

export const b8ExternalHostInventoryV1 = Object.freeze([
  "T-TOOLS::test_a2_lineup.py", "T-TOOLS::test_a2_settings.py", "T-TOOLS::test_a2_bridge.py", "T-TOOLS::test_a2_inputs.py",
  "T-TOOLS::test_a2_confirm.py", "T-TOOLS::test_a2_intake_launch.py", "T-TOOLS::test_a2_finalize.py", "T-TOOLS::test_a2_recovery.py",
  "T-TOOLS::test_a2_orchestrator.py", "T-TOOLS::test_a2_route.py", "T-TOOLS::test_b8_selection.py", "T-TOOLS::mutate_a2.py all",
  "T-TOOLS::bridge/test_contract.mjs", "tests/loop-policy.test.ts::P71 real settings check",
  "tests/loop-selection-native.test.ts::U81 real selection check",
]);
export const b8HostOnlyFileV1 = "tests/loop-selection-native.test.ts";
export const b8MixedFileV1 = "tests/loop-policy.test.ts";
export const b8P71SkipV1 = "--test-skip-pattern=^P71 real settings check$";
export const b8HostGateCommandV1 = "node scripts/check-loop-selection-host-gate.mjs";
export function b8ExternalHostDiagnosticsV1(log = console.log) {
  for (const entry of b8ExternalHostInventoryV1) log(`REQUIRED EXTERNAL HOST: ${entry}; gate=macOS; executed-in-linux=false`);
  log(`REQUIRED EXTERNAL HOST: ${b8MixedFileV1}; exclusion=${b8P71SkipV1}`);
  log(`REQUIRED EXTERNAL HOST: ${b8HostOnlyFileV1}; exclusion=file`);
}
export function validateB8ExternalHostTitlesV1(root) {
  const literalTitles = file => [...readFileSync(join(root, file), "utf8").matchAll(/^test\((['"])([^'"\r\n]+)\1\s*,/gm)].map(m => m[2]);
  for (const [file, title, only] of [[b8MixedFileV1, "P71 real settings check", false], [b8HostOnlyFileV1, "U81 real selection check", true]]) {
    const titles = literalTitles(file);
    if (titles.filter(t => t === title).length !== 1 || only && titles.length !== 1) throw Error("invalid external host title: " + file);
  }
  const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (scripts["test:loop-selection:host"] !== b8HostGateCommandV1) throw Error("missing mandatory macOS host gate");
  for (const [name, body] of Object.entries(scripts)) {
    if (["test:loop-policy:real", "test:loop-selection:real"].includes(name)) continue;
    if (body.includes(b8HostOnlyFileV1)) throw Error("host-only file in Linux lane: " + name);
    if (testArguments(body).includes(b8MixedFileV1) && !body.includes("--test-skip-pattern='^P71 real settings check$'"))
      throw Error("invalid mixed-file host exclusion: " + name);
  }
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  for (const command of workflowCommands(workflow)) {
    if (command.includes(b8HostOnlyFileV1) || testArguments(command).includes(b8MixedFileV1) && !command.includes("--test-skip-pattern='^P71 real settings check$'"))
      throw Error("invalid workflow external host exclusion");
  }
}

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

export function findUncoveredTests(repositoryRoot = process.cwd()) {
  const scripts = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).scripts ?? {};
  const workflow = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const reached = reachableTests(scripts, workflowCommands(workflow));
  if (existsSync(join(repositoryRoot, b8HostOnlyFileV1))) validateB8ExternalHostTitlesV1(repositoryRoot);
  return listTestFiles(repositoryRoot).filter(file => file !== b8HostOnlyFileV1 && !reached.has(file));
}

function main() {
  b8ExternalHostDiagnosticsV1();
  const tests = listTestFiles(process.cwd()), uncovered = findUncoveredTests();
  if (uncovered.length > 0) {
    console.error(`${uncovered.length} test file(s) are not reachable from GitHub Actions:`);
    for (const file of uncovered) console.error(`  ${file}`);
    console.error("\nAdd each test to a workflow-reachable lane. An unused package script is not coverage.");
    process.exitCode = 1;
    return;
  }
  console.log(`all ${tests.length} test files are reachable from GitHub Actions`);
}

if (isMainModuleV1(process.argv[1], import.meta.url)) main();
