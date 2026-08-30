import { sha256Digest } from "../../security";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import { parseReadyFrontierPolicyV1 } from "./controller";
import { ReadyFrontierSimulationStoreV1 } from "./durable-store";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { composeReadyFrontierCanonicalSourceV1 } from "./canonical-source";
import { readyFrontierManualCycleRequestSchemaV1, readyFrontierManualCycleResultSchemaV1 } from "./integration-schemas";
import {
  READY_FRONTIER_MANUAL_CYCLE_RESULT_V1,
  type ReadyFrontierCanonicalReadPortsV1,
  type ReadyFrontierCycleProjectionV1,
  type ReadyFrontierManualCycleRequestV1,
  type ReadyFrontierManualCycleResultV1,
  type ReadyFrontierReadRequestV1,
} from "./integration-types";
import type { ReadyFrontierPolicyV1 } from "./types";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }
function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sortedUnique(values: readonly string[]): string[] {
  const result = [...values].sort();
  if (new Set(result).size !== result.length) fail("invalid_input");
  return result;
}
function makeReadRequest(request: ReadyFrontierManualCycleRequestV1): ReadyFrontierReadRequestV1 {
  const projectIds = Object.freeze([...request.projectIds]) as unknown as string[];
  return Object.freeze({ readGroupId: request.readGroupId, tenantId: request.tenantId, revision: request.sourceRevision,
    observedAt: request.sourceObservedAt, projectIds, readOnly: true, permitsMutation: false,
    permitsNetworkDiscovery: false });
}

export class ReadyFrontierManualCycleServiceV1 {
  private readonly sourceIntegrityKey: Uint8Array;
  private readonly policy: ReadyFrontierPolicyV1;
  private closed = false;

  constructor(private readonly ports: ReadyFrontierCanonicalReadPortsV1,
    private readonly store: ReadyFrontierSimulationStoreV1, policyValue: unknown, sourceIntegrityKeyValue: unknown) {
    if (!ports || typeof ports !== "object" || [ports.readProjects, ports.readWork, ports.readAttention, ports.readCapacity]
      .some((method) => typeof method !== "function")) fail("invalid_input");
    const key = exactHostUint8ArrayV1(sourceIntegrityKeyValue, 128);
    if (!key || key.byteLength < 32) fail("integrity_failed");
    this.sourceIntegrityKey = key.copy();
    try { this.policy = parseReadyFrontierPolicyV1(policyValue); }
    catch (error) { this.sourceIntegrityKey.fill(0); throw error; }
  }

  async runManualCycle(requestValue: unknown): Promise<ReadyFrontierManualCycleResultV1> {
    if (this.closed) fail("integrity_failed");
    const request = parseExactReadyFrontierV1(readyFrontierManualCycleRequestSchemaV1, requestValue) as ReadyFrontierManualCycleRequestV1;
    const requestedProjects = sortedUnique(request.projectIds), policyProjects = this.policy.projectPolicies.map((item) => item.projectId);
    if (!equalStrings(requestedProjects, request.projectIds) || !equalStrings(requestedProjects, policyProjects)
      || request.tenantId !== this.policy.tenantId) fail("scope_mismatch");
    const readRequest = makeReadRequest(request);
    let reads: unknown[];
    try {
      reads = await Promise.all([
        this.ports.readProjects(readRequest),
        this.ports.readWork(readRequest),
        this.ports.readAttention(readRequest),
        this.ports.readCapacity(readRequest),
      ]);
    } catch { fail("integrity_failed"); }
    const source = composeReadyFrontierCanonicalSourceV1(request, reads, this.sourceIntegrityKey);
    const recorded = this.store.runCycle({ cycleId: request.cycleId, evaluatedAt: request.evaluatedAt,
      source, policy: this.policy });
    const projection = this.store.cycleProjection(request.cycleId);
    if (!projection || projection.cycleId !== recorded.evaluation.cycleId) fail("integrity_failed");
    const material: Omit<ReadyFrontierManualCycleResultV1, "resultDigest"> = {
      schema: READY_FRONTIER_MANUAL_CYCLE_RESULT_V1,
      requestId: request.requestId,
      cycleId: recorded.evaluation.cycleId,
      tenantId: recorded.evaluation.tenantId,
      sourceDigest: recorded.evaluation.sourceDigest,
      evaluationDigest: recorded.evaluation.evaluationDigest,
      projectionDigest: projection.projectionDigest,
      replayed: recorded.replayed,
      proposalCount: recorded.evaluation.proposalCount,
      evaluatedAt: recorded.evaluation.evaluatedAt,
      manualTrigger: true,
      scheduled: false,
      createdCanonicalWork: false,
      grantedApproval: false,
      grantedReadyTransition: false,
      createdClaimOrLease: false,
      dispatchedOrExecuted: false,
      contactedProvider: false,
      performedExternalEffect: false,
    };
    return parseExactReadyFrontierV1(readyFrontierManualCycleResultSchemaV1, {
      ...material, resultDigest: sha256Digest(material),
    }) as ReadyFrontierManualCycleResultV1;
  }

  latestProjection(): ReadyFrontierCycleProjectionV1 | undefined {
    if (this.closed) fail("integrity_failed");
    return this.store.latestCycleProjection();
  }

  projectionHistory(limit = 20): ReadyFrontierCycleProjectionV1[] {
    if (this.closed) fail("integrity_failed");
    return this.store.cycleProjectionHistory(limit);
  }

  close(): void {
    if (!this.closed) { this.sourceIntegrityKey.fill(0); this.closed = true; }
  }
}
