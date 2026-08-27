import type { DatabaseClient } from "../../persistence/database";

const id = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
export class ProjectBudgetError extends Error { constructor(readonly safeCode: "invalid_budget" | "budget_ceiling_conflict" | "budget_exhausted" | "budget_reservation_conflict" | "budget_reservation_not_found") { super(safeCode); } }
export interface BudgetReservationRequest { id: string; tenantId: string; projectId: string; ceilingMicrousd: number; estimatedMicrousd: number; createdAt: string; }
function instant(value: string): boolean { const parsed = new Date(value); return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value; }
function valid(value: BudgetReservationRequest): boolean { return [value.id,value.tenantId,value.projectId].every((part) => id.test(part)) && [value.ceilingMicrousd,value.estimatedMicrousd].every(Number.isSafeInteger) && value.ceilingMicrousd >= 0 && value.estimatedMicrousd >= 0 && instant(value.createdAt); }

/** Atomic accounting reservation only; it does not charge a provider or authorize execution. */
export class ProjectBudgetStore {
  constructor(private readonly db: DatabaseClient) {}
  async reserve(input: BudgetReservationRequest): Promise<{ replayed: boolean }> {
    if (!valid(input)) throw new ProjectBudgetError("invalid_budget");
    return this.db.transaction(async (tx) => {
      await tx.query(`INSERT INTO control_project_budget_heads (tenant_id,project_id,ceiling_microusd) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,project_id) DO NOTHING`, [input.tenantId,input.projectId,input.ceilingMicrousd]);
      const head = await tx.query<{ ceiling_microusd: number }>(`SELECT ceiling_microusd FROM control_project_budget_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE`, [input.tenantId,input.projectId]);
      if (Number(head.rows[0]?.ceiling_microusd) !== input.ceilingMicrousd) throw new ProjectBudgetError("budget_ceiling_conflict");
      const prior = await tx.query<{ project_id: string; estimated_microusd: number; created_at: string | Date }>(`SELECT project_id,estimated_microusd,created_at FROM control_project_budget_reservations WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [input.tenantId,input.id]);
      if (prior.rows[0]) { if (prior.rows[0].project_id !== input.projectId || Number(prior.rows[0].estimated_microusd) !== input.estimatedMicrousd || new Date(prior.rows[0].created_at).toISOString() !== input.createdAt) throw new ProjectBudgetError("budget_reservation_conflict"); return { replayed: true }; }
      const used = await tx.query<{ used: number }>(`SELECT COALESCE(SUM(estimated_microusd),0)::bigint AS used FROM control_project_budget_reservations WHERE tenant_id=$1 AND project_id=$2 AND state='active'`, [input.tenantId,input.projectId]);
      if (Number(used.rows[0]?.used ?? 0) + input.estimatedMicrousd > input.ceilingMicrousd) throw new ProjectBudgetError("budget_exhausted");
      await tx.query(`INSERT INTO control_project_budget_reservations (id,tenant_id,project_id,estimated_microusd,state,created_at) VALUES ($1,$2,$3,$4,'active',$5)`, [input.id,input.tenantId,input.projectId,input.estimatedMicrousd,input.createdAt]);
      return { replayed: false };
    });
  }

  async release(input: { tenantId: string; id: string; releasedAt: string }): Promise<{ replayed: boolean }> {
    if (!id.test(input.tenantId) || !id.test(input.id) || !instant(input.releasedAt)) throw new ProjectBudgetError("invalid_budget");
    return this.db.transaction(async (tx) => {
      const prior = await tx.query<{ state: "active" | "released"; created_at: string | Date }>(`SELECT state,created_at FROM control_project_budget_reservations WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [input.tenantId,input.id]);
      if (!prior.rows[0]) throw new ProjectBudgetError("budget_reservation_not_found");
      if (prior.rows[0].state === "released") return { replayed: true };
      if (Date.parse(input.releasedAt) < new Date(prior.rows[0].created_at).getTime()) throw new ProjectBudgetError("invalid_budget");
      await tx.query(`UPDATE control_project_budget_reservations SET state='released',released_at=$3 WHERE tenant_id=$1 AND id=$2`, [input.tenantId,input.id,input.releasedAt]);
      return { replayed: false };
    });
  }
}
