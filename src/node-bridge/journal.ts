import { DatabaseSync } from "node:sqlite";
import { assertNoSecretMaterial, sha256Digest } from "../security";
import { opaqueTokenDigest, type JobEventBody, type ReplayGuard, type SignedNodeFrame } from "../node-protocol/v1";
import type { ArtifactLineageRecordV1 } from "../node-executor/artifact-evidence";

export class BridgeBackpressureError extends Error {
  constructor() {
    super("Bridge journal reached its pending-frame ceiling");
    this.name = "BridgeBackpressureError";
  }
}

export interface JournalAttemptSummary {
  attemptId: string;
  jobId: string;
  leaseId: string;
  leaseEpoch: number;
  state: "leased" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  lastEventSequence: number;
  checkpointIds: string[];
}

export interface JournalOutboundFrame {
  frame: SignedNodeFrame;
  status: "pending" | "sent" | "acknowledged" | "expired";
  essential: boolean;
  sendAttempts: number;
}

export interface JournalJobEvent {
  event: JobEventBody;
  eventDigest: string;
  deliveryAttempt: number;
  messageId: string;
  status: "pending" | "staged" | "acknowledged";
}

const terminalEvents = new Set<JobEventBody["event"]>(["completed", "failed", "cancelled"]);

function attemptState(event: JobEventBody["event"]): JournalAttemptSummary["state"] {
  if (event === "completed" || event === "failed" || event === "cancelled" || event === "waiting") return event;
  return "running";
}

function assertEventShape(event: JobEventBody): void {
  if (!Number.isInteger(event.sequence) || event.sequence < 1) throw new Error("Job event sequence must be a positive integer");
  if (!Number.isInteger(event.leaseEpoch) || event.leaseEpoch < 1) throw new Error("Job event lease epoch must be positive");
  if (event.event === "progress" ? event.progressPercent === undefined : event.progressPercent !== undefined) {
    throw new Error("Only progress events may carry progressPercent");
  }
  if (event.event === "checkpointed" ? !event.checkpointId : event.checkpointId !== undefined) {
    throw new Error("Only checkpointed events may carry checkpointId");
  }
  if ((event.event === "failed" || event.event === "cancelled") ? !event.safeReasonCode : event.safeReasonCode !== undefined) {
    throw new Error("Only failed and cancelled events must carry a safe reason code");
  }
  if (event.event !== "completed" && event.artifactManifestIds.length) {
    throw new Error("Only completed events may expose artifact manifest IDs");
  }
}

function assertArtifactLineage(event: JobEventBody, lineage: ArtifactLineageRecordV1 | undefined): void {
  if (event.event !== "completed") {
    if (lineage) throw new Error("Only a completed event may carry artifact lineage");
    return;
  }
  if (!lineage || event.artifactManifestIds.length !== 1) throw new Error("Completed event requires exactly one artifact lineage record");
  const { lineageDigest, ...unsigned } = lineage;
  if (
    lineageDigest !== sha256Digest(unsigned) ||
    lineage.artifactId !== event.artifactManifestIds[0] ||
    lineage.jobId !== event.jobId ||
    lineage.attemptId !== event.attemptId ||
    lineage.manifest.id !== lineage.artifactId ||
    lineage.producerClaim.artifactId !== lineage.artifactId ||
    lineage.independentVerification.status !== "not_run"
  ) {
    throw new Error("Completed event artifact lineage is inconsistent");
  }
  assertNoSecretMaterial(lineage, "durable artifact lineage");
}

export class SqliteBridgeJournal implements ReplayGuard {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly maximumPendingFrames = 10_000) {
    if (!Number.isInteger(maximumPendingFrames) || maximumPendingFrames < 1) throw new Error("Pending-frame ceiling must be positive");
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  nextOutboundSequence(connectionId: string): number {
    const prior = this.db.prepare(`SELECT last_sequence FROM bridge_sequences WHERE connection_id=? AND direction='node_to_server'`).get(connectionId) as { last_sequence: number } | undefined;
    return (prior?.last_sequence ?? 0) + 1;
  }

  stageOutbound(frame: SignedNodeFrame, essential: boolean, createdAt: string): "staged" | "duplicate" | "coalesced" {
    return this.transaction(() => this.stageOutboundWithinTransaction(frame, essential, createdAt));
  }

  appendJobEvent(event: JobEventBody, recordedAt: string, artifactLineage?: ArtifactLineageRecordV1): "recorded" | "duplicate" {
    assertNoSecretMaterial(event, "durable job event");
    assertEventShape(event);
    assertArtifactLineage(event, artifactLineage);
    const eventDigest = sha256Digest(event);
    return this.transaction(() => {
      const duplicate = this.db.prepare(
        `SELECT event_digest,artifact_lineage_digest FROM bridge_job_events WHERE attempt_id=? AND event_sequence=?`,
      ).get(event.attemptId,event.sequence) as { event_digest: string; artifact_lineage_digest: string | null } | undefined;
      if (duplicate) {
        if (duplicate.event_digest !== eventDigest || duplicate.artifact_lineage_digest !== (artifactLineage?.lineageDigest ?? null)) {
          throw new Error("Job event sequence conflicts with different content");
        }
        return "duplicate" as const;
      }
      const prior = this.db.prepare(
        `SELECT job_id,lease_id,lease_epoch,state,last_event_sequence,checkpoint_ids
         FROM bridge_attempts WHERE attempt_id=?`,
      ).get(event.attemptId) as {
        job_id: string; lease_id: string; lease_epoch: number; state: JournalAttemptSummary["state"];
        last_event_sequence: number; checkpoint_ids: string;
      } | undefined;
      if (prior) {
        if (prior.job_id !== event.jobId || prior.lease_id !== event.leaseId || prior.lease_epoch !== event.leaseEpoch) {
          throw new Error("Job event authority conflicts with the durable attempt identity");
        }
        if (terminalEvents.has(prior.state as JobEventBody["event"])) throw new Error("A terminal attempt cannot accept another job event");
        if (event.sequence !== prior.last_event_sequence + 1) throw new Error("Job event sequence is not monotonic");
      } else if (event.sequence !== 1) {
        throw new Error("A durable attempt must begin at job event sequence 1");
      }
      const checkpointIds = prior ? JSON.parse(prior.checkpoint_ids) as string[] : [];
      if (event.checkpointId && !checkpointIds.includes(event.checkpointId)) checkpointIds.push(event.checkpointId);
      this.db.prepare(
        `INSERT INTO bridge_attempts(attempt_id,job_id,lease_id,lease_epoch,state,last_event_sequence,checkpoint_ids,updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(attempt_id) DO UPDATE SET state=excluded.state,last_event_sequence=excluded.last_event_sequence,
           checkpoint_ids=excluded.checkpoint_ids,updated_at=excluded.updated_at`,
      ).run(event.attemptId,event.jobId,event.leaseId,event.leaseEpoch,attemptState(event.event),event.sequence,JSON.stringify(checkpointIds),recordedAt);
      if (artifactLineage) {
        this.db.prepare(
          `INSERT INTO bridge_artifact_lineage
           (artifact_id,attempt_id,lineage_json,lineage_digest,manifest_digest,claim_digest,verification_state,recorded_at)
           VALUES (?,?,?,?,?,?,'not_run',?)`,
        ).run(
          artifactLineage.artifactId,event.attemptId,JSON.stringify(artifactLineage),artifactLineage.lineageDigest,
          artifactLineage.producerClaim.manifestDigest,artifactLineage.producerClaim.claimDigest,recordedAt,
        );
      }
      this.db.prepare(
        `INSERT INTO bridge_job_events
         (attempt_id,event_sequence,event_json,event_digest,status,delivery_attempt,recorded_at,artifact_id,artifact_lineage_digest)
         VALUES (?,?,?,?,'pending',0,?,?,?)`,
      ).run(
        event.attemptId,event.sequence,JSON.stringify(event),eventDigest,recordedAt,
        artifactLineage?.artifactId ?? null,artifactLineage?.lineageDigest ?? null,
      );
      return "recorded" as const;
    });
  }

  artifactLineage(artifactId: string): ArtifactLineageRecordV1 | undefined {
    const row = this.db.prepare(
      `SELECT lineage_json,lineage_digest FROM bridge_artifact_lineage WHERE artifact_id=?`,
    ).get(artifactId) as { lineage_json: string; lineage_digest: string } | undefined;
    if (!row) return undefined;
    const lineage = JSON.parse(row.lineage_json) as ArtifactLineageRecordV1;
    if (lineage.lineageDigest !== row.lineage_digest) throw new Error("Durable artifact lineage digest mismatch");
    assertArtifactLineage({
      jobId: lineage.jobId,
      attemptId: lineage.attemptId,
      leaseId: "durable-read-validation",
      leaseEpoch: 1,
      event: "completed",
      sequence: 1,
      occurredAt: lineage.recordedAt,
      artifactManifestIds: [lineage.artifactId],
    }, lineage);
    return structuredClone(lineage);
  }

  pendingJobEvents(): JournalJobEvent[] {
    const rows = this.db.prepare(
      `SELECT event_json,event_digest,status,delivery_attempt,outbound_message_id
       FROM bridge_job_events WHERE status='pending' ORDER BY row_id`,
    ).all() as Array<{
      event_json: string; event_digest: string; status: "pending"; delivery_attempt: number; outbound_message_id: string | null;
    }>;
    return rows.map((row) => ({
      event: JSON.parse(row.event_json) as JobEventBody,
      eventDigest: row.event_digest,
      deliveryAttempt: row.delivery_attempt,
      messageId: row.outbound_message_id ?? `message:job-event:${row.event_digest}:${row.delivery_attempt + 1}`,
      status: row.status,
    }));
  }

  jobEventStatus(attemptId: string, eventSequence: number): JournalJobEvent["status"] | undefined {
    return (this.db.prepare(
      `SELECT status FROM bridge_job_events WHERE attempt_id=? AND event_sequence=?`,
    ).get(attemptId,eventSequence) as { status: JournalJobEvent["status"] } | undefined)?.status;
  }

  stageJobEventOutbound(
    frame: SignedNodeFrame<"job.event">,
    attemptId: string,
    eventSequence: number,
    createdAt: string,
  ): "staged" | "duplicate" {
    return this.transaction(() => {
      const row = this.db.prepare(
        `SELECT event_digest,status,delivery_attempt,outbound_message_id FROM bridge_job_events
         WHERE attempt_id=? AND event_sequence=?`,
      ).get(attemptId,eventSequence) as {
        event_digest: string; status: JournalJobEvent["status"]; delivery_attempt: number; outbound_message_id: string | null;
      } | undefined;
      if (!row) throw new Error("Job event is not durably recorded");
      const expectedMessageId = `message:job-event:${row.event_digest}:${row.delivery_attempt + 1}`;
      if (row.status === "acknowledged") throw new Error("Acknowledged job event cannot be staged again");
      if (row.status === "staged") {
        if (row.outbound_message_id !== frame.messageId) throw new Error("Job event is already linked to another outbound frame");
        const disposition = this.stageOutboundWithinTransaction(frame, true, createdAt);
        if (disposition === "coalesced") throw new Error("Essential job event cannot be coalesced");
        return disposition;
      }
      if (frame.messageId !== expectedMessageId || sha256Digest(frame.body) !== row.event_digest) {
        throw new Error("Outbound job event does not match its durable record");
      }
      const disposition = this.stageOutboundWithinTransaction(frame, true, createdAt);
      if (disposition === "coalesced") throw new Error("Essential job event cannot be coalesced");
      this.db.prepare(
        `UPDATE bridge_job_events SET status='staged',delivery_attempt=delivery_attempt+1,outbound_message_id=?,staged_at=?
         WHERE attempt_id=? AND event_sequence=? AND status='pending'`,
      ).run(frame.messageId,createdAt,attemptId,eventSequence);
      return disposition;
    });
  }

  private stageOutboundWithinTransaction(frame: SignedNodeFrame, essential: boolean, createdAt: string): "staged" | "duplicate" | "coalesced" {
      if (frame.direction !== "node_to_server" || frame.senderKind !== "node") throw new Error("Only node-to-server frames enter the bridge outbox");
      assertNoSecretMaterial(frame.body, "bridge outbox frame");
      const frameDigest = sha256Digest(frame);
      const prior = this.db.prepare(`SELECT frame_digest FROM bridge_outbox WHERE message_id=?`).get(frame.messageId) as { frame_digest: string } | undefined;
      if (prior) {
        if (prior.frame_digest !== frameDigest) throw new Error("Outbound message ID conflicts with different content");
        return "duplicate" as const;
      }
      const count = this.db.prepare(`SELECT count(*) AS count FROM bridge_outbox WHERE status IN ('pending','sent')`).get() as { count: number };
      if (count.count >= this.maximumPendingFrames && frame.type === "node.heartbeat" && !essential) {
        const retained = this.db.prepare(
          `SELECT message_id FROM bridge_outbox WHERE type='node.heartbeat' AND status='pending' AND essential=0 LIMIT 1`,
        ).get();
        if (retained) return "coalesced" as const;
      }
      const after = this.db.prepare(`SELECT count(*) AS count FROM bridge_outbox WHERE status IN ('pending','sent')`).get() as { count: number };
      const effectiveLimit = essential ? this.maximumPendingFrames + 64 : this.maximumPendingFrames;
      if (after.count >= effectiveLimit) throw new BridgeBackpressureError();
      const sequence = this.db.prepare(
        `SELECT last_sequence FROM bridge_sequences WHERE connection_id=? AND direction='node_to_server'`,
      ).get(frame.connectionId) as { last_sequence: number } | undefined;
      const expectedSequence = (sequence?.last_sequence ?? 0) + 1;
      if (frame.sequence !== expectedSequence) throw new Error("Outbound frame sequence is not the next journal sequence");
      this.db.prepare(
        `INSERT INTO bridge_sequences(connection_id,direction,last_sequence) VALUES (?,'node_to_server',?)
         ON CONFLICT(connection_id,direction) DO UPDATE SET last_sequence=excluded.last_sequence`,
      ).run(frame.connectionId,frame.sequence);
      this.db.prepare(
        `INSERT INTO bridge_outbox
         (message_id,connection_id,sequence,type,frame_json,frame_digest,status,essential,send_attempts,created_at,expires_at)
         VALUES (?,?,?,?,?,?,'pending',?,0,?,?)`,
      ).run(frame.messageId,frame.connectionId,frame.sequence,frame.type,JSON.stringify(frame),frameDigest,essential ? 1 : 0,createdAt,frame.expiresAt);
      return "staged" as const;
  }

  markSent(messageId: string, sentAt: string): void {
    const result = this.db.prepare(
      `UPDATE bridge_outbox SET status='sent',send_attempts=send_attempts+1,last_sent_at=?
       WHERE message_id=? AND status IN ('pending','sent')`,
    ).run(sentAt,messageId);
    if (result.changes !== 1) throw new Error("Outbound frame is not sendable");
  }

  acknowledge(messageIds: readonly string[], acknowledgedAt: string): number {
    if (!messageIds.length) return 0;
    return this.transaction(() => {
      let changed = 0;
      const statement = this.db.prepare(
        `UPDATE bridge_outbox SET status='acknowledged',acknowledged_at=?
         WHERE message_id=? AND status IN ('pending','sent')`,
      );
      const acknowledgeEvent = this.db.prepare(
        `UPDATE bridge_job_events SET status='acknowledged',acknowledged_at=?
         WHERE outbound_message_id=? AND status='staged'`,
      );
      for (const messageId of new Set(messageIds)) {
        changed += Number(statement.run(acknowledgedAt,messageId).changes);
        acknowledgeEvent.run(acknowledgedAt,messageId);
      }
      return changed;
    });
  }

  expireBefore(now: string): number {
    return this.transaction(() => {
      const expired = this.db.prepare(
        `SELECT message_id FROM bridge_outbox WHERE status IN ('pending','sent') AND expires_at<=?`,
      ).all(now) as Array<{ message_id: string }>;
      if (!expired.length) return 0;
      const expireFrame = this.db.prepare(
        `UPDATE bridge_outbox SET status='expired' WHERE message_id=? AND status IN ('pending','sent')`,
      );
      const retryEvent = this.db.prepare(
        `UPDATE bridge_job_events SET status='pending',outbound_message_id=NULL,staged_at=NULL
         WHERE outbound_message_id=? AND status='staged'`,
      );
      let changed = 0;
      for (const row of expired) {
        changed += Number(expireFrame.run(row.message_id).changes);
        retryEvent.run(row.message_id);
      }
      return changed;
    });
  }

  retireSupersededControlFrames(currentConnectionId: string): number {
    return Number(this.db.prepare(
      `UPDATE bridge_outbox SET status='expired'
       WHERE status IN ('pending','sent') AND connection_id<>?
         AND type IN ('connection.hello','node.heartbeat','protocol.ack')`,
    ).run(currentConnectionId).changes);
  }

  pendingOutbound(excludeConnectionId?: string): JournalOutboundFrame[] {
    const rows = this.db.prepare(
      `SELECT frame_json,status,essential,send_attempts FROM bridge_outbox
       WHERE status IN ('pending','sent') AND (? IS NULL OR connection_id<>?) ORDER BY created_at,sequence`,
    ).all(excludeConnectionId ?? null,excludeConnectionId ?? null) as Array<{ frame_json: string; status: "pending" | "sent"; essential: number; send_attempts: number }>;
    return rows.map((row) => ({
      frame: JSON.parse(row.frame_json) as SignedNodeFrame,
      status: row.status,
      essential: row.essential === 1,
      sendAttempts: row.send_attempts,
    }));
  }

  recordCommand(frame: SignedNodeFrame, receivedAt: string): "queued" | "duplicate" {
    if (frame.direction !== "server_to_node") throw new Error("Only server commands may enter the local command queue");
    assertNoSecretMaterial(frame.body, "bridge command");
    const digest = sha256Digest(frame);
    const prior = this.db.prepare(`SELECT frame_digest FROM bridge_commands WHERE message_id=?`).get(frame.messageId) as { frame_digest: string } | undefined;
    if (prior) {
      if (prior.frame_digest !== digest) throw new Error("Command message ID conflicts with different content");
      return "duplicate";
    }
    this.db.prepare(
      `INSERT INTO bridge_commands(message_id,type,frame_json,frame_digest,state,received_at) VALUES (?,?,?,?,'queued',?)`,
    ).run(frame.messageId,frame.type,JSON.stringify(frame),digest,receivedAt);
    return "queued";
  }

  queuedCommandCount(): number {
    return (this.db.prepare(`SELECT count(*) AS count FROM bridge_commands WHERE state='queued'`).get() as { count: number }).count;
  }

  highestInboundSequence(): number {
    return (this.db.prepare(`SELECT COALESCE(max(sequence),0) AS sequence FROM bridge_inbox`).get() as { sequence: number }).sequence;
  }

  inboundStatus(messageId: string): "received" | "processed" | undefined {
    return (this.db.prepare(`SELECT status FROM bridge_inbox WHERE message_id=?`).get(messageId) as { status: "received" | "processed" } | undefined)?.status;
  }

  markInboundProcessed(messageId: string, processedAt: string): void {
    const result = this.db.prepare(
      `UPDATE bridge_inbox SET status='processed',processed_at=? WHERE message_id=? AND status IN ('received','processed')`,
    ).run(processedAt,messageId);
    if (result.changes !== 1) throw new Error("Inbound frame is not recorded");
  }

  upsertAttempt(summary: JournalAttemptSummary, updatedAt: string): void {
    assertNoSecretMaterial(summary, "attempt summary");
    this.db.prepare(
      `INSERT INTO bridge_attempts(attempt_id,job_id,lease_id,lease_epoch,state,last_event_sequence,checkpoint_ids,updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(attempt_id) DO UPDATE SET
         job_id=excluded.job_id,lease_id=excluded.lease_id,lease_epoch=excluded.lease_epoch,state=excluded.state,
         last_event_sequence=excluded.last_event_sequence,checkpoint_ids=excluded.checkpoint_ids,updated_at=excluded.updated_at`,
    ).run(summary.attemptId,summary.jobId,summary.leaseId,summary.leaseEpoch,summary.state,summary.lastEventSequence,JSON.stringify(summary.checkpointIds),updatedAt);
  }

  unresolvedAttempts(): JournalAttemptSummary[] {
    const rows = this.db.prepare(
      `SELECT attempt_id,job_id,lease_id,lease_epoch,state,last_event_sequence,checkpoint_ids
       FROM bridge_attempts WHERE state IN ('leased','running','waiting') ORDER BY attempt_id`,
    ).all() as Array<{ attempt_id: string; job_id: string; lease_id: string; lease_epoch: number; state: JournalAttemptSummary["state"]; last_event_sequence: number; checkpoint_ids: string }>;
    return rows.map((row) => ({
      attemptId: row.attempt_id, jobId: row.job_id, leaseId: row.lease_id, leaseEpoch: row.lease_epoch,
      state: row.state, lastEventSequence: row.last_event_sequence, checkpointIds: JSON.parse(row.checkpoint_ids) as string[],
    }));
  }

  async consume(frame: SignedNodeFrame, receivedAt: string): Promise<"accepted" | "duplicate"> {
    if (frame.direction !== "server_to_node" || frame.senderKind !== "control_room") throw new Error("Local replay guard accepts only server frames");
    return this.transaction(() => {
      const frameDigest = sha256Digest(frame);
      const nonceDigest = opaqueTokenDigest(frame.nonce);
      const prior = this.db.prepare(
        `SELECT message_id,nonce_digest,connection_id,sequence,frame_digest FROM bridge_inbox
         WHERE message_id=? OR nonce_digest=?`,
      ).all(frame.messageId,nonceDigest) as Array<{ message_id: string; nonce_digest: string; connection_id: string; sequence: number; frame_digest: string }>;
      if (prior.length) {
        const exact = prior.length === 1 && prior[0].message_id === frame.messageId && prior[0].nonce_digest === nonceDigest
          && prior[0].connection_id === frame.connectionId && prior[0].sequence === frame.sequence && prior[0].frame_digest === frameDigest;
        if (exact) return "duplicate" as const;
        throw new Error("Server message or nonce replay conflict");
      }
      const sequence = this.db.prepare(`SELECT last_sequence FROM bridge_sequences WHERE connection_id=? AND direction='server_to_node'`).get(frame.connectionId) as { last_sequence: number } | undefined;
      if (!sequence) {
        if (frame.sequence !== 1 || !["connection.accepted", "protocol.error"].includes(frame.type)) throw new Error("Server connection must begin at sequence 1");
        this.db.prepare(`INSERT INTO bridge_sequences(connection_id,direction,last_sequence) VALUES (?,'server_to_node',?)`).run(frame.connectionId,frame.sequence);
      } else {
        if (frame.sequence !== sequence.last_sequence + 1) throw new Error("Non-monotonic server sequence");
        this.db.prepare(`UPDATE bridge_sequences SET last_sequence=? WHERE connection_id=? AND direction='server_to_node'`).run(frame.sequence,frame.connectionId);
      }
      this.db.prepare(
        `INSERT INTO bridge_inbox(message_id,nonce_digest,connection_id,sequence,frame_digest,status,received_at,expires_at)
         VALUES (?,?,?,?,?,'received',?,?)`,
      ).run(frame.messageId,nonceDigest,frame.connectionId,frame.sequence,frameDigest,receivedAt,frame.expiresAt);
      return "accepted" as const;
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_sequences (
        connection_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('node_to_server','server_to_node')),
        last_sequence INTEGER NOT NULL CHECK(last_sequence>0),
        PRIMARY KEY(connection_id,direction)
      );
      CREATE TABLE IF NOT EXISTS bridge_outbox (
        message_id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence>0),
        type TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        frame_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','sent','acknowledged','expired')),
        essential INTEGER NOT NULL CHECK(essential IN (0,1)),
        send_attempts INTEGER NOT NULL CHECK(send_attempts>=0),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_sent_at TEXT,
        acknowledged_at TEXT,
        UNIQUE(connection_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS bridge_inbox (
        message_id TEXT PRIMARY KEY,
        nonce_digest TEXT NOT NULL UNIQUE,
        connection_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence>0),
        frame_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('received','processed')),
        received_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        processed_at TEXT,
        UNIQUE(connection_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS bridge_commands (
        message_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        frame_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','handled','rejected')),
        received_at TEXT NOT NULL,
        handled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS bridge_attempts (
        attempt_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL CHECK(lease_epoch>0),
        state TEXT NOT NULL CHECK(state IN ('leased','running','waiting','completed','failed','cancelled')),
        last_event_sequence INTEGER NOT NULL CHECK(last_event_sequence>=0),
        checkpoint_ids TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_artifact_lineage (
        artifact_id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        lineage_json TEXT NOT NULL,
        lineage_digest TEXT NOT NULL UNIQUE,
        manifest_digest TEXT NOT NULL,
        claim_digest TEXT NOT NULL,
        verification_state TEXT NOT NULL CHECK(verification_state IN ('not_run')),
        recorded_at TEXT NOT NULL,
        FOREIGN KEY(attempt_id) REFERENCES bridge_attempts(attempt_id)
      );
      CREATE TABLE IF NOT EXISTS bridge_job_events (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT NOT NULL,
        event_sequence INTEGER NOT NULL CHECK(event_sequence>0),
        event_json TEXT NOT NULL,
        event_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','staged','acknowledged')),
        delivery_attempt INTEGER NOT NULL CHECK(delivery_attempt>=0),
        outbound_message_id TEXT,
        recorded_at TEXT NOT NULL,
        staged_at TEXT,
        acknowledged_at TEXT,
        artifact_id TEXT,
        artifact_lineage_digest TEXT,
        UNIQUE(attempt_id,event_sequence),
        FOREIGN KEY(attempt_id) REFERENCES bridge_attempts(attempt_id),
        FOREIGN KEY(artifact_id) REFERENCES bridge_artifact_lineage(artifact_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS bridge_job_events_outbound_message
        ON bridge_job_events(outbound_message_id) WHERE outbound_message_id IS NOT NULL;
    `);
    const eventColumns = new Set((this.db.prepare(`PRAGMA table_info(bridge_job_events)`).all() as Array<{ name: string }>).map((row) => row.name));
    if (!eventColumns.has("artifact_id")) this.db.exec(`ALTER TABLE bridge_job_events ADD COLUMN artifact_id TEXT REFERENCES bridge_artifact_lineage(artifact_id)`);
    if (!eventColumns.has("artifact_lineage_digest")) this.db.exec(`ALTER TABLE bridge_job_events ADD COLUMN artifact_lineage_digest TEXT`);
    this.db.exec("PRAGMA user_version=3;");
  }
}
