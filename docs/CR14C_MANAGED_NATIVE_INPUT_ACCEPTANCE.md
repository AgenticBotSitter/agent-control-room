# CR14C managed native input acceptance

## Delivered and reviewed

The supplied-resource runtime exposes a frozen input facade with one bounded FIFO for
signed incoming frames and explicit stage/transmit commands. Initial receipt registration
precedes queued progress; reconnect reconciliation restores exact recorded work before
the retained snapshot/ACK suffix. No host test driver selects separate server operations.
See `CR14C_MANAGED_NATIVE_INPUT_CONTRACT.md`.

Independent production review accepted `46d1188` against `cea6084` with no remaining
actionable findings. Earlier findings and fixes are retained below. This is static
acceptance plus separately executed tests, not live fleet acceptance.
Independent test re-review accepted `f0df8de`, closing its requested evidence corrections.

## Executed evidence

- Stage zero: exit 0, `ready_for_runtime_check`; no setup or native qualification run.
- New actual input integrations: 3 passed (receipt/progress, offline retained journal,
  lost acknowledgement replay). Wrong-attempt and actual replacement-precommit tests:
  2 passed. Fake-handle queue suite: 21 passed, including fake-clock expiry while
  waiting and after dequeuing without a renewed budget.
- Final combined run: 88 passed, zero failed/skipped. It includes the three new files,
  signed ACK regressions, result coordinator, evidence receiver, startup/facade, compiled
  managed-session tests and eight test-inventory checks.
- Existing managed/revised/reconnect/reporting/compiled regression run: 46 passed.
- TypeScript, full ESLint and private VPS build passed. New tests are registered in the
  normal package lifecycle. No schema/role change was introduced; no physical database
  rehearsal or fresh full lifecycle run is claimed by these scoped results.
- Prerequisite PR #341 at `cea6084873d243bb9d011875fc5d93b872803d15` passed all nine
  GitHub checks in run `34017958371`; it remains open and unmerged.

## Retained findings and corrections

1. Initial typecheck rejected the staging return union. Stage now checks its actual
   envelope receipt shape before returning the narrowed result.
2. Review found source-generation fencing stopped before separate result transactions.
   The result writer now checks the source around queries and final precommit. Actual
   generation replacement rolls back review registration while preserving the earlier
   committed run; it is not falsely reported as complete rollback.
3. Review found mutable internal class fields exposed through `attachInput`. The manager
   now returns only a frozen closure-backed facade; startup tests inspect its exact keys.
4. Review found wrong configured attempts rejected only after durable staging. The fixed
   attempt is now checked inside authenticated stage/transmit before signing/store writes.
   The negative test proves unchanged records and successful later correct staging.
5. Review found valid delayed ACKs rejected after staging. ACK-only handling now accepts
   prepared/sent/receipted states while preserving strict authentication, known IDs,
   sequence ceilings and reconciliation-only report handling.
6. An early 29-entry regression run passed 28 and failed the old startup API-key assertion;
   the new `attachInput` key and exact frozen facade are now explicitly verified.
7. The first 18-entry unit run passed 16: two fixture errors assumed an internal class
   was the facade and omitted required receipt causation. The author corrected both.
   A later prefer-const lint finding was separately corrected without behavioral change.
8. The first 11-entry ACK run passed 10: a synthetic ACK had not consumed its durable
   node sequence, causing a subsequent genuine receipt collision. The fixture now stages
   that signed ACK in the real node journal. Final combined checks include the correction.
9. Independent test review requested exact reconnect frame order/body and unchanged
   protocol/delivery/audit state after old-generation progress denial. The author added
   those assertions in `f0df8de`; the result-review title now explicitly says pending
   review, not completed owner review.

Workers used two isolated source-only checkouts. Stage zero correctly returned
`setup_required` (missing dependencies); they performed no installation or runtime tests.
One protected Git metadata failure was reported without retry. Root committed stopped,
reviewed allowed-path changes and executed the tests centrally. No setup failure became
a runtime pass.

## Limits and next work

All agents, transports and provider responses here are disposable/synthetic. The code
does not open a physical listener, use owner credentials, deploy, start Hermes, or grant
implicit execution authority. Native result bytes remain supplied by the trusted host.
An owner signing configuration and node runtime host still need composition and scoped
real acceptance before the first real website-to-agent task can be claimed.

Continue with the node-side supplied-resource runtime that connects approved intake,
explicit handoff, saved observation reporting and bounded lifecycle cleanup. Use existing
policy/journal/adapter services, not a second scheduler or new permission model. Astra
Medium remains the root setting. Live activation and owner-signing custody are separate
gates; PR #329 is not adopted or reopened by this block.
