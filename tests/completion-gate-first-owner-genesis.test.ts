import assert from "node:assert/strict";
import test from "node:test";
import { CompletionGateStoreV1 } from "../src/completion-gate/v1/store";
import { InMemoryRollbackCheckpointStoreV1 } from "../src/security/rollback-checkpoint";
import type { DatabaseClient } from "../src/persistence/database";

const tenantId = "tenant:first-owner-genesis";
const key = new Uint8Array(32).fill(37);

test("manifest genesis exactly equals the integrity row provisionTenant creates", async () => {
  let inserted: unknown[] | undefined;
  const db: DatabaseClient = {
    query: async <T = Record<string, unknown>>(): Promise<{ rows: T[] }> => ({ rows: [] }),
    transaction: async work => work({ query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> => {
      if (sql.startsWith("SELECT id FROM tenants")) return { rows: [{ id: tenantId } as T] };
      if (sql.startsWith("INSERT INTO control_completion_gate_integrity")) { inserted = params; return { rows: [] }; }
      return { rows: [] };
    } }),
    transactionWithPreCommitCheck: async (work, check) => {
      const result = await db.transaction(work); await check(); return result;
    },
  } as DatabaseClient;
  const checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const gate = new CompletionGateStoreV1(db, key, checkpoints);
  const genesis = gate.genesisIntegrityV1(tenantId);
  await gate.provisionTenant(tenantId);
  assert.deepEqual(inserted, [tenantId, genesis.revision, genesis.recordCount, genesis.stateDigest, genesis.stateAuthTag]);
  assert.deepEqual(checkpoints.read(`completion-gate:${tenantId}`), {
    schema: "control-room-rollback-checkpoint/v1", scope: `completion-gate:${tenantId}`, ...genesis,
  });
});

test("Mac finisher verifies the committed row and creates its independent checkpoint only once", async () => {
  const checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  let row: Record<string, unknown> | undefined, records = "0";
  const db: DatabaseClient = {
    query: async <T = Record<string, unknown>>(): Promise<{ rows: T[] }> => ({ rows: [] }),
    transaction: async work => work({ query: async <T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> => {
      if (sql.includes("FROM control_completion_gate_integrity")) return { rows: (row ? [row] : []) as T[] };
      if (sql.includes("FROM control_completion_gate_records")) return { rows: (sql.includes("count(*)") ? [{ count: records }] : []) as T[] };
      throw new Error("unexpected_query");
    } }),
    transactionWithPreCommitCheck: async (work, check) => {
      const result = await db.transaction(work); await check(); return result;
    },
  } as DatabaseClient;
  const gate = new CompletionGateStoreV1(db, key, checkpoints);
  const genesis = gate.genesisIntegrityV1(tenantId);
  await assert.rejects(gate.completeProvisionedTenantV1(tenantId), /integrity_failed/);
  row = { tenant_id: tenantId, revision: genesis.revision, record_count: genesis.recordCount,
    state_digest: genesis.stateDigest, state_auth_tag: genesis.stateAuthTag };
  records = "1";
  await assert.rejects(gate.completeProvisionedTenantV1(tenantId), /integrity_failed/);
  records = "0";
  await assert.rejects(gate.verifyProvisionedTenantV1(tenantId), /integrity_failed/);
  assert.equal(await gate.completeProvisionedTenantV1(tenantId), "created");
  await gate.verifyProvisionedTenantV1(tenantId);
  assert.equal(await gate.completeProvisionedTenantV1(tenantId), "already_present");
  row = { ...row, revision: 2 };
  await assert.rejects(gate.completeProvisionedTenantV1(tenantId), /integrity_failed/);
  await assert.rejects(gate.verifyProvisionedTenantV1(tenantId), /integrity_failed/);
});
