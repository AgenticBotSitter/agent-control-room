import { connectorProfileSchemaV1, type ConnectorProfileV1 } from "../v1/connector-profile";

/** Exact local Hermes revision observed on the Mac during integration. */
export const HERMES_021_SOURCE_REVISION_V1 = "00570550f37e9082676955d50f65c7d9ba846cc9" as const;
export const HERMES_021_VERSION_V1 = "0.21.3" as const;

/**
 * Public, inert description of the current Hermes CLI's JSON-lines result
 * format. It contains no executable path, login, selected model, provider,
 * workspace, or other Mac-specific details.
 *
 * The command-line shape was observed locally, but that is deliberately not
 * treated as permission to start work. A separate owner-approved qualification
 * must prove one restricted task and its terminal report before `submit` can
 * become admissible.
 */
export const hermes021MacosLocalConnectorProfileV1: ConnectorProfileV1 = connectorProfileSchemaV1.parse({
  schema: "control-room.connector-profile/v1",
  connectorId: "connector.hermes-021.macos-local.v1",
  connectorVersion: "1.0.0",
  harness: "hermes",
  harnessVersion: HERMES_021_VERSION_V1,
  sourceRevision: HERMES_021_SOURCE_REVISION_V1,
  transport: "jsonl_stdio",
  isolation: "harness_owned",
  credentialResolution: "harness_native",
  distribution: "invocation_only",
  operations: {
    submit: { status: "unknown", evidence: "source_inspected", reasonCode: "restricted_live_qualification_pending" },
    status: { status: "unsupported", evidence: "source_inspected", reasonCode: "no_safe_per_task_status_read_proven" },
    result: { status: "supported", evidence: "fixture_tested", reasonCode: "stream_json_terminal_result_parser" },
    events: { status: "unsupported", evidence: "source_inspected", reasonCode: "no_replayable_event_cursor_proven" },
    cancel: { status: "unsupported", evidence: "source_inspected", reasonCode: "interrupt_path_not_qualified" },
    resume: { status: "unsupported", evidence: "source_inspected", reasonCode: "resume_identity_not_qualified" },
    read: { status: "unsupported", evidence: "source_inspected", reasonCode: "no_task_read_equivalent_proven" },
    usage: { status: "supported", evidence: "fixture_tested", reasonCode: "terminal_token_counts_parser" },
    artifacts: { status: "unsupported", evidence: "source_inspected", reasonCode: "artifact_return_not_qualified" },
  },
  resultContract: { forms: ["utf8_text"], maximumBytes: 65_536, additionalAttachments: false },
});
