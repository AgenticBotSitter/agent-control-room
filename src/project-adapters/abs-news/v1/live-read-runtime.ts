import { createHostResultCollectorV1, type HostResultCollectorV1 } from "../../../security/host-value";
import { ProjectWorkspaceContractErrorV1, projectWorkspaceTimeSchemaV1 } from "../../../project-workspace/v1";
import { sha256Digest } from "../../../security";
import {
  parseAbsNewsLiveReadTransportResultV1,
  type AbsNewsLiveReadOutcomeV1,
  type AbsNewsLiveReadRequestV1,
  type AbsNewsLiveReadSourceV1,
  type AbsNewsLiveReadTransportResultV1,
} from "./live-read";
import { SqliteAbsNewsLiveReadStoreV1 } from "./live-read-store";

export interface AbsNewsLiveReadTransportV1 {
  /** The only CR9D-ABS-060 transport seam. Implementations submit one exact result and return no value. */
  read(input: { request: AbsNewsLiveReadRequestV1; source: AbsNewsLiveReadSourceV1 }, result: HostResultCollectorV1): Promise<void>;
}

export class AbsNewsInjectedLiveReadTransportV1 implements AbsNewsLiveReadTransportV1 {
  readonly #results = new Map<string, AbsNewsLiveReadTransportResultV1>();
  #calls = 0;
  constructor(results: unknown[]) {
    for (const value of results) {
      const result = parseAbsNewsLiveReadTransportResultV1(value);
      if (this.#results.has(result.sourceId)) throw new ProjectWorkspaceContractErrorV1("replay_drift");
      this.#results.set(result.sourceId, result);
    }
  }
  get callCount(): number { return this.#calls; }
  async read(input: { source: AbsNewsLiveReadSourceV1 }, result: HostResultCollectorV1): Promise<void> {
    this.#calls += 1;
    const value = this.#results.get(input.source.sourceId);
    if (!value) throw new Error("injected_result_missing");
    result.submit(value);
  }
}

export interface AbsNewsLiveReadSimulationResultV1 {
  outcome: AbsNewsLiveReadOutcomeV1;
  replayed: boolean;
  callCount: number;
}

function validateResult(request: AbsNewsLiveReadRequestV1, source: AbsNewsLiveReadSourceV1, value: unknown): AbsNewsLiveReadTransportResultV1 {
  const result = parseAbsNewsLiveReadTransportResultV1(value);
  if (result.sourceId !== source.sourceId || result.sourceDigest !== source.sourceDigest
    || result.requestedUrl !== source.endpointUrl || result.finalUrl !== source.endpointUrl
    || result.responseByteCount > request.maxResponseBytes) throw new ProjectWorkspaceContractErrorV1("replay_drift");
  if (result.status === "succeeded") {
    if (!request.allowedContentTypes.includes(result.contentType!) || result.batch!.sourceId !== source.sourceId
      || result.batch!.sourceKind !== source.sourceKind || result.batch!.sourceLabel !== source.sourceLabel || result.batch!.items.length > request.maxItemsPerSource
      || result.batch!.items.some((item) => item.sourceId !== source.sourceId || item.sourceKind !== source.sourceKind)) {
      throw new ProjectWorkspaceContractErrorV1("replay_drift");
    }
  }
  return result;
}

/**
 * Runs only injected, explicitly synthetic evidence. It cannot construct a
 * network client, resolve a credential, start a background process, or spend
 * model/provider budget.
 */
export class AbsNewsLiveReadSimulationCoordinatorV1 {
  constructor(private readonly store: SqliteAbsNewsLiveReadStoreV1, private readonly transport: AbsNewsLiveReadTransportV1) {}

  async run(input: { requestId: string; claimedAt: string; markedAt: string; settledAt: string }): Promise<AbsNewsLiveReadSimulationResultV1> {
    const claimedAt = projectWorkspaceTimeSchemaV1.parse(input.claimedAt), markedAt = projectWorkspaceTimeSchemaV1.parse(input.markedAt), settledAt = projectWorkspaceTimeSchemaV1.parse(input.settledAt);
    const bundle = this.store.loadBundle(input.requestId);
    if (bundle.authorization.authorizationMode !== "simulation" || bundle.authorization.networkReadAuthorized) throw new ProjectWorkspaceContractErrorV1("unsupported_action");
    const claimed = this.store.claim({ request: bundle.request, authorization: bundle.authorization, claimedAt });
    if (claimed.disposition === "replay") return { outcome: claimed.outcome, replayed: true, callCount: 0 };
    if (claimed.disposition === "in_progress") {
      const settled = this.store.settle({ claim: claimed.claim, authorization: bundle.authorization, disposition: "ambiguous", sourceResultDigests: [], batchDigests: [], itemCount: 0, totalResponseBytes: 0, safeReasonCode: "post_marker_outcome_unknown", startedAt: claimed.claim.updatedAt, settledAt });
      return { outcome: settled.outcome, replayed: false, callCount: 0 };
    }
    const marked = this.store.mark(claimed.claim, markedAt);
    const resultDigests: string[] = [], batchDigests: string[] = [];
    let itemCount = 0, totalResponseBytes = 0, calls = 0;
    try {
      for (const source of bundle.request.sources) {
        const handoff = createHostResultCollectorV1();
        try {
          await this.transport.read({ request: bundle.request, source }, handoff.collector);
          calls += 1;
          const result = validateResult(bundle.request, source, handoff.take());
          if (Date.parse(result.observedAt) < Date.parse(markedAt) || Date.parse(result.observedAt) > Date.parse(settledAt)) throw new ProjectWorkspaceContractErrorV1("replay_drift");
          resultDigests.push(result.resultDigest);
          if (result.status === "definite_failure") {
            const settled = this.store.settle({ claim: marked.claim, authorization: bundle.authorization, disposition: "definite_failure", sourceResultDigests: resultDigests, batchDigests, itemCount, totalResponseBytes, safeReasonCode: "definite_transport_failure", startedAt: markedAt, settledAt });
            return { outcome: settled.outcome, replayed: false, callCount: calls };
          }
          totalResponseBytes += result.responseByteCount;
          if (totalResponseBytes > bundle.request.maxTotalBytes) throw new ProjectWorkspaceContractErrorV1("unsupported_action");
          itemCount += result.batch!.items.length;
          batchDigests.push(sha256Digest(result.batch));
        } catch (error) {
          handoff.abort();
          throw error;
        }
      }
      if (Date.parse(settledAt) - Date.parse(markedAt) > bundle.request.maxRuntimeSeconds * 1_000) throw new ProjectWorkspaceContractErrorV1("unsupported_action");
      const settled = this.store.settle({ claim: marked.claim, authorization: bundle.authorization, disposition: "succeeded", sourceResultDigests: resultDigests, batchDigests, itemCount, totalResponseBytes, safeReasonCode: "synthetic_read_complete", startedAt: markedAt, settledAt });
      return { outcome: settled.outcome, replayed: false, callCount: calls };
    } catch {
      const settled = this.store.settle({ claim: marked.claim, authorization: bundle.authorization, disposition: "ambiguous", sourceResultDigests: resultDigests, batchDigests, itemCount, totalResponseBytes, safeReasonCode: "post_marker_outcome_unknown", startedAt: markedAt, settledAt });
      return { outcome: settled.outcome, replayed: false, callCount: calls };
    }
  }
}
