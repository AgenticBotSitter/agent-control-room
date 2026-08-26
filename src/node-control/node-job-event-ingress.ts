import {
  NodeProtocolAuthenticator,
  type ProtocolAcknowledgementBody,
  type SignedNodeFrame,
} from "../node-protocol/v1";
import { NodeJobEventError, NodeJobEventService, type IngestedNodeJobEventV1 } from "./job-event-service";

export interface ReceiveNodeJobEventOptions {
  /** A transport-derived identifier; never accept this value from the frame body. */
  transportIdentity: string;
  receivedAt: string;
  expectedConnectionId?: string;
}

export interface ReceivedNodeJobEvent {
  event: IngestedNodeJobEventV1;
  acknowledgement: ProtocolAcknowledgementBody;
}

/**
 * The server-side boundary for node job evidence.  It authenticates the raw
 * signed frame before durable business processing, and only returns an ACK
 * after that processing has completed successfully.  A transport adapter is
 * responsible for signing and delivering the returned acknowledgement.
 */
export class NodeJobEventIngress {
  constructor(
    private readonly authenticator: NodeProtocolAuthenticator,
    private readonly events: NodeJobEventService,
  ) {}

  async receive(raw: string | Uint8Array, options: ReceiveNodeJobEventOptions): Promise<ReceivedNodeJobEvent> {
    const verified = await this.authenticator.verify(raw, {
      expectedDirection: "node_to_server",
      transportIdentity: options.transportIdentity,
      receivedAt: options.receivedAt,
      ...(options.expectedConnectionId ? { expectedConnectionId: options.expectedConnectionId } : {}),
    });
    if (verified.frame.type !== "job.event") throw new NodeJobEventError("invalid_event");
    const event = await this.events.ingestAuthenticated(verified.frame as SignedNodeFrame<"job.event">, options.receivedAt);
    return {
      event,
      acknowledgement: {
        acknowledgedMessageIds: [verified.frame.messageId],
        highestContiguousSequence: verified.frame.sequence,
        disposition: verified.delivery === "duplicate" || event.replayed ? "duplicate" : "accepted",
      },
    };
  }
}
