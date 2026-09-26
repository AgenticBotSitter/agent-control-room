import { computeAuthorityDigest, sha256Digest } from "../../security";
import { CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, CLAUDE_CODE_LOCAL_ADAPTER_V1,
  CLAUDE_CODE_LOCAL_CAPABILITY_V1, CLAUDE_CODE_LOCAL_START_OPERATION_V1 } from "../../harness/claude-code-v1/task-planning-contract";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1,
  CODEX_OWNER_TRUSTED_LOCAL_START_OPERATION_V1 } from "../../harness/codex-v1/owner-trusted-local-task-planning-contract";
import { HERMES_LOCAL_ADAPTER_V1, HERMES_LOCAL_CAPABILITY_V1,
  HERMES_LOCAL_START_OPERATION_V1 } from "../../harness/hermes-local-v1/task-planning-contract";
import { nativeTaskTemplateSchema, type NativeTaskTemplate } from "./task-execution-planner";
import type { TaskAssignmentRoute } from "./task-assignment-coordinator";
import { createMacLocalOwnerReviewProfileV1 } from "./mac-local-owner-review-profile";
import type { MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";
import type { MacLocalTaskRuntimeV1 } from "./mac-local-task-runtime";

type Project = Readonly<{ projectId: string; createdAt: string }>;
type Kind = "hermes" | "claude" | "codex";
const descriptors = Object.freeze({
  hermes: { adapter: HERMES_LOCAL_ADAPTER_V1, capability: HERMES_LOCAL_CAPABILITY_V1,
    operation: HERMES_LOCAL_START_OPERATION_V1, credential: "credential:owner-cli:hermes" },
  claude: { adapter: CLAUDE_CODE_LOCAL_ADAPTER_V1, capability: CLAUDE_CODE_LOCAL_CAPABILITY_V1,
    operation: CLAUDE_CODE_LOCAL_START_OPERATION_V1, credential: "credential:owner-cli:claude-code" },
  codex: { adapter: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, capability: CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1,
    operation: CODEX_OWNER_TRUSTED_LOCAL_START_OPERATION_V1, credential: "credential:owner-cli:codex" },
} as const);

/** Immutable templates for the first running generation. Each job still needs
 * the existing owner approval, active lease and worker-current checks. */
export function buildMacLocalTaskTemplatesV1(projects: readonly Project[],
  configuration: MacLocalProtectedConfigurationV1, runtime: MacLocalTaskRuntimeV1) {
  if (projects.length < 1 || projects.length > 5) throw new Error("mac_local_template_limit");
  const templates: NativeTaskTemplate[] = [];
  const routes: TaskAssignmentRoute[] = [];
  const profiles = projects.map(project => createMacLocalOwnerReviewProfileV1({
    tenantId: configuration.localOwnerSession.tenantId, projectId: project.projectId,
    ownerIdentityId: `identity:${configuration.localOwnerSession.tenantId}:owner`, projectCreatedAt: project.createdAt,
  }));
  for (const [index, project] of projects.entries()) {
    const profile = profiles[index]!;
    for (const kind of ["hermes", "claude", "codex"] as const satisfies readonly Kind[]) {
      const item = descriptors[kind];
      const worker = configuration.enablement.workers.find(value => value.kind === (kind === "claude" ? "claude-code" : kind));
      if (!worker) throw new Error("mac_local_worker_missing");
      const nodeId = `${configuration.enablement.nodeId}.${kind}`;
      const authority: NativeTaskTemplate["authority"] = {
        projectId: project.projectId, allowedExecutor: worker.workerId,
        allowedOperations: [item.operation], credentialRefs: [item.credential], filesystemRoots: [],
        networkPolicy: kind === "hermes" ? "allowlist" : "none",
        allowedNetworkDestinations: kind === "hermes" ? [runtime.hermes.destination] : [],
        effectPolicy: "approval_required", maxRisk: "low", maxDurationSeconds: 120,
        maxConcurrentEffects: 1, expiresAt: "9999-12-31T23:59:59.000Z", digest: "",
      };
      authority.digest = computeAuthorityDigest(authority);
      const connectorProfileDigest = kind === "claude" ? CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1
        : kind === "hermes" ? sha256Digest(runtime.hermes)
          : sha256Digest({ executablePath: worker.executablePath, recordedVersion: worker.recordedVersion });
      templates.push(nativeTaskTemplateSchema.parse({ id: `template:mac-local:${kind}:${sha256Digest(project.projectId).slice(7, 39)}`,
        adapter: item.adapter, authority, instructions: "Return a bounded plain-text result for owner review only.",
        connectorProfileDigest, acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile) }));
      if (index === 0) routes.push({ nodeId, executorId: worker.workerId, capabilityProbeId: item.capability,
        maxConcurrentTasks: 1, requiredScratchBytes: 0, leaseSeconds: 180 });
    }
  }
  return Object.freeze({ templates: Object.freeze(templates), routes: Object.freeze(routes), profiles: Object.freeze(profiles) });
}
