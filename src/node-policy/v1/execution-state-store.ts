import { DatabaseSync } from "node:sqlite";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import {
  applyExecutionAuthorityEvent,
  classifyExecutionRecovery,
  createExecutionAuthoritySnapshot,
  type ExecutionAuthorityEventV1,
  type ExecutionAuthoritySnapshotV1,
  type ExecutionDeadlineSourcesV1,
  type ExecutionIdentityV1,
  type ExecutionRecoveryActionV1,
} from "./execution-authority";

export class ExecutionStateConflictError extends Error {
  constructor(message = "Execution state conflicts with durable history") {
    super(message);
    this.name = "ExecutionStateConflictError";
  }
}

export interface DurableExecutionCreationV1 {
  executionId: string;
  admissionId: string;
  identity: ExecutionIdentityV1;
  authorityDigest: string;
  deadlineSources: ExecutionDeadlineSourcesV1;
  leaseEpoch: number;
  createdAt: string;
}

export interface DurableExecutionEventRecordV1 {
  sequence: number;
  event: ExecutionAuthorityEventV1 | { eventId: string; kind: "admitted"; occurredAt: string };
  eventDigest: string;
  fromState: string | null;
  toState: string;
  requestCancellation: boolean;
}

export class SqliteExecutionStateStore {
  private readonly db: DatabaseSync;

  constructor(path: string, options: { testOnlyAllowEphemeral?: boolean } = {}) {
    if ((path === ":memory:" || path.startsWith("file:")) && !options.testOnlyAllowEphemeral) {
      throw new Error("Durable execution state store requires a filesystem path");
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_authority_state (
        execution_id TEXT PRIMARY KEY,
        admission_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        operation_digest TEXT NOT NULL,
        authority_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('admitted','executing','expiring_soon','cancellation_requested','expired','completed','failed','cancelled')),
        effective_deadline TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL CHECK(lease_epoch >= 0),
        version INTEGER NOT NULL CHECK(version >= 1),
        creation_digest TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_authority_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL REFERENCES execution_authority_state(execution_id) ON DELETE RESTRICT,
        event_id TEXT NOT NULL,
        event_digest TEXT NOT NULL,
        transition_digest TEXT NOT NULL,
        event_json TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        request_cancellation INTEGER NOT NULL CHECK(request_cancellation IN (0,1)),
        occurred_at TEXT NOT NULL,
        UNIQUE(execution_id,event_id)
      );
      PRAGMA user_version=1;
    `);
  }

  close(): void {
    this.db.close();
  }

  create(input: DurableExecutionCreationV1): "created" | "duplicate" {
    assertNoSecretMaterial(input, "execution authority creation");
    const snapshot = createExecutionAuthoritySnapshot(input);
    const creationDigest = sha256Digest(snapshot);
    const snapshotDigest = sha256Digest(snapshot);
    const admittedEvent = { eventId: `admitted:${snapshot.executionId}`, kind: "admitted" as const, occurredAt: snapshot.createdAt };
    const eventDigest = sha256Digest(admittedEvent);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare(`SELECT creation_digest FROM execution_authority_state WHERE execution_id=? OR admission_id=?`).get(snapshot.executionId, snapshot.admissionId) as { creation_digest: string } | undefined;
      if (prior) {
        if (prior.creation_digest !== creationDigest) throw new ExecutionStateConflictError();
        this.db.exec("COMMIT");
        return "duplicate";
      }
      this.db.prepare(`INSERT INTO execution_authority_state(
        execution_id,admission_id,tenant_id,node_id,project_id,job_id,attempt_id,operation_digest,authority_digest,
        state,effective_deadline,lease_epoch,version,creation_digest,snapshot_digest,snapshot_json,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        snapshot.executionId, snapshot.admissionId, snapshot.identity.tenantId, snapshot.identity.nodeId,
        snapshot.identity.projectId, snapshot.identity.jobId, snapshot.identity.attemptId, snapshot.identity.operationDigest,
        snapshot.authorityDigest, snapshot.state, snapshot.deadline.effectiveDeadline, snapshot.leaseEpoch, snapshot.version,
        creationDigest, snapshotDigest, JSON.stringify(snapshot), snapshot.updatedAt,
      );
      const transitionDigest = sha256Digest({ event: admittedEvent, fromState: null, toState: snapshot.state, requestCancellation: false });
      this.db.prepare(`INSERT INTO execution_authority_events(execution_id,event_id,event_digest,transition_digest,event_json,from_state,to_state,request_cancellation,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
        snapshot.executionId, admittedEvent.eventId, eventDigest, transitionDigest, JSON.stringify(admittedEvent), null, snapshot.state, 0, admittedEvent.occurredAt,
      );
      this.db.exec("COMMIT");
      return "created";
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* retain the original safe conflict */ }
      if (error instanceof ExecutionStateConflictError) throw error;
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) throw new ExecutionStateConflictError();
      throw error;
    }
  }

  apply(executionId: string, event: ExecutionAuthorityEventV1): { disposition: "applied" | "duplicate"; snapshot: ExecutionAuthoritySnapshotV1; requestCancellation: boolean } {
    assertNoSecretMaterial(event, "execution authority event");
    const eventDigest = sha256Digest(event);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(`SELECT event_digest,request_cancellation FROM execution_authority_events WHERE execution_id=? AND event_id=?`).get(executionId, event.eventId) as { event_digest: string; request_cancellation: number } | undefined;
      if (existing) {
        if (existing.event_digest !== eventDigest) throw new ExecutionStateConflictError("Execution event ID was reused with different content");
        const snapshot = this.loadWithinTransaction(executionId);
        this.db.exec("COMMIT");
        return { disposition: "duplicate", snapshot, requestCancellation: existing.request_cancellation === 1 };
      }
      const before = this.loadWithinTransaction(executionId);
      const transition = applyExecutionAuthorityEvent(before, event);
      const snapshotDigest = sha256Digest(transition.snapshot);
      const changed = this.db.prepare(`UPDATE execution_authority_state SET
        state=?,effective_deadline=?,lease_epoch=?,version=?,snapshot_digest=?,snapshot_json=?,updated_at=?
        WHERE execution_id=? AND version=?`).run(
        transition.snapshot.state, transition.snapshot.deadline.effectiveDeadline, transition.snapshot.leaseEpoch,
        transition.snapshot.version, snapshotDigest, JSON.stringify(transition.snapshot), transition.snapshot.updatedAt,
        executionId, before.version,
      );
      if (Number(changed.changes) !== 1) throw new ExecutionStateConflictError("Execution state changed concurrently");
      const transitionDigest = sha256Digest({ event, fromState: before.state, toState: transition.snapshot.state, requestCancellation: transition.requestCancellation });
      this.db.prepare(`INSERT INTO execution_authority_events(execution_id,event_id,event_digest,transition_digest,event_json,from_state,to_state,request_cancellation,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
        executionId, event.eventId, eventDigest, transitionDigest, JSON.stringify(event), before.state, transition.snapshot.state,
        transition.requestCancellation ? 1 : 0, event.occurredAt,
      );
      this.db.exec("COMMIT");
      return { disposition: "applied", ...transition };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* retain the original safe conflict */ }
      if (error instanceof ExecutionStateConflictError) throw error;
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) throw new ExecutionStateConflictError();
      throw error;
    }
  }

  load(executionId: string): ExecutionAuthoritySnapshotV1 | undefined {
    const row = this.db.prepare(`SELECT * FROM execution_authority_state WHERE execution_id=?`).get(executionId) as Record<string, unknown> | undefined;
    return row ? this.snapshotFromRow(row) : undefined;
  }

  recoveryAction(executionId: string): ExecutionRecoveryActionV1 {
    const snapshot = this.load(executionId);
    if (!snapshot) throw new ExecutionStateConflictError("Execution state is missing");
    return classifyExecutionRecovery(snapshot);
  }

  events(executionId: string): DurableExecutionEventRecordV1[] {
    try {
      const rows = this.db.prepare(`SELECT sequence,event_digest,transition_digest,event_json,from_state,to_state,request_cancellation,occurred_at FROM execution_authority_events WHERE execution_id=? ORDER BY sequence`).all(executionId) as Array<Record<string, unknown>>;
      let priorState: string | null = null;
      const records = rows.map((row) => {
        const event = JSON.parse(String(row.event_json)) as DurableExecutionEventRecordV1["event"];
        const fromState = row.from_state === null ? null : String(row.from_state);
        const toState = String(row.to_state);
        const requestCancellation = Number(row.request_cancellation) === 1;
        if (sha256Digest(event) !== String(row.event_digest)
          || sha256Digest({ event, fromState, toState, requestCancellation }) !== String(row.transition_digest)
          || event.occurredAt !== String(row.occurred_at)
          || fromState !== priorState) throw new ExecutionStateConflictError("Execution event history digest or chain mismatch");
        priorState = toState;
        return { sequence: Number(row.sequence), event, eventDigest: String(row.event_digest), fromState, toState, requestCancellation };
      });
      const snapshot = this.load(executionId);
      if (records.length > 0 && snapshot && records.at(-1)?.toState !== snapshot.state) throw new ExecutionStateConflictError("Execution event history does not match current state");
      return records;
    } catch (error) {
      if (error instanceof ExecutionStateConflictError) throw error;
      throw new ExecutionStateConflictError("Execution event history is malformed");
    }
  }

  private loadWithinTransaction(executionId: string): ExecutionAuthoritySnapshotV1 {
    const row = this.db.prepare(`SELECT * FROM execution_authority_state WHERE execution_id=?`).get(executionId) as Record<string, unknown> | undefined;
    if (!row) throw new ExecutionStateConflictError("Execution state is missing");
    return this.snapshotFromRow(row);
  }

  private snapshotFromRow(row: Record<string, unknown>): ExecutionAuthoritySnapshotV1 {
    try {
      const snapshot = JSON.parse(String(row.snapshot_json)) as ExecutionAuthoritySnapshotV1;
      if (sha256Digest(snapshot) !== String(row.snapshot_digest)
        || snapshot.executionId !== String(row.execution_id)
        || snapshot.admissionId !== String(row.admission_id)
        || snapshot.identity.tenantId !== String(row.tenant_id)
        || snapshot.identity.nodeId !== String(row.node_id)
        || snapshot.identity.projectId !== String(row.project_id)
        || snapshot.identity.jobId !== String(row.job_id)
        || snapshot.identity.attemptId !== String(row.attempt_id)
        || snapshot.identity.operationDigest !== String(row.operation_digest)
        || snapshot.authorityDigest !== String(row.authority_digest)
        || snapshot.state !== String(row.state)
        || snapshot.deadline.effectiveDeadline !== String(row.effective_deadline)
        || snapshot.leaseEpoch !== Number(row.lease_epoch)
        || snapshot.version !== Number(row.version)
        || snapshot.updatedAt !== String(row.updated_at)) {
        throw new ExecutionStateConflictError("Execution state mirror or digest mismatch");
      }
      return snapshot;
    } catch (error) {
      if (error instanceof ExecutionStateConflictError) throw error;
      throw new ExecutionStateConflictError("Execution state is malformed");
    }
  }
}
