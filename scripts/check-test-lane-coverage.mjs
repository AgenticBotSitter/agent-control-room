import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";
// Proves every test file is reachable from a command GitHub Actions actually runs.
import assert from "node:assert/strict";
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

export function findUncoveredTests(repositoryRoot = process.cwd()) {
  const scripts = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).scripts ?? {};
  const workflow = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const reached = reachableTests(scripts, workflowCommands(workflow));
  return listTestFiles(repositoryRoot).filter(file => !reached.has(file));
}

// One shared shape for all six workflow guards: ordered lanes and explicit bounds.
const loop = "test:improve-control-room-loop-";
const website = "test:improve-control-room-first-website-mutations";
export const mutationLaneShape = {
  "mutation-checks-lineage": { bound: 45, lanes: [
    [loop + "lineage-mutations", 12], [loop + "bridge-mutations", 10],
    [loop + "ui-mutations", 5], [loop + "attention-mutations", 10],
  ] },
  "mutation-checks-candidate": { bound: 45, lanes: [
    [loop + "recovery-mutations", 5], [loop + "monitoring-mutations", 5], [loop + "monitoring-load", 3],
    ...["source", "ui", "sql-consumption", "sql-decision-immutability", "sql-binding", "sql-checks",
      "sql-authority", "sql-candidate-immutability", "sql-grants"].map(part => [`${loop}candidate-mutations:${part}`, 5]),
  ] },
  "mutation-checks": { bound: 45, lanes: [
    [loop + "finalization-mutations", 5], [loop + "finalization-load", 3],
    [website + ":part-1", 5], [website + ":part-2", 5],
  ] },
};

// Like workflowCommands, read the checked-in indentation directly so the early
// CI guards need no installed packages. Only the mutation jobs and merge gate
// use this mapping/sequence/scalar subset; reject unsupported syntax there.
export function mutationWorkflowJobs(source) {
  const jobs = {}, lines = source.split(/\r?\n/u);
  function scalar(value) {
    value = value.replace(/\s+#.*$/u, "").trim();
    if (value.startsWith('"')) return JSON.parse(value);
    if (value.startsWith("'")) {
      assert.match(value, /^'(?:[^']|'')*'$/u);
      return value.slice(1, -1).replaceAll("''", "'");
    }
    if (value.startsWith("[")) {
      assert.match(value, /^\[[a-zA-Z0-9_, -]*\]$/u);
      return value.slice(1, -1).split(",").map(item => item.trim()).filter(Boolean);
    }
    if (value === "true" || value === "false") return value === "true";
    if (/^\d+$/u.test(value)) return Number(value);
    assert.ok(value && !/^[&*!{}|>]/u.test(value), `unsupported workflow scalar: ${value}`);
    return value;
  }
  for (let index = 0; index < lines.length; index++) {
    const header = /^  ([a-zA-Z0-9_-]+):\s*(?:#.*)?$/u.exec(lines[index]);
    if (!header || !/^(?:mutation-checks(?:-|$)|merge-gate$)/u.test(header[1])) continue;
    const key = header[1];
    assert.ok(!Object.hasOwn(jobs, key), `duplicate workflow job: ${key}`);
    const job = jobs[key] = {}, stack = [{ indent: 2, value: job }];
    while (++index < lines.length) {
      const line = lines[index];
      if (!line.trim() || /^\s*#/u.test(line)) continue;
      const indent = /^ */u.exec(line)[0].length;
      if (indent <= 2) { index--; break; }
      while (stack.at(-1).indent >= indent) stack.pop();
      let parent = stack.at(-1).value, text = line.slice(indent), mappingIndent = indent;
      if (text.startsWith("- ")) {
        assert.ok(Array.isArray(parent), "workflow sequence requires a list");
        const step = {}; parent.push(step); parent = step;
        stack.push({ indent, value: step });
        text = text.slice(2);
        mappingIndent += 2;
      }
      const entry = /^([a-zA-Z0-9_-]+):(?:\s+(.*))?$/u.exec(text);
      assert.ok(entry, `unsupported workflow entry: ${text}`);
      const [, name, raw = ""] = entry;
      assert.ok(!Object.hasOwn(parent, name), `duplicate workflow key: ${name}`);
      if (/^\|-?$/u.test(raw)) {
        const block = [];
        while (index + 1 < lines.length && (!lines[index + 1].trim() || /^ */u.exec(lines[index + 1])[0].length > mappingIndent)) {
          block.push(lines[++index]);
        }
        while (block.length && !block.at(-1).trim()) block.pop();
        const padding = block.find(value => value.trim())?.match(/^ */u)[0].length ?? 0;
        assert.ok(block.every(value => !value.trim() || value.startsWith(" ".repeat(padding))), "inconsistent workflow block indentation");
        parent[name] = block.map(value => value.slice(padding)).join("\n") + (raw === "|-" ? "" : "\n");
      } else if (!raw || raw.startsWith("#")) {
        parent[name] = name === "steps" ? [] : {};
        stack.push({ indent: mappingIndent, value: parent[name] });
      } else parent[name] = scalar(raw);
    }
  }
  return jobs;
}

export function assertMutationLaneCoverage(scripts, source) {
  const jobs = typeof source === "string" ? mutationWorkflowJobs(source) : source;
  const expected = mutationLaneShape;
  assert.deepEqual(Object.keys(jobs).filter(key => /^mutation-checks(?:-|$)/u.test(key)).sort(), Object.keys(expected).sort());
  for (const [key, { bound, lanes }] of Object.entries(expected)) {
    const job = jobs[key];
    assert.equal(job["timeout-minutes"], bound, `${key}: retain the job bound`);
    assert.equal(job["continue-on-error"], undefined);
    assert.equal(job.strategy, undefined);
    assert.equal(job.if, key === "mutation-checks" ? "${{ always() }}" : undefined);
    if (key !== "mutation-checks") assert.equal(job.needs, undefined);
    assert.equal(job.env.PG_BIN, "/usr/lib/postgresql/17/bin");
    assert.ok(job.steps.some(step => step.run === "pnpm install --frozen-lockfile --ignore-scripts"));
    assert.ok(job.steps.some(step => step.name === "Install PostgreSQL 17 from PGDG"));
    for (const step of job.steps) {
      assert.equal(step.if, undefined, `${key}: ${step.name ?? step.uses} must be unconditional`);
      assert.equal(step["continue-on-error"], step.run === `pnpm run ${loop}lineage-mutations` ? true : undefined);
    }
    const checks = job.steps.filter(step => /^pnpm run test:/u.test(step.run ?? ""));
    assert.deepEqual(checks.map(step => step.run), lanes.map(([name]) => `pnpm run ${name}`), `${key}: every suite/partition exactly once`);
    for (const [index, step] of checks.entries()) {
      const [name, stepBound] = lanes[index];
      assert.equal(typeof scripts[name], "string", `${name}: executable package lane required`);
      assert.match(scripts[name], /node scripts\/run-tests-with-quarantine\.mjs .*--test/u);
      assert.equal(step["timeout-minutes"], stepBound, `${name}: retain the step bound`);
      if (name.includes("candidate-mutations:") || name.startsWith(website + ":")) assert.match(scripts[name], /--test-name-pattern=/u);
    }
  }
  const final = jobs["mutation-checks"];
  assert.deepEqual(final.needs, ["mutation-checks-lineage", "mutation-checks-candidate"]);
  const aggregation = final.steps.at(-1);
  assert.deepEqual(aggregation.env, {
    LINEAGE_RESULT: "${{ needs.mutation-checks-lineage.result }}",
    CANDIDATE_RESULT: "${{ needs.mutation-checks-candidate.result }}",
  });
  assert.equal(aggregation.run, 'test "$LINEAGE_RESULT" = success\ntest "$CANDIDATE_RESULT" = success\n');
  const commands = Object.keys(expected).flatMap(key => jobs[key].steps.map(step => step.run ?? ""));
  assert.equal(commands.filter(command => command === "node scripts/ci/verify-mutation-checks.mjs --anchors-only").length, 1);
  assert.equal(commands.filter(command => command.includes('node scripts/ci/verify-mutation-checks.mjs "$manifest"')).length, 1);
  for (const part of [1, 2]) {
    assert.ok(scripts[`${website}:part-${part}`].includes(`--test-name-pattern="^B5 verifier guard mutations partition ${part} "`));
  }
  return Object.fromEntries(Object.keys(expected).map(key => [key, jobs[key]]));
}

function main() {
  assertMutationLaneCoverage(JSON.parse(readFileSync("package.json", "utf8")).scripts,
    readFileSync(".github/workflows/ci.yml", "utf8"));
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
