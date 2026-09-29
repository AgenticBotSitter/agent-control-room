import { z } from "zod";
import { connectorProfileSchemaV1, type ConnectorProfileV1 } from "../v1/connector-profile";
import { sha256Digest } from "../../security/canonical-digest";

const fullRevision = z.string().regex(/^[a-f0-9]{40}$/u);
const release = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u);
const versionLine = /^Hermes Agent v([^\s]+) \([^\r\n)]+\) · upstream ([a-f0-9]{7,40})$/u;

export type CurrentMacosHermesBuildV1 = Readonly<{
  /** Exact first line emitted by the installed Hermes executable. */
  versionLine: string;
  /** Parsed release identifier, such as 0.20.0. */
  version: string;
  /** Full Git source revision read from Hermes's own checked-out source. */
  sourceRevision: string;
  buildDigest: string;
}>;

function unavailable(): never { throw new Error("current_macos_hermes_build_unavailable"); }

/**
 * Captures a particular installed Hermes build without treating any one
 * version as the only supported version. The abbreviated source ID emitted by
 * Hermes must match the supplied full local Git revision; neither value is
 * guessed or accepted from a task payload.
 *
 * An update creates a different captured build record. The installer can then
 * run the ordinary text-only qualification again before enabling that record.
 * This keeps normal updates usable while preventing an untested new command
 * shape from silently inheriting old qualification evidence.
 */
export function captureCurrentMacosHermesBuildV1(value: unknown): CurrentMacosHermesBuildV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || typeof input.versionOutput !== "string") unavailable();
  const versionOutput = input.versionOutput;
  const sourceRevision = fullRevision.safeParse(input.sourceRevision);
  if (!sourceRevision.success) unavailable();
  const firstLine = versionOutput.split(/\r?\n/u, 1)[0] ?? "";
  const match = versionLine.exec(firstLine);
  const version = match?.[1];
  const abbreviatedSource = match?.[2];
  if (!version || !release.safeParse(version).success || !abbreviatedSource
    || !sourceRevision.data.startsWith(abbreviatedSource)) unavailable();
  const material = Object.freeze({ versionLine: firstLine, version, sourceRevision: sourceRevision.data });
  return Object.freeze({ ...material, buildDigest: sha256Digest({ purpose: "current-macos-hermes-build/v1", build: material }) });
}

/**
 * Creates inert connector metadata from a captured installed build. The
 * connector identifier stays stable across normal upgrades; the source
 * revision and resulting profile digest change, which deliberately requires
 * a fresh qualification before delivery can be enabled.
 */
export function createCurrentMacosHermesConnectorProfileV1(value: unknown): ConnectorProfileV1 {
  const build = captureCurrentMacosHermesBuildV1(value);
  return connectorProfileSchemaV1.parse({
    schema: "control-room.connector-profile/v1",
    connectorId: "connector.hermes.macos-local.v1",
    connectorVersion: "1.0.0",
    harness: "hermes",
    harnessVersion: build.version,
    sourceRevision: build.sourceRevision,
    transport: "jsonl_stdio",
    isolation: "harness_owned",
    credentialResolution: "harness_native",
    distribution: "invocation_only",
    operations: {
      submit: { status: "unknown", evidence: "source_inspected", reasonCode: "installed_build_qualification_pending" },
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
}
