import { AuthenticatedTelemetryReceiptStoreV1 } from "../../node-fleet/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import type { AuthenticatedTelemetryReceiptV1 } from "../../node-fleet/v1/authenticated-telemetry-receipt-store";
import { exactHostDataSnapshotV1 } from "../../security/host-value";
import type { ConnectionCenterFreshnessSourceV1 } from "./service";
import type { ConnectionCenterNodeFreshnessV1 } from "./types";

/**
 * Reads only server-keyed receipts emitted after NodeFleetSignalIngress has
 * authenticated a signed telemetry frame. The mutable fleet-current projection
 * is intentionally not consulted here.
 */
export class AuthenticatedFleetTelemetryFreshnessSourceV1 implements ConnectionCenterFreshnessSourceV1 {
  readonly #receipts: AuthenticatedTelemetryReceiptStoreV1;
  constructor(db: DatabaseClient, integrityKeyValue: unknown) {
    this.#receipts = new AuthenticatedTelemetryReceiptStoreV1(db, integrityKeyValue);
  }

  async read(input: { tenantId: string; nodeId: string; now: string }): Promise<ConnectionCenterNodeFreshnessV1> {
    return this.#readWith(input, scope => this.#receipts.read(scope));
  }

  async readInSession(session: DatabaseSession, input: { tenantId: string; nodeId: string; now: string }): Promise<ConnectionCenterNodeFreshnessV1> {
    return this.#readWith(input, scope => this.#receipts.readInSession(session, scope));
  }

  async #readWith(input: { tenantId: string; nodeId: string; now: string },
    read: (scope: { tenantId: string; nodeId: string }) => Promise<AuthenticatedTelemetryReceiptV1 | undefined>): Promise<ConnectionCenterNodeFreshnessV1> {
    const captured = exactHostDataSnapshotV1(input, ["tenantId", "nodeId", "now"]);
    if (!captured || typeof captured.tenantId !== "string" || typeof captured.nodeId !== "string"
      || typeof captured.now !== "string") throw new Error("invalid freshness scope");
    const telemetry = await read({ tenantId: captured.tenantId, nodeId: captured.nodeId });
    if (!telemetry) return Object.freeze({ state: "missing", basis: "none", observedAt: null, expiresAt: null });
    const now = Date.parse(captured.now), observed = Date.parse(telemetry.observedAt), expires = Date.parse(telemetry.expiresAt);
    const current = Number.isFinite(now) && observed <= now && expires > now && expires - observed <= 5 * 60_000;
    return Object.freeze({
      state: current ? "current" : "stale",
      basis: "authenticated_telemetry",
      observedAt: telemetry.observedAt,
      expiresAt: telemetry.expiresAt,
    });
  }
}
