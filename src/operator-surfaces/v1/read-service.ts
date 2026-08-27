import type { ServiceIncidentV1 } from "../../services/v1/incident-store";
import { ServiceIncidentStore } from "../../services/v1/incident-store";
import type { DatabaseClient } from "../../persistence/database";
import { jobRecordSchema, nodeRecordSchema, scheduleRecordSchema, serviceRecordSchema } from "../../domain/v1/validators";
import { OperatorSurfaceStoreV1 } from "./store";
import { buildOperatorSurfaceSnapshotV1, filterActionInboxV1 } from "./projections";
import type { ActionInboxFilterV1, ActiveWorkProjectionV1, BottleneckProjectionV1, FleetWorkerSummaryV1, OperatorSurfaceSnapshotV1, ScheduleProjectionV1, ServiceProjectionV1 } from "./types";
import { OPERATOR_SURFACES_CONTRACT_V1 } from "./types";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
function instant(value: string): boolean { return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
function isActiveWorkState(value: string): value is ActiveWorkProjectionV1["state"] { return value === "leased" || value === "running" || value === "waiting_approval"; }

/** This value is created by the server authentication layer, never decoded from an API query or request body. */
export interface AuthorizedOperatorReadScopeV1 { tenantId: string; actorId: string; grantedAt: string; }

/** Fleet and bottleneck sources must already enforce their own tenant binding before this read service consumes them. */
export interface OperatorFleetReadSourceV1 {
  fleet(input: { tenantId: string; now: string }): Promise<FleetWorkerSummaryV1[]>;
  bottlenecks(input: { tenantId: string; now: string }): Promise<BottleneckProjectionV1[]>;
  activeWork(input: { tenantId: string; now: string }): Promise<ActiveWorkProjectionV1[]>;
  services(input: { tenantId: string; now: string }): Promise<ServiceProjectionV1[]>;
  schedules(input: { tenantId: string; now: string }): Promise<ScheduleProjectionV1[]>;
}

export class DatabaseOperatorFleetReadSourceV1 implements OperatorFleetReadSourceV1 {
  constructor(private readonly db: DatabaseClient) {}

  /** Reads only normalized node state and signal availability; absent capacity remains explicitly unavailable. */
  async fleet(input: { tenantId: string; now: string }): Promise<FleetWorkerSummaryV1[]> {
    if (!safeId.test(input.tenantId) || !instant(input.now)) throw new OperatorSurfaceReadError("invalid_read_scope");
    const result = await this.db.query<{ id: string; state: string; payload: unknown; updated_at: string | Date; telemetry_expires_at: string | Date | null; capability_count: number }>(
      `SELECT n.id,n.state,n.payload,n.updated_at,
        MAX(CASE WHEN f.signal_kind='telemetry' AND f.signal_subject_id='node' THEN f.expires_at ELSE NULL END) AS telemetry_expires_at,
        COUNT(CASE WHEN f.signal_kind='capability' THEN 1 ELSE NULL END)::int AS capability_count
       FROM control_nodes n
       LEFT JOIN control_node_fleet_current f ON f.tenant_id=n.tenant_id AND f.node_id=n.id
       WHERE n.tenant_id=$1
       GROUP BY n.id,n.state,n.payload,n.updated_at
       ORDER BY n.id`,
      [input.tenantId],
    );
    return result.rows.map((row) => {
      const node = nodeRecordSchema.safeParse(row.payload);
      if (!node.success || node.data.tenantId !== input.tenantId || node.data.id !== row.id || node.data.state !== row.state) throw new OperatorSurfaceReadError("invalid_read_scope");
      const observedAt = node.data.lastSeenAt ?? new Date(row.updated_at).toISOString();
      const telemetryExpiry = row.telemetry_expires_at ? new Date(row.telemetry_expires_at).getTime() : undefined;
      const telemetryState = telemetryExpiry === undefined ? "missing" : telemetryExpiry > Date.parse(input.now) ? "fresh" : "stale";
      return {
        workerId: node.data.id,
        platform: node.data.platform,
        state: node.data.state === "active" ? "online" : node.data.state === "draining" ? "draining" : node.data.state === "offline" || node.data.state === "revoked" ? "offline" : node.data.state === "quarantined" ? "degraded" : "maintenance",
        ...(node.data.quarantineReasonCode ? { stateReasonCode: node.data.quarantineReasonCode } : {}),
        lastObservedAt: observedAt,
        capacityState: "unavailable" as const,
        capabilityState: Number(row.capability_count) > 0 ? "provisional" as const : "unavailable" as const,
        telemetryState,
      };
    });
  }

  async bottlenecks(input: { tenantId: string; now: string }): Promise<BottleneckProjectionV1[]> {
    if (!safeId.test(input.tenantId) || !instant(input.now)) throw new OperatorSurfaceReadError("invalid_read_scope");
    return [];
  }

  /** Reads active canonical jobs only. Job payloads are validated before any redacted fields are projected. */
  async activeWork(input: { tenantId: string; now: string }): Promise<ActiveWorkProjectionV1[]> {
    if (!safeId.test(input.tenantId) || !instant(input.now)) throw new OperatorSurfaceReadError("invalid_read_scope");
    const result = await this.db.query<{ id: string; project_id: string; state: string; payload: unknown; updated_at: string | Date }>(
      `SELECT id,project_id,state,payload,updated_at FROM control_jobs
       WHERE tenant_id=$1 AND state IN ('leased','running','waiting_approval')
       ORDER BY priority DESC,updated_at DESC,id LIMIT 1000`,
      [input.tenantId],
    );
    return result.rows.map((row) => {
      const job = jobRecordSchema.safeParse(row.payload);
      if (!job.success || job.data.tenantId !== input.tenantId || job.data.id !== row.id || job.data.projectId !== row.project_id || job.data.state !== row.state || !isActiveWorkState(job.data.state)) throw new OperatorSurfaceReadError("invalid_read_scope");
      return { jobId: job.data.id, projectId: job.data.projectId, state: job.data.state, jobType: job.data.jobType, priority: job.data.priority, requiredCapability: job.data.requiredCapability, updatedAt: new Date(row.updated_at).toISOString() };
    });
  }

  /** Projects persisted health/status facts only; the desired state and its digest never leave the server. */
  async services(input: { tenantId: string; now: string }): Promise<ServiceProjectionV1[]> {
    if (!safeId.test(input.tenantId) || !instant(input.now)) throw new OperatorSurfaceReadError("invalid_read_scope");
    const result = await this.db.query<{ id: string; project_id: string; state: string; payload: unknown }>(
      `SELECT id,project_id,state,payload FROM control_services WHERE tenant_id=$1 ORDER BY project_id,id LIMIT 1000`,
      [input.tenantId],
    );
    return result.rows.map((row) => {
      const service = serviceRecordSchema.safeParse(row.payload);
      if (!service.success || service.data.tenantId !== input.tenantId || service.data.id !== row.id || service.data.projectId !== row.project_id || service.data.state !== row.state) throw new OperatorSurfaceReadError("invalid_read_scope");
      return {
        serviceId: service.data.id,
        projectId: service.data.projectId,
        serviceType: service.data.serviceType,
        state: service.data.state,
        ...(service.data.safeStatusCode ? { statusCode: service.data.safeStatusCode } : {}),
        ...(service.data.lastObservedAt ? { lastObservedAt: service.data.lastObservedAt } : {}),
        ...(service.data.lastHealthyAt ? { lastHealthyAt: service.data.lastHealthyAt } : {}),
      };
    });
  }

  /** Projects schedule status only. The expression is intentionally absent because this screen cannot run it. */
  async schedules(input: { tenantId: string; now: string }): Promise<ScheduleProjectionV1[]> {
    if (!safeId.test(input.tenantId) || !instant(input.now)) throw new OperatorSurfaceReadError("invalid_read_scope");
    const result = await this.db.query<{ id: string; project_id: string; state: string; next_run_at: string | Date | null; payload: unknown }>(
      `SELECT id,project_id,state,next_run_at,payload FROM control_schedules WHERE tenant_id=$1 ORDER BY next_run_at NULLS LAST,id LIMIT 1000`,
      [input.tenantId],
    );
    return result.rows.map((row) => {
      const schedule = scheduleRecordSchema.safeParse(row.payload);
      if (!schedule.success || schedule.data.tenantId !== input.tenantId || schedule.data.id !== row.id || schedule.data.projectId !== row.project_id || schedule.data.state !== row.state) throw new OperatorSurfaceReadError("invalid_read_scope");
      const nextRunAt = row.next_run_at ? new Date(row.next_run_at).toISOString() : undefined;
      if (nextRunAt !== schedule.data.nextRunAt) throw new OperatorSurfaceReadError("invalid_read_scope");
      return {
        scheduleId: schedule.data.id,
        projectId: schedule.data.projectId,
        state: schedule.data.state,
        scheduleType: schedule.data.scheduleType,
        targetType: schedule.data.targetType,
        targetId: schedule.data.targetId,
        timezone: schedule.data.timezone,
        ...(nextRunAt ? { nextRunAt } : {}),
        idempotencyWindowSeconds: schedule.data.idempotencyWindowSeconds,
      };
    });
  }
}

export interface OperatorSurfaceReadModelV1 {
  snapshot: OperatorSurfaceSnapshotV1;
  serviceIncidents: ServiceIncidentV1[];
}

export class OperatorSurfaceReadError extends Error {
  constructor(readonly safeCode: "invalid_read_scope" | "invalid_filter") { super(safeCode); }
}

/** Assembles only read-only, redacted, tenant-scoped data. It performs no write, command, or external effect. */
export class OperatorSurfaceReadServiceV1 {
  constructor(
    private readonly surfaces: OperatorSurfaceStoreV1,
    private readonly incidents: ServiceIncidentStore,
    private readonly fleetSource: OperatorFleetReadSourceV1,
  ) {}

  async read(input: { scope: AuthorizedOperatorReadScopeV1; now: string; inboxFilter?: Omit<ActionInboxFilterV1, "now">; incidentState?: ServiceIncidentV1["state"] }): Promise<OperatorSurfaceReadModelV1> {
    if (!safeId.test(input.scope.tenantId) || !safeId.test(input.scope.actorId) || !instant(input.scope.grantedAt) || !instant(input.now)) throw new OperatorSurfaceReadError("invalid_read_scope");
    const tenantId = input.scope.tenantId;
    const [fleet, bottlenecks, activeWork, services, schedules, inbox, ownerFocus, serviceIncidents] = await Promise.all([
      this.fleetSource.fleet({ tenantId, now: input.now }),
      this.fleetSource.bottlenecks({ tenantId, now: input.now }),
      this.fleetSource.activeWork({ tenantId, now: input.now }),
      this.fleetSource.services({ tenantId, now: input.now }),
      this.fleetSource.schedules({ tenantId, now: input.now }),
      this.surfaces.listInbox({ tenantId, limit: 500 }),
      this.surfaces.listOwnerFocus({ tenantId, now: input.now }),
      this.incidents.list({ tenantId, state: input.incidentState, limit: 500 }),
    ]);
    const actionInbox = filterActionInboxV1(inbox, { now: input.now, limit: 100, ...input.inboxFilter });
    if (!actionInbox) throw new OperatorSurfaceReadError("invalid_filter");
    return {
      snapshot: buildOperatorSurfaceSnapshotV1({
        contractVersion: OPERATOR_SURFACES_CONTRACT_V1,
        tenantId,
        generatedAt: input.now,
        fleet,
        bottlenecks,
        activeWork,
        services,
        schedules,
        serviceIncidents: serviceIncidents.map((incident) => ({
          id: incident.id,
          serviceId: incident.serviceId,
          severity: incident.severity,
          state: incident.state,
          reasonCode: incident.safeReasonCode,
          remedyCode: incident.safeRemedyCode,
          openedAt: incident.openedAt,
          lastObservedAt: incident.lastObservedAt,
          ...(incident.resolvedAt ? { resolvedAt: incident.resolvedAt } : {}),
        })),
        actionInbox,
        ownerFocus,
      }),
      serviceIncidents,
    };
  }
}
