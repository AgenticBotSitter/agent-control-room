# CR13A-LIVE-110 independent zero-repair security review

**Disposition:** Rejected  
**Findings:** 0 High, 2 Medium, 0 Low  
**Repair performed:** None

- Integration base: `d1d2b8723797cd2d09efc70384fa98403223a8ec`
- Implementation: `8d0e7aebf379b0898a0fbbedb11cafc94159d2ab`
- Immutable review target: `3c756154744a1b933093771a878ab6b64f243f2e`
- Packet SHA-256: `6704782075dcb61738aeba22a122aebe82ecdef35d0ed2e373f3eed5e54d7ec7`
- Review mode: different owner-authorized reviewer, report only, zero repair

## Findings

### Medium M-001 — Digest equality permits cross-provenance substitution

The contract and activation-evidence boundaries authenticate each individual object through its module-private brand,
but they do not bind the exact objects to one another.

At `src/connection-registry/v1/private-loopback-native-driver-contract.ts:241-250`, contract creation verifies only
that the readiness's public plan digest equals the supplied plan's public digest. At lines 375-418, the rehearsal
identity is derived deterministically from the contract's public digest. At lines 557-573, activation evidence
compares only public references and digests.

A bounded hostile reproduction established:

1. Two separately minted plans with identical configuration were distinct objects.
2. Readiness from the second plan was accepted with the first plan.
3. Two separately constructed fake drivers produced distinct contract/rehearsal objects with identical public
   identities.
4. Activation evidence accepted readiness and rehearsal from the first fixture together with the contract from the
   second fixture.
5. A second readiness minted from the same exact plan was also interchangeable.

Observed result:

```json
{
  "equalCrossPlanAccepted": true,
  "equalCrossDriverAccepted": true,
  "crossReadinessAccepted": true
}
```

The accepted result remained blocked and effect-free, so this did not create listener or activation authority. It
nevertheless contradicts the exact-provenance and cross-plan/cross-driver rejection claims in
`docs/CR13A_LIVE_110_NATIVE_DRIVER_ACTIVATION_EVIDENCE_ACCEPTANCE.md:25-37,51-57` and fails mandatory questions 1
and 7.

Smallest safe remediation direction: retain module-private exact-object relationships between readiness and its
originating plan, contracts and their exact readiness/plan pair, and rehearsals and their exact contract/driver
provenance. Evidence composition must verify those relationships rather than treating equal public digests as
interchangeable identity.

### Medium M-002 — Exported driver method functions remain mutable

The driver instance and its prototype are frozen, and the binder's returned closures are individually frozen.
However, freezing the prototype at `src/connection-registry/v1/private-loopback-native-driver-contract.ts:519-524`
does not freeze the `status`, `rehearse`, or `close` function objects stored on it.

All three exported prototype methods reported:

```json
{
  "frozen": [false, false, false],
  "extensible": [true, true, true]
}
```

The hostile probe successfully installed replacements for own `call`, own `apply`, own `bind`, and the function
prototype chain. Invoking those properties executed all four replacements:

```json
{
  "outcomes": ["call", "apply", "bind", "prototype-call"],
  "executions": 4
}
```

The captured binder at lines 547-554 remained safe, and direct invocation was not changed. The public
extracted-method surface nevertheless contradicts the packet's explicit method/function-property/prototype
requirement and the claim at acceptance lines 34-37 that method substitution cannot redirect dispatch. This fails
mandatory questions 3 and 8.

Smallest safe remediation direction: individually freeze the three captured base-method function objects before
exposing the frozen prototype. Add regressions covering own `call`, `apply`, `bind`, added function properties,
function-prototype replacement, and extracted invocation for all three methods, requiring zero replacement
executions.

## Deterministic reproduction

| Gate | Result |
|---|---|
| macOS stage zero | Pass — `ready_for_runtime_check` |
| `pnpm run check` | Pass |
| `pnpm run lint` | Pass |
| `pnpm run test:cr13a-native-driver-contract` | Pass — 65/65 |
| `pnpm run test:cr13a-connections` | Pass — 107/107 |
| `pnpm run test:cr13a` | Pass — 123/123 |
| `pnpm test` pretests | Pass — 769/769 |
| `pnpm test` core | Pass — 419/421 with two established skips |
| `pnpm test` posttests | Pass — 358/358 |
| `pnpm run test:build` | Pass — production build and 4/4 rendered routes |
| `pnpm run db:verify` | Expected sandbox failure before migrations: temporary `tsx` IPC `listen EPERM` |
| Listener-free migration fallback | Pass — migrations 0001–0036 and 119 PostgreSQL tables |
| Exact-target `git diff --check` | Pass |

The first check/lint attempt stopped during disposable dependency preparation because the copied dependency metadata
still identified its original workspace. An offline installation probe downloaded zero packages and stopped because
one tarball was absent. The reviewer then copied the already-prepared dependency tree and corrected only its
disposable workspace metadata. The exact gates subsequently passed. No target or product file was changed.

## Hostile matrix

| Family | Result |
|---|---|
| Copies, serialization, descriptor/data copies, decorations, extra keys, symbols, accessors, Proxies, null/unusual prototypes, sparse/reordered arrays, re-digested claims | Pass — rejected; zero getter or Proxy executions |
| Cross-plan, readiness, listener, contract, driver, and rehearsal substitution | **Fail — M-001**; different public identities reject, but separately minted equal identities are interchangeable |
| Native, owner, platform, port, peer, host-key, deadline, backpressure, cleanup, recovery, eligibility, attempt, network, retry, and authority replacement | Pass — 26/26 changed-field classes rejected |
| Operation removal, addition, order, duplication, mutation, replacement, and numeric bounds | Pass |
| Fake-event removal, addition, order, duplication, mutation, replacement, and native relabeling | Pass |
| Driver subclass, instance, prototype, receiver, lookalike, method, extracted operation, own-call/apply/bind, function property, and function-prototype attacks | **Fail — M-002**; binder safe, exported prototype method function objects mutable |
| Locator IDs, addresses, ports, paths, protected identities, credentials, commands, frames, and provider values | Pass — absent from public objects, serialization, and bounded errors |
| Selected post-import ambient runtime replacements | Pass — 19 replacement targets executed zero times |
| Static and behavioral external-effect searches | Pass — module is export-only and absent from runtime composition |
| Repeated rehearsal/close, parse-after-close, and concurrent access | Pass — stable frozen records and no effects |

The reviewer-only hostile harness initially scanned an aggregate containing the intentionally private input plan. The
assertion correctly saw its raw plan identity. The scan was corrected to the specified public contract, rehearsal, and
evidence objects; no product change or repair occurred.

## Mandatory questions

1. **No.** Raw locators are omitted, but exact plan/readiness object provenance is not enforced; M-001.
2. **Yes.** The five operations, numeric limits, and required future proofs are exact, ordered, immutable, and
   non-authorizing.
3. **No.** The binder is captured and safe, but mutable exported prototype method functions permit supplied own-call,
   own-apply, own-bind, or prototype behavior to execute; M-002.
4. **Yes.** The fake accepts no executable input and performs no native, listener, network, SSH, credential, provider,
   route, runtime, or deployment operation.
5. **Yes.** Fake rehearsal retains zero attempts/effects and remains explicitly labeled repository-fake.
6. **Yes.** All twelve LIVE-100 blockers remain present in exact order, with every activation and authority claim
   false.
7. **No.** Copies and forged records fail, but separately minted equal cross-plan, cross-readiness, cross-contract, and
   cross-driver records pass; M-001.
8. **No overall.** Records, nested arrays, and binder closures are frozen, but the three public driver method function
   objects are not; M-002.
9. **Yes.** Public data, serialization, and bounded error messages omit the prohibited locator and protected values.
10. **Yes.** The module is absent from local-pilot, browser, HTTP, worker, Hermes, service, and deployment composition
    and imports no external-effect implementation.
11. **No overall.** Every deterministic command reproduced without product repair, but the required hostile cases
    produced M-001 and M-002.

## Effects and cleanup

- Real listener attempts: 0
- Real network-I/O events: 0
- External effects: 0
- Native, SSH, credential, provider, production, and deployment actions: 0
- Commits, pushes, PRs, and product/document edits: 0
- Disposable checkout removal: confirmed absent
- Authoritative working tree after review: clean
