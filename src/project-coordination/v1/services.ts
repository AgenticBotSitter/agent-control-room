import { projectCoordinatorExecutionBindingDigestV1 } from "../../contracts/v1/project-coordination-boundaries";
import { sha256Digest } from "../../security";
import { failProjectCoordinationV1 } from "./errors";
import {
  coordinatorAppointmentSchemaV1,
  coordinatorLifecycleRequestDigestV1,
  coordinatorLifecycleReceiptSchemaV1,
  coordinationOperationRequestSchemaV1,
  delegationPolicyLifecycleRequestDigestV1,
  delegationPolicyLifecycleReceiptSchemaV1,
  projectCoordinationProposalDigestV1,
  type CoordinationCostEvidencePortV1,
  type CoordinationCostEvidenceV1,
  type CoordinationOperationRequestV1,
  type CoordinationRouteResolverPortV1,
  type CoordinatorAppointmentV1,
  type CoordinatorLifecycleReceiptV1,
  type DelegationPolicyLifecycleReceiptV1,
  type ProjectCoordinationProposalV1,
} from "./schemas";
import {
  validateCoordinationProposalV1,
  type CoordinationProposalValidationV1,
} from "./proposal-ingestion";
import { projectWorkAdmissionRequestSchemaV1, type ProjectWorkAdmissionResultV1 } from "./admission";
import {
  authorizeProcessRetirementV1,
  type ProcessRetirementVerifierPortV1,
} from "./retirement";
import {
  authorizeParallelNarrowWriteV1,
  type EnforcedWorkspacePortV1,
} from "./parallel-write";

/**
 * The persistence operations this engine uses. It is a structural port so the
 * engine never imports the canonical store module directly; the existing
 * `CanonicalStore` satisfies it exactly, and no second store is introduced.
 */
export interface ProjectCoordinationCanonicalPortV1 {
  assignProjectCoordinatorV1(input: {
    operation: "appoint" | "replace" | "revoke";
    appointment: CoordinatorAppointmentV1;
    idempotencyKey: string;
    requestDigest: string;
    expectedVersion: number;
    executionBindingDigest?: string;
  }): Promise<CoordinatorLifecycleReceiptV1 & { replayed: boolean }>;
  setProjectDelegationPolicyStateDurableV1(input: {
    action: "pause" | "resume" | "revoke";
    tenantId: string; projectId: string; policyId: string; ownerIdentityId: string;
    idempotencyKey: string; requestDigest: string; expectedVersion: number;
    expectedCoordinatorVersion: number; expectedConflictsVersion: number; expectedAttentionVersion: number;
    occurredAt: string;
  }): Promise<DelegationPolicyLifecycleReceiptV1 & { replayed: boolean }>;
  findDelegationPolicyLifecycleReceiptV1(input: {
    tenantId: string; idempotencyKey: string; requestDigest: string;
  }): Promise<(DelegationPolicyLifecycleReceiptV1 & { replayed: true }) | undefined>;
  recordProjectCoordinationProposalV1(input: {
    proposalId: string; validation: CoordinationProposalValidationV1; ingestedAt: string;
  }): Promise<{ proposalId: string; validationState: "accepted" | "rejected"; safeReasonCode?: string;
    proposalDigest?: string; replayed: boolean }>;
  /**
   * Reads the exact accepted proposal row and re-derives its digest. Adoption
   * routes and prices this value; a caller-supplied copy is never the pricing
   * input.
   */
  loadAcceptedProjectCoordinationProposalV1(input: {
    tenantId: string; projectId: string; proposalId: string;
  }): Promise<{ proposalId: string; proposalDigest: string; proposal: ProjectCoordinationProposalV1 }>;
  /**
   * Looks up an already-committed adoption by its request identity alone and
   * returns the original verified receipt, or nothing when this request has
   * never committed. It consults no route and no price, so an exact retry can be
   * answered before any mutable port is touched.
   */
  findCommittedProjectCoordinationAdoptionV1(input: { request: CoordinationOperationRequestV1 }):
  Promise<{ receiptId: string; receiptDigest: string; jobIds: string[]; taskUnits: number;
    concurrencyUnits: number; proposalDigest: string; replayed: true } | undefined>;
  adoptProjectCoordinationProposalV1(input: {
    request: CoordinationOperationRequestV1; requestDigest: string; proposalDigest: string;
    routes: Record<string, string>; cost: CoordinationCostEvidenceV1;
  }): Promise<{ receiptId: string; receiptDigest: string; jobIds: string[]; taskUnits: number;
    concurrencyUnits: number; replayed: boolean }>;
  admitProjectWorkResourcesV1(value: unknown, parallelWriteAuthorization?: unknown):
  Promise<ProjectWorkAdmissionResultV1>;
  recheckProjectWorkResourceAdmissionV1(value: unknown): Promise<{
    admissionId: string; admissionDigest: string; declarationDigest: string; version: number; state: "held" }>;
  retireProjectWorkResourceAdmissionV1(operationAuthorization: unknown): Promise<{
    admissionId: string; version: number; replayed: boolean }>;
}

/**
 * Owner-driven coordinator lifecycle. Nothing here mints a session, a role grant
 * or an execution authorization; a coordinator proposes and plans, and human web
 * authentication remains human-only.
 */
export class ProjectCoordinatorServiceV1 {
  constructor(private readonly canonical: ProjectCoordinationCanonicalPortV1) {}

  #withBinding(appointment: CoordinatorAppointmentV1) {
    const parsed = coordinatorAppointmentSchemaV1.parse(appointment);
    if (parsed.coordinatorActorType === "human") return { appointment: parsed, executionBindingDigest: undefined };
    if (parsed.coordinatorIdentityId === parsed.executorId) failProjectCoordinationV1("invalid_input");
    const executionBindingDigest = projectCoordinatorExecutionBindingDigestV1({
      schema: "control-room.project-coordinator-execution-binding/v1",
      tenantId: parsed.tenantId, projectId: parsed.projectId,
      coordinatorIdentityId: parsed.coordinatorIdentityId, executorId: parsed.executorId!,
      adapterId: parsed.adapterId!, connectorProfileDigest: parsed.connectorProfileDigest!,
    });
    return { appointment: parsed, executionBindingDigest };
  }

  /** First appointment for a project. */
  #request(operation: "appoint" | "replace" | "revoke", appointment: CoordinatorAppointmentV1, idempotencyKey: string,
    expectedVersion: number) {
    const { appointment: parsed, executionBindingDigest } = this.#withBinding(appointment);
    const requestDigest = coordinatorLifecycleRequestDigestV1({ operation, appointment: parsed, expectedVersion,
      ...(operation !== "revoke" && executionBindingDigest ? { executionBindingDigest } : {}) });
    return { parsed, executionBindingDigest, idempotencyKey, requestDigest, expectedVersion };
  }

  async appoint(appointment: CoordinatorAppointmentV1, idempotencyKey: string, expectedVersion: number) {
    const request = this.#request("appoint", appointment, idempotencyKey, expectedVersion);
    const receipt = await this.canonical.assignProjectCoordinatorV1({ operation: "appoint",
      appointment: request.parsed, idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest,
      expectedVersion: request.expectedVersion,
      ...(request.executionBindingDigest ? { executionBindingDigest: request.executionBindingDigest } : {}) });
    const { replayed, ...durable } = receipt;
    return { ...coordinatorLifecycleReceiptSchemaV1.parse(durable), replayed };
  }

  /** Replaces the current coordinator; the same head version line continues. */
  async replace(appointment: CoordinatorAppointmentV1, idempotencyKey: string, expectedVersion: number) {
    const request = this.#request("replace", appointment, idempotencyKey, expectedVersion);
    const receipt = await this.canonical.assignProjectCoordinatorV1({ operation: "replace",
      appointment: request.parsed, idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest,
      expectedVersion: request.expectedVersion,
      ...(request.executionBindingDigest ? { executionBindingDigest: request.executionBindingDigest } : {}) });
    const { replayed, ...durable } = receipt;
    return { ...coordinatorLifecycleReceiptSchemaV1.parse(durable), replayed };
  }

  /**
   * Pauses delegated autonomy. The coordinator head reserves only `active` and
   * `revoked`, and pause/revoke are the only in-place policy changes, so a pause
   * is expressed by pausing the bounded policy: automatic adoption stops at once
   * while owner-reviewed adoption stays available. The exact Idempotency-Key
   * flows into the durable canonical operation; a retry collects the saved
   * receipt instead of repeating the mutation.
   */
  async pauseDelegation(input: { tenantId: string; projectId: string; policyId: string;
    ownerIdentityId: string; idempotencyKey: string; expectedVersion: number; occurredAt: string;
    expectedCoordinatorVersion?: number; expectedConflictsVersion?: number; expectedAttentionVersion?: number }) {
    return this.#policyLifecycle("pause", input);
  }

  async resumeDelegation(input: { tenantId: string; projectId: string; policyId: string;
    ownerIdentityId: string; idempotencyKey: string; expectedVersion: number; occurredAt: string;
    expectedCoordinatorVersion?: number; expectedConflictsVersion?: number; expectedAttentionVersion?: number }) {
    return this.#policyLifecycle("resume", input);
  }

  async revokeDelegation(input: { tenantId: string; projectId: string; policyId: string;
    ownerIdentityId: string; idempotencyKey: string; expectedVersion: number; occurredAt: string;
    expectedCoordinatorVersion?: number; expectedConflictsVersion?: number; expectedAttentionVersion?: number }) {
    return this.#policyLifecycle("revoke", input);
  }

  async findDelegationPolicyReceipt(input: { action: "pause" | "resume" | "revoke"; tenantId: string;
    projectId: string; policyId: string; ownerIdentityId: string; idempotencyKey: string; expectedVersion: number;
    expectedCoordinatorVersion: number; expectedConflictsVersion: number; expectedAttentionVersion: number }) {
    const requestDigest = delegationPolicyLifecycleRequestDigestV1(input);
    return this.canonical.findDelegationPolicyLifecycleReceiptV1({ tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey, requestDigest });
  }

  #policyLifecycle(action: "pause" | "resume" | "revoke", input: { tenantId: string;
    projectId: string; policyId: string; ownerIdentityId: string; idempotencyKey: string;
    expectedVersion: number; occurredAt: string; expectedCoordinatorVersion?: number;
    expectedConflictsVersion?: number; expectedAttentionVersion?: number }) {
    const requestDigest = delegationPolicyLifecycleRequestDigestV1({ action,
      tenantId: input.tenantId, projectId: input.projectId, policyId: input.policyId,
      ownerIdentityId: input.ownerIdentityId, expectedVersion: input.expectedVersion,
      expectedCoordinatorVersion: input.expectedCoordinatorVersion,
      expectedConflictsVersion: input.expectedConflictsVersion,
      expectedAttentionVersion: input.expectedAttentionVersion });
    return this.canonical.setProjectDelegationPolicyStateDurableV1({ action,
      tenantId: input.tenantId, projectId: input.projectId, policyId: input.policyId,
      ownerIdentityId: input.ownerIdentityId, idempotencyKey: input.idempotencyKey,
      requestDigest, expectedVersion: input.expectedVersion,
      expectedCoordinatorVersion: input.expectedCoordinatorVersion ?? 0,
      expectedConflictsVersion: input.expectedConflictsVersion ?? 0,
      expectedAttentionVersion: input.expectedAttentionVersion ?? 0, occurredAt: input.occurredAt })
      .then((receipt) => {
        const { replayed, ...durable } = receipt;
        return { ...delegationPolicyLifecycleReceiptSchemaV1.parse(durable), replayed };
      });
  }

  async revoke(appointment: CoordinatorAppointmentV1, idempotencyKey: string, expectedVersion: number) {
    const request = this.#request("revoke", appointment, idempotencyKey, expectedVersion);
    const receipt = await this.canonical.assignProjectCoordinatorV1({ operation: "revoke",
      appointment: request.parsed, idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest,
      expectedVersion: request.expectedVersion });
    const { replayed, ...durable } = receipt;
    return { ...coordinatorLifecycleReceiptSchemaV1.parse(durable), replayed };
  }
}

/**
 * Ingests exact retained results through the trusted engine port and records each
 * one as an accepted or safely rejected proposal.
 */
export class ProjectCoordinationProposalServiceV1 {
  constructor(private readonly canonical: ProjectCoordinationCanonicalPortV1) {}

  async ingestVerifiedResult(input: { proposalId: string; evidence: unknown; ingestedAt: string }) {
    const validation = validateCoordinationProposalV1(input.evidence);
    return this.canonical.recordProjectCoordinationProposalV1({
      proposalId: input.proposalId, validation, ingestedAt: input.ingestedAt });
  }
}

/**
 * Trusted cost evidence must be an exact non-negative micro-USD integer with a
 * well-formed evidence digest. Anything else - a fraction, a negative, `NaN`,
 * `Infinity`, a string, a missing field - is not evidence and is treated as
 * `unknown`, which no policy ceiling can admit.
 */
function isAdmissibleCostEvidence(
  value: CoordinationCostEvidenceV1 | undefined | null,
): value is Extract<CoordinationCostEvidenceV1, { kind: "known" }> {
  return !!value && value.kind === "known"
    && typeof value.admittedCostMicroUsd === "number"
    && Number.isSafeInteger(value.admittedCostMicroUsd) && value.admittedCostMicroUsd >= 0
    && typeof value.evidenceDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.evidenceDigest);
}

/**
 * Owner-reviewed and bounded-policy adoption. Both paths build the identical
 * request and call one canonical operation, so neither can create work the other
 * could not, and neither can grant execution authority.
 */
export class ProjectCoordinationAdoptionServiceV1 {
  constructor(
    private readonly canonical: ProjectCoordinationCanonicalPortV1,
    private readonly routes: CoordinationRouteResolverPortV1,
    private readonly costs: CoordinationCostEvidencePortV1,
  ) {}

  /**
   * `proposal` is optional and is never the source of a route or a price. The
   * canonical accepted row is loaded first and everything - selection, required
   * capability, route resolution and cost - is resolved from it. A supplied copy
   * is accepted only as a cross-check: it must hash to the exact stored proposal
   * digest, so a caller cannot present a cheaper or differently-capable object
   * than the one persistence will later adopt.
   *
   * An exact retry of an already-committed request is answered from the canonical
   * record before any mutable port is consulted. Route resolution and cost
   * evidence are current-state services: a route can be retired and trusted cost
   * can move, and neither event may retroactively break the receipt for work that
   * legitimately committed under the old answer. So the committed operation is
   * found and verified first, and the resolver and the pricing port are called
   * only for a request that has genuinely never committed.
   */
  async adopt(input: { request: CoordinationOperationRequestV1; proposal?: ProjectCoordinationProposalV1 }) {
    const request = coordinationOperationRequestSchemaV1.parse(input.request);
    const committed = await this.canonical.findCommittedProjectCoordinationAdoptionV1({ request });
    if (committed) {
      // The cross-check still applies on a retry: a caller copy is compared
      // against the proposal digest the original operation actually committed.
      if (input.proposal !== undefined
        && projectCoordinationProposalDigestV1(input.proposal) !== committed.proposalDigest) {
        failProjectCoordinationV1("proposal_evidence_mismatch");
      }
      const { proposalDigest: _committedProposalDigest, ...receipt } = committed;
      return receipt;
    }
    const canonicalProposal = await this.canonical.loadAcceptedProjectCoordinationProposalV1({
      tenantId: request.tenantId, projectId: request.projectId, proposalId: request.proposalId });
    if (input.proposal !== undefined
      && projectCoordinationProposalDigestV1(input.proposal) !== canonicalProposal.proposalDigest) {
      failProjectCoordinationV1("proposal_evidence_mismatch");
    }
    const proposal = canonicalProposal.proposal;
    const selected = proposal.tasks.filter((task) => request.selectedLocalIds.includes(task.localId));
    if (selected.length !== request.selectedLocalIds.length) failProjectCoordinationV1("invalid_input");

    const routes: Record<string, string> = {};
    for (const task of selected) {
      const route = await this.routes.resolveRoute({ tenantId: request.tenantId, projectId: request.projectId,
        requiredCapability: task.requiredCapability,
        ...(task.recommendedRouteId ? { recommendedRouteId: task.recommendedRouteId } : {}) });
      if (!route) failProjectCoordinationV1("policy_route_mismatch");
      routes[task.localId] = route!;
    }

    // Cost evidence is trusted server evidence, never an agent estimate. A port
    // that is absent, throws, or returns nothing is `unknown`, which no ceiling
    // can admit.
    let cost: CoordinationCostEvidenceV1 = { kind: "unknown" };
    const observed: CoordinationCostEvidenceV1[] = [];
    for (const task of selected) {
      let current: CoordinationCostEvidenceV1;
      try {
        current = await this.costs.currentCost({ tenantId: request.tenantId, projectId: request.projectId,
          routeId: routes[task.localId]!, requiredCapability: task.requiredCapability });
      } catch {
        current = { kind: "unknown" };
      }
      // Each entry is checked on its own before it can contribute. A fractional,
      // negative, non-finite or non-numeric micro-USD value is not cost evidence:
      // summing it first would let two halves round into an admissible integer and
      // silently satisfy a ceiling that exact accounting would have refused.
      observed.push(isAdmissibleCostEvidence(current) ? current : { kind: "unknown" });
    }
    if (observed.length > 0 && observed.every((entry) => entry.kind === "known")) {
      const known = observed as Array<Extract<CoordinationCostEvidenceV1, { kind: "known" }>>;
      // Micro-USD totals accumulate as BigInt so the sum handed to the ceiling is
      // exact. A total past the safe-integer range stays `unknown` rather than
      // being admitted at a rounded value.
      const total = known.reduce((sum, entry) => sum + BigInt(entry.admittedCostMicroUsd), BigInt(0));
      if (total <= BigInt(Number.MAX_SAFE_INTEGER)) {
        cost = { kind: "known", admittedCostMicroUsd: Number(total),
          evidenceDigest: sha256Digest(known.map((entry) => entry.evidenceDigest)) };
      }
    }

    // The digest of the exact proposal that was routed and priced is part of the
    // request identity, so persistence can refuse to adopt any other content and
    // a replay under the same key cannot silently change proposals.
    const requestDigest = sha256Digest({ request, routes,
      proposalDigest: canonicalProposal.proposalDigest,
      cost: cost.kind === "known" ? { admittedCostMicroUsd: cost.admittedCostMicroUsd,
        evidenceDigest: cost.evidenceDigest } : { kind: "unknown" } });
    return this.canonical.adoptProjectCoordinationProposalV1({ request, requestDigest, routes, cost,
      proposalDigest: canonicalProposal.proposalDigest });
  }
}

/**
 * The one shared-work admission service. Manual, scheduled and news-collection
 * callers all reach the same canonical conflict operation through it.
 */
export class ProjectWorkAdmissionServiceV1 {
  constructor(
    private readonly canonical: ProjectCoordinationCanonicalPortV1,
    private readonly retirementVerifier?: ProcessRetirementVerifierPortV1,
    private readonly enforcedWorkspaces?: EnforcedWorkspacePortV1,
  ) {}

  /**
   * A request that asks for parallel narrow repository writing gets no say in
   * whether it is allowed. The enforced workspace is resolved here through the
   * captured trusted boundary, and the named owner policy is verified against
   * the stored row inside the canonical transaction. An admission service
   * composed without that boundary can never admit a narrow writer.
   */
  async admit(request: unknown): Promise<ProjectWorkAdmissionResultV1> {
    const parsed = projectWorkAdmissionRequestSchemaV1.safeParse(request);
    if (!parsed.success || !parsed.data.disjointWriters.requested) {
      return this.canonical.admitProjectWorkResourcesV1(request);
    }
    const { tenantId, projectId, jobId, attemptId, leaseId, nodeId, admissionId } = parsed.data;
    const authorization = await authorizeParallelNarrowWriteV1(this.enforcedWorkspaces, {
      lineage: { tenantId, projectId, jobId, attemptId, leaseId, nodeId, admissionId },
      policyId: parsed.data.disjointWriters.policyId });
    return this.canonical.admitProjectWorkResourcesV1(request, authorization);
  }

  async recheck(request: unknown) {
    return this.canonical.recheckProjectWorkResourceAdmissionV1(request);
  }

  /**
   * Retires a holder from exact authenticated process-retirement evidence. Every
   * other signal - lease expiry, disconnect, browser closure, result text, a bare
   * transport receipt - has no path to this method.
   */
  async retire(proof: unknown): Promise<{ admissionId: string; version: number; replayed: boolean }> {
    if (!this.retirementVerifier) return failProjectCoordinationV1("retirement_evidence_unauthorized");
    const authorization = await authorizeProcessRetirementV1(this.retirementVerifier, proof);
    return this.canonical.retireProjectWorkResourceAdmissionV1(authorization);
  }
}
