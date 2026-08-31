import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { InMemoryRollbackCheckpointStoreV1 } from "../src/security";
import {
  READY_FRONTIER_POLICY_V1,
  READY_FRONTIER_SOURCE_V1,
  ReadyFrontierContractErrorV1,
  ReadyFrontierSimulationStoreV1,
  buildReadyFrontierFixtureV1,
  buildReadyFrontierPolicyV1,
  buildReadyFrontierSourceV1,
  evaluateReadyFrontierV1,
  type ReadyFrontierCycleInputV1,
  type ReadyFrontierPolicyV1,
  type ReadyFrontierSourceSnapshotV1,
} from "../src/ready-frontier/v1";

const key = () => new Uint8Array(32).fill(0x4f);
const code = (safeCode: ReadyFrontierContractErrorV1["safeCode"]) => (error: unknown) =>
  error instanceof ReadyFrontierContractErrorV1 && error.safeCode === safeCode;
function sourceInput(source: ReadyFrontierSourceSnapshotV1) {
  const { sourceDigest: _digest, ...input } = source; void _digest; return input;
}
function policyInput(policy: ReadyFrontierPolicyV1) {
  const { policyDigest: _digest, ...input } = policy; void _digest; return input;
}
function temporaryStore(maximumCycles = 1_000) {
  const directory = mkdtempSync(join(tmpdir(), "cr11b-frontier-")); chmodSync(directory, 0o700);
  const path = join(directory, "frontier.sqlite"), checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const store = new ReadyFrontierSimulationStoreV1(path, "tenant.owner", key(), checkpoints, maximumCycles);
  return { directory, path, checkpoints, store };
}
function cleanup(directory: string) { rmSync(directory, { recursive: true, force: true }); }
function nextCycle(fixture: ReadyFrontierCycleInputV1, suffix: number): ReadyFrontierCycleInputV1 {
  return { ...fixture, cycleId: `frontier.cycle.${String(suffix).padStart(4, "0")}`,
    evaluatedAt: `2026-08-30T18:0${suffix}:00.000Z` };
}

test("CR11B-AUTO-000 durable simulation records one authenticated cycle, exact replay, restart, and safe latest projection", () => {
  const resource = temporaryStore();
  try {
    const fixture = buildReadyFrontierFixtureV1(), first = resource.store.runCycle(fixture), replay = resource.store.runCycle(fixture);
    assert.equal(first.replayed, false); assert.equal(replay.replayed, true);
    assert.deepEqual(replay.evaluation, first.evaluation);
    assert.equal(resource.store.listEvaluations().length, 1);
    const projection = resource.store.latestOperatorProjection();
    assert.equal(projection?.cycleId, fixture.cycleId); assert.equal(projection?.proposalOnly, true);
    resource.store.closeDatabase();
    const restarted = new ReadyFrontierSimulationStoreV1(resource.path, "tenant.owner", key(), resource.checkpoints);
    assert.deepEqual(restarted.listEvaluations(), [first.evaluation]);
    assert.equal(restarted.latestOperatorProjection()?.canDispatchOrExecute, false);
    assert.equal(statSync(resource.path).mode & 0o077, 0); restarted.closeDatabase();
  } finally { cleanup(resource.directory); }
});

test("CR11B-AUTO-000 durable simulation rejects changed replay and foreign scope", () => {
  const resource = temporaryStore();
  try {
    const fixture = buildReadyFrontierFixtureV1(); resource.store.runCycle(fixture);
    const changedSource = buildReadyFrontierSourceV1({ ...sourceInput(fixture.source), sourceRevision: 2,
      candidates: fixture.source.candidates.map((item) => item.candidateId === "candidate.abs.research" ? { ...item, priority: 89 } : item) });
    const changed = evaluateReadyFrontierV1({ ...fixture, source: changedSource }, key());
    assert.throws(() => resource.store.recordEvaluation(changed), code("replay_drift"));

    const foreignSource = buildReadyFrontierSourceV1({ ...sourceInput(fixture.source), schema: READY_FRONTIER_SOURCE_V1,
      tenantId: "tenant.foreign" });
    const foreignPolicy = buildReadyFrontierPolicyV1({ ...policyInput(fixture.policy), schema: READY_FRONTIER_POLICY_V1,
      tenantId: "tenant.foreign" });
    const foreign = evaluateReadyFrontierV1({ ...fixture, source: foreignSource, policy: foreignPolicy }, key());
    assert.throws(() => resource.store.recordEvaluation(foreign), code("scope_mismatch"));
    resource.store.closeDatabase();
  } finally { cleanup(resource.directory); }
});

test("CR11B-AUTO-000 durable simulation enforces its exact cycle ceiling", () => {
  const resource = temporaryStore(1);
  try {
    const fixture = buildReadyFrontierFixtureV1(); resource.store.runCycle(fixture);
    assert.throws(() => resource.store.runCycle(nextCycle(fixture, 3)), code("capacity_exceeded"));
    assert.equal(resource.store.listEvaluations().length, 1); resource.store.closeDatabase();
  } finally { cleanup(resource.directory); }
});

test("CR11B-AUTO-000 later cycles and restarts suppress intents already proposed by the ledger", () => {
  const resource = temporaryStore();
  try {
    const fixture = buildReadyFrontierFixtureV1(), first = resource.store.runCycle(fixture).evaluation;
    const second = resource.store.runCycle(nextCycle(fixture, 3)).evaluation;
    assert.equal(first.proposalCount, 3); assert.equal(second.proposalCount, 0);
    for (const candidateId of first.proposals.map((proposal) => proposal.candidateId)) {
      const disposition = second.dispositions.find((item) => item.candidateId === candidateId);
      assert.equal(disposition?.outcome, "duplicate_suppressed");
      assert.equal(disposition?.reasonCodes.includes("duplicate_prior_proposal_intent"), true);
    }
    assert.equal(second.sourceHistoryRevision, 3); resource.store.closeDatabase();
    const restarted = new ReadyFrontierSimulationStoreV1(resource.path, "tenant.owner", key(), resource.checkpoints);
    const third = restarted.runCycle({ ...nextCycle(fixture, 4), evaluatedAt: "2026-08-30T18:04:00.000Z" }).evaluation;
    assert.equal(third.proposalCount, 0); assert.equal(third.sourceHistoryRevision, 3); restarted.closeDatabase();
  } finally { cleanup(resource.directory); }
});

test("CR11B-AUTO-000 restart rejects wrong integrity key and altered cycle JSON", () => {
  for (const attack of ["wrong_key", "json_tamper"] as const) {
    const resource = temporaryStore();
    try {
      resource.store.runCycle(buildReadyFrontierFixtureV1()); resource.store.closeDatabase();
      if (attack === "json_tamper") {
        const db = new DatabaseSync(resource.path); db.prepare("UPDATE ready_frontier_cycle SET evaluation_json='{}' WHERE ledger_sequence=1").run(); db.close();
      }
      assert.throws(() => new ReadyFrontierSimulationStoreV1(resource.path, "tenant.owner",
        attack === "wrong_key" ? new Uint8Array(32).fill(0x11) : key(), resource.checkpoints), code("integrity_failed"));
    } finally { cleanup(resource.directory); }
  }
});

test("CR11B-AUTO-000 restart detects row deletion, metadata drift, and added schema behavior", () => {
  for (const attack of ["delete", "metadata", "trigger"] as const) {
    const resource = temporaryStore();
    try {
      resource.store.runCycle(buildReadyFrontierFixtureV1()); resource.store.closeDatabase();
      const db = new DatabaseSync(resource.path);
      if (attack === "delete") db.exec("DELETE FROM ready_frontier_cycle WHERE ledger_sequence=1");
      else if (attack === "metadata") db.exec("UPDATE ready_frontier_metadata SET record_count=0 WHERE singleton=1");
      else db.exec("CREATE TRIGGER hostile AFTER INSERT ON ready_frontier_cycle BEGIN DELETE FROM ready_frontier_cycle; END");
      db.close();
      assert.throws(() => new ReadyFrontierSimulationStoreV1(resource.path, "tenant.owner", key(), resource.checkpoints), code("integrity_failed"));
    } finally { cleanup(resource.directory); }
  }
});

test("CR11B-AUTO-000 external checkpoint detects a complete database rollback", () => {
  const resource = temporaryStore();
  try {
    const fixture = buildReadyFrontierFixtureV1(); resource.store.runCycle(fixture); resource.store.closeDatabase();
    const backup = join(resource.directory, "old.sqlite"); copyFileSync(resource.path, backup);
    const second = new ReadyFrontierSimulationStoreV1(resource.path, "tenant.owner", key(), resource.checkpoints);
    second.runCycle(nextCycle(fixture, 3)); second.closeDatabase();
    copyFileSync(backup, resource.path);
    assert.throws(() => new ReadyFrontierSimulationStoreV1(resource.path, "tenant.owner", key(), resource.checkpoints),
      code("integrity_failed"));
  } finally { cleanup(resource.directory); }
});

test("CR11B-AUTO-000 durable implementation contains no network, provider, job, approval, lease, or dispatch client", () => {
  const source = readFileSync(new URL("../src/ready-frontier/v1/durable-store.ts", import.meta.url), "utf8");
  for (const forbidden of ["node:net", "node:http", "node:https", "child_process", "fetch(", "CanonicalStore", "ApprovalStore",
    "LeaseStore", "providerClient", "dispatch(", "execute("]) assert.equal(source.includes(forbidden), false);
});
