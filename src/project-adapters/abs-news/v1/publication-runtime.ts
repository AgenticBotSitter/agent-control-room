import { createHostResultCollectorV1, type HostResultCollectorV1 } from "../../../security/host-value";
import { ProjectWorkspaceContractErrorV1, projectWorkspaceTimeSchemaV1 } from "../../../project-workspace/v1";
import { sha256Digest } from "../../../security";
import {
  parseAbsNewsPublicationDestinationResultV1,
  type AbsNewsPublicationDestinationResultV1,
  type AbsNewsPublicationDestinationV1,
  type AbsNewsPublicationOutcomeV1,
  type AbsNewsPublicationPackageV1,
  type AbsNewsPublicationRequestV1,
} from "./publication";
import { SqliteAbsNewsPublicationStoreV1 } from "./publication-store";

export interface AbsNewsPublicationDestinationAdapterV1 {
  publish(input: { request: AbsNewsPublicationRequestV1; publicationPackage: AbsNewsPublicationPackageV1;
    destination: AbsNewsPublicationDestinationV1 }, result: HostResultCollectorV1): Promise<void>;
}

/**
 * An exact in-memory destination. It has no URL client, credential resolver,
 * filesystem writer, or public-site mutation path. Its own idempotency map
 * demonstrates duplicate absorption independently of the coordinator ledger.
 */
export class AbsNewsInjectedPublicationDestinationV1 implements AbsNewsPublicationDestinationAdapterV1 {
  readonly #results = new Map<string, AbsNewsPublicationDestinationResultV1>();
  readonly #applied = new Map<string, string>();
  #calls = 0;
  #publications = 0;

  constructor(results: unknown[]) {
    for (const value of results) {
      const result = parseAbsNewsPublicationDestinationResultV1(value);
      if (this.#results.has(result.destinationIdempotencyKey)) throw new ProjectWorkspaceContractErrorV1("replay_drift");
      this.#results.set(result.destinationIdempotencyKey, result);
    }
  }
  get callCount(): number { return this.#calls; }
  get publicationCount(): number { return this.#publications; }

  async publish(input: { request: AbsNewsPublicationRequestV1; publicationPackage: AbsNewsPublicationPackageV1;
    destination: AbsNewsPublicationDestinationV1 }, result: HostResultCollectorV1): Promise<void> {
    this.#calls += 1;
    const value = this.#results.get(input.request.destinationIdempotencyKey);
    if (!value) throw new Error("injected_publication_result_missing");
    if (value.status === "succeeded") {
      const prior = this.#applied.get(value.destinationIdempotencyKey);
      if (prior && prior !== value.resultDigest) throw new ProjectWorkspaceContractErrorV1("replay_drift");
      if (!prior) { this.#applied.set(value.destinationIdempotencyKey, value.resultDigest); this.#publications += 1; }
    }
    result.submit(value);
  }
}

export interface AbsNewsPublicationSimulationResultV1 {
  outcome: AbsNewsPublicationOutcomeV1;
  replayed: boolean;
  destinationInvoked: boolean;
}

function validateResult(bundle: ReturnType<SqliteAbsNewsPublicationStoreV1["loadBundle"]>, value: unknown): AbsNewsPublicationDestinationResultV1 {
  const result = parseAbsNewsPublicationDestinationResultV1(value);
  if (result.destinationId !== bundle.destination.destinationId
    || result.destinationIdentityDigest !== bundle.destination.destinationIdentityDigest
    || result.destinationIdempotencyKey !== bundle.request.destinationIdempotencyKey
    || result.packageDigest !== bundle.publicationPackage.packageDigest
    || result.contentRevision !== bundle.publicationPackage.contentRevision
    || result.contentDigest !== bundle.publicationPackage.contentDigest
    || result.destinationPath !== bundle.request.destinationPath) throw new ProjectWorkspaceContractErrorV1("replay_drift");
  return result;
}

/** Runs only a fake destination and rejects every live destination or authorization. */
export class AbsNewsPublicationSimulationCoordinatorV1 {
  constructor(private readonly store: SqliteAbsNewsPublicationStoreV1,
    private readonly destination: AbsNewsPublicationDestinationAdapterV1) {}

  async run(input: { requestId: string; claimedAt: string; markedAt: string; settledAt: string }): Promise<AbsNewsPublicationSimulationResultV1> {
    const claimedAt = projectWorkspaceTimeSchemaV1.parse(input.claimedAt), markedAt = projectWorkspaceTimeSchemaV1.parse(input.markedAt),
      settledAt = projectWorkspaceTimeSchemaV1.parse(input.settledAt), bundle = this.store.loadBundle(input.requestId);
    if (bundle.destination.environment !== "simulation" || bundle.destination.networkConfigured
      || bundle.destination.credentialsReferenceDigests.length > 0 || bundle.authorization.authorizationMode !== "simulation"
      || bundle.authorization.destinationWriteAuthorized) throw new ProjectWorkspaceContractErrorV1("unsupported_action");
    const claimed = this.store.claim({ request: bundle.request, authorization: bundle.authorization, claimedAt });
    if (claimed.disposition === "replay") return { outcome: claimed.outcome, replayed: true, destinationInvoked: false };
    if (claimed.disposition === "in_progress") {
      const settled = this.store.settle({ claim: claimed.claim, authorization: bundle.authorization, disposition: "ambiguous",
        safeReasonCode: "post_marker_outcome_unknown", startedAt: claimed.claim.updatedAt, settledAt });
      return { outcome: settled.outcome, replayed: false, destinationInvoked: false };
    }
    const marked = this.store.mark(claimed.claim, markedAt), handoff = createHostResultCollectorV1();
    try {
      await this.destination.publish({ request: bundle.request, publicationPackage: bundle.publicationPackage,
        destination: bundle.destination }, handoff.collector);
      const result = validateResult(bundle, handoff.take());
      if (Date.parse(result.observedAt) < Date.parse(markedAt) || Date.parse(result.observedAt) > Date.parse(settledAt)) {
        throw new ProjectWorkspaceContractErrorV1("replay_drift");
      }
      if (result.status === "definite_failure") {
        const settled = this.store.settle({ claim: marked.claim, authorization: bundle.authorization, disposition: "definite_failure",
          destinationResultDigest: result.resultDigest, safeReasonCode: "definite_destination_failure", startedAt: markedAt, settledAt });
        return { outcome: settled.outcome, replayed: false, destinationInvoked: true };
      }
      const receiptDigest = sha256Digest({ receiptId: result.receiptId, destinationRevisionDigest: result.destinationRevisionDigest,
        destinationIdempotencyKey: result.destinationIdempotencyKey, packageDigest: result.packageDigest,
        contentRevision: result.contentRevision, contentDigest: result.contentDigest, destinationPath: result.destinationPath });
      const settled = this.store.settle({ claim: marked.claim, authorization: bundle.authorization, disposition: "succeeded",
        destinationResultDigest: result.resultDigest, destinationReceiptDigest: receiptDigest,
        safeReasonCode: "synthetic_publication_complete", startedAt: markedAt, settledAt });
      return { outcome: settled.outcome, replayed: false, destinationInvoked: true };
    } catch {
      handoff.abort();
      const settled = this.store.settle({ claim: marked.claim, authorization: bundle.authorization, disposition: "ambiguous",
        safeReasonCode: "post_marker_outcome_unknown", startedAt: markedAt, settledAt });
      return { outcome: settled.outcome, replayed: false, destinationInvoked: true };
    }
  }
}
