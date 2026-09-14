import { z } from "zod";
import {
  projectCoordinatorExecutionBindingSchemaV1,
  projectCoordinatorPlanningMarkerSchemaV1,
} from "../../contracts/v1/project-coordination-boundaries";
import { sha256Digest } from "../../security";
import { failProjectCoordinationV1 } from "./errors";

export const PROJECT_COORDINATION_PROPOSAL_V1 = "control-room.project-coordination-proposal/v1" as const;
export const VERIFIED_COORDINATION_RESULT_EVIDENCE_V1 =
  "control-room.verified-coordination-result-evidence/v1" as const;
export const PROJECT_COORDINATION_OPERATION_RECEIPT_V1 =
  "control-room.project-coordination-operation-receipt/v1" as const;
export const PROJECT_COORDINATION_MAX_TASKS_V1 = 32;
export const PROJECT_COORDINATION_MAX_EDGES_V1 = 64;

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const localId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const line = z.string().min(1).max(180).refine((value) => !/[\r\n]/.test(value), "must be one line");

/**
 * The complete agent-authored proposal. It is strict: an agent cannot add an
 * authority, credential, endpoint, callback, effect, risk or cost field, and it
 * cannot name its own identity, its coordinator version, an owner, a policy or a
 * route authorization. `projectId` is present only so a result produced for a
 * different project fails a comparison instead of being silently adopted.
 */
export const projectCoordinationProposalSchemaV1 = z.object({
  schema: z.literal(PROJECT_COORDINATION_PROPOSAL_V1),
  projectId: id,
  tasks: z.array(z.object({
    localId,
    title: line,
    instructions: z.string().min(1).max(4_000),
    requiredCapability: id,
    recommendedRouteId: id.optional(),
  }).strict()).min(1).max(PROJECT_COORDINATION_MAX_TASKS_V1),
  edges: z.array(z.object({
    fromLocalId: localId,
    toLocalId: localId,
  }).strict()).max(PROJECT_COORDINATION_MAX_EDGES_V1),
}).strict().superRefine((value, context) => {
  const locals = value.tasks.map((task) => task.localId);
  if (new Set(locals).size !== locals.length) {
    context.addIssue({ code: "custom", message: "task local ids must be unique" });
  }
  const known = new Set(locals);
  const edges = new Set<string>();
  for (const edge of value.edges) {
    if (edge.fromLocalId === edge.toLocalId) context.addIssue({ code: "custom", message: "an edge cannot be a self loop" });
    if (!known.has(edge.fromLocalId) || !known.has(edge.toLocalId)) {
      context.addIssue({ code: "custom", message: "edges must reference proposed tasks" });
    }
    const key = `${edge.fromLocalId}\u0000${edge.toLocalId}`;
    if (edges.has(key)) context.addIssue({ code: "custom", message: "duplicate dependency edge" });
    edges.add(key);
  }
  // A cycle would produce canonical jobs that can never satisfy their
  // dependencies, so it is refused here rather than persisted.
  const outgoing = new Map<string, string[]>();
  for (const edge of value.edges) {
    outgoing.set(edge.fromLocalId, [...(outgoing.get(edge.fromLocalId) ?? []), edge.toLocalId]);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const cyclic = (node: string): boolean => {
    const seen = state.get(node);
    if (seen === 1) return true;
    if (seen === 2) return false;
    state.set(node, 1);
    for (const next of outgoing.get(node) ?? []) if (cyclic(next)) return true;
    state.set(node, 2);
    return false;
  };
  if (locals.some((local) => cyclic(local))) {
    context.addIssue({ code: "custom", message: "dependency edges must not form a cycle" });
  }
});
export type ProjectCoordinationProposalV1 = z.infer<typeof projectCoordinationProposalSchemaV1>;

export function projectCoordinationProposalDigestV1(value: unknown): string {
  return sha256Digest(projectCoordinationProposalSchemaV1.parse(value));
}

/**
 * The strict engine port for verified retained-result evidence.
 *
 * The lead-owned retained-result call site produces this value after it has
 * authenticated the run, the node and the immutable artifact receipt. The engine
 * accepts nothing else: there is no browser-facing entry point, no
 * caller-supplied agent identity and no path that turns raw transport input into
 * a proposal.
 */
export const verifiedCoordinationResultEvidenceSchemaV1 = z.object({
  schema: z.literal(VERIFIED_COORDINATION_RESULT_EVIDENCE_V1),
  planningMarker: projectCoordinatorPlanningMarkerSchemaV1,
  executionBinding: projectCoordinatorExecutionBindingSchemaV1,
  artifactId: id,
  artifactReceiptDigest: digest,
  contentHash: digest,
  /** Larger than the retained-result limit on purpose: the engine, not the caller,
   * decides that an over-limit result is rejected rather than silently truncated. */
  resultText: z.string().max(1_048_576),
  observedAt: instant,
}).strict();
export type VerifiedCoordinationResultEvidenceV1 = z.infer<typeof verifiedCoordinationResultEvidenceSchemaV1>;

/** Content binding used to prove the parsed text is the exact retained artifact. */
export function coordinationResultContentDigestV1(text: string): string {
  return sha256Digest({ schema: VERIFIED_COORDINATION_RESULT_EVIDENCE_V1, text });
}

export const coordinationRouteKinds = ["manual", "scheduled", "news_collection"] as const;
export type CoordinationRouteKindV1 = (typeof coordinationRouteKinds)[number];

/** Trusted current cost evidence. Absence is `unknown`, never zero. */
export type CoordinationCostEvidenceV1 =
  | { kind: "known"; admittedCostMicroUsd: number; evidenceDigest: string }
  | { kind: "unknown" };

export interface CoordinationCostEvidencePortV1 {
  currentCost(request: {
    tenantId: string; projectId: string; routeId: string; requiredCapability: string;
  }): Promise<CoordinationCostEvidenceV1> | CoordinationCostEvidenceV1;
}

/** Server-side route resolution. Agent content never selects an executor. */
export interface CoordinationRouteResolverPortV1 {
  resolveRoute(request: {
    tenantId: string; projectId: string; requiredCapability: string; recommendedRouteId?: string;
  }): Promise<string | undefined> | string | undefined;
}

export const coordinatorAppointmentSchemaV1 = z.object({
  tenantId: id,
  projectId: id,
  ownerIdentityId: id,
  coordinatorIdentityId: id,
  coordinatorActorType: z.enum(["human", "agent"]),
  executorId: id.optional(),
  adapterId: id.optional(),
  connectorProfileDigest: digest.optional(),
  occurredAt: instant,
}).strict().superRefine((value, context) => {
  const agent = value.coordinatorActorType === "agent";
  const hasExecution = value.executorId !== undefined && value.adapterId !== undefined
    && value.connectorProfileDigest !== undefined;
  if (agent !== hasExecution) {
    context.addIssue({ code: "custom", message: "agent coordinators require exactly one execution binding" });
  }
});
export type CoordinatorAppointmentV1 = z.infer<typeof coordinatorAppointmentSchemaV1>;

export function coordinatorLifecycleRequestDigestV1(input: {
  operation: "appoint" | "replace" | "revoke";
  appointment: CoordinatorAppointmentV1;
  expectedVersion: number;
  executionBindingDigest?: string;
}): string {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    failProjectCoordinationV1("invalid_input");
  }
  const appointment = coordinatorAppointmentSchemaV1.parse(input.appointment);
  const identity = JSON.parse(JSON.stringify({
    schema: "control-room.project-coordinator-lifecycle-request/v1",
    operation: input.operation,
    expectedVersion: input.expectedVersion,
    appointment,
    ...(input.operation !== "revoke" && input.executionBindingDigest
      ? { executionBindingDigest: input.executionBindingDigest } : {}),
  })) as Record<string, unknown>;
  return sha256Digest(identity);
}

export const coordinatorLifecycleReceiptSchemaV1 = z.object({
  schema: z.literal("control-room.project-coordinator-lifecycle-receipt/v1"),
  operation: z.enum(["appoint", "replace", "revoke"]),
  tenantId: id,
  projectId: id,
  idempotencyKey: z.string().min(12).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  requestDigest: digest,
  expectedVersion: z.number().int().min(0),
  version: z.number().int().min(1),
  state: z.enum(["active", "revoked"]),
  executionBindingDigest: digest.optional(),
  receiptDigest: digest,
}).strict();
export type CoordinatorLifecycleReceiptV1 = z.infer<typeof coordinatorLifecycleReceiptSchemaV1>;

export const coordinationOperationRequestSchemaV1 = z.object({
  tenantId: id,
  projectId: id,
  proposalId: id,
  idempotencyKey: z.string().min(12).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  operationId: id,
  requestId: id,
  workflowId: id,
  /** Owner-selected subset of the proposal; an empty selection is not an adoption. */
  selectedLocalIds: z.array(localId).min(1).max(PROJECT_COORDINATION_MAX_TASKS_V1),
  /** Server-resolved routes the initiating authority may use. Never agent content. */
  approvedRouteIds: z.array(id).max(64),
  authorization: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("owner"), ownerIdentityId: id }).strict(),
    z.object({ kind: z.literal("policy"), policyId: id, ownerIdentityId: id }).strict(),
  ]),
  routeKind: z.enum(coordinationRouteKinds),
  occurredAt: instant,
  authorityExpiresAt: instant,
}).strict().superRefine((value, context) => {
  if (new Set(value.selectedLocalIds).size !== value.selectedLocalIds.length) {
    context.addIssue({ code: "custom", message: "selected local ids must be unique" });
  }
  if (Date.parse(value.authorityExpiresAt) <= Date.parse(value.occurredAt)) {
    context.addIssue({ code: "custom", message: "authority must expire after the operation" });
  }
});
export type CoordinationOperationRequestV1 = z.infer<typeof coordinationOperationRequestSchemaV1>;

export const PROJECT_COORDINATION_OPERATION_REQUEST_IDENTITY_V1 =
  "control-room.project-coordination-operation-request-identity/v1" as const;

/**
 * The immutable identity of one adoption request: exactly what the caller asked
 * for, and nothing the server later derived for it.
 *
 * Routes and prices are resolved from mutable ports at adoption time and are
 * deliberately absent here. They are recorded in the receipt and bound into the
 * separate request digest, but they are not part of *which request this is*: the
 * same committed operation must still be recognisable as itself after a route
 * has been retired or trusted cost evidence has moved. Everything the caller
 * controls - proposal, selection, approved routes, authorization, operation and
 * idempotency keys, timing - is included, so changed content under one key is a
 * different identity and conflicts.
 */
export function coordinationOperationRequestIdentityDigestV1(value: unknown): string {
  return sha256Digest({ schema: PROJECT_COORDINATION_OPERATION_REQUEST_IDENTITY_V1,
    request: coordinationOperationRequestSchemaV1.parse(value) });
}
