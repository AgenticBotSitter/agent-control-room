import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { renderJobber } from "../scripts/render-agent-jobber.mjs";

const root = process.cwd();
const wavePath = "coordination/agent-build/waves/CR14-PRIVATE-UI-1.json";
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const wave = readJson(wavePath);
const validator = path.join(root, "scripts/validate-agent-intake.mjs");

function validate(file, mode) {
  const result = spawnSync(process.execPath, [validator, "--mode", mode, "--capsule", file], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  return { exit: result.status, report: JSON.parse(result.stdout) };
}

function validateChanged(t, changes) {
  const directory = mkdtempSync(path.join(tmpdir(), "control-room-draft-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "capsule.json");
  writeFileSync(file, JSON.stringify({ ...readJson(wave.capsules[0]), ...changes }));
  return validate(file, "capsule-draft");
}

test("private-beta draft wave has exact, disjoint product scopes and existing contracts", () => {
  assert.equal(wave.schema, "control-room.agent-build-wave/v2");
  assert.equal(wave.status, "draft");
  assert.equal(wave.ownerEffectAuthority, "none");
  assert.equal(wave.capsules.length, 4);
  assert.equal(new Set(wave.capsules).size, 4);
  const productPaths = new Set();
  const ids = new Set();
  for (const file of wave.capsules) {
    const capsule = readJson(file);
    assert.equal(capsule.status, "draft");
    assert.equal(capsule.waveId, wave.waveId);
    assert.equal(capsule.baseCommit, wave.baseCommit);
    assert.equal(capsule.integrationBranch, wave.integrationBranch);
    assert.equal(capsule.mode, "standard-work");
    assert.deepEqual(capsule.effects, { level: "none", maxCount: 0 });
    assert.equal(capsule.limits.maxRepairIterations, 2);
    assert.equal(capsule.maxConcurrentClaimsPerRoute, 3);
    assert.equal(ids.has(capsule.capsuleId), false);
    ids.add(capsule.capsuleId);
    assert.equal(file, `coordination/agent-build/capsules/${capsule.capsuleId}.json`);
    for (const contract of capsule.contractRefs) assert.equal(existsSync(path.join(root, contract)), true, contract);
    for (const productPath of capsule.allowedPaths) {
      assert.equal(productPaths.has(productPath), false, `overlapping scope: ${productPath}`);
      productPaths.add(productPath);
    }
    assert.throws(() => renderJobber(capsule, file), /only ready capsules/);
  }
});

test("draft structure can pass without becoming claimable or renderable as READY", () => {
  for (const file of wave.capsules) {
    const draft = validate(file, "capsule-draft");
    assert.equal(draft.exit, 0, JSON.stringify(draft.report));
    assert.equal(draft.report.schema, "control-room.agent-build-capsule-draft-validation/v2");
    assert.equal(draft.report.disposition, "valid-draft-not-claimable");
    assert.equal(draft.report.claimable, false);
    assert.deepEqual(draft.report.errors, []);
    const normal = validate(file, "capsule");
    assert.equal(normal.exit, 1);
    assert.equal(normal.report.disposition, "draft-or-invalid");
    assert.deepEqual(normal.report.errors, ["capsule_not_claimable"]);
  }
});

test("draft mode retains scope, ancestry format, route and effect validation", (t) => {
  const result = validateChanged(t, {
    baseCommit: "not-a-commit", allowedPaths: ["../outside"],
    routeClaimants: {}, effects: { level: "none", maxCount: 1 },
  });
  assert.equal(result.exit, 1);
  assert.equal(result.report.claimable, false);
  for (const code of ["base_commit_invalid", "allowed_paths_invalid", "route_claimants_mismatch", "none_effect_count_nonzero"]) {
    assert.ok(result.report.errors.includes(code), code);
  }
});

test("draft validator cannot relabel a ready or blocked capsule as a valid draft", (t) => {
  for (const status of ["ready", "blocked", "complete", undefined]) {
    const result = validateChanged(t, { status });
    assert.equal(result.exit, 1);
    assert.equal(result.report.claimable, false);
    assert.deepEqual(result.report.errors, ["capsule_not_draft"]);
  }
});
