import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../../persistence/database";
import { sha256Digest } from "../../../security";
import { advanceContentBloomsReadHighWaterV1, parseContentBloomsControlStateV1 } from "./control";
import { ContentBloomsContractErrorV1 } from "./errors";
import { parseExactContentBloomsV1 } from "./exact";
import { parseContentBloomsOperationalRecordV1 } from "./records";
import { parseContentBloomsAdapterReleaseV1 } from "./release";
import {
  parseContentBloomsReadPageV1,
  parseContentBloomsReadReceiptV1,
  requireExactContentBloomsReadReplayV1,
} from "./read";
import { contentBloomsSafeIdSchemaV1 } from "./schemas";
import type {
  ContentBloomsAdapterControlStateV1,
  ContentBloomsAdapterReleaseV1,
  ContentBloomsOperationalRecordV1,
  ContentBloomsReadOperationV1,
  ContentBloomsReadReceiptV1,
} from "./types";

const storeScopeSchemaV1 = z.object({
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  stateId: contentBloomsSafeIdSchemaV1,
}).strict();

const commitInputSchemaV1 = z.object({
  page: z.unknown(),
  records: z.array(z.unknown()).max(100),
  nextCursor: z.string().min(1).max(512),
  receipt: z.unknown(),
}).strict();

type StoredJson = string | Record<string, unknown>;
interface StateRow { payload: StoredJson; state_digest: string; }
interface ReleaseRow { payload: StoredJson; }
interface ReceiptRow { payload: StoredJson; next_cursor_value: string; }
interface CurrentRow { payload: StoredJson; observed_at: string; record_digest: string; }
interface HistoryRow { payload: StoredJson; record_digest: string; }
interface StreamRow { cursor_value: string; cursor_digest: string; receipt_digest: string; revision: number; }

export interface ContentBloomsSyncCommitResultV1 {
  state: ContentBloomsAdapterControlStateV1;
  receipt: ContentBloomsReadReceiptV1;
  appliedCurrentRecords: number;
  appendedHistoryRecords: number;
  replayed: boolean;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parsedJson(value: StoredJson): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function sameScope(
  left: { tenantId: string; workspaceId: string; projectId: string; adapterId: string },
  right: { tenantId: string; workspaceId: string; projectId: string; adapterId: string },
): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId
    && left.projectId === right.projectId && left.adapterId === right.adapterId;
}

function cursorDigest(scope: { adapterId: string; projectId: string }, value: string): string {
  return sha256Digest({ adapterId: scope.adapterId, projectId: scope.projectId, cursor: value });
}

export class ContentBloomsSyncStoreV1 {
  readonly #scope: z.infer<typeof storeScopeSchemaV1>;

  constructor(private readonly db: DatabaseClient, scopeValue: unknown) {
    this.#scope = parseExactContentBloomsV1(storeScopeSchemaV1, scopeValue);
  }

  async initialize(releaseValue: unknown, stateValue: unknown): Promise<void> {
    const release = parseContentBloomsAdapterReleaseV1(releaseValue);
    const state = parseContentBloomsControlStateV1(stateValue);
    if (!sameScope(this.#scope, release) || !sameScope(this.#scope, state) || state.stateId !== this.#scope.stateId) {
      throw new ContentBloomsContractErrorV1("scope_mismatch");
    }
    if (state.configuredReleaseDigest !== release.releaseDigest
      || (state.status === "enabled" && state.activeReleaseDigest !== release.releaseDigest)) {
      throw new ContentBloomsContractErrorV1("release_untrusted");
    }
    await this.db.transaction(async (tx) => {
      await this.registerReleaseWith(tx, release);
      const existing = await tx.query<StateRow>(
        "SELECT payload,state_digest FROM control_content_blooms_state WHERE tenant_id=$1 AND state_id=$2 FOR UPDATE",
        [this.#scope.tenantId, this.#scope.stateId],
      );
      if (existing.rows[0]) {
        const known = parseContentBloomsControlStateV1(parsedJson(existing.rows[0].payload));
        if (known.stateDigest !== state.stateDigest || existing.rows[0].state_digest !== known.stateDigest) {
          throw new ContentBloomsContractErrorV1("stale_state");
        }
        return;
      }
      await tx.query(
        `INSERT INTO control_content_blooms_state(
          tenant_id,state_id,workspace_id,project_id,adapter_id,revision,state_digest,payload,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        [state.tenantId,state.stateId,state.workspaceId,state.projectId,state.adapterId,state.revision,state.stateDigest,json(state),state.updatedAt],
      );
    });
  }

  async registerRelease(releaseValue: unknown): Promise<ContentBloomsAdapterReleaseV1> {
    const release = parseContentBloomsAdapterReleaseV1(releaseValue);
    if (!sameScope(this.#scope, release)) throw new ContentBloomsContractErrorV1("scope_mismatch");
    return this.db.transaction((tx) => this.registerReleaseWith(tx, release));
  }

  async loadState(): Promise<ContentBloomsAdapterControlStateV1> {
    const row = await this.db.query<StateRow>(
      "SELECT payload,state_digest FROM control_content_blooms_state WHERE tenant_id=$1 AND state_id=$2",
      [this.#scope.tenantId, this.#scope.stateId],
    );
    if (!row.rows[0]) throw new ContentBloomsContractErrorV1("stale_state");
    const state = parseContentBloomsControlStateV1(parsedJson(row.rows[0].payload));
    if (row.rows[0].state_digest !== state.stateDigest || !sameScope(this.#scope, state)) {
      throw new ContentBloomsContractErrorV1("replay_drift");
    }
    return state;
  }

  async activeRelease(): Promise<ContentBloomsAdapterReleaseV1> {
    const state = await this.loadState();
    if (state.status !== "enabled" || !state.activeReleaseDigest) {
      throw new ContentBloomsContractErrorV1("adapter_disabled");
    }
    const row = await this.db.query<ReleaseRow>(
      "SELECT payload FROM control_content_blooms_releases WHERE tenant_id=$1 AND release_digest=$2",
      [this.#scope.tenantId, state.activeReleaseDigest],
    );
    if (!row.rows[0]) throw new ContentBloomsContractErrorV1("release_untrusted");
    const release = parseContentBloomsAdapterReleaseV1(parsedJson(row.rows[0].payload));
    if (!sameScope(this.#scope, release)) throw new ContentBloomsContractErrorV1("scope_mismatch");
    return release;
  }

  async cursor(operation: ContentBloomsReadOperationV1): Promise<string | undefined> {
    const row = await this.db.query<StreamRow>(
      "SELECT cursor_value,cursor_digest,receipt_digest,revision FROM control_content_blooms_streams WHERE tenant_id=$1 AND adapter_id=$2 AND operation=$3",
      [this.#scope.tenantId, this.#scope.adapterId, operation],
    );
    if (!row.rows[0]) return undefined;
    if (row.rows[0].cursor_digest !== cursorDigest(this.#scope, row.rows[0].cursor_value)) {
      throw new ContentBloomsContractErrorV1("replay_drift");
    }
    return row.rows[0].cursor_value;
  }

  async currentRecords(kind?: ContentBloomsOperationalRecordV1["kind"]): Promise<ContentBloomsOperationalRecordV1[]> {
    const row = await this.db.query<{ payload: StoredJson }>(
      kind
        ? "SELECT payload FROM control_content_blooms_current_records WHERE tenant_id=$1 AND adapter_id=$2 AND kind=$3 ORDER BY source_record_id"
        : "SELECT payload FROM control_content_blooms_current_records WHERE tenant_id=$1 AND adapter_id=$2 ORDER BY kind,source_record_id",
      kind ? [this.#scope.tenantId, this.#scope.adapterId, kind] : [this.#scope.tenantId, this.#scope.adapterId],
    );
    return row.rows.map((value) => parseContentBloomsOperationalRecordV1(parsedJson(value.payload)));
  }

  async receiptCount(): Promise<number> {
    const row = await this.db.query<{ count: string | number }>(
      "SELECT count(*) AS count FROM control_content_blooms_read_receipts WHERE tenant_id=$1 AND adapter_id=$2",
      [this.#scope.tenantId, this.#scope.adapterId],
    );
    return Number(row.rows[0]?.count ?? 0);
  }

  async historyCount(): Promise<number> {
    const row = await this.db.query<{ count: string | number }>(
      "SELECT count(*) AS count FROM control_content_blooms_record_history WHERE tenant_id=$1 AND adapter_id=$2",
      [this.#scope.tenantId, this.#scope.adapterId],
    );
    return Number(row.rows[0]?.count ?? 0);
  }

  async commitRead(inputValue: unknown): Promise<ContentBloomsSyncCommitResultV1> {
    const input = parseExactContentBloomsV1(commitInputSchemaV1, inputValue);
    const page = parseContentBloomsReadPageV1(input.page);
    const receipt = parseContentBloomsReadReceiptV1(input.receipt);
    const records = input.records.map((record) => parseContentBloomsOperationalRecordV1(record));
    if (!sameScope(this.#scope, page) || !sameScope(this.#scope, receipt)
      || input.nextCursor !== page.nextCursor
      || cursorDigest(this.#scope, input.nextCursor) !== receipt.nextCursorDigest
      || page.pageId !== receipt.pageId || page.pageDigest !== receipt.pageDigest
      || page.requestId !== receipt.requestId || page.requestDigest !== receipt.requestDigest
      || page.releaseDigest !== receipt.releaseDigest || page.operation !== receipt.operation
      || page.sourceSnapshotVersion !== receipt.sourceSnapshotVersion
      || page.sourceObservedAt !== receipt.sourceObservedAt
      || page.records.map((record) => record.recordDigest).join("\0") !== records.map((record) => record.recordDigest).join("\0")
      || receipt.recordCount !== records.length
      || receipt.recordDigests.join("\0") !== records.map((record) => record.recordDigest).join("\0")) {
      throw new ContentBloomsContractErrorV1("replay_drift");
    }
    if (Date.parse(receipt.recordedAt) < Date.parse(page.sourceObservedAt)) {
      throw new ContentBloomsContractErrorV1("sequence_invalid");
    }

    return this.db.transaction(async (tx) => {
      const state = await this.loadStateWith(tx, true);
      const existingByIdentity = await tx.query<ReceiptRow>(
        "SELECT payload,next_cursor_value FROM control_content_blooms_read_receipts WHERE tenant_id=$1 AND adapter_id=$2 AND request_id=$3 AND page_id=$4",
        [this.#scope.tenantId,this.#scope.adapterId,receipt.requestId,receipt.pageId],
      );
      if (existingByIdentity.rows[0]) {
        const known = parseContentBloomsReadReceiptV1(parsedJson(existingByIdentity.rows[0].payload));
        requireExactContentBloomsReadReplayV1(known, receipt);
        if (existingByIdentity.rows[0].next_cursor_value !== input.nextCursor) {
          throw new ContentBloomsContractErrorV1("replay_drift");
        }
        return { state, receipt: known, appliedCurrentRecords: 0, appendedHistoryRecords: 0, replayed: true };
      }
      const existingByDigest = await tx.query<ReceiptRow>(
        "SELECT payload,next_cursor_value FROM control_content_blooms_read_receipts WHERE tenant_id=$1 AND receipt_digest=$2",
        [this.#scope.tenantId,receipt.receiptDigest],
      );
      if (existingByDigest.rows[0]) throw new ContentBloomsContractErrorV1("replay_drift");
      if (state.stateDigest !== receipt.controlStateDigest || state.status !== "enabled"
        || state.activeReleaseDigest !== receipt.releaseDigest) {
        throw new ContentBloomsContractErrorV1("stale_state");
      }
      const release = await tx.query<ReleaseRow>(
        "SELECT payload FROM control_content_blooms_releases WHERE tenant_id=$1 AND release_digest=$2",
        [this.#scope.tenantId,receipt.releaseDigest],
      );
      if (!release.rows[0]) throw new ContentBloomsContractErrorV1("release_untrusted");
      const acceptedRelease = parseContentBloomsAdapterReleaseV1(parsedJson(release.rows[0].payload));
      if (!sameScope(this.#scope, acceptedRelease) || acceptedRelease.releaseDigest !== receipt.releaseDigest) {
        throw new ContentBloomsContractErrorV1("release_untrusted");
      }
      const stream = await tx.query<StreamRow>(
        "SELECT cursor_value,cursor_digest,receipt_digest,revision FROM control_content_blooms_streams WHERE tenant_id=$1 AND adapter_id=$2 AND operation=$3 FOR UPDATE",
        [this.#scope.tenantId,this.#scope.adapterId,receipt.operation],
      );
      const priorStream = stream.rows[0];
      if (receipt.operation !== "getProjectSummary") {
        if ((priorStream === undefined) !== (page.afterCursor === undefined)
          || (priorStream && (priorStream.cursor_value !== page.afterCursor
            || priorStream.cursor_digest !== cursorDigest(this.#scope, priorStream.cursor_value)))) {
          throw new ContentBloomsContractErrorV1("cursor_drift");
        }
      }

      await tx.query(
        `INSERT INTO control_content_blooms_read_receipts(
          tenant_id,receipt_digest,receipt_id,request_id,page_id,workspace_id,project_id,adapter_id,
          release_digest,control_state_digest,operation,next_cursor_value,next_cursor_digest,payload,recorded_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`,
        [receipt.tenantId,receipt.receiptDigest,receipt.receiptId,receipt.requestId,receipt.pageId,receipt.workspaceId,
          receipt.projectId,receipt.adapterId,receipt.releaseDigest,receipt.controlStateDigest,receipt.operation,
          input.nextCursor,receipt.nextCursorDigest,json(receipt),receipt.recordedAt],
      );

      let appendedHistoryRecords = 0, appliedCurrentRecords = 0;
      for (const record of records) {
        const history = await tx.query<HistoryRow>(
          `SELECT payload,record_digest FROM control_content_blooms_record_history
           WHERE tenant_id=$1 AND adapter_id=$2 AND kind=$3 AND source_record_id=$4 AND source_version=$5`,
          [record.tenantId,record.adapterId,record.kind,record.sourceRecordId,record.sourceVersion],
        );
        if (history.rows[0]) {
          const known = parseContentBloomsOperationalRecordV1(parsedJson(history.rows[0].payload));
          if (known.recordDigest !== record.recordDigest || history.rows[0].record_digest !== record.recordDigest) {
            throw new ContentBloomsContractErrorV1("replay_drift");
          }
        } else {
          await tx.query(
            `INSERT INTO control_content_blooms_record_history(
              tenant_id,workspace_id,project_id,adapter_id,kind,source_record_id,source_version,operation,
              record_digest,receipt_digest,payload,observed_at
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
            [record.tenantId,record.workspaceId,record.projectId,record.adapterId,record.kind,record.sourceRecordId,
              record.sourceVersion,record.operation,record.recordDigest,receipt.receiptDigest,json(record),record.observedAt],
          );
          appendedHistoryRecords += 1;
        }
        appliedCurrentRecords += await this.applyCurrentRecord(tx, record, receipt.receiptDigest);
      }

      if (priorStream) {
        await tx.query(
          `UPDATE control_content_blooms_streams SET cursor_value=$1,cursor_digest=$2,receipt_digest=$3,
            revision=$4,updated_at=$5 WHERE tenant_id=$6 AND adapter_id=$7 AND operation=$8`,
          [input.nextCursor,receipt.nextCursorDigest,receipt.receiptDigest,Number(priorStream.revision)+1,receipt.recordedAt,
            this.#scope.tenantId,this.#scope.adapterId,receipt.operation],
        );
      } else {
        await tx.query(
          `INSERT INTO control_content_blooms_streams(
            tenant_id,workspace_id,project_id,adapter_id,operation,cursor_value,cursor_digest,receipt_digest,revision,updated_at
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9)`,
          [this.#scope.tenantId,this.#scope.workspaceId,this.#scope.projectId,this.#scope.adapterId,receipt.operation,
            input.nextCursor,receipt.nextCursorDigest,receipt.receiptDigest,receipt.recordedAt],
        );
      }
      const nextState = advanceContentBloomsReadHighWaterV1({ state, receipt });
      const updated = await tx.query<{ state_digest: string }>(
        `UPDATE control_content_blooms_state SET revision=$1,state_digest=$2,payload=$3::jsonb,updated_at=$4
         WHERE tenant_id=$5 AND state_id=$6 AND state_digest=$7 RETURNING state_digest`,
        [nextState.revision,nextState.stateDigest,json(nextState),nextState.updatedAt,
          this.#scope.tenantId,this.#scope.stateId,state.stateDigest],
      );
      if (updated.rows[0]?.state_digest !== nextState.stateDigest) throw new ContentBloomsContractErrorV1("stale_state");
      return { state: nextState, receipt, appliedCurrentRecords, appendedHistoryRecords, replayed: false };
    });
  }

  private async registerReleaseWith(tx: DatabaseSession, release: ContentBloomsAdapterReleaseV1): Promise<ContentBloomsAdapterReleaseV1> {
    const existing = await tx.query<ReleaseRow>(
      "SELECT payload FROM control_content_blooms_releases WHERE tenant_id=$1 AND release_digest=$2",
      [release.tenantId,release.releaseDigest],
    );
    if (existing.rows[0]) {
      const known = parseContentBloomsAdapterReleaseV1(parsedJson(existing.rows[0].payload));
      if (known.releaseDigest !== release.releaseDigest) throw new ContentBloomsContractErrorV1("release_untrusted");
      return known;
    }
    const identity = await tx.query<ReleaseRow>(
      "SELECT payload FROM control_content_blooms_releases WHERE tenant_id=$1 AND release_id=$2",
      [release.tenantId,release.releaseId],
    );
    if (identity.rows[0]) throw new ContentBloomsContractErrorV1("replay_drift");
    await tx.query(
      `INSERT INTO control_content_blooms_releases(
        tenant_id,release_digest,release_id,workspace_id,project_id,adapter_id,payload,accepted_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [release.tenantId,release.releaseDigest,release.releaseId,release.workspaceId,release.projectId,
        release.adapterId,json(release),release.acceptedAt],
    );
    return release;
  }

  private async loadStateWith(tx: DatabaseSession, lock: boolean): Promise<ContentBloomsAdapterControlStateV1> {
    const row = await tx.query<StateRow>(
      `SELECT payload,state_digest FROM control_content_blooms_state WHERE tenant_id=$1 AND state_id=$2${lock ? " FOR UPDATE" : ""}`,
      [this.#scope.tenantId,this.#scope.stateId],
    );
    if (!row.rows[0]) throw new ContentBloomsContractErrorV1("stale_state");
    const state = parseContentBloomsControlStateV1(parsedJson(row.rows[0].payload));
    if (state.stateDigest !== row.rows[0].state_digest || !sameScope(this.#scope, state)) {
      throw new ContentBloomsContractErrorV1("replay_drift");
    }
    return state;
  }

  private async applyCurrentRecord(tx: DatabaseSession, record: ContentBloomsOperationalRecordV1, receiptDigest: string): Promise<number> {
    const row = await tx.query<CurrentRow>(
      `SELECT payload,observed_at,record_digest FROM control_content_blooms_current_records
       WHERE tenant_id=$1 AND adapter_id=$2 AND kind=$3 AND source_record_id=$4 FOR UPDATE`,
      [record.tenantId,record.adapterId,record.kind,record.sourceRecordId],
    );
    const current = row.rows[0]
      ? parseContentBloomsOperationalRecordV1(parsedJson(row.rows[0].payload))
      : undefined;
    if (current && (row.rows[0].record_digest !== current.recordDigest
      || new Date(row.rows[0].observed_at).toISOString() !== current.observedAt)) {
      throw new ContentBloomsContractErrorV1("replay_drift");
    }
    if (current && current.recordDigest === record.recordDigest) return 0;
    if (current && Date.parse(record.observedAt) < Date.parse(current.observedAt)) return 0;
    if (current && Date.parse(record.observedAt) === Date.parse(current.observedAt) && record.operation === "upsert") {
      throw new ContentBloomsContractErrorV1("replay_drift");
    }
    if (record.operation === "remove") {
      if (!current) return 0;
      await tx.query(
        "DELETE FROM control_content_blooms_current_records WHERE tenant_id=$1 AND adapter_id=$2 AND kind=$3 AND source_record_id=$4",
        [record.tenantId,record.adapterId,record.kind,record.sourceRecordId],
      );
      return 1;
    }
    if (current) {
      await tx.query(
        `UPDATE control_content_blooms_current_records SET source_version=$1,record_digest=$2,receipt_digest=$3,
          payload=$4::jsonb,observed_at=$5 WHERE tenant_id=$6 AND adapter_id=$7 AND kind=$8 AND source_record_id=$9`,
        [record.sourceVersion,record.recordDigest,receiptDigest,json(record),record.observedAt,
          record.tenantId,record.adapterId,record.kind,record.sourceRecordId],
      );
    } else {
      await tx.query(
        `INSERT INTO control_content_blooms_current_records(
          tenant_id,workspace_id,project_id,adapter_id,kind,source_record_id,source_version,record_digest,
          receipt_digest,payload,observed_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [record.tenantId,record.workspaceId,record.projectId,record.adapterId,record.kind,record.sourceRecordId,
          record.sourceVersion,record.recordDigest,receiptDigest,json(record),record.observedAt],
      );
    }
    return 1;
  }
}
