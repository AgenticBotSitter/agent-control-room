import type { HarnessAdapterManifestV1, HarnessRunEventV1 } from "../v1";

export const HARNESS_ADAPTER_SDK_VERSION_V1 = "control-room-harness-adapter-sdk/v1" as const;

/** Node-local input only. Native session IDs are never part of the normalized output. */
export interface HarnessAdapterEventContextV1 {
  tenantId: string;
  nodeId: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  nativeSessionId?: string;
  verificationCommands?: readonly string[];
}

export interface HarnessAdapterNormalizedFrameV1 {
  events: HarnessRunEventV1[];
  nativeSessionKeyDigest?: string;
  finalTextDigest?: string;
}

export interface HarnessAdapterCompatibilityDecisionV1 {
  compatible: boolean;
  reasons: string[];
}

/** Public, observation-only adapter boundary. It has no execution, approval, credential, or effect method. */
export interface HarnessAdapterV1 {
  sdkVersion: typeof HARNESS_ADAPTER_SDK_VERSION_V1;
  manifest: HarnessAdapterManifestV1;
  evaluateCompatibility(evidence: unknown): HarnessAdapterCompatibilityDecisionV1;
  normalizeEvent(frame: unknown, context: HarnessAdapterEventContextV1): HarnessAdapterNormalizedFrameV1;
}

export interface HarnessAdapterConformanceFixtureV1 {
  name: string;
  frame: unknown;
  context: HarnessAdapterEventContextV1;
  expectedEventCount: number;
}

export interface HarnessAdapterConformanceResultV1 {
  adapterId: string;
  compatible: boolean;
  normalizedEventCount: number;
  reasons: Array<"compatibility_rejected" | "fixture_invalid" | "normalization_failed">;
}
