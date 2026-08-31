# CR11B-AUTO-070 Protected Custody Qualification Foundation Contract

Status: candidate; independent review required

Date: 2026-08-30

## Purpose

AUTO-070 defines the repository-owned machinery that a later owner-authorized qualification can use to examine protected
service identity, policy high-water, clock and revocation custody, checkpoint rollback resistance, hosted PostgreSQL
isolation, backup/restore behavior, and post-marker ambiguity.

This block runs only a deterministic in-process fake. A successful fake report proves that the qualification contract and
failure classification work; it does not prove a hosted database, a production identity, a production clock, a protected
checkpoint, or any of the nine AUTO-050 production gates.

## Authenticated source and plan

The qualification plan carries and re-verifies the complete authenticated AUTO-050 assessment under its existing
activation-packet integrity key. It also binds the accepted AUTO-060 implementation commit and independent-review digest.
The plan's own digest and HMAC bind its tenant, workspace, source assessment, time window, fixed process/role layout, eight
scenario codes, and all nine production blockers.

The plan is valid for at most one hour, must fit inside the source production-boundary window, and is literal
`repository_fake_only`. It requires but does not configure:

- a separately authenticated proof-ingress writer;
- a separate proof-read verifier;
- an independent rollback-checkpoint custodian;
- owner-signed external policy high-water;
- protected monotonic time sampled at the database commit boundary;
- terminal revocation converged across processes;
- hosted PostgreSQL `SERIALIZABLE` transactions;
- an external compare-and-swap checkpoint; and
- isolated restore followed by explicit reconciliation.

The three role identities, key-identity digests, and independence-domain digests are distinct. No role may issue a proof,
approve production, or activate production. The plan contains no connection string, hostname, credential, private key,
protected reference, production identity, or policy material.

## Eight deterministic scenarios

The fixed fake harness owns its state and accepts no database, process, clock, checkpoint, network, or effect callback.
It models three logical processes and runs these cases in canonical order:

1. `service_identity_separation` — three single-purpose identities have distinct key and independence domains.
2. `owner_policy_high_water` — revision two is accepted and an attempted return to revision one is rejected.
3. `protected_clock_commit_boundary` — protected time is monotonic and expiry is decided at the later commit boundary.
4. `revocation_cross_process_convergence` — all three process views observe the terminal revision and reject the old
   credential identity.
5. `serializable_claim_uniqueness` — three contenders produce exactly one deterministic claim owner.
6. `checkpoint_compare_and_swap` — one correct advance succeeds and a stale compare-and-swap fails.
7. `backup_restore_rollback_detection` — a database restored behind the external checkpoint is detected and untrusted.
8. `post_marker_ambiguity` — a committed marker without a destination receipt is terminal ambiguity with no automatic
   retry.

Each scenario emits only a safe finding code and a transcript digest. The eight explicit fault controls exist solely to
exercise the negative paths. Each fault must create exactly one simulated failure and cannot change any authority flag.

## Authenticated report

The report binds the exact plan, source assessment, run identity, chronology, injected test fault, canonical scenario
results, all nine blockers, and counts. Its digest and HMAC are checked on every parse. Parsing re-runs the private fake
model and requires byte-equivalent canonical results, so a fixture caller cannot rewrite a result and make it trusted by
recomputing the public digest and fixture HMAC.

Even when all eight scenarios pass, the report remains `blocked_fake_qualification_only` with safe reason
`protected_production_qualification_not_run`. It always records:

- zero qualified proofs and nine remaining production proofs;
- no live qualification, hosted-database, production-clock, key-store, checkpoint, or owner-policy contact;
- no owner approval, consumer construction, claim, lease, dispatch, execution, network, or external effect; and
- no approval, activation, claim/lease, dispatch/execution, or effect authority.

Exact replay is deterministic. Accessors and Proxies are rejected before their behavior executes. Plans and reports are
deep-frozen after authoritative parsing.

## Safe projection

The projector first re-verifies the full plan and report. It returns only tenant/workspace, plan/report IDs, safe scenario
status pairs, all nine blockers, zero qualified proofs, and false capability flags. It omits source assessments, service
identities, key and domain digests, scenario evidence digests, HMACs, injected faults, protected material, and operational
controls. The projection is deep-frozen and content-digested.

## Hostile acceptance boundary

The exact candidate must prove:

- authenticated AUTO-050 and accepted AUTO-060 lineage;
- canonical scenario, process, role, and gate ordering;
- distinct single-purpose role identities and domains;
- policy rollback, clock rollback, revocation lag, duplicate claims, stale checkpoint CAS, restored-database trust, and
  post-marker retry all fail closed;
- caller-rewritten scenario evidence is re-derived and rejected even after public digest and fixture-HMAC recomputation;
- cross-plan, cross-assessment, scope, chronology, digest, and HMAC drift fails closed;
- accessors and Proxies execute zero caller behavior;
- the safe projection exposes no evidence, authentication, identity, or protected material; and
- source imports no live database, filesystem, process, worker, network, credential, protected-reference, dispatch, or
  execution client.

## Stop boundary

AUTO-070 does not connect to PostgreSQL or any provider, start processes or workers, access a credential store, enroll a
production key or owner policy, read protected time or checkpoints, collect live evidence, resolve protected references,
construct a consumer, contact a destination, schedule work, claim or lease, dispatch or execute, contact an agent or
GitHub, activate recurrence, operate DNS/Cloudflare/hosting, deploy, or cause an external effect.

Independent acceptance may cover only the exact repository-fake commit. A disposable hosted qualification requires a new
controlled-effect packet, exact owner authority, separately provided disposable resources, sanitized evidence, cleanup,
and fresh review. Fake transcript digests can never be promoted or relabelled as production proof.
