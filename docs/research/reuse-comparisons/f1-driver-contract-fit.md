# Actual driver contract comparison

2026-09-08. Research only; no application/dependency/configuration changes.
Base08f4eb6 plus the linked local research fixtures. PostgreSQL18.4 over an owned
0700 Unix socket with TCP disabled. Node22.22.3, Postgres.js3.4.7, node-postgres8.23.0.
No downloads, credentials, providers or production database. Stage zero reported
ready_for_runtime_check. Existing retained tools reused; free storage139GiB.

## Exact experiment and correction

`node --import tsx research/reuse-comparisons/f1-postgres-run.mjs /private/tmp/cr-compare-f1.9x5bSO driver-contract`

The new fixture executes five independent processes, eight seconds each, under
the existing sixty-second parent/owned-cluster lifecycle. Every acquire/query/close
stage is emitted immediately. Parent receipts retain per-process exit, elapsed time,
stdout and failure metadata; parent success means experiment finished, not all cases
passed. Initial and corrected receipts are both retained next to this report.

The first run revealed a fixture mistake: deepStrictEqual treats Postgres.js's
Result Array subclass differently from an ordinary Array. One correction compares
`[...rows]`, preserving every row/value while ignoring an unpromised collection
prototype. No candidate behavior, SQL, expected value or failed observation was
changed. The corrected full matrix ran once. Both disposable clusters stopped and
were removed by the parent; no process handle remains from either attempt.

## Results at the actual DatabaseSession boundary

All variants use the actual boundPrivateDatabase transaction/acquisition/close wrapper.
The Postgres.js variants use the actual privatePostgresOptions builder but override
the target to the synthetic Unix socket, blank synthetic password, pool size1 and
connect_timeout2. Binding variants enable fetch_types to isolate the distinct cold
acquisition issue. Queries retain prepare:false/simple:false. This is not the exact
production constructor, loopback namespace, PostgreSQL17, role or password preflight.

| Variant | Eight value cases | Precommit rejection | Cold acquire/reacquire | Corrected process duration |
|---|---|---|---|---|
| Plain Postgres.js, fetch_types:true | Five pass; serialized JSON array/object/string fail | Empty marker table after rollback | Acquires for these operations |78ms |
| Public sql.typed(string,25), fetch_types:true | Eight pass | Empty marker table after rollback | Acquires for these operations |75ms |
| node-postgres Pool/Client | Eight pass | Empty marker table after rollback | Acquires for these operations |76ms |
| Production-like Postgres.js fetch_types:false | Not attempted | Not attempted | First acquire never emitted acquired; existing wrapper returned database_outcome_uncertain, then closed |5079ms |
| Matching Postgres.js fetch_types:true control | Not attempted | Not attempted | First SELECT and release/reacquire SELECT pass, then closed |94ms |

Values checked: serialized array through json_to_recordset, serialized object JSONB,
serialized JSON string, ordinary object input, text with quote/backslash, UUID, text
array and null. Plain binding produces a scalar instead of the JSON array and stores
serialized object/string text as JSON strings; the failures remain in a normally
completed comparison process. The other five plain value cases pass. Typed binding
uses the public text OID only for strings; all tested SQL contexts have explicit casts.
This does not authorize wrapping all production strings without a call-site audit.

These process timings include loader/connect/query/cleanup overhead, one cold sample,
and are NOT a latency benchmark or memory comparison. No RSS measurement was taken.

## Decision impact and remaining finite evidence

The prior cold-reserve source concern now has a localized runtime observation with
the real private options builder and bounds. It remains narrower than a production
outage diagnosis. Actual prepare:false with fetch_types:true does not cure serialized
JSON. The fetch_types:false case never acquired a lease or executed binding; its
expected non-repair of JSON serialization is source inference only, as explained in
f1-database-driver-source-review.md. Independent review's P2 wording correction is
accepted here; no additional execution was needed.
Typed binding is a viable supported alternative, not a custom serializer or an
upstream fork. Node-postgres retains its earlier four-case actual CR queue result.

The subsequent typed-binding queue comparison now passes the SAME four cases as
node-postgres: actual CR precommit rollback, held/delivered outputs, occupied-ID
refusal and malformed cancellation. Command uses the same runner with mode
`cr-worker-typed`; exact exit0 receipt is f1-pgboss-cr-typed-evidence.json. Two synthetic
deliveries, errors empty, cluster stop/removal confirmed. The fixture adds a public
typed Postgres.js lease under the existing bounds with fetch_types:true; it does not
repair the fetch_types:false cold path. One nested-finally correction ensures the
separate observer pool closes even if database close rejects; no failure injection
or forced-termination acceptance follows from that correction.

Before driver selection, compare active/queued lease shutdown and uncertain transaction behavior under the actual
bounded interface. Plain pool.end is not yet forced active-lease termination. Preserve
parameter semantics beyond the sampled casts, exact canonical IDs, precommit checks,
queue profile guards and no-retry behavior. Do not change the queue engine merely
to conceal this transport mismatch. Full current-schema PG17/private-role acceptance
and real production startup remain separate work.

Existing source provenance and alternatives are in f1-database-driver-source-review.md.
No dependency, license or production-line removal claim follows from this fixture;
both drivers were already retained for authorized comparison. Independent review is
requested separately; this report does not self-approve adoption.
