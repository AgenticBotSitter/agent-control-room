import { z } from "zod";
import { coordinationRouteKinds } from "./schemas";

export const PROJECT_WORK_ADMISSION_REQUEST_V1 = "control-room.project-work-admission-request/v1" as const;

/**
 * The standing-delegation action a stored owner policy must list before it can
 * be the authority for admitting shared work resources at all.
 *
 * A delegation policy is a bounded grant of specific actions, not a general
 * token of standing. Existence, currency and ownership of a policy row say
 * nothing about whether its owner delegated *this* operation, so the policy
 * cited by a `kind: "policy"` admission request must name this exact action.
 * A policy that only allows, say, `proposal.adopt` delegates proposal adoption
 * and nothing else, and can never stand behind a repository writer.
 */
export const PROJECT_WORK_ADMISSION_POLICY_ACTION_V1 = "work.admit" as const;

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const instant = z.string().datetime({ offset: true });

/**
 * The one canonical resource-conflict request. Manual, scheduled and
 * news-collection callers differ only in `routeKind` and in which authority row
 * the transaction locks first; they share this shape, this operation and one
 * lock order, so no route can acquire a holder by a private path.
 *
 * `declaration` is deliberately `unknown`: it is canonicalised by the shared
 * boundary module inside the transaction, so a caller cannot present a
 * pre-digested declaration that the engine never re-derives. Omitting it refuses;
 * it is never treated as read-only work.
 */
export const projectWorkAdmissionRequestSchemaV1 = z.object({
  schema: z.literal(PROJECT_WORK_ADMISSION_REQUEST_V1),
  routeKind: z.enum(coordinationRouteKinds),
  tenantId: id,
  projectId: id,
  jobId: id,
  attemptId: id,
  leaseId: id,
  nodeId: id,
  admissionId: id,
  authority: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("owner"), ownerIdentityId: id }).strict(),
    z.object({ kind: z.literal("policy"), policyId: id, ownerIdentityId: id }).strict(),
  ]),
  declaration: z.unknown(),
  /**
   * A request may only *ask* for exact disjoint repository writers and name the
   * owner policy it believes permits them. It cannot assert that the permission
   * exists and it cannot state its own workspace: the policy is verified against
   * the stored owner policy row inside the canonical transaction, and the
   * enforced workspace is resolved by the trusted workspace/lease boundary.
   * Without both facts the declaration must take a root-tree write scope and
   * serialize.
   */
  disjointWriters: z.object({
    requested: z.boolean(),
    policyId: id.optional(),
  }).strict(),
  acquiredAt: instant,
}).strict().superRefine((value, context) => {
  if (value.disjointWriters.requested && !value.disjointWriters.policyId) {
    context.addIssue({ code: "custom", message: "requested disjoint writers must name the owner policy" });
  }
});
export type ProjectWorkAdmissionRequestV1 = z.infer<typeof projectWorkAdmissionRequestSchemaV1>;

export interface ProjectWorkAdmissionResultV1 {
  admissionId: string;
  admissionDigest: string;
  declarationDigest: string;
  workspaceIntentDigest: string;
  version: number;
  replayed: boolean;
}

export const projectWorkAdmissionRecheckSchemaV1 = z.object({
  tenantId: id,
  projectId: id,
  jobId: id,
  attemptId: id,
  leaseId: id,
  nodeId: id,
  admissionId: id,
  declaration: z.unknown(),
}).strict();
export type ProjectWorkAdmissionRecheckV1 = z.infer<typeof projectWorkAdmissionRecheckSchemaV1>;
