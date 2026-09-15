import { connectorProfileSchemaV1, type ConnectorProfileV1 } from "../v1/connector-profile";

export const HERMES_GPT_SOURCE_REVISION_V1 = "89cbfbe232d62dfb8c3cb4f9af04c6c32f956e73" as const;

/**
 * Inert profile for the selected hermes-gpt FastMCP boundary.
 *
 * The three named operations are now exercised by recorded-transport fixtures
 * built from the pinned upstream `operator_session.py`, so their evidence is
 * `fixture_tested` rather than `source_inspected`. That is still below the
 * admission bar: `connectorOperationAdmissibleV1` requires
 * `actual_interface_tested` or `native_qualified`, so the shared admission
 * rule continues to refuse every call until a separately authorized live
 * qualification runs against a real Hermes installation.
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
    submit: { status: "supported", evidence: "fixture_tested", reasonCode: "hermes_session_continue_present" },
    status: { status: "supported", evidence: "fixture_tested", reasonCode: "hermes_session_job_status_present" },
    result: { status: "supported", evidence: "fixture_tested", reasonCode: "hermes_session_job_result_present" },
    events: { status: "unsupported", evidence: "source_inspected", reasonCode: "no_event_replay_interface" },
    cancel: { status: "unsupported", evidence: "source_inspected", reasonCode: "no_cancel_interface" },
    resume: { status: "unsupported", evidence: "source_inspected", reasonCode: "restart_can_orphan_running_job" },
    read: { status: "unsupported", evidence: "source_inspected", reasonCode: "use_bounded_result_operation" },
    usage: { status: "unsupported", evidence: "source_inspected", reasonCode: "no_per_job_usage_interface" },
    artifacts: { status: "unsupported", evidence: "source_inspected", reasonCode: "no_bounded_artifact_interface" },
  },
  resultContract: { forms: ["utf8_text"], maximumBytes: 65_536, additionalAttachments: false },
});
