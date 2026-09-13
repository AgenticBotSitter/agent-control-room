import { sha256Digest } from "../../security";
import { HARNESS_ADAPTER_SDK_VERSION_V1, defineHarnessAdapterV1, type HarnessAdapterEventContextV1, type HarnessAdapterNormalizedFrameV1, type HarnessAdapterV1 } from "../sdk-v1";
import { claudeCodeAdapterManifestV1 } from "./manifest";
import { evaluateClaudeCodeCompatibilityV1, type ClaudeCodeCompatibilityEvidenceV1 } from "./compatibility";
import { decodeClaudeCodeStreamJsonLineV1 } from "./decoder";

function normalize(frame: unknown, context: HarnessAdapterEventContextV1): HarnessAdapterNormalizedFrameV1 {
  if (typeof frame !== "string") throw new Error("Claude Code stream-json frame required");
  const decoded = decodeClaudeCodeStreamJsonLineV1(frame, {
    tenantId: context.tenantId, nodeId: context.nodeId, runId: context.runId,
    sequence: context.sequence, occurredAt: context.occurredAt,
  });
  return {
    events: decoded.events,
    ...(decoded.nativeSessionId ? { nativeSessionKeyDigest: sha256Digest({
      tenantId: context.tenantId, nodeId: context.nodeId, adapterId: claudeCodeAdapterManifestV1.adapterId, nativeSessionId: decoded.nativeSessionId,
    }) } : {}),
    ...(decoded.finalTextDigest ? { finalTextDigest: decoded.finalTextDigest } : {}),
  };
}

/**
 * Public observation wrapper for Phase A (docs/claude/CLAUDE_CODE_HARNESS_PLAN.md §4): decodes
 * real CLI subprocess output into canonical harness events. It has no start, execute,
 * credential, or dispatch method — process lifecycle and isolation are Stage C, gated on the
 * Codex execution line, and are deliberately absent here.
 */
export const claudeCodeHarnessAdapterV1: HarnessAdapterV1 = defineHarnessAdapterV1({
  sdkVersion: HARNESS_ADAPTER_SDK_VERSION_V1,
  manifest: claudeCodeAdapterManifestV1,
  evaluateCompatibility: (evidence) => {
    const result = evaluateClaudeCodeCompatibilityV1(evidence as ClaudeCodeCompatibilityEvidenceV1);
    return { compatible: result.compatible, reasons: result.reasons };
  },
  normalizeEvent: normalize,
});
