# DBOS actual PostgreSQL transaction fit

2026-09-08. The owner approved the seventeen package-local links. Root verified
every source regular file and missing destination within the exact disposable
package, ran the previously inspected hydration script, then verified all seventeen
resolved links. No global install, package-manager lifecycle sweep or new download.

## Result

DBOS4.27.6 now runs on the disposable PostgreSQL18.4 cluster through Control Room's
unchanged `createPostgresClient` / `DatabaseSession` transaction adapter. Five
observations completed, exit0: actual schema migration; marker and enqueue commit;
precommit refusal rolls both back; repeated workflow ID with changed payload retains
original input; unsupported return-existing policy is refused.

The client is the real pinned installed SDK. Its supplied query bridge delegates
to the current application SQL session. It is not a rewritten candidate insert.
However, the marker is synthetic: this does not execute canonical task admission,
full current schema, actual queue pickup, agent start or review-wait workflows.
No final winner or production PG17 qualification follows from these five cases.

## Preserved setup failures and explicit corrections

1. After hydration, sandbox initdb failed on shared-memory permissions, before
   server start. Exact fixture child removed. The same reviewed runner then received
   execution approval outside that restriction; no kernel configuration changed.
2. PostgreSQL started, but the package contains no psql for the fixture's readiness
   command. Server stopped and child removed. Root replaced only that read-only
   check with the already installed actual `pg` client over the owned socket.
3. Migration succeeded, then the application adapter connection failed. Root
   inspected installed postgres.js `parseOptions`: libpq-style `?host=` does not
   select its socket. Root explicitly approved this second setup-only correction:
   use supported PGHOST/PGPORT/PGUSER/PGDATABASE in the sterile fixture child before
   constructing the unchanged application client. No DBOS SQL or production code
   was patched, and no earlier failure is converted into a pass.
4. Corrected run passed all five observations and stopped/removed its cluster.

The runner configures an owned Unix socket, no TCP listen address, trust only for
the private local fixture and host rejection. It checks `SHOW listen_addresses`
is empty before the comparison. pg_ctl has bounded start/stop; child execution is
bounded. After stopping, runner checks pid/socket absence before exact child
deletion. The reusable downloaded distribution and approved links are retained
for remaining comparisons, not claimed cleaned. No production server is touched.

`f1-postgres-transaction-evidence.json` explicitly transcribes tool-returned terminal
output; it is not advertised as a directly captured stdout file. No successful
rerun is needed solely to create another receipt. Existing scripts are reproducible
inputs; exact earlier acquisition pins remain in the F1 ledger. Disk before this
work was145440260KiB free; no memory benchmark or whole dependency-integrity
revalidation was performed during these runs.

## Selection consequence

The earlier PGlite/setup failures no longer block evidence for the caller-owned
transaction seam. DBOS is a real contender for that responsibility alongside
pg-boss. Changed-input retention is not canonical authorization: a caller must
still refuse mismatched intent rather than adopt an old operational workflow.
Next compare the genuinely missing canonical admission, uncertainty/recovery,
eligibility/concurrency and schedule responsibilities. Reuse these transaction
observations instead of repeating the old failing migration setup or treating
Hatchet's remote transaction as equivalent to either same-session route.
