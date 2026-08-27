import type { ServiceIncidentV1 } from "../../services/v1/incident-store";
import { ServiceIncidentStore } from "../../services/v1/incident-store";
import { OperatorSurfaceStoreV1 } from "./store";
import { buildOperatorSurfaceSnapshotV1, filterActionInboxV1 } from "./projections";
import type { ActionInboxFilterV1, BottleneckProjectionV1, FleetWorkerSummaryV1, OperatorSurfaceSnapshotV1 } from "./types";
import { OPERATOR_SURFACES_CONTRACT_V1 } from "./types";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
function instant(value: string): boolean { return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }

/** This value is created by the server authentication layer, never decoded from an API query or request body. */
export interface AuthorizedOperatorReadScopeV1 { tenantId: string; actorId: string; grantedAt: string; }

/** Fleet and bottleneck sources must already enforce their own tenant binding before this read service consumes them. */
export interface OperatorFleetReadSourceV1 {
  fleet(input: { tenantId: string; now: string }): Promise<FleetWorkerSummaryV1[]>;
  bottlenecks(input: { tenantId: string; now: string }): Promise<BottleneckProjectionV1[]>;
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
    const [fleet, bottlenecks, inbox, ownerFocus, serviceIncidents] = await Promise.all([
      this.fleetSource.fleet({ tenantId, now: input.now }),
      this.fleetSource.bottlenecks({ tenantId, now: input.now }),
      this.surfaces.listInbox({ tenantId, limit: 500 }),
      this.surfaces.listOwnerFocus({ tenantId, now: input.now }),
      this.incidents.list({ tenantId, state: input.incidentState, limit: 500 }),
    ]);
    const actionInbox = filterActionInboxV1(inbox, { now: input.now, limit: 100, ...input.inboxFilter });
    if (!actionInbox) throw new OperatorSurfaceReadError("invalid_filter");
    return {
      snapshot: buildOperatorSurfaceSnapshotV1({ contractVersion: OPERATOR_SURFACES_CONTRACT_V1, tenantId, generatedAt: input.now, fleet, bottlenecks, actionInbox, ownerFocus }),
      serviceIncidents,
    };
  }
}
