import { getRegisteredModuleManifestV1 } from "./registry";

export type ModuleProjectDataAccessV1 = "read" | "write";

export interface ModuleProjectDataPermissionRequestV1 {
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly resource: string;
  readonly access: ModuleProjectDataAccessV1;
}

export interface ModuleProjectDataPermissionV1 extends ModuleProjectDataPermissionRequestV1 {
  readonly authorized: true;
}

const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Runtime gate for module data access. Callers receive a scope-bound receipt,
 * never a database role, connection, credential, or general capability.
 */
export function assertModuleProjectDataPermissionV1(
  request: ModuleProjectDataPermissionRequestV1,
): Readonly<ModuleProjectDataPermissionV1> {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("module_permission_malformed");
  }
  const allowedKeys = new Set(["moduleId", "moduleVersion", "tenantId", "projectId", "resource", "access"]);
  for (const key of Object.keys(request)) {
    if (!allowedKeys.has(key)) throw new Error("module_permission_unknown_key");
  }
  if (typeof request.moduleId !== "string" || typeof request.moduleVersion !== "string"
    || typeof request.resource !== "string") {
    throw new Error("module_permission_malformed");
  }
  if (typeof request.tenantId !== "string" || typeof request.projectId !== "string"
    || !SCOPE_ID_PATTERN.test(request.tenantId) || !SCOPE_ID_PATTERN.test(request.projectId)) {
    throw new Error("module_permission_invalid_scope");
  }
  if (request.access !== "read" && request.access !== "write") throw new Error("module_permission_invalid_access");
  const manifest = getRegisteredModuleManifestV1(request.moduleId, request.moduleVersion);
  const declaration = manifest.permissions.projectData.find(({ resource }) => resource === request.resource);
  if (!declaration || !declaration.access.includes(request.access)) {
    throw new Error("module_permission_denied");
  }
  return Object.freeze({ ...request, authorized: true as const });
}
