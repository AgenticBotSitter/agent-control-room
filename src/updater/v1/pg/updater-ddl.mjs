// The updater's fixed DDL, read and digested by the install-night scripts.
//
// The two scripts need the DDL twice, for two different reasons: `init-database`
// applies the two installer files, and `apply-release-schema` runs the loader
// over all four. Both must read them from the INSTALLED bundle, never from the
// repository, because the bundle is the byte-identical build the owner confirmed
// and the repository is whatever a working copy currently holds.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const refuse = code => { throw new Error(code); };

/** One file, with its digest. `text` is what the caller executes. */
export async function readUpdaterDdlFileV1(directory, name) {
  if (typeof name !== "string" || !/^[0-9]{4}_[a-z0-9_]+\.sql$/u.test(name)) refuse("updater_ddl_file_refused");
  const text = await readFile(join(directory, name), "utf8");
  if (text.length === 0 || text.length > 4 * 1024 * 1024 || text.includes("\0")) refuse("updater_ddl_file_refused");
  return Object.freeze({ name, text, sha256: createHash("sha256").update(text).digest("hex") });
}

/** The named files, in the order given, each required to exist. */
export async function readUpdaterDdlFilesV1(directory, names) {
  if (!Array.isArray(names) || names.length === 0 || names.length > 32) refuse("updater_ddl_file_refused");
  return Object.freeze(await Promise.all(names.map(name => readUpdaterDdlFileV1(directory, name))));
}

/**
 * The digest the install journal records for the updater's schema.
 *
 * It is a digest of the FILE SET, not of the catalogue, and the reason is
 * timing. `init-database` records this before the release ledger has run, so at
 * that moment the schema holds a role and a schema and no tables; a catalogue
 * digest taken then would be a digest of near-emptiness, which a later health
 * check could not distinguish from a schema that had lost every table. The file
 * digest is stable, it is reviewable (a reviewer can recompute it from the
 * bundle), and it is the same value a second run produces, so it is usable as
 * the install record AND as the health-check comparison.
 *
 * The file NAMES are included, not just their bytes: two bundles with identical
 * bytes under different names would otherwise share a digest, and the order
 * matters because the loader's order is a security property (0000 refuses to run
 * before 0001).
 */
export function computeUpdaterDdlFileDigestV1(files) {
  if (!Array.isArray(files) || files.length === 0) refuse("updater_ddl_digest_refused");
  const parts = files.map(file => {
    if (typeof file?.name !== "string" || !/^[0-9]{4}_[a-z0-9_]+\.sql$/u.test(file.name)
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)) refuse("updater_ddl_digest_refused");
    return `${file.name}:${file.sha256}`;
  });
  if (new Set(parts).size !== parts.length) refuse("updater_ddl_digest_refused");
  return `sha256:${createHash("sha256").update(parts.join("\n")).digest("hex")}`;
}
