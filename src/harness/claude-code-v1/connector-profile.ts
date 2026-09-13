import { connectorProfileSchemaV1, type ConnectorProfileV1 } from "../v1/connector-profile";

/**
 * Pinned to the exact npm publish verified unauthenticated on darwin-arm64 in Stage A0
 * (docs/claude/CLAUDE_CODE_A0_VERIFICATION.md). Per docs/SHARED_CONNECTOR_CONTRACT.md's
 * Claude Code section, this profile identifies the package by name/version/SHA-512
 * integrity rather than inventing a Git revision — Claude Code is distributed as an npm
 * package, not from a pinned source checkout the way Codex and Hermes are.
 */
export const CLAUDE_CODE_PACKAGE_NAME_V1 = "@anthropic-ai/claude-code" as const;
export const CLAUDE_CODE_PACKAGE_VERSION_V1 = "2.1.270" as const;
export const CLAUDE_CODE_PACKAGE_INTEGRITY_V1 =
  "sha512-0zMkfIWQu7/SG56VP8r780HZWvrNShzK28AbAnhKRK0ns+ToGXPT0W8UqyZmZCUKAkJDd5//TrwSOhk1+hysiw==" as const;

/**
 * Inert connector metadata only — no callback, credential, endpoint or execution
 * authority, per docs/SHARED_CONNECTOR_CONTRACT.md. Every operation is "unsupported":
 * Stage A0 ran the real CLI unauthenticated and captured real frame shapes for the
 * `result`/`events`-adjacent surface (see evidence below), but no operation has passed
 * an actual authenticated round trip, so none may be admissible yet — see
 * connectorOperationAdmissibleV1, which requires "supported" status and
 * actual_interface_tested/native_qualified evidence together, neither of which any
 * operation here has.
 */
export const claudeCodeConnectorProfileV1: ConnectorProfileV1 = connectorProfileSchemaV1.parse({
  schema: "control-room.connector-profile/v1",
  connectorId: "connector.claude-code.jsonl.v1",
  connectorVersion: "1.0.0",
  harness: "claude",
  harnessVersion: CLAUDE_CODE_PACKAGE_VERSION_V1,
  sourcePackage: {
    ecosystem: "npm",
    name: CLAUDE_CODE_PACKAGE_NAME_V1,
    version: CLAUDE_CODE_PACKAGE_VERSION_V1,
    integrity: CLAUDE_CODE_PACKAGE_INTEGRITY_V1,
  },
  transport: "jsonl_stdio",
  isolation: "adapter_process",
  credentialResolution: "harness_native",
  distribution: "invocation_only",
  operations: {
    submit: { status: "unsupported", evidence: "fixture_tested", reasonCode: "no_authenticated_round_trip_yet" },
    status: { status: "unsupported", evidence: "fixture_tested", reasonCode: "result_frame_shape_only" },
    result: { status: "unsupported", evidence: "fixture_tested", reasonCode: "result_frame_shape_only" },
    events: { status: "unsupported", evidence: "fixture_tested", reasonCode: "stream_json_envelope_only" },
    cancel: { status: "unsupported", evidence: "source_inspected", reasonCode: "interrupt_path_untested" },
    resume: { status: "unsupported", evidence: "fixture_tested", reasonCode: "resume_not_found_path_only" },
    read: { status: "unsupported", evidence: "source_inspected", reasonCode: "no_thread_read_equivalent_verified" },
    usage: { status: "unsupported", evidence: "fixture_tested", reasonCode: "zero_cost_usage_shape_only" },
    artifacts: { status: "unsupported", evidence: "source_inspected", reasonCode: "no_artifact_operation_observed" },
  },
  resultContract: { forms: ["utf8_text"], maximumBytes: 65_536, additionalAttachments: false },
});
