import { sha256Digest } from "../../security";
import {
  HARNESS_ADAPTER_SDK_VERSION_V1,
  defineHarnessAdapterV1,
  type HarnessAdapterEventContextV1,
  type HarnessAdapterNormalizedFrameV1,
  type HarnessAdapterV1,
} from "../sdk-v1";
import { evaluateCodexCompatibilityV1, type CodexCompatibilityEvidenceV1 } from "./compatibility";
import { decodeCodexJsonLineV1 } from "./decoder";
import { codexAdapterManifestV1 } from "./manifest";

function normalize(frame: unknown, context: HarnessAdapterEventContextV1): HarnessAdapterNormalizedFrameV1 {
  if (typeof frame !== "string") throw new Error("Codex JSONL frame required");
  const decoded = decodeCodexJsonLineV1(frame,{ tenantId: context.tenantId,nodeId: context.nodeId,runId: context.runId,
    sequence: context.sequence,occurredAt: context.occurredAt,verificationCommands: context.verificationCommands });
  return { events: decoded.events, ...(decoded.nativeThreadId ? { nativeSessionKeyDigest: sha256Digest({ tenantId: context.tenantId,
    nodeId: context.nodeId,adapterId: codexAdapterManifestV1.adapterId,nativeThreadId: decoded.nativeThreadId }) } : {}),
  ...(decoded.finalTextDigest ? { finalTextDigest: decoded.finalTextDigest } : {}) };
}

/** Public observation wrapper; planning, credentials, and isolated execution remain in protected Codex modules. */
export const codexHarnessAdapterV1: HarnessAdapterV1 = defineHarnessAdapterV1({
  sdkVersion: HARNESS_ADAPTER_SDK_VERSION_V1,
  manifest: codexAdapterManifestV1,
  evaluateCompatibility: (evidence) => {
    const result = evaluateCodexCompatibilityV1(evidence as CodexCompatibilityEvidenceV1);
    return { compatible: result.compatible, reasons: result.reasons };
  },
  normalizeEvent: normalize,
});
