# CR11B-AUTO-060 second-remediation independent re-review

**Disposition:** `REJECTED`

**Exact second-remediation commit:** `0d7287fbdc06af3f8c220dad8227f0f99855b64a`

**Exact second-remediation tree:** `ff5199285d42b69a093ab22421e79a8ccefb5554`

**Rejected first-remediation commit:** `fb2f0a3dd4e2e128ae6076daadad10938fec1438`

**First-remediation tree:** `02f167c4102c648ee8535f13d5584fd572b6ebfd`

**Rejected original commit:** `f77108fc3c556970bff4cc94c4b952a0336a8cac`

**Original tree:** `8993df9e9c70523d81aad0c9eb37d5da83c266fe`

**Compared accepted parent:** `081e492b7bb81a5ab71f140aefb2dc7f2c495ca2`

**Accepted-parent tree:** `24a52686819e5d6d194895a7ce68633e2a52a5d0`

**Review date:** 2026-08-30

**Reviewer:** third different independent Codex reviewer; not the implementation author, original reviewer, or
first-remediation reviewer

**Mode:** owner-authorized, repository-only, report-only re-review. No implementation, test, package, contract,
prior-report, or Git-state change; no network, credential, native-provider, MCP, deployment, or external effect.

## Decision

The second remediation closes the previously reported public digest-only assessment and projection path, and it retains
the five original direct repairs. It is nevertheless rejected because a different evidence-integrity bypass remains in
the direct proof-schema module.

The direct module publicly exports mutable schema instances that are the same objects consulted by the trusted proof
verifier and store. Independent own-method substitution on the exported verification-input schema caused the store to
authenticate a different valid package while persisting an unsigned, changed-binding envelope. The ledger accepted the
row, advanced its HMAC-authenticated state and rollback checkpoint, and returned a projection with one observed gate.
Restoring the original parser made the next ledger verification fail, proving that the persisted envelope had not passed
the verification represented by its observation.

The result stayed fixture-only and non-authorizing: the projected proof was still unqualified, all nine production gates
remained blocking, activation stayed false, and no network, provider, consumer, protected-reference, dispatch,
deployment, or effect path existed. That negative authority limits impact but does not satisfy AUTO-060's central claim
that every observed status comes from the exact authenticated envelope stored in the ledger.

## Exact scope and preserved evidence

Preflight confirmed the requested head, tree, branch, and an empty working tree. The reviewed parent-to-head range adds the
proof types, schemas, verifier, private local store, hostile tests, contract and acceptance records, both immutable prior
rejections, build status, completion-program entry, decision-log amendment, and package test registration.

Both prior reports remained byte-for-byte unchanged before and after the review:

- `docs/reviews/CR11B_AUTO_060_INDEPENDENT_REVIEW.md`:
  `fc22ddd3ee62f432eeaee5d5cbc0aca6715872fa7733e095979ac1ea3457f9cf`;
- `docs/reviews/CR11B_AUTO_060_FIRST_REMEDIATION_REREVIEW.md`:
  `1aa0119e9eb8504d471586c88d62ab44b533f16190d2c9c57fbe58cad30e9dc2`.

All disposable probes used generated fixture keys and private temporary SQLite files outside the repository. They were
removed, and their absence was confirmed. No native, provider, network, credential, or external operation occurred.

## Commands and independently observed results

| Command or probe | Independent result |
|---|---|
| `git rev-parse HEAD HEAD^{tree}` and `git status --short` | Exact second-remediation commit/tree and clean pre-report checkout confirmed |
| `shasum -a 256` on both prior reports | Both immutable hashes matched the acceptance record |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; no readiness or native attempt |
| `node --import tsx --test tests/ready-frontier-production-proof.test.ts` | 19/19 passed; zero failures or skips |
| `npm run test:cr11b` | 118/118 passed; zero failures or skips |
| `npm run check` | Exit 0; TypeScript no-emit check passed |
| `npm run lint` | Exit 0; full ESLint gate passed |
| `git diff --check 4c3e7f8..0d7287f` and `git diff --check fb2f0a3..0d7287f` | Both second-remediation ranges passed |
| Exact first-remediation FRR-001 reproduction | A caller-forged assessment changed status, identifiers, counts, all represented times, and public digests; the old parser/projector accepted it and reported two observed gates while activation remained false |
| Aggregate and direct-module export enumeration | The removed assessment parser, projector, projection parser, assessment/projection schemas, and raw `assess` method were absent; `projectAssessment` was the only repository view builder |
| Seven private second-remediation hostile probes | Forged assessment/projection/observation inputs reached no remaining normal consumer; returned views were deeply frozen; accessors and Proxies did not run; trust aliases and reactivation denied; replay/currentness, mixed-chain isolation, restart/competing-store behavior, and exact-schema checks passed |
| Mutable shared-schema own-method substitution probe | An invalid changed-binding envelope was denied before substitution, persisted and projected as one observed gate while the shared parser was substituted, then caused integrity failure after the original parser was restored |
| Static imports and call review | No network, provider, destination, protected-reference resolver, consumer, activation, claim, lease, dispatch, execution, deployment, or effect client found |

Passing producer tests and the closed prior mechanics do not override the concrete finding below.

## Prior findings and second-remediation dispositions

I first reconstructed the source mechanics and preserved evidence for all five original findings and reproduced the
first-remediation forgery against its exact rejected commit. I then tested their current paths against exact
second-remediation commit `0d7287f`.

| Prior finding | Rejected-source basis | Second-remediation disposition |
|---|---|---|
| `AUTO060-IR-001` noncanonical signatures | The original verifier decoded base64url signature text without an exact 64-byte round trip at owner, issuer, or verifier seams. | Closed for the tested path. One canonical signature routine now enforces exact bytes and text for all three roles; all three alias probes deny. |
| `AUTO060-IR-002` unsigned and backdated assessment | The original public assessor accepted publicly re-digested observations and did not bind evaluation to recorded proof chronology. | Original mechanics closed. Raw assessment is gone; projection derives only after the normal authenticated store read, rejects backdating, and isolates mixed AUTO-050 chains. The new shared-schema finding creates a different way to misrepresent the persisted package, so the overall evidence-integrity gate remains open. |
| `AUTO060-IR-003` revocation resurrection | The original ledger checked revision linkage but not identity lifecycle across revisions. | Closed for tested transitions. Reactivation, omission/remove-readd precursor, same-key/new-ID, same-ID/new-key, key/domain/role/gate/verifier-role swaps deny across normal, restarted, and competing-store paths. |
| `AUTO060-IR-004` old-proof replay | The original record path required the historical package to match current trust before checking exact stored identity. | Closed for tested replay paths. Exact old proofs replay inertly after active and revoking advances, at capacity, after restart, and through a competing store; changed replay denies. |
| `AUTO060-IR-005` open-store file/schema drift | The original store checked privacy and schema only during construction. | Closed for tested boundaries. Mode, hard-link, path, table, index, trigger, and view drift deny; source and probes confirm checks before and after reads and mutations, with rollback remaining fail closed. |
| `AUTO060-FRR-001` public digest-only assessment projection | First remediation still exported an assessment parser/projector that accepted caller-changed evidence status after only public re-digestion. | Direct path closed. The old forgery was independently reproduced, while the second-remediation aggregate and direct executable exports contain no assessment/projection parser, projector, schema, or raw-assessment consumer. |

## AUTO060-SRR-001 — mutable exported schema can substitute the package authenticated by the ledger

**Severity:** high within AUTO-060's repository-fixture evidence-integrity purpose; no production authority or external
effect

`production-proof-schemas.ts` exports Zod schema instances whose own `parse` methods are writable and configurable. The
trusted verifier imports and consults those same live objects. Removing the schema exports from the aggregate index does
not protect the direct module, and freezing the store instance and store prototype does not freeze or capture these
parser dependencies.

The independent probe began with an envelope whose binding material and body digest had changed without a matching issuer
signature. The normal verifier denied it. After substituting the exported verification-input schema's own parse behavior,
the store accepted that changed envelope while the verifier authenticated a separate valid package. The stored proof row
contained the changed envelope, but its derived observation described the substituted valid package. Normal row HMAC,
whole-state HMAC, checkpoint advancement, and projection all completed, producing one observed-unqualified gate. Once the
original parser was restored, the next authenticated ledger read failed integrity.

Observed result:

```json
{"invalidEnvelopeDeniedBeforeSubstitution":true,"exportedSchemaOwnMethodMutable":true,"changedEnvelopeStored":true,"projectedObservedCount":1,"integrityFailsAfterParserRestore":true}
```

This contradicts the exact-envelope, exact-ledger-package, per-operation verification, and store-only provenance claims.
It also shows why absence of the public assessment projector is necessary but not sufficient: a trusted method must not
consult a caller-mutable exported collaborator while deciding which artifact was authenticated.

### Required remediation

Trusted proof and ledger code must not consult mutable schema objects exposed to callers. Keep the authoritative schemas
and their parser operations private and captured, or otherwise bind them so direct-module mutation, prototype drift,
subclassing, and own-method substitution cannot change trusted behavior. If public syntax schemas remain useful, they must
be separate non-authoritative instances that are never consulted by the verifier or store.

Add hostile regression coverage for every directly exported schema/parser dependency before and after store construction,
including own-method and prototype substitution. Prove that attempted drift cannot change the package seen by verification,
cannot append a row or advance the checkpoint, and cannot produce an observed projection. A new exact remediation commit
requires a fourth different independent reviewer; producer tests cannot accept it.

## Authority, redaction, and residual boundary

All normal negative-authority checks remained intact. Complete nine-proof fixture evidence still reports zero qualified
proofs, nine remaining production proofs, all nine blocking gates, and false owner-approval, activation, consumer,
protected-reference, network, claim/lease, dispatch/execution, and external-effect capabilities. The safe normal projection
omits signatures, keys, identity detail, trust detail, evidence/binding digests, authentication tags, protected values,
private locators, and operational controls.

This review accepts no production proof and grants no owner approval, root/key/revocation/checkpoint/clock custody, hosted
or multi-process database qualification, real evidence collection, policy enrollment, protected-reference access,
consumer, activation, scheduling, claim, lease, dispatch, execution, recurrence, deployment, or effect authority. Those
remain explicit blockers even after the new defect is remediated.

## Final disposition

Exact second-remediation commit `0d7287fbdc06af3f8c220dad8227f0f99855b64a` is rejected. Both earlier rejection reports
must remain unchanged. Preserve this report as immutable negative evidence, then calculate and retain its digest with:

```sh
shasum -a 256 docs/reviews/CR11B_AUTO_060_SECOND_REMEDIATION_REREVIEW.md
```

`REJECTED`
