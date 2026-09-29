import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { publishDurableResultV1, type DurableResultBindingV1,
  type DurableResultPublicationConfigurationV1 } from "../../artifacts/v1/durable-result-publication";
import { resultBytesHash } from "../../artifacts/v1/native-results";
import type { DurableResultReceiptV1 } from "../../artifacts/v1/durable-result-receipt";
import type { CompletionReviewTargetV1 } from "../../completion-gate/v1/types";
import { digestSchema, localId } from "../v1/native-run-identifiers";
import { projectHermes021MacosTerminalResultEvidenceV1,
  type Hermes021MacosTerminalResultEvidenceV1 } from "../v1/terminal-result-evidence";
import { HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1 } from "./connector-profile";
import { hermes021MacosTerminalResultSchemaV1, type Hermes021MacosTaskOutcomeV1 } from "./macos-local-worker";

const retainedBindingSchema = z.object({
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, runId: localId, nodeId: localId,
  workflowId: localId, authorityDigest: digestSchema, acceptanceProfileId: localId, acceptanceProfileDigest: digestSchema,
}).strict();
const retainedTerminalSchema = z.object({
  sessionId: z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  terminalResultDigest: digestSchema,
}).strict();

export interface Hermes021MacosRetainedPublicationBindingV1 {
  tenantId: string; projectId: string; jobId: string; attemptId: string; runId: string; nodeId: string;
  workflowId: string; authorityDigest: string; acceptanceProfileId: string; acceptanceProfileDigest: string;
}
export interface Hermes021MacosRetainedTerminalEvidenceV1 { sessionId: string; terminalResultDigest: string; }
export interface Hermes021MacosTerminalResultPublicationInputV1 {
  retainedBinding: Hermes021MacosRetainedPublicationBindingV1;
  retainedTerminal: Hermes021MacosRetainedTerminalEvidenceV1;
  /** Exact terminal JSON line, never a decoded caller-supplied result object. */
  terminalResultRawLine: string;
  /** Digest recorded when this run was admitted. The caller cannot choose a connector label. */
  acceptedConnectorProfileDigest: string;
  receivedAt: string;
  assertAuthority: () => void;
}
export interface Hermes021MacosTerminalResultPublicationV1 {
  receipt: DurableResultReceiptV1; target: CompletionReviewTargetV1;
  evidence: Hermes021MacosTerminalResultEvidenceV1; replayed: boolean;
  qualityAccepted: false; releasesCapacity: false; permitsRetry: false; permitsRedispatch: false;
}
function unavailable(): never { throw new Error("hermes_021_macos_result_publication_unavailable"); }
function profileMismatch(): never { throw new Error("hermes_021_macos_result_publication_connector_profile_mismatch"); }

/**
 * Sends one already-finished, verified Mac-local Hermes result through the
 * existing durable-result publisher. It starts no Hermes process and grants
 * no approval, retry, redispatch, or capacity release. Identity comes only
 * from the retained controller record; text comes only from the exact raw
 * terminal line after its independently retained digest has been rechecked.
 */
export async function publishHermes021MacosTerminalResultV1(
  config: DurableResultPublicationConfigurationV1,
  input: Hermes021MacosTerminalResultPublicationInputV1,
): Promise<Hermes021MacosTerminalResultPublicationV1> {
  if (!input || typeof input !== "object" || typeof input.assertAuthority !== "function"
    || typeof input.terminalResultRawLine !== "string" || typeof input.receivedAt !== "string") unavailable();
  const retained = Object.freeze(retainedBindingSchema.parse(input.retainedBinding));
  const terminal = Object.freeze(retainedTerminalSchema.parse(input.retainedTerminal));
  if (input.acceptedConnectorProfileDigest !== HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1) profileMismatch();
  input.assertAuthority();
  const evidence = projectHermes021MacosTerminalResultEvidenceV1({
    lineage: { tenantId: retained.tenantId, projectId: retained.projectId, jobId: retained.jobId,
      attemptId: retained.attemptId, runId: retained.runId, nodeId: retained.nodeId },
    retained: { ...terminal, connectorProfileDigest: HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1 },
    terminalResultRawLine: input.terminalResultRawLine, observedAt: input.receivedAt,
  });
  let raw: unknown;
  try { raw = JSON.parse(input.terminalResultRawLine); } catch { return unavailable(); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) unavailable();
  const material = raw as Record<string, unknown>;
  // Read result bytes only from material whose digest and fields the evidence
  // projector just re-derived; never from a decoded result passed by a caller.
  if (sha256Digest(material) !== terminal.terminalResultDigest || material.session_id !== terminal.sessionId
    || typeof material.text !== "string") unavailable();
  const bytes = new TextEncoder().encode(material.text);
  if (bytes.byteLength !== evidence.content.sizeBytes || resultBytesHash(bytes) !== evidence.content.contentHash) unavailable();
  const binding: DurableResultBindingV1 = {
    ...retained, harness: "hermes", connectorProfileDigest: HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1,
    terminalEvidenceDigest: evidence.evidenceDigest,
  };
  const published = await publishDurableResultV1(config, {
    binding, bytes, receivedAt: input.receivedAt, assertAuthority: input.assertAuthority,
  });
  return Object.freeze({ ...published, evidence, qualityAccepted: false, releasesCapacity: false,
    permitsRetry: false, permitsRedispatch: false });
}

/**
 * Publishes a completed record returned by the controlled local runner. This
 * is intentionally a separate entry point from arbitrary terminal text: the
 * terminal record is schema-checked and its retained digest must agree before
 * the existing durable publisher is reached.
 */
export async function publishCompletedHermes021MacosOutcomeV1(
  config: DurableResultPublicationConfigurationV1,
  input: Omit<Hermes021MacosTerminalResultPublicationInputV1, "retainedTerminal" | "terminalResultRawLine"> & {
    outcome: Hermes021MacosTaskOutcomeV1;
  },
): Promise<Hermes021MacosTerminalResultPublicationV1> {
  if (!input || input.outcome?.kind !== "completed") unavailable();
  const record = hermes021MacosTerminalResultSchemaV1.parse(input.outcome.terminalResult);
  if (input.outcome.sessionId !== record.session_id || input.outcome.terminalResultDigest !== sha256Digest(record)) unavailable();
  return publishHermes021MacosTerminalResultV1(config, {
    ...input,
    retainedTerminal: { sessionId: record.session_id, terminalResultDigest: input.outcome.terminalResultDigest },
    terminalResultRawLine: JSON.stringify(record),
  });
}
