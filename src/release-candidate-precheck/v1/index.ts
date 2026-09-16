export { RELEASE_CANDIDATE_COMPONENT_IDS_V1,
  RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1,
  type ReleaseCandidateAuthorityFlagsV1,
  type ReleaseCandidateComponentIdV1,
  type ReleaseCandidateComponentV1,
  type ReleaseCandidatePrecheckResultV1,
  type ReleaseCandidatePrecheckStatusV1,
  type ReleaseCandidateReferenceV1 } from './types';
export { evaluateReleaseCandidatePrecheckV1 } from './precheck';
// The acceptance-record layer (issue #61) extends the precheck rather than
// replacing it: the precheck stays the contract for the candidate reference,
// and the acceptance surface adds the per-component acceptance facts on top.
// The shared plain-data walker stays internal to this package — it is imported
// directly by precheck.ts and acceptance.ts, never re-exported here.
export { RELEASE_CANDIDATE_ACCEPTANCE_SCHEMA_V1,
  RELEASE_CANDIDATE_ACCEPTANCE_STATES_V1,
  RELEASE_CANDIDATE_ACCEPTANCE_DRY_RUN_STEPS_V1,
  type ReleaseCandidateAcceptanceDryRunV1,
  type ReleaseCandidateAcceptanceEntryResultV1,
  type ReleaseCandidateAcceptanceEntryV1,
  type ReleaseCandidateAcceptanceEvaluationV1,
  type ReleaseCandidateAcceptanceRecordV1,
  type ReleaseCandidateAcceptanceRefusalStatusV1,
  type ReleaseCandidateAcceptanceRefusalV1,
  type ReleaseCandidateAcceptanceResultV1,
  type ReleaseCandidateAcceptanceStateV1,
  type ReleaseCandidateAcceptanceStatusV1 } from './acceptance-types';
export { dryRunReleaseCandidateAcceptanceV1,
  evaluateReleaseCandidateAcceptanceV1 } from './acceptance';