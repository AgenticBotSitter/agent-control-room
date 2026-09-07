import type { DatabaseClient } from "../../persistence/database";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const digest = /^sha256:[a-f0-9]{64}$/;

export class ResourceReservationError extends Error {
  constructor(readonly safeCode: "invalid_reservation" | "resource_capacity_conflict" | "resource_unavailable" | "reservation_conflict" | "reservation_not_found") { super(safeCode); }
}

export interface ResourceReservationRequest {
  id: string;
  tenantId: string;
  projectId: string;
  workItemId: string;
  routeId: string;
  resourceKey: string;
  units: number;
  capacityUnits: number;
  decisionDigest: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface ResourceReservation {
  id: string;
  tenantId: string;
  projectId: string;
  workItemId: string;
  routeId: string;
  resourceKey: string;
  units: number;
  capacityUnits: number;
  decisionDigest: string;
  state: "active" | "released" | "expired";
  acquiredAt: string;
  expiresAt: string;
  releasedAt?: string;
}

export interface ResourceReservationReconciliation {
  expiredReservationIds: string[];
  activeReservations: ResourceReservation[];
}

function instant(value: string): boolean { const parsed = new Date(value); return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value; }
function valid(input: ResourceReservationRequest): boolean {
  return [input.id,input.tenantId,input.projectId,input.workItemId,input.routeId,input.resourceKey].every((value) => safeId.test(value))
    && Number.isSafeInteger(input.units) && input.units > 0 && Number.isSafeInteger(input.capacityUnits) && input.capacityUnits > 0
    && input.units <= input.capacityUnits && digest.test(input.decisionDigest) && instant(input.acquiredAt) && instant(input.expiresAt) && Date.parse(input.expiresAt) > Date.parse(input.acquiredAt);
}

/** Database-only reservation ledger; it does not acquire a live host resource or grant execution authority. */
export class ResourceReservationStore {
  constructor(private readonly db: DatabaseClient) {}

  async acquire(input: ResourceReservationRequest, now: string): Promise<{ reservation: ResourceReservation; replayed: boolean }> {
    if (!valid(input) || !instant(now) || Date.parse(input.acquiredAt) > Date.parse(now) || Date.parse(input.expiresAt) <= Date.parse(now)) throw new ResourceReservationError("invalid_reservation");
    return this.db.transaction(async (tx) => {
      await tx.query(`INSERT INTO control_resource_reservation_heads (tenant_id,resource_key,capacity_units) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,resource_key) DO NOTHING`, [input.tenantId,input.resourceKey,input.capacityUnits]);
      const head = await tx.query<{ capacity_units: number }>(`SELECT capacity_units FROM control_resource_reservation_heads WHERE tenant_id=$1 AND resource_key=$2 FOR UPDATE`, [input.tenantId,input.resourceKey]);
      if (!head.rows[0] || Number(head.rows[0].capacity_units) !== input.capacityUnits) throw new ResourceReservationError("resource_capacity_conflict");
      await tx.query(`UPDATE control_resource_reservations SET state='expired' WHERE tenant_id=$1 AND resource_key=$2 AND state='active' AND expires_at <= $3`, [input.tenantId,input.resourceKey,now]);
      const existing = await tx.query<ReservationRow>(`SELECT * FROM control_resource_reservations WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [input.tenantId,input.id]);
      if (existing.rows[0]) {
        const reservation = rowToReservation(existing.rows[0], input.capacityUnits);
        if (!sameReservation(reservation, input)) throw new ResourceReservationError("reservation_conflict");
        if (reservation.state !== "active") throw new ResourceReservationError("resource_unavailable");
        return { reservation, replayed: true };
      }
      const used = await tx.query<{ used_units: number }>(`SELECT COALESCE(SUM(units),0)::bigint AS used_units FROM control_resource_reservations WHERE tenant_id=$1 AND resource_key=$2 AND state='active' AND expires_at > $3`, [input.tenantId,input.resourceKey,now]);
      if (Number(used.rows[0]?.used_units ?? 0) + input.units > input.capacityUnits) throw new ResourceReservationError("resource_unavailable");
      await tx.query(`INSERT INTO control_resource_reservations (id,tenant_id,project_id,work_item_id,route_id,resource_key,units,decision_digest,state,acquired_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10)`, [input.id,input.tenantId,input.projectId,input.workItemId,input.routeId,input.resourceKey,input.units,input.decisionDigest,input.acquiredAt,input.expiresAt]);
      return { reservation: { ...input, state: "active" }, replayed: false };
    });
  }

  async release(input: { tenantId: string; id: string; releasedAt: string }): Promise<ResourceReservation> {
    if (!safeId.test(input.tenantId) || !safeId.test(input.id) || !instant(input.releasedAt)) throw new ResourceReservationError("invalid_reservation");
    return this.db.transaction(async (tx) => {
      const row = await tx.query<ReservationRow & { capacity_units: number }>(`SELECT r.*,h.capacity_units FROM control_resource_reservations r JOIN control_resource_reservation_heads h ON h.tenant_id=r.tenant_id AND h.resource_key=r.resource_key WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE OF r,h`, [input.tenantId,input.id]);
      if (!row.rows[0]) throw new ResourceReservationError("reservation_not_found");
      const reservation = rowToReservation(row.rows[0], Number(row.rows[0].capacity_units));
      if (reservation.state === "active") {
        if (Date.parse(input.releasedAt) < Date.parse(reservation.acquiredAt)) throw new ResourceReservationError("invalid_reservation");
        if (Date.parse(input.releasedAt) >= Date.parse(reservation.expiresAt)) {
          await tx.query(`UPDATE control_resource_reservations SET state='expired' WHERE tenant_id=$1 AND id=$2`, [input.tenantId,input.id]);
          return { ...reservation, state: "expired" };
        }
        await tx.query(`UPDATE control_resource_reservations SET state='released',released_at=$3 WHERE tenant_id=$1 AND id=$2`, [input.tenantId,input.id,input.releasedAt]);
        return { ...reservation, state: "released", releasedAt: input.releasedAt };
      }
      return reservation;
    });
  }

  async reconcile(input: { tenantId: string; now: string }): Promise<ResourceReservationReconciliation> {
    if (!safeId.test(input.tenantId) || !instant(input.now)) throw new ResourceReservationError("invalid_reservation");
    return this.db.transaction(async (tx) => {
      const expired = await tx.query<{ id: string }>(`UPDATE control_resource_reservations SET state='expired' WHERE tenant_id=$1 AND state='active' AND expires_at <= $2 RETURNING id`, [input.tenantId,input.now]);
      const active = await tx.query<ReservationRow & { capacity_units: number }>(`SELECT r.*,h.capacity_units FROM control_resource_reservations r JOIN control_resource_reservation_heads h ON h.tenant_id=r.tenant_id AND h.resource_key=r.resource_key WHERE r.tenant_id=$1 AND r.state='active' AND r.expires_at > $2 ORDER BY r.resource_key,r.id`, [input.tenantId,input.now]);
      return {
        expiredReservationIds: expired.rows.map((row) => row.id).sort(),
        activeReservations: active.rows.map((row) => rowToReservation(row, Number(row.capacity_units))),
      };
    });
  }
}

interface ReservationRow { id: string; tenant_id: string; project_id: string; work_item_id: string; route_id: string; resource_key: string; units: number; decision_digest: string; state: ResourceReservation["state"]; acquired_at: string | Date; expires_at: string | Date; released_at: string | Date | null; }
function toInstant(value: string | Date): string { return new Date(value).toISOString(); }
function rowToReservation(row: ReservationRow, capacityUnits: number): ResourceReservation { return { id: row.id, tenantId: row.tenant_id, projectId: row.project_id, workItemId: row.work_item_id, routeId: row.route_id, resourceKey: row.resource_key, units: Number(row.units), capacityUnits, decisionDigest: row.decision_digest, state: row.state, acquiredAt: toInstant(row.acquired_at), expiresAt: toInstant(row.expires_at), ...(row.released_at ? { releasedAt: toInstant(row.released_at) } : {}) }; }
function sameReservation(value: ResourceReservation, input: ResourceReservationRequest): boolean { return value.id === input.id && value.tenantId === input.tenantId && value.projectId === input.projectId && value.workItemId === input.workItemId && value.routeId === input.routeId && value.resourceKey === input.resourceKey && value.units === input.units && value.capacityUnits === input.capacityUnits && value.decisionDigest === input.decisionDigest && value.acquiredAt === input.acquiredAt && value.expiresAt === input.expiresAt; }
