// Fails when a test file exists that no package.json script reaches.
//
// The CI workflow names the lanes it runs rather than globbing, so what executes
// stays reviewable. The cost of that choice is drift: a new test file is written,
// reviewed, committed, and then never runs, because nobody remembered to add it
// to a lane. That is worse than no test, because the repository looks covered.
//
// This closes that gap without giving up the named lanes. Adding a test now
// requires putting it in a lane, which is a deliberate act someone reviews.
//
// It checks reachability from scripts, not from the workflow. A lane that exists
// but is never invoked by a job would still pass here - the workflow comment
// carries that rule, and the job list is short enough to read.
import { readdirSync, readFileSync } from "node:fs";

const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts ?? {};

/** A lane may chain other lanes with `pnpm test:x`; follow those too. */
function expand(name, seen = new Set()) {
  if (seen.has(name)) return "";
  seen.add(name);
  let body = scripts[name] ?? "";
  for (const [, referenced] of body.matchAll(/pnpm (?:run )?([a-z][a-z0-9:.-]*)/g)) {
    body += ` ${expand(referenced, seen)}`;
  }
  return body;
}

const reachable = Object.keys(scripts).map(name => expand(name)).join(" ");
const orphans = readdirSync("tests")
  .filter(file => /\.test\.(ts|tsx|mjs|js)$/.test(file))
  .map(file => `tests/${file}`)
  .filter(file => !reachable.includes(file))
  .sort();

if (orphans.length > 0) {
  console.error(`${orphans.length} test file(s) are not reachable from any package.json script:`);
  for (const file of orphans) console.error(`  ${file}`);
  console.error("\nAdd each to a named lane in package.json. Do not delete this check to make it pass.");
  process.exit(1);
}
console.log(`all ${readdirSync("tests").filter(f => /\.test\./.test(f)).length} test files are reachable from a lane`);
