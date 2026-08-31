import { harnessAdapterManifestSchemaV1, type HarnessAdapterManifestV1 } from "../v1";

export const CODEX_PINNED_VERSION_V1 = "0.150.0-alpha.8" as const;
export const CODEX_PINNED_MACOS_CDHASH_V1 = "33f71aee6d3f281e0a63630b6f7d41659834e260" as const;
export const CODEX_PINNED_EXECUTABLE_V1 = "/Applications/ChatGPT.app/Contents/Resources/codex" as const;

export const codexAdapterManifestV1: HarnessAdapterManifestV1 = harnessAdapterManifestSchemaV1.parse({
  schemaVersion: "control-room-harness/v1",
  adapterId: "adapter.codex.exec.macos.v1",
  adapterVersion: "1.0.0",
  harness: "codex",
  harnessVersion: CODEX_PINNED_VERSION_V1,
  harnessRevision: CODEX_PINNED_MACOS_CDHASH_V1,
  runtime: { name: "native", minimumVersion: CODEX_PINNED_VERSION_V1, supportedPlatforms: ["macos"] },
  supportedVerbs: ["discover", "start", "stream", "cancel", "resume", "usage"],
  eventSchemaVersion: "control-room-harness-event/v1",
  approvalMode: "unsupported",
  isolation: "worktree",
  credentialResolution: "harness_native",
  outputForms: ["structured_events", "artifact_references", "final_text_digest", "usage"],
  license: "Apache-2.0",
  distribution: "invocation_only",
});
