import { sha256Digest } from '../../security/canonical-digest';
import { RELEASE_CANDIDATE_COMPONENT_IDS_V1,
  RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1,
  type ReleaseCandidatePrecheckResultV1 } from './types';

const COMMIT = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const COMPONENT_ID = /^[a-z][a-z-]{1,30}$/;
const FORBIDDEN_SHAPES = [/:\/\//, /^\/[^/]/, /\\/, /\0/, /\r/, /\n/, /\$\{/, /^\s|\s$/];

const RECORD_KEYS = ['schema', 'candidateCommit', 'treeDigest', 'sourceDigest',
  'releaseVersion', 'artifactDigest', 'artifactManifestDigest', 'components'];
const COMPONENT_KEYS = ['id', 'acceptedCommit', 'evidenceDigest'];
const MAX_DEPTH = 8;

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

/** Descriptor-first plain-data walk. Reads .value only from data descriptors, so
 * accessor getters and Proxy read traps on values never execute. Any inspection
 * throw (including a hostile trap) refuses as invalid. */
function readPlain(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error('depth');
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!isDataDescriptor(descriptor)) throw new Error('accessor');
      items.push(readPlain(descriptor.value, depth + 1));
    }
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('symbol');
    return items;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error('prototype');
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('symbol');
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
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

function exactKeys(record: Record<string, unknown>, keys: string[]): string | undefined {
  const actual = Object.keys(record);
  if (actual.length !== keys.length) return 'shape';
  for (let index = 0; index < keys.length; index++) {
    if (actual[index] !== keys[index]) return 'shape';
  }
  return undefined;
}

/** Pure, deterministic, effect-free. Reads no files, environment, clocks,
 * processes, networks, databases, credentials or services. */
export function evaluateReleaseCandidatePrecheckV1(
  input: unknown): ReleaseCandidatePrecheckResultV1 {
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
  const shape = exactKeys(root, RECORD_KEYS);
  if (shape) {
    const expected = new Set(RECORD_KEYS);
    for (const key of Object.keys(root)) {
      if (!expected.has(key)) return invalid(`invalid:extra:${key}`);
    }
    for (const key of RECORD_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(root, key);
      if (!descriptor || !descriptor.enumerable) return missing(`missing:${key}`);
    }
    return invalid('invalid:record-shape');
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
  if (!Array.isArray(root.components)) {
    return root.components === undefined
      ? missing('missing:components')
      : invalid('invalid:components');
  }
  if (root.components.length !== RELEASE_CANDIDATE_COMPONENT_IDS_V1.length) {
    return invalid('invalid:component-count');
  }
  const canonicalComponents: Array<{ id: string; acceptedCommit: string; evidenceDigest: string }> = [];
  for (let index = 0; index < root.components.length; index++) {
    const item = (root.components as unknown[])[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return invalid(`invalid:components[${index}]`);
    }
    const entry = item as Record<string, unknown>;
    if (exactKeys(entry, COMPONENT_KEYS)) {
      const expected = new Set(COMPONENT_KEYS);
      for (const key of Object.keys(entry)) {
        if (!expected.has(key)) return invalid(`invalid:components[${index}]`);
      }
      for (const key of COMPONENT_KEYS) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (!descriptor || !descriptor.enumerable) {
          return missing(`missing:components[${index}].${key}`);
        }
      }
      return invalid(`invalid:components[${index}]`);
    }
    const expectedId = RELEASE_CANDIDATE_COMPONENT_IDS_V1[index]!;
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
    canonicalComponents.push({ id: expectedId, acceptedCommit: entry.acceptedCommit as string,
      evidenceDigest: entry.evidenceDigest as string });
  }
  const canonical = {
    artifactDigest: root.artifactDigest as string,
    artifactManifestDigest: root.artifactManifestDigest as string,
    candidateCommit: root.candidateCommit as string,
    components: canonicalComponents,
    releaseVersion: root.releaseVersion as string,
    schema: RELEASE_CANDIDATE_PRECHECK_SCHEMA_V1,
    sourceDigest: root.sourceDigest as string,
    treeDigest: root.treeDigest as string,
  };
  return Object.freeze({ status: 'precheck_complete_not_accepted' as const,
    recordDigest: sha256Digest(canonical),
    componentCount: RELEASE_CANDIDATE_COMPONENT_IDS_V1.length,
    authority: Object.freeze({ approval: false as const, qualification: false as const,
      installation: false as const, deployment: false as const, execution: false as const,
      externalEffect: false as const, ownerAuthority: false as const }) });
}
