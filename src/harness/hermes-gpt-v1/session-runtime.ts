import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import {
  connectorOperationNamesV1, type ConnectorOperationNameV1,
} from "../v1/connector-profile";
import { hermesGptConnectorProfileV1 } from "./connector-profile";
import {
  HERMES_SESSION_MAX_RESULT_CHARS_V1, hermesSessionJobIsTerminalV1,
  type HermesSessionJobStateV1, type HermesSessionJobV1,
} from "./session-contract";
import {
  hermesSessionContinueV1, hermesSessionJobResultV1, hermesSessionJobStatusV1,
  type HermesSessionCallV1, type HermesSessionToolPortV1,
} from "./session-client";

/**
 * Maps one Control Room task to the supported upstream Hermes session tools.
 *
 * Every outcome here is inert. Nothing in this module accepts a result,
 * records completion, releases capacity, grants execution authority or permits
 * a retry — those remain the ordinary Control Room services' decisions. The
 * runtime's whole job is to carry exact identity across the boundary and to
 * describe honestly what upstream actually reported.
 *
 * Three upstream behaviors drive the design:
 *
 * - Upstream refuses a second concurrent turn for the same session with
 *   `SESSION_BUSY`. That refusal, not a local guess, is what prevents a lost
 *   submit from becoming duplicate execution.
 * - Upstream marks a job `orphaned` after a restart when process ownership
 *   could not be proven. That is uncertainty, never failure and never
 *   completion.
 * - Upstream truncates output at 24,000 characters and reports `truncated`.
 *   Control Room's ceiling is 65,536 *bytes*, so a multi-byte response can
 *   exceed the byte ceiling while satisfying the character cap. Both bounds
 *   are enforced and both truncation causes are reported separately.
 */

export const HERMES_SESSION_OUTCOME_SCHEMA_V1 = "control-room.hermes-session-outcome/v1" as const;

/** Control Room's bounded result ceiling, in bytes. */
export const HERMES_SESSION_RESULT_MAX_BYTES_V1 = 65_536 as const;

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

/** Exact Control Room identity this turn belongs to. */
export const hermesSessionLineageSchemaV1 = z.object({
  tenantId: id, projectId: id, jobId: id, attemptId: id, runId: id, nodeId: id,
}).strict();
export type HermesSessionLineageV1 = z.infer<typeof hermesSessionLineageSchemaV1>;

/** The upstream identity a turn was actually started against. */
export const hermesSessionBindingSchemaV1 = z.object({
  lineage: hermesSessionLineageSchemaV1,
  sessionId: z.string().min(1).max(256),
}).strict();
export type HermesSessionBindingV1 = z.infer<typeof hermesSessionBindingSchemaV1>;

export type HermesSessionSubmitOutcomeV1 =
  | { readonly kind: "started"; readonly upstreamJobId: string; readonly sessionId: string }
  /** Upstream already has a running turn for this session; do not start another. */
  | { readonly kind: "busy"; readonly detail: string }
  /** Upstream declined for a named reason; the turn did not start. */
  | { readonly kind: "refused"; readonly code: string; readonly detail: string }
  /** The request never reached a decision. Whether a turn started is unknown. */
  | { readonly kind: "uncertain"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

export type HermesSessionProgressV1 =
  | { readonly kind: "running"; readonly state: HermesSessionJobStateV1; readonly job: HermesSessionJobV1 }
  | { readonly kind: "terminal"; readonly state: HermesSessionJobStateV1; readonly job: HermesSessionJobV1 }
  | { readonly kind: "unknown_job"; readonly detail: string }
  | { readonly kind: "uncertain"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

export type HermesSessionResultOutcomeV1 =
  | {
    readonly kind: "completed";
    readonly schema: typeof HERMES_SESSION_OUTCOME_SCHEMA_V1;
    readonly binding: HermesSessionBindingV1;
    readonly upstreamJobId: string;
    readonly text: string;
    readonly contentHash: string;
    readonly sizeBytes: number;
    /** Upstream applied its own 24,000-character cap. */
    readonly upstreamTruncated: boolean;
    /** This connector additionally trimmed to Control Room's byte ceiling. */
    readonly ceilingTruncated: boolean;
    readonly returnCode: number | null;
    readonly canonicalPublicationAllowed: false;
    readonly qualityAccepted: false;
    readonly completionRecorded: false;
    readonly grantsExecutionAuthority: false;
    readonly permitsRetry: false;
    readonly permitsResume: false;
  }
  /** Upstream finished without success. Not retryable by this connector. */
  | { readonly kind: "failed"; readonly state: HermesSessionJobStateV1; readonly returnCode: number | null }
  /** Upstream stopped but cannot prove what happened. Never a completion. */
  | { readonly kind: "uncertain"; readonly state: HermesSessionJobStateV1 | "unknown"; readonly reason: string }
  | { readonly kind: "pending"; readonly state: HermesSessionJobStateV1 }
  | { readonly kind: "unknown_job"; readonly detail: string }
  | { readonly kind: "invalid"; readonly reason: string };

function refusalDetail(code: string, safeMessage: string): string {
  // The upstream envelope is already redacted; keep it bounded anyway.
  return `${code}: ${safeMessage}`.slice(0, 500);
}

/** Collapses the client's non-reply outcomes, which every operation shares. */
function carry<T>(call: HermesSessionCallV1<T>):
{ ok: true; value: T } | { ok: false; outcome: { kind: "uncertain"; reason: string } | { kind: "invalid"; reason: string }
  | { kind: "refused"; code: string; detail: string } } {
  if (call.outcome === "ok") return { ok: true, value: call.value };
  if (call.outcome === "invalid_request") return { ok: false, outcome: { kind: "invalid", reason: call.reason } };
  if (call.outcome === "transport_unavailable") return { ok: false, outcome: { kind: "uncertain", reason: call.reason } };
  if (call.outcome === "unrecognized") return { ok: false, outcome: { kind: "uncertain", reason: call.reason } };
  return { ok: false, outcome: { kind: "refused", code: call.code, detail: refusalDetail(call.code, call.envelope.safe_message) } };
}

/**
 * Starts one turn for the supplied Control Room identity.
 *
 * A `busy` outcome is deliberately distinct from a refusal: it means upstream
 * is protecting an already-running turn, so the correct response is to
 * reconcile that turn rather than to report a failure or start another.
 */
export async function submitHermesSessionTurnV1(port: HermesSessionToolPortV1, request: {
  binding: HermesSessionBindingV1; prompt: string; timeoutSeconds?: number;
}, signal?: AbortSignal): Promise<HermesSessionSubmitOutcomeV1> {
  const parsed = hermesSessionBindingSchemaV1.safeParse(request?.binding);
  if (!parsed.success) return { kind: "invalid", reason: "hermes_session_binding_invalid" };
  const call = await hermesSessionContinueV1(port,
    { sessionId: parsed.data.sessionId, prompt: request.prompt, timeoutSeconds: request.timeoutSeconds }, signal);
  const carried = carry(call);
  if (!carried.ok) {
    if (carried.outcome.kind === "refused") {
      return carried.outcome.code === "SESSION_BUSY"
        ? { kind: "busy", detail: carried.outcome.detail }
        : { kind: "refused", code: carried.outcome.code, detail: carried.outcome.detail };
    }
    return carried.outcome;
  }
  // Upstream must have started the turn on the session we named. A mismatch is
  // a foreign identity, not a usable job.
  if (carried.value.session_id !== parsed.data.sessionId.trim()) {
    return { kind: "uncertain", reason: "hermes_session_identity_mismatch" };
  }
  return { kind: "started", upstreamJobId: carried.value.job_id, sessionId: carried.value.session_id };
}

/** Reads one job's current state. Starts nothing and is safe to repeat. */
export async function pollHermesSessionJobV1(port: HermesSessionToolPortV1, jobId: string,
  signal?: AbortSignal): Promise<HermesSessionProgressV1> {
  const call = await hermesSessionJobStatusV1(port, jobId, signal);
  const carried = carry(call);
  if (!carried.ok) {
    return carried.outcome.kind === "refused"
      ? (carried.outcome.code === "JOB_NOT_FOUND"
        ? { kind: "unknown_job", detail: carried.outcome.detail }
        : { kind: "uncertain", reason: carried.outcome.code })
      : carried.outcome;
  }
  const job = carried.value.job;
  if (job.job_id !== jobId) return { kind: "uncertain", reason: "hermes_session_job_identity_mismatch" };
  return hermesSessionJobIsTerminalV1(job.status)
    ? { kind: "terminal", state: job.status, job }
    : { kind: "running", state: job.status, job };
}

/** Trims to the byte ceiling without splitting a UTF-8 sequence. */
function boundedUtf8(text: string, maximumBytes: number): { text: string; bytes: number; trimmed: boolean } {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maximumBytes) return { text, bytes: encoded.byteLength, trimmed: false };
  let end = maximumBytes;
  // Step back off a continuation byte so the result stays valid UTF-8.
  while (end > 0 && (encoded[end] & 0b1100_0000) === 0b1000_0000) end--;
  const slice = encoded.subarray(0, end);
  return { text: slice.toString("utf8"), bytes: slice.byteLength, trimmed: true };
}

/**
 * Reads one finished turn's bounded output and binds it to Control Room identity.
 *
 * A job that upstream has not finished returns `pending`; `timed_out` and
 * `orphaned` return `uncertain`, never a result. An empty response from a
 * successful job is also uncertainty rather than an empty accepted result: an
 * absent output cannot be presented as a completed one.
 */
export async function collectHermesSessionResultV1(port: HermesSessionToolPortV1, request: {
  binding: HermesSessionBindingV1; upstreamJobId: string; maxChars?: number;
}, signal?: AbortSignal): Promise<HermesSessionResultOutcomeV1> {
  const parsed = hermesSessionBindingSchemaV1.safeParse(request?.binding);
  if (!parsed.success) return { kind: "invalid", reason: "hermes_session_binding_invalid" };
  const call = await hermesSessionJobResultV1(port, request.upstreamJobId,
    { maxChars: request.maxChars ?? HERMES_SESSION_MAX_RESULT_CHARS_V1 }, signal);
  const carried = carry(call);
  if (!carried.ok) {
    return carried.outcome.kind === "refused"
      ? (carried.outcome.code === "JOB_NOT_FOUND"
        ? { kind: "unknown_job", detail: carried.outcome.detail }
        : { kind: "uncertain", state: "unknown", reason: carried.outcome.code })
      : (carried.outcome.kind === "invalid"
        ? { kind: "invalid", reason: carried.outcome.reason }
        : { kind: "uncertain", state: "unknown", reason: carried.outcome.reason });
  }
  const value = carried.value;
  if (value.job_id !== request.upstreamJobId
    || (value.session_id !== null && value.session_id !== parsed.data.sessionId.trim())) {
    return { kind: "uncertain", state: "unknown", reason: "hermes_session_result_identity_mismatch" };
  }
  if (!hermesSessionJobIsTerminalV1(value.status)) return { kind: "pending", state: value.status };
  if (value.status === "timed_out" || value.status === "orphaned") {
    return { kind: "uncertain", state: value.status,
      reason: value.status === "orphaned" ? "hermes_session_process_ownership_unproven" : "hermes_session_upstream_deadline" };
  }
  if (value.status === "failed") return { kind: "failed", state: value.status, returnCode: value.return_code ?? null };
  if (value.response.length === 0) {
    return { kind: "uncertain", state: value.status, reason: "hermes_session_empty_response" };
  }
  const bounded = boundedUtf8(value.response, HERMES_SESSION_RESULT_MAX_BYTES_V1);
  return Object.freeze({
    kind: "completed" as const,
    schema: HERMES_SESSION_OUTCOME_SCHEMA_V1,
    binding: parsed.data,
    upstreamJobId: value.job_id,
    text: bounded.text,
    contentHash: sha256Digest(bounded.text),
    sizeBytes: bounded.bytes,
    upstreamTruncated: value.truncated,
    ceilingTruncated: bounded.trimmed,
    returnCode: value.return_code ?? null,
    canonicalPublicationAllowed: false,
    qualityAccepted: false,
    completionRecorded: false,
    grantsExecutionAuthority: false,
    permitsRetry: false,
    permitsResume: false,
  });
}

/**
 * Operations this connector does not implement, with the upstream reason.
 *
 * The profile already records these as unsupported; this is the runtime
 * refusal a caller hits, so an unsupported operation fails closed with a named
 * cause instead of silently doing nothing.
 */
export function hermesSessionUnsupportedOperationV1(operation: ConnectorOperationNameV1):
{ readonly supported: boolean; readonly reasonCode: string } {
  if (!(connectorOperationNamesV1 as readonly string[]).includes(operation)) {
    return { supported: false, reasonCode: "unknown_operation" };
  }
  const declared = hermesGptConnectorProfileV1.operations[operation];
  return { supported: declared.status === "supported", reasonCode: declared.reasonCode };
}
