import { DatabaseSync } from "node:sqlite";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import type { ExecutionAuthoritySnapshotV1 } from "./execution-authority";
import {
  applyEffectClaimEvent,
  classifyEffectClaimRecovery,
  computeEffectClaimKey,
  createEffectClaimSnapshot,
  terminalEffectResultDigest,
  validatePreEffectMarkerBinding,
  type EffectClaimEventV1,
  type EffectClaimSnapshotV1,
  type PreEffectMarkerV1,
  type TerminalEffectClaimStateV1,
} from "./effect-claim";

export class EffectClaimConflictError extends Error {
  constructor(message = "Effect claim conflicts with durable history") {
    super(message);
    this.name = "EffectClaimConflictError";
  }
}

export type EffectClaimDispositionV1 = "dispatch_permitted" | "in_progress" | "ambiguous" | "replay_confirmed" | "replay_failed" | "replay_cancelled";

export interface EffectClaimRequestV1 {
  messageId: string;
  execution: ExecutionAuthoritySnapshotV1;
  claimedAt: string;
  /** Optional atomic node-wide admission ceiling. Native start always supplies its local intersection. */
  maximumActiveEffects?: number;
}

export interface EffectClaimTombstoneV1 {
  schema: "control-room.effect-tombstone/v1";
  claimKey: string;
  identityDigest: string;
  terminalDisposition: TerminalEffectClaimStateV1;
  terminalResultDigest: string;
  historyDigest: string;
  compactedAt: string;
  retainUntil: string;
  tombstoneDigest: string;
}

export interface EffectRetentionHorizonsV1 {
  jobRetentionUntil?: string;
  destinationIdempotencyUntil?: string;
  authorityLateDeliveryUntil?: string;
  protocolRetryUntil?: string;
}

export type EffectClaimLookupV1 = { kind: "full"; snapshot: EffectClaimSnapshotV1 } | { kind: "tombstone"; tombstone: EffectClaimTombstoneV1 };

function canonicalInstant(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) {
    throw new EffectClaimConflictError(`${label} is invalid`);
  }
  return value;
}

function disposition(state: EffectClaimSnapshotV1["state"] | TerminalEffectClaimStateV1): EffectClaimDispositionV1 {
  if (state === "claimed" || state === "executing") return "in_progress";
  if (state === "ambiguous") return "ambiguous";
  return `replay_${state}` as EffectClaimDispositionV1;
}

export class SqliteEffectClaimStore {
  private readonly db: DatabaseSync;

  constructor(path: string, options: { testOnlyAllowEphemeral?: boolean } = {}) {
    if ((path === ":memory:" || path.startsWith("file:")) && !options.testOnlyAllowEphemeral) {
      throw new Error("Durable effect claim store requires a filesystem path");
    }
    this.db = new DatabaseSync(path);
    try {
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS effect_claims (
        claim_key TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        admission_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        operation_digest TEXT NOT NULL,
        identity_digest TEXT NOT NULL,
        authority_digest TEXT NOT NULL,
        effective_deadline TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('claimed','executing','confirmed','failed','cancelled','ambiguous')),
        version INTEGER NOT NULL CHECK(version>=1),
        snapshot_digest TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
        ,UNIQUE(execution_id,operation_digest)
      );
      CREATE TABLE IF NOT EXISTS effect_claim_messages (
        message_id TEXT PRIMARY KEY,
        claim_key TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pre_effect_markers (
        claim_key TEXT PRIMARY KEY REFERENCES effect_claims(claim_key) ON DELETE CASCADE,
        marker_id TEXT NOT NULL UNIQUE,
        marker_digest TEXT NOT NULL,
        marker_json TEXT NOT NULL,
        marked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS effect_claim_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        claim_key TEXT NOT NULL REFERENCES effect_claims(claim_key) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        event_digest TEXT NOT NULL,
        transition_digest TEXT NOT NULL,
        event_json TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        UNIQUE(claim_key,event_id)
      );
      CREATE TABLE IF NOT EXISTS effect_tombstones (
        claim_key TEXT PRIMARY KEY,
        identity_digest TEXT NOT NULL,
        terminal_disposition TEXT NOT NULL CHECK(terminal_disposition IN ('confirmed','failed','cancelled')),
        tombstone_digest TEXT NOT NULL,
        tombstone_json TEXT NOT NULL,
        compacted_at TEXT NOT NULL,
        retain_until TEXT NOT NULL
      );
      PRAGMA user_version=1;
    `);
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void {
    this.db.close();
  }

  claim(input: EffectClaimRequestV1): { created: boolean; claimKey: string; disposition: EffectClaimDispositionV1; lookup: EffectClaimLookupV1 } {
    if (input.maximumActiveEffects !== undefined && (!Number.isSafeInteger(input.maximumActiveEffects)
      || input.maximumActiveEffects < 1 || input.maximumActiveEffects > 10_000)) throw new EffectClaimConflictError("Invalid effect capacity ceiling");
    assertNoSecretMaterial(input, "effect claim");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(input.messageId)) throw new EffectClaimConflictError("Delivery message ID is invalid");
    if (input.execution.state !== "executing" && input.execution.state !== "expiring_soon") {
      throw new EffectClaimConflictError("Effect claims require live executing authority");
    }
    const snapshot = createEffectClaimSnapshot({
      executionId: input.execution.executionId,
      admissionId: input.execution.admissionId,
      identity: input.execution.identity,
      authorityDigest: input.execution.authorityDigest,
      effectiveDeadline: input.execution.deadline.effectiveDeadline,
      createdAt: input.claimedAt,
    });
    const snapshotDigest = sha256Digest(snapshot);
    return this.transaction(() => {
      const message = this.db.prepare(`SELECT claim_key FROM effect_claim_messages WHERE message_id=?`).get(input.messageId) as { claim_key: string } | undefined;
      if (message && message.claim_key !== snapshot.claimKey) throw new EffectClaimConflictError("Delivery message aliases a different effect");
      const tombstone = this.loadTombstoneWithin(snapshot.claimKey);
      if (tombstone) {
        if (this.fullRowExists(snapshot.claimKey)) throw new EffectClaimConflictError("Full claim and tombstone coexist");
        if (tombstone.identityDigest !== snapshot.identityDigest) throw new EffectClaimConflictError();
        if (!message) this.db.prepare(`INSERT INTO effect_claim_messages(message_id,claim_key) VALUES (?,?)`).run(input.messageId,snapshot.claimKey);
        return { created: false, claimKey: snapshot.claimKey, disposition: disposition(tombstone.terminalDisposition), lookup: { kind: "tombstone", tombstone } };
      }
      const prior = this.loadFullWithin(snapshot.claimKey, true);
      if (prior) {
        if (prior.identityDigest !== snapshot.identityDigest || prior.executionId !== snapshot.executionId
          || prior.admissionId !== snapshot.admissionId || prior.authorityDigest !== snapshot.authorityDigest
          || prior.effectiveDeadline !== snapshot.effectiveDeadline) throw new EffectClaimConflictError();
        if (!message) this.db.prepare(`INSERT INTO effect_claim_messages(message_id,claim_key) VALUES (?,?)`).run(input.messageId,snapshot.claimKey);
        return { created: false, claimKey: prior.claimKey, disposition: disposition(prior.state), lookup: { kind: "full", snapshot: prior } };
      }
      if (message) throw new EffectClaimConflictError();
      if (input.maximumActiveEffects !== undefined
        && this.countActiveWithin(snapshot.identity.tenantId, snapshot.identity.nodeId) >= input.maximumActiveEffects)
        throw new EffectClaimConflictError("Effect capacity exhausted");
      this.db.prepare(`INSERT INTO effect_claims(
        claim_key,execution_id,admission_id,tenant_id,node_id,project_id,job_id,attempt_id,operation_digest,
        identity_digest,authority_digest,effective_deadline,state,version,snapshot_digest,snapshot_json,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        snapshot.claimKey,snapshot.executionId,snapshot.admissionId,snapshot.identity.tenantId,snapshot.identity.nodeId,
        snapshot.identity.projectId,snapshot.identity.jobId,snapshot.identity.attemptId,snapshot.identity.operationDigest,
        snapshot.identityDigest,snapshot.authorityDigest,snapshot.effectiveDeadline,snapshot.state,snapshot.version,
        snapshotDigest,JSON.stringify(snapshot),snapshot.updatedAt,
      );
      this.db.prepare(`INSERT INTO effect_claim_messages(message_id,claim_key) VALUES (?,?)`).run(input.messageId,snapshot.claimKey);
      const event = { eventId: `claimed:${snapshot.claimKey}`, kind: "claimed", occurredAt: snapshot.createdAt };
      this.insertEvent(snapshot.claimKey,event,null,"claimed");
      return { created: true, claimKey: snapshot.claimKey, disposition: "dispatch_permitted", lookup: { kind: "full", snapshot } };
    });
  }

  commitPreEffectMarker(marker: PreEffectMarkerV1): { disposition: "committed" | "duplicate"; snapshot: EffectClaimSnapshotV1 } {
    assertNoSecretMaterial(marker, "pre-effect marker");
    const markerDigest = sha256Digest(marker);
    return this.transaction(() => {
      const priorMarker = this.db.prepare(`SELECT marker_digest FROM pre_effect_markers WHERE claim_key=? OR marker_id=?`).get(marker.claimKey,marker.markerId) as { marker_digest: string } | undefined;
      if (priorMarker) {
        if (priorMarker.marker_digest !== markerDigest) throw new EffectClaimConflictError("Pre-effect marker conflicts with durable history");
        const snapshot = this.requireFullWithin(marker.claimKey);
        return { disposition: "duplicate", snapshot };
      }
      const before = this.requireFullWithin(marker.claimKey);
      try {
        validatePreEffectMarkerBinding(marker,before);
      } catch {
        throw new EffectClaimConflictError("Pre-effect marker binding mismatch");
      }
      const event: EffectClaimEventV1 = { eventId: marker.markerId, kind: "marker_committed", markerDigest, occurredAt: marker.markedAt };
      const after = applyEffectClaimEvent(before,event);
      this.db.prepare(`INSERT INTO pre_effect_markers(claim_key,marker_id,marker_digest,marker_json,marked_at) VALUES (?,?,?,?,?)`).run(
        marker.claimKey,marker.markerId,markerDigest,JSON.stringify(marker),marker.markedAt,
      );
      this.persistTransition(before,after,event);
      return { disposition: "committed", snapshot: after };
    });
  }

  apply(claimKey: string, event: Exclude<EffectClaimEventV1, { kind: "marker_committed" }>): { disposition: "applied" | "duplicate"; snapshot: EffectClaimSnapshotV1 } {
    return this.applyWithinGuard(claimKey, event);
  }

  /** Trusted local settlement seam, not evidence verification. Both checks run
   * synchronously under the write lock; a failed post-write check rolls back the
   * event and capacity change. The caller must verify all non-claim evidence.
   * Exact replay also requires the expected CURRENT snapshot and fresh checks. */
  applyChecked(claimKey: string, event: Exclude<EffectClaimEventV1, { kind: "marker_committed" }>, guard: {
    expectedSnapshotDigest: string;
    verifyCurrent(snapshotDigest: string): true;
  }): { disposition: "applied" | "duplicate"; snapshot: EffectClaimSnapshotV1 } {
    const expectedSnapshotDigest = guard.expectedSnapshotDigest, verifyCurrent = guard.verifyCurrent.bind(guard);
    if (!/^sha256:[a-f0-9]{64}$/.test(expectedSnapshotDigest)) throw new EffectClaimConflictError("Invalid expected effect snapshot");
    return this.applyWithinGuard(claimKey, event, { expectedSnapshotDigest, verifyCurrent });
  }

  private applyWithinGuard(claimKey: string, input: Exclude<EffectClaimEventV1, { kind: "marker_committed" }>, guard?: {
    expectedSnapshotDigest: string;
    verifyCurrent(snapshotDigest: string): true;
  }): { disposition: "applied" | "duplicate"; snapshot: EffectClaimSnapshotV1 } {
    // A trusted reader must not accidentally mutate the event being committed.
    const event = structuredClone(input);
    assertNoSecretMaterial(event, "effect claim event");
    return this.transaction(() => {
      const before = this.requireFullWithin(claimKey), beforeDigest = sha256Digest(before);
      const check = (expected: string) => {
        if (guard) {
          const accepted: unknown = guard.verifyCurrent(expected);
          // Reject async verification without leaving a late rejection unobserved.
          // Do not invoke arbitrary thenables to decide synchronous acceptance.
          if (accepted instanceof Promise) Promise.prototype.then.call(accepted, undefined, () => undefined);
          if (accepted !== true) throw new EffectClaimConflictError("Effect settlement check failed");
        }
        if (sha256Digest(this.requireFullWithin(claimKey)) !== expected) throw new EffectClaimConflictError("Effect snapshot changed during verification");
      };
      if (guard && guard.expectedSnapshotDigest !== beforeDigest) throw new EffectClaimConflictError("Effect snapshot is stale");
      if (guard) check(beforeDigest);
      const eventDigest = sha256Digest(event);
      const prior = this.db.prepare(`SELECT event_digest FROM effect_claim_events WHERE claim_key=? AND event_id=?`).get(claimKey,event.eventId) as { event_digest: string } | undefined;
      if (prior) {
        if (prior.event_digest !== eventDigest) throw new EffectClaimConflictError("Effect event ID was reused with different content");
        if (guard) check(beforeDigest);
        return { disposition: "duplicate", snapshot: this.requireFullWithin(claimKey) };
      }
      const after = applyEffectClaimEvent(before,event);
      this.persistTransition(before,after,event);
      if (guard) check(sha256Digest(after));
      return { disposition: "applied", snapshot: after };
    });
  }

  recover(claimKey: string, eventId: string, recoveredAt: string): { action: "re_evaluate_claimed" | "ambiguous" | "await_evidence" | "replay_terminal"; snapshot: EffectClaimSnapshotV1 } {
    return this.transaction(() => {
      const snapshot = this.requireFullWithin(claimKey);
      const classification = classifyEffectClaimRecovery(snapshot);
      if (classification === "re_evaluate_claimed") return { action: classification, snapshot };
      if (classification === "mark_ambiguous") {
        const event: EffectClaimEventV1 = { eventId,kind: "ambiguity_raised",reason: "restart",occurredAt: recoveredAt };
        const eventDigest = sha256Digest(event);
        const prior = this.db.prepare(`SELECT event_digest FROM effect_claim_events WHERE claim_key=? AND event_id=?`).get(claimKey,eventId) as { event_digest: string } | undefined;
        if (prior) {
          if (prior.event_digest !== eventDigest) throw new EffectClaimConflictError("Effect event ID was reused with different content");
          return { action: "ambiguous", snapshot };
        }
        const after = applyEffectClaimEvent(snapshot,event);
        this.persistTransition(snapshot,after,event);
        return { action: "ambiguous", snapshot: after };
      }
      return { action: classification === "await_evidence" ? "await_evidence" : "replay_terminal", snapshot };
    });
  }

  load(claimKey: string): EffectClaimLookupV1 | undefined {
    const tombstone = this.loadTombstoneWithin(claimKey);
    if (tombstone) {
      if (this.fullRowExists(claimKey)) throw new EffectClaimConflictError("Full claim and tombstone coexist");
      return { kind: "tombstone", tombstone };
    }
    const snapshot = this.loadFullWithin(claimKey, true);
    return snapshot ? { kind: "full", snapshot } : undefined;
  }

  /** Historical protected-store evidence, not current cleanup or execution authority. */
  confirmation(claimKey: string): { snapshot: EffectClaimSnapshotV1; event: Extract<EffectClaimEventV1, { kind: "confirmed" }> } | undefined {
    return this.transaction(() => {
      const lookup = this.load(claimKey);
      if (lookup?.kind !== "full" || lookup.snapshot.state !== "confirmed") return undefined;
      const row = this.db.prepare(`SELECT event_json FROM effect_claim_events WHERE claim_key=? ORDER BY sequence DESC LIMIT 1`).get(claimKey) as { event_json: string } | undefined;
      if (!row) throw new EffectClaimConflictError("Effect confirmation event is missing");
      const event = JSON.parse(row.event_json) as EffectClaimEventV1;
      if (event.kind !== "confirmed" || event.destinationReceiptDigest !== lookup.snapshot.destinationReceiptDigest
        || event.occurredAt !== lookup.snapshot.updatedAt) throw new EffectClaimConflictError("Effect confirmation event mismatch");
      return { snapshot: lookup.snapshot, event };
    });
  }

  compactTerminal(claimKey: string, horizons: EffectRetentionHorizonsV1, compactedAt: string): { disposition: "compacted" | "retained_unknown_horizon" | "retained_until"; retainUntil?: string; tombstone?: EffectClaimTombstoneV1 } {
    const values = [horizons.jobRetentionUntil,horizons.destinationIdempotencyUntil,horizons.authorityLateDeliveryUntil,horizons.protocolRetryUntil];
    if (values.some((value) => value === undefined)) return { disposition: "retained_unknown_horizon" };
    const normalized = values.map((value) => canonicalInstant(value as string,"Retention horizon"));
    const retainUntil = new Date(Math.max(...normalized.map(Date.parse))).toISOString();
    const now = canonicalInstant(compactedAt,"Compaction time");
    if (Date.parse(now) < Date.parse(retainUntil)) return { disposition: "retained_until", retainUntil };
    return this.transaction(() => {
      const priorTombstone = this.loadTombstoneWithin(claimKey);
      if (priorTombstone) {
        if (this.fullRowExists(claimKey)) throw new EffectClaimConflictError("Full claim and tombstone coexist");
        return { disposition: "compacted", retainUntil: priorTombstone.retainUntil, tombstone: priorTombstone };
      }
      const snapshot = this.requireFullWithin(claimKey);
      if (!(["confirmed","failed","cancelled"] as string[]).includes(snapshot.state)) throw new EffectClaimConflictError("Only settled terminal claims may compact");
      const terminalDisposition = snapshot.state as TerminalEffectClaimStateV1;
      const eventDigests = (this.db.prepare(`SELECT event_digest FROM effect_claim_events WHERE claim_key=? ORDER BY sequence`).all(claimKey) as Array<{ event_digest: string }>).map((row) => row.event_digest);
      const material = {
        schema: "control-room.effect-tombstone/v1" as const, claimKey, identityDigest: snapshot.identityDigest,
        terminalDisposition, terminalResultDigest: terminalEffectResultDigest(snapshot), historyDigest: sha256Digest(eventDigests),
        compactedAt: now, retainUntil,
      };
      const tombstone: EffectClaimTombstoneV1 = { ...material, tombstoneDigest: sha256Digest(material) };
      this.db.prepare(`INSERT INTO effect_tombstones(claim_key,identity_digest,terminal_disposition,tombstone_digest,tombstone_json,compacted_at,retain_until) VALUES (?,?,?,?,?,?,?)`).run(
        claimKey,tombstone.identityDigest,tombstone.terminalDisposition,tombstone.tombstoneDigest,JSON.stringify(tombstone),now,retainUntil,
      );
      this.db.prepare(`DELETE FROM effect_claims WHERE claim_key=?`).run(claimKey);
      return { disposition: "compacted", retainUntil, tombstone };
    });
  }

  countFull(): number {
    return Number((this.db.prepare(`SELECT count(*) AS count FROM effect_claims`).get() as { count: number }).count);
  }

  /** Count integrity-checked unsettled claims, including claimed/ambiguous effects. A missing
   * result never releases capacity. Bound the full-record scan; retention is explicit owner work. */
  countActive(tenantId: string, nodeId: string): number {
    return this.transaction(() => this.countActiveWithin(tenantId, nodeId));
  }

  private countActiveWithin(tenantId: string, nodeId: string): number {
    const rows = this.db.prepare("SELECT claim_key FROM effect_claims LIMIT 10001").all() as Array<{ claim_key: string }>;
    if (rows.length > 10_000) throw new EffectClaimConflictError("Effect capacity evidence unavailable");
    let count = 0;
    // Do not trust mutable indexed tenant/node/state projections to hide a corrupt active claim.
    for (const row of rows) {
      const claim = this.loadFullWithin(row.claim_key, true);
      if (!claim) throw new EffectClaimConflictError("Effect capacity evidence unavailable");
      if (claim.identity.tenantId === tenantId && claim.identity.nodeId === nodeId
        && ["claimed", "executing", "ambiguous"].includes(claim.state)) count++;
    }
    return count;
  }

  countTombstones(): number {
    return Number((this.db.prepare(`SELECT count(*) AS count FROM effect_tombstones`).get() as { count: number }).count);
  }

  private persistTransition(before: EffectClaimSnapshotV1, after: EffectClaimSnapshotV1, event: EffectClaimEventV1): void {
    const snapshotDigest = sha256Digest(after);
    const changed = this.db.prepare(`UPDATE effect_claims SET state=?,version=?,snapshot_digest=?,snapshot_json=?,updated_at=? WHERE claim_key=? AND version=?`).run(
      after.state,after.version,snapshotDigest,JSON.stringify(after),after.updatedAt,after.claimKey,before.version,
    );
    if (Number(changed.changes) !== 1) throw new EffectClaimConflictError("Effect claim changed concurrently");
    this.insertEvent(after.claimKey,event,before.state,after.state);
  }

  private insertEvent(claimKey: string, event: object, fromState: string | null, toState: string): void {
    const typed = event as { eventId: string; occurredAt: string };
    const eventDigest = sha256Digest(event);
    const transitionDigest = sha256Digest({ event,fromState,toState });
    this.db.prepare(`INSERT INTO effect_claim_events(claim_key,event_id,event_digest,transition_digest,event_json,from_state,to_state,occurred_at) VALUES (?,?,?,?,?,?,?,?)`).run(
      claimKey,typed.eventId,eventDigest,transitionDigest,JSON.stringify(event),fromState,toState,typed.occurredAt,
    );
  }

  private requireFullWithin(claimKey: string): EffectClaimSnapshotV1 {
    const snapshot = this.loadFullWithin(claimKey, true);
    if (!snapshot) throw new EffectClaimConflictError("Effect claim is missing");
    return snapshot;
  }

  private loadFullWithin(claimKey: string, verifyMarker: boolean): EffectClaimSnapshotV1 | undefined {
    const row = this.db.prepare(`SELECT * FROM effect_claims WHERE claim_key=?`).get(claimKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    try {
      const snapshot = JSON.parse(String(row.snapshot_json)) as EffectClaimSnapshotV1;
      if (sha256Digest(snapshot) !== String(row.snapshot_digest)
        || snapshot.claimKey !== String(row.claim_key) || computeEffectClaimKey(snapshot.identity) !== snapshot.claimKey
        || snapshot.executionId !== String(row.execution_id) || snapshot.admissionId !== String(row.admission_id)
        || snapshot.identity.tenantId !== String(row.tenant_id) || snapshot.identity.nodeId !== String(row.node_id)
        || snapshot.identity.projectId !== String(row.project_id) || snapshot.identity.jobId !== String(row.job_id)
        || snapshot.identity.attemptId !== String(row.attempt_id) || snapshot.identity.operationDigest !== String(row.operation_digest)
        || snapshot.identityDigest !== String(row.identity_digest) || sha256Digest(snapshot.identity) !== snapshot.identityDigest
        || snapshot.authorityDigest !== String(row.authority_digest) || snapshot.effectiveDeadline !== String(row.effective_deadline)
        || snapshot.state !== String(row.state) || snapshot.version !== Number(row.version) || snapshot.updatedAt !== String(row.updated_at)) {
        throw new EffectClaimConflictError("Effect claim mirror or digest mismatch");
      }
      if (verifyMarker) {
        const marker = this.db.prepare(`SELECT marker_digest,marker_json FROM pre_effect_markers WHERE claim_key=?`).get(claimKey) as { marker_digest: string; marker_json: string } | undefined;
        if ((marker?.marker_digest ?? undefined) !== snapshot.markerDigest) throw new EffectClaimConflictError("Effect marker mirror mismatch");
        if (marker && sha256Digest(JSON.parse(marker.marker_json)) !== marker.marker_digest) throw new EffectClaimConflictError("Effect marker digest mismatch");
        this.verifyHistoryWithin(snapshot);
      }
      return snapshot;
    } catch (error) {
      if (error instanceof EffectClaimConflictError) throw error;
      throw new EffectClaimConflictError("Effect claim is malformed");
    }
  }

  private verifyHistoryWithin(snapshot: EffectClaimSnapshotV1): void {
    const rows = this.db.prepare(`SELECT event_id,occurred_at,event_digest,transition_digest,event_json,from_state,to_state FROM effect_claim_events WHERE claim_key=? ORDER BY sequence`).all(snapshot.claimKey) as Array<{
      event_id: string; occurred_at: string; event_digest: string; transition_digest: string; event_json: string; from_state: string | null; to_state: string;
    }>;
    if (rows.length !== snapshot.version) throw new EffectClaimConflictError("Effect history length mismatch");
    let priorState: string | null = null;
    let replay = createEffectClaimSnapshot({
      executionId: snapshot.executionId,
      admissionId: snapshot.admissionId,
      identity: snapshot.identity,
      authorityDigest: snapshot.authorityDigest,
      effectiveDeadline: snapshot.effectiveDeadline,
      createdAt: snapshot.createdAt,
    });
    for (const [index,row] of rows.entries()) {
      const event = JSON.parse(row.event_json) as { eventId: string; occurredAt: string };
      if (sha256Digest(event) !== row.event_digest
        || event.eventId !== row.event_id || event.occurredAt !== row.occurred_at
        || row.transition_digest !== sha256Digest({ event,fromState: row.from_state,toState: row.to_state })
        || row.from_state !== priorState) throw new EffectClaimConflictError("Effect history digest or chain mismatch");
      priorState = row.to_state;
      if (index === 0) {
        const expectedCreation = { eventId: `claimed:${snapshot.claimKey}`,kind: "claimed",occurredAt: snapshot.createdAt };
        if (row.from_state !== null || row.to_state !== "claimed" || sha256Digest(event) !== sha256Digest(expectedCreation)) {
          throw new EffectClaimConflictError("Effect creation event mismatch");
        }
      } else {
        const transitioned = applyEffectClaimEvent(replay,event as EffectClaimEventV1);
        if (!transitioned) throw new EffectClaimConflictError("Effect history event is invalid");
        replay = transitioned;
      }
    }
    if (priorState !== snapshot.state || sha256Digest(replay) !== sha256Digest(snapshot)) {
      throw new EffectClaimConflictError("Effect history terminal state mismatch");
    }
  }

  private fullRowExists(claimKey: string): boolean {
    return this.db.prepare(`SELECT 1 AS present FROM effect_claims WHERE claim_key=?`).get(claimKey) !== undefined;
  }

  private loadTombstoneWithin(claimKey: string): EffectClaimTombstoneV1 | undefined {
    const row = this.db.prepare(`SELECT * FROM effect_tombstones WHERE claim_key=?`).get(claimKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    try {
      const tombstone = JSON.parse(String(row.tombstone_json)) as EffectClaimTombstoneV1;
      const { tombstoneDigest, ...material } = tombstone;
      if (tombstone.schema !== "control-room.effect-tombstone/v1"
        || !/^sha256:[a-f0-9]{64}$/.test(tombstone.claimKey)
        || !/^sha256:[a-f0-9]{64}$/.test(tombstone.identityDigest)
        || !/^sha256:[a-f0-9]{64}$/.test(tombstone.terminalResultDigest)
        || !/^sha256:[a-f0-9]{64}$/.test(tombstone.historyDigest)
        || !/^sha256:[a-f0-9]{64}$/.test(tombstone.tombstoneDigest)
        || canonicalInstant(tombstone.compactedAt,"Tombstone compaction time") !== tombstone.compactedAt
        || canonicalInstant(tombstone.retainUntil,"Tombstone retention time") !== tombstone.retainUntil
        || sha256Digest(material) !== tombstoneDigest || tombstoneDigest !== String(row.tombstone_digest)
        || tombstone.claimKey !== String(row.claim_key) || tombstone.identityDigest !== String(row.identity_digest)
        || tombstone.terminalDisposition !== String(row.terminal_disposition)
        || tombstone.compactedAt !== String(row.compacted_at) || tombstone.retainUntil !== String(row.retain_until)) {
        throw new EffectClaimConflictError("Effect tombstone mirror or digest mismatch");
      }
      return tombstone;
    } catch (error) {
      if (error instanceof EffectClaimConflictError) throw error;
      throw new EffectClaimConflictError("Effect tombstone is malformed");
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* retain original failure */ }
      if (error instanceof EffectClaimConflictError) throw error;
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) throw new EffectClaimConflictError();
      throw error;
    }
  }
}
