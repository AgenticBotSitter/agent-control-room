# CR13A-LIVE-100 second-remediation independent re-review packet

**Mode:** independent re-review, report only
**Immutable integration base:** `65ea851c123993d7760d6492966845f74ca1d665`
**Original rejected target:** `5582d57247f38498efe3c587762257bababa7658`
**First remediation target:** `ea81bf82ef4726aa230841420beaca6e96f162cc`
**Second remediation implementation:** `fbfdda99c8063f043bee6166ab664ba494382c85`
**Immutable re-review target:** `2efc17abf0f04325e0f462420f0bccc319c07d43`
**Original negative report SHA-256:** `8cf72b4cad7abe66705612421b642e56a7d1d5af3aebc7ab21ab5e7866fb3f6c`
**First remediation negative report SHA-256:** `bcf4a8aa173c4c898205adc7b6cb4c1431f6105a8cae7719e43e5d5202db708e`
**Previous re-review packet SHA-256:** `f27fb9528b895ee223b48240c83781bd89aaa1a002588b15f26d7cdc4bd51cba`
**Reviewer:** must be different from the producer, both prior LIVE-100 reviewers, and every LIVE-090 reviewer
**Required model / effort:** `gpt-5.6-sol` / `xhigh`
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether target `2efc17abf0f04325e0f462420f0bccc319c07d43` closes remaining M-001 and new L-003,
reconfirms L-001 and L-002, and preserves the complete original default-disabled native-listener boundary. Reject for
any High, Medium, or Low defect, incomplete attack, failed required command, cleanup uncertainty, or material
uncertainty.

Review all three exact ranges:

```text
git diff 65ea851c123993d7760d6492966845f74ca1d665..2efc17abf0f04325e0f462420f0bccc319c07d43
git diff 5582d57247f38498efe3c587762257bababa7658..2efc17abf0f04325e0f462420f0bccc319c07d43
git diff ea81bf82ef4726aa230841420beaca6e96f162cc..2efc17abf0f04325e0f462420f0bccc319c07d43
```

Principal paths are `.gitattributes`, `src/connection-registry/v1/private-loopback-native-listener-adapter.ts`,
`tests/connection-enrollment-private-loopback-native-listener-adapter.test.ts`, `src/connection-registry/v1/index.ts`,
`package.json`, both preserved negative reports, the prior re-review packet, LIVE-100 acceptance, BUILD_STATUS, build
plan, and ADR-159. Treat every test and document as a claim to attack.

## Findings that must close

1. **M-001 — mutable bound function objects.** Confirm the binder, `status`, `start`, and `close` are each frozen and
   non-extensible. Attack own `call`/`apply`/`bind`, own properties, synthetic `prototype`, `__proto__`,
   `Object.setPrototypeOf`, `Object.defineProperty`, delete/reassignment, receiver rebinding, and extracted calls.
   Replacement sentinels must never execute. Direct and extracted operations must still invoke only captured base
   behavior; repeated and at least 16 concurrent starts before and after close must return only bounded `disabled`.
   Reconfirm the exact adapter instance, class prototype, and subclass/lookalike defenses from first remediation.
2. **L-003 — exact-diff whitespace failure.** Confirm `.gitattributes` names only the three immutable LIVE-100 evidence
   paths, disables only `trailing-space` classification, and leaves every other whitespace rule/path unchanged. Verify
   both preserved report SHA-256 values and the prior packet SHA-256 value exactly, prove a synthetic trailing-space
   defect in an unrelated tracked path is still reported, and require all three immutable-range diff checks plus the
   detached working-tree diff check to pass.
3. **L-001/L-002 reconfirmation.** Repeat re-digested readiness clone/serialization/identity substitution and
   locator-shaped listener-ID probes. Only module-minted frozen readiness may pass; public status must expose only a
   bounded non-locator reference and no raw ID, address, port, endpoint, tunnel, host-key, channel, credential, or
   provider value.

## Mandatory re-review questions

1. Are M-001 and L-003 closed, and do L-001 and L-002 remain closed, with no replacement behavior executed?
2. Are the binder and all three function values individually frozen and non-extensible under every own-property,
   prototype, receiver, and extracted-call attack?
3. Do direct and extracted bound operations dispatch only captured base methods, with every start returning bounded
   `disabled`, every close inert, status unchanged, and attempt/network-I/O counters fixed at zero?
4. Are exact base-instance provenance, subclass rejection, frozen adapter/prototype surfaces, and bounded wrong-receiver
   behavior unchanged?
5. Does the narrow whitespace attribute preserve all three exact evidence files byte-for-byte and leave an unrelated
   trailing-space defect detectable by `git diff --check`?
6. Can any copied, serialized, decorated, re-digested, or identity-substituted readiness lookalike pass module-private
   provenance, while the exact module-minted object remains valid?
7. Does status omit every raw locator and protected identity value even for plan-valid locator-shaped listener IDs?
8. Are all twelve blocker and every activation/effect/authority/counter invariants unchanged and immutable?
9. Do Proxy, accessor, symbol, array, prototype, and selected ambient-runtime attacks remain inert and fail closed?
10. Is the adapter still driverless, activation-input-free, unwired, and incapable of native, network, process, SSH,
    credential, provider, production database, deployment, DNS, hosting, or other external effects?
11. Do exact counts reproduce as 55/55 focused, 97/97 connections, 769/769 pretests, 419/421 core tests with two
    established platform skips, 348/348 posttests, 4/4 rendered checks, and 36 migrations/119 PostgreSQL tables? Do all
    three immutable diff checks and the detached working-tree diff check pass?

## Required reproduction

Run from a clean detached disposable checkout at the immutable target with already prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
pnpm run check
pnpm run lint
pnpm run test:cr13a-native-listener-adapter
pnpm run test:cr13a-connections
pnpm test
pnpm run test:build
pnpm run db:verify
git diff --check 65ea851c123993d7760d6492966845f74ca1d665..2efc17abf0f04325e0f462420f0bccc319c07d43
git diff --check 5582d57247f38498efe3c587762257bababa7658..2efc17abf0f04325e0f462420f0bccc319c07d43
git diff --check ea81bf82ef4726aa230841420beaca6e96f162cc..2efc17abf0f04325e0f462420f0bccc319c07d43
git diff --check
```

If `pnpm run db:verify` alone is denied because `tsx` cannot create its local IPC pipe in the review sandbox, preserve
that exact negative command result and run `node --import tsx scripts/verify-migrations.ts` as the listener-free
equivalent. Do not relabel the wrapper failure as a passing command.

Add private disposable probes outside the product tree for every original family and every closure matrix above. The
unrelated-path whitespace probe must be confined to the disposable checkout and removed before the final working-tree
check. Do not weaken, repair, or change product files. Do not mutate the shared checkout, start the app, bind or probe a
port, open SSH, read credentials or Keychain, contact Hermes/provider/production PostgreSQL, install or download
anything, deploy, publish, or perform any external effect. Clean up only the exact disposable directory and confirm its
absence.

## Required report

Return concise sanitized report text for architect placement at
`docs/reviews/CR13A_LIVE_100_SECOND_REMEDIATION_INDEPENDENT_REREVIEW.md`. Include all exact hashes above; reviewer
independence; literal command outcomes and counts; explicit status for M-001, L-003, L-001, and L-002; findings ordered
High/Medium/Low with file/line evidence and required remediation; answers to all eleven questions; hostile-probe
summary; shared-checkout and cleanup confirmation; and exactly one disposition.

`accepted` requires M-001 and L-003 closed, L-001/L-002 reconfirmed, and no new High, Medium, or Low finding. Any failed
command, uncertainty, incomplete attack, or cleanup uncertainty is `rejected`. This review grants no integration,
listener, connection, SSH, credential, native, provider, production, deployment, DNS, public-hosting, or network
authority.
