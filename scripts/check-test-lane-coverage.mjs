import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";
// Proves every test file is reachable from a command GitHub Actions actually runs.
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseArguments } from "./ci/run-scripts-keep-going.mjs";

// js-yaml is the workflow parser supplied by the existing ESLint dependency.
const require = createRequire(import.meta.url);
const { load: loadYaml } = require("js-yaml");

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

// Fixed ticket inventory: each Darwin-only PostgreSQL file requires its
// literal command line in both named macOS updater jobs.
const DARWIN_POSTGRES_COMMAND = "node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 tests/result-file-catalog-postgres.test.ts tests/result-file-download-postgres.test.ts tests/result-file-upload-race-postgres.test.ts tests/result-upload-store-postgres.test.ts tests/text-copy-derivation-postgres.test.ts";
const DARWIN_LEGACY_COMMAND = "node scripts/ci/run-scripts-keep-going.mjs test:updater test:updater-schema test:updater-passkey-postgres test:pg-runtime-postgres test:pg-runtime-stress test:test-runner || darwin_pg_status=$?";
const DARWIN_POSTGRES_FILES = {
  "tests/result-file-catalog-postgres.test.ts": DARWIN_POSTGRES_COMMAND,
  "tests/result-file-download-postgres.test.ts": DARWIN_POSTGRES_COMMAND,
  "tests/result-file-upload-race-postgres.test.ts": DARWIN_POSTGRES_COMMAND,
  "tests/result-upload-store-postgres.test.ts": DARWIN_POSTGRES_COMMAND,
  "tests/text-copy-derivation-postgres.test.ts": DARWIN_POSTGRES_COMMAND,
  "tests/pg-runtime-copy-stress.test.ts": DARWIN_LEGACY_COMMAND,
  "tests/test-runner-service.test.mjs": DARWIN_LEGACY_COMMAND,
};

// Literal snapshot of the executing/aggregating steps. Future legitimate edits
// must deliberately update these pins, rather than weakening the checker.
const DARWIN_JOB_PINS = {
  "test-updater": {
    "if": "${{ !cancelled() && (needs.route.result != 'success' || needs.route.outputs.updater != 'false') }}",
    "runs-on": "macos-26",
    "env": {
      "CONTROL_ROOM_TEST_BLOCK_AGENT_CLI": "1",
      "LC_ALL": "C",
      "LANG": "C"
    },
    "defaults": null,
    "strategy": null,
    "index": 7,
    "step": {
      "name": "Updater lane",
      "run": "set -euo pipefail\n# BSD children inherit the containing directory's group. Use the\n# test login's primary group, not the shared temporary directory's.\nupdater_tmp=\"$(mktemp -d /private/tmp/acr-updater.XXXXXX)\"\ntrap 'rm -rf -- \"${updater_tmp}\"' EXIT\nchgrp \"$(id -g)\" \"${updater_tmp}\"\nchmod 0700 \"${updater_tmp}\"\nexport TMPDIR=\"${updater_tmp}\"\n# The full Xcode image can have writable ancestors. The installed\n# Command Line Tools use the root-owned path this lane verifies.\nsudo /usr/bin/xcode-select --switch /Library/Developer/CommandLineTools\ntest -x /usr/bin/lockf\nfor tool in strip otool; do t=\"$(xcrun -f \"$tool\")\"; echo \"== $t\"; file \"$t\"; xcrun otool -L \"$t\" | cat -vet | head -12; done\npkgutil --pkg-info=com.apple.pkg.CLTools_Executables | grep version || true\nnode --input-type=module -e 'import { resolveDeveloperTools } from \"./src/updater/v1/trusted-runtime.mjs\"; await resolveDeveloperTools();'\n# The guard's control socket lives under the worktree's .test-tmp and\n# macOS caps a socket path at 104 bytes; the hosted checkout path is\n# far longer than a developer's, so run the lane from a short copy.\nshort_root=\"${HOME}/acr\"\nrm -rf -- \"${short_root}\" && ditto \"${PWD}\" \"${short_root}\" && cd \"${short_root}\"\n# Linux exercises refusal only; these bodies need macOS kernel locks.\n# Use a separate short private root without a writable shared ancestor.\ndarwin_pg_status=0\n(\n  darwin_pg_tmp=\"$(mktemp -d \"${HOME}/.acr-pg.XXXXXX\")\" || exit 1\n  trap 'rm -rf -- \"${darwin_pg_tmp}\"' EXIT\n  chgrp \"$(id -g)\" \"${darwin_pg_tmp}\" || exit 1\n  chmod 0700 \"${darwin_pg_tmp}\" || exit 1\n  export TMPDIR=\"${darwin_pg_tmp}\"\n  export PG_BIN=/opt/homebrew/opt/postgresql@17/bin\n  node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 tests/result-file-catalog-postgres.test.ts tests/result-file-download-postgres.test.ts tests/result-file-upload-race-postgres.test.ts tests/result-upload-store-postgres.test.ts tests/text-copy-derivation-postgres.test.ts\n) || darwin_pg_status=$?\nnode scripts/ci/run-scripts-keep-going.mjs test:updater test:updater-schema test:updater-passkey-postgres test:pg-runtime-postgres test:pg-runtime-stress test:test-runner || darwin_pg_status=$?\nexit \"${darwin_pg_status}\"\n"
    }
  },
  "full-gate": {
    "if": "${{ !cancelled() }}",
    "runs-on": "${{ matrix.runner }}",
    "env": null,
    "defaults": null,
    "strategy": {
      "fail-fast": false,
      "matrix": {
        "include": [
          {
            "lane": "demo",
            "runner": "ubuntu-latest",
            "timeout": 25
          },
          {
            "lane": "server",
            "runner": "ubuntu-latest",
            "timeout": 30
          },
          {
            "lane": "components",
            "runner": "ubuntu-latest",
            "timeout": 180
          },
          {
            "lane": "updater",
            "runner": "macos-26",
            "timeout": 45
          },
          {
            "lane": "articles",
            "runner": "ubuntu-latest",
            "timeout": 25
          }
        ]
      }
    },
    "index": 9,
    "step": {
      "name": "Updater lane (merge gate)",
      "if": "${{ !cancelled() && matrix.lane == 'updater' && needs.route.result == 'success' && needs.route.outputs.updater == 'false' }}",
      "env": {
        "CONTROL_ROOM_TEST_BLOCK_AGENT_CLI": "1",
        "LC_ALL": "C",
        "LANG": "C",
        "HOMEBREW_NO_AUTO_UPDATE": "1"
      },
      "run": "set -euo pipefail\npnpm install --frozen-lockfile --ignore-scripts\n# The PostgreSQL-backed updater tests run here too (see test-updater).\nbrew install postgresql@17\ntest -x /opt/homebrew/opt/postgresql@17/bin/pg_ctl\n# BSD children inherit the containing directory's group. Use the\n# test login's primary group, not the shared temporary directory's.\nupdater_tmp=\"$(mktemp -d /private/tmp/acr-updater.XXXXXX)\"\ntrap 'rm -rf -- \"${updater_tmp}\"' EXIT\nchgrp \"$(id -g)\" \"${updater_tmp}\"\nchmod 0700 \"${updater_tmp}\"\nexport TMPDIR=\"${updater_tmp}\"\n# The full Xcode image can have writable ancestors. The installed\n# Command Line Tools use the root-owned path this lane verifies.\nsudo /usr/bin/xcode-select --switch /Library/Developer/CommandLineTools\ntest -x /usr/bin/lockf\nfor tool in strip otool; do t=\"$(xcrun -f \"$tool\")\"; echo \"== $t\"; file \"$t\"; xcrun otool -L \"$t\" | cat -vet | head -12; done\npkgutil --pkg-info=com.apple.pkg.CLTools_Executables | grep version || true\nnode --input-type=module -e 'import { resolveDeveloperTools } from \"./src/updater/v1/trusted-runtime.mjs\"; await resolveDeveloperTools();'\n# The guard's control socket lives under the worktree's .test-tmp and\n# macOS caps a socket path at 104 bytes; the hosted checkout path is\n# far longer than a developer's, so run the lane from a short copy.\nshort_root=\"${HOME}/acr\"\nrm -rf -- \"${short_root}\" && ditto \"${PWD}\" \"${short_root}\" && cd \"${short_root}\"\n# Linux exercises refusal only; these bodies need macOS kernel locks.\n# Use a separate short private root without a writable shared ancestor.\ndarwin_pg_status=0\n(\n  darwin_pg_tmp=\"$(mktemp -d \"${HOME}/.acr-pg.XXXXXX\")\" || exit 1\n  trap 'rm -rf -- \"${darwin_pg_tmp}\"' EXIT\n  chgrp \"$(id -g)\" \"${darwin_pg_tmp}\" || exit 1\n  chmod 0700 \"${darwin_pg_tmp}\" || exit 1\n  export TMPDIR=\"${darwin_pg_tmp}\"\n  export PG_BIN=/opt/homebrew/opt/postgresql@17/bin\n  node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 tests/result-file-catalog-postgres.test.ts tests/result-file-download-postgres.test.ts tests/result-file-upload-race-postgres.test.ts tests/result-upload-store-postgres.test.ts tests/text-copy-derivation-postgres.test.ts\n) || darwin_pg_status=$?\nnode scripts/ci/run-scripts-keep-going.mjs test:updater test:updater-schema test:updater-passkey-postgres test:pg-runtime-postgres test:pg-runtime-stress test:test-runner || darwin_pg_status=$?\nexit \"${darwin_pg_status}\"\n"
    }
  }
};

export function darwinWorkflowViolations(workflow) {
  const errors = [];
  const fail = (job, step, field) => errors.push(
    `${job}: step ${step}, field ${field} differs from the pinned literal. A legitimate future edit to these steps must update the pinned literal in the checker.`);
  let document;
  try { document = loadYaml(workflow); }
  catch { fail("workflow", "YAML", "parse"); return errors; }
  for (const jobName of ["test-updater", "full-gate"]) {
    const pin = DARWIN_JOB_PINS[jobName];
    const job = document?.jobs?.[jobName];
    if (!job || typeof job !== "object") { fail(jobName, pin.step.name, "job lookup"); continue; }
    for (const field of ["if", "runs-on", "env", "defaults", "strategy"]) {
      if (!isDeepStrictEqual(job[field] ?? null, pin[field])) fail(jobName, pin.step.name, field);
    }
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const matches = steps.filter(step => step?.name === pin.step.name);
    if (matches.length !== 1) { fail(jobName, pin.step.name, "step count"); continue; }
    if (steps[pin.index] !== matches[0]) fail(jobName, pin.step.name, "step position");
    const step = matches[0];
    for (const field of new Set(["name", "if", "shell", "working-directory", "env", "run", ...Object.keys(step), ...Object.keys(pin.step)])) {
      if (!isDeepStrictEqual(step[field], pin.step[field])) fail(jobName, pin.step.name, field);
    }
  }
  return errors;
}

function hasDarwinPostgresCommands(workflow, requiredCommand) {
  return darwinWorkflowViolations(workflow).length === 0;
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
  const commandsPresent = new Map(Object.values(DARWIN_POSTGRES_FILES)
    .map(command => [command, hasDarwinPostgresCommands(workflow, command)]));
  return listTestFiles(repositoryRoot).filter(file => {
    const source = readFileSync(join(repositoryRoot, file), "utf8");
    return !reached.has(file)
      || (needsMacosPostgres(source) && !Object.hasOwn(DARWIN_POSTGRES_FILES, file))
      || (Object.hasOwn(DARWIN_POSTGRES_FILES, file) && !commandsPresent.get(DARWIN_POSTGRES_FILES[file]));
  });
}

function main() {
  const violations = darwinWorkflowViolations(readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8"));
  if (violations.length) { for (const error of violations) console.error(error); process.exitCode = 1; }
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
