# CR11B-AUTO-070 first-remediation independent re-review

**Disposition:** `REJECTED`

**Exact reviewed commit:** `1dff163808ef2866eb44ec83394ff64789959f57`

**Exact reviewed tree:** `4829070eb0b4429dc577404daaaea697f439b2b0`

**Compared report-preservation parent:** `3edaf8b33b6d7d139d032c2ba2ea57863d4d1eda`

**Parent tree:** `2c2a2867cfa8c41669cbbb7d9d348f22c8d39cfd`

**Review date:** 2026-08-30

**Reviewer:** different independent Codex reviewer; not the implementation author or the first AUTO-070 reviewer

**Mode:** repository-only, effect-free, report-only re-review. No implementation, test, contract, status, prior-report,
Git-history, database, process, worker, network, credential, provider, deployment, or external-effect change.

**Initial immutable report:** `docs/reviews/CR11B_AUTO_070_INDEPENDENT_REVIEW.md`

**Verified initial-report SHA-256:**
`4a15ae85d35fe6bd71866dc69cc36f8b2cb378d7357db9f90d6d5db697c2f86f`

**This report SHA-256:** pending calculation after this report is preserved unchanged

## Decision

Exact remediation commit `1dff163808ef2866eb44ec83394ff64789959f57` is rejected.

The remediation closes the first report's two concrete substitutions. Captured freeze, value-enumeration, and
frozen-state operations continue to produce deeply frozen plans, reports, and projections after post-load replacement
of `Object.freeze`, `Object.values`, and `Object.isFrozen`. Selective post-load replacement of `Set.prototype.add` no
longer changes service-identity duplicate classification. All eight injected faults still produce exactly one simulated
failure under those changes, and an authentic artifact produced while those helpers are changed parses after they are
restored. Post-load changes to the checked `Array.prototype.map` and `JSON.stringify` digest surfaces fail closed with
`integrity_failed`.

However, `AUTO070-IR-001` is not closed as an acceptance property. Trusted scenario truth still depends on a different
caller-mutable part of `Array.prototype`. A post-load numeric inherited setter at array index `1` can intercept writes to
the initially empty private digest arrays used by `service_identity_separation`. The setter can give the second key
digest a different stored value on both the normal population write and the injected alias write. The private pairwise
counter then observes three apparently distinct key digests.

With explicit fault `service_identity_alias`, the exact candidate returned and authenticated a report with eight
simulated passes, zero simulated failures, and overall `simulated_pass` status. The runtime sentinel did not detect the
change because the checked `map`, `join`, and `sort` method identities remained exact and the sentinel's pre-existing
array already owned its index properties. After the numeric prototype property was removed, authoritative parsing
rejected the same report. Qualification truth therefore still varies with caller-mutable shared prototype state.

The attack did not create production authority. All nine production gates remained blocking, zero proofs were
qualified, and every live, approval, activation, network, claim/lease, dispatch/execution, and external-effect field
remained false. That containment is sound, but it cannot convert a false authenticated qualification result into an
acceptable repository-fake foundation.

## Exact scope and changed paths

Preflight confirmed an empty porcelain status, branch `codex/cr11b-auto-070-custody-qualification`, and the requested
exact commit, tree, parent, and parent tree. The remediation changed only:

- `docs/BUILD_STATUS.md`;
- `docs/CONTROL_ROOM_COMPLETION_PROGRAM.md`;
- `docs/CR11B_AUTO_070_ACCEPTANCE.md`;
- `docs/CR11B_AUTO_070_PROTECTED_CUSTODY_QUALIFICATION_CONTRACT.md`;
- `docs/CR3_DECISION_LOG.md`;
- `src/ready-frontier/v1/production-custody.ts`; and
- `tests/ready-frontier-production-custody.test.ts`.

The unchanged initial report retained its required SHA-256. Static source and import review found no live database,
filesystem, process, worker, network, credential-store, protected-reference, consumer, scheduling, claim/lease,
dispatch, execution, deployment, or operational client in the AUTO-070 runtime path.

## Independently observed checks

| Command or probe | Independent result |
|---|---|
| `git status --short`, `git branch --show-current`, `git rev-parse HEAD`, `git rev-parse HEAD^{tree}` | Clean pre-report checkout; expected branch, commit, and tree confirmed |
| `git rev-parse 3edaf8b33b6d7d139d032c2ba2ea57863d4d1eda^{tree}` | Parent tree `2c2a2867cfa8c41669cbbb7d9d348f22c8d39cfd` confirmed |
| `shasum -a 256 docs/reviews/CR11B_AUTO_070_INDEPENDENT_REVIEW.md` | Required `4a15ae85...2f86f` digest confirmed |
| `git diff --name-status 3edaf8b..1dff163` | Seven declared remediation source, test, contract, status, and decision paths only |
| `git diff --check 3edaf8b..1dff163` | Exit 0; no whitespace errors |
| `node --import tsx --test tests/ready-frontier-production-custody.test.ts` | 13/13 passed; zero failures, skips, or cancellations |
| `npm run test:cr11b` | 132/132 passed; zero failures, skips, or cancellations |
| `npm run check` | Exit 0; TypeScript no-emit check passed |
| `npm run lint` | Exit 0; full ESLint gate passed |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; no readiness or native attempt |
| Independent freeze/Set drift probe | Plans, reports, and projections remained deeply frozen; `service_identity_alias` remained one failure; all eight injected faults failed exactly once; restored helpers accepted the authentic drift-time report |
| Independent checked-helper drift probe | Replacing `Array.prototype.map` or `JSON.stringify` caused `integrity_failed` before artifact work |
| Independent numeric Array-prototype probe | `service_identity_alias` authenticated as eight passes and zero failures; the report was rejected after helper restoration |
| Exact source and import review | No live-resource or effect client and no external contact path found |

Passing producer tests were not treated as acceptance. Their helper-drift case changes the three Object methods and
`Set.prototype.add`, while their fail-closed case changes a checked named Array method. Neither case adds an inherited
numeric Array property before the private scenario arrays are populated.

## Closure assessment for AUTO070-IR-001

### Concrete Object and Set reproductions

The exact reproductions named by the initial report are closed:

- a no-op current `Object.freeze` cannot disable the captured freeze operation;
- changed current `Object.values` and `Object.isFrozen` cannot disable recursive freeze or its verification;
- selective digest rewriting through `Set.prototype.add` cannot change the new pairwise duplicate decision;
- plans, reports, projections, and their nested structures remain frozen under those changes; and
- all eight fault controls still produce one failure with all authority fields false.

### Broader trusted-path requirement

The initial report required private scenario truth not to be changeable through shared collections, prototypes, or other
caller-mutable helpers. That property remains unsatisfied.

The remediation creates empty arrays and writes trusted values with ordinary indexed assignment. For a missing own
index, JavaScript assignment consults an inherited numeric setter. The runtime guard checks only selected named methods
on `Array.prototype`; it does not reject an added numeric data or accessor property. The sentinel does not exercise a
fresh empty array's indexed write, so it also remains unchanged.

The sanitized reproduction added a configurable setter at `Array.prototype[1]` only after the candidate was imported
and the accepted source lineage and plan were built. Ordinary values became normal own data properties. Digest-string
writes instead became an own accessor whose stored value was made distinct on each write. No input, artifact, key,
schema, source assessment, or report field was directly modified. The exact candidate produced:

```json
{"injectedFault":"service_identity_alias","reportStatus":"simulated_pass","simulatedPassCount":8,"simulatedFailureCount":0,"affectedScenarioStatus":"simulated_pass","grantsExternalEffects":false,"blockingGateCount":9,"qualifiedProofCount":0,"rejectedAfterHelperRestore":true}
```

The probe restored the original absence of the numeric prototype property in a `finally` block. It printed and retained
only the sanitized result above.

## AUTO070-RR1-001 — inherited numeric Array properties still control authenticated scenario truth

**Severity:** high within AUTO-070's repository-fake qualification-integrity purpose; no production or external-effect
authority

The exact remediation removed `Set` and named shared array methods from the identity decision, but its private arrays are
not isolated from inherited indexed setters. This permits the same central failure as `AUTO070-IR-001`: an explicit
modeled fault becomes an authenticated success under shared helper drift, and the authentic report changes validity when
that drift is restored.

This is not merely a generic hostile-runtime concern. The candidate explicitly claims that duplicate identity/key/domain
detection uses private logic whose behavior cannot be changed through public globals or prototypes. The reproduction
changes no candidate input and no exported artifact; it changes only the shared prototype used by the candidate's own
fresh arrays.

### Required remediation boundary

The next candidate must ensure that trusted scenario decisions do not perform inherited indexed reads or writes through
caller-mutable array prototypes. It may fail closed on any relevant prototype drift, or use private scalar/own-data logic
whose result is independent of such drift. At minimum, a new hostile case must:

- add a numeric inherited Array setter after module load and before scenario execution;
- prove that `service_identity_alias` still creates exactly one canonical simulated failure;
- prove all eight explicit faults still fail exactly once;
- restore the property and prove authentic drift-time artifacts retain the required deterministic disposition;
- prove all returned artifacts remain deeply frozen; and
- retain all nine blockers, zero qualified proofs, and every capability/authority flag false.

The initial rejection report and this rejection report must remain unchanged. A new exact remediation commit requires a
different independent reviewer.

## Negative authority

No live resource was contacted. This re-review did not use a database, provider, credential, native key store, protected
service identity, production key, owner policy, protected clock, revocation service, checkpoint, restore target,
protected-reference resolver, consumer, scheduler, claim, lease, dispatch, execution, agent, GitHub mutation, recurrence,
DNS/hosting, deployment, or external effect.

The repository fake remains blocked-only. All nine AUTO-050 production gates remain unresolved, zero production proofs
are qualified, and accepted AUTO-060 evidence is unchanged.

## Final disposition

Exact commit `1dff163808ef2866eb44ec83394ff64789959f57` and tree
`4829070eb0b4429dc577404daaaea697f439b2b0` are rejected for AUTO-070. Preserve this report unchanged, calculate its
SHA-256 after report-only preservation, and remediate only in a new exact implementation commit.

`REJECTED`
