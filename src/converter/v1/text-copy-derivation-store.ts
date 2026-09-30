// The production adapter for the text-copy converter port.
//
// The converter (src/converter/v1) produces bytes and knows nothing about
// storage. This is the seam: it takes a `TextCopyDerivationResult` and records
// it, so MIG-E's record exists without the converter ever learning that a
// database exists.
//
// Two rules shape the whole file:
//
//   * The result is STORED, not recomputed. A caller that hands this adapter a
//     result whose converter identity does not match the port that produced it,
//     or whose bytes have changed since, is refused rather than recorded. A
//     derivation that lies about its own provenance is worse than no
//     derivation, because the owner would read it as a fact.
//
//   * The derived bytes are written through the result-file catalog, not here.
//     This adapter never invents a catalog file; it names one that the caller
//     already published, and the database verifies the digest and the set. That
//     is what 0212's insert guard is for, and duplicating the check here would
//     be a second source of truth that could disagree with the first.

import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../persistence/database";
import {
  type TextCopyConverterIdentity,
  type TextCopyDerivationResult,
} from "./text-copy-port.ts";

/** A file the caller has already published into the result-file catalog. */
export interface PublishedDerivedFile {
  readonly tenantId: string;
  readonly setId: string;
  readonly fileId: string;
  readonly contentDigest: `sha256:${string}`;
  readonly sizeBytes: number;
}

export interface RecordDerivationRequest {
  readonly tenantId: string;
  /** The catalog file the conversion read. */
  readonly source: PublishedDerivedFile;
  /**
   * The derived file, present only on success.
   *
   * It must be in the same set as the source, and it must be a different file
   * with a different digest: a text copy of an HTML page is a different
   * document from the page, and a row that claimed otherwise would be asserting
   * something false about the conversion.
   */
  readonly derived?: PublishedDerivedFile;
  /** Exactly the result the converter port returned, unaltered. */
  readonly result: TextCopyDerivationResult;
}

export interface RecordDerivationSuccess {
  readonly derivationId: string;
  /** True when the uniqueness fence already held this exact derivation. */
  readonly reused: boolean;
}

export class TextCopyDerivationRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TextCopyDerivationRefused";
  }
}

function refuse(code: string, detail: string): never {
  throw new TextCopyDerivationRefused(code, detail);
}

const converterIdOf = (identity: TextCopyConverterIdentity): string => identity.id;
const converterVersionOf = (identity: TextCopyConverterIdentity): string => identity.version;

function validIdentity(identity: TextCopyConverterIdentity | undefined): identity is TextCopyConverterIdentity {
  return typeof identity?.id === "string" && typeof identity?.version === "string"
    && /^[a-z0-9][a-z0-9.-]{0,62}$/u.test(identity.id)
    && /^[0-9]+\.[0-9]+\.[0-9]+$/u.test(identity.version);
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

/**
 * A derivation id DERIVED from what the row says, in the same spirit as the
 * catalog's own identifiers: the same conversion of the same bytes by the same
 * converter is always the same id, so a retry that races itself cannot create
 * two rows, and the id leaks nothing about any other tenant's work.
 */
export function deriveDerivationId(
  tenantId: string,
  sourceFileId: string,
  sourceContentDigest: string,
  identity: TextCopyConverterIdentity,
): string {
  const material = [
    "control-room.text-copy-derivation/v1",
    tenantId, sourceFileId, sourceContentDigest,
    converterIdOf(identity), converterVersionOf(identity),
  ].join(":");
  return `derivation:${createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * Record one finished conversion.
 *
 * The whole method is one INSERT ... ON CONFLICT DO NOTHING followed by a
 * re-read, and the reason is the uniqueness fence. Two callers converting the
 * same bytes with the same converter version at the same time must produce ONE
 * row, and the loser of that race must be told it reused a row rather than
 * being handed a unique-violation error it cannot distinguish from a real
 * refusal. A `DO NOTHING` that is not followed by a read would report success
 * for a row that was never written.
 */
export async function recordTextCopyDerivation(
  db: DatabaseClient,
  request: RecordDerivationRequest,
): Promise<RecordDerivationSuccess> {
  const { tenantId, source, derived, result } = request;

  if (typeof tenantId !== "string" || tenantId.length === 0) refuse("derivation_tenant_missing", "a derivation needs a tenant");
  if (!DIGEST.test(source?.contentDigest ?? "")) refuse("derivation_source_digest_invalid", "the source digest is not a sha256 digest");
  if (!Number.isSafeInteger(source?.sizeBytes) || source.sizeBytes < 0) {
    refuse("derivation_source_size_invalid", "the source size is not a byte count");
  }
  if (!validIdentity(result?.converter)) refuse("derivation_converter_identity_invalid", "the converter identity is not a well-formed id and version");
  if (result?.status !== "succeeded" && result?.status !== "no_text_copy") {
    refuse("derivation_status_invalid", `unknown status ${JSON.stringify(result?.status)}`);
  }
  if (!DIGEST.test(result?.sourceDigest ?? "")) refuse("derivation_result_digest_invalid", "the converter reported a source digest that is not a sha256 digest");

  // The converter hashed the bytes it was given. If that digest is not the
  // catalog file's digest, the row would describe one file's conversion while
  // citing another file's identity — so it is refused here as well as by the
  // database, because an early refusal names the actual mismatch.
  if (result.sourceDigest !== source.contentDigest) {
    refuse("derivation_source_digest_mismatch",
      `the converter hashed ${result.sourceDigest} but the catalog file is ${source.contentDigest}`);
  }

  // A success and a failure are different shapes, and the adapter refuses to
  // build the wrong one rather than letting a CHECK reject it: a caller that got
  // this wrong has a bug, and the database error would not say which half.
  if (result.status === "succeeded") {
    if (!derived) refuse("derivation_derived_file_missing", "a succeeded conversion must name the file it produced");
    if (derived.setId !== source.setId) refuse("derivation_set_mismatch", "the derived file must be in the source's set");
    if (derived.fileId === source.fileId) refuse("derivation_source_is_derived", "the derived file must differ from the source file");
    if (!DIGEST.test(derived.contentDigest)) refuse("derivation_derived_digest_invalid", "the derived digest is not a sha256 digest");
    if (derived.contentDigest === source.contentDigest) {
      refuse("derivation_identical_digests", "a text copy cannot be byte-identical to its source");
    }
    if (result.diagnosticCategory !== "none") {
      refuse("derivation_success_with_diagnostic", "a succeeded conversion must carry the 'none' diagnostic");
    }
  } else {
    if (derived) refuse("derivation_refusal_with_file", "a refused conversion has no derived file");
    if (typeof result.diagnosticCategory !== "string" || result.diagnosticCategory.length === 0) {
      refuse("derivation_diagnostic_missing", "a refused conversion must name a diagnostic");
    }
  }

  const derivationId = deriveDerivationId(tenantId, source.fileId, source.contentDigest, result.converter);
  const now = new Date();
  // "none" is the converter's own spelling for "there is nothing to explain",
  // and the schema stores that as NULL: a success has no diagnostic to record,
  // and a nullable column is what says so. Writing the literal 'none' instead
  // trips control_text_copy_derivations_success_has_no_diagnostic — which is the
  // schema being right and this adapter being wrong about the vocabulary.
  const diagnostic = result.status === "succeeded" ? null : result.diagnosticCategory;

  // TWO unique indexes can be violated by one insert and no single ON CONFLICT
  // clause can arbitrate both, so the insert is attempted plainly and each
  // unique violation is interpreted:
  //
  //   * the derived primary key collides only when another writer of the SAME
  //     conversion won the race — which is measured, not assumed: 20 concurrent
  //     writers all compute the same id, so 19 of them collide there and not on
  //     the fence;
  //   * the fence collides when a row already exists for this source digest and
  //     converter, whatever id it carries.
  //
  // Both mean the same thing to the caller: this derivation is already recorded.
  // A `DO NOTHING` naming one arbiter raised
  // "duplicate key value violates unique constraint
  // control_text_copy_derivations_pkey" on the other index, and naming the
  // fence instead raised the same for the primary key. Both were found by
  // running 20 concurrent writers against real PostgreSQL.
  const uniqueViolation = (error: unknown): boolean =>
    (error as { code?: string })?.code === "23505";

  let inserted = { rows: [] as Array<{ derivation_id: string }> };
  try {
    inserted = await db.query<{ derivation_id: string }>(`
      INSERT INTO control_text_copy_derivations (
        tenant_id, derivation_id, source_file_id, source_set_id,
        source_content_digest, source_size_bytes, converter_id, converter_version,
        status, diagnostic_category, derived_file_id, derived_set_id,
        derived_content_digest, derived_size_bytes, created_at, completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
      RETURNING derivation_id`,
    [tenantId, derivationId, source.fileId, source.setId,
      source.contentDigest, source.sizeBytes,
      converterIdOf(result.converter), converterVersionOf(result.converter),
      result.status, diagnostic,
      derived?.fileId ?? null, derived?.setId ?? null,
      derived?.contentDigest ?? null, derived?.sizeBytes ?? null,
      now.toISOString()]);
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
  }

  if (inserted.rows.length > 0) {
    return { derivationId: inserted.rows[0]!.derivation_id, reused: false };
  }

  // Either index held. Re-read so the caller is told WHICH row it reused, rather
  // than reporting a success for a row that may not exist.
  const existing = await db.query<{ derivation_id: string }>(`
    SELECT derivation_id FROM control_text_copy_derivations
     WHERE tenant_id=$1 AND source_file_id=$2 AND source_content_digest=$3
       AND converter_id=$4 AND converter_version=$5`,
  [tenantId, source.fileId, source.contentDigest,
    converterIdOf(result.converter), converterVersionOf(result.converter)]);
  const row = existing.rows[0];
  if (!row) {
    // A unique violation with no readable row means the collision was on a
    // constraint this adapter does not own, which is a real fault rather than a
    // race worth retrying.
    refuse("derivation_fence_lost",
      "the insert collided but no row matching this derivation could be read back");
  }
  return { derivationId: row.derivation_id, reused: true };
}

/**
 * The owner's per-project read. Deliberately the VIEW and not the table, so the
 * caller's own authority decides which projects resolve and the row it gets
 * already carries the source file's display name.
 */
export async function readProjectTextCopyDerivations(
  db: DatabaseClient,
  scope: { tenantId: string; projectId: string },
): Promise<Array<{
  derivationId: string;
  sourceFileId: string;
  sourceDisplayName: string | null;
  sourceState: string | null;
  converterId: string;
  converterVersion: string;
  status: string;
  diagnosticCategory: string | null;
  derivedFileId: string | null;
  derivedContentDigest: string | null;
  derivedSizeBytes: number | null;
}>> {
  if (typeof scope?.tenantId !== "string" || typeof scope?.projectId !== "string") {
    refuse("derivation_read_scope_invalid", "a read needs a tenant and a project");
  }
  const rows = await db.query<{
    derivation_id: string; source_file_id: string; source_display_name: string | null;
    source_state: string | null; converter_id: string; converter_version: string;
    status: string; diagnostic_category: string | null; derived_file_id: string | null;
    derived_content_digest: string | null; derived_size_bytes: string | null;
  }>(`
    SELECT derivation_id, source_file_id, source_display_name, source_state,
           converter_id, converter_version, status, diagnostic_category,
           derived_file_id, derived_content_digest, derived_size_bytes
      FROM control_project_text_copy_derivations
     WHERE tenant_id=$1 AND project_id=$2
     ORDER BY created_at DESC`,
  [scope.tenantId, scope.projectId]);
  return rows.rows.map(row => ({
    derivationId: row.derivation_id,
    sourceFileId: row.source_file_id,
    sourceDisplayName: row.source_display_name,
    sourceState: row.source_state,
    converterId: row.converter_id,
    converterVersion: row.converter_version,
    status: row.status,
    diagnosticCategory: row.diagnostic_category,
    derivedFileId: row.derived_file_id,
    derivedContentDigest: row.derived_content_digest,
    derivedSizeBytes: row.derived_size_bytes === null ? null : Number(row.derived_size_bytes),
  }));
}
