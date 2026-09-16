import { sha256Digest } from '../../security/canonical-digest';
import { RELEASE_CANDIDATE_COMPONENT_IDS_V1 } from './types';
import { evaluateReleaseCandidatePrecheckV1, readPlain } from './precheck';
import { RELEASE_CANDIDATE_ACCEPTANCE_DRY_RUN_STEPS_V1,
  RELEASE_CANDIDATE_ACCEPTANCE_SCHEMA_V1,
  RELEASE_CANDIDATE_ACCEPTANCE_STATES_V1,
  type ReleaseCandidateAcceptanceDryRunV1,
  type ReleaseCandidateAcceptanceEvaluationV1,
  type ReleaseCandidateAcceptanceRefusalStatusV1,
  type ReleaseCandidateAcceptanceResultV1 } from './acceptance-types';

const COMMIT = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const COMPONENT_ID = /^[a-z][a-z-]{1,30}$/;
const FORBIDDEN_SHAPES = [/:\\\/\\/, /^\/[^/]/, /\\/, /\0/, /\r/, /\n/, /\$\{/, /^\s|\s$/];

const RECORD_KEYS = ['schema', 'expectedCandidateCommit', 'expectedReleaseVersion',
  'expectedArtifactDigest', 'frozenBaseCommit', 'acceptanceBindingDigest', 'reference',
  'acceptances'] as const;
const ACCEPTANCE_KEYS = ['id', 'acceptanceState', 'acceptanceBaseCommit', 'acceptedCommit',
  'evidenceDigest'] as const;
const EMPTY_STEPS: readonly string[] = Object.freeze([] as string[]);

function refuse(status: ReleaseCandidateAcceptanceRefusalStatusV1, reason: string,
  componentId?: string): ReleaseCandidateAcceptanceEvaluationV1 {
  return componentId === undefined
    ? Object.freeze({ status, reason })
    : Object.freeze({ status, reason, componentId });
}

const missing = (reason: string) => refuse('blocked_missing_inputs', reason);
const invalid = (reason: string) => refuse('blocked_invalid_inputs', reason);

/** Refusal reasons are a fixed machine-readable vocabulary. Unknown key names
 *  are labels, not free text, so an attacker-supplied key can never inject
 *  arbitrary bytes into a reason string. */
function keyLabel(key: string): string {
  const label = key.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
  return label.length === 0 ? '_' : label;
}

function checkString(value: unknown, pattern: RegExp): boolean {
  if (typeof value !== 'string' || value.length > 256) return false;
  if (!pattern.test(value)) return false;
  return !FORBIDDEN_SHAPES.some((shape) => shape.test(value));
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  if (actual.length !== keys.length) return false;
  for (let index = 0; index < keys.length; index++) {
    if (actual[index] !== keys[index]) return false;
  }
  return true;
}

/** Structural pass over one acceptance entry. Returns a refusal, or the frozen
 *  canonical tuple when the entry is well formed. */
function readAcceptanceEntry(entry: unknown, index: number,
  componentIds: readonly string[]): { refusal?: ReleaseCandidateAcceptanceEvaluationV1;
    entry?: { id: string; acceptanceState: string; acceptanceBaseCommit: string;
      acceptedCommit: string; evidenceDigest: string } } {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { refusal: invalid(`invalid:acceptances[${index}]`) };
  }
  const slot = entry as Record<string, unknown>;
  if (!exactKeys(slot, ACCEPTANCE_KEYS)) {
    const expected = new Set(ACCEPTANCE_KEYS as readonly string[]);
    for (const key of Object.keys(slot)) {
      if (!expected.has(key)) return { refusal: invalid(`invalid:acceptances[${index}].${keyLabel(key)}`) };
    }
    for (const key of ACCEPTANCE_KEYS) {
      if (!(key in slot)) return { refusal: missing(`missing:acceptances[${index}].${key}`) };
    }
    return { refusal: invalid(`invalid:acceptances[${index}]`) };
  }
  // Canonical order is part of the identity contract: a reordered or
  // substituted component is refused, never matched up by id.
  const expectedId = componentIds[index]!;
  if (slot.id === undefined) return { refusal: missing(`missing:acceptances[${index}].id`) };
  if (slot.id !== expectedId || !checkString(slot.id, COMPONENT_ID)) {
    return { refusal: invalid(`invalid:acceptances[${index}].id`) };
  }
  if (slot.acceptanceState === undefined) {
    return { refusal: missing(`missing:acceptances[${index}].acceptanceState`) };
  }
  if (typeof slot.acceptanceState !== 'string'
    || !RELEASE_CANDIDATE_ACCEPTANCE_STATES_V1.includes(slot.acceptanceState)) {
    return { refusal: invalid(`invalid:acceptances[${index}].acceptanceState`) };
  }
  for (const [key, pattern] of [['acceptanceBaseCommit', COMMIT], ['acceptedCommit', COMMIT],
    ['evidenceDigest', DIGEST]] as Array<[string, RegExp]>) {
    if (slot[key] === undefined) return { refusal: missing(`missing:acceptances[${index}].${key}`) };
    if (!checkString(slot[key], pattern)) {
      return { refusal: invalid(`invalid:acceptances[${index}].${key}`) };
    }
  }
  return { entry: Object.freeze({ id: expectedId,
    acceptanceState: slot.acceptanceState as string,
    acceptanceBaseCommit: slot.acceptanceBaseCommit as string,
    acceptedCommit: slot.acceptedCommit as string,
    evidenceDigest: slot.evidenceDigest as string }) };
}

/** Pure, deterministic, effect-free acceptance-record evaluation. Reads no
 *  files, environment, clocks, processes, networks, databases, credentials or
 *  services, and returns only data: it never builds, deploys, starts, repairs or
 *  substitutes a component. */
export function evaluateReleaseCandidateAcceptanceV1(
  input: unknown): ReleaseCandidateAcceptanceEvaluationV1 {
  const componentIds = RELEASE_CANDIDATE_COMPONENT_IDS_V1;
  if (!Object.isFrozen(componentIds)) {
    return invalid('invalid:internal-component-ids-not-frozen');
  }
  if (componentIds.length === 0) return invalid('invalid:internal-component-ids-empty');
  if (!Object.isFrozen(RELEASE_CANDIDATE_ACCEPTANCE_STATES_V1)) {
    return invalid('invalid:internal-acceptance-states-not-frozen');
  }
  let record: unknown;
  try {
    record = readPlain(input, 0);
  } catch {
    return invalid('invalid:record');
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return missing('missing:record');
  }
  const root = record as Record<string, unknown>;
  if (!exactKeys(root, RECORD_KEYS)) {
    const expected = new Set(RECORD_KEYS as readonly string[]);
    for (const key of Object.keys(root)) {
      if (!expected.has(key)) return invalid(`invalid:extra:${keyLabel(key)}`);
    }
    for (const key of RECORD_KEYS) {
      if (!(key in root)) return missing(`missing:${key}`);
    }
    return invalid('invalid:record');
  }
  if (root.schema === undefined) return missing('missing:schema');
  if (root.schema !== RELEASE_CANDIDATE_ACCEPTANCE_SCHEMA_V1) return invalid('invalid:schema');
  for (const [field, pattern] of [['expectedCandidateCommit', COMMIT],
    ['expectedReleaseVersion', VERSION], ['expectedArtifactDigest', DIGEST],
    ['frozenBaseCommit', COMMIT], ['acceptanceBindingDigest', DIGEST]] as Array<[string, RegExp]>) {
    if (root[field] === undefined) return missing(`missing:${field}`);
    if (!checkString(root[field], pattern)) return invalid(`invalid:${field}`);
  }
  if (root.reference === undefined) return missing('missing:reference');
  if (root.reference === null || typeof root.reference !== 'object'
    || Array.isArray(root.reference)) {
    return invalid('invalid:reference');
  }
  // Reuse the exact-candidate precheck instead of re-implementing the reference
  // rules: the acceptance layer adds facts, it does not replace the contract.
  const candidate = evaluateReleaseCandidatePrecheckV1(root.reference);
  if (candidate.status === 'blocked_missing_inputs') {
    return missing(`reference:${candidate.reason}`);
  }
  if (candidate.status === 'blocked_invalid_inputs') {
    return invalid(`reference:${candidate.reason}`);
  }
  if (candidate.candidateCommit !== root.expectedCandidateCommit) {
    return refuse('blocked_stale_candidate', 'stale:candidate-commit');
  }
  if (candidate.releaseVersion !== root.expectedReleaseVersion) {
    return refuse('blocked_stale_candidate', 'stale:release-version');
  }
  if (candidate.artifactDigest !== root.expectedArtifactDigest) {
    return refuse('blocked_digest_mismatch', 'digest-mismatch:artifact-digest');
  }
  if (!Array.isArray(root.acceptances)) {
    return root.acceptances === undefined ? missing('missing:acceptances')
      : invalid('invalid:acceptances');
  }
  if (root.acceptances.length !== componentIds.length) {
    return invalid('invalid:acceptance-count');
  }
  const frozenBaseCommit = root.frozenBaseCommit as string;
  const canonical: Array<{ id: string; acceptanceState: string; acceptanceBaseCommit: string;
    acceptedCommit: string; evidenceDigest: string }> = [];
  for (let index = 0; index < root.acceptances.length; index++) {
    const read = readAcceptanceEntry(root.acceptances[index], index, componentIds);
    if (read.refusal) return read.refusal;
    const entry = read.entry!;
    // Mixed base: one record may only assemble acceptances taken against the
    // single frozen revision.
    if (entry.acceptanceBaseCommit !== frozenBaseCommit) {
      return refuse('blocked_mixed_base', `mixed-base:acceptances[${index}]`, entry.id);
    }
    // Unaccepted input: only an actually accepted component may be assembled.
    if (entry.acceptanceState !== 'accepted') {
      return refuse('blocked_unaccepted_inputs',
        `unaccepted:acceptances[${index}]:${entry.acceptanceState}`, entry.id);
    }
    // Never substitute: the acceptance values must equal the preserved
    // historical values the reference already bound.
    const preserved = candidate.components[index]!;
    if (entry.id !== preserved.id) return invalid(`invalid:acceptances[${index}].id`);
    if (entry.acceptedCommit !== preserved.acceptedCommit) {
      return refuse('blocked_digest_mismatch',
        `digest-mismatch:acceptances[${index}].acceptedCommit`, entry.id);
    }
    if (entry.evidenceDigest !== preserved.evidenceDigest) {
      return refuse('blocked_digest_mismatch',
        `digest-mismatch:acceptances[${index}].evidenceDigest`, entry.id);
    }
    canonical.push(entry);
  }
  const suppliedBindingDigest = root.acceptanceBindingDigest as string;
  const recomputedBindingDigest = sha256Digest({
    candidateCommit: candidate.candidateCommit,
    releaseVersion: candidate.releaseVersion,
    artifactDigest: candidate.artifactDigest,
    artifactManifestDigest: candidate.artifactManifestDigest,
    frozenBaseCommit,
    acceptances: canonical.map((entry) => ({ id: entry.id,
      acceptedCommit: entry.acceptedCommit, evidenceDigest: entry.evidenceDigest,
      acceptanceState: entry.acceptanceState,
      acceptanceBaseCommit: entry.acceptanceBaseCommit })),
  });
  if (suppliedBindingDigest !== recomputedBindingDigest) {
    return refuse('blocked_digest_mismatch', 'digest-mismatch:acceptance-binding');
  }
  const result: ReleaseCandidateAcceptanceResultV1 = Object.freeze({
    status: 'acceptance_record_complete_not_authorized' as const,
    schema: RELEASE_CANDIDATE_ACCEPTANCE_SCHEMA_V1,
    candidateCommit: candidate.candidateCommit,
    frozenBaseCommit,
    releaseVersion: candidate.releaseVersion,
    artifactDigest: candidate.artifactDigest,
    artifactManifestDigest: candidate.artifactManifestDigest,
    acceptances: Object.freeze(canonical.map((entry) => Object.freeze({ id: entry.id,
      acceptanceState: entry.acceptanceState,
      acceptanceBaseCommit: entry.acceptanceBaseCommit,
      acceptedCommit: entry.acceptedCommit, evidenceDigest: entry.evidenceDigest }))),
    componentCount: componentIds.length,
    acceptedComponentCount: canonical.length,
    acceptanceBinding: Object.freeze({ supplied: suppliedBindingDigest,
      recomputed: recomputedBindingDigest }),
    authority: Object.freeze({ approval: false as const, qualification: false as const,
      installation: false as const, deployment: false as const, execution: false as const,
      externalEffect: false as const, ownerAuthority: false as const }),
    dryRunSteps: RELEASE_CANDIDATE_ACCEPTANCE_DRY_RUN_STEPS_V1,
  });
  return result;
}

/** Non-secret dry run over the same evaluation. Missing or unaccepted inputs
 *  refuse with no steps at all — this projection never invents a plan from an
 *  inadmissible record, and it performs no step. */
export function dryRunReleaseCandidateAcceptanceV1(
  input: unknown): ReleaseCandidateAcceptanceDryRunV1 {
  const outcome = evaluateReleaseCandidateAcceptanceV1(input);
  if (outcome.status !== 'acceptance_record_complete_not_authorized') {
    return Object.freeze(outcome.componentId === undefined
      ? { status: outcome.status, reason: outcome.reason, steps: EMPTY_STEPS }
      : { status: outcome.status, reason: outcome.reason,
          componentId: outcome.componentId, steps: EMPTY_STEPS });
  }
  return Object.freeze({
    status: 'acceptance_record_complete_not_authorized' as const,
    dryRun: true as const,
    candidateCommit: outcome.candidateCommit,
    frozenBaseCommit: outcome.frozenBaseCommit,
    releaseVersion: outcome.releaseVersion,
    artifactDigest: outcome.artifactDigest,
    componentCount: outcome.componentCount,
    acceptedComponentCount: outcome.acceptedComponentCount,
    steps: outcome.dryRunSteps,
    authority: outcome.authority,
    authorized: false as const,
  });
}