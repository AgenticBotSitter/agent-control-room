#!/usr/bin/env node
// Run each mutation entry from a manifest against its own `test` command, in
// the worktree, restoring the file afterwards. Temporary: the branch-scoped
// runner in scripts/ci/verify-mutation-checks.mjs needs CI environment
// variables to pick a manifest, which a local cook-mode worktree does not have.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const manifest = process.argv[2];
const only = process.argv[3] ? Number(process.argv[3]) : null;
const entries = JSON.parse(readFileSync(manifest, "utf8"));
let pass = 0, fail = 0, skipped = 0;
const results = [];
entries.forEach((entry, index) => {
  if (only !== null && index !== only) { skipped++; return; }
  const original = readFileSync(entry.file, "utf8");
  if (!original.includes(entry.find)) {
    results.push(`[${index}] SKIP  ${entry.file} -- find string not present`);
    skipped++;
    return;
  }
  writeFileSync(entry.file, original.replace(entry.find, entry.replace));
  try {
    const run = spawnSync("bash", ["-lc", entry.test], { encoding: "utf8", timeout: 15 * 60 * 1000 });
    const code = run.status ?? 1;
    if (code === 0) { results.push(`[${index}] NOT DETECTED  ${entry.file}\n    ${entry.test}`); fail++; }
    else { results.push(`[${index}] detected (exit ${code})  ${entry.file}`); pass++; }
  } finally {
    writeFileSync(entry.file, original);
  }
});
console.log(results.join("\n\n"));
console.log(`\nmutation entries: ${pass} detected, ${fail} NOT detected, ${skipped} skipped of ${entries.length}`);
process.exit(fail > 0 ? 1 : 0);
