import type { DatabaseClient } from "../../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import type { ActionInboxItemV1, OwnerFocusCommandV1, OwnerFocusPinV1 } from "./types";
import { actionInboxItemSchemaV1, ownerFocusCommandSchemaV1, ownerFocusPinSchemaV1 } from "./validators";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

export class OperatorSurfaceStoreError extends Error {
  constructor(readonly safeCode: "invalid_operator_surface" | "command_conflict") { super(safeCode); }
}

function parseInbox(value: ActionInboxItemV1): ActionInboxItemV1 {
  const parsed = actionInboxItemSchemaV1.safeParse(value);
  if (!parsed.success) throw new OperatorSurfaceStoreError("invalid_operator_surface");
  try { assertNoSecretMaterial(parsed.data, "action inbox item"); } catch { throw new OperatorSurfaceStoreError("invalid_operator_surface"); }
  return parsed.data;
}

function parseFocusCommand(value: OwnerFocusCommandV1): OwnerFocusCommandV1 {
  const parsed = ownerFocusCommandSchemaV1.safeParse(value);
  if (!parsed.success) throw new OperatorSurfaceStoreError("invalid_operator_surface");
  try { assertNoSecretMaterial(parsed.data, "owner focus command"); } catch { throw new OperatorSurfaceStoreError("invalid_operator_surface"); }
  return parsed.data;
}

function toInstant(value: string | Date): string { return new Date(value).toISOString(); }
function jsonRecord<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

/** Tenant-bound persistence for redacted projections and owner-priority intent; it never dispatches or authorizes work. */
export class OperatorSurfaceStoreV1 {
  constructor(private readonly db: DatabaseClient) {}

  async upsertInbox(itemInput: ActionInboxItemV1): Promise<{ replayed: boolean }> {
    const item = parseInbox(itemInput);
    return this.db.transaction(async (tx) => {
      const prior = await tx.query<{ payload: unknown }>(`SELECT payload FROM control_action_inbox WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [item.tenantId,item.id]);
      if (prior.rows[0] && sha256Digest(prior.rows[0].payload) === sha256Digest(item)) return { replayed: true };
      await tx.query(
        `INSERT INTO control_action_inbox (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT (tenant_id,id) DO UPDATE SET project_id=EXCLUDED.project_id,work_item_id=EXCLUDED.work_item_id,kind=EXCLUDED.kind,state=EXCLUDED.state,delivery_state=EXCLUDED.delivery_state,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at,payload=EXCLUDED.payload`,
        [item.id,item.tenantId,item.projectId ?? null,item.workItemId ?? null,item.kind,item.state,item.deliveryState,item.createdAt,item.expiresAt ?? null,JSON.stringify(item)],
      );
      return { replayed: false };
    });
  }

  async listInbox(input: { tenantId: string; state?: ActionInboxItemV1["state"]; limit: number }): Promise<ActionInboxItemV1[]> {
    if (!safeId.test(input.tenantId) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) throw new OperatorSurfaceStoreError("invalid_operator_surface");
    const result = input.state
      ? await this.db.query<{ payload: unknown }>(`SELECT payload FROM control_action_inbox WHERE tenant_id=$1 AND state=$2 ORDER BY created_at DESC,id LIMIT $3`, [input.tenantId,input.state,input.limit])
      : await this.db.query<{ payload: unknown }>(`SELECT payload FROM control_action_inbox WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT $2`, [input.tenantId,input.limit]);
    return result.rows.map((row) => {
      const parsed = actionInboxItemSchemaV1.safeParse(row.payload);
      if (!parsed.success || parsed.data.tenantId !== input.tenantId) throw new OperatorSurfaceStoreError("invalid_operator_surface");
      try { assertNoSecretMaterial(parsed.data, "action inbox item"); } catch { throw new OperatorSurfaceStoreError("invalid_operator_surface"); }
      return parsed.data;
    });
  }

  /** Caller must have authenticated and authorized the owner identity before this write boundary. */
  async applyAuthorizedOwnerFocus(commandInput: OwnerFocusCommandV1): Promise<{ replayed: boolean; pin?: OwnerFocusPinV1 }> {
    const command = parseFocusCommand(commandInput);
    const canonicalCommand = jsonRecord(command);
    const digest = sha256Digest(canonicalCommand);
    return this.db.transaction(async (tx) => {
      const prior = await tx.query<{ payload_digest: string }>(`SELECT payload_digest FROM control_owner_focus_command_receipts WHERE tenant_id=$1 AND (command_id=$2 OR idempotency_key=$3) FOR UPDATE`, [command.tenantId,command.commandId,command.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_digest !== digest) throw new OperatorSurfaceStoreError("command_conflict");
        return { replayed: true };
      }
      await tx.query(`INSERT INTO control_owner_focus_command_receipts (tenant_id,command_id,idempotency_key,payload_digest,recorded_at) VALUES ($1,$2,$3,$4,$5)`, [command.tenantId,command.commandId,command.idempotencyKey,digest,command.requestedAt]);
      if (command.operation === "clear_owner_focus") {
        await tx.query(`DELETE FROM control_owner_focus_pins WHERE tenant_id=$1 AND project_id=$2`, [command.tenantId,command.projectId]);
        return { replayed: false };
      }
      const pin: OwnerFocusPinV1 = { id: `focus:${command.projectId}`, tenantId: command.tenantId, projectId: command.projectId, level: command.level!, reason: command.reason!, createdAt: command.requestedAt };
      await tx.query(`INSERT INTO control_owner_focus_pins (id,tenant_id,project_id,level,created_at,expires_at,payload) VALUES ($1,$2,$3,$4,$5,NULL,$6::jsonb) ON CONFLICT (tenant_id,project_id) DO UPDATE SET id=EXCLUDED.id,level=EXCLUDED.level,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at,payload=EXCLUDED.payload`, [pin.id,pin.tenantId,pin.projectId,pin.level,pin.createdAt,JSON.stringify(pin)]);
      return { replayed: false, pin };
    });
  }

  async listOwnerFocus(input: { tenantId: string; now: string }): Promise<OwnerFocusPinV1[]> {
    if (!safeId.test(input.tenantId) || Number.isNaN(Date.parse(input.now))) throw new OperatorSurfaceStoreError("invalid_operator_surface");
    const result = await this.db.query<{ payload: unknown }>(`SELECT payload FROM control_owner_focus_pins WHERE tenant_id=$1 AND (expires_at IS NULL OR expires_at > $2) ORDER BY level,project_id`, [input.tenantId,input.now]);
    return result.rows.map((row) => {
      const parsed = ownerFocusPinSchemaV1.safeParse(row.payload);
      if (!parsed.success || parsed.data.tenantId !== input.tenantId) throw new OperatorSurfaceStoreError("invalid_operator_surface");
      return { ...parsed.data, createdAt: toInstant(parsed.data.createdAt), ...(parsed.data.expiresAt ? { expiresAt: toInstant(parsed.data.expiresAt) } : {}) };
    });
  }
}
