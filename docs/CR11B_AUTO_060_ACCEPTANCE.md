# CR11B-AUTO-060 Candidate Acceptance Record

Status: complete for exact independently accepted effect-free commit `be01058e2edeeddb7bbd2655eaf668ed86b9d0e2`

Date: 2026-08-30

## Candidate claim

The candidate verifies digest-only proof envelopes against an owner-signed, revisioned, repository-fixture Ed25519 trust
bundle and the exact authenticated AUTO-050 plan/assessment chain. It records those observations in an HMAC-authenticated,
rollback-checked private local ledger and derives partial gate status without accepting production readiness.

Every accepted proof remains `observed_unqualified`. Even nine accepted fixture proofs leave all nine gates blocking,
qualified count zero, activation false, and protected production reassessment required.

## Implemented boundary

- canonical external owner-root trust anchor in literal `repository_fixture_only` mode;
- owner-signed monotonic trust bundles with exact issuer/verifier roles, gates, keys, domains, expiry, and revocation;
- issuer-signed envelopes binding the complete AUTO-050 plan, assessment, requirement, binding, evidence, and chronology
  chain;
- required distinct independent-verifier signatures across identity, key, and owner-signed independence domain;
- one-hour maximum proof lifetime bounded by trust-bundle and AUTO-050 plan windows;
- private SQLite append-only trust/proof ledger with row HMAC, whole-state HMAC, exact schema, replay defense, and external
  rollback checkpoint;
- store-private assessment with unobserved, observed-unqualified, expired, revoked, and superseded states;
- authenticated-store-only frozen safe projection without signatures, keys, evidence/binding digests, protected values,
  controls, or a public trust parser; and
- module-private proof, trust, observation, ledger, and AUTO-050 syntax schemas with captured frozen parser operations;
  no caller-visible mutable schema object is consulted by the authoritative proof path; and
- no proof collection, consumer, network, hosted database, provider, deployment, dispatch, or effect path.

## Candidate tests

The dedicated suite contains twenty cases covering:

- owner, issuer, and independent Ed25519 verification;
- noncanonical signature aliases at all three signing roles;
- forged roots and signatures;
- cross-scope, incomplete, and reordered binding substitution;
- false issuer/verifier independence;
- stale, future, overlong, and post-plan chronology;
- complete nine-proof negative authority;
- partial, expired, superseded, and revoked assessment truth;
- exact ledger replay, same-ID drift, and stale trust revisions;
- store-only assessment and rejection of pre-ledger evaluation time;
- absence of every public digest-only assessment/projection trust boundary and rejection of the first-remediation forgery;
- absence of the exported proof-schema module and resistance to public own-method and prototype parser drift before and
  after ledger construction;
- terminal revocation, omission, identity-binding drift, and old-proof replay after trust advancement/capacity;
- SQLite artifact tampering and external-checkpoint rollback detection;
- open-store permission, hard-link, schema, and path-identity drift;
- safe projection redaction and false activation capabilities; and
- structural absence of effect clients.

Current candidate evidence:

- dedicated AUTO-060 third-remediation gate: 20/20;
- combined CR11B third-remediation gate: 119/119;
- registered pretests: 701/701;
- core suite: 414/416 with two intentional platform skips and zero failures;
- public posttests: 52/52;
- TypeScript type checking and full lint: pass;
- production build and 2/2 rendered routes: pass;
- all 27 migrations and 97 PostgreSQL tables: pass;
- macOS stage zero: `ready_for_runtime_check`; and
- working-tree whitespace validation: pass.

Producer evidence cannot accept this phase.

## Independent rejection and first remediation

A different independent reviewer rejected exact candidate
`f77108fc3c556970bff4cc94c4b952a0336a8cac`. The immutable report is
`docs/reviews/CR11B_AUTO_060_INDEPENDENT_REVIEW.md`, SHA-256
`fc22ddd3ee62f432eeaee5d5cbc0aca6715872fa7733e095979ac1ea3457f9cf`. It reproduced five concrete defects:

1. noncanonical base64url strings could alias identical Ed25519 signature bytes;
2. the exported assessor accepted publicly re-digested unsigned observations and store assessment could predate recorded
   proof truth;
3. an owner-signed later trust bundle could reactivate a terminally revoked identity;
4. an exact old proof stopped replaying inertly after the current trust revision changed; and
5. an already-open store did not recheck private file mode/link identity or exact schema on each operation.

The first remediation centralizes exact 64-byte signature round-trip validation for all three signature roles. It removes
the public raw-observation assessor; only the authenticated store builds assessment state, filtered to one exact assessment
and no earlier than all current ledger truth. Trust-chain validation now retains immutable identity/key/domain/role
bindings and irreversible revocation across every revision. Existing proof identity is checked against the fully verified
stored package before current-bundle admission, preserving exact replay after trust changes and at capacity. The store
retains device/inode identity and rechecks private path/file form and exact schema before and after every operation.

The immutable rejection remains unchanged. A different independent agent—not the implementer or first reviewer—must
reproduce all five findings against the rejected commit and verify every remediation variant against the new exact commit.

## First-remediation rejection and second remediation

A new different reviewer reproduced all five original findings against the rejected source, then reviewed exact first
remediation commit `fb2f0a3dd4e2e128ae6076daadad10938fec1438`. It confirmed the direct repairs for signature aliases,
backdating/raw-observation assessment, revocation resurrection, old-proof replay, and open-store drift, but rejected that
commit because an alternate public evidence path remained. The immutable report is
`docs/reviews/CR11B_AUTO_060_FIRST_REMEDIATION_REREVIEW.md`, SHA-256
`1aa0119e9eb8504d471586c88d62ab44b533f16190d2c9c57fbe58cad30e9dc2`.

The reviewer changed an unobserved gate in a real store assessment to `observed_unqualified`, recomputed only its public
SHA-256 digest, and passed it through the exported assessment parser and projector. The projected observed count increased
without any proof, signature, ledger row, HMAC, or checkpoint. Activation remained false, but operator evidence was
forgeable, so `AUTO060-FRR-001` preserved the substance of the original assessment-authenticity defect.

The second remediation removes the exported assessment parser, assessment projector, projection parser, public aggregate
exports for the internal proof schemas, and the store's public raw assessment method. `projectAssessment` is now the only
trusted status-view operation: it verifies private file/schema identity, every authenticated ledger record, current trust,
the rollback checkpoint, and the exact AUTO-050 assessment chain, derives assessment state internally, emits only a
deep-frozen redacted projection, and accepts no proof-assessment or projection input. A new hostile test reconstructs the
public-digest forgery, proves it cannot enter the store, and proves the old executable trust exports are absent.

Both rejection reports remained unchanged, and a third different agent—not the implementer or either prior reviewer—was
therefore assigned the exact second-remediation commit reviewed below.

## Second-remediation rejection and third remediation

The third different reviewer independently confirmed the prior two report hashes, reproduced the first-remediation
public-digest forgery, and verified the second remediation's direct fixes and passing focused/combined gates. It still
rejected exact second-remediation commit `0d7287fbdc06af3f8c220dad8227f0f99855b64a` because the direct
`production-proof-schemas.ts` module exported mutable Zod schema instances used by the verifier and store. Replacing the
verification-input schema's own parse method made the verifier authenticate one valid package while the ledger persisted
a different unsigned changed-binding envelope. The row and checkpoint advanced and projected one observed gate; restoring
the parser caused the next ledger verification to fail, proving verification and custody had diverged. Negative authority
remained intact and no external effect occurred.

The immutable report is `docs/reviews/CR11B_AUTO_060_SECOND_REMEDIATION_REREVIEW.md`, SHA-256
`303133e1297cb28a475b14bc51e0a77d20436a93cf4c23b410ebb544f2624323`.

The third remediation deletes the public proof-schema module. Proof, trust, observation, ledger assessment, projection,
identifier, digest, and time schemas are now module-private and built from private primitives. Their original parser
operations are captured into frozen closures before any caller can receive a module export. AUTO-050 production-boundary
schemas follow the same rule: callers receive only frozen captured parser closures, never the authoritative mutable schema
instances, and those schemas no longer compose caller-visible base schemas. The store persists only the exact canonical
envelope and assessment that the private verifier checks. A hostile regression replaces a public schema own method,
deletes another own method, substitutes its prototype, constructs and uses the ledger while those changes are active, and
proves the trusted result remains unchanged. It also proves the old proof-schema file and old mutable schema exports are
absent.

All three rejection reports remain immutable. A fourth different agent—not the implementer or any prior reviewer—reviewed
the exact third-remediation commit as recorded below.

## Independent acceptance

A fourth different independent agent reviewed exact commit `be01058e2edeeddb7bbd2655eaf668ed86b9d0e2`, tree
`f8b16104082ade92812c82792c04611a1c40073e`. The immutable accepted report is
`docs/reviews/CR11B_AUTO_060_THIRD_REMEDIATION_REREVIEW.md`, SHA-256
`8651708829f346e26ea60afec18418bd150844b063aa8d07e2afdd1f5bd6d61e`.

The reviewer independently covered:

1. root/key canonicalization and signature-material completeness;
2. trust-chain skip, fork, rollback, duplicate identity/key, revocation, expiry, and current-revision behavior;
3. every plan, assessment, requirement, binding, identity, trust, and chronology substitution;
4. issuer/verifier identity, key, and independence-domain aliasing;
5. proof replay, changed replay, database tampering, rollback checkpoint, capacity, restart, and concurrency semantics;
6. all-nine proof self-promotion, owner-approval confusion, and any alternate authority path;
7. safe projection leakage and raw evidence/private key ingress; and
8. every parser/schema dependency through direct and aggregate imports, including mutation before and after store
   construction, own-method replacement, prototype drift, and verification-versus-storage disagreement; and
9. imports/calls for any network, provider, destination, protected-reference, consumer, activation, dispatch, or effect path.

The reviewer confirmed all three earlier report hashes, reproduced the rejected mechanisms from source and preserved
evidence, ran 20/20 focused and 119/119 combined CR11B tests, typecheck, lint, stage zero, and exact diff checks, and used a
disposable generated-key/private-SQLite probe. It changed public schema methods and a shared prototype before and after
ledger construction, attempted replacement, deletion, and prototype substitution on all eleven exported frozen AUTO-050
parser wrappers, retried the prior changed-binding unsigned envelope, and verified denial with zero new row. The exact
canonical valid package persisted, restart integrity passed after restoration, and the old proof-schema module remained
absent. It found no alternate authority or effect path and accepted only the exact effect-free commit and tree above.

Any source or tree change reopens review. The report is immutable.

## Residual boundary

No production proof is accepted. Protected root/key/revocation/checkpoint/clock custody, hosted database qualification,
multi-process concurrency, real evidence collection, owner approval issuance, policy enrollment, consumer construction,
destination reconciliation, deployment, and every external effect remain separate future work.
