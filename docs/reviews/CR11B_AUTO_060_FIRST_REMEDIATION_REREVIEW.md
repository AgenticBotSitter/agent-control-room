# CR11B-AUTO-060 first-remediation independent re-review

**Disposition:** `REJECTED`

**Exact remediation commit:** `fb2f0a3dd4e2e128ae6076daadad10938fec1438`

**Exact remediation tree:** `02f167c4102c648ee8535f13d5584fd572b6ebfd`

**Rejected candidate reproduced:** `f77108fc3c556970bff4cc94c4b952a0336a8cac`

**Compared parent:** `081e492b7bb81a5ab71f140aefb2dc7f2c495ca2`

**Review date:** 2026-08-30

**Reviewer:** different independent Codex reviewer; not the implementation author or initial reviewer

**Mode:** owner-authorized, repository-only, report-only re-review. No source, test, package, contract, prior-report, or Git
state change; no network, credential, native-provider, MCP, deployment, or external effect.

## Decision

The first remediation closes four findings and closes the original direct exploit mechanics for the fifth, but it leaves
an alternate exported evidence path that reproduces the substance of `AUTO060-IR-002`.

An ordinary caller can change a store-produced proof assessment from `unobserved` to `observed_unqualified`, recompute its
public SHA-256 digest, and pass it through both `parseReadyFrontierProductionProofAssessmentV1` and
`projectReadyFrontierProductionProofAssessmentV1`. The resulting safe projection reports the synthetic proof as observed
without an envelope, owner/issuer/verifier signature, ledger row, row HMAC, state HMAC, or rollback checkpoint.

The forged projection remains non-authorizing: qualification stays zero, all nine gates stay blocking, activation and
consumer capabilities stay false, and no effect path exists. That negative authority does not make the evidence claim
authentic. AUTO-060's central contract says the authenticated store is the only assessment builder. The public
assessment-to-projection boundary still accepts caller-re-digested evidence status, so the exact remediation commit is
rejected.

## Exact scope and preserved evidence

Preflight confirmed the exact requested remediation commit and tree on branch
`codex/cr11b-auto-060-proof-ingress`, with an empty status before this report. The immutable initial rejection remains
unchanged at SHA-256 `fc22ddd3ee62f432eeaee5d5cbc0aca6715872fa7733e095979ac1ea3457f9cf`.

I read the governing repository instructions, delegation-review skill, AUTO-050 production boundary, AUTO-060 contract
and acceptance record, security/authority contracts, current build status, initial rejection, complete changed source and
tests, and exact candidate-to-remediation diff. I did not infer acceptance from producer tests.

The remediation-only range `3769eca..fb2f0a3` passes `git diff --check`. The broader parent-to-remediation check reports
only the immutable initial rejection's preserved Markdown hard-break spaces. This review did not rewrite that evidence.

## Commands and independently observed results

| Command or probe | Independent result |
|---|---|
| `git rev-parse HEAD HEAD^{tree}` and `git status --short` | Exact remediation commit/tree and clean pre-report checkout confirmed |
| `shasum -a 256 docs/reviews/CR11B_AUTO_060_INDEPENDENT_REVIEW.md` | Initial rejection hash exactly matched the acceptance record |
| `node --import tsx --test tests/ready-frontier-production-proof.test.ts` | 18/18 passed; zero failures or skips |
| `npm run test:cr11b` | 117/117 passed; zero failures or skips |
| `npm run check` | Exit 0; TypeScript no-emit check passed |
| `npm run lint` | Exit 0; full ESLint gate passed |
| `git diff --check 3769eca..fb2f0a3` | Passed for the exact first-remediation range |
| Static source/import/call review | No network, provider, protected-reference resolver, consumer, activation, claim, lease, dispatch, execution, deployment, or effect client found |
| Private disposable hostile probe | Signature aliases denied at all roles; lifecycle aliases denied; historical exact replay succeeded; mixed assessments stayed isolated; file/schema drift denied; forged public-digest proof assessment projected successfully |

The private probe was outside the repository, used generated fixture keys and private temporary SQLite files only, and
was removed after the review. It made no native-provider or external call.

## Reproduction of the five initial findings

I first reconstructed each finding against exact rejected commit `f77108f` from the immutable evidence and rejected
source, then evaluated exact remediation `fb2f0a3`.

| Initial finding | Rejected-candidate reproduction | First-remediation result |
|---|---|---|
| `AUTO060-IR-001` signature aliases | The old shared verifier decoded base64url and verified bytes without exact 64-byte round-trip canonicality; the initial probe accepted an owner-signature textual alias, and the same seam served issuer and verifier signatures. | Directly closed. One captured parser requires exactly 64 bytes and exact base64url round trip before all three verification roles. Independent owner, issuer, and verifier alias probes denied. |
| `AUTO060-IR-002` unsigned/backdated assessment | The old exported assessor accepted public-digest observations without envelope/ledger authentication and let evaluation predate observation, issue, and receipt. | Backdating and the raw-observation assessor are closed, but the public-digest assessment parser/projector preserves an alternate unsigned status path. Finding remains open in substance; see `AUTO060-FRR-001`. |
| `AUTO060-IR-003` revocation resurrection | The old ledger compared only revision, predecessor digest, and issue time; it never compared identity lifecycle across revisions, so active-revoked-active was accepted. | Closed for the tested fixture ledger. Direct reactivation, omission, same-ID/new-key, same-key/new-ID, key/domain/authority/gate/verifier-role swaps denied through normal, restarted, and competing-store paths. |
| `AUTO060-IR-004` old-proof replay | The old record path verified against the current trust bundle before checking an existing proof ID, so an exact revision-1 replay failed after revision 2. | Closed. Exact historical proof replay succeeded after active/unrelated and revoking revisions, at full capacity, after restart, and through a competing store. Changed receipt replay denied. |
| `AUTO060-IR-005` open-store boundary | The old constructor checked file/schema state once and later reads/mutations did not retain or recheck path identity, mode, link count, or exact schema. | Closed for the stated repository-fixture boundary. Open-store chmod, hard link, path replacement, and added table/index/trigger/view denied. Source tracing confirms boundary checks before and after reads and mutations, including transaction completion. |

## AUTO060-FRR-001 — caller-forged proof assessments still enter the exported projection path

**Severity:** high within AUTO-060's evidence-integrity purpose; no production authority or effect

`ReadyFrontierProductionProofStoreV1.assess` now consumes only authenticated ledger truth and correctly filters one exact
AUTO-050 assessment chain. However, the artifact it returns has only a public `proofAssessmentDigest`.
`parseReadyFrontierProductionProofAssessmentV1` verifies shape, ordering, counts, and that public digest, but no ledger
authentication tag, checkpoint binding, unforgeable store capability, or envelope package. The exported
`projectReadyFrontierProductionProofAssessmentV1` accepts that parser result directly.

The hostile probe performed these steps:

1. recorded one valid signed proof for `credential_broker_unbound` through the real store;
2. obtained the legitimate store assessment with one observed gate;
3. changed unrelated gate `hosted_postgresql_unqualified` from `unobserved` to `observed_unqualified`;
4. supplied synthetic proof/observation IDs and times;
5. changed `observedUnqualifiedCount` from one to two;
6. recomputed the public SHA-256 `proofAssessmentDigest`; and
7. passed the object through the exported parser and projector.

Observed result:

```json
{
  "public_forged_assessment_projected": {
    "accepted": true,
    "observedUnqualifiedCount": 2,
    "activation": false
  }
}
```

No second proof was created, signed, or recorded. This is not projection leakage of protected material; the projection
remained correctly redacted. It is an authenticity bypass: caller-created public digest material can still be presented
through a repository API as ledger-derived observed status. It contradicts the store-only assessment rule and the initial
remediation requirement that every accepted assessment path consume authenticated ledger packages or independently
reverify their complete proof chain.

### Required remediation

Do not let a public-digest assessment become a trusted projection. One bounded repair is to make projection an
authenticated store operation that re-verifies the ledger/checkpoint and projects the just-derived assessment internally.
An alternative is a protected assessment authentication tag or opaque store-issued capability bound to the exact ledger
revision, state digest, trust bundle, AUTO-050 assessment, evaluation time, and assessment digest, verified before
projection. The authentication material must not leak through the safe projection.

Add a hostile test that changes any gate status/identity/count/time in a real store assessment, recomputes every public
digest, and proves that every exported assessment-consuming and projection-building boundary rejects it. Retain the
public parser only as explicitly untrusted syntax validation if needed; it cannot establish ledger provenance.

## Chronology, mixed-chain, durability, and authority checks

The direct store assessment now rejects evaluation before the latest authenticated ledger row; because verified proof
chronology requires observation no later than issue and issue no later than receipt, this also closes pre-observation,
pre-issue, and pre-receipt assessment. Two separately HMAC-authenticated AUTO-050 assessments recorded in one ledger stayed
isolated: each projected exactly one own-chain gate and left the other chain's gate unobserved.

The trust transition keeps every prior identity binding and permits only active-to-terminal-revoked state change. New
identities cannot reuse any retained key identity. Full ledger verification repeats those checks after restart and in a
second store instance. SQLite row/state authentication and external checkpoint verification remain intact.

The all-nine dedicated test passes through the real store and still reports:

- `qualifiedProofCount: 0`;
- `remainingQualifiedProofCount: 9`;
- all nine blocking gates;
- owner approval and activation ineligible; and
- no approval, activation, claim, lease, dispatch, execution, or external-effect authority.

The proof-ingress source imports filesystem/SQLite only for the local repository fixture and cryptography/security
helpers for verification. It has no consumer, provider, network, deployment, protected-reference, scheduler, agent,
GitHub, claim, lease, dispatch, execution, or effect call.

## Residual boundary and disposition

Exact first-remediation commit `fb2f0a3dd4e2e128ae6076daadad10938fec1438` is rejected. The initial rejection must remain
unchanged. A new exact remediation commit and another different-agent re-review are required.

This rejection grants no production proof, owner approval, production root/key/revocation/checkpoint/clock custody,
hosted or multi-process database qualification, real evidence collection, protected-reference access, consumer,
activation, scheduling, claim, lease, dispatch, execution, recurrence, deployment, or external-effect authority. All nine
production gates remain blocking.

After this report is frozen, calculate and retain its immutable digest with:

```sh
shasum -a 256 docs/reviews/CR11B_AUTO_060_FIRST_REMEDIATION_REREVIEW.md
```

`REJECTED`
