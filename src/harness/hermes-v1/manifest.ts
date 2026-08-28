import { harnessAdapterManifestSchemaV1, type HarnessAdapterManifestV1 } from "../v1";

export const HERMES_PINNED_REVISION_V1 = "5fc308a70719a83cccdbba4c0e39c23f5a8239d5" as const;

export const hermesAdapterManifestV1: HarnessAdapterManifestV1 = harnessAdapterManifestSchemaV1.parse({
  schemaVersion: "control-room-harness/v1",
  adapterId: "adapter.hermes.gateway.v1",
  adapterVersion: "1.0.0",
  harness: "hermes",
  harnessVersion: "0.20.6",
  harnessRevision: HERMES_PINNED_REVISION_V1,
  runtime: { name: "python", minimumVersion: "3.11", supportedPlatforms: ["linux", "macos", "windows"] },
  supportedVerbs: ["discover", "start", "stream", "steer", "cancel", "resume", "usage"],
  eventSchemaVersion: "control-room-harness-event/v1",
  approvalMode: "observe_only",
  isolation: "adapter_process",
  credentialResolution: "harness_native",
  outputForms: ["structured_events", "usage"],
  license: "MIT",
  distribution: "invocation_only",
});
