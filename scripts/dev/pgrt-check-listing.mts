// A check on the listing parser, against the REAL archive, run as a script.
//
// `parseArchiveRow` is the function findings 3 and 10 added, and it is the
// kind of code that can be wrong in a way no synthetic archive reveals: a
// character class that is a range rather than a list, or a column width that
// changes with the value. MEASURED, both happened while writing it, and both
// produced a plan of directories and no files.
//
// So this compares the parser's view of the pinned archive against
// `unzip -Z1`, which is the listing the code used before finding 3 and which
// this machine has always agreed with. Every name must match, and the counts
// and byte total are printed so a pin bump can be re-measured.
//
//   PG_RUNTIME_ARCHIVE=/path/to/postgresql.zip node --import tsx scripts/dev/pgrt-check-listing.mts
//
// It is a dev tool, not a test: it needs the 437 MB archive, which the lanes
// skip for when it is absent. The synthetic lanes cover the parser's shape.

import { execFileSync } from "node:child_process";

/** The stripped environment `unzip` is spawned with by the vendor step itself. */
const SAFE_ENVIRONMENT = { LANG: "C", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv;

const archive = process.env.PG_RUNTIME_ARCHIVE;
if (!archive) {
  console.error("set PG_RUNTIME_ARCHIVE to the downloaded archive");
  process.exitCode = 1;
} else {
  const listing = execFileSync("/usr/bin/unzip", ["-Z", archive],
    { encoding: "utf8", maxBuffer: 1 << 28, env: SAFE_ENVIRONMENT });
  const names = execFileSync("/usr/bin/unzip", ["-Z1", archive],
    { encoding: "utf8", maxBuffer: 1 << 28, env: SAFE_ENVIRONMENT })
    .split("\n").filter(Boolean);
  const { parsePgArchiveRowV1 } = await import("../../src/updater/v1/pg/pg-runtime-vendor.ts");
  const parsed = listing.split("\n").map(line => parsePgArchiveRowV1(line)).filter(entry => entry !== null);
  const parsedNames = new Set(parsed.map(entry => entry.name));
  const expected = new Set(names);
  const missing = names.filter(name => !parsedNames.has(name));
  const extra = parsed.filter(entry => !expected.has(entry.name));
  const byKind: Record<string, number> = {};
  for (const entry of parsed) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
  const selected = parsed.filter(entry =>
    /^pgsql\/(bin\/(postgres|initdb|pg_ctl|pg_controldata|psql|pg_dump|pg_restore|pg_basebackup|pg_verifybackup)$|lib\/lib[\w.+-]*\.dylib$|lib\/postgresql\/(plpgsql|dict_snowball)\.dylib$|share\/postgresql(\/|$))/u.test(entry.name));
  console.log(JSON.stringify({
    names: names.length,
    parsed: parsed.length,
    byKind,
    missingFromParser: missing.slice(0, 5),
    extraFromParser: extra.slice(0, 5).map(entry => `${entry.name} (${entry.kind})`),
    selectedMembers: selected.length,
    selectedBytes: selected.reduce((sum, entry) => sum + entry.bytes, 0),
    selectedNonRegular: selected.filter(entry => entry.kind !== "file" && entry.kind !== "directory")
      .map(entry => `${entry.name} (${entry.kind})`),
  }, null, 2));
  if (missing.length > 0 || extra.length > 0) process.exitCode = 1;
}
