import { z } from "zod";
import { isHostProxyV1 } from "../../security/host-value";
import { ProjectCoordinationErrorV1, failProjectCoordinationV1 } from "./errors";

/**
 * The trusted boundary for the two facts a parallel narrow repository writer
 * needs, neither of which a request may assert about itself:
 *
 * 1. which workspace the selected harness actually enforces for this exact
 *    attempt/lease/node lineage, and
 * 2. that the owner policy named by the request really permits narrow writing.
 *
 * Fact 1 is resolved here, by a port captured in the server/node composition
 * rather than supplied per request, exactly as the process-retirement verifier
 * is. Fact 2 is resolved inside the canonical transaction against the stored
 * owner policy row, because only the database holds that authority. A request
 * string cannot establish either one.
 */

export const PARALLEL_NARROW_WRITE_POLICY_ACTION_V1 = "work.admit.parallel-narrow-write" as const;

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const parallelWriteLineageSchemaV1 = z.object({
  tenantId: id,
  projectId: id,
  jobId: id,
  attemptId: id,
  leaseId: id,
  nodeId: id,
  admissionId: id,
}).strict();
export type ParallelWriteLineageV1 = z.infer<typeof parallelWriteLineageSchemaV1>;

export const enforcedWorkspaceIdentitySchemaV1 = z.object({
  /** Identity of the workspace the harness enforces. Never a request field. */
  enforcedWorkspaceId: id,
  /** The workspace intent the declaration must have been built from. */
  workspaceIntentDigest: digest,
}).strict();
export type EnforcedWorkspaceIdentityV1 = z.infer<typeof enforcedWorkspaceIdentitySchemaV1>;

export interface EnforcedWorkspacePortV1 {
  /**
   * Returns the workspace the trusted workspace/lease boundary currently
   * enforces for this exact lineage, or nothing when it enforces none. It never
   * invents, repairs or completes an identity from the request.
   */
  currentEnforcedWorkspace(lineage: ParallelWriteLineageV1):
  Promise<EnforcedWorkspaceIdentityV1 | undefined> | EnforcedWorkspaceIdentityV1 | undefined;
}

export interface ParallelNarrowWriteAuthorizationV1 {
  readonly lineage: ParallelWriteLineageV1;
  readonly policyId: string;
  readonly workspace: EnforcedWorkspaceIdentityV1;
}

const authorizations = new WeakSet<object>();

/**
 * Resolves the enforced workspace through the captured port and mints the
 * authorization the canonical store demands before it will consider a narrow
 * repository writer. The policy is still verified against the stored row inside
 * the transaction; this value only carries the policy the caller named.
 */
export async function authorizeParallelNarrowWriteV1(
  port: EnforcedWorkspacePortV1 | undefined,
  input: { lineage: unknown; policyId: unknown },
): Promise<ParallelNarrowWriteAuthorizationV1> {
  if (!port || typeof port !== "object" || isHostProxyV1(port)
    || typeof port.currentEnforcedWorkspace !== "function") {
    return failProjectCoordinationV1("resource_workspace_unverified");
  }
  const lineage = parallelWriteLineageSchemaV1.safeParse(input.lineage);
  const policyId = id.safeParse(input.policyId);
  if (!lineage.success || !policyId.success) {
    return failProjectCoordinationV1("resource_disjoint_write_not_permitted");
  }
  let resolved: unknown;
  try {
    resolved = await port.currentEnforcedWorkspace(lineage.data);
  } catch (error) {
    if (error instanceof ProjectCoordinationErrorV1) throw error;
    return failProjectCoordinationV1("resource_workspace_unverified");
  }
  const workspace = enforcedWorkspaceIdentitySchemaV1.safeParse(resolved);
  if (!workspace.success) return failProjectCoordinationV1("resource_workspace_unverified");
  const authorization = Object.freeze({
    lineage: Object.freeze(lineage.data),
    policyId: policyId.data,
    workspace: Object.freeze(workspace.data),
  });
  authorizations.add(authorization);
  return authorization;
}

/** Recognises only an authorization this module minted from a trusted resolution. */
export function acquireParallelNarrowWriteAuthorizationV1(
  value: unknown,
): ParallelNarrowWriteAuthorizationV1 | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value) || !authorizations.has(value)
    || !Object.isFrozen(value)) return undefined;
  return value as ParallelNarrowWriteAuthorizationV1;
}
