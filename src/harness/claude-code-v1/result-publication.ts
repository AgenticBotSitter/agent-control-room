import { createHash } from "node:crypto";
import { z } from "zod";
import { digestSchema, localId } from "../v1/native-run-identifiers";
import { sha256Digest } from "../../security/canonical-digest";
import { publishDurableResultV1, type DurableResultBindingV1,
  type DurableResultPublicationConfigurationV1 } from "../../artifacts/v1/durable-result-publication";
import type { DurableResultReceiptV1 } from "../../artifacts/v1/durable-result-receipt";
import type { CompletionReviewTargetV1 } from "../../completion-gate/v1/types";
import { claudeCodeConnectorProfileV1 } from "./connector-profile";
import { CLAUDE_CODE_MAX_RESULT_BYTES_V1, CLAUDE_CODE_STREAM_FRAME_SCHEMA_V1,
  type ClaudeCodeResultFrameV1, type ClaudeCodeStreamDecoderStateV1 } from "./stream-json-decode";
import { CLAUDE_CODE_SESSION_DISPOSITION_SCHEMA_V1, type ClaudeCodeProcessBindingV1,
  type ClaudeCodeSessionDispositionV1 } from "./owned-process-session";

/**
 * The digest of the accepted Claude connector profile. The bridge uses this
 * one value as `connectorProfileDigest` and refuses any caller-supplied
 * digest that differs, so a caller cannot publish Claude-tagged evidence
 * under some other connector's admitted identity. The shared publisher then
 * verifies the same digest against the digest the run was actually admitted
 * with, which is the durable half of the same check.
 */
export const CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1: string = sha256Digest(claudeCodeConnectorProfileV1);

/**
 * Identity the trusted caller retained BEFORE this call and supplies here
 * whole. Every field is project authority: none of it may be read out of the
 * decoded terminal JSON, which carries only content and observed session
 * evidence. The harness tag and connector profile digest are deliberately
 * absent — this module supplies both from the accepted connector profile so
 * a caller cannot relabel the publication.
 */
export interface ClaudeRetainedPublicationBindingV1 {
  tenantId: string; projectId: string; jobId: string; attemptId: string; runId: string; nodeId: string;
  workflowId: string;
  acceptanceProfileId: string; acceptanceProfileDigest: string;
}

/**
 * The session identity the caller retained for this owned process, bound to
 * the exact `processAttemptId` it was observed on.
 *
 * This is an explicit bridge input, not a field the process disposition
 * exposes today: `ClaudeCodeSessionDispositionV1` carries no session ID and
 * no terminal-frame digest, and `OwnedClaudeCodeProcessSessionV1` exposes no
 * method that retains the validated init observation. The expected session ID
 * may originate from the validated `init` frame on that owned stream; it is
 * then retained by the caller and checked here against the independently
 * decoded terminal observation. Both sides of that comparison must never come
 * from the same terminal frame, and an upstream session ID is never project
 * authority on its own.
 */
export interface ClaudeRetainedSessionEvidenceV1 {
  processAttemptId: string;
  /** Retained expected session ID, bound to `processAttemptId`. */
  sessionId: string;
  /**
   * Independently observed canonical digest of the terminal frame, retained by
   * the caller. It is satisfied here only by re-deriving it from the exact raw
   * terminal material supplied as `terminalFrameRawLine`, never by trusting a
   * digest carried on a caller-supplied decoded frame object.
   */
  terminalFrameDigest: string;
}

export interface ClaudeTerminalResultPublicationInputV1 {
  /** Retained, trusted publication identity. Never derived from transport output. */
  retainedBinding: ClaudeRetainedPublicationBindingV1;
  /** The accepted process binding for the owned session that produced the evidence. */
  processBinding: ClaudeCodeProcessBindingV1;
  /** Retained session/evidence anchors for that same process attempt. */
  retainedSession: ClaudeRetainedSessionEvidenceV1;
  /** The owned session's own disposition. A disposition alone never grants publication. */
  disposition: ClaudeCodeSessionDispositionV1;
  /**
   * The EXACT raw terminal line the decoder was given — the same string that
   * produced `terminalFrame`. This, not the decoded frame object, is the
   * evidence this bridge binds published bytes to: its canonical digest is
   * recomputed here with the decoder's own digest function and must re-derive
   * the retained `terminalFrameDigest`. Every security-relevant field the
   * bridge acts on is then read back out of this verified material.
   */
  terminalFrameRawLine: string;
  /**
   * The independently decoded terminal frame and the decoder state that
   * produced it. The frame is a convenience input for the decoder's own
   * classification; it is never the evidence boundary, and it may not disagree
   * with the verified raw material about the bytes that get published.
   */
  terminalFrame: ClaudeCodeResultFrameV1;
  decoderState: ClaudeCodeStreamDecoderStateV1;
  /** The accepted connector profile digest recorded for this run at admission. */
  acceptedConnectorProfileDigest: string;
  receivedAt: string;
  /** The caller's synchronous authority fence. Preserved and passed through untouched. */
  assertAuthority: () => void;
}

export interface ClaudeTerminalResultPublicationV1 {
  readonly receipt: DurableResultReceiptV1;
  readonly target: CompletionReviewTargetV1;
  readonly replayed: boolean;
  /** This bridge approves, completes, releases and redispatches nothing. */
  readonly qualityAccepted: false;
  readonly releasesCapacity: false;
  readonly permitsRetry: false;
  readonly permitsRedispatch: false;
}

function unavailable(): never { throw new Error("claude_code_result_publication_unavailable"); }
function bindingMismatch(): never { throw new Error("claude_code_result_publication_binding_mismatch"); }
function sessionMismatch(): never { throw new Error("claude_code_result_publication_session_mismatch"); }
function profileMismatch(): never { throw new Error("claude_code_result_publication_connector_profile_mismatch"); }
function evidenceMismatch(): never { throw new Error("claude_code_result_publication_evidence_digest_mismatch"); }
function notTerminal(): never { throw new Error("claude_code_result_publication_session_not_terminal"); }
function unusableResult(): never { throw new Error("claude_code_result_publication_result_unusable"); }
function unusableMaterial(): never {
  throw new Error("claude_code_result_publication_terminal_material_unusable");
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Retained identity is captured field by field at entry and frozen, so a
 * caller that mutates its own object afterwards cannot change what was
 * verified or what is published. Only the fields this bridge supports are
 * copied; an unexpected extra field is refused rather than forwarded.
 */
const retainedBindingSchema = z.object({
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, runId: localId, nodeId: localId,
  workflowId: localId, acceptanceProfileId: localId, acceptanceProfileDigest: digestSchema,
}).strict();

const retainedSessionSchema = z.object({
  processAttemptId: localId,
  sessionId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  terminalFrameDigest: digestSchema,
}).strict();

const textDigest = (value: string): string =>
  `sha256:${createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex")}`;

/**
 * Bridges one accepted Claude terminal result into the EXISTING shared durable
 * publisher. It performs no execution, no acquisition, no retry, no
 * redispatch, no approval and no capacity release, and it opens no new table,
 * storage authority or result schema: every durable effect is the shared
 * `publishDurableResultV1` path, called once.
 *
 * The published bytes are bound to independently re-derivable evidence: the
 * caller supplies the exact raw terminal line, this function recomputes its
 * canonical digest with the decoder's own digest function, requires that to
 * equal the retained terminal-frame digest, and then reads the published text
 * out of that verified material rather than out of the decoded frame object.
 *
 * Identity is retained authority, supplied whole by the trusted caller. The
 * decoded terminal JSON may supply content and observed session evidence and
 * nothing else — never tenant, project, job, attempt, run, node, workflow or
 * acceptance-profile identity, and never a grant or key. Missing retained
 * authority, or session evidence that is failed, non-terminal or uncertain,
 * refuses publication; none of it is invented from transport output, and a
 * transport disposition on its own never grants publication.
 *
 * Exact publication retry over the same retained evidence re-enters the shared
 * publisher, which returns the existing durable receipt as a replay. This
 * bridge holds no state of its own, so a reconstructed instance over the same
 * database replays identically and starts no new process.
 */
export async function publishClaudeTerminalResultV1(
  config: DurableResultPublicationConfigurationV1,
  input: ClaudeTerminalResultPublicationInputV1,
): Promise<ClaudeTerminalResultPublicationV1> {
  if (!input || typeof input !== "object") unavailable();
  // The authority fence is retained authority too: without it there is
  // nothing to refuse against, so publication is refused outright rather
  // than proceeding with an assumed grant.
  if (typeof input.assertAuthority !== "function") unavailable();
  const assertAuthority = input.assertAuthority;
  assertAuthority();

  const retained = Object.freeze(retainedBindingSchema.parse(input.retainedBinding));
  const session = Object.freeze(retainedSessionSchema.parse(input.retainedSession));
  const processBinding = input.processBinding;
  const disposition = input.disposition;
  const frame = input.terminalFrame;
  const state = input.decoderState;
  if (!processBinding || typeof processBinding !== "object" || !disposition || typeof disposition !== "object"
    || !frame || typeof frame !== "object" || !state || typeof state !== "object") unavailable();
  if (typeof input.acceptedConnectorProfileDigest !== "string") unavailable();
  if (typeof input.receivedAt !== "string") unavailable();

  // The accepted connector profile is fixed by this module. A caller may only
  // confirm the digest it retained; it may not choose a different one.
  if (input.acceptedConnectorProfileDigest !== CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1) profileMismatch();

  // The disposition must describe the same owned process the retained session
  // is bound to, and the accepted process binding must describe the same run
  // and attempt the retained publication binding claims. A publication binding
  // that has drifted from the process that produced the evidence is refused
  // before any publisher work.
  if (disposition.schema !== CLAUDE_CODE_SESSION_DISPOSITION_SCHEMA_V1) unavailable();
  if (disposition.processAttemptId !== processBinding.processAttemptId
    || disposition.runId !== processBinding.runId
    || disposition.attemptId !== processBinding.attemptId) bindingMismatch();
  if (session.processAttemptId !== processBinding.processAttemptId) bindingMismatch();
  if (processBinding.runId !== retained.runId || processBinding.attemptId !== retained.attemptId) bindingMismatch();

  // A closed session with proven, certain cleanup and a caller-confirmed
  // terminal result is the only publishable shape. Open, uncertain, malformed
  // and unconfirmed sessions all refuse: none of them proves the result.
  if (disposition.closed !== true || disposition.cleanupUncertain !== false
    || disposition.exitObserved !== true || disposition.exitMalformed !== false
    || disposition.terminalResultConfirmed !== true) notTerminal();

  // The independent decode must itself be a clean, completed decode. A poisoned
  // or still-running decoder is uncertain evidence, not a terminal result.
  if (state.failed !== false || state.initObserved !== true || state.terminalObserved !== true) notTerminal();
  if (frame.schema !== CLAUDE_CODE_STREAM_FRAME_SCHEMA_V1 || frame.kind !== "result") unavailable();
  if (state.sessionId !== frame.sessionId) sessionMismatch();

  // Retained expected session versus the independently decoded terminal
  // observation. Both sides never come from the terminal frame.
  if (session.sessionId !== frame.sessionId) sessionMismatch();

  // ------------------------------------------------------------------
  // Evidence binding. The retained terminal-frame digest is satisfied only by
  // the exact raw terminal material, re-derived here.
  //
  // The decoded frame is a caller-supplied structural object: TypeScript
  // `readonly` and the decoder's own `Object.freeze` constrain nothing about a
  // separately constructed object, so `frame.frameDigest` proves nothing about
  // `frame.resultText`. The raw line does: the decoder computes its digest as
  // `sha256Digest(JSON.parse(line))`, and the same function over the same
  // material is recomputed here. Altering the published text necessarily
  // alters this recomputed digest, so it can no longer satisfy the retained
  // one.
  // ------------------------------------------------------------------
  const rawLine = input.terminalFrameRawLine;
  if (typeof rawLine !== "string" || rawLine.length === 0) unavailable();
  let material: unknown;
  try {
    material = JSON.parse(rawLine);
  } catch {
    unusableMaterial();
  }
  if (!plainObject(material)) unusableMaterial();
  let materialDigest: string;
  try {
    materialDigest = sha256Digest(material);
  } catch {
    unusableMaterial();
  }
  // THE security boundary: the retained digest against material the caller
  // cannot have altered without breaking the match.
  if (session.terminalFrameDigest !== materialDigest) evidenceMismatch();
  // Defence in depth only, and no longer load bearing on its own.
  if (session.terminalFrameDigest !== frame.frameDigest) evidenceMismatch();

  // Everything security relevant is now read back out of the VERIFIED
  // material, never out of the separately supplied frame object. Reading it
  // from the frame after checking a digest would reinstate the same gap one
  // level down.
  if (material.type !== "result") unusableMaterial();
  if (typeof material.session_id !== "string" || material.session_id !== session.sessionId) sessionMismatch();
  if (material.is_error !== false || material.terminal_reason !== undefined) notTerminal();

  // Outcome classification stays the decoder's: a failed, errored or
  // terminal-reason-bearing result publishes nothing.
  if (frame.outcome !== "succeeded" || frame.isError !== false
    || frame.terminalReasonPresent !== false) notTerminal();

  // Bounded text bytes, taken from the verified material. The ceiling is the
  // connector profile's existing result contract, re-checked here so an
  // oversized result is refused before any reservation exists; the shared
  // publisher enforces its own ceiling too.
  const resultText = material.result;
  if (typeof resultText !== "string" || resultText.length === 0) unusableResult();
  const bytes = new TextEncoder().encode(resultText);
  if (bytes.byteLength === 0 || bytes.byteLength > CLAUDE_CODE_MAX_RESULT_BYTES_V1) unusableResult();
  // The decoded frame may not contradict the verified material about the exact
  // bytes that are about to be published, nor about the content digest the
  // decoder reported for them.
  if (frame.resultText !== resultText || frame.resultBytes !== bytes.byteLength
    || frame.resultTextDigest !== textDigest(resultText)) unusableResult();

  const binding: DurableResultBindingV1 = {
    tenantId: retained.tenantId, projectId: retained.projectId, jobId: retained.jobId,
    attemptId: retained.attemptId, runId: retained.runId, nodeId: retained.nodeId,
    workflowId: retained.workflowId,
    // Both supplied from the accepted connector profile, never from the caller
    // and never from the decoded frame.
    harness: claudeCodeConnectorProfileV1.harness,
    connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
    // The retained digest, now proven to be the canonical digest of the exact
    // raw terminal material whose text is being published.
    terminalEvidenceDigest: session.terminalFrameDigest,
    acceptanceProfileId: retained.acceptanceProfileId,
    acceptanceProfileDigest: retained.acceptanceProfileDigest,
  };

  assertAuthority();
  // One call into the shared publisher. Its identity verification, reservation
  // lifecycle, byte readback, receipt and every assertAuthority fence are
  // preserved exactly; its errors are never swallowed or relabelled.
  const published = await publishDurableResultV1(config, {
    binding, bytes, receivedAt: input.receivedAt, assertAuthority,
  });

  return Object.freeze({
    receipt: published.receipt,
    target: published.target,
    replayed: published.replayed,
    qualityAccepted: false,
    releasesCapacity: false,
    permitsRetry: false,
    permitsRedispatch: false,
  });
}
