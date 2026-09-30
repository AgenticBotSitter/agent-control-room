#!/usr/bin/env bash
# Mutation proof for the chief-of-staff fix round (the Opus security review's
# B1-B4) and the guards this stream added for them.
#
# Split from scripts/orchui-mutations.sh on purpose. That script's LANE is the
# fast unit lane, and every mutation in it is a one-line edit in TypeScript.
# The guards fixed here are of two kinds that file cannot cover:
#
#   - DATABASE guards (B1's view predicate, B4's replay comparison, B2's scope
#     key). Mutating those means editing a MIGRATION, which changes the ledger
#     digest, so the lane has to re-apply migrations to a real cluster. That is
#     slow -- roughly a minute per mutation -- and it is the only place the guard
#     is actually enforced.
#   - Guards whose proof is a real coordinator over real stores (B2's completion
#     lookup), which no in-memory double can stand in for: the whole bug was that
#     the double and production disagreed.
#
# Each mutation is applied, the focused lane is re-run, and a FAILURE is the PASS
# condition. Every mutation is restored afterwards; the tree must end clean.
#
# Usage: PG_BIN=/opt/homebrew/opt/postgresql@17/bin bash scripts/orchui-fix-mutations.sh
set -u
cd "$(dirname "$0")/.."

PORT_BASE="${CONTROL_ROOM_PG_TEST_PORT_BASE:-59450}"
export CONTROL_ROOM_PG_TEST_PORT_BASE="$PORT_BASE"
export PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
export TMPDIR="${TMPDIR:-/tmp}"
# The panel lives in a .tsx test, so the UI lane has to include it. Without it
# the B3f mutation below "escapes" for the boring reason that no test in the
# lane renders the panel at all -- measured, and the fix is to run the test that
# does.
UNIT_LANE=(tests/intake-coordinator.test.ts tests/project-orchestration-owner.test.ts
  tests/project-orchestration-ui.test.tsx)
DB_LANE="tests/orchestrator-split-suggestions-postgres.test.ts"
COORD_LANE="tests/project-orchestration-postgres.test.ts"
COORD=src/work-intake/v1/intake-coordinator.ts
STORE=src/work-intake/v1/intake-coordinator-store.ts
OWNER=src/web/v1/project-orchestration-owner.ts
UI=private-app/app/project-orchestration.tsx
MIGRATION=db/migrations/0203_work_batch_split_suggestions_tenant_bound_read.sql
NEEDSYOU_MIGRATION=db/migrations/0204_planner_needs_you_digest_scopes.sql
# Round 3's migration. It carries the security_barrier, the scope-keyed ledger and
# the owner-retry latch, so every guard in it is a database guard and every
# mutation below re-applies the whole schema to a real cluster.
RETRY_MIGRATION=db/migrations/0205_planner_barrier_and_owner_retry.sql
# The lane that proves N-B1 and N-B3 on a real cluster, as the production logins.
BARRIER_PATTERN="tenant-bound|leaks nothing through an ERROR"
# EVERY test that carries a round-3 assertion, not just the first one found. Three
# of these mutations were reported ESCAPED in a full run while passing when run
# individually, because the pattern named one test and the assertion that caught
# them lives in another -- the lane ran, and the test that would have failed was
# filtered out of it. A pattern is part of the proof, so it is written out.
RETRY_PATTERN="one description gives one|failure counter is durable|REAL coordinator spends"
# The results directory defaults to a path under the repository's own scratch
# area, not a home directory. The sibling scripts/orchui-mutations.sh carries an
# absolute home path here; this one does not, because a home path in committed
# file content names the machine it was written on and nothing about the product.
RESULTS_DIR="${RESULTS_DIR:-${TMPDIR:-/tmp}/orchui-fix-mutations}"
mkdir -p "$RESULTS_DIR"

pass=0; fail=0; failures=""
# mutate <id> <file> <old> <new> [--lane unit|db|coord] [--pattern <name>]
# A `python3` free literal replace, one guard, then the named lane is re-run.
mutate() {
  local id="$1" file="$2" old="$3" new="$4"; shift 4
  local lane="unit" pattern=""
  while [ $# -gt 0 ]; do case "$1" in
    --lane) lane="$2"; shift 2;;
    --pattern) pattern="$2"; shift 2;;
    *) shift;; esac; done
  if ! grep -qF -- "${old//@TICK@/$(printf "\140")}" "$file"; then
    echo "SETUP-ERROR $id: anchor not found in $file" | tee "$RESULTS_DIR/$id.log"
    fail=$((fail+1)); failures="$failures $id(setup)"; return
  fi
  python3 - "$file" "$old" "$new" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
# @TICK@ is a literal backtick. The store anchors end in one and the shell cannot be
# trusted to carry it through a word-split argument, so it travels as a placeholder
# and is restored here.
old = old.replace("@TICK@", chr(96))
new = new.replace("@TICK@", chr(96))
text = open(path, encoding="utf8").read()
assert text.count(old) == 1, f"anchor is not unique ({text.count(old)})"
open(path, "w", encoding="utf8").write(text.replace(old, new))
PY
  # A migration edit changes the ledger digest, so the applier would refuse with
  # migration_altered. Regenerating the ledger is part of applying the mutation,
  # and the ledger itself is restored with the file.
  if [ "$file" = "$MIGRATION" ] || [ "$file" = "$NEEDSYOU_MIGRATION" ] || [ "$file" = "$RETRY_MIGRATION" ]; then
    node scripts/generate-migration-ledger.mjs >/dev/null 2>&1
  fi
  local files=()
  case "$lane" in
    unit) files=("${UNIT_LANE[@]}");;
    db) files=("$DB_LANE");;
    coord) files=("$COORD_LANE");;
  esac
  local args=(--import tsx --test --test-concurrency=1)
  [ -n "$pattern" ] && args+=(--test-name-pattern="$pattern")
  if node "${args[@]}" "${files[@]}" > "$RESULTS_DIR/$id.log" 2>&1; then
    echo "ESCAPED  $id  (the lane still passed with the guard removed)" | tee -a "$RESULTS_DIR/summary.txt"
    fail=$((fail+1)); failures="$failures $id(ESCAPED)"
  else
    local which
    which=$(grep -oE "^(not ok [0-9]+|✖ ) .*" "$RESULTS_DIR/$id.log" | head -2 | paste -sd ';' -)
    [ -z "$which" ] && which=$(grep -oE "AssertionError.*" "$RESULTS_DIR/$id.log" | head -1)
    echo "CAUGHT   $id  <- $which" | tee -a "$RESULTS_DIR/summary.txt"
    pass=$((pass+1))
  fi
  git checkout -- "$file"
  if [ "$file" = "$MIGRATION" ] || [ "$file" = "$NEEDSYOU_MIGRATION" ] || [ "$file" = "$RETRY_MIGRATION" ]; then
    node scripts/generate-migration-ledger.mjs >/dev/null 2>&1
  fi
}

: > "$RESULTS_DIR/summary.txt"

# ---------------------------------------------------------------------------
# B1: the current-split-suggestion view is tenant-bound. Remove the predicate
# from the view and the intake login reads every tenant's proposal again.
# ---------------------------------------------------------------------------
mutate B1-view-predicate-removed "$MIGRATION" \
  "  WHERE s.base_revision=b.version AND b.state='proposed'
    AND public.work_intake_split_suggestion_visible(s.tenant_id, s.batch_id, s.proposed_by_identity_id);" \
  "  WHERE s.base_revision=b.version AND b.state='proposed';" \
  --lane db --pattern "tenant-bound"

# B1b: the same rule, spelled a second time on the TABLE rather than shared. The
# shared predicate is what stops the two from drifting; this mutation shows the
# "one definition" assertion has teeth.
mutate B1b-shared-predicate-split "$MIGRATION" \
  "  USING (public.work_intake_split_suggestion_visible(work_batch_split_suggestions.tenant_id,
    work_batch_split_suggestions.batch_id, work_batch_split_suggestions.proposed_by_identity_id))
  WITH CHECK (public.work_intake_split_suggestion_visible(work_batch_split_suggestions.tenant_id,
    work_batch_split_suggestions.batch_id, work_batch_split_suggestions.proposed_by_identity_id));" \
  "  USING (NOT public.is_work_intake_session() OR work_batch_split_suggestions.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b))
  WITH CHECK (NOT public.is_work_intake_session() OR work_batch_split_suggestions.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b));" \
  --lane db --pattern "tenant-bound"

# B1c: the predicate always says yes. This is the "a predicate that is not
# really a predicate" mutation: the function exists, is called by both, and
# bounds nothing.
mutate B1c-predicate-always-true "$MIGRATION" \
  "  SELECT NOT public.is_work_intake_session() OR EXISTS (" \
  "  SELECT true OR public.is_work_intake_session() OR EXISTS (" \
  --lane db --pattern "tenant-bound"

# ---------------------------------------------------------------------------
# B2: a repeat of a completed request is answered from storage, with no run.
# ---------------------------------------------------------------------------
mutate B2-completion-lookup-ignored "$COORD" \
  "    const stored = await this.#completions?.completed({ tenantId: input.principal.tenantId,
      projectId: input.projectId, identityId: input.principal.identityId, requestKey: input.requestKey });
    if (stored) return stored;" \
  "    const stored = null as Awaited<ReturnType<NonNullable<IntakeCompletionLookupPortV1['completed']>>>;
    void stored;" \
  --lane unit --pattern "B2:"

# B2b: the PRODUCTION lookup always reports "not completed", which is the
# adapter-shaped version of the same hole and cannot be caught by the in-memory
# test above.
mutate B2b-lookup-always-null "$STORE" \
  "    if (receipt.data.projectId !== input.projectId) return null;" \
  "    if (receipt.data.projectId !== input.projectId) return null;
    return null;" \
  --lane coord --pattern "B2:"

# B2c: the lookup answers for a request that has NOT completed, because the
# 'completed' status filter is dropped. This is the fabricated-receipt direction:
# a receipt nobody stored would hand the owner a batch id that does not exist.
# Round 3 added N8's refusal, so this anchor moved: the SELECT now names
# `request_digest` as well, and the status filter is on the next line.
mutate B2c-lookup-ignores-status "$STORE" \
  " WHERE tenant_id=\$1 AND operation_scope=\$2 AND idempotency_key=\$3 AND status='completed'\@TICK@," \
  " WHERE tenant_id=\$1 AND operation_scope=\$2 AND idempotency_key=\$3@TICK@," \
  --lane coord --pattern "B2:"

# ---------------------------------------------------------------------------
# B3: the escalation is reachable from the panel, and Needs-you is only said
# when an item exists.
# ---------------------------------------------------------------------------
# B3a: count only the per-REQUEST scope, which is what the browser's fresh key
# per press never repeats. This is the exact bug the review found.
# Round 3 moved the check into #escalated(), so the old inline anchor is stale and
# this reported SETUP-ERROR rather than a result. The anchor below is the live one,
# and mutating it proves the PROJECT scope is still the arm that makes the rule
# reachable from the panel -- which is the whole point of 0204.
mutate B3a-project-scope-not-counted "$COORD" \
  "    for (const scope of [input.projectScope, input.failureScope]) {" \
  "    for (const scope of [input.failureScope]) {" \
  --lane unit --pattern "B3: a fresh idempotency key per press still reaches"

# B3b: the escalation check runs AFTER the allowance and the planner, so the
# third press costs a run before it is refused.
mutate B3b-escalation-check-moved-after-run "$COORD" \
  "      if (!(await this.failures.ownerRetryGranted?.(scope))) return true;" \
  "      return false;" \
  --lane unit --pattern "escalated description is refused"

# B3c: a success clears only one scope, leaving the project counter live so a
# later unrelated failure escalates on a counter that already saw a recovery.
mutate B3c-success-clears-one-scope "$COORD" \
  "    await this.failures.clear(input.failureScope);
    await this.failures.clear(input.projectScope);" \
  "    await this.failures.clear(input.failureScope);" \
  --lane unit --pattern "B3:"

# B3d: the failure scope is a readable string again, which is what overflowed
# 0202's 180-character CHECK for a long request key and made the second failure
# impossible to record.
mutate B3d-scope-is-readable-again "$COORD" \
  "export function intakeRequestScopeV1(kind: \"initial\" | \"resplit\", tenantId: string, projectId: string, requestKey: string) {
  return @TICK@\${kind}:\${sha256Digest({ tenantId, projectId, requestKey }).slice(7)}@TICK@;
}" \
  "export function intakeRequestScopeV1(kind: \"initial\" | \"resplit\", tenantId: string, projectId: string, requestKey: string) {
  return @TICK@\${kind}:\${tenantId}:\${projectId}:\${requestKey}@TICK@;
}" \
  --lane unit --pattern "B3:"

# B3e: the OWNER copy says "Needs-you" on a first failure, which is the label
# the review found describing an item that did not exist.
mutate B3e-first-failure-says-needs-you "$OWNER" \
  "      if (result.status === \"planner_failed\") return Object.freeze({ ...common, status: \"failed\" as const,
        needsYou: false as const,
        message: \"The chief of staff could not prepare a proposal this time. Your description is still here; try again, or choose another chief of staff.\" });" \
  "      if (result.status === \"planner_failed\") return Object.freeze({ ...common, status: \"failed\" as const,
        needsYou: true as const,
        message: \"Needs-you: the chief of staff could not prepare a proposal this time.\" });" \
  --lane unit

# B3f: the PANEL announces a first failure as an alert, which is the same claim
# in the other direction.
mutate B3f-panel-announces-first-failure "$UI" \
  "  (result.status === \"failed\" && result.needsYou)
  || (result.status === \"refused\" && result.allowanceRefused);" \
  "  result.status === \"failed\" || (result.status === \"refused\" && result.allowanceRefused);" \
  --lane unit

# ---------------------------------------------------------------------------
# B4: a differing replay under a used request key is refused.
# ---------------------------------------------------------------------------
# B4a: the pre-read returns any existing row without comparing, which is how a
# same-key different-proposal replay came back as SUCCESS carrying the first
# record.
mutate B4a-pre-read-comparison-removed "$STORE" \
  "    if (existing) {
      if (Number(existing.base_revision) !== input.baseRevision
        || existing.base_revision_digest !== input.baseRevisionDigest
        || existing.proposal_digest !== input.proposalDigest)
        throw new IntakeSuggestionStoreErrorV1(\"intake_suggestion_replay_conflict\");
      return this.#record(existing);
    }" \
  "    if (existing) return this.#record(existing);" \
  --lane db --pattern "production suggestion store"

# B4b: the post-insert check goes back to && where it needs ||, which is the
# literal defect the review named.
mutate B4b-post-insert-and-not-or "$STORE" \
  "    if (!stored || Number(stored.base_revision) !== input.baseRevision
      || stored.base_revision_digest !== input.baseRevisionDigest
      || stored.proposal_digest !== input.proposalDigest)" \
  "    if (!stored || (Number(stored.base_revision) !== input.baseRevision
      && stored.base_revision_digest !== input.baseRevisionDigest
      && stored.proposal_digest !== input.proposalDigest))" \
  --lane db --pattern "production suggestion store"

# B4c: the comparison checks the proposal but not the base revision, which is
# the arm a same-proposal replay at a newer revision slips past.
mutate B4c-base-revision-not-compared "$STORE" \
  "      if (Number(existing.base_revision) !== input.baseRevision
        || existing.base_revision_digest !== input.baseRevisionDigest
        || existing.proposal_digest !== input.proposalDigest)" \
  "      if (existing.proposal_digest !== input.proposalDigest)" \
  --lane db --pattern "production suggestion store"

# ---------------------------------------------------------------------------
# The escalation must be EARNED, in the database as well as the adapter. The
# guard recomputes the scope key in SQL; if the two definitions drift, or the
# guard stops checking, the raise is either silently dead or silently forged.
# ---------------------------------------------------------------------------
# Repointed at 0205 for the same reason as E3: 0204's copy of this guard is
# REPLACED wholesale by 0205, so mutating 0204 leaves the live guard intact and the
# lane passes for the wrong reason. The guard that actually runs is the one below.
# The pattern is the test that carries the ASSERTION, which is the failure-counter
# test -- the membership rows were added there, not to the round-3 test. Pointing
# it at "one description gives one" was why E1 still escaped after the assertion
# existed: the lane ran, but the test that would have failed was filtered out.
mutate E1-needs-you-guard-scope-check-removed "$RETRY_MIGRATION" \
  "    OR NEW.scope_key NOT IN (project_key_initial, project_key_resplit, request_key_initial, request_key_resplit)" \
  "    OR false" \
  --lane db --pattern "failure counter is durable"

# E2: the SQL scope key stops matching the application's, which kills every
# escalation while every other assertion still passes.
mutate E2-scope-key-definitions-drift "$NEEDSYOU_MIGRATION" \
  "  SELECT kind || ':' || pg_catalog.encode(pg_catalog.sha256(" \
  "  SELECT kind || ':drifted:' || pg_catalog.encode(pg_catalog.sha256(" \
  --lane db --pattern "failure counter is durable"

# E3: the guard accepts a raise with no counter at 2, which is the whole
# property 0202 was written for.
# 0205 REPLACES this guard body wholesale, so a mutation of 0204's copy is dead
# code: it is created and then overwritten two migrations later, and the lane
# passes because the live guard is 0205's, not because the check is optional. The
# mutation below pointed at 0204 and ESCAPED for exactly that reason -- measured,
# and the fix is to point it at the file whose body survives.
mutate E3-needs-you-count-check-removed "$RETRY_MIGRATION" \
  "    OR NOT EXISTS (SELECT 1 FROM public.control_planner_failure_counters c
      WHERE c.tenant_id=NEW.tenant_id AND c.project_id=NEW.project_id
        AND c.scope_key=NEW.scope_key
        AND c.failure_count>=NEW.failure_count AND c.cleared_at IS NULL) THEN" \
  "    OR false THEN" \
  --lane db --pattern "failure counter is durable|one description gives one"

# The mid-run summary is kept because it is where the round-2 block ended, and
# the EXIT it used to carry is gone on purpose: with the exit in place, every
# round-3 mutation below it was dead code and the run reported 18/18 without ever
# executing a single one of them. The script's own report is the only place that
# would have said so, and it did not -- which is why the round-3 mutations are now
# proven by the run finishing, not by a number that could come from anywhere.
echo
echo "round-2 block done: $pass caught / $fail not caught so far"

# ---------------------------------------------------------------------------
# Round 3 (N-B1): the security_barrier on the tenant-bound view.
# ---------------------------------------------------------------------------
# Each of these removes ONE reloption, and the cast/oracle test must fail. The
# first is the one the review measured; the other five are the sweep, and they are
# here so a later edit that drops one of them is caught by the same mechanism
# rather than by a reader's memory.
mutate F1a-split-suggestion-barrier-dropped "$RETRY_MIGRATION" \
  "ALTER VIEW work_batch_current_split_suggestions SET (security_barrier = true);" \
  "-- dropped" \
  --lane db --pattern "$BARRIER_PATTERN"

# F1b, F1c and F1d -- the SWEEP -- ARE DELIBERATELY NOT MUTATED, and the reason is
# recorded rather than hidden: no test in this lane puts a caller-supplied filter
# on those three views, so dropping their barrier cannot fail anything here. They
# were measured the same way N-B1 was (the four casts, as a tenant-crossing
# caller) before the reloption was set, and they are pinned by the preflight, so a
# database where one lost the property still fails every login's startup. What is
# NOT true is that the migration alone is pinned by a test in this lane, and
# claiming otherwise would be the exact overstatement 0205's header is careful to
# avoid. Proving them needs a test that drives a caller filter through each view,
# which is the next slice, not this one.

# ---------------------------------------------------------------------------
# Round 3 (N-B3): the Needs-you ledger is keyed on the escalating scope.
# ---------------------------------------------------------------------------
mutate F2a-needs-you-still-keyed-on-request-key "$RETRY_MIGRATION" \
  "  ON public.control_planner_needs_you_items (tenant_id,project_id,scope_key);" \
  "  ON public.control_planner_needs_you_items (tenant_id,project_id,request_key);" \
  --lane db --pattern "$RETRY_PATTERN"

mutate F2b-needs-you-id-not-bound-to-the-scope "$RETRY_MIGRATION" \
  "    OR NEW.id<>'planner-needs-you:' || substring(pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(NEW.tenant_id || '/' || NEW.project_id || '/' || NEW.scope_key,'UTF8')),'hex') from 1 for 32)" \
  "    OR false" \
  --lane db --pattern "$RETRY_PATTERN"

mutate F2c-needs-you-counter-not-matched-on-its-own-scope "$RETRY_MIGRATION" \
  "        AND c.scope_key=NEW.scope_key
        AND c.failure_count>=NEW.failure_count AND c.cleared_at IS NULL) THEN" \
  "        AND c.failure_count>=NEW.failure_count AND c.cleared_at IS NULL) THEN" \
  --lane db --pattern "$RETRY_PATTERN"

# ---------------------------------------------------------------------------
# Round 3 (N-B3): the owner retry is a one-shot latch, and the grant cannot
# lower the count it is stamped on.
# ---------------------------------------------------------------------------
mutate F3a-retry-grant-needs-no-escalation "$RETRY_MIGRATION" \
  "    AND control_planner_failure_counters.failure_count>=2
    AND control_planner_failure_counters.owner_retry_cleared_at IS NULL;" \
  "    AND control_planner_failure_counters.owner_retry_cleared_at IS NULL;" \
  --lane db --pattern "$RETRY_PATTERN"

mutate F3b-retry-grant-not-one-shot "$RETRY_MIGRATION" \
  "    AND control_planner_failure_counters.failure_count>=2
    AND control_planner_failure_counters.owner_retry_cleared_at IS NULL;" \
  "    AND control_planner_failure_counters.failure_count>=2;" \
  --lane db --pattern "$RETRY_PATTERN"

mutate F3c-retry-could-lower-the-count "$RETRY_MIGRATION" \
  "    IF NEW.failure_count IS DISTINCT FROM OLD.failure_count
      OR NEW.last_failure_at IS DISTINCT FROM OLD.last_failure_at
      OR NEW.cleared_at IS DISTINCT FROM OLD.cleared_at
      OR OLD.cleared_at IS NOT NULL OR OLD.failure_count<2 THEN" \
  "    IF OLD.cleared_at IS NOT NULL OR OLD.failure_count<2 THEN" \
  --lane db --pattern "$RETRY_PATTERN"

mutate F3d-latch-could-be-set-without-escalation "$RETRY_MIGRATION" \
  "      OR OLD.cleared_at IS NOT NULL OR OLD.failure_count<2 THEN" \
  "      OR OLD.cleared_at IS NOT NULL THEN" \
  --lane db --pattern "$RETRY_PATTERN"

mutate F3e-latch-could-survive-its-own-clear "$RETRY_MIGRATION" \
  "  IF NEW.failure_count=0 AND NEW.cleared_at IS NOT NULL
    AND NEW.last_failure_at IS NOT NULL AND NEW.owner_retry_cleared_at IS NULL THEN" \
  "  IF NEW.failure_count=0 AND NEW.cleared_at IS NOT NULL
    AND NEW.last_failure_at IS NOT NULL THEN" \
  --lane db --pattern "$RETRY_PATTERN"

# ---------------------------------------------------------------------------
# The COORDINATOR's half of the retry, which no migration can prove: the grant
# is what lets a press through, and it is spent by the run.
# ---------------------------------------------------------------------------
mutate F4a-escalated-press-runs-anyway "$COORD" \
  "      if (!(await this.failures.ownerRetryGranted?.(scope))) return true;" \
  "      if (false) return true;" \
  --lane unit --pattern "escalated description is refused"

# Single-quoted, not double-quoted: the replacement ends a line with a bare `}`,
# and a double-quoted continuation does not stop bash treating a following `}` or
# `(` as a command. Two runs died at exactly this line with "AND: command not
# found", which reads like the script's problem and is a quoting one.
mutate F4b-retry-is-never-spent "$COORD" \
  '      await this.failures.clear(scope);
    }
    return false;' \
  '    }
    return false;' \
  --lane unit --pattern "retry that fails again"

mutate F4c-any-store-is-treated-as-having-a-grant "$COORD" \
  "      if (!(await this.failures.ownerRetryGranted?.(scope))) return true;" \
  "      if (!(await this.failures.ownerRetryGranted?.(scope)) && false) return true;" \
  --lane unit --pattern "escalated description is refused"

# The ledger identity in the ADAPTER: it is what stops one item per press, and the
# in-memory double cannot stand in for it.
# The CONFLICT TARGET, which the twenty-press stress found the hard way. Naming
# the scope index alone leaves the primary key (tenant_id, id) unhandled, and 19 of
# 20 concurrent raises of one description fail with a primary-key violation -- the
# de-duplication holding only in sequence.
mutate F5b-needs-you-conflict-target-names-one-index "$STORE" \\
  '      ON CONFLICT DO NOTHING@TICK@,' \\
  '      ON CONFLICT (tenant_id,project_id,scope_key) DO NOTHING@TICK@,' \\
  --lane coord --pattern "STRESS: 20 concurrent presses"

# The CONFLICT TARGET, which is the whole de-duplication. Naming the REQUEST-KEY
# index instead of the scope one is the original bug: it dedupes a repeat of the
# same request, which is already deduped, and leaves a second press -- a fresh key,
# the same description -- free to write a second row.
mutate F5a-adapter-keys-the-item-on-the-request-key "$STORE" \
  '      ON CONFLICT DO NOTHING@TICK@,' \
  '      ON CONFLICT (tenant_id,project_id,request_key) DO NOTHING@TICK@,' \
  --lane db --pattern "$RETRY_PATTERN"

# The completion lookup's N8 refusal, and the status predicate that round 3 dropped
# by accident. Both are proved by the same test, which is why it exists.
mutate F6a-completion-lookup-answers-a-different-description "$STORE" \
  "    if (input.ownerRequest !== undefined) return null;" \
  "    // removed" \
  --lane coord --pattern "completion lookup answers only a COMPLETED request"

mutate F6b-completion-lookup-answers-an-unfinished-request "$STORE" \
  " AND status='completed'\@TICK@," \
  " @TICK@," \
  --lane coord --pattern "completion lookup answers only a COMPLETED request"

echo
echo "round-3 summary: $pass caught / $fail escaped  (failures:${failures:- none})"
[ "$fail" -eq 0 ]
