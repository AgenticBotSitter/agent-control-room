# Owner-bootstrap asynchronous migration contract

2026-09-08. Thirty local scenarios pass their expected assertions. This advances
the caller audit; it does not select jose, reject jsonwebtoken, or qualify production.

## What actually ran

The hash-pinned current owner-bootstrap module is transpiled and adapted only in
memory. Its real configuration schema, subject digest, monotonic checks, single-use
bridge, command preflight and transaction callback control flow execute. The actual
Node crypto verifier verifies freshly generated synthetic RSA tokens. An injected
async wrapper delays its returned identity. Neither candidate library runs here;
their parsing/signature behavior remains separately evidenced by the consolidated
comparison. This experiment isolates the additional asynchronous caller contract.

SecurityStore.bootstrapOwner is a write counter. Database transactions and opens
are sentinels, not PostgreSQL or PGlite. SQL target/workspace checks receive synthetic
rows. A commit count records that the tested control flow reached the fake commit,
not that any real authorization, rollback, ACL or database durability was proven.

## Results that change implementation requirements

| Scenario | Await-only migration | Freshness-aware migration |
|---|---|---|
| Trust expires during initial bridge verification | Enters one transaction before next check rejects | Rejects before transaction entry |
| Trust expires during final verification | Simulated commit reached | No simulated commit |
| Cancellation during final verification | Simulated commit reached | No simulated commit |
| Trust expires during command preflight | Opens then closes one fake connection | Never opens connection |

The freshness-aware variant awaits verification, resamples time, rejects clock
rollback/cancellation/expired identity, and returns the precommit Promise to its
transaction caller. Positive controls complete valid bridge and command paths.
Wrong owner, already-expired trust, cancellation and changes before the precommit
check are also covered across synchronous and adapted variants.

Two other explicit negative controls discriminate adapter mistakes:

- An unchanged synchronous helper receiving an async identity rejects even a valid
  owner; it is broken compatibility, not demonstrated privilege escalation.
- A callback retaining `{ current(); }` after current becomes async reaches the
  simulated commit while final verification is held. Returning that Promise is a
  distinct requirement from awaiting the earlier call sites. The held valid result
  is released before exit; no pending service or rejected background work is retained.

These are intentionally defective research adaptations. They are not vulnerabilities
in the currently synchronous application or in either third-party library.

## Reproduction, resources and remaining work

Run `node --import tsx research/reuse-comparisons/f8-bootstrap-async-contract.mjs`.
The first26-case run passed. A second run added valid command positive controls and
final-verification cancellation, yielding30 cases; its full receipt is retained.
Peak process RSS259376KiB includes TypeScript tooling/imports/synthetic RSA setup;
it is not a production memory estimate or a candidate performance benchmark.
Zero downloads, physical connections, application edits, retained temporary roots,
provider calls, credential access or deployment effects. No cleanup target created.

This supports an exact migration obligation rather than another policy subsystem.
Next run the actual selected-library adapter through these caller paths and the
remaining task/news/private dispatch seams, preserving post-await freshness and
failure-before-effect contracts. Tests against real disposable PostgreSQL remain
separate from this fake-transaction evidence. Independent source review found no
blocking reporting defect. It notes that the illustrative patch checks rollback
against each pre-await sample but does not yet preserve a high-water mark across
all post-await observations. Do not copy it as production-ready migration code.
Bootstrap token/max-age expiry, complete monotonic behavior and real candidate
errors remain distinct tests; this experiment's delayed expiry is trust expiry.
Selection remains open.

[Harness](../../../research/reuse-comparisons/f8-bootstrap-async-contract.mjs),
[complete receipt](f8-bootstrap-async-contract-evidence.json),
[caller inventory](f8-jwt-caller-audit.md),
[independent review](f8-bootstrap-async-contract-review.md).
