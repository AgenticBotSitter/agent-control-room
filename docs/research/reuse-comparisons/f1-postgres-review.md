# Independent DBOS/PostgreSQL transaction and read-recovery review

2026-09-08. Source/receipt-only review of `f1-postgres-run.mjs`, `f1-dbos-fit.mjs`,
`f1-dbos-recovery-fit.mjs`, the transaction report, both evidence JSON files and
the unchanged `src/persistence/database.ts` adapter. No execution, source download,
service operation or package mutation. The separate recovery narrative was not yet
present when inspected; this review concerns its actual fixture and direct receipt.
Root retains final selection and integration acceptance.

## Disposition

No material blocker to the **narrow observations reported**. These runs remove the
previous setup obstacle to DBOS's caller-owned transaction comparison. They do not
select DBOS over pg-boss or establish canonical task admission, worker execution,
engine crash recovery, review waits, race safety or production PostgreSQL17 support.

### Actual candidate and application seam

Both fixtures resolve the real installed DBOS4.27.6 client and migration function;
the native path uses the actual `pg` pool for setup/readback. Enqueue's supplied
query port delegates to the transaction session from CR's unchanged
`createPostgresClient`. That adapter calls postgres.js `begin`, awaits the callback
and precommit check, and commits only after their success. No rewritten DBOS insert
or fake transaction implementation manufactures the observed commit/rollback.

The marker and workflow names are synthetic. The rollback case explicitly checks
both marker absence and workflow-row absence; the positive case observes the real
workflow row after the committed marker/enqueue transaction. This is representative
database-interface fit, not the full current schema or permission/eligibility logic.
`rowCount` is structurally supplied from returned rows/affectedRows; this narrow
successful path does not prove that translation is correct for every future SDK
statement. No broad adapter-equivalence claim should be added.

### Duplicate identity and recovery evidence

- Transaction replay with the same workflow ID and changed input compares stored
  input rows before/after and retains the original bytes. It does not establish that
  the caller's changed intent is authorized or rejected; CR still needs its own
  canonical mismatch handling.
- The recovery fixture issues two promises using separate CR SQL transactions and
  observes two handles with one workflow ID and one row retaining either submitted
  input. Its receipt explicitly does not guarantee overlapping engine critical
  sections. It is parallel-client submission evidence, not a deterministic race test.
- Two independent workflow rows demonstrate enqueue independence, not concurrent
  worker pickup or continued productivity while reviews wait.
- The injected acknowledgement loss occurs **after `await enqueue` returns from
  a known committed transaction**. Read recovery calls actual DBOS retrieval and
  does not increment the local enqueue counter. This is meaningful read-after-commit
  recovery, not an observed dropped database response or uncertain commit outcome.
- Reconstruction destroys/recreates the SDK client and CR driver while keeping the
  same live cluster and pool. Preserved inputs and no further enqueue are asserted.
  No worker, engine process or server crash/restart occurs in this case.

The direct recovery receipt reports four observations, exit0, five enqueue calls,
and cleanup. Its limitations match the source. The earlier five-observation receipt
is explicitly a root transcription of tool output rather than a direct stdout
capture; the report does not hide that provenance difference.

### Isolation, bounded execution and cleanup

The runner creates a fresh child beneath the explicit owned root, checks restrictive
root mode, creates a0700 socket directory, initializes local trust/host rejection
and starts PostgreSQL with an empty TCP listen address. Actual readiness checks
`SHOW listen_addresses` equals empty via the selected socket. The child's sterile
environment receives only the fixture socket identity before creating the unchanged
CR driver; it does not connect to the user's configured database.

Server commands are timeout/output bounded; the research child has a60-second bound.
The finally path stops the owned cluster, confirms pid/socket absence and removes
only that fresh child. If stop is unconfirmed it retains the child for inspection
instead of deleting a possibly active cluster. This review checked those source and
receipt assertions, not fresh OS process state. The reusable downloaded package root
and its explicitly approved hydration links remain retained; reports correctly do
not call the entire acquisition cohort cleaned.

### Preserved failures and corrections

The new transaction report/receipt preserve shared-memory initdb refusal, missing
packaged psql, and application-driver socket-selection failure before the successful
run. The two fixture corrections are source-visible and scoped: use installed pg
for the readiness query; use postgres.js-supported PG environment parameters for
the owned socket rather than assuming a libpq URL query. No DBOS SQL, application
adapter or canonical policy was changed. Older PGlite uuid/concurrent-migration and
unhydrated ICU failures remain in the earlier dossier/ledger, not converted to passes.

The launch fixtures check candidate/package versions but do not rehash the entire
installed candidate/dependency tree before import. The report explicitly disclaims
a fresh whole-dependency integrity revalidation and links earlier acquisition pins;
this is not grounds to invalidate the historical run. Do not market it as an
independently reverified exact package-byte closure.

## Next decision, without repeating accepted observations

Use these receipts for same-session transaction admission and known-commit read
recovery. The actual remaining discriminators are canonical admission/intent binding,
uncertainty at the effect boundary, eligible pickup/review waits, schedules and
integration/removal cost against pg-boss and the viable Hatchet interface. A new
counter label or repeated synthetic marker happy path will not answer those questions.
