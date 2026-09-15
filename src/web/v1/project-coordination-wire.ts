// Wire contracts for the project-coordination browser client.
//
// Every page the project-coordination UI renders is described here as a strict
// zod schema so the browser parses the response with the same checks the
// canonical store applied on the server. None of these types are inputs to the
// coordination engine itself: they are presentation projections of the head
// rows, conflict ledger, and pending adoption/admission receipts the service
// exposes through the protected HTTP routes. The page never carries authority.

import { z } from "zod";
import {
  catalogProjectIdSchema,
  webProjectSchema,
} from "./project-wire";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const revision = z.string().min(1).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/);
const relativePath = z
  .string()
  .max(512)
  .refine(
    (value) =>
      value === "" ||
      /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,127})*$/.test(
        value,
      ),
    "invalid repository-relative path",
  );

// Head state the page renders as "who is the coordinator now".
//
// Two-shape discriminated union: a populated head carries version >= 1 plus the
// identity and binding fields; an empty head carries version 0 with the identity
// and binding fields all nullable. The browser's switch narrows on `state`
// so the active-page and empty-page views both stay type-safe.
const coordinatorHeadPopulatedSchema = z
  .object({
    tenantId: id,
    projectId: catalogProjectIdSchema,
    version: z.number().int().min(1),
    state: z.enum(["active", "revoked"]),
    coordinatorActorType: z.enum(["human", "agent"]),
    coordinatorIdentityId: id,
    executorId: id.nullable(),
    adapterId: id.nullable(),
    connectorProfileDigest: digest.nullable(),
    executionBindingDigest: digest.nullable(),
    appointedAt: instant,
    appointedByOwnerIdentityId: id,
  })
  .strict();

const coordinatorHeadEmptySchema = z
  .object({
    tenantId: id,
    projectId: catalogProjectIdSchema,
    version: z.literal(0),
    state: z.literal("none"),
    coordinatorActorType: z.null(),
    coordinatorIdentityId: z.null(),
    executorId: z.null(),
    adapterId: z.null(),
    connectorProfileDigest: z.null(),
    executionBindingDigest: z.null(),
    appointedAt: z.null(),
    appointedByOwnerIdentityId: z.null(),
  })
  .strict();

export const coordinatorHeadStateSchema = z.discriminatedUnion("state", [
  coordinatorHeadPopulatedSchema,
  coordinatorHeadEmptySchema,
]);

// A bounded delegation policy attached to the same head. The coordinator can
// only adopt proposals when a policy is active and inside its validity window.
export const delegationPolicySummarySchema = z
  .object({
    tenantId: id,
    projectId: catalogProjectIdSchema,
    policyId: id,
    coordinatorVersion: z.number().int().min(1),
    state: z.enum(["active", "paused", "revoked"]),
    allowedActions: z.array(z.string().min(1).max(120)).min(1).max(20),
    validFrom: instant,
    validUntil: instant,
    taskAllowance: z.number().int().min(0).max(10_000),
    taskUnitsUsed: z.number().int().min(0).max(10_000),
    microUsdCeiling: z.string().regex(/^[0-9]{1,20}$/),
    microUsdUsed: z.string().regex(/^[0-9]{1,20}$/),
    concurrencyAllowance: z.number().int().min(0).max(1000),
    concurrencyUnitsUsed: z.number().int().min(0).max(1000),
  })
  .strict();

// Active work on the project: the same canonical job records the project page
// already renders through `ProjectOverviewActivityView`, plus the read/write
// scopes the coordinator adopted for it. The page renders them, never authorises
// them.
export const coordinationActiveWorkItemSchema = z
  .object({
    jobId: z.string().regex(/^job:[A-Za-z0-9:_-]{1,160}$/),
    title: z.string().min(1).max(280),
    state: z.enum([
      "proposed",
      "leased",
      "running",
      "waiting",
      "review",
      "finished",
      "failed",
      "blocked",
    ]),
    updatedAt: instant,
    proposalId: z.string().regex(/^proposal:[A-Za-z0-9:_-]{1,160}$/),
    proposalDigest: digest,
    readScopes: z.array(relativePath).max(20),
    writeScopes: z.array(relativePath).max(20),
  })
  .strict();

// Dependency edges between active items. The page renders them so the owner can
// see "B depends on A", and refuses to render anything that would imply
// authority: an edge never carries a recommendation, a re-assignment, or an
// approval.
export const coordinationDependencyEdgeSchema = z
  .object({
    fromJobId: z.string().regex(/^job:[A-Za-z0-9:_-]{1,160}$/),
    toJobId: z.string().regex(/^job:[A-Za-z0-9:_-]{1,160}$/),
    required: z.boolean(),
  })
  .strict();

// A concrete resource conflict. The page surfaces only conflicts the ledger
// has accepted, never a guess. `reasonCode` is the bounded engine refusal code
// the admission operation returned.
export const coordinationConflictLedgerItemSchema = z
  .object({
    ledgerId: z.string().regex(/^conflict:[A-Za-z0-9:_-]{1,160}$/),
    projectId: catalogProjectIdSchema,
    repository: z.string().min(1).max(280),
    resourceKind: z.enum(["tree", "file", "logical"]),
    resourcePath: relativePath,
    conflictingAdmissionId: z.string().regex(/^admission:[A-Za-z0-9:_-]{1,160}$/),
    conflictingJobId: z.string().regex(/^job:[A-Za-z0-9:_-]{1,160}$/),
    conflictingLeaseId: z.string().regex(/^lease:[A-Za-z0-9:_-]{1,160}$/),
    reasonCode: z.string().min(1).max(80),
    raisedAt: instant,
    resolvedAt: instant.nullable(),
    resolutionKind: z
      .enum(["retired", "released", "expired", "superseded", "unspecified"])
      .nullable(),
  })
  .strict();

// Uncertain / disconnected state that needs owner review. The page renders the
// same codes the queue-attention browser client surfaces, but scoped to the
// coordination ledger so the project page never has to reach across
// boundaries.
export const coordinationAttentionItemSchema = z
  .object({
    attentionId: z.string().regex(/^attention:[A-Za-z0-9:_-]{1,160}$/),
    projectId: catalogProjectIdSchema,
    severity: z.enum(["urgent", "soon", "normal"]),
    category: z.enum([
      "uncertainty",
      "failure",
      "approval",
      "review",
      "preparation",
    ]),
    ownerQuestion: z.string().min(1).max(280),
    observedAt: instant,
    referencedJobId: z
      .string()
      .regex(/^job:[A-Za-z0-9:_-]{1,160}$/)
      .nullable(),
    referencedAdmissionId: z
      .string()
      .regex(/^admission:[A-Za-z0-9:_-]{1,160}$/)
      .nullable(),
  })
  .strict();

// The full coordination page payload. The server response is the union of
// every block the page renders, computed once from the canonical head, ledger
// and receipts; the page re-renders without rerunning the engine.
export const projectCoordinationPageSchema = z
  .object({
    project: webProjectSchema.extend({
      projectId: catalogProjectIdSchema,
    }),
    coordinationEnabled: z.boolean(),
    coordinatorHead: coordinatorHeadStateSchema,
    delegationPolicy: delegationPolicySummarySchema.nullable(),
    activeWork: z.array(coordinationActiveWorkItemSchema).max(100),
    dependencies: z.array(coordinationDependencyEdgeSchema).max(500),
    conflicts: z.array(coordinationConflictLedgerItemSchema).max(100),
    attention: z.array(coordinationAttentionItemSchema).max(50),
    nextAction: z.enum([
      "appoint-coordinator",
      "replace-coordinator",
      "revoke-coordinator",
      "pause-policy",
      "resume-policy",
      "revoke-policy",
      "review-attention",
      "resolve-conflict",
      "view-active-work",
      "none",
    ]),
    observedAt: instant,
    // The exact saved versions the page was rendered with. The browser sends
    // these back unchanged on writes; the server refuses anything stale. They
    // are never recomputed client-side from array lengths or presence flags.
    // Ledger revisions are 52-bit content digests over saved rows (the
    // ledgers have no version column), so the bound is the JSON-safe
    // integer range rather than a small sequence cap.
    versions: z
      .object({
        coordinatorVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        policyVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        conflictsVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        attentionVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    // The acting owner's own identity id, so the lifecycle form can warn
    // before naming it as coordinator (the server refuses self-approval).
    viewerOwnerIdentityId: id,
  })
  .strict();

export type ProjectCoordinationPage = z.infer<typeof projectCoordinationPageSchema>;

// The exact revision the server returns with every response, used by owner
// actions to make sure the page state has not drifted underneath the user.
// Every field carries the `expected*` prefix because the shape is a guard:
// the caller is asserting "this is what I saw, refuse me if it isn't current".
export const projectCoordinationRevisionSchema = z
  .object({
    projectId: catalogProjectIdSchema,
    expectedCoordinatorVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    expectedPolicyVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    expectedConflictsVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    expectedAttentionVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    observedAt: instant,
  })
  .strict();

export type ProjectCoordinationRevision = z.infer<
  typeof projectCoordinationRevisionSchema
>;

// An owner action's exact-revision requirement. The browser sends the revision
// it received with the most recent `readCoordination` call; the server refuses
// any action whose revision does not match the current head.
export const projectCoordinationRevisionGuardSchema = projectCoordinationRevisionSchema;

export type ProjectCoordinationRevisionGuard = ProjectCoordinationRevision;

// Inputs to the four owner-authorised lifecycle calls. Each carries the
// coordinator appointment shape the engine expects (`coordinatorActorType`,
// `coordinatorIdentityId`, the execution-binding fields for agents), the
// revision guard, and the idempotency key the HTTP layer requires.
export const projectCoordinatorAppointRequestSchema = z
  .object({
    projectId: catalogProjectIdSchema,
    revision: projectCoordinationRevisionGuardSchema,
    coordinatorActorType: z.enum(["human", "agent"]),
    coordinatorIdentityId: id,
    executorId: id.optional(),
    adapterId: id.optional(),
    connectorProfileDigest: digest.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.coordinatorActorType !== "agent") return;
    if (
      value.executorId === undefined ||
      value.adapterId === undefined ||
      value.connectorProfileDigest === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent coordinator requires executorId, adapterId and connectorProfileDigest",
      });
      return;
    }
    if (value.coordinatorIdentityId === value.executorId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "coordinatorIdentityId must differ from executorId",
      });
    }
  });

export type ProjectCoordinatorAppointRequest = z.infer<
  typeof projectCoordinatorAppointRequestSchema
>;

export const projectCoordinatorReplaceRequestSchema =
  projectCoordinatorAppointRequestSchema;

export const projectCoordinatorRevokeRequestSchema = z
  .object({
    projectId: catalogProjectIdSchema,
    revision: projectCoordinationRevisionGuardSchema,
    coordinatorActorType: z.enum(["human", "agent"]),
    coordinatorIdentityId: id,
    executorId: id.optional(),
    adapterId: id.optional(),
    connectorProfileDigest: digest.optional(),
  })
  .strict();

export type ProjectCoordinatorRevokeRequest = z.infer<
  typeof projectCoordinatorRevokeRequestSchema
>;

export const projectCoordinatorRevokePolicyRequestSchema = z
  .object({
    projectId: catalogProjectIdSchema,
    revision: projectCoordinationRevisionGuardSchema,
    policyId: id,
  })
  .strict();

export type ProjectCoordinatorRevokePolicyRequest = z.infer<
  typeof projectCoordinatorRevokePolicyRequestSchema
>;

export const projectCoordinatorPausePolicyRequestSchema =
  projectCoordinatorRevokePolicyRequestSchema;

export const projectCoordinatorResumePolicyRequestSchema =
  projectCoordinatorRevokePolicyRequestSchema;

// Result envelope every owner action returns. Either the new head revision the
// browser must adopt, or a refused reason code that maps to the page's
// "stale page" / "no longer valid" branches.
export const projectCoordinationActionResultSchema = z
  .object({
    status: z.enum(["accepted", "refused"]),
    reasonCode: z
      .enum([
        "stale_revision",
        "no_coordinator",
        "coordinator_already_active",
        "coordinator_replay_conflict",
        "policy_required",
        "policy_already_active",
        "policy_already_revoked",
        "policy_already_paused",
        "policy_replay_conflict",
        "policy_revoked",
        "coordinator_self_approval",
        "invalid_input",
        "unknown_tenant",
        "unknown_project",
      ])
      .optional(),
    revision: projectCoordinationRevisionSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.status === "refused" ||
      (value.status === "accepted" && value.revision !== undefined),
    "accepted actions must return a revision",
  );

export type ProjectCoordinationActionResult = z.infer<
  typeof projectCoordinationActionResultSchema
>;

// Re-export the revision string rule for callers that compose the guard.
export { revision as projectCoordinationRevisionRule };
