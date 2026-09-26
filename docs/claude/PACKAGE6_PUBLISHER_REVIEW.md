# Package 6 — fifth Mac login (`control_room_local_result_publisher`) review

**Reviewed by:** Marvin (independent, read-only) · **Commit:** `8ba905b8` (parent `e492ea75`)
**Scope as assigned:** the owner approved the fifth login, the `results_lock` columns, and the
publisher's read-only access to workspaces, identities and role grants. This review judges only
whether those were implemented exactly as approved — not whether they should exist.

**VERDICT: APPROVE**

Every finding I set out to test came back clean. Details and the evidence for each are below, so
the approval is auditable rather than a rubber stamp.

## Verification performed

- Parsed `db/roles/local_result_publisher_roles.sql` and the `publisherReads` / `publisherInserts` /
  `publisherUpdates` maps independently and diffed them mechanically (not by eye). Result below.
- Confirmed the preflight introspects **column-level** privileges
  (`has_column_privilege(...)` for `SELECT`/`INSERT`/`UPDATE` at `private-database-preflight.ts:372-379`),
  so the maps are an enforced ceiling, not documentation.
- Ran `tests/mac-local-local-result-publisher-role.test.ts` — 2/2 pass, and
  `tsc --project tsconfig.vps.json` exit 0 with no output.
- Confirmed no product code was changed by this review.

## 1. Do the grants match the preflight maps exactly?

**Yes — mechanically, with zero drift in either direction.**

| Set | SQL-only | Map-only |
|---|---|---|
| Reads (14 tables) | none | none |
| Inserts (7 tables) | none | none |
| Updates (4 tables) | none | none |

Per-table update columns also match exactly:

| Table | Columns |
|---|---|
| `control_harness_runs` | `publisher_lock` |
| `control_native_review_plans` | `publisher_lock` |
| `control_durable_result_write_reservations` | `state`, `contract_digest`, `reservation`, `auth_tag`, `updated_at` |
| `control_audit_chain_heads` | `head_hash`, `event_count`, `updated_at` |

The `results_lock` grant added to `db/roles/native_results_roles.sql:32` correctly landed in
`resultUpdates` (`private-database-preflight.ts:144`), **not** in the publisher's map. No privilege
leaked from one role's map into another's.

## 2. Can the publisher write anything outside the publish path?

**No.** The role holds no `GRANT DELETE` at all, and no `UPDATE` on `audit_events`.

`identity_digest` on `control_durable_result_write_reservations` is correctly **excluded** from the
update grant while `state`/`contract_digest`/`reservation`/`auth_tag` are included — so the
compare-and-swap port can move a reservation's state without being able to re-point whose artifact
it authenticates.

The runtime test confirms the boundaries rather than assuming them. Under the publisher login it
proves denial on `UPDATE control_jobs`, `UPDATE control_attempts`, `UPDATE control_harness_runs`
(the real `state` column, not the lock), `INSERT control_native_task_queue`,
`INSERT control_completion_gate_records`, and `DELETE control_native_review_plans`.

One judgement call, recorded as correct rather than as a finding: the role **can** insert into
`audit_events` and update `control_audit_chain_heads`. That looks alarming until you compare it to
every other audit-writing role in the schema — `resultUpdates`, `ideaCreationUpdates` and the
evidence maps all carry the identical `control_audit_chain_heads: ["head_hash","event_count","updated_at"]`
grant. The publisher is not widened here; it is consistent with the established pattern. Forging
an audit chain is not a new capability the fifth login introduces.

## 3. Can any `*_lock` column carry a value other than `false`?

**No — and this holds schema-wide, not just for the new columns.**

Migration `0089` adds all four new columns with `NOT NULL DEFAULT false` plus an explicit
`CHECK (... IS FALSE)`:

- `control_harness_runs.publisher_lock` (`0089:14-15`)
- `control_native_review_plans.publisher_lock` (`0089:16-17`)
- `control_native_review_plans.results_lock` (`0089:24-25`)
- `control_native_artifact_receipts.results_lock` (`0089:26-27`)

I checked every other `*_lock` column in the schema for the same property. All of them carry a
false-CHECK: `web_lock` on `workspaces`, `control_identities`, `control_role_grants`,
`control_connection_registry_heads`, `control_completion_gate_integrity`; `coordinator_lock` on
`tenants`, `projects`, `control_nodes`, `control_node_keys`, `control_manual_project_heads`,
`control_harness_runs`, `control_node_fleet_signals`, `control_worker_delivery_receipts`;
`result_lock` on `control_jobs`; plus `evidence_lock` and `replay_lock`.

So the granted UPDATE privilege is genuinely inert: the role is permitted to write the column, and
the constraint guarantees the write is a no-op. `IS FALSE` is NULL-safe in a way `= false` is not,
so a NULL can never be introduced either.

## 4. Is any other role widened beyond inert lock columns?

**No.** The commit's entire `db/roles/` diff is 49 added lines and **zero deleted or modified
lines** — the new role file plus the single `results_lock` grant.

`control_room_native_results` gains exactly one line, and it is the inert pattern: UPDATE on
`results_lock` on two tables whose columns are `CHECK (IS FALSE)`. No real column on that role
changed. It is already granted `result_lock` on `control_jobs`, `coordinator_lock` on
`control_harness_runs`/`projects`, and `web_lock` on `control_completion_gate_records` — all
pre-existing and all inert by the same argument.

## 5. Pool wiring

The split matches the trust model, and the review-tray authority stays in the right place.

- `publisherPool` runs run-registration and `publishDurableResultV1` including the durable
  reservation (`mac-local-default-task-provider.ts:73`, `:86`, `:95`).
- `DurableResultReviewSubmissionServiceV1` is moved **off** the coordinator read pool and onto a
  dedicated `resultsPool` (`:83`). This is the important one: review-tray registration is the
  review-authority step, and it no longer runs under the coordinator client that the task planners
  also use.
- `assertCurrent` correctly stays on `readPool` (`:93`) — the lease/readiness fence must not depend
  on the publish login.
- Both new pools are closed on **both** paths: the success path (`:104-105`) and the `catch`
  path (`:113`). A leak on the failure path would leave a live connection per retry.
- `captureMacLocalDatabaseRolesV1` validates `publisher` with the same
  distinct-endpoint/distinct-username rules as the other four, and requires the exact key set, so
  a config missing the fifth role is rejected rather than silently defaulted.
- `mac-local-host.ts:127-128` adds the publisher username to the queue-worker preflight
  `loginNames`, which is required now that the publisher writes harness runs.

## 6. Approved read-only access

`workspaces`, `control_identities` and `control_role_grants` are `SELECT`-only, which is what was
approved and is the minimum the startup installation check needs. The columns are the owner's
workspace/identity row, the active owner grant, and a **digest** — `auth_subject_digest`, not a
credential. No secret material is exposed by these reads. The publisher is read-only on
`projects`, `control_workflows`, `control_completion_gate_records` and the idea tables; it does not
get those, and it correctly does not need to.

## Note for the lead, not a finding

The commit message records the per-agent journey still stopping before pending review at a masked
step, with Codex as next owner. That is outside this review's scope, but it means this login's
end-to-end completion is not yet demonstrated. The approval covers the **grants and wiring as
specified** — it is not a claim that the fifth-login journey reaches pending review today.

---

## Second independent review (Codex)

# Package 6 publisher independent review

**Verdict: APPROVE** for commit `8ba905b8` only. This is a source and disposable-database review, not approval to change a live database.

I compared `db/roles/local_result_publisher_roles.sql` and the changed grant in `db/roles/native_results_roles.sql` against the `publisherReads`, `publisherInserts`, `publisherUpdates`, `resultReads`, `resultInserts`, and `resultUpdates` maps in `src/web/v1/private-database-preflight.ts`. The table and column permissions match those maps exactly. The publisher cannot update a real harness-run or review-plan field: its two added UPDATE permissions touch only false-constrained lock columns. The native results role likewise gains only the false-constrained `results_lock` columns on review plans and artifact receipts. Migration 0089 adds the four constraints without changing existing result data or granting role membership. Neither role gains job, attempt, queue, or completion-gate write permission through this change.

The publisher path uses its own database pool for run registration and durable result publication; later review-tray registration continues under the existing results pool. I checked the new role test's real PostgreSQL privilege probes. Both publisher tests passed, including fresh-run insertion, exact replay, and denial of unrelated writes (2 passed, 0 failed). No live systems were touched.

Review-method note: the preflight map and SQL grants are separate declarations, so exact agreement was checked directly; the successful tests are supporting evidence, not a substitute for that comparison. The verdict is scoped to `8ba905b8` and does not cover later commits on Claude's branch.
