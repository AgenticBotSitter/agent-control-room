import type { DatabaseClient } from "../../persistence/database";

const id = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
export class ProjectBudgetError extends Error { constructor(readonly safeCode: "invalid_budget" | "budget_ceiling_conflict" | "budget_exhausted" | "budget_reservation_conflict") { super(safeCode); } }
export interface BudgetReservationRequest { id: string; tenantId: string; projectId: string; ceilingMicrousd: number; estimatedMicrousd: number; createdAt: string; }
function valid(value: BudgetReservationRequest): boolean { return [value.id,value.tenantId,value.projectId].every((part) => id.test(part)) && [value.ceilingMicrousd,value.estimatedMicrousd].every(Number.isSafeInteger) && value.ceilingMicrousd >= 0 && value.estimatedMicrousd >= 0 && new Date(value.createdAt).toISOString() === value.createdAt; }

/** Atomic accounting reservation only; it does not charge a provider or authorize execution. */
export class ProjectBudgetStore {
  constructor(private readonly db: DatabaseClient) {}
  async reserve(input: BudgetReservationRequest): Promise<{ replayed: boolean }> {
    if (!valid(input)) throw new ProjectBudgetError("invalid_budget");
    return this.db.transaction(async (tx) => {
      await tx.query(`INSERT INTO control_project_budget_heads (tenant_id,project_id,ceiling_microusd) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,project_id) DO NOTHING`, [input.tenantId,input.projectId,input.ceilingMicrousd]);
      const head = await tx.query<{ ceiling_microusd: number }>(`SELECT ceiling_microusd FROM control_project_budget_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE`, [input.tenantId,input.projectId]);
      if (Number(head.rows[0]?.ceiling_microusd) !== input.ceilingMicrousd) throw new ProjectBudgetError("budget_ceiling_conflict");
      const prior = await tx.query<{ estimated_microusd: number }>(`SELECT estimated_microusd FROM control_project_budget_reservations WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [input.tenantId,input.id]);
      if (prior.rows[0]) { if (Number(prior.rows[0].estimated_microusd) !== input.estimatedMicrousd) throw new ProjectBudgetError("budget_reservation_conflict"); return { replayed: true }; }
      const used = await tx.query<{ used: number }>(`SELECT COALESCE(SUM(estimated_microusd),0)::bigint AS used FROM control_project_budget_reservations WHERE tenant_id=$1 AND project_id=$2 AND state='active'`, [input.tenantId,input.projectId]);
      if (Number(used.rows[0]?.used ?? 0) + input.estimatedMicrousd > input.ceilingMicrousd) throw new ProjectBudgetError("budget_exhausted");
      await tx.query(`INSERT INTO control_project_budget_reservations (id,tenant_id,project_id,estimated_microusd,state,created_at) VALUES ($1,$2,$3,$4,'active',$5)`, [input.id,input.tenantId,input.projectId,input.estimatedMicrousd,input.createdAt]);
      return { replayed: false };
    });
  }
}
