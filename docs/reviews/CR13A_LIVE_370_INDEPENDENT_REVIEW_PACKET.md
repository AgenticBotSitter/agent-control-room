# CR13A-LIVE-370 independent review packet

**Review type:** different independent, report-only, zero-repair
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Product:** `6f908ccd1f65f48a5d874fa0da96afe301d8decf`
**Product tree:** `5b04736a1a485042941755771f5b526ae154b936`
**Design parent:** `304c4a28d0f0ccf3cdda340a923d0e29a14492a3`
**Accepted corrected LIVE-360 product:** `6028badb6db6b0455e9bed02c45751ea81517fa4`
**Accepted LIVE-360 re-review SHA-256:**
`2dbf2c395ba8a95c41898cba05309551ca4e7be8e2b04e706f1fed1b7828cd47`

## Authority and stop boundary

This review is local, repository-only, and effect-free. It authorizes no install, download, product repair, shared
repository edit, authorization issuance/renewal/revocation, production key/database use, post-transaction time recheck,
source lookup/invocation, protected native read, listener, provider, network, deployment, DNS, hosting, or production
action.

Do not generate review code. Do not alter the product, packet, dependencies, or test selection. Run every fixed command
exactly once and in order. Any failure, mismatch, executable ambient dependency, nonzero forbidden effect, false
authority, forbidden consumer/import/implementation, incomplete cleanup, or inability to inspect rejects. Do not retry,
repair, substitute, or broaden. Return prose only; make no shared-repository edit.

## Required independent inspection

Inspect LIVE-370 architecture, ADR-188, exact product range, migration, authorization store, package scripts, and tests.
Verify:

1. Exact parent/tree/product and exactly three changed paths: migration 0038, authorization-store module, and focused
   test.
2. Exact accepted corrected LIVE-360 product and independent re-review digest binding; independently hash the preserved
   re-review.
3. `consumeForInvocation` accepts only the exact previously sealed envelope and repeats complete body authentication,
   accepted lineage/review binding, full tenant/project/connection/node/platform/runtime/candidate/attempt lineage,
   authorization-ID digest, digest-only nonce, operation, time bounds, key identity, body digest, and authorization tag.
4. One transaction first requires the tenant, locks and verifies the complete authenticated registration stream/head
   plus every nonce reservation, requires exactly one identity/nonce match, then locks and verifies the complete
   authenticated consumption stream/head before time or mutation. Missing, partial, changed, duplicated, deleted,
   reordered, or tampered state fails closed.
5. Migration 0038 adds only one authenticated append-only consumption stream/head. Unique tenant/authorization and
   tenant/nonce identities make each authorization and nonce one-use; record mutations/deletions/truncation and head
   deletion/truncation are rejected.
6. Consumption records and heads use a separately supplied exact 32-byte HMAC key that is defensively captured and
   byte-distinct from both authorization sealing and registration-state keys. No key is generated, stored, returned,
   logged, or exposed, and production key configuration remains false.
7. Only after both authenticated streams are verified does the transaction read exactly one same-session SQL
   `clock_timestamp()`, require one canonical finite instant, enforce inclusive not-before/exclusive expiry immediately
   before insert, insert exactly one authenticated record, and atomically advance the authenticated head.
8. Exact replay after spend and concurrent duplicate spend return only `already_consumed_terminal`; they never create a
   second row or source authority. Changed authorization-ID/nonce/body reuse is a conflict. Persistent PGlite close/reopen
   preserves the terminal spend.
9. A known pre-commit insert/head failure rolls back all consumption state. Any failure after the transaction callback
   prepared its result is terminal ambiguity even if it mimics an internal safe error; later exact reads can prove only
   already-spent terminal state and cannot restore invocation authority.
10. Hostile envelopes, keys, rows, Proxies, accessors, Symbols, widened objects, behavioral scalars, and ambient intrinsic
    replacement execute no caller behavior. Public errors, records, callables, receipts, and status remain exact, frozen,
    sanitized, and contain no raw authorization ID, keys, tags, authorization body, locator, host identity, endpoint,
    credential, command, raw diagnostic, reversible transform, or stack.
11. Success returns only one immutable `consumed_pending_post_transaction_time_recheck` receipt. It grants no source
    lookup/invocation, native read, approval, qualification, candidate, activation, network, command, lease, execution,
    post-transaction validity, retry, fallback, or blocker clearance.
12. No source/native module is imported, modified, retrieved, or invoked; no application/API/worker/scheduler/Idea Lab/
    Hermes/runtime consumer, production database connection, provider, network, listener, or deployment behavior is
    added. Cleanup removes the exact disposable root and verifies absence with no dependency/build/review residue.

## Fixed 14-command sequence

Use a fresh local-only disposable clone detached at the exact product and copy prepared dependencies without install or
download. Record the disposable root. Run exactly once and in order:

1. `git status --short`
2. `git rev-parse HEAD`
3. `git rev-parse HEAD^{tree}`
4. `git diff --check 304c4a28d0f0ccf3cdda340a923d0e29a14492a3 6f908ccd1f65f48a5d874fa0da96afe301d8decf`
5. `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
6. `npm run check`
7. `npm run lint`
8. `npm run test:cr13a-invocation-authorization-store`
9. `npm run test:cr13a`
10. `npm run build`
11. `node --test tests/rendered-html.test.mjs`
12. `npm run db:verify` using sandbox escalation only for the disposable verifier's local `tsx` IPC socket
13. `git status --short`
14. `git diff --check 304c4a28d0f0ccf3cdda340a923d0e29a14492a3 6f908ccd1f65f48a5d874fa0da96afe301d8decf`

After command 14, remove only the recorded disposable root and verify that exact path is absent. Command 12 permits
only local temporary IPC and PGlite; it does not permit a real PostgreSQL service, network, or production contact.

## Required disposition

Report High, Medium, and Low findings separately. Acceptance requires all twelve groups and fourteen commands to pass
once, exact identities, exactly three changed paths, 0 High/Medium/Low, 34/34 focused tests, 384/384 CR13A tests,
769/421/392 full lifecycle tests, 5/5 build stages, 4/4 rendered routes, 38 migrations/124 PGlite tables, zero source/
native/listener/network/provider/production/external effects, clean status and diffs, and verified cleanup.

Acceptance permits ordinary integration of this exact repository-only atomic consumption store. It grants no production
key/database use, post-transaction time validity, authorization issuance/renewal/revocation, source lookup/invocation,
protected native read, observation, attestation, candidate, owner approval, physical qualification, runtime activation,
provider, deployment, blocker clearance, or production authority.
