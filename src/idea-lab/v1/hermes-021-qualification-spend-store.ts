import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import {
  hmacSha256Tag,
  parseRollbackCheckpointV1,
  rollbackCheckpointDigestV1,
  sha256Digest,
  type RollbackCheckpointStoreV1,
  type RollbackCheckpointV1,
} from "../../security";
import {
  dataMethodV1,
  exactHostDataSnapshotV1,
  exactHostUint8ArrayV1,
  isHostProxyV1,
} from "../../security/host-value";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import type { IdeaLabHermes021QualificationSpendStoreV1 } from "./hermes-021-enrolled-gateway-port";
import { capturedIdeaTimeMillisecondsV1, capturedIdeaTimeStringV1, ideaDigestSchemaV1, ideaIdSchemaV1,
  ideaTimeSchemaV1 } from "./schemas";

export const IDEA_LAB_HERMES_021_QUALIFICATION_SPEND_EVENT_V1 =
  "control-room-hermes-021-qualification-spend-event/v1" as const;

const eventKindSchema = z.enum([
  "claimed", "execute_returned", "terminal_ambiguity", "cleanup_completed", "cleanup_uncertain",
]);

const claimSchema = z.object({
  permitDigest: ideaDigestSchemaV1,
  attemptId: ideaIdSchemaV1,
  markerDigest: ideaDigestSchemaV1,
  claimedAt: ideaTimeSchemaV1,
}).strict();

const settlementSchema = z.object({
  permitDigest: ideaDigestSchemaV1,
  attemptId: ideaIdSchemaV1,
  markerDigest: ideaDigestSchemaV1,
  outcome: eventKindSchema.exclude(["claimed"]),
  settledAt: ideaTimeSchemaV1,
}).strict();

interface SpendRow {
  tenant_id: string;
  permit_digest: string;
  sequence: number | string;
  event_kind: z.infer<typeof eventKindSchema>;
  attempt_id: string;
  marker_digest: string;
  previous_record_digest: string | null;
  record_digest: string;
  record_auth_tag: string;
  occurred_at: string | Date;
}

function protectedKey(value: unknown): Uint8Array {
  const exact = exactHostUint8ArrayV1(value, 32);
  if (!exact || exact.byteLength !== 32) throw new IdeaLabErrorV1("invalid_input");
  return exact.copy();
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function eventMaterial(row: Omit<SpendRow, "record_digest" | "record_auth_tag" | "occurred_at"> & {
  occurred_at: string;
}) {
  return {
    contractVersion: IDEA_LAB_HERMES_021_QUALIFICATION_SPEND_EVENT_V1,
    tenantId: row.tenant_id,
    permitDigest: row.permit_digest,
    sequence: Number(row.sequence),
    eventKind: row.event_kind,
    attemptId: row.attempt_id,
    markerDigest: row.marker_digest,
    previousRecordDigest: row.previous_record_digest,
    occurredAt: row.occurred_at,
  };
}

function checkpointMaterial(scope: string, rows: readonly SpendRow[]) {
  return {
    schema: "control-room-rollback-checkpoint/v1" as const,
    scope,
    revision: rows.length,
    recordCount: rows.length,
    stateDigest: sha256Digest(rows.map((row) => row.record_digest)),
  };
}

function rowTime(row: SpendRow): string {
  const formatted = capturedIdeaTimeStringV1(row.occurred_at);
  if (!formatted) throw new IdeaLabErrorV1("integrity_failed");
  return formatted;
}

function time(value: string): number {
  const milliseconds = capturedIdeaTimeMillisecondsV1(value);
  if (milliseconds === undefined) throw new IdeaLabErrorV1("integrity_failed");
  return milliseconds;
}

export class IdeaLabHermes021QualificationSpendDatabaseStoreV1
implements IdeaLabHermes021QualificationSpendStoreV1 {
  readonly #db: DatabaseClient;
  readonly #tenantId: string;
  readonly #stateKey: Uint8Array;
  readonly #checkpointKey: Uint8Array;
  readonly #checkpointRead: (scope: string) => RollbackCheckpointV1 | undefined;
  readonly #checkpointInitialize: (checkpoint: RollbackCheckpointV1) => void;
  readonly #checkpointAdvance: (expectedDigest: string, checkpoint: RollbackCheckpointV1) => void;

  constructor(db: DatabaseClient, input: Readonly<{
    tenantId: string;
    stateKey: Uint8Array;
    checkpointKey: Uint8Array;
  }>, checkpoint: RollbackCheckpointStoreV1) {
    if (!db || typeof db !== "object" || isHostProxyV1(db) || !dataMethodV1(db, "query")
      || !dataMethodV1(db, "transactionWithPreCommitCheck") || !checkpoint || typeof checkpoint !== "object"
      || isHostProxyV1(checkpoint)) throw new IdeaLabErrorV1("invalid_input");
    const captured = exactHostDataSnapshotV1(input, ["tenantId", "stateKey", "checkpointKey"]);
    const read = dataMethodV1(checkpoint, "read"), initialize = dataMethodV1(checkpoint, "initialize");
    const advance = dataMethodV1(checkpoint, "advance");
    if (!captured || !read || !initialize || !advance) throw new IdeaLabErrorV1("invalid_input");
    this.#db = db;
    this.#tenantId = ideaIdSchemaV1.parse(captured.tenantId);
    this.#stateKey = protectedKey(captured.stateKey);
    this.#checkpointKey = protectedKey(captured.checkpointKey);
    this.#checkpointRead = (scope) => Reflect.apply(read, checkpoint, [scope]) as RollbackCheckpointV1 | undefined;
    this.#checkpointInitialize = (value) => { Reflect.apply(initialize, checkpoint, [value]); };
    this.#checkpointAdvance = (expected, value) => { Reflect.apply(advance, checkpoint, [expected, value]); };
    Object.freeze(this);
  }

  #scope(permitDigest: string): string {
    return `idea-lab-hermes-qualification:${this.#tenantId}:${permitDigest}`;
  }

  async #rows(session: DatabaseSession, permitDigest: string, lock = false): Promise<SpendRow[]> {
    const result = await session.query<SpendRow>(`SELECT tenant_id,permit_digest,sequence,event_kind,attempt_id,
      marker_digest,previous_record_digest,record_digest,record_auth_tag,occurred_at
      FROM control_idea_qualification_spend_events WHERE tenant_id=$1 AND permit_digest=$2
      ORDER BY sequence${lock ? " FOR UPDATE" : ""}`, [this.#tenantId, permitDigest]);
    return result.rows;
  }

  #verifyRows(rows: SpendRow[], permitDigest: string): void {
    let previous: string | null = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!, sequence = Number(row.sequence);
      const occurredAt = rowTime(row);
      const material = eventMaterial({ ...row, occurred_at: occurredAt });
      const validKind = sequence === 1 ? row.event_kind === "claimed"
        : sequence === 2 ? row.event_kind === "execute_returned" || row.event_kind === "terminal_ambiguity"
          : sequence === 3 && (row.event_kind === "cleanup_completed" || row.event_kind === "cleanup_uncertain");
      if (row.tenant_id !== this.#tenantId || row.permit_digest !== permitDigest || sequence !== index + 1
        || !validKind || row.previous_record_digest !== previous || sha256Digest(material) !== row.record_digest
        || !same(hmacSha256Tag(this.#stateKey, { ...material, recordDigest: row.record_digest }), row.record_auth_tag)
        || (index > 0 && (row.attempt_id !== rows[0]!.attempt_id || row.marker_digest !== rows[0]!.marker_digest
          || time(occurredAt) < time(rowTime(rows[index - 1]!))))) {
        throw new IdeaLabErrorV1("integrity_failed");
      }
      previous = row.record_digest;
    }
  }

  #checkpointFor(permitDigest: string, rows: SpendRow[]): RollbackCheckpointV1 {
    const material = checkpointMaterial(this.#scope(permitDigest), rows);
    return parseRollbackCheckpointV1({ ...material, stateAuthTag: hmacSha256Tag(this.#checkpointKey, material) });
  }

  #verifyCheckpoint(permitDigest: string, rows: SpendRow[]): RollbackCheckpointV1 | undefined {
    const raw = this.#checkpointRead(this.#scope(permitDigest));
    if (rows.length === 0) {
      if (raw) throw new IdeaLabErrorV1("integrity_failed");
      return undefined;
    }
    if (!raw) throw new IdeaLabErrorV1("integrity_failed");
    const current = parseRollbackCheckpointV1(raw), expected = this.#checkpointFor(permitDigest, rows);
    if (current.scope !== expected.scope || current.revision !== expected.revision
      || current.recordCount !== expected.recordCount || current.stateDigest !== expected.stateDigest
      || !same(current.stateAuthTag, expected.stateAuthTag)) throw new IdeaLabErrorV1("integrity_failed");
    return current;
  }

  async #insert(session: DatabaseSession, input: {
    permitDigest: string;
    attemptId: string;
    markerDigest: string;
    eventKind: z.infer<typeof eventKindSchema>;
    occurredAt: string;
  }, rows: SpendRow[]): Promise<SpendRow[]> {
    const sequence = rows.length + 1, previousRecordDigest = rows.at(-1)?.record_digest ?? null;
    const material = {
      contractVersion: IDEA_LAB_HERMES_021_QUALIFICATION_SPEND_EVENT_V1,
      tenantId: this.#tenantId,
      permitDigest: input.permitDigest,
      sequence,
      eventKind: input.eventKind,
      attemptId: input.attemptId,
      markerDigest: input.markerDigest,
      previousRecordDigest,
      occurredAt: input.occurredAt,
    };
    const recordDigest = sha256Digest(material);
    const recordAuthTag = hmacSha256Tag(this.#stateKey, { ...material, recordDigest });
    await session.query(`INSERT INTO control_idea_qualification_spend_events
      (tenant_id,permit_digest,sequence,event_kind,attempt_id,marker_digest,previous_record_digest,
       record_digest,record_auth_tag,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [this.#tenantId, input.permitDigest, sequence, input.eventKind, input.attemptId, input.markerDigest,
      previousRecordDigest, recordDigest, recordAuthTag, input.occurredAt]);
    const next = [...rows, {
      tenant_id: this.#tenantId, permit_digest: input.permitDigest, sequence, event_kind: input.eventKind,
      attempt_id: input.attemptId, marker_digest: input.markerDigest, previous_record_digest: previousRecordDigest,
      record_digest: recordDigest, record_auth_tag: recordAuthTag, occurred_at: input.occurredAt,
    }];
    this.#verifyRows(next, input.permitDigest);
    return next;
  }

  async claim(inputValue: Parameters<IdeaLabHermes021QualificationSpendStoreV1["claim"]>[0]):
  Promise<"claimed" | "already_claimed" | "conflict"> {
    const input = parseExactIdeaLabV1(claimSchema, inputValue);
    let checkpointAction: (() => void) | undefined;
    const result = await this.#db.transactionWithPreCommitCheck(async (tx) => {
      const rows = await this.#rows(tx, input.permitDigest, true);
      this.#verifyRows(rows, input.permitDigest);
      const checkpoint = this.#verifyCheckpoint(input.permitDigest, rows);
      if (rows.length > 0) {
        const first = rows[0]!;
        return first.attempt_id === input.attemptId && first.marker_digest === input.markerDigest
          ? "already_claimed" as const : "conflict" as const;
      }
      const next = await this.#insert(tx, { ...input, eventKind: "claimed", occurredAt: input.claimedAt }, rows);
      const nextCheckpoint = this.#checkpointFor(input.permitDigest, next);
      checkpointAction = checkpoint
        ? () => this.#checkpointAdvance(checkpoint.stateDigest, nextCheckpoint)
        : () => this.#checkpointInitialize(nextCheckpoint);
      return "claimed" as const;
    }, () => { checkpointAction?.(); });
    return result;
  }

  async settle(inputValue: Parameters<IdeaLabHermes021QualificationSpendStoreV1["settle"]>[0]): Promise<void> {
    const input = parseExactIdeaLabV1(settlementSchema, inputValue);
    let checkpointAction: (() => void) | undefined;
    await this.#db.transactionWithPreCommitCheck(async (tx) => {
      const rows = await this.#rows(tx, input.permitDigest, true);
      this.#verifyRows(rows, input.permitDigest);
      const checkpoint = this.#verifyCheckpoint(input.permitDigest, rows), first = rows[0];
      if (!first || first.attempt_id !== input.attemptId || first.marker_digest !== input.markerDigest || !checkpoint) {
        throw new IdeaLabErrorV1("authorization_denied");
      }
      const existing = rows.find((row) => row.event_kind === input.outcome);
      if (existing) {
        if (rowTime(existing) !== input.settledAt) throw new IdeaLabErrorV1("integrity_failed");
        return;
      }
      const executionOutcome = input.outcome === "execute_returned" || input.outcome === "terminal_ambiguity";
      if ((rows.length === 1) !== executionOutcome || rows.length >= 3) throw new IdeaLabErrorV1("integrity_failed");
      const next = await this.#insert(tx, { ...input, eventKind: input.outcome, occurredAt: input.settledAt }, rows);
      const nextCheckpoint = this.#checkpointFor(input.permitDigest, next);
      checkpointAction = () => this.#checkpointAdvance(rollbackCheckpointDigestV1(checkpoint), nextCheckpoint);
    }, () => { checkpointAction?.(); });
  }
}
