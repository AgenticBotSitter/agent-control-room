# CR13A-LIVE-400 independent review packet

**Review type:** different independent, report-only, zero-repair
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Product:** `ccce7c84ebfbf955f05fb7b150c1ccf9b80535b3`
**Product tree:** `734fb41e572e227b41f2c2b7955c7cea2e3b6a7d`
**Design parent:** `8334a7eb1e8e3d15ed21253e2fd502e66b8d799a`
**Accepted LIVE-390 product:** `34640c7c6a3c63b781aa848f687ae1c23e7c2dee`
**Accepted LIVE-390 review SHA-256:**
`c41370441890e64ef53c76c65a8990119520f550cea093e59aa71d7a4926e586`

## Authority and stop boundary

This review is local, repository-only, report-only, and zero-repair. It authorizes no install, download, shared
repository edit, real authorization, production database, source lookup/invocation, protected native read, listener,
provider, network, deployment, DNS, hosting, or production action. Local synthetic PGlite spend/recheck tests are the
only effects allowed. Run the fixed commands exactly once and in order. Any failure or inability rejects. Do not
retry, repair, substitute, broaden, or write a report file; return prose only.

## Required independent inspection

Inspect the LIVE-400 architecture, ADR-191, exact product range, implementation, the LIVE-390 continuity change,
package scripts, and focused tests. Verify:

1. Exact parent/tree/product and exactly four changed paths: `package.json`, the implementation, the focused test, and
   the LIVE-390 consumer-continuity test. Independently hash the preserved accepted LIVE-390 review.
2. The factory constructs the exact accepted authorization store and captures its frozen spend/recheck methods. It
   accepts no store, receipt, clock, callback, source, lookup, native binding, retry, fallback, output collector, or
   readiness input.
3. Each runner entry owns one lexical flow, calls spend at most once, accepts only its own fresh receipt, calls recheck
   at most once with the same sealed value and exact receipt, clears local receipt references, and returns neither.
4. Malformed/precommit store rejection is `rejected_before_spend`; unknown or ambiguous commit state is
   `terminal_spend_uncertain`; already-spent evidence stops without recheck; every failure after a fresh spend is
   `terminal_recheck_failed`; no outcome retries, replaces, refunds, unconsumes, or falls back.
5. Only the exact successful recheck produces `completed_and_stopped_before_lookup`. Even success has every source,
   native, runtime, effect, and authority field false and exposes no continuation or bearer capability.
6. Dynamic results expose no authorization/body/nonce/receipt digest, consumption/recheck time, key, database locator,
   source locator, native/host identity, endpoint, credential, command, raw error code, diagnostic, stack, or reversible
   protected material.
7. Concurrent exact entries converge to one fresh flow and one durable spend. Replay, recheck expiry, recheck database
   failure, commit-return uncertainty, and mid-flight sealed-value mutation all stop terminally before lookup.
8. Hostile Proxy/accessor/Symbol/malformed inputs and factory dependencies execute no hostile behavior and either
   return a pre-spend terminal result or throw the one frozen safe factory error.
9. Implementation/status/result records are frozen and exact-brand parsed; copies, accessors, Proxies, Symbols,
   inherited/extra state, digest substitution, and ambient intrinsic replacement cannot acquire authority.
10. The static status has all 23 `actual*` totals zero and all eight grants false. Test results may report one local
    spend and at most one recheck but no receipt input/export, source/native/runtime/provider/network/production effect.
11. The implementation is absent from the connection-registry barrel and has no production consumer. It imports no
    LIVE-330/native source, `node:os`, `node:process`, `node:net`, child process, PostgreSQL creator, environment,
    listener, provider, network, deployment, or runtime client and adds no migration.
12. Cleanup removes the exact disposable review root and verifies its absence with no dependency/build/review residue.

## Fixed 14-command sequence

Use a fresh local-only disposable clone detached at the exact product and copy prepared dependencies without install or
download. Record its exact root. Run once and in order:

1. `git status --short`
2. `git rev-parse HEAD`
3. `git rev-parse HEAD^{tree}`
4. `git diff --check 8334a7eb1e8e3d15ed21253e2fd502e66b8d799a ccce7c84ebfbf955f05fb7b150c1ccf9b80535b3`
5. `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
6. `npm run check`
7. `npm run lint`
8. `npm run test:cr13a-fresh-spend-recheck-composition`
9. `npm run test:cr13a`
10. `npm run build`
11. `node --test tests/rendered-html.test.mjs`
12. `npm run db:verify` using sandbox escalation only for local `tsx` IPC and PGlite
13. `git status --short`
14. `git diff --check 8334a7eb1e8e3d15ed21253e2fd502e66b8d799a ccce7c84ebfbf955f05fb7b150c1ccf9b80535b3`

After command 14, remove only the recorded disposable root and verify exact absence. Command 12 permits no real
PostgreSQL service, network, or production contact.

## Required disposition

Report High, Medium, and Low separately. Acceptance requires all twelve groups and fourteen commands to pass once,
exact identities, exactly four changed paths, 0 High/Medium/Low, 12/12 focused, 415/415 CR13A, producer-supplied
current-turn 769/421/392 full lifecycle, 5/5 build, 4/4 render, 38 migrations/124 PGlite tables, 23 static zero actuals,
eight false grants, zero receipt exposure and zero source/native/listener/network/provider/production/external effects,
clean status/diffs, and verified cleanup. Distinguish producer evidence from independently rerun commands.

Acceptance permits ordinary integration of this exact unwired private spend/recheck composition only. It grants no
source lookup/invocation, protected native read, observation, physical qualification, runtime activation, provider,
production database, deployment, blocker clearance, or production authority.
