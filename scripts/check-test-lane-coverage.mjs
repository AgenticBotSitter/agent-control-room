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

// These are the workflow's existing setup/diagnostic forms, not a shell parser.
// Keep them literal: broadening one can make later test commands unreachable.
const macosSetupLines = new Set([
  "set -euo pipefail",
  "updater_tmp=\"$(mktemp -d /private/tmp/acr-updater.XXXXXX)\"",
  "trap 'rm -rf -- \"${updater_tmp}\"' EXIT",
  "chgrp \"$(id -g)\" \"${updater_tmp}\"",
  "chmod 0700 \"${updater_tmp}\"",
  "export TMPDIR=\"${updater_tmp}\"",
  "sudo /usr/bin/xcode-select --switch /Library/Developer/CommandLineTools",
  "test -x /usr/bin/lockf",
  "for tool in strip otool; do t=\"$(xcrun -f \"$tool\")\"; echo \"== $t\"; file \"$t\"; xcrun otool -L \"$t\" | cat -vet | head -12; done",
  "pkgutil --pkg-info=com.apple.pkg.CLTools_Executables | grep version || true",
  "node --input-type=module -e 'import { resolveDeveloperTools } from \"./src/updater/v1/trusted-runtime.mjs\"; await resolveDeveloperTools();'",
  "short_root=\"${HOME}/acr\"",
  "rm -rf -- \"${short_root}\" && ditto \"${PWD}\" \"${short_root}\" && cd \"${short_root}\"",
  "darwin_pg_tmp=\"$(mktemp -d \"${HOME}/.acr-pg.XXXXXX\")\" || exit 1",
  "trap 'rm -rf -- \"${darwin_pg_tmp}\"' EXIT",
  "chgrp \"$(id -g)\" \"${darwin_pg_tmp}\" || exit 1",
  "chmod 0700 \"${darwin_pg_tmp}\" || exit 1",
  "export TMPDIR=\"${darwin_pg_tmp}\"",
  "export PG_BIN=/opt/homebrew/opt/postgresql@17/bin",
  "test -x /opt/homebrew/opt/postgresql@17/bin/pg_ctl",
  "brew install postgresql@17",
  "pnpm install --frozen-lockfile --ignore-scripts",
]);
const macosTestCommand = /^(?:(?:CI=true|(?:PG_BIN|TMPDIR)=[a-zA-Z0-9_./-]+|(?:LC_ALL|LANG)=[a-zA-Z0-9_.-]+|CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1)\s+)*(?:pnpm\s+(?:run\s+)?[a-z][a-z0-9:.-]*|node\s+scripts\/ci\/run-scripts-keep-going\.mjs\s+[a-z0-9:._ -]+|node\s+(?:scripts\/run-tests-with-quarantine\.mjs|--test)\s+[a-zA-Z0-9_=./ -]+)(?:\s+\|\|\s+darwin_pg_status=\$\?)?$/u;

function provenMacosCommands(step) {
  return workflowCommands(step).flatMap(command => {
    const lines = command.split("\n").map(line => line.trim())
      .filter(line => line && !line.startsWith("#"));
    let subshell = false, capturesStatus = false;
    for (const [index, line] of lines.entries()) {
      if (line === "(") {
        if (subshell) return [];
        subshell = true;
      } else if (line === ") || darwin_pg_status=$?") {
        if (!subshell || !capturesStatus) return [];
        subshell = false;
      } else if (line === "darwin_pg_status=0") {
        capturesStatus = true;
      } else if (line === 'exit "${darwin_pg_status}"') {
        // The existing aggregate exit is safe only at the end of the step.
        if (subshell || !capturesStatus || index !== lines.length - 1) return [];
      } else if (!macosSetupLines.has(line)
        && !/^(?:export\s+)?(?:CI=true|(?:PG_BIN|TMPDIR)=[a-zA-Z0-9_./-]+|(?:LC_ALL|LANG)=[a-zA-Z0-9_.-]+|CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1)$/u.test(line)
        && !/^cd\s+[a-zA-Z0-9_./-]+$/u.test(line)
        && !macosTestCommand.test(line)) {
        // Whole-step refusal: an unrecognized line can change whether any
        // later line executes (exit, heredoc, chains, functions, loops, etc.).
        return [];
      }
    }
    if (subshell) return [];
    return lines.filter(line => macosTestCommand.test(line));
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
