# CR10Q-SEC-020 — Public-security remediation and frozen re-review packet

**Date:** 2026-08-29
**Status:** remediation complete locally; different independent re-review not yet authorized or observed
**Previous independent disposition:** `remediation_required`
**Original reviewed packet:** `public-security-review:6fc96618cf696e2b0ea82cf8`
**Remediated candidate packet:** `public-security-review:e965af191cb495d5edfc61f6`
**Remediation re-review packet:** `public-security-remediation-review:32d741a6b5773158f4decf41`
**Required next block:** `CR10Q-SEC-025`
**Effects:** none

## Preserved negative evidence

`docs/reviews/CR10Q_INDEPENDENT_REVIEW.md` remains the original review evidence. Its final disposition is `remediation_required` and its byte digest remains:

```text
sha256:11a4710620e3e8487a5834df30277b5c915959ac52224fb25322d15b13a0919f
```

The remediation does not edit, replace, reinterpret, or mark that report accepted.

## Remediations

| Finding | Change | Producer regression evidence |
|---|---|---|
| `CR10Q-IR-001` — High | Public record snapshots use a null prototype, define own properties explicitly, and reject `__proto__`, `constructor`, and `prototype` before reading nested values. | All four public data operations reject each reserved key without executing a nested Proxy trap. A reserved compatibility-evidence key fails before `evaluateCompatibility` is called. Accepted snapshot fields remain own properties with no inherited record state. |
| `CR10Q-IR-002` — High | Public property names are bounded to 256 characters. | A 256-character name is accepted; a 257-character name is rejected by snapshot, freeze, digest, and sensitive-value boundaries. |
| `CR10Q-IR-003` — Medium | Current mechanical, disposition, review-packet, architect-review, and build-status scope claims use the machine-counted 36 files. | Regression checks bind the corrected documents, machine audit, and unchanged original report. Historical mismatch evidence remains visible only where it is explicitly described. |

## Frozen remediation re-review packet

The `control-room-public-security-remediation-review-packet/v1` contract binds:

- the original reviewed packet ID, original reviewer identity, immutable report digest, and `remediation_required` disposition;
- the changed candidate packet, mechanical audit, source inventory, and blocked tree disposition;
- the public-core remediation source and hostile-boundary regression digests;
- the remediation-packet contract and its own regression-source digests;
- the corrected scope-document digest and exact 36-file count;
- all three independent findings and their required evidence; and
- all 24 original case IDs in their original order, with full reexecution mandatory.

The required reviewer relationship is `different_from_original_reviewer_architect_and_candidate_producer`. The only permitted repository write is `docs/reviews/CR10Q_REMEDIATION_REREVIEW.md`. The reviewer may not repair source. The packet records no independent acceptance, cannot create a release candidate, and grants no legal conclusion, license, publication decision, or external-effect authority.

## Verification

| Gate | Result |
|---|---|
| CR10B public package gate | 41/41 passed |
| CR10C mechanical gate | 7/7 passed |
| CR10C blocked-tree disposition gate | 9/9 passed |
| CR10Q security and packet gate | 22/22 passed |
| Full repository pre-suite | 521/521 passed |
| Registered main suite | 416 total; 414 passed; 0 failed; 2 intentional platform skips |
| Expanded public post-suite | 52/52 passed |
| TypeScript and ESLint | passed |
| Production build | all five vinext stages passed |
| Rendered routes | 2/2 passed |
| Migration verifier | migrations 0001 through 0026; 96 PostgreSQL tables verified |
| Mechanical audit | 36 files; 5 components; 2 schemas; 2 fabricated fixtures; 5 local links; 0 bounded sensitive-data findings |
| Tree disposition | 6 local passes; 2 failures; 9 not observed; still `blocked_before_independent_review` |
| Diff whitespace | passed |

The first sandboxed migration-verifier attempt was denied before verification because the local `tsx` IPC socket could not be created. The same effect-free command was then run with permission for local temporary IPC and passed. No migration result is claimed from the denied attempt.

## Retained blockers

The candidate still lacks complete project license text and package-manifest license metadata. Owner licensing authority, independent dependency provenance, NOTICE review, independent private-data review, final artifact inventory, signature verification, real clean-room installation, protected disclosure and signing resources, repository visibility, owner publication decision, and a separate isolation boundary for untrusted adapter code remain unresolved.

No dependency installation, download, archive, registry or provider contact, credential use, native harness, signing, upload, publication, deployment, repository-visibility change, production mutation, or other external effect occurred. All work remains local and uncommitted under the owner's through-2026-09-01 instruction.

## Next

CR10Q-SEC-025 uses `gpt-5.6-sol` at `max` reasoning and requires explicit owner authorization for a new different independent reviewer. That reviewer must challenge all three remediations, rerun all 24 original cases and the complete verification ledger, preserve every remaining blocker, and write only the named re-review report.
