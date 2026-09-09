# Independent shutdown and typed-queue review

2026-09-08. Source/retained-receipt review only. No reruns, installs, services, application changes or driver selection. Reviewed the shutdown fixture, both shutdown receipts, runner cleanup, actual bounded-database wrapper, installed Postgres.js end/terminate and pg8.23.0/pg-pool lifecycle source, and the added typed queue branch with its receipt. The previous driver-contract P2 is now explicitly corrected: fetch_types:false JSON non-repair is source inference, not an executed binding result.

## Disposition

No blocking discrepancy found in the shutdown report's narrow observations or the four typed queue cases. These are useful negative-preserving comparisons, not a passed shutdown contract for all candidates. Parent exit0 means the corrected experiment completed; two candidate close calls explicitly returned database_close_uncertain.

The source/receipt supports:

- An independent pg Client observes one active server session before close. The second application operation enters checkout behind a one-connection pool; at the recorded point only one lease and one SQL query were issued. Both outstanding application promises reject and future work is refused. These are actual wrapper/driver observations, not assertions that the underlying pending checkout promise has already been removed from every driver queue.
- Postgres.js close resolves at 3ms; pg Pool.end and tracked Client.end-then-Pool.end exceed the intentionally shortened 500ms close ceiling. Both initial/corrected receipts preserve the Postgres.js session still present immediately afterward. The observation counts sessions, not their instantaneous query state, so it must not be restated as proof of continued active execution at every sample—or proof that execution stopped.
- The initial failure is a cleanup assertion after the first candidate, not a driver value/assertion failure. Increasing only the post-result cleanup observation window from two seconds to 5.5 seconds does not alter candidate close bounds or the retained adverse result. Initial exit1 and parent-owned cluster cleanup remain preserved. Corrected receipt records session absence after explicit cleanup for all three candidates, then cluster stop/removal. This is not independent OS-wide descendant enumeration.

## What maintained source explains—and does not

The actually resolved pg package is the cohort's pg8.23.0 (`node_modules/pg/lib/index.js`); its pg-pool is the same cohort's `node_modules/pg-pool/index.js`.

- pg-pool `end` (lines488–499) sets ending and pulses the queue. `_pulseQueue` (127–146) removes idle clients and resolves only when its client list is empty; it does not immediately cancel every checked-out operation or reject each existing pending checkout there. `_release`/`_remove` (172–185,385–397) are important to completion after a lease is returned. Thus plain Pool.end is not inherently a force-active-and-queued-work adapter.
- pg Client.end (781–819) has distinct paths: dead connection destruction, pipelined-work drain, active non-pipeline connection destruction, or graceful end; its promise waits for connection end. `pipeline = Boolean(c.pipeline)` (101) is false in this fixture. The comment about a busy client being disconnected is therefore applicable to the intended configuration, not a universal description of all Client.end modes.
- The tracked experiment does **not** timestamp/observe completion of each Client.end separately from the subsequent Pool.end. Its 503ms result therefore cannot identify which awaited phase delayed, prove a particular internal race, or establish that public Client.end always waits for the SQL duration. Source identifies relevant lifecycle differences but does not resolve this observed composition's delay. Preserve this as a specific unknown before relying on tracked-client termination.
- Postgres.js `end({timeout:0})` races normal connection end against destroy (`src/index.js:365–388`); terminate rejects work and initiates socket end (`src/connection.js:404–425`). This explains why application-side shutdown can finish before a server-session disappearance observation. It is not a transactional rollback acknowledgement.

The actual wrapper invalidates operations before invoking terminate, and its catch paths await the bounded close promise. Consequently pg's database_close_uncertain operation errors can supersede initial outcome uncertainty without implying successful SQL completion. No mutating SQL, transaction reconciliation, failed COMMIT, restart or production role tests occur here. Recorded timings are single fixture observations, not comparative performance claims.

## Typed queue branch

The added branch retains actual boundPrivateDatabase, reserves the same Postgres.js connection for a transaction, wraps only string parameters in public text-OID typed values, and uses unsafe with prepare:false/simple:false. fetch_types:true is explicit; this does not repair the prior cold fetch_types:false path or cover uncast application parameters.

The retained exit0 receipt matches all four shared assertions: marker and queue rollback on precommit rejection; actual submission/worker outputs for held then delivered; occupied canonical operational ID refusal with no extra delivery; malformed extra-field cancellation with no delivery. Deliver is synthetic, and its held disposition is not persisted canonical review/admission state. There are exactly two synthetic deliveries and no reported errors.

The nested-finally cleanup ensures the independent observation pool is asked to close even if database close rejects. Source supports that ordinary cleanup improvement; this receipt does not inject that rejection or validate forced shutdown. No queue engine winner, full driver adoption, production PG17/current-role acceptance or canonical live-work acceptance follows. Root retains those decisions and the remaining lifecycle/parameter gates.
