import { harnessAdapterManifestSchemaV1, type HarnessAdapterManifestV1 } from "../v1";

/**
 * Pinned to @anthropic-ai/claude-code@2.1.270 as installed and verified unauthenticated
 * on darwin-arm64 in Stage A0 (docs/claude/CLAUDE_CODE_A0_VERIFICATION.md). The revision is
 * the npm registry's published gitHead for this exact version, not the shorter build commit
 * `claude doctor` prints at runtime — see CLAUDE_CODE_PINNED_BUILD_COMMIT_V1 in compatibility.ts
 * for that second, independently-checked identifier.
 */
export const CLAUDE_CODE_PINNED_VERSION_V1 = "2.1.270" as const;
export const CLAUDE_CODE_PINNED_REVISION_V1 = "6cba495abac4528f76fddf32acd46b016a0d48a6" as const;

/**
 * Phase A per docs/claude/CLAUDE_CODE_HARNESS_PLAN.md §4: wraps the CLI subprocess for
 * discover/start/stream/cancel/resume/usage only. Declares neither "steer" nor
 * approvalMode "request_response" — those need the in-process Agent SDK host (Phase B/D)
 * and must not be claimed here where no runtime backs them. isolation is declared as
 * "worktree" because Stage C is scoped to reuse the Codex worktree manager rather than
 * build a second one; no real spawner exists yet for either harness.
 */
export const claudeCodeAdapterManifestV1: HarnessAdapterManifestV1 = harnessAdapterManifestSchemaV1.parse({
  schemaVersion: "control-room-harness/v1",
  adapterId: "adapter.claude-code.cli.v1",
  adapterVersion: "1.0.0",
  harness: "claude",
  harnessVersion: CLAUDE_CODE_PINNED_VERSION_V1,
  harnessRevision: CLAUDE_CODE_PINNED_REVISION_V1,
  runtime: { name: "node", minimumVersion: "22.13.0", supportedPlatforms: ["macos"] },
  supportedVerbs: ["discover", "start", "stream", "cancel", "resume", "usage"],
  eventSchemaVersion: "control-room-harness-event/v1",
  approvalMode: "unsupported",
  isolation: "worktree",
  credentialResolution: "harness_native",
  outputForms: ["structured_events", "final_text_digest", "usage"],
  license: "SEE LICENSE IN README.md",
  distribution: "invocation_only",
});
