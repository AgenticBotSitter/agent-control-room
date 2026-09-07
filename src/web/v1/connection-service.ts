import type { DatabaseClient } from "../../persistence/database";
import { ConnectionRegistryStoreV1 } from "../../connection-registry/v1/store";
import { ConnectionCenterReadServiceV1 } from "../../connection-center/v1/service";
import { AuthenticatedFleetTelemetryFreshnessSourceV1 } from "../../connection-center/v1/authenticated-freshness";
import type { VerifiedWebIdentity } from "./access-verifier";
import { WebSessionAuthority } from "./session-authority";
import { queueAttentionSchema, type QueueAttentionSource } from "./queue-attention-wire";

export interface WebConnectionKeys {
  registryIntegrityKey: Uint8Array;
  /** Omission means signal evidence is not configured, never evidence of a current signal. */
  telemetryIntegrityKey?: Uint8Array;
}

/** Reads existing enrollments only. No intake, listener, native driver, provider or command port. */
export class WebConnectionService {
  private readonly authority: WebSessionAuthority;
  private readonly registry?: ConnectionRegistryStoreV1;
  private readonly freshness?: AuthenticatedFleetTelemetryFreshnessSourceV1;
  constructor(db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    clock: () => number = Date.now, keys?: WebConnectionKeys) {
    this.authority = new WebSessionAuthority(db, scope, clock, "connection_inventory");
    if (keys) {
      this.registry = new ConnectionRegistryStoreV1(db, keys.registryIntegrityKey);
      if (keys.telemetryIntegrityKey !== undefined)
        this.freshness = new AuthenticatedFleetTelemetryFreshnessSourceV1(db, keys.telemetryIntegrityKey);
    }
  }

  async authorize(identity: VerifiedWebIdentity): Promise<void> {
    await this.authority.authenticated(identity, async (_, actor) => { actor.require("connections.read", undefined, true); });
  }

  async read(identity: VerifiedWebIdentity) {
    return this.authority.authenticated(identity, async (tx, actor) => {
      // This registry is tenant-wide. Per-project and operator grants cannot enumerate it.
      actor.require("connections.read", undefined, true);
      if (!this.registry) throw new Error("connection_inventory_not_configured");
      const source = new ConnectionCenterReadServiceV1({ read: input => this.registry!.readInSession(tx, input) },
        this.freshness ? { read: input => this.freshness!.readInSession(tx, input) } : undefined);
      const projection = await source.read({ tenantId: this.scope.tenantId, now: actor.now });
      return { projection, telemetry: this.freshness ? "configured" as const : "not_configured" as const };
    });
  }
  async readQueueAttention(identity: VerifiedWebIdentity, source?: QueueAttentionSource) {
    return this.authority.authenticated(identity, async (_, actor) => {
      actor.require("connections.read", undefined, true);
      if (!source) throw new Error("queue_attention_not_configured");
      return queueAttentionSchema.parse(source.read());
    });
  }
}
