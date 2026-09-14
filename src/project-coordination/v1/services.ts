import { projectCoordinatorExecutionBindingDigestV1 } from "../../contracts/v1/project-coordination-boundaries";
import { sha256Digest } from "../../security";
import { failProjectCoordinationV1 } from "./errors";
import {
  coordinatorAppointmentSchemaV1,
  coordinationOperationRequestSchemaV1,
  type CoordinationCostEvidencePortV1,
  type CoordinationCostEvidenceV1,
  type CoordinationOperationRequestV1,
  type CoordinationRouteResolverPortV1,
  type CoordinatorAppointmentV1,
  type ProjectCoordinationProposalV1,
} from "./schemas";
import {
  validateCoordinationProposalV1,
  type CoordinationProposalValidationV1,
} from "./proposal-ingestion";
import type { ProjectWorkAdmissionResultV1 } from "./admission";
import {
  authorizeProcessRetirementV1,
  type ProcessRetirementVerifierPortV1,
} from "./retirement";

/**
 * The persistence operations this engine uses. It is a structural port so the
 * engine never imports the canonical store module directly; the existing
 * `CanonicalStore` satisfies it exactly, and no second store is introduced.
 */
export interface ProjectCoordinationCanonicalPortV1 {
  assignProjectCoordinatorV1(input: {
    operation: "assign" | "revoke";
    appointment: CoordinatorAppointmentV1;
    executionBindingDigest?: string;
  }): Promise<{ version: number; state: "active" | "revoked"; executionBindingDigest?: string }>;
  setProjectDelegationPolicyStateV1(input: {
    tenantId: string; projectId: string; policyId: string; ownerIdentityId: string;
    toState: "paused" | "active" | "revoked"; occurredAt: string;
  }): Promise<{ version: number; state: string }>;
  recordProjectCoordinationProposalV1(input: {
    proposalId: string; validation: CoordinationProposalValidationV1; ingestedAt: string;
  }): Promise<{ proposalId: string; validationState: "accepted" | "rejected"; safeReasonCode?: string;
    proposalDigest?: string; replayed: boolean }>;
  adoptProjectCoordinationProposalV1(input: {
    request: CoordinationOperationRequestV1; requestDigest: string;
    routes: Record<string, string>; cost: CoordinationCostEvidenceV1;
  }): Promise<{ receiptId: string; receiptDigest: string; jobIds: string[]; taskUnits: number;
    concurrencyUnits: number; replayed: boolean }>;
  admitProjectWorkResourcesV1(value: unknown): Promise<ProjectWorkAdmissionResultV1>;
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
  async appoint(appointment: CoordinatorAppointmentV1) {
    const { appointment: parsed, executionBindingDigest } = this.#withBinding(appointment);
    return this.canonical.assignProjectCoordinatorV1({ operation: "assign", appointment: parsed,
      ...(executionBindingDigest ? { executionBindingDigest } : {}) });
  }

  /** Replaces the current coordinator; the same head version line continues. */
  async replace(appointment: CoordinatorAppointmentV1) {
    return this.appoint(appointment);
  }

  /**
   * Pauses delegated autonomy. The coordinator head reserves only `active` and
   * `revoked`, and pause/revoke are the only in-place policy changes, so a pause
   * is expressed by pausing the bounded policy: automatic adoption stops at once
   * while owner-reviewed adoption stays available.
   */
  async pauseDelegation(input: { tenantId: string; projectId: string; policyId: string;
    ownerIdentityId: string; occurredAt: string }) {
    return this.canonical.setProjectDelegationPolicyStateV1({ ...input, toState: "paused" });
  }

  async resumeDelegation(input: { tenantId: string; projectId: string; policyId: string;
    ownerIdentityId: string; occurredAt: string }) {
    return this.canonical.setProjectDelegationPolicyStateV1({ ...input, toState: "active" });
  }

  async revokeDelegation(input: { tenantId: string; projectId: string; policyId: string;
    ownerIdentityId: string; occurredAt: string }) {
    return this.canonical.setProjectDelegationPolicyStateV1({ ...input, toState: "revoked" });
  }

  async revoke(appointment: CoordinatorAppointmentV1) {
    const { appointment: parsed } = this.#withBinding(appointment);
    return this.canonical.assignProjectCoordinatorV1({ operation: "revoke", appointment: parsed });
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

  async adopt(input: { request: CoordinationOperationRequestV1; proposal: ProjectCoordinationProposalV1 }) {
    const request = coordinationOperationRequestSchemaV1.parse(input.request);
    const selected = input.proposal.tasks.filter((task) => request.selectedLocalIds.includes(task.localId));
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
      observed.push(current && current.kind === "known" ? current : { kind: "unknown" });
    }
    if (observed.length > 0 && observed.every((entry) => entry.kind === "known")) {
      const known = observed as Array<Extract<CoordinationCostEvidenceV1, { kind: "known" }>>;
      cost = { kind: "known",
        admittedCostMicroUsd: known.reduce((total, entry) => total + entry.admittedCostMicroUsd, 0),
        evidenceDigest: sha256Digest(known.map((entry) => entry.evidenceDigest)) };
    }

    const requestDigest = sha256Digest({ request, routes,
      cost: cost.kind === "known" ? { admittedCostMicroUsd: cost.admittedCostMicroUsd,
        evidenceDigest: cost.evidenceDigest } : { kind: "unknown" } });
    return this.canonical.adoptProjectCoordinationProposalV1({ request, requestDigest, routes, cost });
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
  ) {}

  async admit(request: unknown): Promise<ProjectWorkAdmissionResultV1> {
    return this.canonical.admitProjectWorkResourcesV1(request);
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
