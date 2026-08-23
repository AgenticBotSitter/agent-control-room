import { messageEnvelopeSchema, type MessageEnvelope } from "../domain/v1";
import { assertDigest, assertNoSecretMaterial } from "../security";
import type { DatabaseClient, DatabaseSession } from "./database";

function json(value: unknown): string {
  return JSON.stringify(value);
}

function assertSafeFailureCode(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) throw new Error("Safe failure code is invalid");
}

export interface InboxRef {
  tenantId: string;
  protocol: string;
  messageId: string;
}

export interface OutboxMessage {
  id: string;
  tenantId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  idempotencyKey: string;
  attempts: number;
  payload: unknown;
}

export interface InboxProcessingOptions {
  /** Total handler attempts, including the successful attempt if one occurs. */
  maxAttempts?: number;
  /** Stable, non-sensitive code recorded when the handler fails. */
  safeFailureCode?: string;
}

export class DeliveryStore {
  constructor(private readonly db: DatabaseClient) {}

  async receive(envelope: MessageEnvelope, options: { now?: string; maxFutureSkewSeconds?: number } = {}): Promise<{ replayed: boolean }> {
    const validated = messageEnvelopeSchema.parse(envelope) as MessageEnvelope;
    const now = Date.parse(options.now ?? new Date().toISOString());
    const maxFutureSkew = (options.maxFutureSkewSeconds ?? 300) * 1_000;
    if (Date.parse(validated.expiresAt) <= now) throw new Error("Inbox message has expired");
    if (Date.parse(validated.sentAt) > now + maxFutureSkew) throw new Error("Inbox message timestamp is too far in the future");
    assertDigest(validated.body, validated.bodyDigest, "Inbox body");
    assertNoSecretMaterial(validated.body, "Inbox body");
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query<{ message_id: string }>(
        `INSERT INTO control_inbox (tenant_id,protocol,message_id,body_digest,payload)
         VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING message_id`,
        [validated.tenantId, validated.protocol, validated.messageId, validated.bodyDigest, json(validated)],
      );
      if (inserted.rows.length) return { replayed: false };
      const prior = await tx.query<{ body_digest: string }>(
        `SELECT body_digest FROM control_inbox WHERE tenant_id=$1 AND protocol=$2 AND message_id=$3`,
        [validated.tenantId, validated.protocol, validated.messageId],
      );
      if (prior.rows[0]?.body_digest !== validated.bodyDigest) throw new Error("Inbox message ID reused with a different body digest");
      return { replayed: true };
    });
  }

  async processOnce<T>(
    ref: InboxRef,
    handler: (tx: DatabaseSession, envelope: MessageEnvelope) => Promise<T>,
    options: InboxProcessingOptions = {},
  ): Promise<{ result?: T; replayed: boolean }> {
    const maxAttempts = options.maxAttempts ?? 3;
    const safeFailureCode = options.safeFailureCode ?? "handler_failed";
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("Inbox maxAttempts must be a positive integer");
    assertSafeFailureCode(safeFailureCode);

    let handlerStarted = false;
    try {
      return await this.db.transaction(async (tx) => {
        const row = await tx.query<{ status: string; payload: MessageEnvelope }>(
          `SELECT status,payload FROM control_inbox WHERE tenant_id=$1 AND protocol=$2 AND message_id=$3 FOR UPDATE`,
          [ref.tenantId, ref.protocol, ref.messageId],
        );
        if (!row.rows[0]) throw new Error("Inbox message not found");
        if (row.rows[0].status === "processed") return { replayed: true };
        if (row.rows[0].status === "failed") throw new Error("Inbox message is parked after repeated failures");
        if (row.rows[0].status === "processing") throw new Error("Inbox message is already processing");

        await tx.query(
          `UPDATE control_inbox SET status='processing',attempts=attempts+1,safe_failure_code=NULL
           WHERE tenant_id=$1 AND protocol=$2 AND message_id=$3`,
          [ref.tenantId, ref.protocol, ref.messageId],
        );
        handlerStarted = true;
        const result = await handler(tx, messageEnvelopeSchema.parse(row.rows[0].payload) as MessageEnvelope);
        await tx.query(
          `UPDATE control_inbox SET status='processed',processed_at=now()
           WHERE tenant_id=$1 AND protocol=$2 AND message_id=$3`,
          [ref.tenantId, ref.protocol, ref.messageId],
        );
        return { result, replayed: false };
      });
    } catch (error) {
      if (handlerStarted) {
        try {
          await this.recordInboxFailure(ref, maxAttempts, safeFailureCode);
        } catch (recordError) {
          throw new AggregateError([error, recordError], "Inbox handler and durable failure recording both failed");
        }
      }
      throw error;
    }
  }

  async executeIdempotent<T>(input: {
    tenantId: string;
    operationScope: string;
    idempotencyKey: string;
    requestDigest: string;
  }, operation: (tx: DatabaseSession) => Promise<T>): Promise<{ result: T; replayed: boolean }> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query<{ idempotency_key: string }>(
        `INSERT INTO control_idempotency (tenant_id,operation_scope,idempotency_key,request_digest,status)
         VALUES ($1,$2,$3,$4,'processing') ON CONFLICT DO NOTHING RETURNING idempotency_key`,
        [input.tenantId, input.operationScope, input.idempotencyKey, input.requestDigest],
      );
      if (!inserted.rows.length) {
        const prior = await tx.query<{ request_digest: string; status: string; result: T }>(
          `SELECT request_digest,status,result FROM control_idempotency
           WHERE tenant_id=$1 AND operation_scope=$2 AND idempotency_key=$3 FOR UPDATE`,
          [input.tenantId, input.operationScope, input.idempotencyKey],
        );
        if (!prior.rows[0]) throw new Error("Idempotency record disappeared");
        if (prior.rows[0].request_digest !== input.requestDigest) throw new Error("Idempotency key reused with a different request digest");
        if (prior.rows[0].status !== "completed") throw new Error("Idempotent operation is still processing");
        return { result: prior.rows[0].result, replayed: true };
      }

      const result = await operation(tx);
      if (result === undefined) throw new Error("Idempotent operations must return a JSON value; undefined is not replayable");
      await tx.query(
        `UPDATE control_idempotency SET status='completed',result=$1::jsonb,completed_at=now()
         WHERE tenant_id=$2 AND operation_scope=$3 AND idempotency_key=$4 AND status='processing'`,
        [json(result), input.tenantId, input.operationScope, input.idempotencyKey],
      );
      return { result, replayed: false };
    });
  }

  async claimOutbox(input: { tenantId: string; claimToken: string; limit: number; maxAttempts: number; now: string }): Promise<OutboxMessage[]> {
    if (!input.tenantId || input.claimToken.length < 12) throw new Error("Outbox claim scope or token is invalid");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) throw new Error("Outbox claim limit is invalid");
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) throw new Error("Outbox maxAttempts is invalid");
    return this.db.transaction(async (tx) => {
      const claimed = await tx.query<{
        id: string; tenant_id: string; topic: string; aggregate_type: string; aggregate_id: string;
        idempotency_key: string; attempts: number; payload: unknown;
      }>(
        `WITH candidates AS (
           SELECT id FROM control_outbox
           WHERE tenant_id=$5 AND status IN ('pending','failed') AND available_at <= $1 AND attempts < $4
           ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE control_outbox o SET status='processing',claim_token=$3,claimed_at=$1,attempts=o.attempts+1,safe_failure_code=NULL
         FROM candidates c WHERE o.id=c.id
         RETURNING o.id,o.tenant_id,o.topic,o.aggregate_type,o.aggregate_id,o.idempotency_key,o.attempts,o.payload`,
        [input.now, input.limit, input.claimToken, input.maxAttempts, input.tenantId],
      );
      return claimed.rows.map((row) => ({
        id: row.id, tenantId: row.tenant_id, topic: row.topic, aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id, idempotencyKey: row.idempotency_key, attempts: row.attempts, payload: row.payload,
      }));
    });
  }

  async markOutboxDelivered(tenantId: string, id: string, claimToken: string, deliveredAt: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE control_outbox SET status='delivered',delivered_at=$1,claim_token=NULL
       WHERE tenant_id=$2 AND id=$3 AND status='processing' AND claim_token=$4 RETURNING id`,
      [deliveredAt, tenantId, id, claimToken],
    );
    if (result.rows.length === 1) return;
    const prior = await this.db.query<{ status: string }>(`SELECT status FROM control_outbox WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    if (prior.rows[0]?.status !== "delivered") throw new Error("Outbox claim is stale or missing");
  }

  async markOutboxFailed(input: { tenantId: string; id: string; claimToken: string; availableAt: string; safeFailureCode: string; maxAttempts: number }): Promise<void> {
    assertSafeFailureCode(input.safeFailureCode);
    const result = await this.db.query(
      `UPDATE control_outbox SET status=CASE WHEN attempts >= $6 THEN 'dead_letter' ELSE 'failed' END,
         available_at=$1,safe_failure_code=$2,claim_token=NULL
       WHERE tenant_id=$3 AND id=$4 AND status='processing' AND claim_token=$5 RETURNING id`,
      [input.availableAt, input.safeFailureCode, input.tenantId, input.id, input.claimToken, input.maxAttempts],
    );
    if (result.rows.length !== 1) throw new Error("Outbox claim is stale or missing");
  }

  async recoverStaleOutbox(input: { tenantId: string; claimedBefore: string; availableAt: string; safeFailureCode: string; maxAttempts: number }): Promise<number> {
    assertSafeFailureCode(input.safeFailureCode);
    const recovered = await this.db.query<{ id: string }>(
      `UPDATE control_outbox SET
         status=CASE WHEN attempts >= $4 THEN 'dead_letter' ELSE 'failed' END,
         available_at=$2,safe_failure_code=$3,claim_token=NULL
       WHERE tenant_id=$5 AND status='processing' AND claimed_at <= $1 RETURNING id`,
      [input.claimedBefore, input.availableAt, input.safeFailureCode, input.maxAttempts, input.tenantId],
    );
    return recovered.rows.length;
  }

  private async recordInboxFailure(ref: InboxRef, maxAttempts: number, safeFailureCode: string): Promise<void> {
    const recorded = await this.db.query(
      `UPDATE control_inbox SET
         attempts=attempts+1,
         status=CASE WHEN attempts+1 >= $4 THEN 'failed' ELSE 'received' END,
         safe_failure_code=$5,
         processed_at=NULL
       WHERE tenant_id=$1 AND protocol=$2 AND message_id=$3 AND status='received'
       RETURNING message_id`,
      [ref.tenantId, ref.protocol, ref.messageId, maxAttempts, safeFailureCode],
    );
    if (recorded.rows.length !== 1) {
      throw new Error("Inbox failure could not be recorded because message state changed");
    }
  }
}
