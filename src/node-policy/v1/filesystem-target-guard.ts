import { lstat, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { canonicalFilesystemPathSchema } from "./schemas";
import { TargetGuardError } from "./target-guard-errors";

export type FilesystemDialectV1 = "posix" | "windows";

export interface FilesystemObjectEvidenceV1 {
  realPath: string;
  volumeId: string;
  objectId: string;
  objectType: "file" | "directory" | "other";
}

export interface FilesystemInspectorV1 {
  dialect: FilesystemDialectV1;
  inspectExisting(canonicalPath: string): Promise<FilesystemObjectEvidenceV1>;
  exists(canonicalPath: string): Promise<boolean>;
}

export type AuthorizedFilesystemPlanV1 = {
  kind: "existing";
  requestedPath: string;
  realPath: string;
  allowedRootPath: string;
  allowedRootRealPath: string;
  volumeId: string;
  rootObjectId: string;
  targetObjectId: string;
} | {
  kind: "new_file";
  requestedPath: string;
  candidateRealPath: string;
  requestedParentPath: string;
  parentRealPath: string;
  basename: string;
  allowedRootPath: string;
  allowedRootRealPath: string;
  volumeId: string;
  rootObjectId: string;
  parentObjectId: string;
};

function dialectOf(value: string): FilesystemDialectV1 {
  if (value.startsWith("/")) return "posix";
  if (/^[A-Z]:\\/.test(value)) return "windows";
  throw new TargetGuardError("invalid_target");
}

function pathApi(dialect: FilesystemDialectV1): typeof posix | typeof win32 {
  return dialect === "windows" ? win32 : posix;
}

function validateCanonicalPath(value: string, dialect: FilesystemDialectV1): void {
  if (!canonicalFilesystemPathSchema.safeParse(value).success || dialectOf(value) !== dialect) throw new TargetGuardError("invalid_target");
}

function contained(root: string, target: string, dialect: FilesystemDialectV1): boolean {
  const relative = pathApi(dialect).relative(root, target);
  return relative === "" || (!pathApi(dialect).isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${pathApi(dialect).sep}`));
}

function validBasename(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[\\/]/.test(value)
    && [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    });
}

interface InspectedRootV1 {
  configuredPath: string;
  evidence: FilesystemObjectEvidenceV1;
}

async function inspectRoots(inspector: FilesystemInspectorV1, roots: string[]): Promise<InspectedRootV1[]> {
  if (roots.length === 0 || new Set(roots).size !== roots.length
    || roots.some((root, index) => index > 0 && roots[index - 1] > root)) throw new TargetGuardError("target_not_allowed");
  for (const root of roots) validateCanonicalPath(root, inspector.dialect);
  try {
    const evidence = await Promise.all(roots.map(async (root) => ({ configuredPath: root, evidence: await inspector.inspectExisting(root) })));
    if (evidence.some((root) => root.evidence.objectType !== "directory")) throw new TargetGuardError("target_not_allowed");
    return evidence;
  } catch (error) {
    if (error instanceof TargetGuardError) throw error;
    throw new TargetGuardError("target_unavailable");
  }
}

function matchingRoot(target: FilesystemObjectEvidenceV1, roots: InspectedRootV1[], dialect: FilesystemDialectV1): InspectedRootV1 | undefined {
  return roots
    .filter(({ evidence }) => evidence.volumeId === target.volumeId && contained(evidence.realPath, target.realPath, dialect))
    .sort((left, right) => right.evidence.realPath.length - left.evidence.realPath.length
      || (left.configuredPath < right.configuredPath ? -1 : left.configuredPath > right.configuredPath ? 1 : 0))[0];
}

export async function authorizeExistingFilesystemTarget(input: {
  canonicalPath: string;
  allowedRoots: string[];
  inspector: FilesystemInspectorV1;
}): Promise<AuthorizedFilesystemPlanV1> {
  validateCanonicalPath(input.canonicalPath, input.inspector.dialect);
  const roots = await inspectRoots(input.inspector, input.allowedRoots);
  let target: FilesystemObjectEvidenceV1;
  try {
    target = await input.inspector.inspectExisting(input.canonicalPath);
  } catch (error) {
    if (error instanceof TargetGuardError) throw error;
    throw new TargetGuardError("target_unavailable");
  }
  validateCanonicalPath(target.realPath, input.inspector.dialect);
  roots.forEach((root) => validateCanonicalPath(root.evidence.realPath, input.inspector.dialect));
  const root = matchingRoot(target, roots, input.inspector.dialect);
  if (!root) throw new TargetGuardError("target_not_allowed");
  return {
    kind: "existing", requestedPath: input.canonicalPath, realPath: target.realPath,
    allowedRootPath: root.configuredPath, allowedRootRealPath: root.evidence.realPath,
    volumeId: target.volumeId, rootObjectId: root.evidence.objectId, targetObjectId: target.objectId,
  };
}

export async function authorizeNewFileTarget(input: {
  canonicalPath: string;
  allowedRoots: string[];
  inspector: FilesystemInspectorV1;
}): Promise<AuthorizedFilesystemPlanV1> {
  validateCanonicalPath(input.canonicalPath, input.inspector.dialect);
  if (await input.inspector.exists(input.canonicalPath)) throw new TargetGuardError("target_not_allowed");
  const api = pathApi(input.inspector.dialect);
  const basename = api.basename(input.canonicalPath);
  if (!validBasename(basename)) throw new TargetGuardError("invalid_target");
  const parentPath = api.dirname(input.canonicalPath);
  validateCanonicalPath(parentPath, input.inspector.dialect);
  const roots = await inspectRoots(input.inspector, input.allowedRoots);
  let parent: FilesystemObjectEvidenceV1;
  try {
    parent = await input.inspector.inspectExisting(parentPath);
  } catch (error) {
    if (error instanceof TargetGuardError) throw error;
    throw new TargetGuardError("target_unavailable");
  }
  if (parent.objectType !== "directory") throw new TargetGuardError("target_not_allowed");
  validateCanonicalPath(parent.realPath, input.inspector.dialect);
  roots.forEach((root) => validateCanonicalPath(root.evidence.realPath, input.inspector.dialect));
  const root = matchingRoot(parent, roots, input.inspector.dialect);
  if (!root) throw new TargetGuardError("target_not_allowed");
  const candidateRealPath = api.join(parent.realPath, basename);
  validateCanonicalPath(candidateRealPath, input.inspector.dialect);
  if (!contained(root.evidence.realPath, candidateRealPath, input.inspector.dialect)) throw new TargetGuardError("target_not_allowed");
  return {
    kind: "new_file", requestedPath: input.canonicalPath, candidateRealPath, requestedParentPath: parentPath,
    parentRealPath: parent.realPath, basename, allowedRootPath: root.configuredPath,
    allowedRootRealPath: root.evidence.realPath, volumeId: parent.volumeId,
    rootObjectId: root.evidence.objectId, parentObjectId: parent.objectId,
  };
}

function sameEvidence(actual: FilesystemObjectEvidenceV1, expected: { realPath: string; volumeId: string; objectId: string }): boolean {
  return actual.realPath === expected.realPath && actual.volumeId === expected.volumeId && actual.objectId === expected.objectId;
}

export async function revalidateAuthorizedFilesystemPlan(plan: AuthorizedFilesystemPlanV1, inspector: FilesystemInspectorV1): Promise<void> {
  validateCanonicalPath(plan.requestedPath, inspector.dialect);
  try {
    const root = await inspector.inspectExisting(plan.allowedRootPath);
    if (root.objectType !== "directory" || !sameEvidence(root, {
      realPath: plan.allowedRootRealPath, volumeId: plan.volumeId, objectId: plan.rootObjectId,
    })) throw new TargetGuardError("identity_mismatch");
    if (plan.kind === "existing") {
      const target = await inspector.inspectExisting(plan.requestedPath);
      if (!sameEvidence(target, { realPath: plan.realPath, volumeId: plan.volumeId, objectId: plan.targetObjectId })) {
        throw new TargetGuardError("identity_mismatch");
      }
      return;
    }
    if (await inspector.exists(plan.requestedPath)) throw new TargetGuardError("identity_mismatch");
    const parent = await inspector.inspectExisting(plan.requestedParentPath);
    if (parent.objectType !== "directory" || !sameEvidence(parent, {
      realPath: plan.parentRealPath, volumeId: plan.volumeId, objectId: plan.parentObjectId,
    })) throw new TargetGuardError("identity_mismatch");
  } catch (error) {
    if (error instanceof TargetGuardError) throw error;
    throw new TargetGuardError("target_unavailable");
  }
}

export class NodeFilesystemInspector implements FilesystemInspectorV1 {
  readonly dialect: FilesystemDialectV1 = process.platform === "win32" ? "windows" : "posix";

  async inspectExisting(canonicalPath: string): Promise<FilesystemObjectEvidenceV1> {
    validateCanonicalPath(canonicalPath, this.dialect);
    try {
      const resolved = await realpath(canonicalPath);
      validateCanonicalPath(resolved, this.dialect);
      const metadata = await stat(resolved);
      return {
        realPath: resolved, volumeId: String(metadata.dev), objectId: `${metadata.dev}:${metadata.ino}`,
        objectType: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other",
      };
    } catch (error) {
      if (error instanceof TargetGuardError) throw error;
      throw new TargetGuardError("target_unavailable");
    }
  }

  async exists(canonicalPath: string): Promise<boolean> {
    validateCanonicalPath(canonicalPath, this.dialect);
    try {
      await lstat(canonicalPath);
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
      throw new TargetGuardError("target_unavailable");
    }
  }
}
