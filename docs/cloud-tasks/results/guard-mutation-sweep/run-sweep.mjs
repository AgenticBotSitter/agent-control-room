// Applies each hand-written guard mutation one at a time, runs the guard's own
// tests, records the exit code, and restores the guard byte for byte.
// Usage, from the repository root on a clean checkout:
//   node docs/cloud-tasks/results/guard-mutation-sweep/run-sweep.mjs [--baseline] [--only ID,ID] [--out results.json]
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mutations, suites } from "./mutations.mjs";

const args = process.argv.slice(2);
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;

function run(command) {
  const started = Date.now();
  const result = spawnSync("bash", ["-c", command], {
    encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined},
  });
  return { status: result.status ?? (result.signal ? `signal:${result.signal}` : 1),
    ms: Date.now() - started, tail: `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-6).join("\n"),
    failed: [...new Set(String(result.stdout).split("\n").filter(l => /^\s*not ok \d+ - /.test(l)).map(l => l.replace(/^\s*not ok \d+ - /, "").trim()))] };
}

const records = [];
if (args.includes("--baseline")) {
  for (const [name, command] of Object.entries(suites)) {
    const r = run(command);
    records.push({ id: `baseline:${name}`, suite: name, command, status: r.status, ms: r.ms });
    console.log(`baseline ${name}: exit=${r.status} (${r.ms}ms)`);
    if (r.status !== 0) console.log(r.tail);
  }
}
for (const m of mutations) {
  if (only && !only.has(m.id)) continue;
  const original = readFileSync(m.file, "utf8");
  const count = original.split(m.from).length - 1;
  if (count !== 1) { console.log(`${m.id}: SKIPPED, anchor occurs ${count} times`); records.push({ ...m, status: "anchor", verdict: "invalid" }); continue; }
  writeFileSync(m.file, original.replace(m.from, () => m.to));
  let r;
  try { r = run(suites[m.suite]); }
  finally { writeFileSync(m.file, original); }
  const verdict = r.status === 0 ? "SURVIVED" : "caught";
  records.push({ id: m.id, suite: m.suite, file: m.file, kind: m.kind, what: m.what, status: r.status, verdict, ms: r.ms, failed: r.failed });
  console.log(`${m.id} [${m.kind}] ${m.file}: exit=${r.status} ${verdict} (${r.ms}ms) - ${m.what}`);
}
if (out) writeFileSync(out, JSON.stringify(records, null, 2) + "\n");
const dirty = spawnSync("git", ["status", "--porcelain", "--", "scripts"], { encoding: "utf8" }).stdout.trim();
if (dirty) { console.error(`guard files not restored:\n${dirty}`); process.exitCode = 2; }
