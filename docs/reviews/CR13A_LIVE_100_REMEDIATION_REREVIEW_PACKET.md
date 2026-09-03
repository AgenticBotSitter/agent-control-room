# CR13A-LIVE-100 remediation independent re-review packet

**Mode:** independent re-review, report only  
**Immutable integration base:** `65ea851c123993d7760d6492966845f74ca1d665`  
**Original rejected target:** `5582d57247f38498efe3c587762257bababa7658`  
**Remediation implementation:** `915a5ed20bafe76367e0ae8ab06252dd05e54dac`  
**Immutable re-review target:** `ea81bf82ef4726aa230841420beaca6e96f162cc`  
**Original packet SHA-256:** `2e852036fa717a862fb6f9ae09e1a574d27216109ac394901aba442292f0f688`  
**Original negative report SHA-256:** `8cf72b4cad7abe66705612421b642e56a7d1d5af3aebc7ab21ab5e7866fb3f6c`  
**Reviewer:** must be different from the producer, first LIVE-100 reviewer, and every LIVE-090 reviewer  
**Required model / effort:** `gpt-5.6-sol` / `xhigh`  
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether target `ea81bf82ef4726aa230841420beaca6e96f162cc` closes M-001, L-001, and L-002 without
regressing the complete original default-disabled native-listener boundary. Reject for any High, Medium, or Low defect,
incomplete attack, failed command, cleanup uncertainty, or material uncertainty.

Review both exact diffs:

```text
git diff 65ea851c123993d7760d6492966845f74ca1d665..ea81bf82ef4726aa230841420beaca6e96f162cc
git diff 5582d57247f38498efe3c587762257bababa7658..ea81bf82ef4726aa230841420beaca6e96f162cc
```

Principal paths are `src/connection-registry/v1/private-loopback-native-listener-adapter.ts`,
`tests/connection-enrollment-private-loopback-native-listener-adapter.test.ts`, `src/connection-registry/v1/index.ts`,
`package.json`, the LIVE-100 acceptance document, BUILD_STATUS, build plan, ADR-159, and the preserved negative report.
Treat every test and document as a claim to attack.

## Findings that must close

1. **M-001 — mutable adapter runtime surface.** Confirm exact base-instance provenance, subclass rejection, frozen and
   non-extensible instance, frozen prototype, bounded wrong-receiver behavior, and frozen bound operations that invoke
   captured base methods. Prove own-method, own-field, prototype, prototype-chain, subclass, lookalike, borrowed-method,
   and receiver attacks cannot run caller behavior or change disabled truth. Include repeated and at least 16 concurrent
   starts before/after repeated close.
2. **L-001 — re-digested listener/plan substitution.** Confirm only a readiness object minted and frozen by this module
   can pass its parser. Re-digested clones, exact-shape copies, paired and unpaired listener/plan changes, changed
   references, decorated records, serialized round trips, and same-shaped lookalikes must fail even when every public
   digest is recomputed. Confirm an unmodified module-minted record remains usable.
3. **L-002 — locator-shaped listener-ID retention.** Mint readiness from listener plans whose valid IDs contain bounded
   literal loopback-address/port-like suffixes and confirm the raw ID, address, and port never appear in properties,
   serialization, safe errors, or bound status. Confirm only a bounded derived non-locator reference is exposed and
   remains bound to the plan used at minting.

## Mandatory re-review questions

1. Are M-001, L-001, and L-002 each closed under all attacks above, with no replacement behavior executed?
2. Is every accepted adapter an exact base instance with frozen own and prototype surfaces, and are subclasses and
   lookalikes rejected before use?
3. Do public methods and the binder return bounded local errors for wrong receivers or invalid values without exposing
   dependency errors, and do bound operations dispatch only captured base methods?
4. Can any repeated, concurrent, post-close, borrowed, or rebound `start()` call do anything except reject with the
   local `disabled` code while attempts and network-I/O counts remain zero?
5. Can any copied, serialized, decorated, re-digested, or identity-substituted readiness object pass module-private
   provenance validation? Does the exact module-minted frozen object still pass all structural and digest checks?
6. Does public readiness omit the raw listener ID, endpoint, address, port, tunnel peer, host key, channel, credential,
   and provider values, including for locator-shaped but plan-valid listener IDs?
7. Are all twelve blockers still canonical, present once, ordered, fixed false, and frozen, with all activation, native,
   effect, retry, approval, network, command, lease, and execution facts false and both counters zero?
8. Do top-level and nested Proxies, accessors, symbols, sparse or unusual arrays, prototype drift, and selected ambient
   runtime drift still fail closed before caller replacement behavior runs?
9. Is the adapter still driverless, activation-input-free, and absent from local-pilot, browser, HTTP, Hermes, worker,
   and service composition, with the prior unconditional disabled local-pilot listener unchanged?
10. Did the remediation add no native/network/process/SSH/credential/provider/database/deployment effect and honestly
    preserve all residual same-process limitations?
11. Do exact deterministic counts reproduce as 55/55 focused, 97/97 connections, 769/769 pretests, 419/421 core tests
    with two established platform skips, 348/348 posttests, 4/4 rendered checks, and 36 migrations/119 PostgreSQL tables?
    Do both exact diff checks and the detached working-tree diff check pass?

## Required reproduction

Run from a clean detached disposable checkout at the immutable re-review target with already prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
pnpm run check
pnpm run lint
pnpm run test:cr13a-native-listener-adapter
pnpm run test:cr13a-connections
pnpm test
pnpm run test:build
pnpm run db:verify
git diff --check 65ea851c123993d7760d6492966845f74ca1d665..ea81bf82ef4726aa230841420beaca6e96f162cc
git diff --check 5582d57247f38498efe3c587762257bababa7658..ea81bf82ef4726aa230841420beaca6e96f162cc
git diff --check
```

If `pnpm run db:verify` alone is denied because `tsx` cannot create its local IPC pipe in the review sandbox, preserve
that exact negative command result and run `node --import tsx scripts/verify-migrations.ts` as the listener-free
equivalent. Do not relabel the wrapper failure as a passing command.

Add private disposable probes outside the product tree for every original hostile family plus all three closure
matrices above. Do not weaken, repair, or change product files. Do not mutate the shared checkout, start the app, bind or
probe a port, open SSH, read credentials or Keychain, contact Hermes/provider/production PostgreSQL, install or download
anything, deploy, publish, or perform an external effect. Clean up only the exact disposable review directory created
for this task and confirm its absence.

## Required report

Return concise sanitized report text for architect placement at
`docs/reviews/CR13A_LIVE_100_REMEDIATION_INDEPENDENT_REREVIEW.md`. Include all exact hashes above; reviewer independence;
literal command outcomes and counts; explicit closure status for M-001, L-001, and L-002; findings ordered
High/Medium/Low with file/line evidence and required remediation; answers to all eleven questions; disposable probe
summary; shared-checkout and cleanup confirmation; and exactly one disposition.

`accepted` requires all three findings closed and no new High, Medium, or Low finding. Any failure, uncertainty,
incomplete attack, or cleanup uncertainty is `rejected`. This review grants no integration, listener, connection, SSH,
credential, native, provider, production, deployment, DNS, public-hosting, or network authority.
