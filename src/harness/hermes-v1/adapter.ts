import { sha256Digest } from "../../security";
import {
  HARNESS_ADAPTER_SDK_VERSION_V1,
  defineHarnessAdapterV1,
  type HarnessAdapterEventContextV1,
  type HarnessAdapterNormalizedFrameV1,
  type HarnessAdapterV1,
} from "../sdk-v1";
import { evaluateHermesCompatibilityV1, type HermesCompatibilityEvidenceV1 } from "./compatibility";
import { normalizeHermesGatewayEventV1 } from "./gateway";
import { hermesAdapterManifestV1 } from "./manifest";

function normalize(frame: unknown, context: HarnessAdapterEventContextV1): HarnessAdapterNormalizedFrameV1 {
  if (!context.nativeSessionId) throw new Error("Hermes native session required");
  const event = normalizeHermesGatewayEventV1(frame,{ tenantId: context.tenantId,runId: context.runId,sequence: context.sequence,
    occurredAt: context.occurredAt,nativeSessionId: context.nativeSessionId });
  return { events: event ? [event] : [], nativeSessionKeyDigest: sha256Digest({ tenantId: context.tenantId,nodeId: context.nodeId,
    adapterId: hermesAdapterManifestV1.adapterId,nativeSessionId: context.nativeSessionId }) };
}

/** Public observation wrapper; lifecycle invocation remains in the protected Hermes gateway client. */
export const hermesHarnessAdapterV1: HarnessAdapterV1 = defineHarnessAdapterV1({
  sdkVersion: HARNESS_ADAPTER_SDK_VERSION_V1,
  manifest: hermesAdapterManifestV1,
  evaluateCompatibility: (evidence) => {
    const result = evaluateHermesCompatibilityV1(evidence as HermesCompatibilityEvidenceV1);
    return { compatible: result.compatible, reasons: result.reasons };
  },
  normalizeEvent: normalize,
});
