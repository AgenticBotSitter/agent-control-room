# Actual JWT candidates through owner setup and dispatch

2026-09-08; baseline c437014. Research-only in-memory adaptations; no production
code, authentication, database, account or deployment changes.

## What is newly demonstrated

Actual jsonwebtoken9.0.3 and jose6.2.12 now run inside the current verifier policy
and hash-pinned owner-bootstrap control flow, not merely a synthetic async stand-in.
The synchronous candidate passes30 expected scenarios and jose23 applicable ones;
the seven synchronous-control scenarios are omitted for the genuinely async library.
The unchanged default Node-crypto experiment still passes30 on recheck.

Thirty-six further scenarios run actual task-http, news-collection-http and
private-process composition, including the real access-key-cache and shared error
mapping. Each candidate preserves valid request success and missing-token, bad
signature, wrong-audience and expired-token401 behavior across all three selected
paths. No denied request calls the injected operation. Six held jose valid/invalid
cases verify no operation occurs before release and correct success/refusal afterward.
Private-process closes its fake pool once. Other imports use current repository
modules; only the listed main modules are individually hash-pinned.

The selected paths are task listing, news collection proposal and Idea options.
They establish caller identity/error-ordering fit, not every task/review/submission
branch, news approval, injected operation's authorization, full UI, browser or live
owner login. The injected operations observe a frozen non-Promise identity and
subject; the earlier consolidated project tests check the complete identity fields.

## Migration consequences remain concrete

Jsonwebtoken preserves all synchronous caller signatures. Both candidate wrappers
replace custom JWT JSON parsing and direct RSA verification while retaining strict
CR byte/schema/key/session policy. Jose requires awaited identities in each consuming
route and repeated owner-bootstrap checks. Existing synchronous factory validation
must remain synchronous for access-key-cache.

Actual candidate bootstrap cases reproduce the earlier intentionally defective
await-only controls: expiry/cancellation during final verification can reach the
simulated commit; post-await freshness checks prevent it. The command positive
controls succeed, while expiry during preflight is stopped before a fake connection
opens only in the freshness-aware variant. SecurityStore writes and commits remain
counters, not real PostgreSQL behavior or rollback evidence.

Discarding the precommit Promise permits simulated commit before final verification
finishes. Jsonwebtoken's receipt reaches the authored fourth-verification held gate
before commit. Jose records only three completed verifications at that moment:
its actual async verification is still pending, so do not claim its authored fourth
gate was already acknowledged. Both pending valid paths are released/settled before
process exit. Neither negative control is a vulnerability claim against current code
or the candidate library.

The illustrative freshness adaptation still needs a complete post-await high-water
contract; it is not a patch to copy into production. Rehearsal resource-preflight
mapping, comprehensive key-cache invalid-trust cases and final selection/cost rubric
remain. Retain the original immutable caller inventory and its limitations.

## Failure, provenance and resource record

The first dispatch fixture failed during actual Idea registry construction because
the fake DB lacked its required transaction method. One correction supplied a
fail-on-call transaction sentinel. The next test process exited0 with36 scenarios.
Its imported modules emitted Node's experimental SQLite warning; no SQLite database
was opened by this fixture. Parsing the combined tool output initially failed on
the warning prefix, then the same retained output was parsed at its JSON boundary.
No test rerun was used to hide that capture correction.

Reacquired the same16 integrity-pinned packages from the prior ledger into the
logged1.33MiB owned cohort, with scripts/audit/funding disabled and own cache.
Lock metadata differs from the earlier recreation; package versions/integrities and
selected entry hashes are checked, not assumed from the old lock checksum. The new
lock checksum is recorded separately. Resource RSS in each receipt includes tooling
and synthetic keys, not standalone candidate/server usage. No benchmark winner is
inferred. Cleanup status is in the acquisition ledger; no production dependencies
were installed. Independent source review accepted the bounded comparison and its
jose pending-verification qualification. After terminal calls and review, the owned
1364KiB root was removed and absence verified. Full selection remains separate.

Reproduce with `node --import tsx research/reuse-comparisons/f8-bootstrap-async-contract.mjs
<owned-root> jsonwebtoken` (or `jose`) and `node --import tsx
research/reuse-comparisons/f8-dispatch-callers-fit.mjs <owned-root>`.

[Shared adapter](../../../research/reuse-comparisons/f8-candidate-verifiers.mjs),
[jsonwebtoken receipt](f8-bootstrap-jsonwebtoken-evidence.json),
[jose receipt](f8-bootstrap-jose-evidence.json),
[dispatch receipt](f8-dispatch-callers-evidence.json),
[acquisition ledger](f8-jwt-callers-acquisitions.json),
[independent review](f8-actual-callers-review.md).
