# CR13A-LIVE-350 independent remediation re-review packet

**Review type:** different independent remediation re-review, report-only, zero-repair
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Rejected product:** `df7f981c539b1c7f2826ac62e64f28ff0215554e`
**Rejected tree:** `19aee72f1dacf33799708cf2d356c095711cf2bc`
**Rejected review SHA-256:** `36df995d36b09fb55b86e44bf01e956885d81ed6bfba783333c8ecb1c78d1261`
**Remediation parent:** `6947de2a5d8741a96a2780d9526d3d94b9cee4ce`
**Corrected product:** `053c4d02003e0223438e26aecea851253d05a60b`
**Corrected tree:** `e282a2a749836bd97cfe44c9b165c0ea88a6a58f`
**Accepted LIVE-340 product:** `3108a8759863c4692ade2d5532e88cd28f259779`
**Accepted LIVE-340 review SHA-256:**
`bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af`

## Authority and stop boundary

This re-review is local, repository-only, and effect-free. It authorizes no install, download, repair, shared-repository
edit, authorization issuance/consumption/revocation, production key/database use, current-time authority, source
lookup/invocation, native read, listener, network, provider, deployment, or production action.

Do not generate review code. Do not alter the product, packet, dependencies, or test selection. Run every fixed command
exactly once and in order. Any failure, mismatch, incomplete closure, new finding, executable ambient dependency,
nonzero forbidden effect, or incomplete cleanup rejects. Do not retry, repair, substitute, or broaden. Return prose
only; make no shared-repository edit.

## Required independent inspection

Inspect the architecture, ADR-186, rejected product, preserved rejection, exact remediation delta, corrected product,
store, test, migration, barrel, and package scripts. Verify:

1. The rejected product/tree and preserved report hash are exact; the original Medium finding is not erased or
   reclassified by passing producer evidence.
2. The corrected product/tree and remediation parent are exact; the remediation changes exactly the store and its
   focused test and contains no unrelated product or authority expansion.
3. Both key inputs are captured through the existing exact host Uint8Array boundary before comparison or storage.
4. A bounded equality function compares every captured byte without early exit, through the captured host byte reader,
   and rejects byte-for-byte identical authorization and persisted-state key material.
5. Different exact 32-byte keys remain accepted; short, hostile, proxied, subclassed, shared, detached, or identical key
   material fails closed without executing caller behavior or writing state.
6. The focused regression explicitly supplies a different Uint8Array containing identical bytes and requires the
   sanitized `invalid_input` error.
7. Original LIVE-350 guarantees remain intact: exact authenticated body and lineage, separate key purposes, atomic
   authorization/head/digest-only nonce registration, authenticated append-only stream, inert exact replay, conflict,
   tamper, rollback, restart, local concurrency, hostile-input safety, and sanitized receipts.
8. No issuer, consumer, revoker, list/read API, trusted-current-time authority, source lookup/invocation, native read,
   observation/attestation/candidate, listener, application/runtime wiring, production database, provider, network, or
   deployment behavior was added.
9. The original review's clean 14-command evidence is retained as historical evidence only; this re-review establishes
   the corrected product independently through the fixed commands below.
10. Cleanup removes the exact disposable root and verifies absence with no dependency/build/review residue.

## Fixed 14-command sequence

Use a fresh local-only disposable clone detached at the exact corrected product and copy prepared dependencies without
install or download. Record the disposable root. Run exactly once and in order:

1. `git status --short`
2. `git rev-parse HEAD`
3. `git rev-parse HEAD^{tree}`
4. `git diff --check 6947de2a5d8741a96a2780d9526d3d94b9cee4ce 053c4d02003e0223438e26aecea851253d05a60b`
5. `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
6. `npm run check`
7. `npm run lint`
8. `npm run test:cr13a-invocation-authorization-store`
9. `npm run test:cr13a`
10. `npm run build`
11. `node --test tests/rendered-html.test.mjs`
12. `npm run db:verify` using sandbox escalation only for the disposable verifier's local `tsx` IPC socket
13. `git status --short`
14. `git diff --check 6947de2a5d8741a96a2780d9526d3d94b9cee4ce 053c4d02003e0223438e26aecea851253d05a60b`

After command 14, remove only the recorded disposable root and verify that exact path is absent. Command 12 permits
only local temporary IPC and PGlite; it does not permit a real PostgreSQL service, network, or production contact.

## Required disposition

Report High, Medium, and Low findings separately. Acceptance requires all ten groups and fourteen commands to pass
once, exact identities and hashes, exact two-path remediation scope, the original Medium closed, 0 new or residual
High/Medium/Low, 14/14 focused tests, 364/364 CR13A tests, 5/5 build stages, 4/4 rendered routes, 37 migrations/122
PGlite tables, zero forbidden effects, clean status/diffs, and verified cleanup.

Acceptance permits ordinary integration of the corrected inert registration store only. It grants no production key
or database use, trusted-current-time authority, authorization issuance/consumption/revocation, source lookup/
invocation, native read, physical qualification, runtime activation, provider, deployment, blocker clearance, or
production authority.
