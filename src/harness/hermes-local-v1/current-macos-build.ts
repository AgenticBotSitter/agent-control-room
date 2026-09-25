import { z } from "zod";
import { connectorProfileSchemaV1, type ConnectorProfileV1 } from "../v1/connector-profile";
import { sha256Digest } from "../../security/canonical-digest";

/**
 * Exact, independently observed Hermes build installed on the owner's Mac on
 * 2026-09-24.  This is deliberately a new compatibility identity: it does
 * not relabel, broaden, or reuse the older Hermes 0.21 evidence.
 */
export const HERMES_MACOS_CURRENT_BUILD_V1 =
  "Hermes Agent v0.20.0+22959.gb50bb77 (2026.9.24) · upstream b50bb77e" as const;
export const HERMES_MACOS_CURRENT_VERSION_V1 = "0.20.0" as const;
/** Full revision read locally from Hermes's own checked-out source. */
export const HERMES_MACOS_CURRENT_SOURCE_REVISION_V1 =
  "b50bb77ec5cf44babadbd2aa8b6338bf505ef972" as const;

const versionLine = z.literal(HERMES_MACOS_CURRENT_BUILD_V1);

/**
 * Accept only the exact first line emitted by `hermes --version`.  A changed
 * patch build, source revision, or malformed value must be qualified again;
 * it is never an automatic fallback to the older 0.21 adapter.
 */
export function verifyCurrentMacosHermesBuildV1(value: unknown): typeof HERMES_MACOS_CURRENT_BUILD_V1 {
  if (typeof value !== "string") throw new Error("current_macos_hermes_build_unavailable");
  const firstLine = value.split(/\r?\n/u, 1)[0] ?? "";
  try { return versionLine.parse(firstLine); }
  catch { throw new Error("current_macos_hermes_build_unavailable"); }
}

/**
 * Public, inert capability description.  It states only the observed CLI
 * identity and text result boundary; a separately constructed fixed runner
 * still owns model choice, credentials, workspace, process lifetime and any
 * live delivery permission.
 */
export const currentMacosHermesConnectorProfileV1: ConnectorProfileV1 = connectorProfileSchemaV1.parse({
  schema: "control-room.connector-profile/v1",
  connectorId: "connector.hermes-current.macos-local.v1",
  connectorVersion: "1.0.0",
  harness: "hermes",
  harnessVersion: HERMES_MACOS_CURRENT_VERSION_V1,
  sourceRevision: HERMES_MACOS_CURRENT_SOURCE_REVISION_V1,
  transport: "jsonl_stdio",
  isolation: "harness_owned",
  credentialResolution: "harness_native",
  distribution: "invocation_only",
  operations: {
    submit: { status: "unknown", evidence: "source_inspected", reasonCode: "current_build_runner_qualification_pending" },
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

export const CURRENT_MACOS_HERMES_CONNECTOR_PROFILE_DIGEST_V1 =
  sha256Digest(currentMacosHermesConnectorProfileV1);
