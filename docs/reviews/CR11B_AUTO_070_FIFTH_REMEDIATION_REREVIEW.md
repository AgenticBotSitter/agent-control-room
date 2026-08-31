# CR11B-AUTO-070 fifth-remediation independent re-review

**Disposition:** `REJECTED`

**Exact reviewed commit:** `bf1a66325b9bbb7cf107b9e4857bd5d4b6874a38`

**Exact reviewed tree:** `83c885c270aa095ebb39534944636658d33e1297`

**Compared report-preservation parent:** `6f100ee297204dcdd00d3e034f2d15e4ec71ff50`

**Parent tree:** `1c2626b6f1344e12e7ec9a26442723a9bc84cf8d`

**Review date:** 2026-08-30

**Reviewer:** sixth different independent Codex reviewer; not the implementation author or any of the five prior
AUTO-070 reviewers

**Mode:** repository-only, effect-free, report-only re-review. No implementation, test, contract, status, prior-report,
Git-history, database, process, worker, network, credential, provider, deployment, or external-effect change.

**Initial immutable report SHA-256:**
`4a15ae85d35fe6bd71866dc69cc36f8b2cb378d7357db9f90d6d5db697c2f86f`

**First-remediation immutable report SHA-256:**
`2d212bfa071437b1af10c0ac9c00432df0d4823d2196a3ee235e8feaec17ebab`

**Second-remediation immutable report SHA-256:**
`7e759fdb942ee07f6647f31ce365c0d9ff5883f178ed310fb30e058dc6cba763`

**Third-remediation immutable report SHA-256:**
`4d9517bdb99b93258b23edfac37320ced6c023c13687f815e8e07d4c1840e695`

**Fourth-remediation immutable report SHA-256:**
`8e65da402e9e4ea045ced9387294e5caa6ba8ecaf84f9ede73471ab6fcc61db0`

**This report SHA-256:** pending calculation after this report is preserved unchanged

## Decision

Exact fifth-remediation commit `bf1a66325b9bbb7cf107b9e4857bd5d4b6874a38` is rejected.

The fifth remediation closes the exact `AUTO070-RR4-001` array-iterator defect. It captures the original
`Array.prototype[Symbol.iterator]`, verifies its exact descriptor before every exported operation, removes iterable
spread from trusted process, scenario, blocker, and projection lists, and copies all nine authenticated blocker
positions through complete indexed literals. An independent selective replacement of the iterator failed closed with
`integrity_failed` before the changed iterator could touch the nine-blocker list. After descriptor restoration, the
original report projected to the same digest-bound exact ordered nine blockers.

The four earlier concrete attack families also remain closed. Post-load changes to `Object.freeze`, `Object.values`,
`Object.isFrozen`, and selective `Set.prototype.add` retain deep freezing and exactly one alias failure. An inherited
numeric `Array.prototype[1]` setter cannot change any of the eight fault results. Checked array-helper drift fails
closed. Changed Date instance methods fail before artifact work and normal invalid, equal, and reversed chronology is
denied. Changed `String.prototype.slice` fails before report construction or parsing, and restoration preserves exact
report identity, replay, and authoritative parsing.

However, the exported operations still pass caller input through the shared exact snapshot implementation, which uses
the current mutable `Object.getOwnPropertyDescriptors` without a captured intrinsic or an AUTO-070 runtime check. An
independent post-load substitution changed only the descriptor value for the explicit
`injectedFault: "service_identity_alias"` input to `"none"`. The runtime sentinel and current guard accepted that
environment. The harness then signed a report whose injected fault was `none`, whose eight scenarios all passed, and
whose failure count was zero. The input object itself still contained the explicit alias fault.

The attack created no production authority. The resulting report still had all nine blockers, zero qualified proofs,
and false activation, claim/lease, dispatch/execution, network, and external-effect fields. That containment is sound,
but a qualification harness that can authenticate an eight-pass result after shared reflection semantics silently erase
the requested fault does not satisfy exact-input, deterministic-failure, or authenticated-artifact integrity.

## Exact scope and changed paths

Preflight confirmed an empty porcelain status, branch `codex/cr11b-auto-070-custody-qualification`, and the requested
exact commit, tree, parent, and parent tree. The parent-to-candidate diff changes only:

- `docs/BUILD_STATUS.md`;
- `docs/CONTROL_ROOM_COMPLETION_PROGRAM.md`;
- `docs/CR11B_AUTO_070_ACCEPTANCE.md`;
- `docs/CR11B_AUTO_070_PROTECTED_CUSTODY_QUALIFICATION_CONTRACT.md`;
- `docs/CR3_DECISION_LOG.md`;
- `src/ready-frontier/v1/production-custody.ts`; and
- `tests/ready-frontier-production-custody.test.ts`.

All five prior reports retained their required SHA-256 values. Static source and import review found no live database,
filesystem, process, worker, network, credential-store, protected-reference, consumer, scheduling, claim/lease,
dispatch, execution, deployment, or operational client in the AUTO-070 runtime path.

## Independently observed checks

| Command or probe | Independent result |
|---|---|
| `git status --short`, branch, commit, tree, and parent checks | Clean pre-report checkout; expected branch and exact identities confirmed |
| SHA-256 verification of all five prior reports | Required `4a15ae85...2f86f`, `2d212bfa...7ebab`, `7e759fdb...a763`, `4d9517bd...e695`, and `8e65da40...61db0` digests confirmed |
| `git diff --name-status 6f100ee..bf1a663` | Seven declared fifth-remediation source, test, contract, status, and decision paths only |
| `git diff --check 6f100ee..bf1a663` | Exit 0; no whitespace errors |
| `node --import tsx --test tests/ready-frontier-production-custody.test.ts` | 17/17 passed; zero failures, skips, or cancellations |
| `npm run test:cr11b` | 136/136 passed; zero failures, skips, or cancellations |
| `npm run check` | Exit 0; TypeScript no-emit check passed |
| `npm run lint` | Exit 0; full ESLint gate passed |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; no runtime or native attempt |
| Post-load selective array-iterator substitution | Plan/projection work failed closed before targeted iterator behavior; restoration preserved the original projection and exact ordered nine blockers |
| Post-load Object and selective Set substitutions | Plans, reports, and projections remained deeply frozen; alias fault remained exactly one failure; restored-runtime parsing remained stable |
| Post-load inherited numeric `Array.prototype[1]` setter | All eight faults produced exactly seven passes and one failure; every artifact stayed deeply frozen and non-authorizing |
| Checked array-helper drift | Replacing `Array.prototype.map` failed closed with `integrity_failed` before artifact work |
| Post-load Date method substitutions and normal chronology probes | Changed methods failed closed; invalid instants and equal or reversed plan/run windows were denied; restoration preserved parsing |
| Post-load `String.prototype.slice` substitution | Construction and parsing failed closed; restoration preserved exact report replay and identity |
| Post-load selective `Object.getOwnPropertyDescriptors` substitution | Explicit alias-fault input became an authenticated `none`/eight-pass report with zero failures; all authority stayed false |
| Eight-fault, authentic re-derivation, deep-freeze, blocker, proof, and authority tests | Every normal fault produced exactly one failure; rewritten reports were rejected; all nine blockers, zero proofs, deep freezes, and false authority/effect fields were retained |
| Exact source and import review | No live-resource or effect client and no external-contact path found |

Passing producer tests were not treated as acceptance. The independent reflection probe was disposable, printed only the
safe disposition and negative-authority counts, restored the original descriptor in `finally`, and was removed before
this report was written.

## Recorded finding closure

### `AUTO070-RR4-001` — closed

The array iterator is captured and checked before artifact work. Trusted fixed collections no longer use iterable
spread, and the projector copies the nine verified blocker positions through a complete array literal. The former
selective iterator cannot run, omit the ninth gate, or alter the projection; restoration gives exact ordered replay.

### `AUTO070-RR3-001` — closed

Both report-ID derivations use the captured `String.prototype.slice` intrinsic. Descriptor drift fails closed before
artifact work, while restoration preserves exact construction, replay, and parsing identity.

### `AUTO070-RR2-001` — closed

Captured and checked Date instance methods plus captured static parsing retain canonical chronology. Method substitution
fails closed, normal invalid/equal/reversed boundaries are denied, and restored-runtime replay is stable.

### `AUTO070-RR1-001` — closed

Trusted scenario decisions use scalars, and fixed collections are complete literals. The inherited numeric setter cannot
intercept trusted scenario writes; all eight faults remain exactly one failure with frozen, non-authorizing artifacts.

### `AUTO070-IR-001` — concrete reproductions closed; broader invariant remains open

Captured Object freeze/value operations and scalar duplicate logic close the original freeze and Set reproductions. The
initial finding also requires authenticated harness truth not to depend on caller-mutable public runtime behavior. The
unchecked reflection seam still changes exact input truth and therefore leaves that broader acceptance property open.

## `AUTO070-RR5-001` — mutable reflection can erase an explicit fault before authentication

**Severity:** high within AUTO-070's deterministic qualification-integrity purpose; no production or external-effect
authority

`runReadyFrontierProductionCustodyFakeQualificationV1` runs `assertCanonicalRuntimeV1`, then delegates caller input to
`parseExactReadyFrontierV1`. The snapshot implementation in `src/ready-frontier/v1/exact.ts` resolves the current
`Object.getOwnPropertyDescriptors` at call time. The AUTO-070 guard captures and checks singular
`Object.getOwnPropertyDescriptor`, but it does not capture or check the plural reflection operation used to obtain input
values. The private digest/HMAC sentinel does not exercise input reflection.

The sanitized disposable reproduction constructed a normal authenticated fixture, created an ordinary run input whose
own data property was `injectedFault: "service_identity_alias"`, and replaced only
`Object.getOwnPropertyDescriptors`. The replacement delegated normally for every value except that exact run-input
object; for it, the returned descriptor map reported `injectedFault: "none"`. The candidate returned:

```json
{"inputFault":"service_identity_alias","authenticatedFault":"none","status":"simulated_pass","simulatedFailureCount":0,"qualifiedProofCount":0,"grantsExternalEffects":false}
```

The original reflection descriptor was restored in a `finally` block. The temporary probe was removed. No key,
assessment, plan, report body, authentication tag, host identity, credential, or external detail was printed or retained,
and the probe contacted nothing.

Because the changed helper runs after the runtime guard and before Zod parsing, the implementation authenticates the
substituted ordinary snapshot as though it were exact caller input. Private scenario re-derivation cannot detect the
substitution: it correctly re-derives the already changed `none` value. This violates the contract's exact input and
eight-isolated-fault claims.

### Required remediation boundary

The next candidate must prevent post-load shared reflection or collection semantics from changing the ordinary-data
snapshot that becomes authenticated plan, run, report, or projection material. At minimum it must capture and use, or
capture and verify before every exported operation, `Object.getOwnPropertyDescriptors` and every other ambient helper
used by the exact snapshot path to choose keys, prototypes, descriptors, values, array shape, or result properties. The
repair should audit the complete `parseExactReadyFrontierV1`/`exactHostDataArrayV1` path rather than adding only the one
plural descriptor check; relevant surfaces include prototype lookup, own-key enumeration, descriptor lookup,
data-property definition, and array shape/copy helpers.

A hostile regression must replace `Object.getOwnPropertyDescriptors` after module load, supply an explicit
`service_identity_alias` run, and prove fail-closed behavior before reflection substitution or preservation of exactly
one alias failure. Companion cases should cover selective own-key omission and data-property-definition drift so one
reflection helper cannot replace another attack. Every descriptor must be restored, and the original plan, report, and
projection must remain exactly valid afterward. The repair must retain the Object/Set, numeric-setter, checked-array,
Date, String, iterator, deep-freeze, chronology, eight-fault, authentic-re-derivation, nine-blocker, zero-proof, and
negative-authority cases. All six reports must remain unchanged, and a seventh different independent reviewer must
examine a new exact remediation commit.

## Negative authority

No live resource was contacted. This re-review did not use a database, provider, credential, native key store, protected
service identity, production key, owner policy, protected clock, revocation service, checkpoint, restore target,
protected-reference resolver, consumer, scheduler, claim, lease, dispatch, execution, agent, GitHub mutation, recurrence,
DNS/hosting, deployment, or external effect.

The repository fake remains blocked-only. All nine AUTO-050 production gates remain unresolved in authentic normal
reports, zero production proofs are qualified, and accepted AUTO-060 evidence is unchanged.

## Final disposition

Exact commit `bf1a66325b9bbb7cf107b9e4857bd5d4b6874a38` and tree
`83c885c270aa095ebb39534944636658d33e1297` are rejected for AUTO-070. Preserve this report unchanged, calculate its
SHA-256 after the report-only preservation commit, and remediate only in a new exact implementation commit.

`REJECTED`
