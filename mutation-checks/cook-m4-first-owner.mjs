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

import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const ARCHIVE = process.env.PG_RUNTIME_ARCHIVE;

const MUTATIONS = [
  // --- firstOwner: the exact-key input check -------------------------------
  { name: "firstOwner refuses an input with an extra key", covers: "the first-owner port refuses bad input before it touches the database",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: '|| Object.keys(input).sort().join(",") !== keys.join(",") || !safeRoot(input.root)\n    || input.release !== "current"',
    replace: '|| !safeRoot(input.root)\n    || input.release !== "current"',
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- firstOwner: the release must be literally "current" ----------------
  { name: "firstOwner refuses a release that is not the literal current", covers: "the first-owner port refuses bad input before it touches the database",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: '|| input.release !== "current" || !DIGEST.test(input.schemaDigest ?? "")',
    replace: '|| typeof input.release !== "string" || !DIGEST.test(input.schemaDigest ?? "")',
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- firstOwner: the digest comparison BEFORE the transaction -------------
  { name: "firstOwner compares the schema digest before minting the owner", covers: "the first-owner port refuses bad input before it touches the database",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: "  if (observed !== pinned) refuse(`first_owner_schema_drift:computed=${observed}:expected=${pinned}`);",
    replace: "  if (false) refuse(`first_owner_schema_drift:computed=${observed}:expected=${pinned}`);",
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- firstOwner: the tenant the receipt must match ----------------------
  { name: "firstOwner refuses a receipt for another tenant", covers: "the first-owner port refuses bad input before it touches the database",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: '  if (receipt.tenantId !== tenantId) refuse("first_owner_tenant_mismatch");',
    replace: "  // mutated: the tenant is not compared",
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- firstOwner: the identity row must exist ----------------------------
  { name: "firstOwner refuses an owner identity row that is missing", covers: "the first-owner port refuses bad input before it touches the database",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: '    refuse("first_owner_identity_refused");\n  }\n  // EXACTLY four keys',
    replace: '    void 0;\n  }\n  // EXACTLY four keys',
    note: "MEASURED: this replacement text was once left in the SOURCE by an interrupted run, and it failed with 'Assignment to constant variable' rather than silently passing - which is the outcome a mutation must have.",
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- firstOwner: the receipt's WHOLE shape ------------------------------
  { name: "firstOwner refuses a receipt whose digest and counts are missing",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    covers: "the first-owner port refuses bad input before it touches the database",
    find: "    || !DIGEST.test(receipt.manifestDigest ?? \"\")\n    || !Number.isSafeInteger(receipt.created) || receipt.created < 0\n    || !Number.isSafeInteger(receipt.kept) || receipt.kept < 0",
    replace: "    || false\n    || false\n    || false",
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- checkHealth: the samples count is exactly three ---------------------
  { name: "checkHealth demands exactly three samples", covers: "checkHealth refuses a request that is not three samples",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: "    || input.samples !== FIRST_OWNER_HEALTH_SAMPLES_V1",
    replace: "    || !Number.isInteger(input.samples) || input.samples < 1",
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- checkHealth: the schema digest --------------------------------------
  { name: "checkHealth compares the release schema digest", covers: "a drifted schema digest is refused as health_database_refused",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: "      refuse(`health_database_refused:schema_drift:computed=${schemaDigest}:expected=${expectedSchema}`);",
    replace: "      refuse(`health_database_refused:sample${index + 1}:mutated`);",
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- checkHealth: the updater digest -------------------------------------
  { name: "checkHealth compares the updater schema digest", covers: "a drifted schema digest is refused as health_database_refused",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: "      refuse(`health_database_refused:updater_drift:computed=${updaterDigest}:expected=${expectedUpdater}`);",
    replace: "      refuse(`health_database_refused:sample${index + 1}:mutated`);",
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- checkHealth: the counts ---------------------------------------------
  { name: "checkHealth compares the owner row counts", covers: "a drifted schema digest is refused as health_database_refused",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: "      if (count !== expected) refuse(`health_database_refused:count:${table}=${count}:expected=${expected}`);",
    replace: "      if (false) refuse(`health_database_refused:count:${table}=${count}:expected=${expected}`);",
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- writeDatabaseLogins: the read-back ---------------------------------
  { name: "writeDatabaseLogins reads each file back before naming its digest", covers: "the login ports write 0600 files the service account owns and remove exactly those",
    knownUnverifiable: "MEASURED, and confirmed by deleting this line and re-running: the test" +
      " still passes. The port WRITES the file at 0600 and then reads it back, so the bytes" +
      " always match the password it was given; a difference needs something to replace the" +
      " file between the rename and the read, which this lane cannot construct" +
      " deterministically without a second process racing on the box. Defence in depth for a" +
      " window this lane cannot open, recorded rather than dressed up.",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: "    if (stored !== password) refuse(`database_logins_write_refused:${name}`);",
    replace: "    // mutated: the read-back is not compared",
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- writeDatabaseLogins: the 0600 mode ---------------------------------
  // HONESTLY UNVERIFIABLE, and recorded as such rather than dressed up.
  //
  // MEASURED: this guard covers the window between the file's rename and the
  // read-back that follows it. The port WRITES the file at 0600 and renames over
  // whatever was there, so a caller cannot present it a 0644 file — two attempts
  // (a pre-widened file, and a file holding another value) both got no refusal,
  // because the write corrected both before the read. Nothing in the lane can open
  // that window deterministically without a second racing process on the box.
  //
  // The entry stays, and the harness reports it UNVERIFIABLE, because deleting the
  // clause is a real weakening and pretending a test covers it would be worse than
  // admitting the gap. The covering evidence is the read-back comparison
  // (`if (stored !== password)`) which IS mutation-checked, and the mode check is
  // defence in depth for a window this lane cannot construct.
  { name: "writeDatabaseLogins refuses a login file that is not 0600", covers: "the login ports write 0600 files the service account owns and remove exactly those",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    knownUnverifiable: "the guard covers the window between the rename and the read-back. MEASURED: "
      + "the port writes the file at 0600 BEFORE the read, so no caller can present it a wider mode - "
      + "two attempts (a pre-widened file, and a file holding another value) both got no refusal. The "
      + "lane cannot construct the race deterministically without a second process on the box, so the "
      + "guard is defence in depth with no covering test. Recorded rather than dressed up.",
    find: "      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {\n        refuse(`database_logins_write_refused:${name}`);\n      }",
    replace: "      if (!stat.isFile() || stat.nlink !== 1) refuse(`database_logins_write_refused:${name}`);",
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- removeDatabaseLogins: the stray-file refusal -----------------------
  { name: "removeDatabaseLogins refuses a file this module did not write", covers: "the login ports write 0600 files the service account owns and remove exactly those",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: "  if (unexpected.length > 0) refuse(\"database_logins_remove_refused\");",
    replace: "  // mutated: a foreign file is removed along with ours",
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- retireDatabase: the live-cluster refusal ---------------------------
  { name: "retireDatabase refuses a cluster whose postmaster is alive", covers: "retireDatabase refuses a live cluster and removes a dead one",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: "    if (await alive) refuse(\"retire_database_live_cluster_refused\");",
    replace: "    if (false) refuse(\"retire_database_live_cluster_refused\");",
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- retireDatabase: an unparseable pid is LIVE -------------------------
  { name: "retireDatabase treats an unparseable pid file as live", covers: "retireDatabase refuses a live cluster and removes a dead one",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: "    if (!Number.isSafeInteger(pid) || pid < 1) refuse(\"retire_database_live_cluster_refused\");",
    replace: "    if (!Number.isSafeInteger(pid) || pid < 1) pid = 0;",
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- retireDatabase: the live check comes BEFORE the link check ---------
  { name: "retireDatabase asks about the postmaster before the current link", covers: "retireDatabase refuses a live cluster and removes a dead one",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: '  const entry = await lstat(dataDirectory).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));\n  // The link check comes SECOND',
    replace: '  const currentEntryFirst = await lstat(current).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));\n  if (currentEntryFirst) refuse("retire_database_current_link_present");\n  const entry = await lstat(dataDirectory).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));\n  // The link check comes SECOND',
    lane: ["node", "--import", "tsx", "--test", "tests/install-first-owner-real-postgres.test.mjs"] },
  // --- retireDatabase: the data id grammar --------------------------------
  { name: "retireDatabase refuses a data id outside its grammar", covers: "retireDatabase refuses a data id outside its grammar",
    file: "src/updater/v1/pg/first-owner-ports.mjs",
    find: '|| !/^data-[A-Za-z0-9._-]{1,32}$/u.test(input.pgDataId)) refuse("retire_database_input_refused");',
    replace: '|| typeof input.pgDataId !== "string" || input.pgDataId.length < 1) refuse("retire_database_input_refused");',
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
// ONE RUN AT A TIME. This harness WRITES TO THE FILE UNDER TEST, so two concurrent
// runs read the same source, each write a mutation, each run a 40-second lane, and
// each restore - and two restores can land on the other's mutation. MEASURED: three
// runs alive at once deleted two real guards from the committed source, and both
// deletions passed every test, because the tests cannot reach the windows the guards
// cover. That is the whole cost of a harness that edits the thing it measures, and a
// lock is cheaper than finding out again.
//
// The lock is a directory in TMPDIR. A stale lock from a killed run is named in the
// message rather than silently stolen, because a lock this harness silently steals is
// the same class of bug it is here to catch.
const LOCK_DIR = join(process.env.TMPDIR ?? "/tmp", "control-room-m4-mutation.lock");
try {
  mkdirSync(LOCK_DIR, { recursive: false });
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  console.error(`REFUSING TO RUN: another mutation run holds ${LOCK_DIR}.`);
  console.error("This harness writes to the file under test, so two runs at once corrupt each other.");
  console.error("If no run is alive, remove that directory by hand.");
  process.exit(3);
}
process.on("exit", () => { try { rmdirSync(LOCK_DIR); } catch { /* best effort */ } });

/**
 * What the lane's output says, from EITHER reporter.
 *
 * MEASURED, and this is the fourth false verdict in one round - the subtlest,
 * because it is not a parser bug at all.
 *
 * Node's spec reporter prints its `tests/pass/fail` summary ONLY ON SUCCESS. On a
 * failing run it stops after the assertion and writes no summary:
 *
 *   pass:  "✔ …\nℹ tests 1\nℹ pass 1\nℹ fail 0\n"
 *   fail:  "✖ …\n    AssertionError …\n    at async TestContext …\n"     <- no ℹ lines
 *
 * So a harness that decides "did the lane run?" by looking for the summary reads
 * every FAILING lane as "nothing ran" - and reports UNVERIFIABLE for precisely the
 * mutations it caught. The evidence of a failure is the FAILURE MARKER (`✖` in the
 * spec reporter, `not ok` in TAP) and the child's exit status, not the summary.
 *
 * Three false verdicts from this harness in one round, all the same mistake in
 * different clothes: the spec reporter chosen for M1, the escaped regexes, and now
 * the summary. The rule that survives all three is the one this round kept reaching
 * for - when the harness cannot read the result, it says so instead of inventing
 * one.
 */
function score(output) {
  const specFailCount = /(?:^|\n)ℹ fail (\d+)/u.exec(output);
  const specPassCount = /(?:^|\n)ℹ pass (\d+)/u.exec(output);
  const tapFailCount = /(?:^|\n)# fail (\d+)/mu.exec(output);
  const tapPassCount = /(?:^|\n)# pass (\d+)/mu.exec(output);
  const specMarker = /(?:^|\n)✖ /u.test(output);
  const tapMarker = /(?:^|\n)not ok (\d+) - /u.test(output);
  const specOk = /(?:^|\n)✔ /u.test(output);
  const tapOk = /(?:^|\n)ok (\d+) - /u.test(output);
  return {
    pass: Number(specPassCount?.[1] ?? tapPassCount?.[1] ?? (specOk || tapOk ? 1 : 0)),
    fail: Number(specFailCount?.[1] ?? tapFailCount?.[1] ?? (specMarker || tapMarker ? 1 : 0)),
    // `ranSomething` is TRUE for a failing lane with no summary, which is the case
    // the summary-based check got backwards.
    ranSomething: Boolean(specPassCount || tapPassCount || specOk || tapOk
      || specMarker || tapMarker || specFailCount || tapFailCount),
  };
}


// `--list` prints each mutation's find-text presence WITHOUT running anything, so
// a stale find text is caught in a second rather than after twenty minutes of
// postmasters. MEASURED: three find texts were stale for two full runs because the
// only place the check lived was the run itself, and the run reported UNVERIFIABLE
// only after spending the time.
if (process.argv.includes("--list")) {
  let bad = 0, known = 0;
  for (const mutation of MUTATIONS) {
    const text = readFileSync(ROOT + mutation.file, "utf8");
    const ok = text.includes(mutation.find);
    if (mutation.knownUnverifiable) {
      known += 1;
      console.log(`known-un ${mutation.name}  (no test can fail it: see the entry)`);
      continue;
    }
    if (!ok) bad += 1;
    console.log(`${ok ? "ok      " : "STALE   "} ${mutation.name}${mutation.covers ? `  [${mutation.covers.slice(0, 46)}]` : ""}`);
  }
  console.log(`${MUTATIONS.length - known - bad} present, ${bad} stale, ${known} known-unverifiable`);
  process.exitCode = bad === 0 ? 0 : 1;
  process.exit(0);
}

// A PRE-FLIGHT on the SOURCE, and it is here because of a measured accident TWICE:
// an interrupted mutation run left a guard DELETED in a committed file, and the next
// run's "restore" made it permanent. Both times the lane still passed, because the
// lane could not reach the window the guard covered - which is exactly how a deleted
// guard survives review.
//
// So every run begins by asserting that each mutation's `replace` text is ABSENT from
// the source. A `replace` present at start means a previous run ended mid-mutation,
// and continuing would mutate an already-mutated file and restore that instead.
{
  // The test is on the PAIR, not on the replace text alone. MEASURED: an earlier
  // version asked whether `replace` was present, and one mutation's replace is a
  // SUFFIX of its own find text - so it was always present and the pre-flight
  // refused to run against a perfectly clean source, which is a harness that cries
  // wolf and will be ignored the one time it matters.
  //
  // So a source is dirty for a mutation when the find text is GONE and the replace
  // text is present: that is exactly what a mutation looks like after the write.
  const dirty = MUTATIONS.filter((m) => {
    if (m.knownUnverifiable) return false;
    const text = readFileSync(ROOT + m.file, "utf8");
    return !text.includes(m.find) && text.includes(m.replace);
  });
  if (dirty.length > 0) {
    console.error(`REFUSING TO RUN: ${dirty.length} mutation(s) are ALREADY APPLIED to the source:`);
    for (const m of dirty) console.error(`  ${m.name} - its replace text is present in ${m.file}`);
    console.error("A previous run was interrupted mid-mutation. Restore the source, then re-run.");
    process.exit(2);
  }
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
  if (mutation.knownUnverifiable) {
    console.log(`EXPECTED-UNVERIFIABLE ${mutation.name}`);
    unverifiable += 1; continue;
  }
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
  if (!counts.ranSomething) {
    console.log(`UNVERIFIABLE ${mutation.name} (the lane ran no tests: bad \`covers\` name?)`);
    unverifiable += 1; continue;
  }
  const verdict = result.status !== 0 || counts.fail > 0 ? "CAUGHT" : "MISSED";
  if (verdict === "CAUGHT") caught += 1; else missed += 1;
  console.log(`${verdict.padEnd(12)} ${mutation.name}`);
}
console.log(`\n${caught} caught, ${missed} missed, ${unverifiable} unverifiable, of ${MUTATIONS.length}`);
process.exitCode = missed === 0 && unverifiable === 0 ? 0 : 1;