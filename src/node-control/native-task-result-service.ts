import type { NodeProtocolAuthenticator } from "../node-protocol/v1/authentication";
import type { HarnessRunStoreV1 } from "../harness/v1/store";
import type { NativeResultStore } from "../artifacts/v1/native-results";
import type { NativeResultSubmissionService } from "../completion-gate/v1/native-result-submission";

/** Inert private upload ingestion. A signed snapshot authenticates the exact bytes' recorded hash/size.
 * Transport supplies both arguments; this class starts no upload/listener/native run and never logs content. */
export class NativeTaskResultService {
  constructor(private readonly authentication: NodeProtocolAuthenticator, private readonly runs: HarnessRunStoreV1,
    private readonly results: NativeResultStore,
    private readonly submission?: Pick<NativeResultSubmissionService, "submit">) {}
  async ingest(raw: string | Uint8Array, bytes: Uint8Array,
    options: { transportIdentity: string; expectedConnectionId: string; receivedAt: string }) {
    try {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 65_536 || !options.transportIdentity || !options.expectedConnectionId) throw new Error();
      const owned = Uint8Array.from(bytes);
      const { frame } = await this.authentication.verify(raw, { ...options, expectedDirection: "node_to_server", maxFrameBytes: 16_384 });
      if (frame.type !== "harness.native.snapshot" || frame.body.state !== "completed" || !frame.body.result
        || Date.parse(frame.body.observedAt) > Date.parse(frame.sentAt)) throw new Error();
      await this.runs.recordNativeSnapshot(frame.tenantId, frame.actorId, frame.body);
      const captured = await this.results.capture(frame.tenantId, frame.actorId, frame.body, owned, options.receivedAt);
      if (this.submission) await this.submission.submit(frame.tenantId, frame.body.runId);
      return captured;
    } catch { throw new Error("native_result_rejected"); }
  }
}
