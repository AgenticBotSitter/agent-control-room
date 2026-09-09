# Driver shutdown comparison: observed limits, not adoption

2026-09-08. Existing owned PostgreSQL18.4 Unix-socket cohort, no TCP or production
data. Actual boundPrivateDatabase wrapper; only closeMs shortened from5000 to500
using its supported limits argument. Inert SELECT pg_sleep(3), then a second query
queued behind a pool of one. An independent maintained pg Client observes the
first active server session before queueing/closing; future app queries are refused.

Command: `node --import tsx research/reuse-comparisons/f1-postgres-run.mjs /private/tmp/cr-compare-f1.9x5bSO driver-shutdown`.

| Maintained interface composition | close result | close duration | Actual server sessions immediately afterward | SQL issued |
|---|---|---|---|---|
| Postgres.js end({timeout:0}) | Resolved |3ms |1 |1 |
| pg Pool.end() | database_close_uncertain |502ms |1 |1 |
| Tracked public pg Client.end(), then Pool.end() | database_close_uncertain |503ms |1 |1 |

All three invoke terminate once, refuse future work, and reject both outstanding
application operations. Postgres.js rejects them as database_outcome_uncertain;
both pg compositions report database_close_uncertain. All show only one acquired/
released lease and one SQL issue at the recorded point; the queued SELECT42 did
not issue. This is one specific active-plus-queued close case, not arbitrary
cancellation, transaction outcome reconciliation or a driver-wide benchmark.

**Do not call any variant proof that PostgreSQL execution is already stopped when
client close returns.** Client disconnection and server work cessation are distinct.
No mutating SQL was used. In production a lost acknowledgement cannot establish
rollback/non-execution; existing uncertainty quarantine must remain.

The tracked pg experiment is explicitly a narrow research composition, not a
completed replacement driver. Its failure does not reject node-postgres generally;
public lifecycle/queue semantics still need source review and a specified adapter.
No library-private socket destruction, undocumented cancellation or new DB grants
were introduced to make a result green.

Initial run stopped after the first variant because its cleanup observation ceiling
was2s, shorter than the already-running inert3s query. The parent stopped/removed
the entire cluster. Exact initial evidence remains. One cleanup-only correction
allows5.5s observation; all candidate close limits/results remain unchanged. The
second run completed all three variants with exact session-absence observations
after explicit cleanup, then parent cluster stop/removal. Cleanup explicitly calls
public end on owned clients and is NOT credited to the candidate's close result.
No retained services or native/provider calls. There are no live handles to poll.

Next: inspect the maintained pg pool/client shutdown and queued-checkout contract,
then compare a fully specified minimal adapter against the existing Postgres.js
route. Avoid a blanket engine rewrite for driver lifecycle behavior. Binding and
queue happy paths are already covered in f1-driver-contract-fit.md; don't repeat
them unchanged. Exact production PG17/roles and commit-uncertainty acceptance remain.
Independent review of this new shutdown packet is pending.
