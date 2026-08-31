# CR11B-AUTO-060 Candidate Acceptance Record

Status: second remediation implemented locally after two independent rejections; third different-agent re-review pending

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
- no proof collection, consumer, network, hosted database, provider, deployment, dispatch, or effect path.

## Candidate tests

The dedicated suite contains nineteen cases covering:

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
- terminal revocation, omission, identity-binding drift, and old-proof replay after trust advancement/capacity;
- SQLite artifact tampering and external-checkpoint rollback detection;
- open-store permission, hard-link, schema, and path-identity drift;
- safe projection redaction and false activation capabilities; and
- structural absence of effect clients.

Current candidate evidence:

- dedicated AUTO-060 second-remediation gate: 19/19;
- combined CR11B second-remediation gate: 118/118;
- registered pretests: 700/700;
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

Both rejection reports remain unchanged. A third different agent—not the implementer or either prior reviewer—must review
the new exact second-remediation commit before AUTO-060 can close.

## Required independent review

A third different independent agent must re-review the exact frozen second-remediation commit. At minimum, it must attack:

1. root/key canonicalization and signature-material completeness;
2. trust-chain skip, fork, rollback, duplicate identity/key, revocation, expiry, and current-revision behavior;
3. every plan, assessment, requirement, binding, identity, trust, and chronology substitution;
4. issuer/verifier identity, key, and independence-domain aliasing;
5. proof replay, changed replay, database tampering, rollback checkpoint, capacity, restart, and concurrency semantics;
6. all-nine proof self-promotion, owner-approval confusion, and any alternate authority path;
7. safe projection leakage and raw evidence/private key ingress; and
8. imports/calls for any network, provider, destination, protected-reference, consumer, activation, dispatch, or effect path.

Any concrete finding rejects the candidate. The report is immutable once written. Remediation requires a new exact commit
and a different-agent re-review.

## Residual boundary

No production proof is accepted. Protected root/key/revocation/checkpoint/clock custody, hosted database qualification,
multi-process concurrency, real evidence collection, owner approval issuance, policy enrollment, consumer construction,
destination reconciliation, deployment, and every external effect remain separate future work.
