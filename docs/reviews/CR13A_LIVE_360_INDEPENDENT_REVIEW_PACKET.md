# CR13A-LIVE-360 independent review packet

**Review type:** different independent, report-only, zero-repair
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Product:** `03a49d858869594712f44f9f0be6fccda5e59040`
**Product tree:** `621c5bcd4ddbad980ee92eb0d68f52562e011580`
**Design parent:** `347cf258bed65d457ec35ef2ef47e0c2945a8973`
**Accepted corrected LIVE-350 product:** `053c4d02003e0223438e26aecea851253d05a60b`
**Accepted LIVE-350 re-review SHA-256:**
`ffea24f4ed6e7d62ffb7a06caf2446471582eff6780351af88136b9aba3c3324`

## Authority and stop boundary

This review is local, repository-only, and effect-free. It authorizes no install, download, product repair,
shared-repository edit, authorization issuance/consumption/revocation, production key/database use, source lookup/
invocation, protected native read, listener, provider, network, deployment, DNS, hosting, or production action.

Do not generate review code. Do not alter the product, packet, dependencies, or test selection. Run every fixed command
exactly once and in order. Any failure, mismatch, executable ambient dependency, nonzero forbidden effect, false
authority, forbidden consumer/import/implementation, incomplete cleanup, or inability to inspect rejects. Do not retry,
repair, substitute, or broaden. Return prose only; make no shared-repository edit.

## Required independent inspection

Inspect LIVE-360 architecture, ADR-187, exact product range, authorization store, package scripts, and tests. Verify:

1. Exact parent/tree/product and exactly two changed paths: the authorization-store module and focused test.
2. Exact accepted corrected LIVE-350 product and independent re-review digest binding; independently hash the preserved
   re-review.
3. `validateForConsumption` accepts only the exact previously sealed envelope and reauthenticates the entire body,
   accepted source/contract/review evidence, full tenant/project/connection/node/platform/runtime/candidate/attempt
   lineage, authorization ID, digest-only nonce, operation, time bounds, key identity, body digest, and authorization
   tag.
4. One transaction first requires the exact tenant, locks and verifies the authenticated stream/head plus every nonce
   reservation, and requires exactly one identity/nonce match. Missing identity is unavailable; partial or changed
   identity/nonce reuse is a conflict; tamper/deletion/duplication/reordering fails integrity.
5. Only after state authentication does the method execute exactly one fixed same-session SQL
   `clock_timestamp()` read. It accepts no caller time, `Date.now`, header, callback, receipt time, authorization time,
   timer, or ambient clock as current-time authority.
6. Database time must be exactly one canonicalizable finite instant. Missing, duplicate, noncanonical, malformed, or
   failed clock results fail closed. Validation passes at not-before and before expiry, rejects before not-before, and
   rejects at or after expiry.
7. Success returns only one exact frozen sanitized `validated_unconsumed` receipt. It is repeatable and performs no
   write or spend; it cannot be used as a token, key, bearer capability, replay checkpoint, or substitute for a future
   consumption transaction.
8. Tests prove actual local PGlite clock SQL, mocked exact edge instants, no database writes, unavailable/conflict
   distinction, malformed clock handling, and that authenticated-state failure prevents the clock read.
9. Hostile envelopes, keys, rows, Proxies, accessors, Symbols, widened objects, and ambient intrinsic replacement
   execute no caller behavior. Public errors, records, callables, receipts, and status remain exact and frozen.
10. Public evidence exposes no raw authorization ID, key, tag, authorization body, locator, protected native value,
    host identity, endpoint, credential, command, provider content, raw diagnostic, reversible transform, or stack.
11. No migration, issuer, consumption/revocation/update/delete/list API, LIVE-330 import/modification, source lookup/
    invocation, protected native read, observation/attestation/candidate, owner authorization, listener, application/
    API/worker/scheduler/Idea Lab/Hermes/runtime consumer, production database connection, provider, network, or
    deployment behavior is added.
12. Cleanup removes the exact disposable root and verifies absence with no dependency/build/review residue.

## Fixed 14-command sequence

Use a fresh local-only disposable clone detached at the exact product and copy prepared dependencies without install or
download. Record the disposable root. Run exactly once and in order:

1. `git status --short`
2. `git rev-parse HEAD`
3. `git rev-parse HEAD^{tree}`
4. `git diff --check 347cf258bed65d457ec35ef2ef47e0c2945a8973 03a49d858869594712f44f9f0be6fccda5e59040`
5. `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
6. `npm run check`
7. `npm run lint`
8. `npm run test:cr13a-invocation-authorization-store`
9. `npm run test:cr13a`
10. `npm run build`
11. `node --test tests/rendered-html.test.mjs`
12. `npm run db:verify` using sandbox escalation only for the disposable verifier's local `tsx` IPC socket
13. `git status --short`
14. `git diff --check 347cf258bed65d457ec35ef2ef47e0c2945a8973 03a49d858869594712f44f9f0be6fccda5e59040`

After command 14, remove only the recorded disposable root and verify that exact path is absent. Command 12 permits
only local temporary IPC and PGlite; it does not permit a real PostgreSQL service, network, or production contact.

## Required disposition

Report High, Medium, and Low findings separately. Acceptance requires all twelve groups and fourteen commands to pass
once, exact identities, exactly two changed paths, 0 High/Medium/Low, 21/21 focused tests, 371/371 CR13A tests, 5/5
build stages, 4/4 rendered routes, 37 migrations/122 PGlite tables, zero consumption/source/native/network/provider/
external effects, clean status and diffs, and verified cleanup.

Acceptance permits ordinary integration of this exact read-only validator only. It grants no production database use,
authorization issuance/consumption/revocation, source lookup/invocation, protected native read, physical qualification,
runtime activation, provider, deployment, blocker clearance, or production authority.
