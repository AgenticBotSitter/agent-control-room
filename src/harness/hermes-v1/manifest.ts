import { harnessAdapterManifestSchemaV1, type HarnessAdapterManifestV1 } from "../v1";

export const HERMES_PINNED_REVISION_V1 = "4956ff0cb9646aaf894c228e6dc932b126d1f927" as const;

export const hermesAdapterManifestV1: HarnessAdapterManifestV1 = harnessAdapterManifestSchemaV1.parse({
  schemaVersion: "control-room-harness/v1",
  adapterId: "adapter.hermes.gateway.v1",
  adapterVersion: "1.0.0",
  harness: "hermes",
  harnessVersion: "0.20.6",
  harnessRevision: HERMES_PINNED_REVISION_V1,
  runtime: { name: "python", minimumVersion: "3.11", supportedPlatforms: ["linux", "macos", "windows"] },
  supportedVerbs: ["discover", "stream", "usage"],
  eventSchemaVersion: "control-room-harness-event/v1",
  approvalMode: "observe_only",
  isolation: "adapter_process",
  credentialResolution: "harness_native",
  outputForms: ["structured_events", "usage"],
  license: "MIT",
  distribution: "invocation_only",
});
