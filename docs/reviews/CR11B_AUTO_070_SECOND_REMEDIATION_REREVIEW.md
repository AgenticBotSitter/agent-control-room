# CR11B-AUTO-070 second-remediation independent re-review

**Disposition:** `REJECTED`

**Exact reviewed commit:** `2cea5975e2c346cf171dbd49c5ab55592ab18578`

**Exact reviewed tree:** `a1eca854dc027078a915834b80418583a9d3b0b0`

**Compared report-preservation parent:** `5369dcfb43a75862aad160a461b1197b954de736`

**Review date:** 2026-08-30

**Reviewer:** third different independent Codex reviewer; not the implementation author or either prior AUTO-070 reviewer

**Mode:** repository-only, effect-free, report-only re-review. No implementation, test, contract, status, prior-report,
Git-history, database, process, worker, network, credential, provider, deployment, or external-effect change.

**Initial immutable report:** `docs/reviews/CR11B_AUTO_070_INDEPENDENT_REVIEW.md`

**Verified initial-report SHA-256:**
`4a15ae85d35fe6bd71866dc69cc36f8b2cb378d7357db9f90d6d5db697c2f86f`

**First-remediation immutable report:** `docs/reviews/CR11B_AUTO_070_FIRST_REMEDIATION_REREVIEW.md`

**Verified first-remediation-report SHA-256:**
`2d212bfa071437b1af10c0ac9c00432df0d4823d2196a3ee235e8feaec17ebab`

**This report SHA-256:** pending calculation after this report is preserved unchanged

## Decision

Exact second-remediation commit `2cea5975e2c346cf171dbd49c5ab55592ab18578` is rejected.

The second remediation closes `AUTO070-RR1-001`. Trusted service-role, scenario-result, reported-code, and projection
collections are complete literals. Identity, role-count, revocation, and claim decisions use explicit scalar values.
The only indexed assignment left in the AUTO-070 source initializes a private `Uint8Array` sentinel before module
exposure; it is not an inherited ordinary-Array write. A post-load inherited setter at `Array.prototype[1]` no longer
changes any of the eight explicit fault dispositions. Each fault produces exactly seven passes and one failure, including
`service_identity_alias`; the authentic alias report still parses after the numeric property is removed.

The concrete `Object.freeze`, `Object.values`, `Object.isFrozen`, and selective `Set.prototype.add` substitutions from
`AUTO070-IR-001` are also closed. Plans, reports, projections, and their nested collections remain deeply frozen through
the captured operations. The selective Set substitution cannot change duplicate classification. Drift of the checked
canonical `Array.prototype.map` helper fails closed with `integrity_failed`.

However, the broader shared-runtime and deterministic-chronology requirement from `AUTO070-IR-001` remains open.
AUTO-070 captures `Date` and `Date.parse`, but its private time schema dynamically calls the current
`Date.prototype.getTime` and `Date.prototype.toISOString`. An independent post-load substitution of only those two
prototype methods made an invalid canonical-shaped instant appear valid to the schema. Because captured `Date.parse`
still returned `NaN`, every chronological comparison evaluated false rather than denying the input. The exact candidate
therefore built and authenticated a plan whose `plannedAt` equalled `expiresAt` and whose instant did not exist, then ran
and authenticated a report with equally invalid start and completion instants. After the two prototype methods were
restored, authoritative parsing rejected the same plan.

This attack did not change scenario classification or create production authority. The injected
`service_identity_alias` still produced one failure; all nine gates remained blocking, zero proofs were qualified, and
every live, approval, activation, network, claim/lease, dispatch/execution, and external-effect field remained false.
The containment is sound, but an authenticated plan and report whose chronology changes validity with mutable shared
runtime state cannot satisfy AUTO-070's exact replay, chronology, and re-derived-authentication contract.

## Exact scope and changed paths

Preflight confirmed an empty porcelain status, branch `codex/cr11b-auto-070-custody-qualification`, and the requested
exact commit, tree, and parent. The parent-to-candidate diff changes only:

- `docs/BUILD_STATUS.md`;
- `docs/CONTROL_ROOM_COMPLETION_PROGRAM.md`;
- `docs/CR11B_AUTO_070_ACCEPTANCE.md`;
- `docs/CR11B_AUTO_070_PROTECTED_CUSTODY_QUALIFICATION_CONTRACT.md`;
- `docs/CR3_DECISION_LOG.md`;
- `src/ready-frontier/v1/production-custody.ts`; and
- `tests/ready-frontier-production-custody.test.ts`.

Both prior reports retained their required SHA-256 values. Static source and import review found no live database,
filesystem, process, worker, network, credential-store, protected-reference, consumer, scheduling, claim/lease,
dispatch, execution, deployment, or operational client in the AUTO-070 runtime path.

## Independently observed checks

| Command or probe | Independent result |
|---|---|
| `git status --short`, `git branch --show-current`, and exact `git rev-parse` checks | Clean pre-report checkout; expected branch, commit `2cea5975...`, tree `a1eca854...`, and parent `5369dcfb...` confirmed |
| SHA-256 verification of both prior reports | Required `4a15ae85...2f86f` and `2d212bfa...7ebab` digests confirmed |
| `git diff --name-status 5369dcf..2cea597` | Seven declared second-remediation source, test, contract, status, and decision paths only |
| `git diff --check 5369dcf..2cea597` | Exit 0; no whitespace errors |
| `node --import tsx --test tests/ready-frontier-production-custody.test.ts` | 14/14 passed; zero failures, skips, or cancellations |
| `npm run test:cr11b` | 133/133 passed; zero failures, skips, or cancellations |
| `npm run check` | Exit 0; TypeScript no-emit check passed |
| `npm run lint` | Exit 0; full ESLint gate passed |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; no runtime or native attempt |
| Post-load Object and selective Set drift case | All artifacts remained deeply frozen; `service_identity_alias` remained one failure; the authentic drift-time report parsed after restoration |
| Checked canonical-helper drift case | Changed `Array.prototype.map` failed closed with `integrity_failed` |
| Post-load numeric `Array.prototype[1]` setter before scenario execution | All eight explicit faults produced exactly seven passes and one failure; projections remained frozen and non-authorizing; the authentic alias report parsed after restoration |
| Post-load Date-prototype chronology probe | Candidate built an authenticated plan with identical invalid `plannedAt`/`expiresAt`, ran an authenticated report with identical invalid start/completion, retained one injected failure and all nine blockers, and rejected the same plan after helper restoration |
| Exact source and import review | No live-resource or effect client and no external-contact path found |

Passing producer tests were not treated as acceptance. They cover the earlier Object, Set, checked Array-method, and
numeric Array-property attacks, but they do not change the two Date instance methods used by the private time schema.

## Finding closure status

### `AUTO070-RR1-001` — closed

The exact indexed-write defect is closed. The candidate does not populate trusted ordinary arrays by assignment into
missing indices. Fixed collections are complete literals, and the decisions previously affected by temporary arrays now
use explicit scalar values. The independent numeric-setter reproduction ran all eight fault controls and observed one
failure for each, deep freezing throughout, unchanged negative authority, and successful restored-helper parsing of the
authentic drift-time report.

### `AUTO070-IR-001` — concrete substitutions closed; broader invariant remains open

Captured freeze/value/frozen-state operations and private scalar duplicate logic close the two original concrete
reproductions. The finding's broader requirement was that authoritative scenario and artifact truth not depend on
caller-mutable shared helpers after module load. That property is still not met for authoritative chronology because the
time-schema refinement invokes mutable Date prototype methods.

## `AUTO070-RR2-001` — mutable Date prototype methods bypass chronology and change artifact validity

**Severity:** high within AUTO-070's repository-fake qualification-integrity purpose; no production or external-effect
authority

The canonical runtime guard pins the `Date` constructor and its static `parse` method, but not the instance methods used
inside `timeSchemaV1`. A caller can change `Date.prototype.getTime` and `Date.prototype.toISOString` after module load
without tripping the guard. The schema then accepts an impossible canonical-shaped time while the captured static parser
returns `NaN`. JavaScript comparisons against `NaN` are false, so the candidate's less-than, less-than-or-equal,
greater-than, and maximum-lifetime denial conditions are all bypassed.

The sanitized disposable reproduction changed only those two method descriptors after importing the candidate and
building valid accepted source lineage. It used one invalid canonical-shaped instant for plan start, plan expiry, run
start, and run completion. It observed:

```json
{"invalidPlanBuilt":true,"invalidReportBuilt":true,"reportStatus":"simulated_failure","failures":1,"blockers":9,"qualifiedProofs":0,"grantsExternalEffects":false,"restoredPlanAccepted":false}
```

No key, source assessment, authentication tag, host identity, credential, or raw external detail was printed or retained.
The two original descriptors were restored in a `finally` block, and the probe contacted nothing.

### Required remediation boundary

The next candidate must make time syntax and chronology independent of caller-mutable Date prototype methods, or detect
all relevant drift and fail closed before artifact work. At minimum, hostile coverage must change the Date instance
methods after module load, prove invalid and equal/reversed windows are denied, prove valid artifacts retain stable
validity after restoration, and retain all existing Object, Set, checked-helper, numeric-setter, deep-freeze, eight-fault,
and negative-authority cases. Both prior reports and this report must remain unchanged. A new exact remediation commit
requires a fourth different independent reviewer.

## Negative authority

No live resource was contacted. This re-review did not use a database, provider, credential, native key store, protected
service identity, production key, owner policy, protected clock, revocation service, checkpoint, restore target,
protected-reference resolver, consumer, scheduler, claim, lease, dispatch, execution, agent, GitHub mutation, recurrence,
DNS/hosting, deployment, or external effect.

The repository fake remains blocked-only. All nine AUTO-050 production gates remain unresolved, zero production proofs
are qualified, and accepted AUTO-060 evidence is unchanged.

## Final disposition

Exact commit `2cea5975e2c346cf171dbd49c5ab55592ab18578` and tree
`a1eca854dc027078a915834b80418583a9d3b0b0` are rejected for AUTO-070. Preserve this report unchanged, calculate its
SHA-256 after the report-only preservation commit, and remediate only in a new exact implementation commit.

`REJECTED`
