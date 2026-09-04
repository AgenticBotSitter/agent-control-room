# CR13A-LIVE-390 independent review packet

**Review type:** different independent, report-only, zero-repair
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Product:** `34640c7c6a3c63b781aa848f687ae1c23e7c2dee`
**Product tree:** `607841a1d1fe70eb06e9e02971bc5b89d4061af8`
**Design parent:** `d57b02fa82ff03f84399ae2c28ee139bc295e3b3`
**Accepted LIVE-370 product:** `6f908ccd1f65f48a5d874fa0da96afe301d8decf`
**Accepted LIVE-370 review SHA-256:**
`c1b22f9b8012328f4709c608c4a53292be279f47070aec6136ab40293618f490`
**Accepted LIVE-380 product:** `1b79bbc75dfe74ce0777bcc33cbcc801054113f0`
**Accepted LIVE-380 review SHA-256:**
`4a5f60f8ca2ad08ee04f1603773279aef97558edfa27acda1604592f8ae610bd`

## Authority and stop boundary

This review is local, repository-only, report-only, and effect-free. It authorizes no install, download, repair, shared
repository edit, authorization validation/consumption/recheck, database transaction, source import/lookup/invocation,
protected native read, listener, provider, network, production database, deployment, DNS, hosting, or production
action. Run the fixed commands exactly once and in order. Any failure or inability rejects. Do not retry, repair,
substitute, broaden, or write a report file; return prose only.

## Required independent inspection

Inspect the LIVE-390 architecture, ADR-190, exact product range, new contract module, barrel export, package scripts, and
focused tests. Verify:

1. Exact parent/tree/product and exactly four changed paths: `package.json`, the connection-registry barrel, the new
   contract module, and its focused test. Independently hash both preserved accepted reviews.
2. The contract binds exact accepted LIVE-370 and LIVE-380 products/reviews and cannot be substituted, copied,
   re-digested, or reconstructed.
3. The future flow must obtain its fresh spend from its own immediately preceding LIVE-370 call and accepts no
   caller-supplied spend or recheck receipt, callable, store, database session, clock, source, native binding, output
   collector, retry instruction, fallback, or readiness claim.
4. Exactly one spend and one recheck are allowed. The same sealed authorization and exact fresh receipt pass directly
   into the recheck inside one private non-exported flow.
5. Spend and recheck receipts remain private and non-authorizing. Object identity, public fields, replay, later calls,
   or reconstructed records cannot establish same-flow freshness.
6. A known precommit rejection creates no source authority. Commit uncertainty and every failure after spend are
   terminal. A spent authorization cannot be retried, replaced, replayed, refunded, or routed to fallback.
7. Even successful composition must stop immediately before the first source lookup. The contract exposes no lookup,
   invocation, raw observation, attestation, candidate, physical-attempt, or activation capability.
8. Contract/status parsers accept only their exact frozen singletons and reject copies, extras, accessors, Proxies,
   Symbols, alternate or inherited state, and ambient intrinsic replacement without executing behavior.
9. Public errors, records, arrays, callables, and status are frozen, sanitized, and expose no authorization, receipt,
   nonce, database, locator, native, host, endpoint, credential, command, diagnostic, transform, or stack material.
10. All 28 `actual*` totals are zero, all eight grants are false, both accepted dependencies are reported as uncalled,
    and composition, lookup, invocation, runtime, qualification, candidate, activation, and effects remain absent.
11. The module does not import or instantiate the authorization store, database/PGlite/SQLite, LIVE-330, Node native or
    effect modules; create a migration; define executable consume/recheck/lookup/invoke behavior; or add a runtime
    consumer beyond the safe barrel.
12. Cleanup removes the exact disposable root and verifies absence with no dependency/build/review residue.

## Fixed 14-command sequence

Use a fresh local-only disposable clone detached at the exact product and copy prepared dependencies without install or
download. Record its exact root. Run once and in order:

1. `git status --short`
2. `git rev-parse HEAD`
3. `git rev-parse HEAD^{tree}`
4. `git diff --check d57b02fa82ff03f84399ae2c28ee139bc295e3b3 34640c7c6a3c63b781aa848f687ae1c23e7c2dee`
5. `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
6. `npm run check`
7. `npm run lint`
8. `npm run test:cr13a-fresh-spend-recheck-composition-contract`
9. `npm run test:cr13a`
10. `npm run build`
11. `node --test tests/rendered-html.test.mjs`
12. `npm run db:verify` using sandbox escalation only for local `tsx` IPC and PGlite
13. `git status --short`
14. `git diff --check d57b02fa82ff03f84399ae2c28ee139bc295e3b3 34640c7c6a3c63b781aa848f687ae1c23e7c2dee`

After command 14, remove only the recorded disposable root and verify exact absence. Command 12 permits no real
PostgreSQL service, network, or production contact.

## Required disposition

Report High, Medium, and Low separately. Acceptance requires all twelve groups and fourteen commands to pass once,
exact identities, exactly four changed paths, 0 High/Medium/Low, 11/11 focused, 403/403 CR13A, producer-supplied
current-turn 769/421/392 full lifecycle, 5/5 build, 4/4 render, 38 migrations/124 PGlite tables, 28 zero actuals, eight
false grants, zero source/native/listener/network/provider/production/external effects, clean status/diffs, and verified
cleanup. Distinguish producer evidence from independently rerun commands.

Acceptance permits ordinary integration of this exact inert contract only. It grants no executable composition,
authorization spend/recheck, source lookup/invocation, protected native read, observation, physical qualification,
runtime activation, provider, production database, deployment, blocker clearance, or production authority.
