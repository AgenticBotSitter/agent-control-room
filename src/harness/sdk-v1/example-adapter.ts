import { sha256Digest } from "../../security";
import { HARNESS_EVENT_SCHEMA_VERSION_V1, HARNESS_CONTRACT_VERSION_V1, harnessRunEventSchemaV1 } from "../v1";
import { defineHarnessAdapterV1 } from "./conformance";
import { HARNESS_ADAPTER_SDK_VERSION_V1, type HarnessAdapterV1 } from "./types";

/** Effect-free example for third-party adapter authors. It only maps a bounded status frame to an observation. */
export const exampleHarnessAdapterV1: HarnessAdapterV1 = defineHarnessAdapterV1({
  sdkVersion: HARNESS_ADAPTER_SDK_VERSION_V1,
  manifest: {
    schemaVersion: HARNESS_CONTRACT_VERSION_V1, adapterId: "adapter.example.status.v1", adapterVersion: "1.0.0", harness: "other",
    harnessVersion: "1.0.0", harnessRevision: "0000000000000000000000000000000000000000",
    runtime: { name: "node", minimumVersion: "22.13.0", supportedPlatforms: ["linux","macos","windows"] }, supportedVerbs: ["discover","stream"],
    eventSchemaVersion: HARNESS_EVENT_SCHEMA_VERSION_V1, approvalMode: "unsupported", isolation: "adapter_process",
    credentialResolution: "unsupported", outputForms: ["structured_events"], license: "MIT", distribution: "redistributable",
  },
  evaluateCompatibility: (evidence) => ({ compatible: Boolean(evidence && typeof evidence === "object" && (evidence as { version?: unknown }).version === "1.0.0"),
    reasons: evidence && typeof evidence === "object" && (evidence as { version?: unknown }).version === "1.0.0" ? [] : ["version_drift"] }),
  normalizeEvent: (frame, context) => {
    if (!frame || typeof frame !== "object" || Array.isArray(frame) || (frame as { state?: unknown }).state !== "ready") throw new Error("example frame invalid");
    const event = harnessRunEventSchemaV1.parse({ schemaVersion: HARNESS_EVENT_SCHEMA_VERSION_V1,tenantId: context.tenantId,runId: context.runId,
      sequence: context.sequence,occurredAt: context.occurredAt,source: "adapter",sourceEventKeyDigest: sha256Digest({ adapterId: "adapter.example.status.v1",
        runId: context.runId,sequence: context.sequence,state: "ready" }),payload: { category: "transport",state: "connected" } });
    return { events: [event] };
  },
});
