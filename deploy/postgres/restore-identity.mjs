// Stable database-restore identity consumed by #60/#61, plus the typed placeholder
// for #65's future artifact-set digest. The identity binds ledger digest, role/grant
// snapshot, schema digest and required-row hashes: a restored database is accepted
// only when every piece matches. This module never copies artifacts and never
// invents #65's digest — the placeholder validates shape only.
import { createHash } from "node:crypto";

const sha256 = text => createHash("sha256").update(text).digest("hex");
const canonical = value => JSON.stringify(value);
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

// Future #65 artifact-set digest shape. Accepted as an opaque input and echoed into
// the restore identity; validated for shape only, never generated here.
/**
 * @param {unknown} input
 * @returns {{ algorithm: string, value: string, setId: string } | undefined}
 */
export function parseArtifactSetDigest(input) {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null) throw new Error("artifact_set_digest_invalid");
  if (input.algorithm !== "sha256" || typeof input.value !== "string" || !DIGEST_RE.test(`sha256:${input.value}`)) {
    throw new Error("artifact_set_digest_invalid");
  }
  if (typeof input.setId !== "string" || input.setId.length < 1 || input.setId.length > 160) {
    throw new Error("artifact_set_digest_invalid");
  }
  return { algorithm: "sha256", value: input.value, setId: input.setId };
}

/**
 * @param {{ ledgerDigest: string, rolesDigest: string, schemaDigest: string, rowsDigest: string, ownersDigest: string, ledgerRowsDigest: string, artifactSetDigest?: unknown }} parts
 */
export function computeDatabaseRestoreIdentity({ ledgerDigest, rolesDigest, schemaDigest, rowsDigest, ownersDigest, ledgerRowsDigest, artifactSetDigest }) {
  for (const [name, value] of [["ledgerDigest", ledgerDigest], ["rolesDigest", rolesDigest],
      ["schemaDigest", schemaDigest], ["rowsDigest", rowsDigest], ["ownersDigest", ownersDigest],
      ["ledgerRowsDigest", ledgerRowsDigest]]) {
    if (typeof value !== "string" || !DIGEST_RE.test(value)) throw new Error(`restore_identity_invalid:${name}`);
  }
  const artifact = parseArtifactSetDigest(artifactSetDigest);
  const identity = {
    version: 1, ledgerDigest, rolesDigest, schemaDigest, rowsDigest, ownersDigest, ledgerRowsDigest,
    ...(artifact === undefined ? {} : { artifactSetDigest: artifact }),
  };
  return { ...identity, identityDigest: `sha256:${sha256(canonical(identity))}` };
}

/**
 * @param {any} expected
 * @param {any} actual
 */
export function verifyRestoredIdentity(expected, actual) {
  if (typeof expected !== "object" || expected === null || typeof actual !== "object" || actual === null) {
    throw new Error("restore_identity_mismatch:shape");
  }
  for (const key of ["ledgerDigest", "rolesDigest", "schemaDigest", "rowsDigest", "ownersDigest",
      "ledgerRowsDigest", "identityDigest"]) {
    if (expected[key] !== actual[key]) throw new Error(`restore_identity_mismatch:${key}`);
  }
  if (JSON.stringify(expected.artifactSetDigest ?? null) !== JSON.stringify(actual.artifactSetDigest ?? null)) {
    throw new Error("restore_identity_mismatch:artifactSetDigest");
  }
  return true;
}
