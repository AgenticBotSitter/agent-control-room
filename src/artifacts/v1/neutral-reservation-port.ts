/**
 * Neutral result-write reservation port.
 *
 * The harness-neutral publisher (`durable-result-publication.ts`) persists
 * reservation rows through this interface instead of touching a concrete
 * table. The PostgreSQL adapter for the dedicated neutral sibling table is
 * lead-owned and pending (it arrives with the lead's narrowly scoped
 * migration after #63); until then, tests and local runs inject the
 * in-memory implementation below. No neutral record is ever stored under a
 * native schema literal, and the native-only constraint is never widened.
 *
 * Record shape mirrors the reservation row columns (snake_case) so the
 * publisher's parse/verify logic is identical for every implementation.
 * The port stores opaque records: HMAC tags, state-machine transitions and
 * mirror verification stay in the publisher, which never shares keys here.
 *
 * Concurrency contract (every implementation MUST hold it):
 * - One record per (tenantId, runId) and one per (tenantId, artifactId);
 *   a second insert colliding on either reports "conflict" (the PostgreSQL
 *   unique-violation path).
 * - compareAndSwap applies only when the stored state AND contractDigest
 *   still equal prior; otherwise it reports false and changes nothing
 *   (the conditional-UPDATE-matched-zero-rows path). It MUST preserve the
 *   stored created_at, exactly as the previous conditional UPDATE did by
 *   never setting that column.
 * - Implementations running inside a caller transaction MUST lock the row
 *   in findForUpdate (e.g. SELECT ... FOR UPDATE). Standalone
 *   implementations MUST serialize each method so concurrent callers
 *   observe the same outcomes: exactly one insert winner, failed swaps
 *   that change nothing.
 */

import type { DatabaseSession } from "../../persistence/database";

export interface NeutralReservationRowV1 {
  tenant_id: string; project_id: string; job_id: string; attempt_id: string;
  run_id: string; artifact_id: string; identity_digest: string; state: string;
  contract_digest: string; reservation: unknown; auth_tag: string;
  created_at: string; updated_at: string;
}

export interface NeutralReservationPriorV1 {
  tenantId: string; runId: string; state: string; contractDigest: string;
}

export interface NeutralReservationPort {
  findForUpdate(session: DatabaseSession, tenantId: string, runId: string): Promise<NeutralReservationRowV1 | null>;
  insertFresh(session: DatabaseSession, row: NeutralReservationRowV1): Promise<"inserted" | "conflict">;
  compareAndSwap(session: DatabaseSession, prior: NeutralReservationPriorV1,
    next: NeutralReservationRowV1): Promise<boolean>;
}

/**
 * In-memory port: per-key serialized map with both uniqueness constraints.
 *
 * **Test-only, nonpersistent.** This implementation does NOT survive a
 * "restart" — constructing a fresh instance yields an empty store. The
 * publisher treats it as non-durable: any replay claim, restart recovery
 * test, or persistent integration scenario must inject a separate
 * `PersistentNeutralReservationPort` (or the future lead-owned PostgreSQL
 * adapter) that shares backing storage across reconstructions.
 *
 * The `session` argument is accepted for interface compatibility and
 * ignored: each method is atomic, and cross-method races resolve through
 * the same fail-closed outcomes as the database guards (insert conflict
 * on either unique key; swap mismatch on stale prior changes nothing).
 */
export class InMemoryNeutralReservationPort implements NeutralReservationPort {
  private readonly records: Map<string, NeutralReservationRowV1>;
  private readonly artifactIndex: Map<string, string>;
  private locks = Promise.resolve();

  private key(tenantId: string, runId: string): string {
    return `${tenantId}\n${runId}`;
  }

  private artifactKey(tenantId: string, artifactId: string): string {
    return `${tenantId}\n${artifactId}`;
  }

  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.locks.then(fn);
    this.locks = run.then(() => undefined, () => undefined);
    return run;
  }

  private static clone(row: NeutralReservationRowV1): NeutralReservationRowV1 {
    return { ...row, reservation: structuredClone(row.reservation) };
  }

  /**
   * Construct a nonpersistent test port. Each call returns a fresh empty
   * store; recreate-to-restart is intentionally a no-op for state.
   */
  constructor() {
    this.records = new Map();
    this.artifactIndex = new Map();
  }

  async findForUpdate(_session: DatabaseSession, tenantId: string,
    runId: string): Promise<NeutralReservationRowV1 | null> {
    return this.exclusive(() => {
      const row = this.records.get(this.key(tenantId, runId));
      return row ? InMemoryNeutralReservationPort.clone(row) : null;
    });
  }

  async insertFresh(_session: DatabaseSession,
    row: NeutralReservationRowV1): Promise<"inserted" | "conflict"> {
    return this.exclusive(() => {
      const key = this.key(row.tenant_id, row.run_id);
      const artifactKey = this.artifactKey(row.tenant_id, row.artifact_id);
      const artifactOwner = this.artifactIndex.get(artifactKey);
      if (this.records.has(key) || (artifactOwner !== undefined && artifactOwner !== key)) {
        return "conflict";
      }
      this.records.set(key, InMemoryNeutralReservationPort.clone(row));
      this.artifactIndex.set(artifactKey, key);
      return "inserted";
    });
  }

  async compareAndSwap(_session: DatabaseSession, prior: NeutralReservationPriorV1,
    next: NeutralReservationRowV1): Promise<boolean> {
    return this.exclusive(() => {
      const key = this.key(prior.tenantId, prior.runId);
      const current = this.records.get(key);
      if (!current || current.state !== prior.state || current.contract_digest !== prior.contractDigest) {
        return false;
      }
      // Identity columns are immutable: only state-progression fields move.
      this.records.set(key, InMemoryNeutralReservationPort.clone({
        ...current,
        state: next.state,
        contract_digest: next.contract_digest,
        reservation: next.reservation,
        auth_tag: next.auth_tag,
        updated_at: next.updated_at,
      }));
      return true;
    });
  }

  /** Test-only read; returns a copy so assertions cannot mutate the store. */
  peek(tenantId: string, runId: string): NeutralReservationRowV1 | null {
    const row = this.records.get(this.key(tenantId, runId));
    return row ? InMemoryNeutralReservationPort.clone(row) : null;
  }
}

export function createInMemoryNeutralReservationPort(): InMemoryNeutralReservationPort {
  return new InMemoryNeutralReservationPort();
}

/**
 * Shared backing storage for `PersistentNeutralReservationPort`. Tests pass
 * the same `PersistentReservationStoreV1` instance to multiple port
 * constructors so the second port (e.g. a "restart" instance) observes the
 * exact state the first port committed. The store is intentionally a
 * test-only shim — production persistence goes through the lead-owned
 * PostgreSQL adapter after #63.
 */
export interface PersistentReservationStoreV1 {
  records: Map<string, NeutralReservationRowV1>;
  artifactIndex: Map<string, string>;
  locks: { chain: Promise<void> };
}

/**
 * Persistent in-memory port. Sharing the backing store across
 * constructions yields the exact "restart after process exit" behavior the
 * publisher needs for replay claims, manifest-collision recovery, and
 * inventory scans. Still test-only: it holds the rows in process memory,
 * not in PostgreSQL or any durable file, and it is labelled non-production
 * at the construction site.
 */
export class PersistentNeutralReservationPort implements NeutralReservationPort {
  private readonly records: Map<string, NeutralReservationRowV1>;
  private readonly artifactIndex: Map<string, string>;
  private readonly lockChain: { chain: Promise<void> };

  private key(tenantId: string, runId: string): string {
    return `${tenantId}\n${runId}`;
  }

  private artifactKey(tenantId: string, artifactId: string): string {
    return `${tenantId}\n${artifactId}`;
  }

  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.lockChain.chain.then(fn);
    this.lockChain.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private static clone(row: NeutralReservationRowV1): NeutralReservationRowV1 {
    return { ...row, reservation: structuredClone(row.reservation) };
  }

  constructor(store: PersistentReservationStoreV1) {
    if (!store || !(store.records instanceof Map) || !(store.artifactIndex instanceof Map)
      || !store.locks) {
      throw new Error("persistent_neutral_reservation_store_invalid");
    }
    this.records = store.records;
    this.artifactIndex = store.artifactIndex;
    this.lockChain = store.locks;
  }

  async findForUpdate(_session: DatabaseSession, tenantId: string,
    runId: string): Promise<NeutralReservationRowV1 | null> {
    return this.exclusive(() => {
      const row = this.records.get(this.key(tenantId, runId));
      return row ? PersistentNeutralReservationPort.clone(row) : null;
    });
  }

  async insertFresh(_session: DatabaseSession,
    row: NeutralReservationRowV1): Promise<"inserted" | "conflict"> {
    return this.exclusive(() => {
      const key = this.key(row.tenant_id, row.run_id);
      const artifactKey = this.artifactKey(row.tenant_id, row.artifact_id);
      const artifactOwner = this.artifactIndex.get(artifactKey);
      if (this.records.has(key) || (artifactOwner !== undefined && artifactOwner !== key)) {
        return "conflict";
      }
      this.records.set(key, PersistentNeutralReservationPort.clone(row));
      this.artifactIndex.set(artifactKey, key);
      return "inserted";
    });
  }

  async compareAndSwap(_session: DatabaseSession, prior: NeutralReservationPriorV1,
    next: NeutralReservationRowV1): Promise<boolean> {
    return this.exclusive(() => {
      const key = this.key(prior.tenantId, prior.runId);
      const current = this.records.get(key);
      if (!current || current.state !== prior.state || current.contract_digest !== prior.contractDigest) {
        return false;
      }
      this.records.set(key, PersistentNeutralReservationPort.clone({
        ...current,
        state: next.state,
        contract_digest: next.contract_digest,
        reservation: next.reservation,
        auth_tag: next.auth_tag,
        updated_at: next.updated_at,
      }));
      return true;
    });
  }

  /** Test-only read; returns a copy so assertions cannot mutate the store. */
  peek(tenantId: string, runId: string): NeutralReservationRowV1 | null {
    const row = this.records.get(this.key(tenantId, runId));
    return row ? PersistentNeutralReservationPort.clone(row) : null;
  }
}

export function createPersistentNeutralReservationStore(): PersistentReservationStoreV1 {
  return { records: new Map(), artifactIndex: new Map(), locks: { chain: Promise.resolve() } };
}

export function createPersistentNeutralReservationPort(store: PersistentReservationStoreV1): PersistentNeutralReservationPort {
  return new PersistentNeutralReservationPort(store);
}
