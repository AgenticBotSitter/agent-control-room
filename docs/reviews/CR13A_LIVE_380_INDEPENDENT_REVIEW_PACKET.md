# CR13A-LIVE-380 independent review packet

**Review type:** different independent, report-only, zero-repair
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Product:** `1b79bbc75dfe74ce0777bcc33cbcc801054113f0`
**Product tree:** `c49131e5629a57cb59e1fa96613dfe1d267804d1`
**Design parent:** `774e9b24bb3b4f363e776fafabe7882fa31b37bd`
**Accepted LIVE-370 product:** `6f908ccd1f65f48a5d874fa0da96afe301d8decf`
**Accepted LIVE-370 review SHA-256:**
`c1b22f9b8012328f4709c608c4a53292be279f47070aec6136ab40293618f490`

## Authority and stop boundary

This review is local, repository-only, report-only, and effect-free. It authorizes no install, download, repair, shared
repository edit, authorization mutation, source lookup/invocation, protected native read, listener, provider, network,
production database, deployment, DNS, hosting, or production action. Run the fixed commands exactly once and in order.
Any failure or inability rejects. Do not retry, repair, substitute, broaden, or write a report file; return prose only.

## Required independent inspection

Inspect LIVE-380 architecture, ADR-189, exact product range, authorization store, package scripts, and tests. Verify:

1. Exact parent/tree/product and exactly two changed paths: the authorization-store module and focused test. Verify the
   accepted LIVE-370 product and independently hash its preserved review.
2. `recheckAfterConsumption` accepts only the exact sealed envelope and exact fresh LIVE-370 receipt. The receipt parser
   requires every fixed identity, state, false effect/grant, canonical consumed-at, and digest field; rejects terminal,
   changed, extra, Proxy, accessor, Symbol, and behavioral values before database access.
3. The receipt is never treated as secret, object identity, bearer capability, retry authority, or proof of current time.
4. The method opens a new transaction only after LIVE-370 returned. It requires the exact tenant, reauthenticates the
   complete registration stream/head and every nonce, then the complete consumption stream/head with the distinct third
   key, and requires exactly one stored consumption matching authorization, nonce, body, and receipt consumed-at.
5. Missing, partial, duplicate, changed, deleted, reordered, or tampered durable state rejects before the second clock
   read. Hostile row scalars execute no behavior.
6. Only after durable authentication does one fixed same-session `clock_timestamp()` read occur. No caller, process,
   header, timer, receipt, callback, `Date.now`, or ambient clock becomes current-time authority.
7. The second clock must be exactly one canonical finite instant, cannot precede consumed-at or not-before, and must be
   strictly before expiry. Missing, duplicate, malformed, noncanonical, failed, regressed, and expired time rejects.
8. Success is only one immutable sanitized `consumed_and_post_transaction_time_rechecked` receipt bound to exact spend,
   consumed-at, and rechecked-at. Exact replay is read-only and cannot add a spend or restore freshness.
9. All failures are sanitized and the prior consumption stays terminal. No update, deletion, refund, renewal, retry,
   alternate authorization, fallback, or post-failure source route exists.
10. Public errors, records, callables, receipts, and status are exact and frozen and expose no raw authorization ID, key,
    tag, body, locator, native value, host identity, endpoint, credential, command, diagnostic, transform, or stack.
11. No migration, new spend, issuer/revoker/list API, LIVE-330 import/change/retrieval/invocation, source lookup, descriptor
    inspection, native read, observation/attestation/candidate, listener, application/API/worker/scheduler/Idea Lab/
    Hermes/runtime consumer, production database, provider, network, or deployment behavior is added.
12. Cleanup removes the exact disposable root and verifies absence with no dependency/build/review residue.

## Fixed 14-command sequence

Use a fresh local-only disposable clone detached at the exact product and copy prepared dependencies without install or
download. Record its exact root. Run once and in order:

1. `git status --short`
2. `git rev-parse HEAD`
3. `git rev-parse HEAD^{tree}`
4. `git diff --check 774e9b24bb3b4f363e776fafabe7882fa31b37bd 1b79bbc75dfe74ce0777bcc33cbcc801054113f0`
5. `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
6. `npm run check`
7. `npm run lint`
8. `npm run test:cr13a-invocation-authorization-store`
9. `npm run test:cr13a`
10. `npm run build`
11. `node --test tests/rendered-html.test.mjs`
12. `npm run db:verify` using sandbox escalation only for local `tsx` IPC and PGlite
13. `git status --short`
14. `git diff --check 774e9b24bb3b4f363e776fafabe7882fa31b37bd 1b79bbc75dfe74ce0777bcc33cbcc801054113f0`

After command 14, remove only the recorded disposable root and verify exact absence. Command 12 permits no real
PostgreSQL service, network, or production contact.

## Required disposition

Report High, Medium, and Low separately. Acceptance requires all twelve groups and fourteen commands to pass once,
exact identities, exactly two changed paths, 0 High/Medium/Low, 42/42 focused, 392/392 CR13A, producer-supplied current-
turn 769/421/392 full lifecycle, 5/5 build, 4/4 render, 38 migrations/124 PGlite tables, zero source/native/listener/
network/provider/production/external effects, clean status/diffs, and verified cleanup. Distinguish producer evidence
from independently rerun commands.

Acceptance permits ordinary integration of this exact read-only recheck only. It grants no source lookup/invocation,
protected native read, observation, physical qualification, runtime activation, provider, production database,
deployment, blocker clearance, or production authority.
