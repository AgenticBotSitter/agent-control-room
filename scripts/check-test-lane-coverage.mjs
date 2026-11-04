import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";
// Proves every test file is reachable from a command GitHub Actions actually runs.
import assert from "node:assert/strict";
import ts from "typescript";
import { createRequire } from "node:module";
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
  "mutation-checks-lineage": { bound: 50, lanes: [
    [loop + "lineage-mutations", 12], [loop + "bridge-mutations", 17],
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
// This independent contract prevents a workflow-only timeout increase from
// leaving the actual parent capped at 550s. Parse executable TS, not comments.
export function assertMutationLaneCoverage(scripts, source, bridgeSource = readFileSync(
  new URL("../tests/improve-control-room-loop-bridge-mutations.test.ts", import.meta.url), "utf8")) {
  const bridgeCommand = scripts[loop + "bridge-mutations"];
  assert.equal(typeof bridgeCommand, "string");
  assert.deepEqual([...bridgeCommand.matchAll(/(?:^|\s)--test-timeout=(\d+)(?=\s|$)/gu)].map(match => Number(match[1])),
    [960000], "bridge: retain the 960s runner budget, including cleanup headroom");
  const program = ts.createSourceFile("bridge-mutations.test.ts", bridgeSource, ts.ScriptTarget.Latest, true);
  const parents = program.statements.filter(statement => ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression) && ts.isIdentifier(statement.expression.expression)
    && statement.expression.expression.text === "test"
    && statement.expression.arguments.length > 0
    && ts.isStringLiteral(statement.expression.arguments[0])
    && statement.expression.arguments[0].text === "B1b guard-off proofs with restored green checks");
  assert.equal(parents.length, 1, "bridge: exactly one measured parent required");
  const options = parents[0].expression.arguments[1];
  assert.ok(options && ts.isObjectLiteralExpression(options), "bridge: literal parent options required");
  const timeouts = options.properties.filter(property => ts.isPropertyAssignment(property)
    && property.name.getText(program) === "timeout");
  assert.equal(timeouts.length, 1, "bridge: exactly one parent timeout required");
  assert.ok(ts.isNumericLiteral(timeouts[0].initializer), "bridge: literal parent timeout required");
  assert.equal(Number(timeouts[0].initializer.text), 900000, "bridge: retain the measured 900s parent budget");
  const require = createRequire(import.meta.resolve("eslint"));
  const jobs = typeof source === "string" ? require("js-yaml").load(source).jobs : source;
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
