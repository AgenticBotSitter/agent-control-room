# JWT caller adaptation audit

2026-09-08; source checkpoint f2bac29, inspected current source. Research only;
no authentication, provisioning, dependency or application changes.

## Decision-changing finding

The asynchronous candidate is not a one-line replacement. Seven production source
files contain eight factory construction sites. Six files actually consume verified
identities; the seventh validates trust synchronously without verifying a token.
Owner bootstrap has repeated verification and a precommit callback that must not
discard a future Promise. The executed project HTTP adapter does not prove those
other callers. Keep selection open until this distinction is exercised.

| Source under src/web/v1 | Current contract | jose adaptation | jsonwebtoken adaptation |
|---|---|---|---|
| project-http.ts | Synchronous identity within async request handler | Await verification before any service call; executed in consolidated experiment | Keep caller signature; executed in consolidated experiment |
| task-http.ts | Synchronous identity shared by task/review/assignment branches | Await once before routing; exercise denial before injected operations, including submission and revision | No caller signature change; run route regression tests |
| news-collection-http.ts | Synchronous identity before body read and propose/approve | Await before either operation; recheck downstream time after body await | No caller signature change; existing body-await freshness still matters |
| private-process.ts | Async key loading, then synchronous identity for all private dispatch | Await verification after keys load; preserve drain/error handling and test injected Idea operations as well as normal services | No additional await; do not remove existing key-cache freshness checks |
| private-owner-bootstrap.ts (two factories) | verifyPinnedOwner, repeated current(), deployment command preflight | Make helper/current async; await four current call sites; return or await precommit check; await command preflight before openDatabase | Preserve helper/callback signatures; execute full bootstrap regressions |
| private-database-rehearsal.ts | Synchronous claims check inside async rehearsal before resource acquisition | Await claims then recheck elapsed-time/cancellation limits before resource acquisition | Preserve caller signature; run synthetic rehearsal regressions |
| access-key-cache.ts | Factory construction validates key material synchronously | Keep factory validation synchronous; only returned token verifier may be async | Preserve synchronous validation |

The eight construction sites are project-http:15, task-http:24,
news-collection-http:9, private-process:173, private-owner-bootstrap:33 and97,
private-database-rehearsal:93, access-key-cache:65 at this checkpoint.
These are source references, not permanently stable line identifiers.

## Freshness must survive adaptation

`private-owner-bootstrap.ts` calls current() before entering a transaction, on
transaction entry, before SecurityStore.bootstrapOwner, and in the precommit hook.
Its command wrapper separately verifies before opening a database. Simply making
verifyPinnedOwner async would leave unawaited checks and change identity values to
Promises. A correct implementation must retain failure-before-open and
failure-before-commit behavior and monotonic/cancellation checks. After asynchronous
verification, resample time and enforce the verified identity's expiry; do not accept
the original pre-await clock as evidence of freshness at the next effect boundary.

The existing WebSessionAuthority.authenticated entry and precommit checks provide
freshness enforcement for callers actually routed through that authority. Four
direct synthetic checks already demonstrate its entry behavior. This does not prove
owner bootstrap, rehearsal, or every injected private-process operation uses it.
Do not infer coverage from an identity type or one passing route.

## Exact scope versus estimates

For a synchronous candidate the production implementation target is one verifier
module plus package manifest/lock and attribution; caller signature edits: zero.
For jose, target the verifier plus six identity-consuming files; key-cache is a
required validation regression target, not necessarily an edited file. Both require
focused tests and attribution updates. No database migration, provider replacement,
new service, or upstream fork is required by either option.

Both remove the direct JWT JSON.parse use and signature verification block, but not
canonical byte checks, strict header/claim schemas, deployment-selected keys, session
limits, token digests, authorization or origin checks. A whole-auth deletion or net
line saving would be misleading. Estimated development time and performance ranking
remain unknown; the prior combined-process timings are not a fair server benchmark.

## Follow-up evidence and remaining discriminating experiment

The [async contract experiment](f8-bootstrap-async-contract-fit.md) now executes
30 scenarios through the actual owner-bootstrap control flow with a delayed real
Node verifier and fake persistence. It demonstrates post-await freshness and
precommit Promise propagation requirements, with intentionally defective controls.
It is not execution of jose/jsonwebtoken inside bootstrap; keep that limitation
when reusing this evidence.

Load the actual owner-bootstrap module with each candidate adapter and a synthetic
database sentinel, never a live connection. Test valid owner, wrong owner, expired
trust/token, cancellation, expiry while verification is held, transaction entry,
precommit expiry and database-open suppression. Include an intentionally unawaited
candidate as a negative control. Then run task/news/private dispatch seams against
held valid/invalid results with injected operations. Only after those cases and an
independent challenge should the library decision close. No need to repeat the99
unchanged policy cases merely to rediscover this source-level contract difference.

Evidence: [consolidated fit](f8-jwt-consolidated-fit.md),
[independent review](f8-jwt-consolidated-review.md).
