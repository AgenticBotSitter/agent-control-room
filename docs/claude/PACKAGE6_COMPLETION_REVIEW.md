# Package 6 completion review — `codex/mac-w3-complete` @ `8122a59b`

Reviewer: CR (Control Room independent review)
Reviewed: `codex/mac-w3-complete` at `8122a59b` against base `f1900258`
Branch: `hermes/mac-w3-completion-review` (this document only; no product code changed, nothing merged)

## Verdict: FINDINGS — do not merge as-is

Sections 2 (permissions), 3 (Mac-local reader) and 4 (run lifecycle) hold up. Section 1 does
not: the deadlock is real, structural, and the branch's remedy is a timing change, which the
owner's brief explicitly rules out as the final answer.

Independent checks I ran (all observed, not inferred):

- `node --import tsx --test tests/owner-trusted-local-cli-publish.test.ts tests/owner-trusted-local-cli-delivery.test.ts` — 9/9 pass at `8122a59b`.
- `node --import tsx --test tests/hermes-claude-shared-lifecycle-conformance.test.ts` — 1/1 pass.
- `node --import tsx --test tests/mac-local-local-result-publisher-role.test.ts` — 3/3 pass.
- `npx tsc --project tsconfig.vps.json` — clean, exit 0.
- `node scripts/verify-migration-ledger.mjs` — verified, 93 files, `sha256:f53de700…`.
- Deadlock reproduction against a real PostgreSQL 17.11 cluster using the project's own FK
  topology (migrations 0003/0020/0042/0044/0080). Evidence quoted in Finding 1.

---

## 1. The deadlock — real cause, and the 15s interval is not a fix

### Which two transactions collide

**TX-A: the quality sweep reader.** `TaskQualityCoordinator.sweep` → `reconcile` →
`DurableLocalResultInspectionServiceV1.inspectSubmitted`, all inside one
`transactionWithPreCommitCheck`. Its lock order is:

| # | Table | Mode | file:line |
|---|-------|------|-----------|
| S1 | `control_harness_runs` | `FOR UPDATE` | `src/completion-gate/v1/durable-local-result-inspection.ts:101` |
| S2 | `control_native_artifact_receipts` | `FOR UPDATE` | `src/completion-gate/v1/durable-result-review-submission.ts:75-76` |
| S3 | `control_native_review_plans` | `FOR UPDATE` | `src/completion-gate/v1/durable-result-review-submission.ts:66-67` |
| S4 | `control_jobs` | `FOR UPDATE` | `src/completion-gate/v1/durable-local-result-inspection.ts:151-152` |
| S5 | `control_attempts` | `FOR UPDATE` | `src/completion-gate/v1/durable-local-result-inspection.ts:153-154` |
| S6 | `control_leases` | `FOR UPDATE` | `src/completion-gate/v1/durable-local-result-inspection.ts:157-158` |

**TX-B: the durable result publisher.** `publishDurableResultV1`, whose `captured` transaction
does:

| # | Step | Locks taken | file:line |
|---|------|-------------|-----------|
| P1 | reservation row | `control_durable_result_write_reservations FOR UPDATE` | `src/artifacts/v1/neutral-reservation-postgres.ts:109` |
| P2 | `INSERT control_artifact_manifests` | **FK `KEY SHARE` on `control_jobs` + `control_attempts`** | `src/artifacts/v1/durable-result-publication.ts` captured-tx |
| P3 | `INSERT control_native_artifact_receipts` | **FK `KEY SHARE` on `control_harness_runs`** (FK at `db/migrations/0042_cr14c_private_task_results.sql:14`) | same |
| P4 | `ensureNeutralReviewPlan` | `control_native_review_plans FOR UPDATE` | `src/artifacts/v1/durable-result-publication.ts:500` |

### The cycle

The inversion is **child-before-parent in the reader, parent-before-child in the writer**:

- TX-A takes the *child* rows first: `control_harness_runs` (S1) and the receipt/plan rows
  (S2, S3) — and only later the *parent* `control_jobs` (S4), `control_attempts` (S5),
  `control_leases` (S6).
- TX-B takes the *parent* rows first — and it does so **implicitly, through foreign-key
  enforcement** at P2/P3 — and only then touches the *child* `control_native_review_plans`
  (P4).

So TX-B holds `control_jobs` (P2) and wants `control_native_review_plans` (P4), while TX-A
holds `control_native_review_plans` (S3) and wants `control_jobs` (S4). That is a two-row
cycle on a single job, and it needs no second agent, no retries, and no timing luck.

### Empirical proof

On a fresh PostgreSQL 17.11 cluster built to the project's real FK topology, interleaving
exactly those two orders:

```
ERROR:  deadlock detected
DETAIL:  Process 16374 waits for ShareLock on transaction 821; blocked by process 16351.
         Process 16351 waits for ShareLock on transaction 822; blocked by process 16374.
         Process 16374: SELECT plan FROM control_native_review_plans WHERE tenant_id='t1' AND run_id='r1' FOR UPDATE;
         Process 16351: SELECT id FROM control_jobs WHERE tenant_id='t1' AND id='j1' FOR UPDATE;
CONTEXT:  while locking tuple (0,1) in relation "control_native_review_plans"
```

Both waiting statements map one-to-one onto source lines: `control_native_review_plans`
`FOR UPDATE` is `durable-result-publication.ts:500` (publisher) and
`durable-result-review-submission.ts:66-67` (reader); `control_jobs` `FOR UPDATE` is
`durable-local-result-inspection.ts:151-152` (reader). Re-running with the publisher writing a
fresh artifact reproduced it again — a second, independent occurrence in the same session.

### Answers to the three specific questions

**Would a consistent lock order remove it regardless of timing? — Yes, and I verified it.**
Re-running the same interleaving with the reader reordered parent-first
(`jobs → attempts → leases → runs → receipts → plans`) completed with no deadlock. The cycle is
a pure ordering artefact; fix the order and the race is gone at any interval.

**Would a single-flight guard remove it? — No.** The `qualityInFlight` guard at
`src/web/v1/mac-local-default-task-provider.ts:208` only serialises *the sweep against
itself*. The two colliding transactions are the sweep and the publish path, which run on
different code paths and different pools (`readPool` for the reader, `publisherPool` for the
publisher — `src/web/v1/mac-local-default-task-provider.ts:133-146`). A single-flight flag
cannot see them. Note also that the guard is already in place and the deadlock still occurred
in rehearsal, which is the empirical proof that it is not the fix.

**Can it still happen at 15 seconds with multiple tasks completing at once? — Yes.**
The interval controls only *when* the sweep starts, not whether the two transactions overlap.
`setInterval` fires the next tick from a fixed cadence regardless of how long the previous
sweep ran (the `qualityInFlight` check at `mac-local-default-task-provider.ts:208` skips an
overlapping tick, but the next eligible tick still lands whenever the CLI processes finish).
With three Mac-local agents finishing within a sweep's lifetime — the normal case the journey
exercises — TX-A is inside its S1→S4 window while TX-B is inside its P2→P4 window. That is the
same cycle. 15s only makes the window rarer, not absent. In fact a longer interval makes each
individual sweep a *longer* transaction when several runs are reconciled in one pass
(`sweep` loops up to 5 candidates, `src/web/v1/task-quality-coordinator.ts:118-140`), so it
can widen the very window it is meant to avoid.

There is one more reason 15s is not merely insufficient but actively worse than it looks: the
sweep's error handling converts a failed run into `status: "unavailable"`
(`src/web/v1/task-quality-coordinator.ts:140`), which the host turns into a hard throw
(`mac-local-default-task-provider.ts:203`) and a one-shot stderr line (`:210`). A deadlocked
reconciliation therefore does not self-heal on the next tick — it is reported and skipped
until something else changes, with no retry.

### The real fix (required before merge)

Two changes, both inside existing ownership boundaries:

1. **Fix the lock order in the reader** — acquire parent keys before child rows in
   `DurableLocalResultInspectionServiceV1.inspectSubmitted`
   (`src/completion-gate/v1/durable-local-result-inspection.ts:101-158`): take
   `control_jobs` → `control_attempts` → `control_leases` **before** the
   `control_harness_runs` / receipt / plan rows. This is the ordering the writer already
   observes implicitly via FK, and it is the ordering every other coordination path in this
   codebase already documents and follows
   (`src/persistence/canonical-store.ts:1325-1340`, note at `:1338`: "A route that needed a different order
   would be a deadlock, so the shared helpers below are the only way these rows are locked").
   This change alone removes the deadlock at any interval.
2. **Make the lock order explicit and enforced, not incidental** — document the canonical
   order next to the reader the way `canonical-store.ts` does, and add a regression test that
   drives the sweep against a concurrent publish and asserts no `40P01`. Without the test, the
   ordering is unpinned and the next reader refactor can silently reintroduce it.
3. **Restore a prompt interval.** Once the order is correct, `15_000` is unjustified; the
   rehearsal's own 2s poll was not the defect. A short interval with a correct lock order is
   safe, and it restores the completion latency the package was built to deliver.

If the owner prefers to keep 15s, that is acceptable only *after* change 1 lands and is
proven by change 2's test — but then the interval is a latency choice, not a deadlock remedy,
and the rehearsal status document should say so. `docs/claude/PACKAGE5_REHEARSAL_STATUS.md:18-21`
currently frames it as "a rehearsal timing change, not a relaxed verification check" — true,
but incomplete: it does not say the timing change is *load-bearing for correctness*, which is
exactly the claim the package must not make.

### One-line statement for the record

The sweep locks a child row before a parent row; the publisher's foreign keys lock the parent
before the child. Reconciling the reader to parent-first order eliminates the deadlock
regardless of timing; a single-flight guard cannot, because the collision is between two
different pools; and 15 seconds does not prevent it, because the collision is structural.

---

## 2. Permissions — within approved scope. No finding.

Owner-approved, for `control_room_local_result_publisher`:

- `INSERT` on `control_harness_run_events` — granted at
  `db/roles/local_result_publisher_roles.sql:34`. Matches.
- `UPDATE` on exactly `state,last_sequence,run_digest,run_auth_tag,payload,updated_at,last_observed_at`
  of `control_harness_runs` — granted at `db/roles/local_result_publisher_roles.sql:42-43`.
  Exactly those seven columns, no more. Matches.

Hold-only CHECK-false `*_lock` columns (standing approval):

- `db/migrations/0090_mac_local_quality_read_locks.sql` adds `coordinator_lock` to
  `control_native_artifact_receipts` and `control_native_review_plans`, both
  `NOT NULL DEFAULT false CONSTRAINT … CHECK (… IS FALSE)`. Inert by construction.
- `db/roles/task_coordinator_roles.sql:59` grants the coordinator `UPDATE` on only those two
  columns. Matches the standing pattern used by every other `*_lock` column in the schema.
- `control_native_review_plans` remains append-only via its existing trigger
  (`db/migrations/0044_cr14c_native_review_plans.sql`), and
  `control_native_artifact_receipts` via `reject_append_only_mutation`
  (`db/migrations/0042_cr14c_private_task_results.sql:18-19`).

Checks that the grant did not silently widen:

- `src/web/v1/private-database-preflight.ts:184,187` mirrors the role file exactly, including
  the seven columns. Preflight and role file agree.
- The denied-write probe was correctly moved off the now-granted column:
  `scripts/mac-local/check-database.ts:65` and
  `tests/mac-local-local-result-publisher-role.test.ts:159` now probe
  `native_session_key_digest` (still denied) instead of `state` (now granted). This is the
  right change — the old probe would have started passing for the wrong reason.
- The structural digest was regenerated (`private-database-preflight.ts:20`) and the ledger
  verified (93 files, `sha256:f53de700…`), with migration 0090 inserted at order 90 and the
  role files shifted to 91-93.
- No grant on `control_jobs`, `control_attempts`, or `control_leases` was added to the
  publisher. The Mac-local lifecycle's job/attempt/lease writes continue to run under the
  existing coordinator login, as the trust-decision amendment states.

No excess. Findings: none.

---

## 3. The Mac-local result reader — fully authenticated. No finding.

`DurableLocalResultInspectionServiceV1.inspectSubmitted`
(`src/completion-gate/v1/durable-local-result-inspection.ts`) is now wired into the completion
path as the `resultInspectionSource` (`mac-local-default-task-provider.ts:133-136, 184`). It
performs strictly more verification than before, and nothing was loosened:

- **No bypass.** Every read is still authenticated. The durable plan/receipt come from
  `DurableResultReviewSubmissionServiceV1.inspectSubmitted` (`:119-122`) — the real service,
  not a new permissive path. `verifyDurableResultReviewPlanV1` and
  `verifyReviewPlanAgainstReceiptV1` are still called (`:131-132`); the previous direct
  `verifyDurableResultReviewPlanV1` call was replaced by the service, not dropped.
- **Bytes are re-read and checked.** `readDurableResultV1` authenticates the receipt, fetches
  the stored bytes, and runs `checkedResultBytes` against the receipt's content hash
  (`durable-result-publication.ts`, `readDurableResultV1`). Altered result text is refused.
- **Wrong-adapter results are refused.** The adapter identity must be one of the three
  Mac-local CLI identities *and* match the harness tag (`:110-113`), and the run must not be
  native or remote and not resumable (`:115-116`). A Hermes-021 run cannot satisfy the
  Codex/Claude/Hermes-local identities; `run.connectorProfileDigest` must equal the receipt's
  (`:130`).
- **Unauthenticated delivery is refused.** The delivery receipt is read with the
  `ownerTrustedLocal` key and its HMAC verified inside
  `readControllerWorkerDeliveryReceiptV1` (`:136-137`); a receipt signed with any other key
  fails. Covered by the new negative test at
  `tests/hermes-claude-shared-lifecycle-conformance.test.ts:252-261` — and that test passes
  (verified above).
- **New binding added, not removed.** `run.nativeSessionKeyDigest` must equal
  `sha256Digest({ purpose, deliveryDigest })` with the per-adapter purpose string
  (`:147`), and `run.createdAt` must equal the delivery receipt's `receivedAt` (`:148`).
  I cross-checked all three purpose strings against the registrations
  (`src/harness/codex-v1/owner-trusted-local-run-registration.ts:33`,
  `src/harness/claude-code-v1/local-run-registration.ts:27`,
  `src/harness/hermes-local-v1/local-run-registration.ts:32`) — they match exactly. This is what stops a
  result from one delivery being replayed under another's run.
- **Time is bound to observation.** `result.receipt.receivedAt` must equal `run.finishedAt`
  (`:131`) and the terminal event must be a `lifecycle/succeeded` event (`:117-118`). The
  publisher now stamps `receivedAt` from the observed terminal event
  (`owner-trusted-local-cli-publish.ts:114`), which is what makes this binding coherent — the
  receipt time is the observed completion time, not the earlier delivery-receipt time.
- **Job/attempt/lease still verified.** All three are re-read under `FOR UPDATE` and
  cross-checked against their payloads, versions, epochs and expiry (`:152-172`).

Findings: none.

---

## 4. Run lifecycle — observation-driven and replay-idempotent. No finding.

**Success/failure is driven only by what the host observed.**

- The terminal state is chosen by the caller of `record()`: `publish` passes `"succeeded"`
  only after the CLI process returned completed text; `recordFailure` passes `"failed"` only
  after the process reported failure (`owner-trusted-local-cli-publish.ts:97` and `:118`).
  `recordFailure` is invoked from the delivery bridge at exactly one place — the
  `execution.kind === "failed"` branch (`owner-trusted-local-cli-delivery.ts:119-123`) — and
  never on the publish path. A failed process cannot produce a result: `publish` is not called.
- The events are authenticated lifecycle observations written through
  `HarnessRunStoreV1.append`, which enforces legal transitions
  (`src/harness/v1/store.ts:166` against `src/harness/v1/lifecycle.ts:4-16`:
  `discovered → starting → running → succeeded`, or `discovered → failed`) and stamps
  `startedAt`/`finishedAt` from the event it actually wrote
  (`owner-trusted-local-cli-publish.ts:85-89`). `succeeded` is terminal and cannot be
  re-entered (`transitions.succeeded = []`).
- `publish` refuses to proceed unless the last event is a `lifecycle/succeeded`
  (`owner-trusted-local-cli-publish.ts:100-101`) and binds
  `terminalEvidenceDigest` to that exact event (`:108-109`) — so the durable receipt is
  cryptographically tied to the observed terminal transition, not merely to a caller assertion.
- No request field can assert completion: the reader requires the stored run state to be
  `succeeded` *and* the terminal event to be `lifecycle/succeeded`
  (`durable-local-result-inspection.ts:115-118`).

**Replay is idempotent.**

- Run registration: on retry, `record()` reconstructs the initial projection from the
  authenticated existing run and requires the digest to match, rather than re-inserting
  (`owner-trusted-local-cli-publish.ts:69-76`).
- Lifecycle events: each state is appended only if no prior event carries it
  (`:81-82`), and the sequence is `snapshot.events.length + 1` (`:86`), which
  `appendWithin` verifies against `last_sequence` (`store.ts:158-159`).
- Verified by test, not just by reading: a replay adds no second run and no second lifecycle
  event — `tests/owner-trusted-local-cli-publish.test.ts:84-85` asserts the event count stays
  at exactly 3. Passing.
- Failure replay: the delivery bridge's one-shot receipt fence
  (`owner-trusted-local-cli-delivery.ts:93-98`) returns `already_delivered` before execution,
  so a failed run cannot be re-executed; `recordFailure` is called once and not again
  (`tests/owner-trusted-local-cli-delivery.test.ts:54-61`, passing).
- Terminal-state re-entry is blocked explicitly: `if (snapshot.run.state === terminal) unavailable()`
  (`owner-trusted-local-cli-publish.ts:83`).

Findings: none.

---

## Required before merge

1. Reorder the reader's locks parent-first in
   `src/completion-gate/v1/durable-local-result-inspection.ts:101-158` (Finding 1).
2. Add a concurrency regression test that runs the sweep against a concurrent publish and
   asserts no `40P01`; document the canonical order at the reader as
   as `src/persistence/canonical-store.ts:1338` does
3. Restore a prompt sweep interval once the order is correct, or — if 15s is kept — amend
   `docs/claude/PACKAGE5_REHEARSAL_STATUS.md:18-21` to state that the interval is a latency
   choice made *after* the ordering fix, not a deadlock remedy (Finding 1).

Sections 2, 3 and 4 are approved as written.
