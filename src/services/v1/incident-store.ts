import type { DatabaseClient } from "../../persistence/database";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
function instant(value: string): boolean { const parsed = new Date(value); return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value; }
function json(value: unknown): string { return JSON.stringify(value); }

export interface ServiceIncidentV1 { id: string; tenantId: string; correlationKey: string; generation: number; serviceId: string; severity: "warning" | "critical"; safeReasonCode: string; safeRemedyCode: string; state: "open" | "resolved"; openedAt: string; lastObservedAt: string; resolvedAt?: string; }
export type ServiceIncidentInputV1 = { tenantId: string; serviceId: string; correlationKey: string; observedAt: string } & ({ action: "open_or_update"; severity: "warning" | "critical"; safeReasonCode: string; safeRemedyCode: string } | { action: "resolve" });
export class ServiceIncidentError extends Error { constructor(readonly safeCode: "invalid_incident") { super(safeCode); } }

function valid(input: ServiceIncidentInputV1): boolean { return [input.tenantId,input.serviceId,input.correlationKey].every((value) => safeId.test(value)) && instant(input.observedAt) && (input.action === "resolve" || (safeId.test(input.safeReasonCode) && safeId.test(input.safeRemedyCode) && ["warning","critical"].includes(input.severity))); }

/** Durable correlation ledger and outbox proposal only; it never repairs or operates a service. */
export class ServiceIncidentStore {
  constructor(private readonly db: DatabaseClient) {}
  /** Returns only tenant-bound durable incident projections; it never reads or repairs a host. */
  async list(input: { tenantId: string; state?: ServiceIncidentV1["state"]; limit: number }): Promise<ServiceIncidentV1[]> {
    if (!safeId.test(input.tenantId) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) throw new ServiceIncidentError("invalid_incident");
    const result = input.state
      ? await this.db.query<Row>(`SELECT * FROM control_service_incidents WHERE tenant_id=$1 AND state=$2 ORDER BY last_observed_at DESC,id LIMIT $3`, [input.tenantId,input.state,input.limit])
      : await this.db.query<Row>(`SELECT * FROM control_service_incidents WHERE tenant_id=$1 ORDER BY last_observed_at DESC,id LIMIT $2`, [input.tenantId,input.limit]);
    return result.rows.map((row) => rowToIncident(row));
  }
  async apply(input: ServiceIncidentInputV1): Promise<{ incident?: ServiceIncidentV1; replayed: boolean }> {
    if (!valid(input)) throw new ServiceIncidentError("invalid_incident");
    return this.db.transaction(async (tx) => {
      await tx.query(`INSERT INTO control_service_incident_heads (tenant_id,correlation_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [input.tenantId,input.correlationKey]);
      const head = await tx.query<{ next_generation: number }>(`SELECT next_generation FROM control_service_incident_heads WHERE tenant_id=$1 AND correlation_key=$2 FOR UPDATE`, [input.tenantId,input.correlationKey]);
      const open = await tx.query<Row>(`SELECT * FROM control_service_incidents WHERE tenant_id=$1 AND correlation_key=$2 AND state='open' FOR UPDATE`, [input.tenantId,input.correlationKey]);
      if (input.action === "resolve") {
        const current = open.rows[0];
        if (!current) return { replayed: true };
        await tx.query(`UPDATE control_service_incidents SET state='resolved',resolved_at=$4,last_observed_at=$4 WHERE tenant_id=$1 AND correlation_key=$2 AND generation=$3`, [input.tenantId,input.correlationKey,current.generation,input.observedAt]);
        const incident = { ...rowToIncident(current), state: "resolved" as const, resolvedAt: input.observedAt, lastObservedAt: input.observedAt };
        await this.outbox(tx, incident, "resolved", input.observedAt);
        return { incident, replayed: false };
      }
      const current = open.rows[0];
      if (current) {
        const prior = rowToIncident(current);
        const severity = prior.severity === "critical" || input.severity === "critical" ? "critical" : "warning";
        await tx.query(`UPDATE control_service_incidents SET severity=$4,safe_reason_code=$5,safe_remedy_code=$6,last_observed_at=$7 WHERE tenant_id=$1 AND correlation_key=$2 AND generation=$3`, [input.tenantId,input.correlationKey,prior.generation,severity,input.safeReasonCode,input.safeRemedyCode,input.observedAt]);
        return { incident: { ...prior, severity, safeReasonCode: input.safeReasonCode, safeRemedyCode: input.safeRemedyCode, lastObservedAt: input.observedAt }, replayed: true };
      }
      const generation = Number(head.rows[0]?.next_generation ?? 0) + 1;
      await tx.query(`UPDATE control_service_incident_heads SET next_generation=$3 WHERE tenant_id=$1 AND correlation_key=$2`, [input.tenantId,input.correlationKey,generation]);
      const incident: ServiceIncidentV1 = { id: `incident:${input.tenantId}:${input.correlationKey}:${generation}`, tenantId: input.tenantId, correlationKey: input.correlationKey, generation, serviceId: input.serviceId, severity: input.severity, safeReasonCode: input.safeReasonCode, safeRemedyCode: input.safeRemedyCode, state: "open", openedAt: input.observedAt, lastObservedAt: input.observedAt };
      await tx.query(`INSERT INTO control_service_incidents (id,tenant_id,correlation_key,generation,service_id,severity,safe_reason_code,safe_remedy_code,state,opened_at,last_observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$9)`, [incident.id,incident.tenantId,incident.correlationKey,incident.generation,incident.serviceId,incident.severity,incident.safeReasonCode,incident.safeRemedyCode,incident.openedAt]);
      await this.outbox(tx, incident, "opened", input.observedAt);
      return { incident, replayed: false };
    });
  }
  private async outbox(tx: { query<T>(statement: string, params?: unknown[]): Promise<{ rows: T[] }> }, incident: ServiceIncidentV1, event: "opened" | "resolved", at: string): Promise<void> {
    await tx.query(`INSERT INTO control_outbox (id,tenant_id,topic,aggregate_type,aggregate_id,idempotency_key,status,available_at,payload) VALUES ($1,$2,$3,'service_incident',$4,$5,'pending',$6,$7::jsonb) ON CONFLICT DO NOTHING`, [`outbox:${incident.tenantId}:${incident.id}:${event}`,incident.tenantId,`service.incident.${event}`,incident.id,`${incident.id}:${event}`,at,json({ incidentId: incident.id, correlationKey: incident.correlationKey, generation: incident.generation, serviceId: incident.serviceId, severity: incident.severity, safeReasonCode: incident.safeReasonCode, safeRemedyCode: incident.safeRemedyCode })]);
  }
}

interface Row { id: string; tenant_id: string; correlation_key: string; generation: number; service_id: string; severity: ServiceIncidentV1["severity"]; safe_reason_code: string; safe_remedy_code: string; state: ServiceIncidentV1["state"]; opened_at: string | Date; last_observed_at: string | Date; resolved_at: string | Date | null; }
function toInstant(value: string | Date): string { return new Date(value).toISOString(); }
function rowToIncident(row: Row): ServiceIncidentV1 { return { id: row.id, tenantId: row.tenant_id, correlationKey: row.correlation_key, generation: Number(row.generation), serviceId: row.service_id, severity: row.severity, safeReasonCode: row.safe_reason_code, safeRemedyCode: row.safe_remedy_code, state: row.state, openedAt: toInstant(row.opened_at), lastObservedAt: toInstant(row.last_observed_at), ...(row.resolved_at ? { resolvedAt: toInstant(row.resolved_at) } : {}) }; }
