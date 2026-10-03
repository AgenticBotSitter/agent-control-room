#!/bin/bash
# The self-test the owner rule asks for: break every guard this branch added, on
# purpose, and watch a named test fail. Run from the worktree root without
# concurrent source edits. Each mutation is applied, the named test is run, the file is
# restored, and the result recorded. Nothing is committed.
#
# ===========================================================================
# WHY THIS SCRIPT WAS REBUILT (review R7CFIX-R01, MEDIUM).
#
# The previous version reported "10 of 10 caught" and four of those verdicts
# were produced by ZERO tests. Both causes are structural, so both are now
# properties of this file rather than things to remember:
#
#   1. A SETUP FAILURE IS NOT A CAUGHT MUTATION. `pg_one` took a DESCRIPTION
#      string, grepped it in the test file and returned 2 without invoking node
#      when it was absent; `run_mutation` then read every nonzero as success.
#      Here a test is named by its TEST NAME, resolved against the file before
#      any mutation is applied, and a verdict is only ever formed from output
#      that proves the named test was EXECUTED and failed in its own body.
#   2. A NONZERO EXIT IS NOT EVIDENCE OF ANYTHING. The previous version logged
#      "HARNESS BROKEN" and carried on, then printed counts and exited 0. Here
#      every precondition is a hard gate: a broken baseline, a missing anchor, a
#      missing test, a setup error and a timeout all STOP the run with a nonzero
#      exit. The summary counts only what it can prove and then CHOOSES this
#      script's exit code.
#
# THREE MORE LIES MEASURED ON THIS REPOSITORY, each of which this file makes
# impossible rather than merely unlikely:
#
#   3. A `--test-name-pattern` matching NOTHING reports the FILE as PASSING.
#      Measured on node 26.7: it prints `pass 1 / fail 0` and exits 0 having run
#      nothing. So a name-filtered verdict is worthless unless the result PROVES
#      the named test ran. The structured classifier requires that proof.
#   4. A `--test-name-pattern` with NO FILE ARGUMENT forwards no test files and
#      node runs its DEFAULT DISCOVERY over the whole suite -- twenty minutes
#      per mutation, and a live cluster left behind when interrupted. Every
#      invocation here passes the file as its own argument.
#   5. Node's `--test-timeout` is NOT a bound on the PROCESS. Measured: a 1500 ms
#      timeout printed `not ok` and `# cancelled 1`, and the run then took
#      60058 ms to finish. So each lane here also runs under
#      `r7cfix-test-watchdog.mjs`, which kills the whole PROCESS GROUP at a hard
#      bound -- a postmaster included -- and reports 124, which is classified as
#      a TIMEOUT and never as a caught mutation.
#
# THE RULE, stated once: a guard is "caught" only when (a) the anchor matched
# exactly once, (b) the mutation was applied, (c) the NAMED test is proved to
# have been EXECUTED, and (d) it failed in an ASSERTION of its own body. A
# module-load crash, a crashed hook, a timeout, a skip and a setup error are all
# HARNESS-ERROR and none of them is counted. The classifier requires the named
# diagnostic to carry testCodeFailure, ERR_ASSERTION and AssertionError, plus a
# passing baseline for that exact name. No environment-message blacklist is used.
#
# Restores happen in a `trap ... EXIT` AND after every run, so an interrupted run
# cannot leave a mutated product file behind.
set -u
# Supply native PostgreSQL binaries/runtime via the environment when required.
# All scratch files belong to this checkout, with one directory per invocation.
export LC_ALL=C
export CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1
cd "$(dirname "$0")/.."
mkdir -p .test-tmp
export TMPDIR="$(mktemp -d "$PWD/.test-tmp/r7cfix-mutations.XXXXXX")"
PG_LANE_LO=59791
PG_LANE_HI=59799

LOG="$TMPDIR/mutation-self-test.log"
LOG_DIR="$TMPDIR/mutation-logs"
: > "$LOG"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

PG_FILE=tests/fleet-proposal-authority-postgres.test.ts
UNIT_FILE=tests/fleet-expired-offer-skip.test.mjs
# The exact test names this script matches on. Each is checked against its own
# file before any mutation, so a name that does not exist can never become a
# silent pass (finding 3).
PG_MAIN="R7C-01/R7C-03: an owner task stays claimable long after creation, and an MCP bot counts as present"
PG_EFFECT="R7C-01: an effect intent for a lapsed authority is refused with the named error"
PG_READY="R7C-01: an already-ready job whose authority lapsed is refused as expired, not as a conflict"
UNIT_HEAD="R7C-01c: an expired offer at the head of the list is skipped, and the next one is claimed"
UNIT_ALONE="R7C-01c: an expired offer alone ends the pass idle, having claimed nothing"
UNIT_OTHER="R7C-01c: a code outside the fixed refusal set still ends the pass"
UNIT_CODE='R7C-01c: the MCP claim tool reports `expired` as a code a bot can act on'

# Hard bounds, both generous and both real. The database-free lane finishes in
# seconds; each PostgreSQL test provisions its own cluster and ran at ~10 s.
PG_TIMEOUT_MS=900000
UNIT_TIMEOUT_MS=180000

MUTATED=()
CAUGHT=0
NOT_CAUGHT=0
BROKEN=0
declare -a DETAIL=()

restore_all() {
  local file
  for file in "${MUTATED[@]:-}"; do
    if [ -n "${file#-}" ] && [ -f "$file.restore" ]; then
      cp "$file.restore" "$file" && rm -f "$file.restore"
      printf 'restored: %s\n' "$file" >> "$LOG"
    fi
  done
  MUTATED=()
}
record() { printf '%s\n' "$1" >> "$LOG"; printf '%s\n' "$1"; }

on_exit() {
  local status=$?
  trap - EXIT
  restore_all
  echo
  echo "== mutation self-test summary =="
  printf 'caught:       %s\n' "$CAUGHT"
  printf 'NOT CAUGHT:   %s\n' "$NOT_CAUGHT"
  printf 'BROKEN:       %s\n' "$BROKEN"
  local line
  for line in "${DETAIL[@]:-}"; do [ -n "$line" ] && printf '  %s\n' "$line"; done
  echo "--- git status after every restore (must show no modified source file) ---"
  git status --porcelain | tee -a "$LOG"
  echo "--- nothing left listening on this lane's ports ---"
  lsof -nP -iTCP:"$PG_LANE_LO-$PG_LANE_HI" -sTCP:LISTEN 2>/dev/null || echo "(nothing)"
  # The exit code IS the verdict. A guard that survived, or one that was never
  # really tested, fails this script -- and so does a run that stopped early.
  if [ "$BROKEN" -ne 0 ] || [ "$NOT_CAUGHT" -ne 0 ] || [ "$CAUGHT" -eq 0 ] || [ "$status" -ne 0 ]; then
    exit 1
  fi
  exit 0
}
trap on_exit EXIT

fail_hard() {
  record "HARNESS-ERROR: $1"
  BROKEN=$((BROKEN + 1))
  # A broken precondition makes every later verdict void, so the run stops HERE
  # rather than continuing and printing counts nobody should read.
  record "stopped: the results above are void"
  exit 1
}

# ---------------------------------------------------------------------------
# One mutation: apply, run the NAMED test, classify, restore.
# ---------------------------------------------------------------------------
# apply <label> <file> <find> <replace> -- the anchor is the guard's own source
# line, resolved against the file under test and never against a description in
# this script. Zero or several matches is a broken precondition, not a skip.
apply() {
  local label="$1" file="$2" find="$3" replace="$4"
  cp "$file" "$file.restore" || fail_hard "cannot back up: $label"
  MUTATED+=("$file")
  if ! python3 - "$file" "$find" "$replace" <<'PY'
import sys
path, find, replace = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding="utf-8").read()
count = text.count(find)
if count != 1:
    print(f"ANCHOR-MISMATCH: matched {count} times, expected exactly 1", file=sys.stderr)
    sys.exit(3)
open(path, "w", encoding="utf-8").write(text.replace(find, replace))
PY
  then
    restore_all
    fail_hard "anchor did not match exactly once for: $label"
  fi
}

# run_mutation <label> <file> <find> <replace> <test-file> <test-name> <bound> <per-test>
run_mutation() {
  local label="$1" file="$2" find="$3" replace="$4" testfile="$5" testname="$6" bound="$7" pertest="$8"
  local key; key=$(printf '%s' "$label" | tr -c 'a-zA-Z0-9' '_')
  local base="$LOG_DIR/$key.baseline.log"
  local pattern
  pattern=$(node scripts/r7cfix-mutation-classifier.mjs --pattern "$testname") || fail_hard "invalid test pattern"
  # Every mutation has a fresh passing baseline of the SAME exact named test.
  baseline "$testname" "$testfile" "$bound" "$base" "$pattern"
  apply "$label" "$file" "$find" "$replace"
  local out="$LOG_DIR/$key.log"
  node scripts/r7cfix-test-watchdog.mjs --timeout-ms "$bound" -- \
    node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-reporter=tap \
      "--test-timeout=$pertest" "--test-name-pattern=$pattern" "$testfile" > "$out" 2>&1
  local status=$?
  restore_all
  local verdict
  verdict=$(node scripts/r7cfix-mutation-classifier.mjs "$base" 0 "$out" "$status" "$testname")
  case "$verdict" in
    CAUGHT) record "caught: $label"; DETAIL+=("caught   $label"); CAUGHT=$((CAUGHT + 1));;
    SURVIVED) record "SURVIVED: $label"; DETAIL+=("survived $label"); NOT_CAUGHT=$((NOT_CAUGHT + 1));;
    *) fail_hard "no positive assertion evidence for: $label (exit=$status)";;
  esac
}

# ---------------------------------------------------------------------------
# Preconditions. Every one is a hard stop.
# ---------------------------------------------------------------------------
echo "== 0. preconditions. Every one of these is a hard stop. =="
for name in "$PG_MAIN" "$PG_EFFECT" "$PG_READY"; do
  grep -qF "$name" "$PG_FILE" || fail_hard "the PostgreSQL file has no test named: $name"
done
for name in "$UNIT_HEAD" "$UNIT_ALONE" "$UNIT_OTHER" "$UNIT_CODE"; do
  grep -qF "$name" "$UNIT_FILE" || fail_hard "the database-free lane has no test named: $name"
done
record "harness ok: every test name this script matches on exists in its file"

baseline() {
  local name="$1" testfile="$2" bound="$3" out="$4" pattern="$5"
  node scripts/r7cfix-test-watchdog.mjs --timeout-ms "$bound" -- \
    node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-reporter=tap \
      "--test-timeout=300000" "--test-name-pattern=$pattern" "$testfile" > "$out" 2>&1
  local status=$?
  node scripts/r7cfix-mutation-classifier.mjs --baseline "$out" "$status" "$name" \
    || fail_hard "the exact named baseline did not pass: $name (exit=$status)"
  record "harness ok: this exact named test passes unmutated: $name"
}

echo
echo "== 1. the proposal authority stamp reverts to five minutes from creation =="
run_mutation "task-service: 300s stamp from creation" src/web/v1/task-service.ts \
  'const authority: AuthorityEnvelope = { ...proposalAuthorityMaterialV1(projectId, actor.now), digest: "" };' \
  'const authority: AuthorityEnvelope = { ...proposalAuthorityMaterialV1(projectId, actor.now), digest: "",
        maxDurationSeconds: 300, expiresAt: new Date(Date.parse(actor.now) + 300_000).toISOString() };' \
  "$PG_FILE" "$PG_MAIN" "$PG_TIMEOUT_MS" 300000

echo "== 2. the claim boundary stops mapping a lapsed authority to a named refusal =="
# The anchor is the mapping at the CLAIM's own boundary, which is the single
# place that covers all three of the canonical store's authority reads.
run_mutation "gateway-store: claim boundary drops the expired mapping" src/fleet/v1/gateway-store.ts \
  '      if (error instanceof JobAuthorityExpiredError) fleetFail("expired");
      throw error;' \
  '      throw error;' \
  "$PG_FILE" "$PG_MAIN" "$PG_TIMEOUT_MS" 300000

echo "== 3. the effect authorization guard loses its NAME (canonical-store.ts:341) =="
# Decided by the effect test, which is the only one that creates an Effect
# record. Measured, not assumed: with this mutation the effect test fails on
# `raised instanceof JobAuthorityExpiredError`, and the main test still passes.
run_mutation "canonical-store: effect authorization answers a bare Error" src/persistence/canonical-store.ts \
  'if (Date.parse(job.authority.expiresAt) <= Date.parse(validated.createdAt)) throw new JobAuthorityExpiredError();' \
  'if (Date.parse(job.authority.expiresAt) <= Date.parse(validated.createdAt)) throw new Error("Job authority has expired");' \
  "$PG_FILE" "$PG_EFFECT" "$PG_TIMEOUT_MS" 300000

echo "== 4. the effect authorization guard is DELETED (canonical-store.ts:341) =="
# A deletion, not a rename: the guard must still REFUSE, so this variant decides
# whether an Effect record is created AT ALL for a lapsed authority. Measured:
# with the line gone the insert succeeds and the same assertion sees `undefined`.
# The fixture carries a real approval precisely so this verdict is about line
# 341 and not about the approval guard one line below it.
run_mutation "canonical-store: effect authorization is not refused at all" src/persistence/canonical-store.ts \
  '        if (Date.parse(job.authority.expiresAt) <= Date.parse(validated.createdAt)) throw new JobAuthorityExpiredError();
        if (job.authority.networkPolicy === "allowlist"' \
  '        if (job.authority.networkPolicy === "allowlist"' \
  "$PG_FILE" "$PG_EFFECT" "$PG_TIMEOUT_MS" 300000

echo "== 5. the up-front envelope check says conflict instead of expired =="
# Decided by the ALREADY-READY test, and this is why it is a separate mutation:
# measured on this tree, with this mutation the already-READY test FAILS and the
# main test still PASSES, because its doomed job is `proposed` and fails at
# `proposed -> ready` before line 738 is ever reached.
run_mutation "gateway-store: window check answers conflict" src/fleet/v1/gateway-store.ts \
  '      if (Date.parse(job.authority.expiresAt) <= Date.parse(now)) return fleetFail("expired");' \
  '      if (Date.parse(job.authority.expiresAt) <= Date.parse(now)) return fleetFail("conflict");' \
  "$PG_FILE" "$PG_READY" "$PG_TIMEOUT_MS" 300000

# ---------------------------------------------------------------------------
# A MUTATION OF SQL MUST NOT CHANGE THE QUERY'S BIND ARITY. Found by running
# the harness natively on real PostgreSQL, where guards 6 and 7 were WRONG in
# the way this file exists to prevent.
#
#   - guard 6 deleted the whole `AND ... >$5` line and guard 7 deleted the whole
#     `WHEN ... THEN 'blocked'` branch. Each of those clauses is the ONLY
#     reference to its bind placeholder, so both mutations also changed how many
#     parameters the prepared statement needs.
#   - MEASURED on PostgreSQL 17.11 through node-postgres, three placeholders
#     against four values: `bind message supplies 4 parameters, but prepared
#     statement "" requires 3`. SQLSTATE 08P01, raised by the PROTOCOL layer
#     before a single row exists, and surfaced by this test file's own
#     `withRealPostgres` as `database_outcome_uncertain`.
#
# So guard 7 answered HARNESS-ERROR (correctly refused: no assertion ran), and
# guard 6 answered CAUGHT for the WRONG REASON -- the run died at the first
# `list_eligible_work` call on the healthy path, at "the bot can list work",
# which says nothing about whether a lapsed offer is listed. The classifier was
# right that an assertion failed; the mutation had simply broken the query.
#
# THE RULE, for the two mutations below and for every SQL mutation added after:
# delete or rewrite a GUARD's behaviour, never a placeholder's binding. Each
# keeps `$5`/`$3` referenced, so the statement still parses and binds, and the
# deciding failure is the guard's own assertion rather than 08P01.
# ---------------------------------------------------------------------------

echo "== 6. listWork lists an offer nobody can claim =="
# The horizon moves a century into the past, so no offer is ever excluded for
# having lapsed. `$5` stays bound: dropping it would answer 08P01 instead.
run_mutation "gateway-store: listWork no longer excludes a lapsed offer" src/fleet/v1/gateway-store.ts \
  "        AND (j.payload#>>'{authority,expiresAt}')::timestamptz>\$5::timestamptz" \
  "        AND (j.payload#>>'{authority,expiresAt}')::timestamptz>=\$5::timestamptz-interval '100 years'::interval" \
  "$PG_FILE" "$PG_MAIN" "$PG_TIMEOUT_MS" 300000

echo "== 7. the owner is not told an offer is unclaimable =="
# The branch still EVALUATES the expiry (`$3` stays bound, so the guard's own
# comparison runs) but nothing is ever reported `blocked`, which is exactly the
# bug: an offer nobody can take reads as open work.
run_mutation "owner-service: projectOffers never says blocked" src/fleet/v1/owner-service.ts \
  "            WHEN (j.payload#>>'{authority,expiresAt}')::timestamptz<=\$3::timestamptz THEN 'blocked' ELSE 'open' END AS state," \
  "            WHEN (j.payload#>>'{authority,expiresAt}')::timestamptz<=\$3::timestamptz THEN 'open' ELSE 'open' END AS state," \
  "$PG_FILE" "$PG_READY" "$PG_TIMEOUT_MS" 300000

echo "== 8. a replayed MCP call stops counting as contact =="
run_mutation "gateway-store: replay path does not touch presence" src/fleet/v1/gateway-store.ts \
  '          || prior.safe_metadata.toolName !== toolName) return fleetFail("conflict");
        await this.#touchPresenceIn(tx, principal, this.#now());
        return Object.freeze({ recorded: true, replayed: true });' \
  '          || prior.safe_metadata.toolName !== toolName) return fleetFail("conflict");
        return Object.freeze({ recorded: true, replayed: true });' \
  "$PG_FILE" "$PG_MAIN" "$PG_TIMEOUT_MS" 300000

echo "== 9. the FIRST MCP call stops counting as contact =="
run_mutation "gateway-store: new-call path does not touch presence" src/fleet/v1/gateway-store.ts \
  '      await this.#touchPresenceIn(tx, principal, this.#now());
      await appendAuditWith(tx, { id: auditId,' \
  '      await appendAuditWith(tx, { id: auditId,' \
  "$PG_FILE" "$PG_MAIN" "$PG_TIMEOUT_MS" 300000

echo "== 10. the connector stops skipping an expired offer =="
run_mutation "connector: expired escapes the claim loop again" scripts/fleet/connector.mjs \
  '            if (error?.code === "expired") { expiredOffers += 1; continue; }' \
  '            if (error?.code === "expired") { throw error; }' \
  "$UNIT_FILE" "$UNIT_HEAD" "$UNIT_TIMEOUT_MS" 60000

echo "== 11. the connector swallows a refusal OUTSIDE its fixed set =="
# The over-widening. A guard that had grown into a general catch would hide a
# real fault, so the test that proves the new branch is ONE named case also
# checks this. Lesson 3's rule, applied to my own fix.
run_mutation "connector: the catch swallows another refusal" scripts/fleet/connector.mjs \
  '            if (error?.code !== "conflict" && error?.code !== "not_found") throw error;' \
  '            if (error?.code === "unavailable") continue;' \
  "$UNIT_FILE" "$UNIT_OTHER" "$UNIT_TIMEOUT_MS" 60000

echo "== 12. the connector's fixed refusal set loses \`expired\` =="
# The layer UNDER guards 10 and 11: if the gateway's code is not in the
# connector's vocabulary, `fleetRefusalCode` returns "" and the skip above is
# unreachable, so the pass is abandoned again. This is the link the review noted
# the new branch depends on.
run_mutation "connector: the fixed refusal set drops expired" scripts/fleet/connector.mjs \
  '"rate_limited", "expired", "unavailable", "paused"' \
  '"rate_limited", "unavailable", "paused"' \
  "$UNIT_FILE" "$UNIT_CODE" "$UNIT_TIMEOUT_MS" 60000

echo "== 13. the connector abandons the pass after an expired offer alone =="
# The third shape: a skip is a skip, not a silent success. With this mutation the
# one-line summary of skipped offers never runs, so the pass ends as an outage.
run_mutation "connector: an expired offer alone ends the pass as unreachable" scripts/fleet/connector.mjs \
  '        if (expiredOffers) {' \
  '        if (false && expiredOffers) {' \
  "$UNIT_FILE" "$UNIT_ALONE" "$UNIT_TIMEOUT_MS" 60000
