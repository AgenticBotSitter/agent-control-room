// Runs every mutation check in one manifest against a worktree and reports which
// ones a test did NOT catch. A mutation that survives is a guard with no proof.
//
// This is a local tool, not a lane: the manifests name their own test command, and
// the point is to run them the way a reviewer would, one at a time, with the tree
// restored afterwards. It never leaves the worktree dirty: each mutation is applied
// with an exact-string replace, and the file is written back from the bytes read
// before the mutation, so a killed run cannot leave a mutated file behind.
//
// Usage: node scripts/run-mutation-manifest.mjs mutation-checks/cook-health.json
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifests = process.argv.slice(2);
if (manifests.length === 0) {
  console.error("usage: node scripts/run-mutation-manifest.mjs <manifest.json>...");
  process.exit(2);
}

/** Runs one command to completion. Exit 0 is a CAUGHT mutation, non-zero is a
 *  SURVIVOR, which is the result that matters. */
const run = command => new Promise(resolveRun => {
  const child = spawn("sh", ["-c", command], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.on("close", code => resolveRun({ code: code ?? 1, output }));
});

const survivors = [];
let applied = 0;
for (const manifest of manifests) {
  const entries = JSON.parse(await readFile(resolve(root, manifest), "utf8"));
  for (const [index, entry] of entries.entries()) {
    const path = join(root, entry.file);
    const before = await readFile(path, "utf8");
    if (!before.includes(entry.find)) {
      survivors.push({ manifest, index, why: `anchor not found in ${entry.file}`, entry });
      continue;
    }
    // One occurrence only: a manifest whose `find` appears twice is ambiguous, and
    // replacing all of them would mutate code the entry does not mean to cover.
    if (before.split(entry.find).length - 1 !== 1) {
      survivors.push({ manifest, index, why: `anchor is not unique in ${entry.file}`, entry });
      await writeFile(path, before);
      continue;
    }
    const mutated = before.replace(entry.find, entry.replace);
    try {
      await writeFile(path, mutated);
      const { code } = await run(entry.test);
      if (code === 0) survivors.push({ manifest, index, why: "NOT CAUGHT: the test still passed", entry });
      else applied += 1;
    } finally {
      // Restored in a finally, so a failing or interrupted run cannot leave a
      // mutated guard in the worktree for the next reviewer to find.
      await writeFile(path, before);
    }
  }
}
console.log(`mutation checks: ${applied} caught, ${survivors.length} surviving`);
for (const survivor of survivors) {
  console.log(`  ${survivor.manifest}[${survivor.index}] ${survivor.why}`);
  console.log(`    why it exists: ${survivor.entry.why}`);
}
process.exit(survivors.length === 0 ? 0 : 1);
