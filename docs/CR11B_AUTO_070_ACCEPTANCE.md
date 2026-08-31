# CR11B-AUTO-070 Acceptance Record

Status: five candidates rejected; fifth remediation implemented; sixth different independent review pending

Date: 2026-08-30

## Candidate claim

The candidate provides an authenticated, versioned, effect-free qualification foundation for the protected custody and
hosted PostgreSQL properties left open by AUTO-060. Its exact private fake exercises eight distributed-state boundaries
and emits a re-derived authenticated report plus a safe disabled projection.

It does not perform a live qualification. A complete simulated pass leaves all nine production gates blocking, zero
qualified proofs, and every authority/effect flag false.

## Implemented boundary

- complete authenticated AUTO-050 assessment carried into and re-verified from every plan;
- accepted AUTO-060 implementation and review identities pinned into the plan;
- distinct proof-writer, proof-reader, and external-checkpoint custody roles;
- fixed three-process, eight-scenario fake qualification model;
- exact policy, clock, revocation, serializable-claim, checkpoint, restore, and ambiguity failure classification;
- report digest/HMAC with private deterministic evidence re-derivation;
- eight isolated negative fault controls;
- frozen, evidence-free, non-authorizing projection; and
- no live database, process, worker, network, filesystem, credential, protected-reference, consumer, dispatch, execution,
  deployment, or effect client.

## Producer verification

- focused AUTO-070 tests: 17/17 passing;
- combined CR11B tests: 136/136 passing;
- registered pretests: 718/718 passing;
- core tests: 414/416 passing with zero failures and two intentional platform skips;
- public post-tests: 52/52 passing;
- TypeScript check: passing;
- full lint: passing;
- production build and rendered-route checks: passing, 2/2 routes;
- database verification: all 27 migrations and 97 PostgreSQL tables;
- macOS stage zero: `ready_for_runtime_check`; and
- working-tree whitespace validation: passing.

## Acceptance requirement

Producer tests do not accept this security boundary. A fresh independent reviewer must examine the exact committed
candidate, rerun the focused and combined gates, attack all eight failures and authenticated artifact seams, confirm the
source has no effect path, and preserve a sanitized immutable report. Any finding keeps AUTO-070 open.

## First review disposition and remediation

The first independent review rejected exact commit `28c6603478ffbb6036dea348475f402984bfbbae`, tree
`44f05681e39de44dfc979451be4bee919dc5fc5e`. The unchanged report is
`docs/reviews/CR11B_AUTO_070_INDEPENDENT_REVIEW.md`, SHA-256
`4a15ae85d35fe6bd71866dc69cc36f8b2cb378d7357db9f90d6d5db697c2f86f`.

Finding `AUTO070-IR-001` proved that caller-mutable `Object.freeze` and `Set.prototype.add` controlled claimed
immutability and identity-duplicate classification. The remediation captures and verifies trusted runtime operations,
removes shared collections and array helpers from scenario decisions, retains a private digest/HMAC runtime sentinel,
and adds two hostile shared-helper tests. All thirteen focused cases and 132 combined CR11B cases now pass. This does not
close the finding; a different reviewer must accept the exact remediation commit.

## First-remediation re-review and second remediation

A different reviewer rejected exact first-remediation commit
`1dff163808ef2866eb44ec83394ff64789959f57`, tree
`4829070eb0b4429dc577404daaaea697f439b2b0`. The unchanged report is
`docs/reviews/CR11B_AUTO_070_FIRST_REMEDIATION_REREVIEW.md`, SHA-256
`2d212bfa071437b1af10c0ac9c00432df0d4823d2196a3ee235e8feaec17ebab`.

Finding `AUTO070-RR1-001` proved that a post-load inherited setter at numeric `Array.prototype` index `1` could intercept
trusted writes into initially empty arrays and make `service_identity_alias` authenticate as eight passes. The second
remediation eliminates inherited indexed writes from service-role construction, identity decisions, revocation and claim
decisions, scenario-result construction, report comparison, and projection construction. Trusted three-way decisions now
use scalars, while fixed output collections use array literals that create own indexed data directly. A new hostile case
installs the inherited setter, requires all eight faults to fail exactly once, checks deep freezing and negative authority,
restores the prototype, and re-verifies the authentic drift-time report. This finding remains open until a third different
reviewer accepts the exact second-remediation commit.

## Second-remediation re-review and third remediation

A third different reviewer rejected exact second-remediation commit
`2cea5975e2c346cf171dbd49c5ab55592ab18578`, tree
`a1eca854dc027078a915834b80418583a9d3b0b0`. The unchanged report is
`docs/reviews/CR11B_AUTO_070_SECOND_REMEDIATION_REREVIEW.md`, SHA-256
`7e759fdb942ee07f6647f31ce365c0d9ff5883f178ed310fb30e058dc6cba763`.

Finding `AUTO070-RR2-001` proved that mutable `Date.prototype.getTime` and `Date.prototype.toISOString` could make an
impossible canonical-shaped instant pass schema validation while captured static parsing returned `NaN`, causing all
chronology denial comparisons to be false. The third remediation captures both instance methods, checks their exact
descriptors before every exported operation, invokes only the captured methods for schema validation, cross-checks the
captured static parse epoch, and rejects equal as well as reversed run boundaries. Its hostile regression changes both
instance methods after module load, requires invalid/equal/reversed plan and run operations to fail closed, restores the
methods, and re-verifies the pre-existing valid authenticated plan and report. A fourth different reviewer must accept the
exact third-remediation commit.

## Third-remediation re-review and fourth remediation

A fourth different reviewer closed the three prior findings but rejected exact third-remediation commit
`941b6d624bd06dab2a17ab490f33dcd5ac4c6fc2`, tree
`748d90175e3d64d7352e362df97fb6fda63e276c`. The unchanged report is
`docs/reviews/CR11B_AUTO_070_THIRD_REMEDIATION_REREVIEW.md`, SHA-256
`4d9517bdb99b93258b23edfac37320ced6c023c13687f815e8e07d4c1840e695`.

Finding `AUTO070-RR3-001` proved that current `String.prototype.slice` semantics controlled the digest-derived report ID,
so a report authenticated under substituted semantics failed after restoration. The fourth remediation captures the
string prototype and slice intrinsic before exposure, checks their exact descriptor before every exported operation,
and derives both new and expected report IDs only through the captured intrinsic. Its hostile regression changes slice
after module load, requires construction and parsing to fail closed before artifact work, restores the method, and proves
exact replay plus parsing return the original stable authenticated report. A fifth different reviewer must accept the
exact fourth-remediation commit.

## Fourth-remediation re-review and fifth remediation

A fifth different reviewer closed the four prior concrete attacks but rejected exact fourth-remediation commit
`ccdc13e37179674891793de978ae6c32409d646f`, tree
`40415e8b47bc779fddf06b7fe9419fe385fa4e47`. The unchanged report is
`docs/reviews/CR11B_AUTO_070_FOURTH_REMEDIATION_REREVIEW.md`, SHA-256
`8e65da402e9e4ea045ced9387294e5caa6ba8ecaf84f9ede73471ab6fcc61db0`.

Finding `AUTO070-RR4-001` proved that current `Array.prototype[Symbol.iterator]` semantics controlled the projection's
blocker copy. A selective iterator could duplicate the first valid blocker, omit the ninth, preserve schema length, and
authenticate that false projection. The fifth remediation captures the array iterator before exposure, checks its exact
descriptor before every exported operation, and removes array spread from every trusted process, scenario, gate, and
projection collection. Fixed array literals use explicit own indexed values, including all nine already authenticated
report blockers. Its hostile regression substitutes the iterator after module load, requires plan and projection work to
fail closed before the changed blocker iterator runs, restores it, and proves the original report projects to the exact
same ordered nine blockers and digest. A sixth different reviewer must accept the exact fifth-remediation commit.

## Negative authority

No live resource was contacted and no owner approval, production policy, production key, hosted-database qualification,
consumer, activation, claim, lease, dispatch, execution, deployment, or external effect was created. The fake result is
not AUTO-060 production evidence and cannot satisfy any AUTO-050 requirement.
