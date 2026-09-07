import { NodeProtocolAuthenticator } from "../node-protocol/v1/authentication";
import type { HarnessRunStoreV1 } from "../harness/v1/store";

/** Inert server ingestion component: authenticate the existing node protocol, then persist evidence.
 * Composition supplies transport identity/connection; no browser route, listener, dispatch or retry. */
export class NativeTaskSnapshotService {
  constructor(private readonly authentication: NodeProtocolAuthenticator, private readonly runs: HarnessRunStoreV1) {}
  async ingest(raw: string | Uint8Array, options: { transportIdentity: string; expectedConnectionId: string; receivedAt: string }) {
    try {
      if (!options.transportIdentity || !options.expectedConnectionId) throw new Error("missing transport binding");
      const { frame } = await this.authentication.verify(raw, { ...options, expectedDirection: "node_to_server", maxFrameBytes: 16_384 });
      if (frame.type !== "harness.native.snapshot" || Date.parse(frame.body.observedAt) > Date.parse(frame.sentAt)) throw new Error("invalid observation");
      // Replay authentication alone is not proof of persistence: a previous transaction may have failed.
      const stored = await this.runs.recordNativeSnapshot(frame.tenantId, frame.actorId, frame.body);
      return { event: { runId: frame.body.runId, snapshotVersion: frame.body.snapshotVersion, replayed: stored.replayed },
        acknowledgement: { acknowledgedMessageIds: [frame.messageId], highestContiguousSequence: frame.sequence,
          disposition: stored.replayed ? "duplicate" as const : "accepted" as const } };
    } catch { throw new Error("native_snapshot_rejected"); }
  }
}
