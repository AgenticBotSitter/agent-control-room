// A measurement helper, not a test and not shipped: it runs the REAL allow-list
// over the REAL archive's `unzip -Z` listing and prints what the guards would see.
//
// It exists because the two numbers that decide the size ceiling and the
// symlink refusal are properties of the archive, and a guard whose value can
// only be obtained by unpacking 437 MB is a guard nobody re-measures after a
// pin bump. It is never imported by the runtime and never installed.
//
//   PG_RUNTIME_ARCHIVE=/path/to/postgresql.zip node --import tsx scripts/dev/pgrt-measure-archive.mts

import { execFileSync } from "node:child_process";
import { planPgRuntimeExtractionV1 } from "../../src/updater/v1/pg/pg-runtime-vendor.ts";

const archive = process.env.PG_RUNTIME_ARCHIVE;
if (!archive) {
  console.error("set PG_RUNTIME_ARCHIVE to the downloaded archive");
  process.exitCode = 1;
} else {
  // The stripped environment `vendorPgRuntimeV1` spawns `unzip` with, so this
  // tool reads the archive exactly as the vendor step does.
  const environment = { LANG: "C", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv;
  const listing = execFileSync("/usr/bin/unzip", ["-Z", archive],
    { encoding: "utf8", maxBuffer: 1 << 28, env: environment });
  const rows: Array<{ type: string; bytes: number; name: string }> = [];
  for (const line of listing.split("\n")) {
    // A long-listing row is `<mode> <version> <os> <size> …`; the archive header
    // and the summary line do not start with a mode.
    if (!/^[-dl][rwxsStTl-]{9}\s/.test(line)) continue;
    const size = Number(/^\S+\s+\S+\s+\S+\s+(\d+)\s/u.exec(line)![1]);
    // The name is after the time field, which is `HH:MM` or a date.
    const name = line.replace(/^.*\s\d{2}:\d{2}\s/u, "");
    rows.push({ type: line[0]!, bytes: size, name });
  }
  const selected = new Set(planPgRuntimeExtractionV1(rows.map(row => row.name)).files.map(file => file.archivePath));
  const selectedRows = rows.filter(row => selected.has(row.name) || selected.has(`${row.name}/`));
  const byType: Record<string, number> = {};
  for (const row of rows) byType[row.type] = (byType[row.type] ?? 0) + 1;
  const selectedBytes = selectedRows.reduce((sum, row) => sum + row.bytes, 0);
  console.log(JSON.stringify({
    rows: rows.length,
    byType,
    selected: selectedRows.length,
    selectedBytes,
    selectedMegabytes: Math.round(selectedBytes / 1e6),
    selectedNonRegular: selectedRows.filter(row => row.type !== "-" && row.type !== "d")
      .map(row => `${row.name} (${row.type})`),
    allBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
  }, null, 2));
}
