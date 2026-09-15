// Stable database-restore identity consumed by #60/#61, plus the typed placeholder
// for #65's future artifact-set digest. The identity binds ledger digest, role/grant
// snapshot, schema digest, required-row hashes and the source database owner: a
// restored database is accepted only when every piece matches, including
// pg_database ownership. This module never copies artifacts and never
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
 * @param {{ ledgerDigest: string, rolesDigest: string, membershipsDigest: string, schemaDigest: string, rowsDigest: string, ownersDigest: string, ledgerRowsDigest: string, databaseOwnerDigest: string, artifactSetDigest?: unknown }} parts
 */
export function computeDatabaseRestoreIdentity({ ledgerDigest, rolesDigest, membershipsDigest, schemaDigest, rowsDigest, ownersDigest, ledgerRowsDigest, databaseOwnerDigest, artifactSetDigest }) {
  for (const [name, value] of [["ledgerDigest", ledgerDigest], ["rolesDigest", rolesDigest],
      ["membershipsDigest", membershipsDigest],
      ["schemaDigest", schemaDigest], ["rowsDigest", rowsDigest], ["ownersDigest", ownersDigest],
      ["ledgerRowsDigest", ledgerRowsDigest], ["databaseOwnerDigest", databaseOwnerDigest]]) {
    if (typeof value !== "string" || !DIGEST_RE.test(value)) throw new Error(`restore_identity_invalid:${name}`);
  }
  const artifact = parseArtifactSetDigest(artifactSetDigest);
  const identity = {
    version: 1, ledgerDigest, rolesDigest, membershipsDigest, schemaDigest, rowsDigest, ownersDigest, ledgerRowsDigest,
    databaseOwnerDigest,
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
  for (const key of ["ledgerDigest", "rolesDigest", "membershipsDigest", "schemaDigest", "rowsDigest", "ownersDigest",
      "ledgerRowsDigest", "databaseOwnerDigest", "identityDigest"]) {
    if (expected[key] !== actual[key]) throw new Error(`restore_identity_mismatch:${key}`);
  }
  if (JSON.stringify(expected.artifactSetDigest ?? null) !== JSON.stringify(actual.artifactSetDigest ?? null)) {
    throw new Error("restore_identity_mismatch:artifactSetDigest");
  }
  return true;
}
