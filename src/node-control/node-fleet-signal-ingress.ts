import { FleetSignalStore, FleetSignalStoreError } from "../node-fleet/v1";
import { NodeProtocolAuthenticator, type ProtocolAcknowledgementBody } from "../node-protocol/v1";
import type { DatabaseClient } from "../persistence/database";

export interface ReceiveNodeFleetSignalOptions {
  transportIdentity: string;
  receivedAt: string;
  expectedConnectionId?: string;
}

/** Authenticates a raw fleet frame before it can reach fleet persistence. */
export class NodeFleetSignalIngress {
  private readonly signals: FleetSignalStore;

  constructor(private readonly authenticator: NodeProtocolAuthenticator, db: DatabaseClient) {
    this.signals = new FleetSignalStore(db);
  }

  async receive(raw: string | Uint8Array, options: ReceiveNodeFleetSignalOptions): Promise<{ replayed: boolean; acknowledgement: ProtocolAcknowledgementBody }> {
    const verified = await this.authenticator.verify(raw, {
      expectedDirection: "node_to_server", transportIdentity: options.transportIdentity, receivedAt: options.receivedAt,
      ...(options.expectedConnectionId ? { expectedConnectionId: options.expectedConnectionId } : {}),
    });
    if (verified.frame.type !== "node.fleet.signal") throw new FleetSignalStoreError("invalid_signal");
    const replay = await this.signals.ingestAuthenticated(verified.frame.body, options.receivedAt, { tenantId: verified.frame.tenantId, nodeId: verified.frame.actorId });
    return { replayed: replay.replayed, acknowledgement: { acknowledgedMessageIds: [verified.frame.messageId], highestContiguousSequence: verified.frame.sequence, disposition: verified.delivery === "duplicate" || replay.replayed ? "duplicate" : "accepted" } };
  }
}
