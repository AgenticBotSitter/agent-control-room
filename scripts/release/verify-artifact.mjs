// Artifact integrity verifier: recomputes every hash in a release manifest.
// Read-only; exits 0 only when every listed file matches.
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { MANIFEST_NAME, sha256File } from "./build-release.mjs";

// Returns { ok, checked, problems[] }. Never throws on content mismatch —
// mismatch is data, reported in problems.
export function verifyManifest({ repoRoot = resolve("."), manifestPath } = {}) {
  const problems = [];
  const root = resolve(repoRoot);
  const manifestFile = manifestPath || join(root, "dist-release", MANIFEST_NAME);
  if (!existsSync(manifestFile)) return { ok: false, checked: 0, problems: ["manifest_missing"] };
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile, "utf8")); }
  catch { return { ok: false, checked: 0, problems: ["manifest_unreadable"] }; }
  if (manifest.schema !== "control-room.release-manifest/v1" || !Array.isArray(manifest.files)) {
    return { ok: false, checked: 0, problems: ["manifest_schema_invalid"] };
  }
  let checked = 0;
  for (const entry of manifest.files) {
    const full = join(root, entry.path);
    if (!existsSync(full) || !statSync(full).isFile()) { problems.push(`missing:${entry.path}`); continue; }
    const st = statSync(full);
    if (st.size !== entry.bytes) { problems.push(`size:${entry.path}`); continue; }
    if (sha256File(full) !== entry.sha256) { problems.push(`hash:${entry.path}`); continue; }
    checked++;
  }
  return { ok: problems.length === 0, checked, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node scripts/release/verify-artifact.mjs [--artifact <dir>]");
    process.exit(0);
  }
  const i = args.indexOf("--artifact");
  const manifestPath = i === -1 ? undefined : join(resolve(args[i + 1] || "dist-release"), MANIFEST_NAME);
  const result = verifyManifest({ manifestPath });
  console.log(`artifact: ${result.ok ? "OK" : "MISMATCH"} (${result.checked} files verified)`);
  for (const p of result.problems) console.log(`  ${p}`);
  process.exit(result.ok ? 0 : 1);
}
