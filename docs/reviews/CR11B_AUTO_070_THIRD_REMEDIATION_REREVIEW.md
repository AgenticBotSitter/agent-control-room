# CR11B-AUTO-070 third-remediation independent re-review

**Disposition:** `REJECTED`

**Exact reviewed commit:** `941b6d624bd06dab2a17ab490f33dcd5ac4c6fc2`

**Exact reviewed tree:** `748d90175e3d64d7352e362df97fb6fda63e276c`

**Compared report-preservation parent:** `18df8f53f97c9b0006f4571c09f7785a4e41624a`

**Parent tree:** `2bf4e9c549d85b65b180f5ddb8ada06a85e72e23`

**Review date:** 2026-08-30

**Reviewer:** fourth different independent Codex reviewer; not the implementation author or any of the three prior
AUTO-070 reviewers

**Mode:** repository-only, effect-free, report-only re-review. No implementation, test, contract, status, prior-report,
Git-history, database, process, worker, network, credential, provider, deployment, or external-effect change.

**Initial immutable report SHA-256:**
`4a15ae85d35fe6bd71866dc69cc36f8b2cb378d7357db9f90d6d5db697c2f86f`

**First-remediation immutable report SHA-256:**
`2d212bfa071437b1af10c0ac9c00432df0d4823d2196a3ee235e8feaec17ebab`

**Second-remediation immutable report SHA-256:**
`7e759fdb942ee07f6647f31ce365c0d9ff5883f178ed310fb30e058dc6cba763`

**This report SHA-256:** pending calculation after this report is preserved unchanged

## Decision

Exact third-remediation commit `941b6d624bd06dab2a17ab490f33dcd5ac4c6fc2` is rejected.

The third remediation closes all three recorded findings. Captured freeze/value operations and scalar duplicate logic
close `AUTO070-IR-001`; fixed array literals and scalar decisions close `AUTO070-RR1-001`; and captured, checked Date
instance methods plus static-parse cross-checking close `AUTO070-RR2-001`. Independent reproductions confirmed that all
eight explicit faults still produce exactly one failure, returned artifacts are deeply frozen, all nine production
blockers remain, zero proofs qualify, and every production/effect capability remains false.

However, the exact candidate still derives the authenticated report identity through the current
`String.prototype.slice` after the runtime sentinel has passed. A post-load substitution of only that method changed the
digest-derived report ID to a different schema-valid ID. The candidate built, authenticated, parsed, and returned the
changed report while the helper was substituted. After the original method was restored, authoritative parsing rejected
the same report because the expected report ID changed back. The report's scenario results and negative-authority fields
remained sound, but authenticated artifact identity and exact replay still depend on mutable shared runtime behavior.

No production authority was created. All nine gates remained blocking, zero proofs were qualified, and every live,
approval, activation, network, claim/lease, dispatch/execution, and external-effect field remained false.

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

All three prior reports retained their required SHA-256 values. Static source and import review found no live database,
filesystem, process, worker, network, credential-store, protected-reference, consumer, scheduling, claim/lease,
dispatch, execution, deployment, or operational client in the AUTO-070 runtime path.

## Independently observed checks

| Command or probe | Independent result |
|---|---|
| `git status --short`, branch, commit, tree, and parent checks | Clean pre-report checkout; expected branch and exact identities confirmed |
| SHA-256 verification of all three prior reports | Required `4a15ae85...2f86f`, `2d212bfa...7ebab`, and `7e759fdb...a763` digests confirmed |
| `git diff --name-status 18df8f5..941b6d6` | Seven declared third-remediation source, test, contract, status, and decision paths only |
| `git diff --check 18df8f5..941b6d6` | Exit 0; no whitespace errors |
| `node --import tsx --test tests/ready-frontier-production-custody.test.ts` | 15/15 passed; zero failures, skips, or cancellations |
| `npm run test:cr11b` | 134/134 passed; zero failures, skips, or cancellations |
| `npm run check` | Exit 0; TypeScript no-emit check passed |
| `npm run lint` | Exit 0; full ESLint gate passed |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; no runtime or native attempt |
| Post-load Object and selective Set substitutions | A new plan, alias-fault report, and projection remained deeply frozen; the alias fault remained exactly one failure; the authentic drift-time report parsed after restoration |
| Post-load inherited numeric `Array.prototype[1]` setter | All eight faults produced seven passes and one failure; every artifact stayed deeply frozen and non-authorizing |
| Checked helper drift | Replacing `Array.prototype.map` failed closed with `integrity_failed` before artifact work |
| Post-load Date method substitutions | Valid and invalid plan/run operations failed closed with `integrity_failed` before artifact work; the original authenticated plan and report parsed after restoration |
| Normal invalid, equal, and reversed windows | Invalid plan/run instants were rejected; equal and reversed plan/run windows were denied |
| Post-load `String.prototype.slice` substitution | Candidate authenticated a report with changed digest-derived ID; the report remained non-authorizing but was rejected after helper restoration |
| Exact source and import review | No live-resource or effect client and no external-contact path found |

Passing producer tests were not treated as acceptance. They cover the three earlier shared-runtime attacks but do not
change the string method used to derive and re-derive the authenticated report ID.

## Recorded finding closure

### `AUTO070-IR-001` — closed

Captured freeze, value-enumeration, and frozen-state operations retain deep immutability after current Object methods are
replaced. Scalar duplicate detection ignores selective Set behavior. Under those changes, the alias fault remains one
failure and the authenticated report remains valid after restoration.

### `AUTO070-RR1-001` — closed

The exact inherited-index defect is closed. A numeric inherited Array setter cannot intercept any trusted scenario
write. All eight faults independently produced exactly seven passes and one failure, with frozen reports and projections,
all nine blockers, zero proofs, and false authority fields.

### `AUTO070-RR2-001` — closed

The two Date instance methods are captured and checked before every exported operation, invoked only through the captured
references, and cross-checked against captured static parsing. Substitution fails with `integrity_failed` before artifact
work. Under the normal runtime, invalid, equal, and reversed plan and run windows are rejected; after restoration, the
pre-existing valid authenticated plan and report remain valid.

## `AUTO070-RR3-001` — mutable string slicing controls authenticated report identity

**Severity:** high within AUTO-070's deterministic qualification-integrity purpose; no production or external-effect
authority

Both report construction and authoritative report parsing derive `reportId` by calling `.slice(7, 31)` on a digest string.
The runtime guard neither captures nor checks `String.prototype.slice`, and its digest/HMAC sentinel does not exercise
that method. Both paths therefore accept the same changed shared semantics while the substitution is active.

The sanitized disposable probe imported the candidate and built a normal authenticated fixture before replacing only
`String.prototype.slice`. The replacement returned one schema-valid safe string. The candidate then produced:

```json
{"authenticatedReportBuilt":true,"changedReportId":"frontier.production-custody-report.mutable-runtime-id","blockingGateCount":9,"qualifiedProofCount":0,"grantsExternalEffects":false,"rejectedAfterHelperRestore":true}
```

The original descriptor was restored in a `finally` block. No secret, key, assessment body, transcript, host identity,
credential, or external detail was printed or retained, and the probe contacted nothing.

The changed ID is covered by the report digest and HMAC, so ordinary authentication succeeds while the helper is changed.
That does not make the identity trustworthy: the same authentic report becomes invalid when the shared method is restored.
This violates the contract's deterministic report identity and exact-replay requirements.

### Required remediation boundary

The next candidate must not derive authenticated artifact identity through the current mutable string prototype. It may
capture and verify the exact intrinsic before exposure, fail closed on relevant drift, or use private logic independent
of shared prototypes. A hostile regression must replace `String.prototype.slice` after module load, prove report identity
cannot change under the substitution, restore the method, and prove the authentic artifact retains the same validity.
All earlier Object, Set, numeric Array, checked-helper, Date, deep-freeze, eight-fault, and negative-authority cases must
remain intact. All four reports must remain unchanged, and a fifth different independent reviewer must examine the next
exact remediation commit.

## Negative authority

No live resource was contacted. This re-review did not use a database, provider, credential, native key store, protected
service identity, production key, owner policy, protected clock, revocation service, checkpoint, restore target,
protected-reference resolver, consumer, scheduler, claim, lease, dispatch, execution, agent, GitHub mutation, recurrence,
DNS/hosting, deployment, or external effect.

The repository fake remains blocked-only. All nine AUTO-050 production gates remain unresolved, zero production proofs
are qualified, and accepted AUTO-060 evidence is unchanged.

## Final disposition

Exact commit `941b6d624bd06dab2a17ab490f33dcd5ac4c6fc2` and tree
`748d90175e3d64d7352e362df97fb6fda63e276c` are rejected for AUTO-070. Preserve this report unchanged, calculate its
SHA-256 after report-only preservation, and remediate only in a new exact implementation commit.

`REJECTED`
