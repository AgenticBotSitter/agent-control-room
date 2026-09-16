import { types as nodeUtilTypes } from 'node:util';
import { sha256Digest } from '../../security/canonical-digest';
import { RELEASE_CANDIDATE_COMPONENT_IDS_V1,
  RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1,
  type ReleaseCandidatePrecheckResultV1 } from './types';

const COMMIT = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const COMPONENT_ID = /^[a-z][a-z-]{1,30}$/;
const FORBIDDEN_SHAPES = [/:\\\/\\/, /^\/[^/]/, /\\/, /\0/, /\r/, /\n/, /\$\{/, /^\s|\s$/];

const RECORD_KEYS = ['schema', 'candidateCommit', 'treeDigest', 'sourceDigest',
  'releaseVersion', 'artifactDigest', 'artifactManifestDigest',
  'aggregateBindingDigest', 'components'] as const;
const COMPONENT_KEYS = ['id', 'acceptedCommit', 'evidenceDigest'] as const;
const MAX_DEPTH = 8;
const MAX_KEYS = 64;

const missing = (reason: string): ReleaseCandidatePrecheckResultV1 =>
  Object.freeze({ status: 'blocked_missing_inputs' as const, reason });
const invalid = (reason: string): ReleaseCandidatePrecheckResultV1 =>
  Object.freeze({ status: 'blocked_invalid_inputs' as const, reason });

function isDataDescriptor(value: unknown): value is { value: unknown } {
  if (typeof value !== 'object' || value === null) return false;
  const descriptor = value as { get?: unknown; set?: unknown; value?: unknown };
  return descriptor.get === undefined && descriptor.set === undefined
    && Object.prototype.hasOwnProperty.call(descriptor, 'value');
}

/** Trap-free plain-data walk. Performs only the introspection needed to refuse
 * exotic shapes (Proxy traps, accessors, prototypes, Symbols, non-enumerable,
 * unknown / sparse keys), then returns the recognized plain value. Catches
 * any throw — every hostile reflection call (Proxy `getPrototypeOf`, accessor
 * getter, prototype getter, frozen/Sealed access) is treated as attacker input
 * and refused. Proxy detection uses `util.types.isProxy`, which inspects the
 * internal [[ProxyTarget]] slot without invoking any user trap. */
/** Trap-free plain-data walk, shared with the release-candidate acceptance
 * layer (`./acceptance`) so both surfaces refuse the same exotic shapes
 * (Proxy traps, accessors, prototype pollution, Symbols, non-enumerable,
 * unknown / sparse keys) through one hardened implementation. */
export function readPlain(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error('depth');
  if (value === null || typeof value !== 'object') return value;
  // Proxy rejection — util.types.isProxy is a brand check that does not invoke
  // any Proxy trap. Plain objects and arrays return false.
  if (nodeUtilTypes.isProxy(value)) throw new Error('proxy');
  if (Array.isArray(value)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!isDataDescriptor(lengthDescriptor)) throw new Error('accessor');
    const length = lengthDescriptor.value as number;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
      throw new Error('length');
    }
    const items: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!isDataDescriptor(descriptor)) throw new Error('accessor');
      items.push(readPlain(descriptor.value, depth + 1));
    }
    const ownKeys = Object.getOwnPropertyNames(value);
    const extraNames = ownKeys.filter((k) => k !== 'length');
    if (extraNames.length !== length) throw new Error('sparse');
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('symbol');
    return items;
  }
  // Strict plain-object requirement. `util.types.isProxy` above already rejects
  // Proxy-wrapped objects; we additionally require the prototype to be exactly
  // Object.prototype (not null, not custom). Class instances, `Object.create(parent)`
  // with a non-null parent, and exotic host objects are all refused.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype) throw new Error('prototype');
  const ownNames = Object.getOwnPropertyNames(value);
  if (ownNames.length > MAX_KEYS) throw new Error('too-many-keys');
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('symbol');
  const record: Record<string, unknown> = {};
  for (const key of ownNames) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) throw new Error('descriptor');
    if (!descriptor.enumerable) throw new Error('non-enumerable');
    if (!isDataDescriptor(descriptor)) throw new Error('accessor');
    record[key] = readPlain(descriptor.value, depth + 1);
  }
  return record;
}

function checkString(value: unknown, pattern: RegExp): boolean {
  if (typeof value !== 'string' || value.length > 256) return false;
  if (!pattern.test(value)) return false;
  return !FORBIDDEN_SHAPES.some(shape => shape.test(value));
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  if (actual.length !== keys.length) return false;
  for (let index = 0; index < keys.length; index++) {
    if (actual[index] !== keys[index]) return false;
  }
  return true;
}

/** Pure, deterministic, effect-free. Reads no files, environment, clocks,
 * processes, networks, databases, credentials or services. */
export function evaluateReleaseCandidatePrecheckV1(
  input: unknown): ReleaseCandidatePrecheckResultV1 {
  // Internal invariant: the canonical component ID list must be frozen.
  // If it isn't, refuse immediately rather than reporting a "complete" precheck
  // over a mutable identity contract.
  const componentIds = RELEASE_CANDIDATE_COMPONENT_IDS_V1;
  if (!Object.isFrozen(componentIds)) {
    return invalid('invalid:internal-component-ids-not-frozen');
  }
  if (componentIds.length === 0) {
    return invalid('invalid:internal-component-ids-empty');
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
      if (!expected.has(key)) return invalid(`invalid:extra:${key}`);
    }
    for (const key of RECORD_KEYS) {
      if (!(key in root)) return missing(`missing:${key}`);
    }
    return invalid('invalid:record');
  }
  if (root.schema !== RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1) {
    return root.schema === undefined ? missing('missing:schema') : invalid('invalid:schema');
  }
  const fields: Array<[string, RegExp]> = [
    ['candidateCommit', COMMIT],
    ['treeDigest', DIGEST],
    ['sourceDigest', DIGEST],
    ['releaseVersion', VERSION],
    ['artifactDigest', DIGEST],
    ['artifactManifestDigest', DIGEST],
  ];
  for (const [field, pattern] of fields) {
    if (root[field] === undefined) return missing(`missing:${field}`);
    if (!checkString(root[field], pattern)) return invalid(`invalid:${field}`);
  }
  if (root.aggregateBindingDigest === undefined) {
    return missing('missing:aggregateBindingDigest');
  }
  if (!checkString(root.aggregateBindingDigest, DIGEST)) {
    return invalid('invalid:aggregateBindingDigest');
  }
  if (!Array.isArray(root.components)) {
    return root.components === undefined
      ? missing('missing:components')
      : invalid('invalid:components');
  }
  if (root.components.length !== componentIds.length) {
    return invalid('invalid:component-count');
  }
  const rootCandidate = root.candidateCommit as string;
  const rootArtifact = root.artifactDigest as string;
  const rootManifest = root.artifactManifestDigest as string;
  const suppliedBindingDigest = root.aggregateBindingDigest as string;
  const canonicalComponents: Array<{ id: string; acceptedCommit: string; evidenceDigest: string }> = [];
  for (let index = 0; index < root.components.length; index++) {
    const item = (root.components as unknown[])[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return invalid(`invalid:components[${index}]`);
    }
    const entry = item as Record<string, unknown>;
    if (!exactKeys(entry, COMPONENT_KEYS)) {
      const expected = new Set(COMPONENT_KEYS as readonly string[]);
      for (const key of Object.keys(entry)) {
        if (!expected.has(key)) return invalid(`invalid:components[${index}]`);
      }
      for (const key of COMPONENT_KEYS) {
        if (!(key in entry)) return missing(`missing:components[${index}].${key}`);
      }
      return invalid(`invalid:components[${index}]`);
    }
    const expectedId = componentIds[index]!;
    if (entry.id !== expectedId) {
      return entry.id === undefined
        ? missing(`missing:components[${index}].id`)
        : invalid(`invalid:components[${index}].id`);
    }
    if (!COMPONENT_ID.test(expectedId)) return invalid(`invalid:components[${index}].id`);
    if (entry.acceptedCommit === undefined) {
      return missing(`missing:components[${index}].acceptedCommit`);
    }
    if (!checkString(entry.acceptedCommit, COMMIT)) {
      return invalid(`invalid:components[${index}].acceptedCommit`);
    }
    if (entry.evidenceDigest === undefined) {
      return missing(`missing:components[${index}].evidenceDigest`);
    }
    if (!checkString(entry.evidenceDigest, DIGEST)) {
      return invalid(`invalid:components[${index}].evidenceDigest`);
    }
    const acceptedCommit = entry.acceptedCommit as string;
    const evidenceDigest = entry.evidenceDigest as string;
    // Historical-evidence guard. The component's evidence digest must be a
    // witness attestation emitted at the component's own historical acceptance
    // time — NOT a digest re-derived from the candidate root's parameters.
    // Refuse when the supplied digest equals the candidate-derived binding
    // (proving the operator reconstructed it from the candidate rather than
    // producing it from independently trusted historical evidence).
    const candidateDerivedDigest = sha256Digest({
      artifactDigest: rootArtifact, artifactManifestDigest: rootManifest,
      candidateCommit: rootCandidate, componentId: expectedId });
    if (evidenceDigest === candidateDerivedDigest) {
      return invalid(`invalid:components[${index}].evidenceDigest-candidate-reconstructed`);
    }
    // Distinct historical guards: refuse repeated historical commits that all
    // collapse to the candidate (each component must attest a different
    // historical accept-time decision OR the operator has not actually
    // assembled different histories). Components may legitimately share an
    // accepted commit when they were co-accepted, but the digests must then
    // remain distinct — otherwise the per-component historical attestation is
    // not actually distinct from the candidate reconstruction. Catch the case
    // where the operator passes a uniform record with one candidate-derived
    // digest per slot: at least one slot must carry a non-candidate-derived
    // digest (already handled above), and per-component attestations must not
    // collapse to exactly one value across all 14 slots.
    canonicalComponents.push(Object.freeze({ id: expectedId, acceptedCommit, evidenceDigest }));
  }
  // Verify the historical component digests are all distinct from each other
  // OR (when multiple components are intentionally co-accepted at the same
  // commit) the operator still supplies per-component distinct witness
  // digests. A record where every component carries the same evidenceDigest
  // means the historical witness set collapsed to a single attestation — that
  // is not a multi-component assembled release; refuse.
  const seenDigests = new Set<string>();
  for (const c of canonicalComponents) {
    if (seenDigests.has(c.evidenceDigest)) {
      return invalid('invalid:components.evidenceDigest-not-distinct');
    }
    seenDigests.add(c.evidenceDigest);
  }
  // Recompute the aggregate binding digest: it must equal
  // `sha256Digest({ candidateCommit, treeDigest, sourceDigest, releaseVersion,
  //   artifactDigest, artifactManifestDigest,
  //   components: [{ id, acceptedCommit, evidenceDigest }, ...] in canonical order })`.
  // Each component contributes the full historical tuple (id, acceptedCommit,
  // evidenceDigest) so the binding cannot be re-derived from candidate root
  // parameters alone — it requires every component's independently attested
  // historical acceptance commit AND its evidence digest. A substitution of
  // acceptedCommit alone (with digests and aggregate binding digest
  // unchanged) therefore mismatches; the operator must recompute the
  // aggregate binding alongside any historical-commit change. The supplied
  // digest MUST equal the recomputed value; otherwise the binding is forged
  // or substituted.
  const recomputedBindingDigest = sha256Digest({
    candidateCommit: rootCandidate, treeDigest: root.treeDigest as string,
    sourceDigest: root.sourceDigest as string,
    releaseVersion: root.releaseVersion as string,
    artifactDigest: rootArtifact, artifactManifestDigest: rootManifest,
    components: canonicalComponents.map((c) => ({ id: c.id,
      acceptedCommit: c.acceptedCommit, evidenceDigest: c.evidenceDigest })) });
  if (suppliedBindingDigest !== recomputedBindingDigest) {
    return invalid('invalid:aggregateBindingDigest-mismatch');
  }
  // Preserve the real per-component accepted values into the output without
  // replacing them with anything computed from the candidate root. The
  // aggregate binding is reported as supplied/recomputed for proof of internal
  // consistency — never as acceptance. Status is explicitly
  // precheck-complete-not-accepted; all authority flags remain false.
  return Object.freeze({ status: 'precheck_complete_not_accepted' as const,
    schema: RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1,
    candidateCommit: rootCandidate,
    artifactDigest: rootArtifact,
    artifactManifestDigest: rootManifest,
    releaseVersion: root.releaseVersion as string,
    components: Object.freeze(canonicalComponents),
    componentCount: componentIds.length,
    aggregateBinding: Object.freeze({
      supplied: suppliedBindingDigest, recomputed: recomputedBindingDigest }),
    authority: Object.freeze({ approval: false as const, qualification: false as const,
      installation: false as const, deployment: false as const, execution: false as const,
      externalEffect: false as const, ownerAuthority: false as const }) });
}
