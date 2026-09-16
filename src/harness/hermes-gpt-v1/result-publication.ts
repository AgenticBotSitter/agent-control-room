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

export interface PublishHermesSessionResultInputV1 {
  /**
   * The completed outcome already produced by the upstream session runtime.
   * Any variant other than `kind: "completed"` is rejected up-front by the
   * adapter before the durable publisher is invoked.
   */
  outcome: HermesSessionResultOutcomeV1;
  /**
   * Already-authenticated connector profile digest. The caller supplies the
   * digest of the connector profile the upstream adapter was loaded with at
   * the moment the result was collected; the durable publisher will reject
   * any value that does not match the recorded payload's connector profile
   * digest.
   */
  connectorProfileDigest: string;
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

  // Reject obviously bad inputs before projection: digest shape, profile
  // digest shape, upstream job id pattern.
  if (!/^sha256:[a-f0-9]{64}$/.test(input.connectorProfileDigest)) {
    throw new Error("upstream_hermes_invalid_connector_profile_digest");
  }
  if (!HERMES_SESSION_JOB_ID_PATTERN_V1.test(completed.upstreamJobId)) {
    throw new Error("upstream_hermes_invalid_upstream_job_id");
  }

  // Project the upstream outcome into inert terminal-result evidence. The
  // projection recomputes the contentHash and sizeBytes from the actual
  // `text` and compares them against the values the upstream runtime
  // recorded on the outcome; any disagreement fails closed with
  // `terminal_result_evidence_unavailable`. The connector profile digest
  // is part of the retained binding facts so a forged value in the
  // durable binding cannot survive projection-time reconciliation. The
  // caller's `receivedAt` is bound as `observedAt` so exact replays
  // produce identical evidence and receipt.
  const evidence = projectUpstreamHermesSessionResultEvidenceV1({
    lineage: completed.binding.lineage,
    retained: {
      connectorProfileDigest: input.connectorProfileDigest,
      upstreamSessionId: completed.upstreamSessionId,
      upstreamJobId: completed.upstreamJobId,
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

  // The durable binding is the harness-neutral contract. The publisher
  // records the connector profile digest; the upstream identity is encoded
  // in the evidence source; the harness tag identifies the connector family
  // without impersonating the native or codex harnesses. The acceptance
  // profile id and digest come from a profile the caller has already
  // registered with the completion gate, not from a digest the publisher
  // invents per call.
  const binding: DurableResultBindingV1 = {
    tenantId: completed.binding.lineage.tenantId,
    projectId: completed.binding.lineage.projectId,
    jobId: completed.binding.lineage.jobId,
    attemptId: completed.binding.lineage.attemptId,
    runId: completed.binding.lineage.runId,
    nodeId: completed.binding.lineage.nodeId,
    workflowId: input.workflowId,
    harness: "upstream-hermes",
    connectorProfileDigest: input.connectorProfileDigest,
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
