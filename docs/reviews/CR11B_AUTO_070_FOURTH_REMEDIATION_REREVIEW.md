# CR11B-AUTO-070 fourth-remediation independent re-review

**Disposition:** `REJECTED`

**Exact reviewed commit:** `ccdc13e37179674891793de978ae6c32409d646f`

**Exact reviewed tree:** `40415e8b47bc779fddf06b7fe9419fe385fa4e47`

**Compared report-preservation parent:** `cb98d9c0a1f3749f7b4f294b5dcf9fa10f3364fc`

**Parent tree:** `20ddd4821d674ca562e68376117472d6b475e711`

**Review date:** 2026-08-30

**Reviewer:** fifth different independent Codex reviewer; not the implementation author or any of the four prior
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

**This report SHA-256:** pending calculation after this report is preserved unchanged

## Decision

Exact fourth-remediation commit `ccdc13e37179674891793de978ae6c32409d646f` is rejected.

The fourth remediation closes the exact `AUTO070-RR3-001` string-slicing defect. It captures the original string
prototype and `slice` intrinsic before module exposure, verifies the exact own descriptor before every exported
operation, and invokes only the captured intrinsic for both construction-time and parse-time report identity. Replacing
`String.prototype.slice` after module load now fails closed with `integrity_failed` before report construction or parsing.
After restoration, exact report replay and authoritative parsing return the original stable authenticated report.

The three earlier concrete attack families also remain closed. Post-load changes to `Object.freeze`, `Object.values`,
`Object.isFrozen`, and selective `Set.prototype.add` leave the alias fault as exactly one failure and returned artifacts
deeply frozen. An inherited numeric `Array.prototype[1]` setter cannot change any of the eight fault results. Checked
array-helper drift fails closed. Changed Date instance methods fail closed before artifact work; under the normal runtime,
invalid, equal, and reversed plan and run chronology is denied. All eight explicit faults independently produce seven
passes and exactly one failure, all nine production blockers remain on normal reports and projections, zero proofs are
qualified, and every authority/effect field remains false.

However, the candidate still uses the current mutable `Array.prototype[Symbol.iterator]` to copy the authenticated
report's blocking gates into the safe projection. The runtime guard does not capture or check that iterator. An
independent post-load substitution changed only iteration of the exact nine-gate array, duplicating the first valid gate
and omitting the ninth. The candidate accepted the authenticated source report, returned a schema-valid projection with
nine entries, and authenticated the changed projection digest. The projection therefore claimed a blocker set that was
not the exact authenticated set.

The attack did not create production authority: the changed projection still had zero qualified proofs and false
activation, claim/lease, dispatch/execution, network, and effect capabilities. That containment is sound, but an
authenticated safe projection that can silently omit a production blocker does not satisfy the contract's exact all-nine
blocker or shared-runtime-integrity boundary.

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

All four prior reports retained their required SHA-256 values. Static source and import review found no live database,
filesystem, process, worker, network, credential-store, protected-reference, consumer, scheduling, claim/lease,
dispatch, execution, deployment, or operational client in the AUTO-070 runtime path.

## Independently observed checks

| Command or probe | Independent result |
|---|---|
| `git status --short`, branch, commit, tree, and parent checks | Clean pre-report checkout; expected branch and exact identities confirmed |
| SHA-256 verification of all four prior reports | Required `4a15ae85...2f86f`, `2d212bfa...7ebab`, `7e759fdb...a763`, and `4d9517bd...e695` digests confirmed |
| `git diff --name-status cb98d9c..ccdc13e` | Seven declared fourth-remediation source, test, contract, status, and decision paths only |
| `git diff --check cb98d9c..ccdc13e` | Exit 0; no whitespace errors |
| `node --import tsx --test tests/ready-frontier-production-custody.test.ts` | 16/16 passed; zero failures, skips, or cancellations |
| `npm run test:cr11b` | 135/135 passed; zero failures, skips, or cancellations |
| `npm run check` | Exit 0; TypeScript no-emit check passed |
| `npm run lint` | Exit 0; full ESLint gate passed |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; no runtime or native attempt |
| Post-load Object and selective Set substitutions | Plans, reports, and projections remained deeply frozen; the alias fault remained exactly one failure; restored helpers accepted the authentic drift-time report |
| Post-load inherited numeric `Array.prototype[1]` setter | All eight faults produced exactly seven passes and one failure; every artifact stayed deeply frozen and non-authorizing; restored-helper parsing remained stable |
| Checked array-helper drift | Replacing `Array.prototype.map` failed closed with `integrity_failed` before artifact work |
| Post-load Date method substitutions | Invalid, equal, reversed, and otherwise valid artifact operations failed closed before work; after restoration the original valid plan and report parsed unchanged |
| Normal invalid, equal, and reversed chronology | Invalid instants and equal or reversed plan/run windows were denied |
| Post-load `String.prototype.slice` substitution | Report construction and parsing failed closed with `integrity_failed`; after restoration exact replay and parsing returned the original report |
| Post-load selective array-iterator substitution | Projection returned nine gate entries with the first gate duplicated twice and the ninth gate missing; projection remained non-authorizing |
| Exact source and import review | No live-resource or effect client and no external-contact path found |

Passing producer tests were not treated as acceptance. They cover the four recorded mutable-runtime attack families but
do not replace the array iterator used by the projection's `blockingGateCodes: [...report.blockingGateCodes]` copy.

## Recorded finding closure

### `AUTO070-RR3-001` — closed

Both report-ID derivations use the captured `String.prototype.slice` intrinsic. The guard checks the exact original
descriptor before artifact work, so post-load replacement cannot create a differently identified authentic report.
Restoration preserves exact replay and parsing of the original artifact.

### `AUTO070-RR2-001` — closed

Captured and checked Date instance methods plus captured static parsing retain canonical chronology. Method substitution
fails closed, normal invalid/equal/reversed boundaries are denied, and restored-runtime replay is stable.

### `AUTO070-RR1-001` — closed

Trusted scenario decisions use scalars, and fixed collections are complete literals. The inherited numeric setter cannot
intercept a trusted scenario write; all eight faults remain exactly one failure with frozen, non-authorizing artifacts.

### `AUTO070-IR-001` — concrete reproductions closed; broader invariant remains open

Captured Object operations and scalar duplicate logic close the original freeze and Set reproductions. The initial
finding also required authoritative artifact truth not to depend on caller-mutable public prototypes. The unchecked array
iterator still changes the exact blocker truth exported by the authenticated projection, so that broader acceptance
property is not yet satisfied.

## `AUTO070-RR4-001` — mutable array iteration can omit an authenticated production blocker

**Severity:** high within AUTO-070's deterministic qualification-integrity purpose; no production or external-effect
authority

`projectReadyFrontierProductionCustodyReportV1` re-verifies the complete plan and report, then constructs
`blockingGateCodes` with array spread from the authenticated report. Array spread resolves the current shared
`Array.prototype[Symbol.iterator]`. The canonical runtime guard checks selected named Array methods but not that symbol
method, and its digest/HMAC sentinel does not exercise array iteration.

The sanitized disposable reproduction imported the candidate, constructed a normal authenticated fixture, and then
replaced only the array iterator. The replacement delegated normally for every array except a nine-element array with the
exact first and ninth production gates; for that array it yielded the first eight gates followed by the first gate again.
The candidate returned:

```json
{"projectionReturned":true,"blockerCount":9,"missingLastGate":true,"duplicateFirstGate":2,"qualifiedProofCount":0,"canActivateProduction":false,"canDispatchOrExecute":false}
```

The original iterator descriptor was restored in a `finally` block. No key, assessment, report body, authentication tag,
host identity, credential, or external detail was printed or retained, and the probe contacted nothing.

The projection schema checks only length and gate-enum membership, so a duplicate valid gate replaces a different valid
gate without rejection. The projection digest then authenticates the changed collection. This violates the contract's
requirement that the projection contain all nine exact blockers and demonstrates another caller-mutable shared-runtime
dependency in an authoritative exported artifact.

### Required remediation boundary

The next candidate must not construct trusted projection collections through an unchecked mutable iterator. It may use
fixed indexed literals from the already verified report, or capture and verify the exact relevant intrinsic before
exposure. A hostile regression must replace `Array.prototype[Symbol.iterator]` after module load, prove that construction
fails closed or preserves the exact ordered nine blockers, restore the method, and prove the original report and
projection retain exact validity. It must retain all prior Object, Set, numeric-setter, checked-helper, Date, String,
deep-freeze, eight-fault, chronology, and negative-authority cases. All five reports must remain unchanged, and a sixth
different independent reviewer must examine a new exact remediation commit.

## Negative authority

No live resource was contacted. This re-review did not use a database, provider, credential, native key store, protected
service identity, production key, owner policy, protected clock, revocation service, checkpoint, restore target,
protected-reference resolver, consumer, scheduler, claim, lease, dispatch, execution, agent, GitHub mutation, recurrence,
DNS/hosting, deployment, or external effect.

The repository fake remains blocked-only. All nine AUTO-050 production gates remain unresolved in the authenticated
report, zero production proofs are qualified, and accepted AUTO-060 evidence is unchanged.

## Final disposition

Exact commit `ccdc13e37179674891793de978ae6c32409d646f` and tree
`40415e8b47bc779fddf06b7fe9419fe385fa4e47` are rejected for AUTO-070. Preserve this report unchanged, calculate its
SHA-256 after the report-only preservation commit, and remediate only in a new exact implementation commit.

`REJECTED`
