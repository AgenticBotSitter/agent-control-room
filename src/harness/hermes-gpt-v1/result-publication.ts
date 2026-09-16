import { z } from "zod";
import {
  HERMES_SESSION_JOB_ID_PATTERN_V1,
  hermesSessionJobResultResponseSchemaV1,
  type HermesSessionJobResultResponseV1,
  type HermesSessionJobStateV1,
} from "./session-contract";
import {
  type HermesSessionResultOutcomeV1,
} from "./session-runtime";
export type { HermesSessionResultOutcomeV1 } from "./session-runtime";
import {
  projectUpstreamHermesSessionResultEvidenceV1,
  type UpstreamHermesSessionResultEvidenceV1,
} from "../v1/terminal-result-evidence";
import {
  publishDurableResultV1,
  type DurableResultBindingV1,
  type DurableResultPublicationConfigurationV1,
} from "../../artifacts/v1/durable-result-publication";
import type { DurableResultReceiptV1 } from "../../artifacts/v1/durable-result-receipt";
import type { CompletionReviewTargetV1 } from "../../completion-gate/v1/types";

/**
 * Synchronous current-authority fence the durable publisher invokes before
 * every reservation write, byte I/O, manifest insert, receipt insert and
 * audit append. If the fence throws, publication fails closed without
 * writing anything to the durable path.
 */
export type HermesResultPublicationAuthorityFenceV1 = () => void;

/**
 * Independently retained, already-authenticated upstream binding facts.
 *
 * These values must come from the caller's own record of the upstream
 * session it authenticated — NOT from the outcome being published. The
 * adapter compares the completed outcome against this binding before it
 * projects evidence or touches the durable publisher, and derives the
 * durable binding from these facts alone. A caller that supplies the
 * outcome's own values here proves nothing: a foreign, well-formed,
 * internally hashed outcome would remain self-consistent through
 * projection.
 */
export interface HermesRetainedUpstreamBindingV1 {
  /** Canonical lineage retained before the result was collected. */
  lineage: {
    tenantId: string;
    projectId: string;
    jobId: string;
    attemptId: string;
    runId: string;
    nodeId: string;
  };
  /** Upstream session id retained from the authenticated reply. */
  upstreamSessionId: string;
  /** Upstream job id retained from the authenticated reply. */
  upstreamJobId: string;
  /**
   * Digest of the connector profile the upstream adapter was loaded with
   * at the moment the result was collected. The durable publisher rejects
   * any value that does not match the recorded payload's connector
   * profile digest.
   */
  connectorProfileDigest: string;
}

export interface PublishHermesSessionResultInputV1 {
  /**
   * The completed outcome already produced by the upstream session runtime.
   * Any variant other than `kind: "completed"` is rejected up-front by the
   * adapter before the durable publisher is invoked.
   */
  outcome: HermesSessionResultOutcomeV1;
  /**
   * Independently retained authenticated upstream binding. Required, and
   * deliberately separate from `outcome`: the adapter compares the two and
   * derives the durable binding only from this side, so a foreign outcome
   * cannot validate against itself.
   */
  retainedBinding: HermesRetainedUpstreamBindingV1;
  /**
   * Canonical workflow id for the local run this upstream result belongs
   * to. The session binding carries the lineage; workflowId is the only
   * field the binding leaves out.
   */
  workflowId: string;
  /**
   * Synchronous current-authority fence. The durable publisher invokes it
   * before every durable effect. Throwing aborts the publication with no
   * side effects.
   */
  assertAuthority: HermesResultPublicationAuthorityFenceV1;
  /**
   * Caller-pinned receipt timestamp. Required: the publisher never
   * invents a wall-clock value, because that would silently break
   * replay-time determinism (a re-run must produce a byte-identical
   * receipt). The same value is bound into the projected evidence as
   * `observedAt`.
   */
  receivedAt: string;
  /**
   * Already-registered acceptance profile. The profile's id and digest
   * are persisted by the completion gate; the publisher does not
   * fabricate them per call. The completion gate's review inspectors
   * read the profile by id and verify the digest matches what the
   * publisher recorded, so a forged binding identity cannot survive.
   */
  acceptanceProfile: { id: string; digest: string };
}

/**
 * Result of a successful upstream Hermes session result publication.
 *
 * `receipt` is the durable, inert receipt the neutral publisher returns;
 * `target` is the pending owner-review target; `evidence` is the projected
 * terminal-result evidence whose digest was bound into the durable
 * reservation's identity; `replayed` is true iff this call was an exact
 * replay of a prior publication.
 */
export interface PublishHermesSessionResultOutputV1 {
  receipt: DurableResultReceiptV1;
  target: CompletionReviewTargetV1;
  evidence: UpstreamHermesSessionResultEvidenceV1;
  replayed: boolean;
}

/**
 * Hermes-specific adapter that converts one completed
 * `HermesSessionResultOutcomeV1` into independently verifiable, inert
 * terminal-result evidence and publishes it through the existing
 * harness-neutral `publishDurableResultV1` service.
 *
 * The adapter performs no I/O of its own. It does not call upstream, start
 * a process, retry, resume, cancel, or otherwise change the upstream
 * session. It does not create a new table, a new reservation system or an
 * alternate publisher. It binds the existing neutral publisher through
 * dependency injection of the `DurableResultPublicationConfigurationV1`.
 *
 * Exact replay returns the same durable receipt. Changed text or lineage
 * under the same durable identity fails closed. Storage/database uncertainty
 * is reported as uncertainty and never converted to completion or
 * permission to retry Hermes.
 */
export async function publishHermesSessionResultV1(
  config: DurableResultPublicationConfigurationV1,
  input: PublishHermesSessionResultInputV1,
): Promise<PublishHermesSessionResultOutputV1> {
  // Reject every non-completed outcome up-front. The durable publisher is
  // never reached for failed, uncertain, pending, unknown-job or invalid
  // outcomes; those go through their own refusal surfaces.
  if (input.outcome.kind !== "completed") {
    throw new Error("upstream_hermes_session_result_not_completed");
  }
  const completed = input.outcome;

  const retained = input.retainedBinding;

  // Validate the retained facts before trusting them: a malformed retained
  // binding is a caller error and must not be papered over as a mismatch.
  if (!/^sha256:[a-f0-9]{64}$/.test(retained.connectorProfileDigest)) {
    throw new Error("upstream_hermes_invalid_connector_profile_digest");
  }
  if (!HERMES_SESSION_JOB_ID_PATTERN_V1.test(retained.upstreamJobId)
    || !HERMES_SESSION_JOB_ID_PATTERN_V1.test(completed.upstreamJobId)) {
    throw new Error("upstream_hermes_invalid_upstream_job_id");
  }

  // Compare the completed outcome against the independently retained,
  // already-authenticated binding BEFORE projecting evidence or touching the
  // durable publisher. The trusted side is `retained`; the untrusted side is
  // the outcome. Because the two sides come from different sources, a
  // foreign but well-formed and internally hashed outcome cannot validate
  // against itself.
  const outcomeLineage = completed.binding.lineage;
  for (const field of ["tenantId", "projectId", "jobId", "attemptId", "runId", "nodeId"] as const) {
    if (outcomeLineage[field] !== retained.lineage[field]) {
      throw new Error("upstream_hermes_retained_lineage_mismatch");
    }
  }
  if (completed.upstreamJobId !== retained.upstreamJobId) {
    throw new Error("upstream_hermes_retained_upstream_job_id_mismatch");
  }
  if (completed.upstreamSessionId !== retained.upstreamSessionId) {
    throw new Error("upstream_hermes_retained_upstream_session_id_mismatch");
  }

  // Project the upstream outcome into inert terminal-result evidence. The
  // projection recomputes the contentHash and sizeBytes from the actual
  // `text` and compares them against the values the upstream runtime
  // recorded on the outcome; any disagreement fails closed with
  // `terminal_result_evidence_unavailable`. Lineage and the retained
  // identity/profile facts come from `retained`, never from the outcome, so
  // the projection's own identity guard is not defeated from here. The
  // caller's `receivedAt` is bound as `observedAt` so exact replays produce
  // identical evidence and receipt.
  const evidence = projectUpstreamHermesSessionResultEvidenceV1({
    lineage: retained.lineage,
    retained: {
      connectorProfileDigest: retained.connectorProfileDigest,
      upstreamSessionId: retained.upstreamSessionId,
      upstreamJobId: retained.upstreamJobId,
    },
    outcome: {
      success: true,
      job_id: completed.upstreamJobId,
      session_id: completed.upstreamSessionId,
      status: "completed",
      return_code: completed.returnCode,
      response: completed.text,
      truncated: completed.upstreamTruncated,
    },
    upstreamCeilingTruncated: completed.ceilingTruncated,
    observedAt: input.receivedAt,
    claimedContentHash: completed.contentHash,
    claimedSizeBytes: completed.sizeBytes,
  });

  // The durable binding is the harness-neutral contract, derived ONLY from
  // the independently retained facts — never from the outcome under
  // publication. The upstream identity is encoded in the evidence source;
  // the harness tag identifies the connector family without impersonating
  // the native or codex harnesses. The acceptance profile id and digest come
  // from a profile the caller has already registered with the completion
  // gate, not from a digest the publisher invents per call.
  const binding: DurableResultBindingV1 = {
    tenantId: retained.lineage.tenantId,
    projectId: retained.lineage.projectId,
    jobId: retained.lineage.jobId,
    attemptId: retained.lineage.attemptId,
    runId: retained.lineage.runId,
    nodeId: retained.lineage.nodeId,
    workflowId: input.workflowId,
    harness: "upstream-hermes",
    connectorProfileDigest: retained.connectorProfileDigest,
    acceptanceProfileId: input.acceptanceProfile.id,
    acceptanceProfileDigest: input.acceptanceProfile.digest,
  };

  const result = await publishDurableResultV1(config, {
    binding,
    bytes: new TextEncoder().encode(completed.text),
    receivedAt: input.receivedAt,
    assertAuthority: input.assertAuthority,
  });

  return { receipt: result.receipt, target: result.target, evidence, replayed: result.replayed };
}

/**
 * Helper for callers that want to verify the upstream reply shape before
 * handing it to the adapter. Mirrors the success side of
 * `hermesSessionJobResultResponseSchemaV1` and rejects every other outcome
 * (refusal envelopes, unrecognized replies, non-completed terminal states).
 *
 * The adapter itself does not consume this schema; it accepts the higher
 * `HermesSessionResultOutcomeV1` discriminated union produced by the
 * session runtime. This helper is for the seam where a transport reply
 * still needs to be classified before the outcome is constructed.
 */
export function parseHermesSessionJobResultReplyV1(value: unknown):
  HermesSessionJobResultResponseV1 | undefined {
  const parsed = hermesSessionJobResultResponseSchemaV1.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Re-export the upstream terminal-state set for callers that want to
 * classify the runtime outcome before calling the adapter.
 */
export const UPSTREAM_HERMES_TERMINAL_STATES_V1 = [
  "completed", "failed", "timed_out", "orphaned",
] as const satisfies readonly HermesSessionJobStateV1[];
