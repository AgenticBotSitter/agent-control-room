import { sha256Digest } from "../../security";
import type { ReadyFrontierMaterializationServiceV1 } from "./materialization-service";
import {
  buildReadyFrontierFakeDeliveryAcknowledgementV1,
  parseReadyFrontierNoRelayRequestV1,
  projectReadyFrontierNoRelayV1,
  validateReadyFrontierFakeDeliveryForRunV1,
} from "./no-relay";
import type { ReadyFrontierNoRelayStoreV1 } from "./no-relay-store";
import {
  READY_FRONTIER_FAKE_DELIVERY_REQUEST_V1,
  type ReadyFrontierFakeDeliveryPortV1,
  type ReadyFrontierFakeDeliveryRequestV1,
  type ReadyFrontierNoRelayProjectionV1,
  type ReadyFrontierNoRelayResultV1,
} from "./no-relay-types";
import type { ReadyFrontierPromotionServiceV1, ReadyFrontierTrustedClockV1 } from "./promotion-service";
import { READY_FRONTIER_PROMOTION_REQUEST_V1, type ReadyFrontierPromotionBuildInputV1 } from "./ready-policy-types";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { readyFrontierTimeSchemaV1 } from "./schemas";
import { exactHostUint8ArrayV1 } from "../../security/host-value";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }

const repositoryFakePorts = new WeakSet<object>();
const repositoryFakeDeliveryCounts = new WeakMap<object, number>();

/** A fixed in-memory fake. It has no callback, client, locator, credential, network, process, or filesystem seam. */
export class ReadyFrontierInMemoryFakeDeliveryV1 implements ReadyFrontierFakeDeliveryPortV1 {
  constructor(private readonly outcome: "acknowledge" | "throw_after_marker" | "malformed",
    private readonly acknowledgedAt: string) {
    parseExactReadyFrontierV1(readyFrontierTimeSchemaV1, acknowledgedAt); repositoryFakePorts.add(this);
    repositoryFakeDeliveryCounts.set(this, 0); Object.freeze(this);
  }
  async deliver(request: ReadyFrontierFakeDeliveryRequestV1): Promise<unknown> {
    repositoryFakeDeliveryCounts.set(this, (repositoryFakeDeliveryCounts.get(this) ?? 0) + 1);
    if (this.outcome === "throw_after_marker") throw new Error("repository fake delivery interruption");
    if (this.outcome === "malformed") return Object.freeze({ schema: "invalid-repository-fake-result" });
    return buildReadyFrontierFakeDeliveryAcknowledgementV1({ runId: request.runId,
      deliveryId: request.deliveryId, jobId: request.jobId, routeId: request.routeId,
      handoffId: request.handoffId, acknowledgedAt: this.acknowledgedAt,
      state: "acknowledged_repository_simulation", repositorySimulationOnly: true,
      createsAttempt: false, createsLease: false, claimsJob: false, dispatchesOrExecutes: false,
      contactsProvider: false, messagesAgent: false, mutatesGitHub: false, grantsExternalEffect: false });
  }
  deliveryCount(): number { return repositoryFakeDeliveryCounts.get(this) ?? 0; }
}
const repositoryFakeDeliver = ReadyFrontierInMemoryFakeDeliveryV1.prototype.deliver;

/**
 * Repository-only end-to-end coordinator. It composes accepted modules and terminates at a fake acknowledgement;
 * it has no production consumer, claim, lease, dispatch, agent, provider, GitHub, or external-effect client.
 */
export class ReadyFrontierNoRelayCoordinatorV1 {
  private readonly activeRuns = new Set<string>();
  private readonly runIntegrityKey: Uint8Array;
  constructor(private readonly materializer: ReadyFrontierMaterializationServiceV1,
    private readonly promoter: ReadyFrontierPromotionServiceV1, private readonly store: ReadyFrontierNoRelayStoreV1,
    private readonly fakeDelivery: ReadyFrontierInMemoryFakeDeliveryV1,
    private readonly deliveryClock: ReadyFrontierTrustedClockV1, runIntegrityKeyValue: unknown) {
    const runIntegrityKey = exactHostUint8ArrayV1(runIntegrityKeyValue, 128);
    if (!repositoryFakePorts.has(fakeDelivery as object)
      || Object.getPrototypeOf(fakeDelivery) !== ReadyFrontierInMemoryFakeDeliveryV1.prototype
      || !Object.isFrozen(fakeDelivery) || !runIntegrityKey || runIntegrityKey.byteLength < 32) fail("policy_denied");
    this.runIntegrityKey = runIntegrityKey.copy();
  }

  async run(value: unknown): Promise<ReadyFrontierNoRelayResultV1> {
    const request = parseReadyFrontierNoRelayRequestV1(value), requestDigest = sha256Digest(request);
    if (this.activeRuns.has(request.runId)) fail("policy_inactive");
    const existing = this.store.current(request.runId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) fail("replay_drift");
      if (existing.state === "delivery_started") {
        const recovered = this.store.complete(existing.runId, existing.requestDigest,
          { state: "terminal_ambiguous", updatedAt: Date.parse(request.observedAt) < Date.parse(existing.updatedAt)
            ? existing.updatedAt : request.observedAt });
        return { run: recovered, materializationReplayed: true, promotionReplayed: true, runReplayed: true };
      }
      return { run: existing, materializationReplayed: true, promotionReplayed: true, runReplayed: true };
    }
    this.activeRuns.add(request.runId);
    try {
      const deliveryPreflightNow = this.readDeliveryClock();
      if (Date.parse(deliveryPreflightNow) < Date.parse(request.promotedAt)) fail("replay_drift");
      const materialization = await this.materializer.materialize(request.materializationRequest);
      const materialized = materialization.receipt;
      const promotionInput: ReadyFrontierPromotionBuildInputV1 = {
        request: { schema: READY_FRONTIER_PROMOTION_REQUEST_V1, requestId: request.promotionRequestId,
          tenantId: materialized.tenantId, workspaceId: materialized.workspaceId,
          materializationReceiptId: materialized.receiptId, materializationReceiptDigest: materialized.receiptDigest,
          jobId: materialized.job.id, standingPolicyId: materialized.standingPolicyId,
          standingPolicyRevision: materialized.standingPolicyRevision,
          standingPolicyDigest: materialized.standingPolicyDigest, readyPolicyId: request.readyPolicyId,
          readyPolicyRevision: request.readyPolicyRevision, readyPolicyDigest: request.readyPolicyDigest,
          requestedAt: request.promotionRequestedAt, promotedAt: request.promotedAt,
          reservationExpiresAt: request.reservationExpiresAt,
          trigger: "standing_ready_policy_repository_simulation", repositorySimulationOnly: true,
          createsApproval: false, createsSchedule: false, permitsReadyTransition: true,
          permitsDatabaseSchedulerReservation: true, permitsInternalJobberHandoff: true,
          permitsClaimOrLease: false, permitsDispatchOrExecution: false, permitsProviderContact: false,
          permitsAgentMessage: false, permitsGitHubMutation: false, permitsExternalEffects: false },
        materializationReceipt: materialized,
      };
      const promotion = await this.promoter.promote(promotionInput), receipt = promotion.receipt;
      if (receipt.tenantId !== request.tenantId || receipt.workspaceId !== request.workspaceId) fail("scope_mismatch");
      const deliveryId = `frontier.fake-delivery:${sha256Digest({ runId: request.runId,
        handoffPacketDigest: receipt.handoff.packetDigest }).slice(7, 31)}`;
      const deliveryNow = this.readDeliveryClock();
      if (Date.parse(deliveryNow) < Date.parse(deliveryPreflightNow)
        || Date.parse(deliveryNow) < Date.parse(receipt.promotedAt)) fail("replay_drift");
      const delivery: ReadyFrontierFakeDeliveryRequestV1 = {
        schema: READY_FRONTIER_FAKE_DELIVERY_REQUEST_V1, runId: request.runId, deliveryId,
        tenantId: receipt.tenantId, workspaceId: receipt.workspaceId, projectId: receipt.readyJob.projectId,
        jobId: receipt.readyJob.id, routeId: receipt.handoff.routeId, handoffId: receipt.handoff.handoffId,
        handoffPacketDigest: receipt.handoff.packetDigest, promotionReceiptDigest: receipt.receiptDigest,
        deliveryStartedAt: deliveryNow, deliveryDeadline: request.deliveryDeadline,
        transport: "injected_fake", repositorySimulationOnly: true,
        createsAttempt: false, createsLease: false, claimsJob: false, dispatchesOrExecutes: false,
        contactsProvider: false, messagesAgent: false, mutatesGitHub: false, grantsExternalEffect: false,
      };
      const start = { runId: request.runId, tenantId: receipt.tenantId, workspaceId: receipt.workspaceId,
        projectId: receipt.readyJob.projectId, requestDigest, materializationReceiptDigest: materialized.receiptDigest,
        promotionReceiptDigest: receipt.receiptDigest, jobId: receipt.readyJob.id, routeId: receipt.handoff.routeId,
        handoffId: receipt.handoff.handoffId, handoffPacketDigest: receipt.handoff.packetDigest,
        deliveryId, deliveryDeadline: request.deliveryDeadline, startedAt: deliveryNow };
      const began = this.store.begin(start, Date.parse(deliveryNow) >= Date.parse(request.deliveryDeadline)
        ? "expired_before_delivery" : "delivery_started");
      if (began.replayed || began.run.state !== "delivery_started") return { run: began.run,
        materializationReplayed: materialization.replayed, promotionReplayed: promotion.replayed,
        runReplayed: began.replayed };
      let acknowledgement: ReturnType<typeof validateReadyFrontierFakeDeliveryForRunV1>;
      try { acknowledgement = validateReadyFrontierFakeDeliveryForRunV1(delivery,
        await repositoryFakeDeliver.call(this.fakeDelivery, Object.freeze(delivery))); }
      catch {
        const ambiguous = this.store.complete(request.runId, requestDigest,
          { state: "terminal_ambiguous", updatedAt: this.safeNow(deliveryNow) });
        return { run: ambiguous, materializationReplayed: materialization.replayed,
          promotionReplayed: promotion.replayed, runReplayed: false };
      }
      const completed = this.store.complete(request.runId, requestDigest,
        { state: "acknowledged_repository_simulation", updatedAt: acknowledgement.acknowledgedAt,
          acknowledgementDigest: acknowledgement.acknowledgementDigest });
      return { run: completed, materializationReplayed: materialization.replayed,
        promotionReplayed: promotion.replayed, runReplayed: false };
    } finally { this.activeRuns.delete(request.runId); }
  }

  recoverUnsettled(recoveredAt: unknown) { return this.store.recoverUnsettled(recoveredAt); }
  projection(tenantId: string): ReadyFrontierNoRelayProjectionV1 {
    return projectReadyFrontierNoRelayV1({ tenantId, runs: this.store.listCurrent() }, this.runIntegrityKey);
  }
  close(): void { this.runIntegrityKey.fill(0); }
  private readDeliveryClock(): string {
    try { return parseExactReadyFrontierV1(readyFrontierTimeSchemaV1, this.deliveryClock.now()); }
    catch { fail("integrity_failed"); }
  }
  private safeNow(fallback: string): string {
    try {
      const now = parseExactReadyFrontierV1(readyFrontierTimeSchemaV1, this.deliveryClock.now());
      return Date.parse(now) < Date.parse(fallback) ? fallback : now;
    } catch { return fallback; }
  }
}
