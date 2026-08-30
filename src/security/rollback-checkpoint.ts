import { sha256Digest } from "./digest";
import { exactHostDataSnapshotV1 } from "./host-value";

export const ROLLBACK_CHECKPOINT_SCHEMA_V1 = "control-room-rollback-checkpoint/v1" as const;

export interface RollbackCheckpointV1 {
  schema: typeof ROLLBACK_CHECKPOINT_SCHEMA_V1;
  scope: string;
  revision: number;
  recordCount: number;
  stateDigest: string;
  stateAuthTag: string;
}

/**
 * This port must be implemented by storage outside the database or ledger it
 * protects. Its compare-and-swap operation is the rollback-resistant anchor;
 * an ordinary table in the protected database is not a valid implementation.
 */
export interface RollbackCheckpointStoreV1 {
  read(scope: string): RollbackCheckpointV1 | undefined;
  initialize(checkpoint: RollbackCheckpointV1): void;
  advance(expectedCheckpointDigest: string, checkpoint: RollbackCheckpointV1): void;
}

export function parseRollbackCheckpointV1(value: unknown): RollbackCheckpointV1 {
  const keys = ["recordCount", "revision", "schema", "scope", "stateAuthTag", "stateDigest"];
  const item = exactHostDataSnapshotV1(value, keys);
  if (!item) throw new Error("rollback checkpoint invalid");
  if (item.schema !== ROLLBACK_CHECKPOINT_SCHEMA_V1 || typeof item.scope !== "string" || item.scope.length < 3 || item.scope.length > 240
    || !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || !Number.isSafeInteger(item.recordCount) || (item.recordCount as number) < 0
    || typeof item.stateDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.stateDigest)
    || typeof item.stateAuthTag !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/.test(item.stateAuthTag)) throw new Error("rollback checkpoint invalid");
  return item as unknown as RollbackCheckpointV1;
}

export function rollbackCheckpointDigestV1(value: RollbackCheckpointV1): string {
  return sha256Digest(parseRollbackCheckpointV1(value));
}

/** Effect-free test/reference implementation. It is not durable deployment storage. */
export class InMemoryRollbackCheckpointStoreV1 implements RollbackCheckpointStoreV1 {
  readonly #values = new Map<string, RollbackCheckpointV1>();
  constructor(options: { testOnly: true }) { if (options.testOnly !== true) throw new Error("in-memory rollback checkpoint is test-only"); }
  read(scope: string): RollbackCheckpointV1 | undefined { const value = this.#values.get(scope); return value ? structuredClone(value) : undefined; }
  initialize(value: RollbackCheckpointV1): void {
    const next = parseRollbackCheckpointV1(value);
    if (this.#values.has(next.scope) || next.revision !== 1) throw new Error("rollback checkpoint conflict");
    this.#values.set(next.scope, structuredClone(next));
  }
  advance(expectedCheckpointDigest: string, value: RollbackCheckpointV1): void {
    const next = parseRollbackCheckpointV1(value); const current = this.#values.get(next.scope);
    if (!current || rollbackCheckpointDigestV1(current) !== expectedCheckpointDigest || next.revision !== current.revision + 1) throw new Error("rollback checkpoint conflict");
    this.#values.set(next.scope, structuredClone(next));
  }
}
