import { evaluateFleetSignalFreshness, FleetSignalStore } from "../../node-fleet/v1";
import type { DatabaseClient } from "../../persistence/database";
import type { ConnectionCenterFreshnessSourceV1 } from "./service";
import type { ConnectionCenterNodeFreshnessV1 } from "./types";

/**
 * Reads only telemetry that crossed NodeFleetSignalIngress authentication before
 * persistence. Discovery, capabilities, and benchmarks never imply recency.
 */
export class AuthenticatedFleetTelemetryFreshnessSourceV1 implements ConnectionCenterFreshnessSourceV1 {
  readonly #store: FleetSignalStore;
  constructor(db: DatabaseClient) { this.#store = new FleetSignalStore(db); }

  async read(input: { tenantId: string; nodeId: string; now: string }): Promise<ConnectionCenterNodeFreshnessV1> {
    const telemetry = (await this.#store.current({ tenantId: input.tenantId, nodeId: input.nodeId }))
      .find((signal) => signal.kind === "telemetry");
    if (!telemetry) return Object.freeze({ state: "missing", basis: "none", observedAt: null, expiresAt: null });
    const freshness = evaluateFleetSignalFreshness(telemetry, input.now);
    return Object.freeze({
      state: freshness.eligible ? "current" : "stale",
      basis: "authenticated_telemetry",
      observedAt: telemetry.observedAt,
      expiresAt: telemetry.expiresAt,
    });
  }
}
