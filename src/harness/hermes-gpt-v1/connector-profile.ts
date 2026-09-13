import { connectorProfileSchemaV1, type ConnectorProfileV1 } from "../v1/connector-profile";

export const HERMES_GPT_SOURCE_REVISION_V1 = "89cbfbe232d62dfb8c3cb4f9af04c6c32f956e73" as const;

/**
 * Inert profile for the selected hermes-gpt FastMCP boundary. Source inspection
 * found the three named operations, but none has completed the required native
 * fit qualification, so the shared admission rule still refuses every call.
 */
export const hermesGptConnectorProfileV1: ConnectorProfileV1 = connectorProfileSchemaV1.parse({
  schema: "control-room.connector-profile/v1",
  connectorId: "connector.hermes-gpt.fastmcp.v1",
  connectorVersion: "1.0.0",
  harness: "hermes",
  harnessVersion: "0.10.0",
  sourceRevision: HERMES_GPT_SOURCE_REVISION_V1,
  transport: "fastmcp_tools",
  isolation: "harness_owned",
  credentialResolution: "harness_native",
  distribution: "invocation_only",
  operations: {
    submit: { status: "supported", evidence: "source_inspected", reasonCode: "hermes_session_continue_present" },
    status: { status: "supported", evidence: "source_inspected", reasonCode: "hermes_session_job_status_present" },
    result: { status: "supported", evidence: "source_inspected", reasonCode: "hermes_session_job_result_present" },
    events: { status: "unsupported", evidence: "source_inspected", reasonCode: "no_event_replay_interface" },
    cancel: { status: "unsupported", evidence: "source_inspected", reasonCode: "no_cancel_interface" },
    resume: { status: "unsupported", evidence: "source_inspected", reasonCode: "restart_can_orphan_running_job" },
    read: { status: "unsupported", evidence: "source_inspected", reasonCode: "use_bounded_result_operation" },
    usage: { status: "unsupported", evidence: "source_inspected", reasonCode: "no_per_job_usage_interface" },
    artifacts: { status: "unsupported", evidence: "source_inspected", reasonCode: "no_bounded_artifact_interface" },
  },
  resultContract: { forms: ["utf8_text"], maximumBytes: 65_536, additionalAttachments: false },
});
