# CR11B-AUTO-030 Fourth Remediation Independent Re-review

**Review mode:** independent-review, report-only, zero repair budget

**Review date:** 2026-08-30

**Reviewer identity:** Codex reviewer `auto030_fourth_remediation_rereview`, a fresh reviewer task different from the authors of all four preserved negative reports

## Exact review binding

- Immutable feature base: `8acdbcabe300660f062c202d7850537cb20373d6`
- Original feature commit: `59c81987ac178ef59c073f523581f74b954962e5`
- Rejected first candidate: `47e4000fb374eaefdfeb31e88db127505d3f11dc`
- Rejected first remediation: `fd64e418882fb8ca8a044163b2c623f235e21976`
- Rejected second remediation: `5b26a634516ca1a956edfeb67c7480343bf9104b`
- Rejected third remediation: `9e43ea56471df1ee58dd8e94da04550ce6062063`
- Exact fourth-remediation target: `adf0804a52a13d544192afc90506c3e989254ffd`
- Branch: `codex/cr11b-auto-030-ready-scheduler-handoff`
- Feature merge-base: `8acdbcabe300660f062c202d7850537cb20373d6`
- Fourth-remediation merge-base: `9e43ea56471df1ee58dd8e94da04550ce6062063`

`HEAD`, branch, merge bases, and target matched exactly before review. `git status --short --branch` showed the exact branch and a clean working tree before any review write. This report is the only repository file created or changed by this reviewer.

The four immutable negative reports were read in full and independently hashed before review:

| Preserved report | Independently observed SHA-256 |
|---|---|
| `docs/reviews/CR11B_AUTO_030_INDEPENDENT_REVIEW.md` | `5a5f2d884c28ae5397caaf27b4573aa14f3ae93fe8936687d8251d7e328ae825` |
| `docs/reviews/CR11B_AUTO_030_INDEPENDENT_REREVIEW.md` | `8f0bd318bbbf69a516f737da5cdd4367e4bd00cc6afcb0130c7c433e9e042652` |
| `docs/reviews/CR11B_AUTO_030_SECOND_REMEDIATION_REREVIEW.md` | `db6e7986b97a877db77cc235a8e9d83b9723ef7a5a4aacdc4fe12805cd2897b7` |
| `docs/reviews/CR11B_AUTO_030_THIRD_REMEDIATION_REREVIEW.md` | `10147ed33b7a95a300c36ac5a1d7d59124c037a8e88fa59323e816f97ffe0acc` |

No prior report was changed or reinterpreted as passing evidence.

## Disposition rationale

No reproducible fourth-remediation finding remains on the exact target. The database abstraction now makes the abort-capable check mandatory, and both repository adapters implement it in the correct order: await the complete application callback, synchronously run the trusted-time predicate, then return to the transaction manager. Inspection of the installed PostgreSQL transaction implementation confirmed that `COMMIT` is initiated only after that wrapper callback returns. The PGlite adapter has the same ordering, and an independent disposable probe confirmed that a thrown predicate rolls back the application callback's write.

The canonical operation uses `transactionWithPreCommitCheck`, not the ordinary transaction operation. It samples a canonical trusted clock after both policy queues, repeatedly through commit-sensitive phases, in the adapter-owned post-callback/pre-commit predicate, and again after the transaction promise settles. The time check rejects regression, invalid instants, inactive or expired policy, expired reservation/handoff/job authority, stale promotion time, and stale materialization. Expiry at the last abort-capable boundary rolls back the complete attempted bundle. Expiry only after successful commit returns explicit canonical ambiguity and never a new or replay current-success result.

The earlier architecture repairs also hold: the public canonical port accepts only the opaque single-acquire token; all persistence facts are reconstructed from hidden exact clones; registered use keeps both policy operations alive through database completion; generic ready, delivery, and claim paths are isolated; request identity and replay are transactionally bound; receipt-only projection is historical; independent local policy stacks reach the shared canonical transaction boundary; capacity and collision paths converge or roll back; and the UI has no authority control.

## Mandatory database-boundary assessment

### PostgreSQL adapter

`createPostgresClient` implements `transactionWithPreCommitCheck` inside `sql.begin`. It awaits the supplied application callback, invokes `preCommitCheck()` synchronously, and only then returns its result. The installed `postgres` library awaits that callback and issues `commit` afterward. There is no awaited application seam between the predicate and return to the transaction manager. A live PostgreSQL server was neither available nor authorized, so this is exact source/dependency-order evidence rather than a native multi-session PostgreSQL run.

### PGlite adapter

`adaptPglite` implements the same sequence inside `db.transaction`: complete callback, synchronous predicate, return. The focused post-callback probe passed with zero request, transition, ready job, reservation, handoff, or outbox rows after the predicate observed expiry. A separate disposable adapter probe inserted a row in the application callback, threw from the predicate, and observed zero committed rows; its success case observed `callback-complete`, `precommit-check`, then `promise-resolved` and one committed row.

### Canonical use and post-transaction truth

`CanonicalStore.promoteReadyFrontierJobWithInternalHandoff` calls only `transactionWithPreCommitCheck` for this operation. The predicate invokes the same non-decreasing trusted-time validator after the complete new or replay application callback. After the transaction promise settles, the store samples again. If that final sample is no longer current, it throws `Ready frontier transaction completed without confirmed current authorization; canonical outcome is ambiguous`. Focused new-result and replay probes each crossed expiry only after commit and received ambiguity rather than `replayed: false` or `replayed: true` success.

The process clock still cannot prove the external database's physical commit timestamp. The accepted claim is limited to the last abort-capable adapter boundary before commit initiation plus explicit post-transaction ambiguity. Production database-clock custody and cross-service ambiguity reconciliation remain unproved.

## Prior finding disposition

### Original review family

| Finding | Fourth re-review disposition |
|---|---|
| `AUTO030-REV-001` generic ready transition | Closed. Generic `proposed -> ready` rejects the frontier work-order class before mutation; the focused attack leaves the job proposed with zero reservation, transition, outbox, or handoff. |
| `AUTO030-REV-002` stale persistence after revocation | Closed for the repository claim. The standalone persistence export is absent. Only the promotion module mints the opaque token, canonical acquisition registers its use synchronously, and policy revision/suspension/revocation cannot overtake the outstanding database promise. |
| `AUTO030-REV-003` conflicting request identity | Closed locally. Tenant-scoped `ready-frontier-promotion` idempotency binds request digest, receipt, job, reservation, and handoff. Exact duplicate requests converge to one new result and one replay; changed same-ID job lineage rejects with one bundle retained. |
| `AUTO030-REV-004` stale replay | Closed. Replay locks tenant/request state and verifies exact pending handoff, transition, active reservation, resource-head capacity, ready job/digest, pre-commit time, and post-transaction time. Expired reservation and advanced truth reject. |
| `AUTO030-REV-005` invalid observation time | Closed. Projection parses exact canonical UTC time; invalid, offset-form, impossible, pre-effective, exact-expiry, and post-expiry observations cannot produce active current policy truth. |

### First-remediation re-review family

| Finding | Fourth re-review disposition |
|---|---|
| `AUTO030-RR-001` caller-expanded ceilings and persistence facts | Closed structurally. The canonical port accepts only the opaque token and locally derives global/project limits, resource key/units/capacity, request/receipt/job identities, actor, transition, reservation, and negative-authority handoff from hidden exact clones. |
| `AUTO030-RR-002` guard retirement before database completion | Closed. Single acquisition registers an in-flight use before any await; authorization retirement waits for all uses, and both enclosing policy callbacks remain active through the database promise. The unawaited-call probe cannot be overtaken by revocation. |
| `AUTO030-RR-003` pre-queue trusted time | Closed. No clock call occurs before queued policy acquisition. Fresh time is sampled inside both guards, after tenant/resource locking and mutation phases, at adapter-owned pre-commit, and after transaction completion; regression fails closed. |
| `AUTO030-RR-004` expired receipt projected pending | Closed. Receipt-only projection is explicitly historical, always reports zero current ready jobs and zero pending handoffs, and never infers current state from nominal expiry. |
| `AUTO030-RR-005` whitespace-evidence wording | Closed on the fourth-remediation range and current tree. `git diff --check 9e43ea5..adf0804` and working-tree `git diff --check` pass. The immutable first report's earlier Markdown hard breaks remain documented and unchanged; no clean full-feature-range claim is made here. |

### Second-remediation re-review family

| Finding | Fourth re-review disposition |
|---|---|
| `AUTO030-SRR-001` mutable canonical input after validation | Closed. No caller persistence-fact object enters the canonical method. Hidden receipt and policy bindings are exact-cloned at token acquisition and are the sole source for every later write. Accessor, Proxy, and caller-extra-field attacks do not influence the stored bundle. |
| `AUTO030-SRR-002` expiry during transition-to-commit | Closed. The clock is checked after transition, handoff insertion, request completion, and finally by the transaction owner after the full callback. Expiry through that last abort-capable point rolls back request, transition, ready job, reservation, handoff, and ordinary transition outbox. |
| `AUTO030-SRR-003` replay end-time crossing | Closed. Replay checks after its last evidence read, again at adapter pre-commit, and again after transaction settlement. Pre-commit expiry rejects the transaction; post-transaction expiry returns ambiguity rather than replay success. |
| `AUTO030-SRR-004` receipt-only current-pending projection | Closed. Projection reports authenticated history only and never a current ready job or pending handoff, including after early release, missing/advanced state, or nominal expiry. |
| `AUTO030-SRR-005` same-store concurrency evidence | Closed within the exact local claim. Two independent evaluation, standing-policy, and ready-policy stores with two services were pending at the shared canonical transaction wrapper and converged to one job, reservation, transition, handoff, and request. This is not multi-process PostgreSQL proof. |

### Third-remediation re-review family

| Finding | Fourth re-review disposition |
|---|---|
| `AUTO030-TRR-001` expiry after application callback but before commit | Closed for the specified adapter boundary. Both required adapters run the predicate after the complete callback and before commit initiation. The exact delayed-after-callback probe reaches nine clock calls, rejects after expiry, and leaves the full attempted bundle absent. |
| `AUTO030-TRR-002` replay crosses expiry after final callback check | Closed. The adapter predicate covers the post-callback replay window, and the post-transaction sample prevents both replay and new results from being reported as current success after later expiry. The post-commit new-result path is explicit durable ambiguity. |

## Supplemental security and truth assessment

| Area | Observed result |
|---|---|
| Policy lifetime | Standing and ready policy operations serialize. Suspension/revocation preserve ceilings, revocation is terminal, reentrant write/close rejects without rolling back the guarded operation, and registered database use prevents early retirement. |
| Monotonic trusted time | Canonical exact UTC is required. Time cannot regress below the prior sample or initial authorization. Policy, reservation, handoff, job-authority, promotion-skew, and materialization-age boundaries fail closed. |
| Exact token binding | Token is private, opaque, single-acquire, unavailable after retirement, and provides hidden cloned receipt/policy inputs only. Forged, wrapper, accessor, Proxy, expanded-cap, resource-substitution, digest-substitution, and positive-authority extras cannot become persistence facts. |
| Global/project ready ceilings | Counts are read after the tenant lock and compared with hidden ready-policy ceilings. Competing local promotions serialize and one survives when constrained. |
| Resource capacity | Resource heads are locked, exact capacity is bound, expired reservations are removed from current usage, and over-capacity attempts reject. |
| Route/platform/capability/risk/cost | Promotion re-authenticates exact evaluation/materialization/policy lineage and enforces both standing and ready project ceilings before token minting; canonical persistence verifies the zero-effect job and exact bound route/resource values. |
| Atomicity and collision | Reservation, ready transition, transition evidence/outbox, dedicated handoff, and request completion occur in one transaction. Forced late handoff collision rolls back every newly attempted row. |
| Exact replay/idempotency | Exact request replay returns the same authenticated receipt only while current canonical evidence remains exact. Changed request reuse, expired reservation, missing/advanced handoff, transition drift, capacity-head drift, and job drift reject. |
| Generic ready isolation | Generic canonical transition rejects frontier work orders before any ready bundle mutation. |
| Generic delivery isolation | The handoff is in `control_ready_frontier_handoffs`, not `control_outbox`. Generic delivery sees only the ordinary `domain.transition` event. |
| Generic claim isolation | Generic job claim rejects a frontier-ready job before node lookup, attempt creation, or lease creation, including replay. |
| Projection truth | Receipt-only evidence is historical, never current pending. Safe projection omits owner evidence, authentication tags, objectives, source evidence, private locators, credentials, and handoff payloads. |
| UI authority | Server-rendered portfolio and project surfaces contain no button, form, input, select, textarea, action handler, or frontier mutation control. The only link is navigation to the read-only project view. |
| Effect clients | Focused structural search found no fetch, HTTPS, process execution, provider, GitHub, agent-message, handoff-consumer, or claim invocation in the AUTO-030 promotion/policy modules. No such client was invoked during review. |

## Commands and results

All commands used installed repository dependencies, repository reads, disposable PGlite/private SQLite state, and no network or external effect.

| Command or check | Result |
|---|---|
| `git rev-parse HEAD` | exact target `adf0804a52a13d544192afc90506c3e989254ffd` |
| `git branch --show-current` | exact branch `codex/cr11b-auto-030-ready-scheduler-handoff` |
| `git status --short --branch` before review | exact branch; clean working tree |
| `git merge-base 8acdbc... adf0804...` | exact feature base `8acdbcabe300660f062c202d7850537cb20373d6` |
| `git merge-base 9e43ea5... adf0804...` | exact rejected third remediation `9e43ea56471df1ee58dd8e94da04550ce6062063` |
| `shasum -a 256` over all four prior reports | all four matched their documented immutable SHA-256 values |
| `git diff --name-status 9e43ea5..adf0804` | fourth-remediation database, canonical-store, focused-test, contract/status/decision, and preserved third-report paths only |
| `git diff --check 9e43ea5..adf0804` | passed |
| working-tree `git diff --check` before report | passed |
| `node --import tsx --test tests/ready-frontier-promotion.test.ts` | 22/22 passed |
| `pnpm test:cr11b` | 66/66 passed |
| `pnpm check` | passed |
| `pnpm lint` | passed |
| Disposable PGlite adapter order/rollback probe via `node --import tsx --input-type=module` | failed pre-commit predicate rolled back to zero rows; success order was callback, predicate, transaction-promise resolution with one row |
| `pnpm test` | pretest 648/648; core 414/416 with two intentional platform skips and zero failures; posttest 52/52 |
| `pnpm test:build` | production build passed; rendered routes 2/2 passed |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | exit 0; `ready_for_runtime_check` |
| `pnpm db:verify` | blocked before migration execution by sandbox-denied `tsx` IPC socket, `listen EPERM`; no migration result claimed from this wrapper |
| `node --import tsx scripts/verify-migrations.ts` | all 27 migrations applied; 97 PostgreSQL tables verified |
| Static inspection of PostgreSQL and PGlite transaction adapters plus installed transaction-manager source | both run the predicate after application callback completion and before transaction-manager commit initiation |
| Source/UI search for effect clients and frontier action controls | none found in the AUTO-030 boundary; rendered tests also passed |

## Evidence limitations and negative authority

- This is effect-free repository evidence using PGlite, private SQLite fixtures, installed source, deterministic tests, and static inspection. It does not prove independent multi-process PostgreSQL convergence, live PostgreSQL failure recovery, hosted persistence, or physical database commit-timestamp alignment with the process clock.
- The PostgreSQL adapter ordering is source-verified but was not exercised against a live server. The successful migration verifier uses PGlite's PostgreSQL-compatible engine and proves schema application, not hosted PostgreSQL operations.
- Production standing/ready policy enrollment, owner-authentication ingress, production independent-review enrollment, policy/clock/key/checkpoint custody, current-state projection ingress, and cross-service ambiguity reconciliation remain absent.
- The dedicated internal handoff has no consumer. It grants no approval, schedule, attempt, claim, lease, dispatch, execution, provider contact, agent message, GitHub mutation, credential access, filesystem/network effect, or external effect.
- Repository ready-policy fixtures continue to state that production owner authentication and production independent review are unverified. This review accepts only the exact effect-free repository snapshot; it does not mutate those fixture facts or create production authority.
- No install, download, credential, native read, GitHub/network contact, message, timer, recurrence activation, DNS, Cloudflare, hosting, deployment, merge, commit, push, or production action occurred.
- This report does not authorize a merge, AUTO-040 execution, a handoff consumer, live scheduling, or any external effect. Those remain separate Codex/owner gates.

## Final disposition

Every recorded `REV`, `RR`, `SRR`, and `TRR` attack is closed for the exact effect-free local repository claim at `adf0804a52a13d544192afc90506c3e989254ffd`. The retained limitations are stated as limitations and are not promoted to production or multi-process proof.

ACCEPTED_EFFECT_FREE_REPOSITORY_SNAPSHOT
