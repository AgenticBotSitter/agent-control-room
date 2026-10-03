#!/usr/bin/env node
// M4's mutation checks: break one guard at a time and confirm a test fails.
//
// The owner rule asks for mutation checks on every guard a stream adds, and the
// M1 round measured that a naive harness reports false PASSES: the runner emits
// TAP ("ok 1 -" / "# pass N") whenever a mutated module fails to LOAD, and a
// harness that reads only the spec reporter scores that as "the tests passed with
// the guard deleted". So this harness counts BOTH reporters, and a run that
// counts NEITHER is reported as UNVERIFIABLE rather than as a pass or a miss.
//
// Each entry is {name, file, find, replace, lane}. `lane` is the command that
// should go red. Both reporters are scored; a mutation is CAUGHT only when the
// lane reports at least one failure, and UNVERIFIABLE when it reports neither.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const ARCHIVE = process.env.PG_RUNTIME_ARCHIVE;

const MUTATIONS = [
  { name: "probe samples", file: "src/updater/v1/pg/first-owner-ports.mjs",
    covers: "checkHealth refuses a request that is not three samples",
    find: "    || input.samples !== FIRST_OWNER_HEALTH_SAMPLES_V1",
    replace: "    || !Number.isInteger(input.samples) || input.samples < 1",
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
];

/** Both reporters, because the runner picks one per run. */
/**
 * The counts, from EITHER reporter.
 *
 * MEASURED, and this is a third false-verdict bug in this harness: the regexes were
 * written as `/(?:^|\\n)ℹ fail (\\d+)/u`, where `\\n` and `\\d` are an escaped
 * BACKSLASH followed by `n`/`d` - so every pattern matched a literal backslash-n and
 * a literal backslash-d, found nothing in any real output, and the run reported
 * UNVERIFIABLE for all seventeen mutations. A harness whose parsers never match will
 * happily report a result; the guard that made that visible is the same one this
 * round needed twice, namely "if I cannot read the output, say so".
 *
 * So: `/\n/` (a real newline escape), and `\d`, and the check is `pass + fail > 0`
 * rather than "did a pattern match", because a reporter that prints nothing because
 * it printed nothing is the case that matters.
 */
function score(output) {
  const spec = /(?:^|\n)ℹ fail (\d+)/u.exec(output);
  const specPass = /(?:^|\n)ℹ pass (\d+)/u.exec(output);
  const specTests = /(?:^|\n)ℹ tests (\d+)/u.exec(output);
  const tapFail = /(?:^|\n)# fail (\d+)/mu.exec(output);
  const tapPass = /(?:^|\n)# pass (\d+)/mu.exec(output);
  const tapTests = /(?:^|\n)# tests (\d+)/mu.exec(output);
  const tapOk = /(?:^|\n)ok (\d+) - /u.exec(output);
  const tapNotOk = /(?:^|\n)not ok (\d+) - /u.exec(output);
  const pass = Number(specPass?.[1] ?? tapPass?.[1] ?? tapOk?.[1] ?? 0);
  const fail = Number(spec?.[1] ?? tapFail?.[1] ?? (tapNotOk ? 1 : 0));
  const tests = Number(specTests?.[1] ?? tapTests?.[1] ?? (tapOk || tapNotOk ? 1 : 0));
  return { pass, fail, tests, sawSummary: tests > 0 };
}

// `--list` prints each mutation's find-text presence WITHOUT running anything, so
// a stale find text is caught in a second rather than after twenty minutes of
// postmasters. MEASURED: three find texts were stale for two full runs because the
// only place the check lived was the run itself, and the run reported UNVERIFIABLE
// only after spending the time.
if (process.argv.includes("--list")) {
  let bad = 0;
  for (const mutation of MUTATIONS) {
    const text = readFileSync(ROOT + mutation.file, "utf8");
    const ok = text.includes(mutation.find);
    if (!ok) bad += 1;
    console.log(`${ok ? "ok      " : "STALE   "} ${mutation.name}${mutation.covers ? `  [${mutation.covers.slice(0, 46)}]` : ""}`);
  }
  console.log(`${MUTATIONS.length - bad} present, ${bad} stale`);
  process.exitCode = bad === 0 ? 0 : 1;
  process.exit(0);
}

let caught = 0, missed = 0, unverifiable = 0;
for (const mutation of MUTATIONS) {
  const path = ROOT + mutation.file;
  // READ FRESH PER MUTATION, and this is a fix rather than tidiness: an earlier
  // version read every file ONCE before the loop, so a file left mutated by an
  // INTERRUPTED previous run became the snapshot every later run "restored" — and
  // a guard deleted by the interrupted run was silently re-deleted on the next run,
  // which is how the 0600 mode check above went missing twice.
  const original = readFileSync(path, "utf8");
  if (!original.includes(mutation.find)) {
    console.log(`UNVERIFIABLE  ${mutation.name} (find text not present in ${mutation.file})`);
    unverifiable += 1; continue;
  }
  writeFileSync(path, original.replace(mutation.find, mutation.replace));
  let result;
  try {
    // `--test-name-pattern` binds the run to the ONE test that covers this guard.
    // Running all six tests per mutation builds six postmasters and costs ~3
    // minutes a mutation; one test costs one cluster. The pattern is a REGEX
    // matched against the test name, so it is anchored to avoid matching a
    // different test that shares a prefix.
    const lane = mutation.covers
      ? [...mutation.lane.slice(0, -1), `--test-name-pattern=^${mutation.covers.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
        mutation.lane[mutation.lane.length - 1]]
      : mutation.lane;
    result = spawnSync(lane[0], lane.slice(1), {
      cwd: ROOT, encoding: "utf8", timeout: 900_000,
      // `maxBuffer` IS THE REASON EVERY MUTATION READ "UNVERIFIABLE", and it is
      // worth recording because it is the fourth false verdict in one round and the
      // subtlest. node caps a child's captured output at 1 MB by default; a failing
      // PostgreSQL lane writes a stack trace per failed assertion, so the buffer
      // filled BEFORE the reporter's own summary was reached — and the summary is
      // the only part this harness scores. MEASURED: the raw tail with the guard
      // deleted contained `AssertionError … samples=1 must be refused`, which is a
      // CAUGHT mutation, while the harness reported UNVERIFIABLE.
      //
      // Sixteen megabytes, which is the same bound `control-room-native-ports.mjs`
      // uses for a comparable capture.
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PG_RUNTIME_ARCHIVE: ARCHIVE ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        CONTROL_ROOM_PGRT_PORT_BASE: process.env.CONTROL_ROOM_PGRT_PORT_BASE ?? "59930" },
    });
  } finally { writeFileSync(path, original); }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const counts = score(output);
  // A `--test-name-pattern` that matches NOTHING reports zero tests, and a
  // mutation then reads MISSED when in fact nothing ran. MEASURED: three
  // mutations were reported MISSED for exactly this reason - the `covers` name
  // named a test that did not exist (the samples guard's test is
  // "checkHealth refuses a request that is not three samples", not the counting
  // test). A mutation whose lane ran zero tests is UNVERIFIABLE, not MISSED.
  if (!counts.sawTests || counts.pass + counts.fail < 1) {
    console.log(`UNVERIFIABLE ${mutation.name} (the lane ran no tests: bad \`covers\` name?)`);
    unverifiable += 1; continue;
  }
  const verdict = result.status !== 0 || counts.fail > 0 ? "CAUGHT" : "MISSED";
  if (verdict === "CAUGHT") caught += 1; else missed += 1;
  console.log(`${verdict.padEnd(12)} ${mutation.name}`);
}
console.log(`\n${caught} caught, ${missed} missed, ${unverifiable} unverifiable, of ${MUTATIONS.length}`);
process.exitCode = missed === 0 && unverifiable === 0 ? 0 : 1;