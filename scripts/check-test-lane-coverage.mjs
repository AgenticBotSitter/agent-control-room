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

// This deliberately supports only the workflow's known condition grammar.
// Unknown expressions cannot prove that a Darwin body can execute.
function macosCondition(condition, lane) {
  if (condition === undefined) return true;
  condition = condition.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/u, "$1");
  if (condition === "true" || condition === "!cancelled()" || condition === "always()") return true;
  if (condition === "runner.os == 'macOS'") return true;
  if (lane && condition === `matrix.lane == '${lane}'`) return true;
  if (lane && condition === `!cancelled() && matrix.lane == '${lane}' && needs.route.result == 'success' && needs.route.outputs.${lane} == 'false'`) return true;
  return /^!cancelled\(\) && \(needs\.route\.result != 'success' \|\| needs\.route\.outputs\.[a-z_-]+ != 'false'\)$/u.test(condition);
}

function provenMacosCommands(step) {
  return workflowCommands(step).flatMap(command => {
    // Do not interpret shell programs. Conditional blocks, functions, loops
    // and continuations need a dedicated proof before they can earn credit.
    // One-line tool-report loops contain no test command and earn no credit.
    if (/^\s*(?:if|elif|case|while|until|select|function)\b|^\s*\w+\s*\(\)\s*\{|\\\s*$/mu.test(command)
      || /^\s*for\b(?![^\n]*;\s*done\s*$)/mu.test(command)) return [];
    return command.split("\n").filter(line =>
      /^\s*(?:pnpm\s+(?:run\s+)?[a-z][a-z0-9:.-]*|node\s+scripts\/[a-zA-Z0-9_./-]+\.mjs)(?:\s+[^;&|<>`]*?)?(?:\s+\|\|\s+[a-z_]+\s*=\s*\$\?)?\s*$/u.test(line));
  });
}

// Credit individual steps, after proving both job and step conditions.
export function macosWorkflowCommands(source) {
  const commands = [];
  const jobs = source.split(/^  [a-zA-Z0-9_-]+:\s*$/m).slice(1);
  for (const job of jobs) {
    const jobCondition = /^    if:\s*(.+)$/m.exec(job)?.[1];
    if (!macosCondition(jobCondition)) continue;
    const steps = job.split(/^      - /m).slice(1);
    if (/^    runs-on: ['"]?macos-[a-zA-Z0-9.-]+['"]?\s*$/m.test(job)) {
      for (const step of steps) {
        const condition = /^(?:if:|        if:)\s*(.+)$/m.exec(step)?.[1];
        if (macosCondition(condition)) commands.push(...provenMacosCommands(step));
      }
      continue;
    }
    if (!/^    runs-on: \$\{\{ matrix\.runner \}\}\s*$/m.test(job)) continue;
    const macLanes = [...job.matchAll(/^          - lane: ([a-zA-Z0-9_-]+)\n            runner: macos-[a-zA-Z0-9.-]+\s*$/gm)]
      .map(match => match[1]);
    for (const step of steps) {
      const condition = /^(?:if:|        if:)\s*(.+)$/m.exec(step)?.[1];
      const lane = /matrix\.lane == '([a-zA-Z0-9_-]+)'/u.exec(condition ?? "")?.[1];
      if (lane && macLanes.includes(lane)) {
        if (macosCondition(condition, lane)) commands.push(...provenMacosCommands(step));
      }
    }
  }
  return commands;
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
  const macReached = reachableTests(scripts, macosWorkflowCommands(workflow));
  return listTestFiles(repositoryRoot).filter(file => {
    const source = readFileSync(join(repositoryRoot, file), "utf8");
    return !reached.has(file) || (needsMacosPostgres(source) && !macReached.has(file));
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
