/** Versioned acceptance-record surface for the first release candidate (issue #61).
 *
 * The exact-candidate precheck in `./types.ts` proves a candidate-reference
 * record is complete and internally consistent. This surface adds the missing
 * half of a deterministic acceptance record: the per-component acceptance
 * facts (state, acceptance base, preserved historical commit and evidence
 * digest) plus the operator-declared frozen candidate, release version and
 * immutable #64 release-artifact digest. It refuses missing, unaccepted, stale,
 * mixed-base and digest-mismatched inputs, and it never builds, deploys, starts,
 * repairs or silently substitutes a component.
 *
 * Machine identity reuses the same stable semantic component IDs as the
 * precheck; GitHub issue numbers are documentation only.
 *
 * Records are compared positionally, exactly as the precheck compares its own
 * keys: the top-level and per-entry keys must appear in the documented order and
 * no unknown key is tolerated, so a re-keyed document is a different document
 * and a reordered component list is never matched up by `id`. */

import type { ReleaseCandidateAuthorityFlagsV1,
  ReleaseCandidateComponentIdV1,
  ReleaseCandidateReferenceV1 } from './types';

export const RELEASE_CANDIDATE_ACCEPTANCE_SCHEMA_V1 =
  'control-room.release-candidate-acceptance-record/v1' as const;

/** Only `accepted` is admissible. Every other state is a refusal: pending,
 *  rejected, superseded and withdrawn components must not be assembled into a
 *  release candidate record. Frozen at runtime so the admissible-state contract
 *  cannot be widened from the outside. */
export const RELEASE_CANDIDATE_ACCEPTANCE_STATES_V1: readonly string[] = Object.freeze([
  'accepted',
  'pending',
  'rejected',
  'superseded',
  'withdrawn',
] as const);

export type ReleaseCandidateAcceptanceStateV1 =
  (typeof RELEASE_CANDIDATE_ACCEPTANCE_STATES_V1)[number];

/** One component's acceptance facts. `acceptedCommit` and `evidenceDigest` are
 *  the values the precheck reference preserves for the same slot; a caller that
 *  supplies different values is refused rather than having one side substituted. */
export interface ReleaseCandidateAcceptanceEntryV1 {
  id: ReleaseCandidateComponentIdV1;
  acceptanceState: ReleaseCandidateAcceptanceStateV1;
  /** Public revision this acceptance was recorded against. Exactly one base is
   *  admissible per record; several bases refuse as mixed-base. */
  acceptanceBaseCommit: string;
  acceptedCommit: string;
  evidenceDigest: string;
}

export interface ReleaseCandidateAcceptanceRecordV1 {
  schema: typeof RELEASE_CANDIDATE_ACCEPTANCE_SCHEMA_V1;
  /** The one frozen candidate this record is assembled against. */
  expectedCandidateCommit: string;
  expectedReleaseVersion: string;
  /** The immutable release-artifact digest the candidate must reference. */
  expectedArtifactDigest: string;
  /** The single public revision every listed acceptance was recorded against. */
  frozenBaseCommit: string;
  /** Separately-supplied binding digest over the frozen candidate parameters and
   *  every acceptance tuple, recomputed by the evaluator as
   *  `sha256Digest({ candidateCommit, releaseVersion, artifactDigest,
   *    artifactManifestDigest, frozenBaseCommit,
   *    acceptances: [{ id, acceptedCommit, evidenceDigest, acceptanceState,
   *      acceptanceBaseCommit }, ...] in canonical component order })`. */
  acceptanceBindingDigest: string;
  /** Reused exact-candidate precheck reference
   *  (schema `control-room.release-candidate-reference/v1`) carrying the already
   *  accepted component commits and their historical evidence digests. */
  reference: ReleaseCandidateReferenceV1;
  /** Exactly one entry per canonical component, in canonical component order. */
  acceptances: ReleaseCandidateAcceptanceEntryV1[];
}

export type ReleaseCandidateAcceptanceRefusalStatusV1 =
  | 'blocked_missing_inputs'
  | 'blocked_invalid_inputs'
  | 'blocked_unaccepted_inputs'
  | 'blocked_stale_candidate'
  | 'blocked_mixed_base'
  | 'blocked_digest_mismatch';

export type ReleaseCandidateAcceptanceStatusV1 =
  | ReleaseCandidateAcceptanceRefusalStatusV1
  | 'acceptance_record_complete_not_authorized';

/** A refusal names exactly one reason. `componentId` is present only when the
 *  refusal concerns one canonical component slot. */
export interface ReleaseCandidateAcceptanceRefusalV1 {
  readonly status: ReleaseCandidateAcceptanceRefusalStatusV1;
  readonly reason: string;
  readonly componentId?: string;
}

/** A single component's preserved acceptance values, echoed from the input —
 *  never re-derived from the candidate root and never substituted. */
export interface ReleaseCandidateAcceptanceEntryResultV1 {
  readonly id: string;
  readonly acceptanceState: string;
  readonly acceptanceBaseCommit: string;
  readonly acceptedCommit: string;
  readonly evidenceDigest: string;
}

/** Complete, internally consistent acceptance record. Completeness is never
 *  authorization: every authority flag is explicitly false. */
export interface ReleaseCandidateAcceptanceResultV1 {
  readonly status: 'acceptance_record_complete_not_authorized';
  readonly schema: string;
  readonly candidateCommit: string;
  readonly frozenBaseCommit: string;
  readonly releaseVersion: string;
  readonly artifactDigest: string;
  readonly artifactManifestDigest: string;
  readonly acceptances: readonly ReleaseCandidateAcceptanceEntryResultV1[];
  readonly componentCount: number;
  readonly acceptedComponentCount: number;
  readonly acceptanceBinding: { readonly supplied: string; readonly recomputed: string };
  readonly authority: ReleaseCandidateAuthorityFlagsV1;
  /** Constant, non-secret preparation steps. This module performs none of them. */
  readonly dryRunSteps: readonly string[];
}

export type ReleaseCandidateAcceptanceEvaluationV1 =
  | ReleaseCandidateAcceptanceRefusalV1
  | ReleaseCandidateAcceptanceResultV1;

/** Constant preparation steps for a complete record. They name what an operator
 *  performs under separate owner authority; reporting them has no effect. */
export const RELEASE_CANDIDATE_ACCEPTANCE_DRY_RUN_STEPS_V1: readonly string[] = Object.freeze([
  'confirm each listed accepted commit and evidence digest against its own acceptance record',
  'confirm the immutable release-artifact and manifest digests before assembly',
  'assemble the frozen candidate commit without rebuilding any component',
  'run the repository checks against the frozen candidate',
  'request owner authority for installation and live qualification',
] as const);

/** Non-secret operator projection. Refusals carry no steps at all: a dry run
 *  refuses to plan from missing or unaccepted inputs. */
export type ReleaseCandidateAcceptanceDryRunV1 =
  | { readonly status: ReleaseCandidateAcceptanceRefusalStatusV1;
      readonly reason: string;
      readonly componentId?: string;
      readonly steps: readonly string[] }
  | { readonly status: 'acceptance_record_complete_not_authorized';
      readonly dryRun: true;
      readonly candidateCommit: string;
      readonly frozenBaseCommit: string;
      readonly releaseVersion: string;
      readonly artifactDigest: string;
      readonly componentCount: number;
      readonly acceptedComponentCount: number;
      readonly steps: readonly string[];
      readonly authority: ReleaseCandidateAuthorityFlagsV1;
      readonly authorized: false };