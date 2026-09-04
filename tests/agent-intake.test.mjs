import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const validator = path.join(root, "scripts/validate-agent-intake.mjs");
const base = "1".repeat(40);
const head = "2".repeat(40);

function documents(overrides = {}) {
  const capsule = {
    schema: "control-room.agent-build-capsule/v2",
    capsuleId: "CR5D-PILOT-001",
    waveId: "CR5D-PILOT",
    block: "CR-5D",
    summary: "Add one frozen fixture",
    platform: "any",
    status: "ready",
    mode: "standard-work",
    taskClass: "T0-mechanical",
    risk: "low",
    baseCommit: base,
    integrationBranch: "integration/cr5d-pilot",
    eligibleRoutes: ["marvin-hermes-provisional"],
    routeClaimants: { "marvin-hermes-provisional": ["MarvinAi5"] },
    dependencies: [],
    requiredTools: ["node >=22.13.0"],
    maxConcurrentClaimsPerRoute: 3,
    verification: { required: true, independence: "route" },
    objective: "Add one frozen fixture.",
    contractRefs: ["docs/CR3_BUILD_PLAN.md"],
    allowedPaths: ["tests/fixtures/example.json"],
    forbiddenPrefixes: ["db/migrations", "src/security"],
    acceptanceCommands: ["node --test tests/example.test.mjs"],
    semanticAcceptance: ["Fixture follows the accepted contract."],
    limits: { maxChangedFiles: 1, maxChangedLines: 20, maxRepairIterations: 1 },
    effects: { level: "none", maxCount: 0 },
    stopConditions: ["Stop if the accepted contract is ambiguous."],
    resultManifestPath: "coordination/agent-build/results/CR5D-PILOT-001.json",
    ...overrides.capsule
  };
  const result = {
    schema: "control-room.agent-build-result/v2",
    capsulePath: "coordination/agent-build/capsules/CR5D-PILOT-001.json",
    capsuleId: capsule.capsuleId,
    waveId: capsule.waveId,
    baseCommit: capsule.baseCommit,
    implementationCommit: head,
    producerRoute: capsule.eligibleRoutes[0],
    changedFiles: [{ path: "tests/fixtures/example.json", additions: 5, deletions: 0 }],
    commands: [{ command: "node --test tests/example.test.mjs", exitCode: 0 }],
    repairIterations: 0,
    failures: [],
    assumptions: [],
    effectCount: 0,
    safety: { secretsAbsent: true, privateHostDataAbsent: true, workerDidNotApproveOrMerge: true, scopeNotExpanded: true },
    disposition: "ready-for-intake",
    ...overrides.result
  };
  return { capsule, result };
}

function run(overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "control-room-intake-"));
  const capsulePath = path.join(directory, "coordination/agent-build/capsules/CR5D-PILOT-001.json");
  const resultPath = path.join(directory, "coordination/agent-build/results/CR5D-PILOT-001.json");
  const { capsule, result } = documents(overrides);
  mkdirSync(path.dirname(capsulePath), { recursive: true });
  mkdirSync(path.dirname(resultPath), { recursive: true });
  writeFileSync(capsulePath, JSON.stringify(capsule));
  writeFileSync(resultPath, JSON.stringify(result));
  const completed = spawnSync(process.execPath, [validator, "--capsule", capsulePath, "--result", resultPath], { encoding: "utf8" });
  return { completed, report: JSON.parse(completed.stdout) };
}

function git(directory, ...args) {
  const completed = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(completed.status, 0, completed.stderr);
  return completed.stdout.trim();
}

test("eligible result passes structural intake", () => {
  const { completed, report } = run();
  assert.equal(completed.status, 0);
  assert.equal(report.disposition, "eligible");
  assert.deepEqual(report.errors, []);
});

test("draft capsule cannot pass ordinary result intake", () => {
  const { completed, report } = run({ capsule: { status: "draft" } });
  assert.equal(completed.status, 1);
  assert.equal(report.disposition, "quarantined");
  assert.ok(report.errors.includes("capsule_not_claimable"));
});

test("scope expansion is quarantined", () => {
  const { completed, report } = run({ result: { changedFiles: [{ path: "src/security/escape.ts", additions: 1, deletions: 0 }] } });
  assert.equal(completed.status, 1);
  assert.equal(report.disposition, "quarantined");
  assert.ok(report.errors.includes("changed_files_outside_capsule"));
});

test("failed acceptance command is quarantined", () => {
  const { completed, report } = run({ result: { commands: [{ command: "node --test tests/example.test.mjs", exitCode: 1 }], failures: ["fixture test failed"] } });
  assert.equal(completed.status, 1);
  assert.ok(report.errors.includes("acceptance_command_failed:node --test tests/example.test.mjs"));
});

test("required verification must declare an independence boundary", () => {
  const { completed, report } = run({ capsule: { verification: { required: true, independence: "none" } } });
  assert.equal(completed.status, 1);
  assert.ok(report.errors.includes("required_verification_not_independent"));
});

test("an ineligible producer route is quarantined", () => {
  const { completed, report } = run({ result: { producerRoute: "ziggy-windows" } });
  assert.equal(completed.status, 1);
  assert.ok(report.errors.includes("producer_route_ineligible"));
});

test("ready capsule can be validated before a jobber is published", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "control-room-capsule-"));
  const capsulePath = path.join(directory, "capsule.json");
  const { capsule } = documents();
  writeFileSync(capsulePath, JSON.stringify(capsule));
  const completed = spawnSync(process.execPath, [validator, "--mode", "capsule", "--capsule", capsulePath], { encoding: "utf8" });
  const report = JSON.parse(completed.stdout);
  assert.equal(completed.status, 0);
  assert.equal(report.disposition, "claimable");
});

test("capsule claimant map must exactly cover eligible routes", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "control-room-capsule-"));
  const capsulePath = path.join(directory, "capsule.json");
  const { capsule } = documents({ capsule: { eligibleRoutes: ["marvin-hermes-provisional", "ziggy-windows"] } });
  writeFileSync(capsulePath, JSON.stringify(capsule));
  const completed = spawnSync(process.execPath, [validator, "--mode", "capsule", "--capsule", capsulePath], { encoding: "utf8" });
  const report = JSON.parse(completed.stdout);
  assert.equal(completed.status, 1);
  assert.ok(report.errors.includes("route_claimants_mismatch"));
});

test("git intake reconstructs isolated implementation and metadata commits", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "control-room-intake-git-"));
  git(directory, "init", "-b", "integration/cr5d-pilot");
  git(directory, "config", "user.email", "intake@example.test");
  git(directory, "config", "user.name", "Intake Test");
  mkdirSync(path.join(directory, "docs"), { recursive: true });
  writeFileSync(path.join(directory, "docs/contract.md"), "frozen contract\n");
  git(directory, "add", ".");
  git(directory, "commit", "-m", "product base");
  const productBase = git(directory, "rev-parse", "HEAD");

  const capsulePath = "coordination/agent-build/capsules/CR5D-PILOT-001.json";
  const resultPath = "coordination/agent-build/results/CR5D-PILOT-001.json";
  const { capsule, result } = documents({ capsule: { baseCommit: productBase } });
  result.baseCommit = productBase;
  result.changedFiles = [{ path: "tests/fixtures/example.json", additions: 1, deletions: 0 }];
  mkdirSync(path.join(directory, path.dirname(capsulePath)), { recursive: true });
  writeFileSync(path.join(directory, capsulePath), JSON.stringify(capsule));
  git(directory, "add", capsulePath);
  git(directory, "commit", "-m", "dispatch capsule");
  const targetBase = git(directory, "rev-parse", "HEAD");

  const producerBranch = `agent/${result.producerRoute}/${capsule.capsuleId.toLowerCase()}`;
  git(directory, "switch", "-c", producerBranch);
  mkdirSync(path.join(directory, "tests/fixtures"), { recursive: true });
  writeFileSync(path.join(directory, "tests/fixtures/example.json"), "{}\n");
  git(directory, "add", "tests/fixtures/example.json");
  git(directory, "commit", "-m", "implement capsule");
  const implementationCommit = git(directory, "rev-parse", "HEAD");

  result.implementationCommit = implementationCommit;
  mkdirSync(path.join(directory, path.dirname(resultPath)), { recursive: true });
  writeFileSync(path.join(directory, resultPath), JSON.stringify(result));
  git(directory, "add", resultPath);
  git(directory, "commit", "-m", "record result metadata");
  const observedHead = git(directory, "rev-parse", "HEAD");

  const completed = spawnSync(process.execPath, [
    validator,
    "--discover-base", targetBase,
    "--head", observedHead,
    "--branch", producerBranch,
    "--target", capsule.integrationBranch
  ], { cwd: directory, encoding: "utf8" });
  const report = JSON.parse(completed.stdout);
  assert.equal(completed.status, 0, completed.stdout);
  assert.equal(report.disposition, "eligible");
  assert.deepEqual(report.changed, ["tests/fixtures/example.json"]);
});
