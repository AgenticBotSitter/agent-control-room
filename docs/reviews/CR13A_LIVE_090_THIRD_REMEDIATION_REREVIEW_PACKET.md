# CR13A-LIVE-090 third remediation independent re-review packet

**Mode:** fourth independent re-review, report only
**Immutable integration base:** `04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d`
**Original rejected target:** `dbdb297aa04ea7465ab636c94ccf1084003cdf27`
**First remediation target:** `89be9d7fb486a3fb5855402073466108a19a75ec`
**Second remediation target:** `f0a64ae4fab6b0a7d926fca573c9ce324c6b9ee3`
**Exact third remediation implementation:** `77ef10c2ec9d0912e4d59ca71c95b1886c9ae60e`
**Immutable third remediation review target:** `a94241fb4578af7ff8ba2b85afa4d18f2fdd4066`
**M-001 report SHA-256:** `0f3db267c28605f0687d18f831c303c9c1055a6b4e9f64be65b9b50dd3e716bd`
**M-002 report SHA-256:** `ca1b7ef365cd6a9b4fe79e22eade3d48667a8ccc1d8befc2f09bcb6f469803f2`
**M-003 report SHA-256:** `7870ea50f7c84edcd41adffa00191df8f504e3d85099c1d7dae50c37bb78ccfe`
**Previous packet SHA-256:** `32e552933c8b3f6f7b65b0642bd45352b53f16bee00cdf7311804da67830e15b`
**Reviewer:** must differ from the producer and all three earlier reviewers
**Required model / effort:** `gpt-5.6-sol` / `xhigh`
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether exact target `a94241fb4578af7ff8ba2b85afa4d18f2fdd4066` closes M-003, keeps M-001/M-002
closed, and preserves every listener-session, transport-admission, cleanup, safe-output, and no-effect boundary. Reject
for any open High, Medium, or Low defect, incomplete review, failed required product command, or material uncertainty.

Read all three preserved negative reports. Inspect the complete product and narrow third remediation:

```text
git diff 04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d..a94241fb4578af7ff8ba2b85afa4d18f2fdd4066
git diff f0a64ae4fab6b0a7d926fca573c9ce324c6b9ee3..a94241fb4578af7ff8ba2b85afa4d18f2fdd4066
```

Principal remediation paths are the listener-session and transport-admission modules and tests, the LIVE-090
acceptance contract, BUILD_STATUS, build plan, ADR-158, and all three negative reports. Treat tests and documents as
claims to verify, not authority.

## Mandatory review questions

1. Are M-001's asynchronous and synchronous `finish()` races still closed with non-mutating contention, exactly one
   admission, successful settlement, ordered cleanup, and one receipt?
2. Are M-002's absent, captured-native, and undefined/default constructor-data cases still invalid yet safely observed
   under strict Node rejection handling, with behavioral and foreign selections untouched?
3. Does Promise acceptance still require the complete captured runtime to remain exact, so runtime drift can never turn
   a malformed result into a valid dependency result?
4. Is rejection cleanup now governed by the narrower facts the captured native observer actually uses: exact native
   Promise identity, an inert effective constructor selected only through own data descriptors, and the captured native
   species path when required?
5. If ambient `Promise.prototype.then` changes after import while effective constructor/species selection remains safe,
   do both listener and transport boundaries attach only the captured observer, leave the replacement uncalled, own the
   existing rejection, and return only local `integrity_failed` under strict process policy?
6. If full runtime custody fails immediately after the collaborator returns, is safely observable settlement owned
   before either seam terminally reports integrity failure?
7. Do accessors, foreign constructor/species selections, Proxies, subclasses, foreign thenables, and supplied behavior
   remain unread, unexecuted, and unassimilated? The in-process port does not claim it can retroactively neutralize an
   arbitrary side effect a malicious collaborator created outside the returned safely observable Promise boundary.
8. Do raw frames, delivery IDs, rejection values, signatures, locators, credentials, tunnel material, and arbitrary
   downstream text remain absent from state, errors, receipts, documents, and output? Are terminal cleanup and receipt
   digest/negative-authority facts unchanged?
9. Is there still no listener/socket, port bind/probe, SSH, timer, route, credential operation, Hermes/provider call,
   production PostgreSQL/VPS contact, deployment, DNS, hosting, install/download, or external effect?
10. Do all exact gates, bounded strict subprocess checks, robustness probes, diff checks, and disposable cleanup
    reproduce with no new High, Medium, or Low defect?

## Required reproduction

Run from a clean disposable local checkout at the immutable third-remediation target with prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
pnpm run check
pnpm run lint
pnpm run test:cr13a-listener-session
pnpm run test:cr13a-connections
pnpm test
pnpm run test:build
pnpm run db:verify
git diff --check 04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d..a94241fb4578af7ff8ba2b85afa4d18f2fdd4066
git diff --check f0a64ae4fab6b0a7d926fca573c9ce324c6b9ee3..a94241fb4578af7ff8ba2b85afa4d18f2fdd4066
```

Expected counts are 47/47 focused tests, 89/89 connection tests, 769/769 pretests, 419/421 core tests with two
established platform skips, 340/340 posttests, 4/4 rendered checks, and 36 migrations/119 PostgreSQL tables.

If `pnpm run db:verify` alone is denied because `tsx` cannot create its local IPC pipe in the review sandbox, preserve
that exact negative command result and run `node --import tsx scripts/verify-migrations.ts` as the listener-free
equivalent. Do not relabel the wrapper failure as a passing command.

Add disposable read-only checks for M-001's two races; M-002's safe constructor cases; post-import ambient `then` drift
at both seams; full-runtime failure immediately after collaborator return; effective own/prototype constructor selection;
species selection; data/accessor descriptors; unusual flags and symbols; fulfilled/rejected/pending results; Proxies,
subclasses, and foreign thenables; receiver/count; runtime restoration; policy mismatch; late cleanup failure; evidence
release; receipt recomputation; unsafe output; and absence of listener/runtime wiring. Never execute supplied behavior.
Bound every subprocess so it cannot hang.

Do not mutate the shared checkout, start the app, bind or probe a port, open SSH, read credentials or Keychain, contact
Hermes/provider/production PostgreSQL, install or download anything, deploy, publish, or perform any external effect.
Clean up only the exact disposable review directory. If sandbox policy denies that final deletion, report the exact
directory and stop; the architect will validate, remove only that directory, and return confirmation.

## Required report

Return concise sanitized report text for architect placement at
`docs/reviews/CR13A_LIVE_090_THIRD_REMEDIATION_INDEPENDENT_REREVIEW.md`. Include all exact hashes above, independence,
command outcomes and counts, explicit M-001/M-002/M-003 closure, H/M/L findings, ten answers, sanitized check summary,
no-effect/shared-checkout/cleanup confirmation, and exactly one disposition. Do not include reproduction code,
step-by-step abuse instructions, raw protected values, or sensitive host details.

`accepted` requires M-001/M-002/M-003 closed and no High, Medium, or Low finding. Any product failure, uncertainty,
incomplete attack, or unresolved cleanup uncertainty is `rejected`. The report grants no integration, listener,
connection, SSH, credential, native, provider, production, deployment, DNS, public-hosting, or network authority.
