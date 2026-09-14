import { z } from "zod";
import { coordinationRouteKinds } from "./schemas";

export const PROJECT_WORK_ADMISSION_REQUEST_V1 = "control-room.project-work-admission-request/v1" as const;

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
   * Owner policy permitting exact disjoint repository writers, plus the workspace
   * the selected harness actually enforces. Both are required before two writers
   * may share a repository; otherwise the declaration must take a root-tree write
   * scope and serialize.
   */
  disjointWriters: z.object({
    permitted: z.boolean(),
    policyId: id.optional(),
    enforcedWorkspaceId: id.optional(),
  }).strict(),
  acquiredAt: instant,
}).strict().superRefine((value, context) => {
  if (value.disjointWriters.permitted
    && (!value.disjointWriters.policyId || !value.disjointWriters.enforcedWorkspaceId)) {
    context.addIssue({ code: "custom", message: "permitted disjoint writers require a policy and an enforced workspace" });
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
