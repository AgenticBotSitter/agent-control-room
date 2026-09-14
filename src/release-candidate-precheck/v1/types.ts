/** Versioned candidate-reference record for the exact-candidate release precheck.
 * Machine identity uses stable semantic component IDs; GitHub issue numbers are
 * documentation only (see docs/RELEASE_CANDIDATE_PRECHECK_CONTRACT.md). */

export const RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1 =
  'control-room.release-candidate-reference/v1' as const;

/** Lexical identity for each required semantic component. Required so
 *  release artifacts, manifests and the candidate tree commit and tree-digest
 *  are bound per-component. Treated as canonical literal keys; rewriting this
 *  array changes the precheck contract. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const RELEASE_CANDIDATE_COMPONENT_IDS_V1: readonly string[] = Object.freeze([
  'browser-journey',
  'hermes-connector',
  'portable-configuration',
  'project-webpage',
  'notices',
  'codex-connector',
  'server-integration',
  'persistent-work-security',
  'postgresql-recovery',
  'release-artifact',
  'durable-result-storage',
  'server-composition',
  'private-ingress',
  'worker-installation',
] as const);

export type ReleaseCandidateComponentIdV1 =
  (typeof RELEASE_CANDIDATE_COMPONENT_IDS_V1)[number];

export interface ReleaseCandidateComponentV1 {
  id: ReleaseCandidateComponentIdV1;
  acceptedCommit: string;
  evidenceDigest: string;
}

export interface ReleaseCandidateReferenceV1 {
  schema: typeof RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1;
  candidateCommit: string;
  treeDigest: string;
  sourceDigest: string;
  releaseVersion: string;
  artifactDigest: string;
  artifactManifestDigest: string;
  components: ReleaseCandidateComponentV1[];
}

export type ReleaseCandidatePrecheckStatusV1 =
  | 'blocked_missing_inputs'
  | 'blocked_invalid_inputs'
  | 'precheck_complete_not_accepted';

/** Every authority flag is explicitly false: completeness is never acceptance. */
export interface ReleaseCandidateAuthorityFlagsV1 {
  approval: false;
  qualification: false;
  installation: false;
  deployment: false;
  execution: false;
  externalEffect: false;
  ownerAuthority: false;
}

/** A single component's preserved real accepted values. These come directly
 * from the input record (the operator-supplied acceptedCommit and evidenceDigest
 * that were emitted at acceptance time) and are never re-derived from the
 * candidate root. */
export interface ReleaseCandidateComponentResultV1 {
  readonly id: string;
  readonly acceptedCommit: string;
  readonly evidenceDigest: string;
}

export type ReleaseCandidatePrecheckResultV1 =
  | { status: 'blocked_missing_inputs'; reason: string }
  | { status: 'blocked_invalid_inputs'; reason: string }
  | { status: 'precheck_complete_not_accepted';
      schema: string;
      candidateCommit: string;
      artifactDigest: string;
      artifactManifestDigest: string;
      releaseVersion: string;
      components: ReadonlyArray<ReleaseCandidateComponentResultV1>;
      componentCount: number; authority: ReleaseCandidateAuthorityFlagsV1 };
