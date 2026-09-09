import { z } from "zod";
import { dirname, isAbsolute, resolve } from "node:path";
import { localId } from "../harness/v1/native-run-identifiers";
import { sha256Digest } from "../security/canonical-digest";

/** A promise is not completed authority. Reject it before any subsequent effect
 * and observe its rejection so a misconfigured callback cannot crash the host. */
export function assertSynchronousWorkspaceAuthority(check: () => unknown): void {
  const result = check();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new Error("workspace_authority_must_be_synchronous");
  }
}

const path = z.string().min(1).max(4096).refine(value => !value.includes("\0") && isAbsolute(value) && resolve(value) === value);
export const workspaceIntentSchema = z.object({
  schema: z.literal("control-room.workspace-intent/v1"),
  tenantId: localId, projectId: localId, nodeId: localId, jobId: localId,
  attemptId: localId, runId: localId, leaseId: localId, leaseEpoch: z.number().int().positive(),
  repositoryRoot: path, workspaceRoot: path, checkoutPath: path,
  revision: z.string().regex(/^[a-f0-9]{40}$/),
}).strict().superRefine((value, ctx) => {
  const expected = `codex-${sha256Digest(value.runId).slice(7,31)}`;
  if (dirname(value.checkoutPath) !== value.workspaceRoot || value.checkoutPath.slice(value.workspaceRoot.length + 1) !== expected)
    ctx.addIssue({ code: "custom", message: "workspace target binding invalid" });
});
export type WorkspaceIntent = z.infer<typeof workspaceIntentSchema>;

const creationSchema = z.object({
  realPath: path, repositoryRealPath: path, headRevision: z.string().regex(/^[a-f0-9]{40}$/),
  device: z.string().regex(/^[1-9][0-9]*$/).max(32), inode: z.string().regex(/^[1-9][0-9]*$/).max(32),
}).strict();
const identitySchema = creationSchema.pick({ realPath: true, device: true, inode: true });
const rootIdentitiesSchema = z.object({ repository: identitySchema, workspace: identitySchema, commonGit: identitySchema }).strict();
export function parseWorkspaceRoots(value: unknown, intent: WorkspaceIntent) {
  const parsed = rootIdentitiesSchema.safeParse(value);
  if (!parsed.success || parsed.data.repository.realPath !== intent.repositoryRoot
    || parsed.data.workspace.realPath !== intent.workspaceRoot) throw new Error("workspace_roots_binding_invalid");
  return parsed.data;
}
export function parseWorkspaceCreation(value: unknown, intent: WorkspaceIntent) {
  const parsed = creationSchema.safeParse(value);
  if (!parsed.success || parsed.data.realPath !== intent.checkoutPath
    || parsed.data.repositoryRealPath !== intent.repositoryRoot || parsed.data.headRevision !== intent.revision)
    throw new Error("workspace_creation_binding_invalid");
  return parsed.data;
}

export function parseWorkspaceIntent(value: unknown): WorkspaceIntent {
  const parsed = workspaceIntentSchema.safeParse(value);
  if (!parsed.success) throw new Error("workspace_intent_invalid");
  return parsed.data;
}
