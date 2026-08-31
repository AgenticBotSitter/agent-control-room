# CR11B-AUTO-060 Candidate Acceptance Record

Status: implementation complete locally; independent security and authority review pending

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
- partial assessment with unobserved, observed-unqualified, expired, revoked, and superseded states;
- safe projection without signatures, keys, evidence/binding digests, protected values, or controls; and
- no proof collection, consumer, network, hosted database, provider, deployment, dispatch, or effect path.

## Candidate tests

The dedicated suite contains thirteen cases covering:

- owner, issuer, and independent Ed25519 verification;
- forged roots and signatures;
- cross-scope, incomplete, and reordered binding substitution;
- false issuer/verifier independence;
- stale, future, overlong, and post-plan chronology;
- complete nine-proof negative authority;
- partial, expired, superseded, and revoked assessment truth;
- exact ledger replay, same-ID drift, and stale trust revisions;
- SQLite artifact tampering and external-checkpoint rollback detection;
- safe projection redaction and false activation capabilities; and
- structural absence of effect clients.

Current candidate evidence:

- dedicated AUTO-060: 13/13;
- combined CR11B: 112/112;
- registered pretests: 694/694;
- core suite: 414/416 with two intentional platform skips and zero failures;
- public posttests: 52/52;
- TypeScript type checking and full lint: pass;
- production build and 2/2 rendered routes: pass;
- all 27 migrations and 97 PostgreSQL tables: pass;
- macOS stage zero: `ready_for_runtime_check`; and
- working-tree whitespace validation: pass.

Producer evidence cannot accept this phase.

## Required independent review

A different independent agent must review the exact frozen implementation commit. At minimum, it must attack:

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
