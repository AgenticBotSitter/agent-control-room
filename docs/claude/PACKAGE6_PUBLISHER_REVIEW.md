# Package 6 publisher independent review

**Verdict: APPROVE** for commit `8ba905b8` only. This is a source and disposable-database review, not approval to change a live database.

I compared `db/roles/local_result_publisher_roles.sql` and the changed grant in `db/roles/native_results_roles.sql` against the `publisherReads`, `publisherInserts`, `publisherUpdates`, `resultReads`, `resultInserts`, and `resultUpdates` maps in `src/web/v1/private-database-preflight.ts`. The table and column permissions match those maps exactly. The publisher cannot update a real harness-run or review-plan field: its two added UPDATE permissions touch only false-constrained lock columns. The native results role likewise gains only the false-constrained `results_lock` columns on review plans and artifact receipts. Migration 0089 adds the four constraints without changing existing result data or granting role membership. Neither role gains job, attempt, queue, or completion-gate write permission through this change.

The publisher path uses its own database pool for run registration and durable result publication; later review-tray registration continues under the existing results pool. I checked the new role test's real PostgreSQL privilege probes. Both publisher tests passed, including fresh-run insertion, exact replay, and denial of unrelated writes (2 passed, 0 failed). No live systems were touched.

Review-method note: the preflight map and SQL grants are separate declarations, so exact agreement was checked directly; the successful tests are supporting evidence, not a substitute for that comparison. The verdict is scoped to `8ba905b8` and does not cover later commits on Claude's branch.
