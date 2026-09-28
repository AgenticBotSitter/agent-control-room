import { CLAUDE_CODE_LOCAL_ADAPTER_V1, CLAUDE_CODE_LOCAL_CAPABILITY_V1 } from "../../harness/claude-code-v1/task-planning-contract";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1 } from "../../harness/codex-v1/owner-trusted-local-task-planning-contract";
import { HERMES_LOCAL_ADAPTER_V1, HERMES_LOCAL_CAPABILITY_V1 } from "../../harness/hermes-local-v1/task-planning-contract";
import type { PipelineStageTemplateV1 } from "../../pipelines/v1/schemas";
import type { TaskAssignmentRoute } from "../../web/v1/task-assignment-coordinator";
import type { CompletionPrincipalV1 } from "./types";
import type { HarnessRunV1 } from "../../harness/v1/types";

type ProtectedSelectionV1 = Pick<PipelineStageTemplateV1, "workerId" | "workerKind" | "nodeId" | "selectionKey" | "model" | "provider" | "profile">;

const routeKinds = Object.freeze({
  codex: Object.freeze({ capability: CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1, harness: "codex",
    adapterId: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, modelFamily: "model-family:openai" }),
  "claude-code": Object.freeze({ capability: CLAUDE_CODE_LOCAL_CAPABILITY_V1, harness: "claude",
    adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1, modelFamily: "model-family:anthropic" }),
  hermes: Object.freeze({ capability: HERMES_LOCAL_CAPABILITY_V1, harness: "hermes",
    adapterId: HERMES_LOCAL_ADAPTER_V1 }),
} as const);

function hermesModelFamily(provider: string | null): string | undefined {
  if (!provider) return undefined;
  const normalized = provider.toLowerCase();
  if (["openai", "azure-openai"].includes(normalized)) return "model-family:openai";
  if (["anthropic", "claude"].includes(normalized)) return "model-family:anthropic";
  if (["google", "gemini", "vertex-ai"].includes(normalized)) return "model-family:google";
  if (["ollama", "local"].includes(normalized)) return "model-family:local";
  return undefined;
}

/** Producer provenance reconstructed from the authenticated harness-run row
 * and its canonical attempt worker. Missing protected model selection remains
 * absent so configured agent-review separation fails closed distinctly. */
export function deriveAuthenticatedRunPrincipalV1(run: Pick<HarnessRunV1,
  "nodeId" | "adapterId" | "harness" | "modelSelection">, workerId: string): CompletionPrincipalV1 {
  const selection = run.modelSelection;
  const modelFamily = run.harness === "codex" ? "model-family:openai"
    : run.harness === "claude" ? "model-family:anthropic"
      : run.harness === "hermes" ? hermesModelFamily(selection?.provider ?? null) : undefined;
  const selectedProfile = selection ? run.harness === "hermes" ? selection.profile : selection.model : undefined;
  const agentProfileId = `agent-profile:${selectedProfile || run.adapterId}`;
  return Object.freeze({ actorId: run.nodeId, actorType: "agent", workerId, harness: run.harness,
    adapterId: run.adapterId, agentProfileId,
    ...(modelFamily ? { modelFamily } : {}) });
}

/**
 * Derive review provenance from the installation-owned route and the exact
 * server-selected stage snapshot. Browser or worker payloads are never an
 * input. Unknown provider families remain absent so independence fails closed
 * with `reviewer_provenance_missing` rather than inventing a family.
 */
export function deriveProtectedAgentPrincipalV1(route: TaskAssignmentRoute,
  selection: ProtectedSelectionV1): CompletionPrincipalV1 {
  const kind = routeKinds[selection.workerKind];
  if (!route || route.nodeId !== selection.nodeId || route.executorId !== selection.workerId
    || route.capabilityProbeId !== kind.capability)
    throw new Error("protected_agent_route_mismatch");
  if (selection.workerKind === "hermes" ? !selection.provider || !selection.profile
    : selection.provider !== null || selection.profile !== null) throw new Error("protected_agent_route_mismatch");
  const modelFamily = "modelFamily" in kind ? kind.modelFamily : hermesModelFamily(selection.provider);
  return Object.freeze({ actorId: selection.nodeId, actorType: "agent", workerId: selection.workerId,
    agentProfileId: `agent-profile:${selection.workerKind === "hermes" ? selection.profile : selection.selectionKey}`,
    harness: kind.harness, adapterId: kind.adapterId, ...(modelFamily ? { modelFamily } : {}) });
}
