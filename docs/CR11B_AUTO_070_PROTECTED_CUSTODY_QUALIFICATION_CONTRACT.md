# CR11B-AUTO-070 Protected Custody Qualification Foundation Contract

Status: four candidates rejected; exact fourth remediation requires a fifth different independent review

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
deep-frozen after authoritative parsing. Freeze, frozen-state, and nested-value operations are captured before the module
is exposed. Duplicate identity/key/domain detection uses private scalar three-way comparison rather than a shared
collection or an inherited indexed write. Trusted fixed collections are created as complete array literals, never by
assigning numbered slots on an empty array.
Canonical JSON/digest helpers are pinned by exact runtime references and a private digest/HMAC sentinel; drift fails closed
before plan, report, or projection work.

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

## First review and remediation

The first independent review rejected exact candidate commit `28c6603478ffbb6036dea348475f402984bfbbae`, tree
`44f05681e39de44dfc979451be4bee919dc5fc5e`. Its immutable report has SHA-256
`4a15ae85d35fe6bd71866dc69cc36f8b2cb378d7357db9f90d6d5db697c2f86f`.

`AUTO070-IR-001` showed that post-load replacement of `Object.freeze` disabled the claimed freeze and that selective
replacement of `Set.prototype.add` converted the explicit identity-alias fault into an authenticated eight-pass report.
Negative authority remained intact, but fake qualification truth was not trustworthy.

The remediation captures freeze/value operations before exposure, verifies each recursive freeze, removes `Set` and
shared array helpers from scenario truth, uses private pairwise/counting loops, and checks the canonical digest runtime
surface plus sentinel on every exported operation. New hostile cases change freeze/value/frozen-state and selective Set
behavior both before and after artifact construction, require the identity-alias fault to remain one failure, require all
artifacts to remain frozen, re-parse the drift-time report after helper restoration, and require other canonical helper
drift to fail closed. A different reviewer then rejected exact first-remediation commit
`1dff163808ef2866eb44ec83394ff64789959f57`, tree
`4829070eb0b4429dc577404daaaea697f439b2b0`, in unchanged report SHA-256
`2d212bfa071437b1af10c0ac9c00432df0d4823d2196a3ee235e8feaec17ebab`.

`AUTO070-RR1-001` showed that an inherited numeric setter on `Array.prototype[1]` could intercept writes to initially
empty private arrays and keep the identity-alias fault looking unique. The second remediation removes every inherited
indexed write from trusted scenario truth. Service roles and the canonical eight results are complete literals;
identity, role, revocation, and claim decisions use explicit scalars; report comparison and projection collections are
fixed literals. Its hostile regression installs the numeric setter before scenario execution, requires all eight faults
to produce one failure, checks deep freezing and all negative-authority fields, restores the prototype, and re-verifies
the authentic drift-time report. Only a third different independent reviewer can accept the exact second-remediation
commit.

A third different reviewer accepted the inherited-index closure but rejected exact second-remediation commit
`2cea5975e2c346cf171dbd49c5ab55592ab18578`, tree
`a1eca854dc027078a915834b80418583a9d3b0b0`, in unchanged report SHA-256
`7e759fdb942ee07f6647f31ce365c0d9ff5883f178ed310fb30e058dc6cba763`.

`AUTO070-RR2-001` showed that substituted Date instance methods could make an impossible canonical-shaped instant pass
schema validation while captured static parsing returned `NaN`, bypassing chronology comparisons. The third remediation
captures `getTime` and `toISOString`, verifies their exact descriptors before artifact work, invokes only the captured
methods, cross-checks their epoch with captured static parsing, and makes equal completion/start boundaries invalid. Its
hostile regression substitutes both methods after module load, requires invalid, equal, and reversed plan/run operations
to fail closed, restores the methods, and re-verifies the stable pre-existing plan and report. Only a fourth different
independent reviewer can accept the exact third-remediation commit.

A fourth different reviewer closed the prior three findings but rejected exact third-remediation commit
`941b6d624bd06dab2a17ab490f33dcd5ac4c6fc2`, tree
`748d90175e3d64d7352e362df97fb6fda63e276c`, in unchanged report SHA-256
`4d9517bdb99b93258b23edfac37320ced6c023c13687f815e8e07d4c1840e695`.

`AUTO070-RR3-001` showed that mutable current `String.prototype.slice` semantics could change the digest-derived report
ID and make an authenticated artifact invalid after restoration. The fourth remediation captures the string prototype
and slice intrinsic, verifies the exact descriptor before artifact work, and derives both construction-time and
parse-time report IDs through the captured intrinsic. Its hostile regression substitutes slice, requires report
construction and parsing to fail closed, restores the method, and proves the original authenticated report retains exact
replay and parsing validity. Only a fifth different independent reviewer can accept the exact fourth-remediation commit.
