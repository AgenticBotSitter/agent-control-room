# CR11B-AUTO-030 Independent Security Review

**Review mode:** independent-review, report-only, zero repair budget  
**Review date:** 2026-08-30  
**Disposition:** `REJECTED_FINDINGS_REQUIRE_REMEDIATION`

## Exact review target

- Corrected immutable base: `8acdbcabe300660f062c202d7850537cb20373d6`
- Exact candidate/head: `47e4000fb374eaefdfeb31e88db127505d3f11dc`
- Branch: `codex/cr11b-auto-030-ready-scheduler-handoff`
- Merge-base: `8acdbcabe300660f062c202d7850537cb20373d6`
- GitHub handoff identified by the architect: PR #166. This review made no GitHub or network call.

The initial packet named a different full base hash that did not resolve. Review stopped without changes, the architect issued the corrected base above, and all preflight checks were repeated before substantive review. At resumed preflight, `HEAD` and the branch matched exactly and `git status --short --branch` showed no working-tree change.

The base-to-head comparison contains only the declared AUTO-030 policy, promotion, canonical-store, fixture/projection, UI, test, package-script, and documentation paths. No unrelated candidate path was observed.

## Disposition rationale

The intended service path has useful protection: it authenticates the evaluation and materialization, nests the standing- and ready-policy guards across the canonical transaction, serializes ready counts on a tenant row, serializes resource capacity on a resource head, and commits the reservation, ready transition, transition outbox, and internal-handoff outbox atomically. The fixture also states production owner authentication and production independent review are false, and the UI has no action controls.

Those properties do not establish the required invariant, however. A public canonical transition can ready the exact frontier job without either policy, a reservation, or a handoff. A second exported persistence seam can commit a previously built receipt after the ready policy is revoked. Promotion request identity is not durably bound, so one request ID can create two separate ready jobs, reservations, and handoffs. Exact replay accepts an expired reservation and does not inspect current outbox status. The safe projection also reports an active policy when its observation time is invalid. These are independently reproduced repository-local failures of the acceptance contract, not merely missing production evidence.

## Findings

### AUTO030-REV-001 — High — Generic canonical transition bypasses the complete ready-policy transaction

**Observed implementation:** `CanonicalStore.transition` remains a public mutation entry point at `src/persistence/canonical-store.ts:602-604`. In `transitionWith`, a non-coordinated job transition is rejected only when the current job state is not `proposed` (`src/persistence/canonical-store.ts:1042-1047`). Therefore `proposed -> ready` is explicitly allowed. The code takes the tenant lock and checks expiry/dependencies (`src/persistence/canonical-store.ts:1025-1058`) but does not require the standing policy, ready policy, authenticated materialization, ready ceilings, resource reservation, or internal handoff.

**Observed exploit/failure path:** A disposable in-memory PGlite probe created an exact AUTO-020 frontier job through `ReadyFrontierMaterializationServiceV1`, enrolled no ready policy, and called `canonical.transition(...)` with `toState: "ready"`. It returned:

```json
{"state":"ready","replayed":false,"counts":{"ready":"1","reservations":"0","handoffs":"0"}}
```

**Violated requirement:** The acceptance target requires the exact frontier job to become ready only while both policies are current, with the transition, reservation, and handoff committed together or not at all. The atomic-result contract at `docs/CR11B_AUTO_030_READY_PROMOTION_AND_HANDOFF_CONTRACT.md:34-47` is bypassed completely.

**Required remediation and acceptance test:** Make every `ready-frontier-work-order/v1` proposed-to-ready transition reachable only through the policy-bound coordinated operation; a public generic transition must fail for that job class. Add a hostile test that materializes a frontier job, omits or revokes the ready policy, invokes every generic canonical transition path, and proves the job remains proposed with zero reservation, ready transition event, domain transition outbox, and handoff outbox rows. Repeat with global/project ceilings already exhausted.

### AUTO030-REV-002 — High — Exported persistence bypass commits after ready-policy revocation

**Observed implementation:** The guarded service nests `withCurrentPolicy` calls at `src/ready-frontier/v1/promotion-service.ts:46-53`, but `persistReadyFrontierPromotionV1` is independently exported at `src/ready-frontier/v1/promotion.ts:232-258`. That function authenticates the supplied historical receipt and supplied historical ready policy, then calls the canonical mutation directly. It does not consult either policy store or prove that either supplied revision is still current.

**Observed exploit/failure path:** A disposable probe built a valid promotion receipt while the ready policy was active, recorded a terminal revocation as revision 2, then invoked the exported persistence function with the old authenticated revision 1. It returned:

```json
{"latestPolicyState":"revoked","persistedState":"ready","replayed":false}
```

**Violated requirement:** Policy revision, suspension, and revocation must serialize entirely before or after promotion, and stale or superseded policy truth must fail before mutation (`docs/CR11B_AUTO_030_READY_PROMOTION_AND_HANDOFF_CONTRACT.md:26-32`). The guarantee currently exists only by caller convention around one service method.

**Required remediation and acceptance test:** Remove or cryptographically/database-bind every unguarded persistence entry point so a caller cannot supply an old policy object as proof of current state. Add a hostile test that builds a receipt, then suspends, revokes, and revises each parent policy before invoking every exported mutation seam. Each call must fail with the canonical job and all reservation/transition/outbox counts unchanged.

### AUTO030-REV-003 — High — One promotion request ID can create multiple ready jobs and handoffs

**Observed implementation:** The request schema includes `requestId`, but no promotion-request ledger or uniqueness binding is written. Stable reservation/handoff identity is derived from tenant, job, materialization, and policy digests at `src/ready-frontier/v1/promotion.ts:137-165`; canonical idempotency is subsequently derived from receipt and packet digests at `src/ready-frontier/v1/promotion.ts:242-255`. A reused request ID attached to a different eligible job therefore produces unrelated canonical idempotency keys.

**Observed exploit/failure path:** Two eligible materializations in different projects were submitted through the guarded promotion service with the fixture's same default request ID. Both calls succeeded:

```json
{"sameRequestId":true,"firstJob":"job:frontier:8b69b7d57d45886079114a461dbf2a3c","secondJob":"job:frontier:a32d430df2ffc1ea8b29ca5df5b19437","counts":{"ready":"2","reservations":"2","handoffs":"2"}}
```

**Violated requirement:** The independent-review gate explicitly asks whether a duplicate or conflicting request can create multiple ready jobs, reservations, or handoffs. Exact replay is required to be inert; conflicting identity must not be accepted as unrelated work.

**Required remediation and acceptance test:** Persist a tenant-scoped promotion-request identity bound to the exact canonical request digest, materialization receipt, job, and resulting receipt. Exact replay must return the original result and any changed binding under the same request ID must fail in the same transaction before mutation. Add same-ID/different-job, same-ID/different-materialization, same-ID/different-policy, and concurrent same-ID hostile tests.

### AUTO030-REV-004 — Medium — Exact replay accepts expired reservation and non-pending handoff state is not checked

**Observed implementation:** The replay query at `src/persistence/canonical-store.ts:515-527` verifies reservation lineage and timestamps but does not select or require reservation `state = 'active'`, and it returns replay success at line 528. The preceding handoff query at lines 488-497 fixes the topic and checks identity/payload but does not select or require outbox `status = 'pending'`.

**Observed exploit/failure path:** After a valid promotion, the accepted CR6 `ResourceReservationStore.reconcile` path expired the reservation at a time after its declared expiry. Replaying the original envelope still succeeded:

```json
{"reservationState":"expired","replayAccepted":true,"receiptState":"ready_handoff_pending"}
```

This means the returned authenticated receipt asserts an active reservation and pending ready handoff after canonical state no longer supports that assertion. Inspection also shows the same ambiguity for processing, delivered, failed, or dead-letter outbox status.

**Violated requirement:** Exact replay must verify the existing reservation and handoff, and ambiguous replay must not report success. The acceptance record specifically requires review of reservation expiry and a ready job without its reservation/handoff.

**Required remediation and acceptance test:** Define and enforce the post-expiry/release state machine. At minimum, replay must not return `ready_handoff_pending` unless the reservation is active and the handoff is still in its permitted pending state; it should also bind the resource-head capacity. Add tests for reconciled expiry, explicit release, handoff processing/delivered/failed/dead-letter states, and expiry racing exact replay. Prove the projection and any future consumer fail closed on those states.

### AUTO030-REV-005 — Medium — Invalid observation time is projected as an active repository policy

**Observed implementation:** `projectReadyFrontierPromotionV1` accepts `observedAt` as an unchecked string. `Date.parse` is used at `src/ready-frontier/v1/promotion-projection.ts:25-27`; when it returns `NaN`, both range comparisons are false, so an active policy is labeled `repository_fixture_active`.

**Observed exploit/failure path:** A pure repository probe called the projection with `observedAt: "not-an-instant"` and received:

```json
{"observedAt":"not-an-instant","readyPolicyState":"repository_fixture_active"}
```

**Violated requirement:** The operator projection must be a safe, honest view of policy truth. Unknown observation time cannot prove effective/expiry state.

**Required remediation and acceptance test:** Parse `observedAt` through the exact canonical time schema before any comparison and reject invalid/non-canonical values. Add invalid, offset-form, impossible, before-effective, exact-expiry, and after-expiry cases; none may produce an active label unless a canonical observation instant is inside the policy interval.

## Positive evidence and requested-area assessment

### Observed

- Exact base, head, merge-base, branch, and clean pre-review tree were verified locally.
- Ready-policy records are strict, HMAC-authenticated, append-only, checkpointed against rollback, monotonic per policy ID, suspendable, and terminally revocable.
- The intended service path holds the standing-policy SQLite transaction and then the ready-policy SQLite transaction through the canonical PGlite/PostgreSQL-compatible transaction.
- The intended canonical path locks the tenant before counting ready jobs and locks the resource head before expiring reservations and summing active units. Generic new ready transitions take the same tenant lock, which serializes the count read; finding REV-001 is an authorization/ceiling bypass, not a missed lock.
- A forced handoff-row collision rolls back the reservation, job transition, transition evidence, and newly attempted outbox writes in the focused test.
- Promotion receipts and handoff packets are digest-bound and HMAC-authenticated. Fixture fields explicitly state repository simulation, repository fixture evidence, no production owner authentication, and no production independent review.
- No AUTO-030 source consumer for `ready-frontier.scheduler-jobber-handoff` was found. The packet and receipt literals deny claim/lease, dispatch/execution, provider contact, agent messages, GitHub mutation, and external effects.
- The rendered React source contains no promotion, approval, schedule, claim, lease, dispatch, message, or execution control. The focused server-render tests also reject form controls.

### Documented, not independently re-observed in this review

- The acceptance record documents 634/634 registered pretests, 414/416 core tests with two intentional platform skips, 52/52 post-tests, production build and 2/2 rendered routes, stage-zero readiness, 26 migrations/96 tables, and localhost browser QA. This review did not rerun those broader gates because the packet required the focused/local minimum and the reproduced security failures already determine rejection.

### Inferred from inspected implementation

- Separate SQLite `BEGIN IMMEDIATE` guards serialize policy revision/suspension/revocation against the intended service callback. A database or process failure may fail closed, but no cross-service production custody claim is supported.
- The tenant/resource locking order protects intended-path global/project count and resource-capacity concurrency. This does not compensate for the alternate mutation seams in REV-001 and REV-002.
- Transaction semantics make insertion collision rollback credible for the tested local PGlite/PostgreSQL-compatible boundary. Hosted or distributed ambiguity is outside this candidate.

### Blocked or outside authorized evidence

- Production policy ingress/custody, production owner authentication, production independent-review evidence, real capacity, an outbox consumer, scheduler/jobber delivery, no-relay agent operation, provider/agent contact, GitHub mutation, credentials, hosting, deployment, and every external effect were neither authorized nor attempted.
- No claim about live PostgreSQL isolation, multi-process production failover, or cross-service reconciliation is accepted from repository fixtures alone.

### Unsupported candidate claims

- “A frontier job becomes ready only while both policies are current” is unsupported because REV-001 and REV-002 bypass the guarded service.
- “Exact replay is inert for duplicate or conflicting requests” is unsupported because REV-003 permits one request ID to create multiple lineages.
- “Exact replay verifies the existing reservation and handoff” is unsupported for expired/released reservation state and non-pending outbox state because of REV-004.
- “The safe projection reports current ready-policy state” is unsupported for invalid observation time because of REV-005.

## Commands and results

All commands ran with installed dependencies, repository reads, disposable local/test SQLite, and no network or external effect.

| Command/check | Result |
|---|---|
| `git rev-parse 8acdbcabe300660f062c202d7850537cb20373d6^{commit}` | exact corrected base resolved |
| `git rev-parse 47e4000fb374eaefdfeb31e88db127505d3f11dc^{commit}` | exact candidate resolved |
| `git merge-base <base> <head>` | exact corrected base |
| `git status --short --branch` before review | exact branch, clean tree |
| `git diff --name-status <base>..<head>` | declared AUTO-030 paths only |
| `pnpm test:cr11b` | 52/52 passed |
| `node --import tsx --test tests/ready-frontier-promotion.test.ts` | 8/8 passed |
| `pnpm check` | passed |
| `pnpm lint` | passed |
| `git diff --check <base>..<head>` | passed |
| Disposable generic-transition bypass probe | succeeded unexpectedly; 1 ready, 0 reservations, 0 handoffs |
| Disposable revoked-policy direct-persist probe | succeeded unexpectedly after terminal revocation |
| Disposable same-request/different-job probe | both promotions succeeded; 2 ready, 2 reservations, 2 handoffs |
| Disposable reservation-expiry replay probe | replay succeeded unexpectedly with reservation state `expired` |
| Pure invalid-observation projection probe | returned `repository_fixture_active` unexpectedly |

## Residual blockers and next gate

AUTO-030 is not accepted. AUTO-040 must not begin on this candidate. Remediation must preserve the report and add hostile regression coverage for every finding. Because findings affect architecture-owned authorization, idempotency, and canonical transaction boundaries, repairs require architect ownership followed by a different independent re-review of the exact remediated head. No merge is authorized by this report.
