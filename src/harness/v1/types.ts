import type { NativeSnapshotEventPayload, NativeTaskRegistration } from "./native-observation";

export const HARNESS_CONTRACT_VERSION_V1 = "control-room-harness/v1" as const;
export const HARNESS_EVENT_SCHEMA_VERSION_V1 = "control-room-harness-event/v1" as const;

export const harnessRunStates = ["discovered", "starting", "running", "waiting_input", "waiting_approval", "cancelling", "disconnected", "succeeded", "failed", "cancelled"] as const;
export type HarnessRunState = (typeof harnessRunStates)[number];
export type HarnessLifecycleVerb = "discover" | "start" | "stream" | "steer" | "cancel" | "resume" | "usage";

export interface HarnessAdapterManifestV1 {
  schemaVersion: typeof HARNESS_CONTRACT_VERSION_V1;
  adapterId: string;
  adapterVersion: string;
  harness: "hermes" | "codex" | "claude" | "other";
  harnessVersion: string;
  harnessRevision: string;
  runtime: { name: string; minimumVersion: string; supportedPlatforms: Array<"linux" | "macos" | "windows"> };
  supportedVerbs: HarnessLifecycleVerb[];
  eventSchemaVersion: typeof HARNESS_EVENT_SCHEMA_VERSION_V1;
  approvalMode: "unsupported" | "observe_only" | "request_response";
  isolation: "adapter_process" | "worktree" | "container" | "harness_owned";
  credentialResolution: "harness_native" | "node_reference_only" | "unsupported";
  outputForms: Array<"structured_events" | "artifact_references" | "final_text_digest" | "usage">;
  license: string;
  distribution: "invocation_only" | "redistributable";
}

export interface HarnessRunV1 {
  schemaVersion: typeof HARNESS_CONTRACT_VERSION_V1;
  id: string;
  tenantId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  nodeId: string;
  adapterId: string;
  adapterVersion: string;
  harness: HarnessAdapterManifestV1["harness"];
  harnessVersion: string;
  nativeSessionKeyDigest: string;
  parentRunId?: string;
  revisionOfRunId?: string;
  state: HarnessRunState;
  resumable: boolean;
  cancelState: "not_requested" | "requested" | "confirmed" | "reported" | "unsupported";
  nativeTask?: NativeTaskRegistration;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastObservedAt: string;
  safeReasonCode?: string;
}

export type HarnessEventPayloadV1 =
  | NativeSnapshotEventPayload
  | { category: "lifecycle"; state: HarnessRunState; reasonCode?: string }
  | { category: "activity"; activity: "tool" | "file" | "test" | "checkpoint"; phase: "started" | "progress" | "completed" | "failed"; count?: number }
  | { category: "attention"; attention: "input" | "approval"; state: "requested" | "resolved" }
  | { category: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number; estimatedCostUsd?: string }
  | { category: "transport"; state: "connected" | "disconnected" | "reconnected" | "drift"; reasonCode?: string };

export interface HarnessRunEventV1 {
  schemaVersion: typeof HARNESS_EVENT_SCHEMA_VERSION_V1;
  tenantId: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  source: "adapter" | "harness_read" | "control_room";
  sourceEventKeyDigest: string;
  payload: HarnessEventPayloadV1;
}

export interface HarnessRunUsageV1 {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  estimatedCostUsd?: string;
}
