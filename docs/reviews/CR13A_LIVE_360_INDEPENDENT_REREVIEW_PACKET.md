# CR13A-LIVE-360 independent remediation re-review packet

**Review type:** different independent remediation re-review, report-only, zero-repair
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Rejected product:** `03a49d858869594712f44f9f0be6fccda5e59040`
**Rejected tree:** `621c5bcd4ddbad980ee92eb0d68f52562e011580`
**Rejected review SHA-256:** `b753f6b627fd066841465c7647f82dd56da85d4c48a236f7ea363d682504071f`
**Remediation parent:** `3198c7999cf836c87e023fd5ab86da0e1212aced`
**Corrected product:** `6028badb6db6b0455e9bed02c45751ea81517fa4`
**Corrected tree:** `2fdc3ae96202754f2fdc7654f319cae087dd4843`
**Accepted corrected LIVE-350 product:** `053c4d02003e0223438e26aecea851253d05a60b`
**Accepted LIVE-350 re-review SHA-256:**
`ffea24f4ed6e7d62ffb7a06caf2446471582eff6780351af88136b9aba3c3324`

## Authority and stop boundary

This re-review is local, repository-only, and effect-free. It authorizes no install, download, repair,
shared-repository edit, authorization issuance/consumption/revocation, production database use, source lookup/
invocation, protected native read, listener, provider, network, deployment, or production action.

Do not generate review code. Do not alter the product, packet, dependencies, or test selection. Run every fixed command
exactly once and in order. Any failure, mismatch, incomplete closure, new finding, executable ambient dependency,
nonzero forbidden effect, or incomplete cleanup rejects. Do not retry, repair, substitute, or broaden. Return prose
only; make no shared-repository edit.

## Required independent inspection

Inspect the architecture, ADR-187, rejected product, preserved rejection, exact remediation delta, corrected product,
store, and focused test. Verify:

1. Rejected product/tree and preserved report hash are exact; the original Medium finding is not erased or
   reclassified by passing producer evidence.
2. Corrected product/tree and remediation parent are exact; remediation changes exactly the store and focused test and
   contains no unrelated product or authority expansion.
3. Every captured authorization-row scalar is proven to be an exact primitive with its required format before numeric
   conversion, hashing, regex use, text-length access, or comparison. `sequence` accepts only a bounded nonnegative safe
   integer or canonical bounded decimal string.
4. Every captured head and nonce-row scalar receives the same pre-coercion primitive/format validation, including
   `last_sequence`, all identifiers/digests, and all authentication tags.
5. Behavioral `valueOf`, `Symbol.toPrimitive`, and `length` accessors injected as authorization sequence/auth-tag,
   record-auth-tag, head sequence/auth-tag, or nonce reservation-auth-tag execute zero times and fail with sanitized
   integrity errors before any database-time read.
6. Ordinary numeric and PostgreSQL string sequence representations remain accepted, while objects, malformed numbers,
   oversized values, invalid digests/tags, accessors, Proxies, Symbols, and widened rows fail closed.
7. Original LIVE-360 guarantees remain intact: full stream/nonce/lineage authentication precedes the same-session
   database clock read; exact time edges; repeatable read-only `validated_unconsumed` receipt; no write/spend/capability.
8. No migration, issuer, consumer, revoker, list API, LIVE-330 import, source lookup/invocation, protected native read,
   application/runtime wiring, production database connection, provider, network, or deployment behavior was added.
9. Original review's clean command evidence remains historical only; this re-review independently establishes the
   corrected product through the fixed commands below.
10. Cleanup removes the exact disposable root and verifies absence with no dependency/build/review residue.

## Fixed 14-command sequence

Use a fresh local-only disposable clone detached at the exact corrected product and copy prepared dependencies without
install or download. Record the disposable root. Run exactly once and in order:

1. `git status --short`
2. `git rev-parse HEAD`
3. `git rev-parse HEAD^{tree}`
4. `git diff --check 3198c7999cf836c87e023fd5ab86da0e1212aced 6028badb6db6b0455e9bed02c45751ea81517fa4`
5. `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
6. `npm run check`
7. `npm run lint`
8. `npm run test:cr13a-invocation-authorization-store`
9. `npm run test:cr13a`
10. `npm run build`
11. `node --test tests/rendered-html.test.mjs`
12. `npm run db:verify` using sandbox escalation only for the disposable verifier's local `tsx` IPC socket
13. `git status --short`
14. `git diff --check 3198c7999cf836c87e023fd5ab86da0e1212aced 6028badb6db6b0455e9bed02c45751ea81517fa4`

After command 14, remove only the recorded disposable root and verify that exact path is absent. Command 12 permits
only local temporary IPC and PGlite; it does not permit a real PostgreSQL service, network, or production contact.

## Required disposition

Report High, Medium, and Low findings separately. Acceptance requires all ten groups and fourteen commands to pass
once, exact identities and hashes, exact two-path remediation scope, the original Medium closed, 0 new or residual
High/Medium/Low, 23/23 focused tests, 373/373 CR13A tests, 5/5 build stages, 4/4 rendered routes, 37 migrations/122
PGlite tables, zero forbidden effects, clean status/diffs, and verified cleanup.

Acceptance permits ordinary integration of the corrected read-only validator only. It grants no production database
use, authorization issuance/consumption/revocation, source lookup/invocation, protected native read, physical
qualification, runtime activation, provider, deployment, blocker clearance, or production authority.
