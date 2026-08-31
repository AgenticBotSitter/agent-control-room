import type {
  ProjectWorkspaceOperatorReadSourceV1,
  ProjectWorkspaceOwnerReadScopeAuthorityV1,
} from "@/src/project-workspace/v1";
import { PROJECT_WORKSPACE_PROTECTED_RUNTIME_DISABLED_V1 } from "@/src/project-workspace/v1";

export interface ProjectWorkspaceProtectedRuntimeV1 {
  scopeAuthority: ProjectWorkspaceOwnerReadScopeAuthorityV1;
  readSource: ProjectWorkspaceOperatorReadSourceV1;
}

/**
 * The repository intentionally ships no implicit identity-header, catalog, or
 * database wiring. A later owner-attended pilot must provide all three as one
 * server-only composition after its protected configuration is accepted.
 */
export function getProjectWorkspaceProtectedRuntimeV1(): ProjectWorkspaceProtectedRuntimeV1 | undefined {
  return undefined;
}

export const projectWorkspaceProtectedRuntimeDispositionV1 = PROJECT_WORKSPACE_PROTECTED_RUNTIME_DISABLED_V1;
