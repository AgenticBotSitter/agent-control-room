# CR11B-AUTO-110 independent review

**Verdict:** `REJECTED`

**Exact reviewed commit:** `7750c9b179d9f07ac05041ff4ac0dd19dd7766e7`

**Exact reviewed tree:** `86ff495485cb649c9cb458c63aeaca443f5016fa`

**Compared immutable base:** `59795094c8c6742117d0e246e9a8762c1f8c17c8`

**Base tree:** `ca810a49f321187cf3ef5a8e44ddb06c596e51a4`

**Review date:** 2026-08-31

**Reviewer:** different independent Codex security reviewer; not the implementation author

**Mode:** local repository-only, effect-free, report-only independent review. No implementation, test, contract, status,
package, dependency, Git-history, provider, host, process, database, credential, protected-reference, service,
configuration, migration, backup/restore, cleanup, consumer, deployment, or external-effect change.

**Report SHA-256:** calculated after the final report write and supplied in the handoff; embedding it here would change
the file digest.

## Decision

Exact candidate `7750c9b179d9f07ac05041ff4ac0dd19dd7766e7`, tree
`86ff495485cb649c9cb458c63aeaca443f5016fa`, is rejected.

The candidate correctly embeds and re-verifies the exact accepted AUTO-100 source lineage, retains all 36 canonical live
blockers in order, fixes the requested stages and ceilings, and emits only a disabled disposition and safe projection.
Every live capability remains false. The dedicated 12-case suite, combined 182-case CR11B suite, TypeScript check, and
exact-range whitespace check pass. Static source and import review found no network, host, process, PostgreSQL,
credential, protected-reference, service-control, migration, backup/restore, cleanup, consumer, or deployment client.

However, the only purported owner-direction evidence is an arbitrary caller-supplied SHA-256-shaped string and an
arbitrary caller-supplied timestamp. Neither construction nor parsing compares those fields to an immutable accepted
owner-direction record or authenticates them under an owner trust root. The public builder nevertheless sets
`ownerPhaseDirectionKind` to `owner_direction_to_prepare_auto110_not_live_effect_authority` and
`phasePreparationAuthorized` to `true`; the safe projection repeats the latter claim. Two unrelated caller-selected
digests and times independently produced valid packets carrying those claims.

This is false repository authority, even though it does not grant a live effect. The exact candidate cannot be accepted
as the authoritative source for a later packet while any ordinary caller can manufacture the fact that the owner
directed and authorized this phase.

## Scope and changed paths

Preflight confirmed a clean checkout on `codex/cr11b-auto-110-owner-rehearsal-packet`, exact reviewed commit and tree,
literal parent/base `59795094c8c6742117d0e246e9a8762c1f8c17c8`, and base tree
`ca810a49f321187cf3ef5a8e44ddb06c596e51a4`. No branch switch occurred.

The exact base-to-candidate range contains one commit and nine declared paths:

- added: `src/operations/v1/postgres-rehearsal.ts`, `tests/operations-postgres-rehearsal.test.ts`,
  `docs/CR11B_AUTO_110_ACCEPTANCE.md`, and `docs/CR11B_AUTO_110_POSTGRES_REHEARSAL_CONTRACT.md`;
- modified: `src/operations/v1/index.ts`, `package.json`, `docs/BUILD_STATUS.md`,
  `docs/CONTROL_ROOM_COMPLETION_PROGRAM.md`, and `docs/CR3_DECISION_LOG.md`.

No migration, lockfile, dependency version, provider adapter, operational configuration, protected value, or live-effect
client is in the range. The changed paths match the requested AUTO-110 effect-free packet scope.

## Independently observed checks

| Command or review | Result |
|---|---|
| Branch, status, commit, parent, tree, and base-tree checks | Clean pre-report checkout; exact candidate, tree, literal parent, and immutable base confirmed |
| `git diff --name-status 59795094c8c6742117d0e246e9a8762c1f8c17c8..7750c9b179d9f07ac05041ff4ac0dd19dd7766e7` | Nine declared AUTO-110 source, test, export, package, contract, acceptance, status, program, and decision paths |
| `git diff --check 59795094c8c6742117d0e246e9a8762c1f8c17c8..7750c9b179d9f07ac05041ff4ac0dd19dd7766e7` | Exit 0; no whitespace errors |
| `node --import tsx --test tests/operations-postgres-rehearsal.test.ts` | 12/12 passed; zero failures, skips, cancellations, or todos |
| `npm run test:cr11b` | 182/182 passed; zero failures, skips, cancellations, or todos |
| `./node_modules/.bin/tsc --noEmit` | Exit 0; TypeScript check passed |
| Caller-controlled owner-direction probe | Unexpected acceptance reproduced twice; two unrelated digests and times each yielded `phasePreparationAuthorized: true` and the owner-direction kind |
| Exact source, import, redaction, and live-client review | No raw host or credential value and no live network, process, database, service-control, provider, migration, backup/restore, cleanup, or deployment client found |

No GitHub or other network query was made because the review packet prohibits external contact. Local refs, history, and
the exact immutable range supplied all repository-scope evidence.

## Contract reconstruction

### AUTO-100 source and 36 blockers

Construction and parsing call the accepted AUTO-100 packet and disposition parsers. Those parsers bind the exact current
AUTO-090 target and CR10A snapshot, reconstruct all 39 source-separated gates, preserve exactly three repository-contract
observations, and leave exactly 36 live gates blocking. AUTO-110 binds the source packet/disposition IDs and digests,
embeds both complete objects, and requires its own blocker list to equal the source packet's canonical ordered blocker
list. Reordered stages, requirements, or blockers and changed or re-digested source identities fail closed.

The exact accepted AUTO-100 implementation commit and review SHA-256 are fixed literals. The ordinary source-substitution
and complete re-digested source-fork boundaries are therefore accepted narrowly.

### Bounded request, disposition, and projection

The request fixes ten ordered stages, eleven blocking requirements, one native attempt, one host session, four database
sessions, 1,800 seconds of live activity, 3,600 seconds of request lifetime, and 1,048,576 bytes of sanitized evidence.
It forbids production data, a public endpoint, existing-production-schema writes, service installation/control, raw
evidence retention, and automatic retry. Rollback and cleanup are required; cleanup requires separate authorization and
a receipt.

The disposition is deterministically bound to the exact request digest and can report only
`disabled_before_protected_reference_resolution`. Cross-request disposition and projection reuse fail. All contact,
process, database, migration, backup/restore, cleanup, consumer, deployment, approval, execution, and external-effect
facts remain false.

### Chronology, schema custody, registries, and redaction

Private Zod schemas require strict data and canonical offset timestamps. Captured `Date.parse` and `Number.isFinite`
reject non-finite chronology, enforce source disposition before direction, direction before request, positive expiry,
the one-hour request ceiling, and disposition after request. The two exported stage and requirement registries are
frozen and compared element-by-element. Exact JSON snapshotting rejects accessors and Proxies without executing their
behavior.

The request and projection contain only a generic Hostinger target class, safe codes, digests, timestamps, counts, and
false capability facts. They contain no hostname, address, port, username, protected locator, credential reference,
credential value, connection string, raw conversation, raw evidence, or deployable configuration.

Those controls do not authenticate the caller-supplied owner-direction digest and time. A SHA-256 syntax check proves
only formatting, not owner origin or acceptance.

## Finding

### `AUTO110-IR-001` — any caller can mint the claimed owner phase direction and preparation authorization

**Severity:** high within AUTO-110's owner-direction and authoritative repository-truth boundary; no live or external-
effect authority

`requestInputSchema` accepts `ownerPhaseDirectionDigest` and `ownerPhaseDirectionRecordedAt` directly from the caller.
The builder checks only digest syntax and chronology, copies both values into the request, and unconditionally sets:

- `ownerPhaseDirectionKind: "owner_direction_to_prepare_auto110_not_live_effect_authority"`; and
- `phasePreparationAuthorized: true`.

The parser verifies the self-consistent request digest but has no immutable expected owner-direction identity and no
owner signature, authentication tag, trust-root check, or accepted repository snapshot to compare. Re-digesting the
request therefore cannot distinguish an owner record from any caller-selected record.

The following local in-memory probe used the exact canonical AUTO-100 fixture source, then called the public builder
twice with unrelated caller-selected direction digests and times. Both requests built and parsed:

```text
{"requestId":"request:operations:postgres-rehearsal:caller-a","phasePreparationAuthorized":true,"ownerPhaseDirectionKind":"owner_direction_to_prepare_auto110_not_live_effect_authority","accepted":true}
{"requestId":"request:operations:postgres-rehearsal:caller-b","phasePreparationAuthorized":true,"ownerPhaseDirectionKind":"owner_direction_to_prepare_auto110_not_live_effect_authority","accepted":true}
```

This does not turn on host or database contact, but it contradicts the candidate's core claim that the packet records the
owner's direction. The projection can present false owner-derived preparation authority, and the acceptance document
says an independently accepted request may become the source of a later live packet. Future strong-factor checks do not
repair false source provenance in this artifact.

### Required bounded remediation

AUTO-110 must not derive owner provenance from a caller-supplied bare digest and time. A bounded remediation must choose
one of these fail-closed shapes:

1. bind request construction and parsing to one privately captured immutable owner-direction snapshot that is accepted
   through repository governance, and reject caller-selected direction identity/time forks; or
2. verify a canonical exact owner-direction attestation under an independently pinned owner trust root before setting any
   owner-direction or preparation-authorized fact.

If this phase intentionally does not authenticate owner direction in code, the artifact must say so explicitly and keep
`phasePreparationAuthorized` and every owner-derived authorization fact false; it may record only a non-authorizing,
unverified operator note.

Regression coverage must prove that unrelated and re-digested direction IDs, digests, and times are rejected or remain
explicitly unverified, that cross-request disposition/projection reuse still fails, and that all 36 blockers and every
live capability remain unchanged. Remediation must not add a live client, protected value, credential, or effect path.

## Sanitized negative authority

The candidate and this review performed no provider, host, protected-reference, network, process, PostgreSQL service,
database, credential, service-control, configuration, migration, backup, restore, cleanup, consumer, deployment, DNS,
Cloudflare, or external-system contact or change. No native rehearsal or live qualification occurred. No raw host
identity, protected locator, credential reference/value, connection string, production data, raw evidence, or deployable
configuration was read or retained. No commit, push, approval, or merge occurred.

All 36 live production blockers remain exact and blocking. This report grants no approval, owner window, protected-
reference resolution, host/database contact, installation, service control, migration, backup/restore, cleanup,
consumer activation, deployment, retry, dispatch, execution, or external-effect authority.

## Final verdict

Exact commit `7750c9b179d9f07ac05041ff4ac0dd19dd7766e7`, tree
`86ff495485cb649c9cb458c63aeaca443f5016fa`, is rejected for CR11B-AUTO-110. Preserve this report unchanged under its
handoff SHA-256. Remediate only in a new exact implementation commit and appoint a different independent reviewer.

`REJECTED`
