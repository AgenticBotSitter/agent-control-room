import { z } from "zod";
import { sha256Digest } from "../../security";

export const PROJECT_COORDINATOR_EXECUTION_BINDING_V1 =
  "control-room.project-coordinator-execution-binding/v1" as const;
export const PROJECT_COORDINATOR_PLANNING_MARKER_V1 =
  "control-room.project-coordinator-planning-marker/v1" as const;
export const PROJECT_WORK_RESOURCE_DECLARATION_V1 =
  "control-room.project-work-resource-declaration/v1" as const;
export const PROJECT_WORK_RESOURCE_ADMISSION_V1 =
  "control-room.project-work-resource-admission/v1" as const;
export const NO_WORKSPACE_INTENT_V1 = "control-room.no-workspace-intent/v1" as const;
export const NO_WORKSPACE_RESOURCE_V1 = "control-room.no-workspace-resource/v1" as const;
export const NO_WORKSPACE_ANCHOR_RESOURCE_ID_V1 = "resource:logical:no-workspace:v1" as const;
export const CURRENT_RESOURCE_HOLDER_PROOF_V2 =
  "control-room.current-resource-holder/v2" as const;
export const PROCESS_RETIREMENT_PROOF_V1 = "control-room.process-retirement-proof/v1" as const;
export const CURRENT_RESOURCE_HOLDER_MAX_TTL_MS_V2 = 10_000;

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const revision = z.string().min(1).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/);
const relativePath = z.string().max(512).refine((value) => value === "" ||
  /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,127})*$/.test(value),
"invalid repository-relative path");

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const projectCoordinatorExecutionBindingSchemaV1 = z.object({
  schema: z.literal(PROJECT_COORDINATOR_EXECUTION_BINDING_V1),
  tenantId: id,
  projectId: id,
  coordinatorIdentityId: id,
  executorId: id,
  adapterId: id,
  connectorProfileDigest: digest,
}).strict();
export type ProjectCoordinatorExecutionBindingV1 =
  z.infer<typeof projectCoordinatorExecutionBindingSchemaV1>;

export function projectCoordinatorExecutionBindingDigestV1(value: unknown): string {
  return sha256Digest(projectCoordinatorExecutionBindingSchemaV1.parse(value));
}

/**
 * Server-created proof that one exact canonical job was explicitly requested to
 * produce a coordination proposal. A result without this immutable marker is an
 * ordinary task result and must never be parsed as a project plan.
 */
export const projectCoordinatorPlanningMarkerSchemaV1 = z.object({
  schema: z.literal(PROJECT_COORDINATOR_PLANNING_MARKER_V1),
  tenantId: id,
  projectId: id,
  planningJobId: id,
  planningJobDigest: digest,
  planningInputDigest: digest,
  attemptId: id,
  runId: id,
  nodeId: id,
  coordinatorIdentityId: id,
  coordinatorVersion: z.number().int().positive(),
  adapterId: id,
  connectorProfileDigest: digest,
  executionBindingDigest: digest,
  executionRequestDigest: digest,
  ownerIdentityId: id,
  ownerRequestId: id,
  ownerRequestDigest: digest,
  expectedProposalSchema: z.literal("control-room.project-coordination-proposal/v1"),
  createdAt: instant,
}).strict();
export type ProjectCoordinatorPlanningMarkerV1 =
  z.infer<typeof projectCoordinatorPlanningMarkerSchemaV1>;

export function projectCoordinatorPlanningMarkerDigestV1(value: unknown): string {
  return sha256Digest(projectCoordinatorPlanningMarkerSchemaV1.parse(value));
}

const scopeBase = z.object({
  resourceId: id,
  resourceKind: z.enum(["repository", "logical"]),
  resourceConfigurationDigest: digest,
  accessMode: z.enum(["read", "write"]),
  scopeKind: z.enum(["file", "tree", "logical"]),
  path: relativePath,
}).strict().superRefine((value, context) => {
  if (value.resourceKind === "logical" && (value.scopeKind !== "logical" || value.path !== "")) {
    context.addIssue({ code: "custom", message: "logical resources require one whole logical scope" });
  }
  if (value.resourceKind === "repository" && value.scopeKind === "logical") {
    context.addIssue({ code: "custom", message: "repository resources require file or tree scopes" });
  }
});

const repositoryWorkspace = z.object({
  kind: z.literal("repository"),
  resourceId: id,
  resourceConfigurationDigest: digest,
  baseRevision: revision,
  workspaceIntentDigest: digest,
}).strict();

const noWorkspace = z.object({
  kind: z.literal("none"),
  anchorResourceId: z.literal(NO_WORKSPACE_ANCHOR_RESOURCE_ID_V1),
  anchorConfigurationDigest: digest,
  baseRevision: z.literal("no-workspace:v1"),
  workspaceIntentDigest: digest,
}).strict();

const declarationBase = z.object({
  schema: z.literal(PROJECT_WORK_RESOURCE_DECLARATION_V1),
  tenantId: id,
  projectId: id,
  jobId: id,
  workspace: z.discriminatedUnion("kind", [repositoryWorkspace, noWorkspace]),
  scopes: z.array(scopeBase).min(1).max(96),
}).strict();

export type ProjectWorkResourceScopeV1 = z.infer<typeof scopeBase>;
export type ProjectWorkResourceDeclarationV1 = z.infer<typeof declarationBase>;

function canonicalScopes(scopes: readonly ProjectWorkResourceScopeV1[]): ProjectWorkResourceScopeV1[] {
  const seen = new Set<string>();
  const canonical = scopes.map((scope) => ({ ...scope, path: scope.path.toLowerCase() }));
  for (const scope of canonical) {
    const key = `${scope.resourceId}\0${scope.scopeKind}\0${scope.path}`;
    if (seen.has(key)) throw new Error("project_resource_declaration_duplicate_scope");
    seen.add(key);
  }
  return canonical.sort((left, right) => compareAscii(left.resourceId, right.resourceId)
    || compareAscii(left.scopeKind, right.scopeKind)
    || compareAscii(left.path, right.path)
    || compareAscii(left.accessMode, right.accessMode));
}

/** Resolve IDs/configuration digests before this function; browser values are never trusted inputs. */
export function canonicalProjectWorkResourceDeclarationV1(value: unknown): ProjectWorkResourceDeclarationV1 {
  const parsed = declarationBase.parse(value);
  const scopes = canonicalScopes(parsed.scopes);
  const repositoryScopes = scopes.filter((scope) => scope.resourceKind === "repository");
  const logicalScopes = scopes.filter((scope) => scope.resourceKind === "logical");
  if (scopes.some((scope) => scope.resourceId === NO_WORKSPACE_ANCHOR_RESOURCE_ID_V1)) {
    throw new Error("project_resource_declaration_reserved_anchor_scope");
  }
  if (repositoryScopes.length > 64 || logicalScopes.length > 32) {
    throw new Error("project_resource_declaration_scope_limit");
  }
  if (parsed.workspace.kind === "none") {
    if (repositoryScopes.length !== 0 || logicalScopes.length === 0
    ) {
      throw new Error("project_resource_declaration_no_workspace_invalid");
    }
    if (parsed.workspace.anchorConfigurationDigest !== noWorkspaceAnchorConfigurationDigestV1(parsed.tenantId)
      || parsed.workspace.workspaceIntentDigest !== noWorkspaceIntentDigestV1(parsed)) {
      throw new Error("project_resource_declaration_no_workspace_binding_invalid");
    }
  } else {
    const workspace = parsed.workspace;
    if (!repositoryScopes.some((scope) => scope.resourceKind === "repository"
      && scope.resourceId === workspace.resourceId
      && scope.resourceConfigurationDigest === workspace.resourceConfigurationDigest)) {
      throw new Error("project_resource_declaration_workspace_scope_missing");
    }
  }
  return declarationBase.parse({ ...parsed, scopes });
}

export function projectWorkResourceDeclarationDigestV1(value: unknown): string {
  return sha256Digest(canonicalProjectWorkResourceDeclarationV1(value));
}

export const projectWorkResourceAdmissionSchemaV1 = z.object({
  schema: z.literal(PROJECT_WORK_RESOURCE_ADMISSION_V1),
  tenantId: id,
  projectId: id,
  jobId: id,
  attemptId: id,
  leaseId: id,
  nodeId: id,
  admissionId: id,
  declarationDigest: digest,
}).strict();
export type ProjectWorkResourceAdmissionV1 = z.infer<typeof projectWorkResourceAdmissionSchemaV1>;

export function projectWorkResourceAdmissionDigestV1(value: unknown): string {
  return sha256Digest(projectWorkResourceAdmissionSchemaV1.parse(value));
}

export function noWorkspaceAnchorConfigurationDigestV1(tenantId: string): string {
  return sha256Digest({ schema: NO_WORKSPACE_RESOURCE_V1, tenantId: id.parse(tenantId) });
}

export function noWorkspaceIntentDigestV1(value: { tenantId: string; projectId: string; jobId: string }): string {
  return sha256Digest({ schema: NO_WORKSPACE_INTENT_V1,
    tenantId: id.parse(value.tenantId), projectId: id.parse(value.projectId), jobId: id.parse(value.jobId) });
}

/** This digest is evidence only when returned by the authenticated current-holder port. */
export const currentResourceHolderProofSchemaV2 = z.object({
  schema: z.literal(CURRENT_RESOURCE_HOLDER_PROOF_V2),
  tenantId: id,
  projectId: id,
  jobId: id,
  attemptId: id,
  leaseId: id,
  nodeId: id,
  runId: id,
  admissionId: id,
  resourceAdmissionDigest: digest,
  startAuthorizationDigest: digest,
  admissionVersion: z.number().int().positive(),
  state: z.literal("held"),
  checkedAt: instant,
  expiresAt: instant,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.checkedAt)) {
    context.addIssue({ code: "custom", message: "holder proof must expire after it was checked" });
  }
});
export type CurrentResourceHolderProofV2 = z.infer<typeof currentResourceHolderProofSchemaV2>;

export function currentResourceHolderProofDigestV2(value: unknown): string {
  return sha256Digest(currentResourceHolderProofSchemaV2.parse(value));
}

export function verifyCurrentResourceHolderProofV2(value: unknown, expected: {
  tenantId: string; projectId: string; jobId: string; attemptId: string; leaseId: string; nodeId: string;
  runId: string; admissionId: string; resourceAdmissionDigest: string; startAuthorizationDigest: string;
}, nowMs: number): CurrentResourceHolderProofV2 {
  const proof = currentResourceHolderProofSchemaV2.parse(value);
  if (!Number.isSafeInteger(nowMs) || Date.parse(proof.checkedAt) > nowMs
    || Date.parse(proof.expiresAt) <= nowMs
    || Date.parse(proof.expiresAt) - Date.parse(proof.checkedAt) > CURRENT_RESOURCE_HOLDER_MAX_TTL_MS_V2
    || Object.entries(expected).some(([key, expectedValue]) =>
      proof[key as keyof CurrentResourceHolderProofV2] !== expectedValue)) {
    throw new Error("current_resource_holder_proof_invalid");
  }
  return proof;
}

/** Shape/digest only; acceptance still requires the captured authenticated retirement verifier. */
export const processRetirementProofSchemaV1 = z.object({
  schema: z.literal(PROCESS_RETIREMENT_PROOF_V1),
  tenantId: id,
  projectId: id,
  jobId: id,
  attemptId: id,
  leaseId: id,
  nodeId: id,
  admissionId: id,
  resourceAdmissionDigest: digest,
  runId: id,
  processIdentityDigest: digest,
  sourceKind: z.enum(["native_recovery", "codex_owned_process"]),
  sourceEvidenceDigest: digest,
  observedAt: instant,
}).strict();
export type ProcessRetirementProofV1 = z.infer<typeof processRetirementProofSchemaV1>;

export function processRetirementProofDigestV1(value: unknown): string {
  return sha256Digest(processRetirementProofSchemaV1.parse(value));
}
