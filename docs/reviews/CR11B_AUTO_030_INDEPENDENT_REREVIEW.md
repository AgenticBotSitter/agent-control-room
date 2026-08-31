# CR11B-AUTO-030 Independent Remediation Re-review

**Review mode:** independent-review, report-only, zero repair budget

**Review date:** 2026-08-30

## Exact review binding

- Immutable feature base: `8acdbcabe300660f062c202d7850537cb20373d6`
- Rejected candidate: `47e4000fb374eaefdfeb31e88db127505d3f11dc`
- Exact remediated target: `fd64e418882fb8ca8a044163b2c623f235e21976`
- Branch observed before review: `codex/cr11b-auto-030-ready-scheduler-handoff`
- Feature merge-base: `8acdbcabe300660f062c202d7850537cb20373d6`
- Remediation merge-base: `47e4000fb374eaefdfeb31e88db127505d3f11dc`
- Preserved first review SHA-256: `5a5f2d884c28ae5397caaf27b4573aa14f3ae93fe8936687d8251d7e328ae825`

The branch, `HEAD`, and target matched exactly, and `git status --short --branch` was clean before this report was created. This reviewer was assigned as a different agent from the first independent reviewer and the separate transaction auditor. The review made no GitHub or network call, changed no implementation or existing documentation, and performed no production, provider, agent, credential, deployment, scheduling, claim, lease, dispatch, execution, or external effect. Disposable SQLite/PGlite probes were removed after sanitized output was captured.

## Decision rationale

The remediation closes several important defects. Generic transition can no longer ready a frontier work order. The internal packet is in a dedicated one-state table that generic delivery cannot claim. Generic job claim rejects frontier-ready jobs before creating an attempt or lease. The intended service binds promotion request identity, and canonical replay inspects the exact completed request, pending handoff, transition, active reservation, resource head, and ready job after the tenant lock. Invalid canonical instants now reject. Transaction collision rollback, local policy write/close reentrancy, exact request convergence, and zero-control UI evidence also pass.

Those improvements do not establish the protected promotion invariant. The public canonical promotion method checks that policy guard objects are live and identity-bound, but all actual ceiling, resource, request, receipt, time, and handoff facts remain caller supplied. A caller holding legitimate live guards raised a policy's global ready ceiling from one to two and committed two ready jobs, reservations, and handoffs. Guard liveness is checked only before the database transaction; a fire-and-forget call released both guards, revoked the ready policy, and then committed after a deliberately delayed transaction resumed. Separately, the intended promotion service samples its trusted clock before it waits for queued policy guards; it committed a ready result after the ready policy and reservation had expired because it used the stale pre-queue sample. The operator projection also labels an expired historical receipt as a currently pending internal handoff.

These are repository-local authorization and truth failures on the exact remediated target. The complete repository gate being green does not override them.

## Findings

### AUTO030-RR-001 — High — Live policy guards do not bind the canonical port to policy ceilings or an authenticated receipt

**Observed implementation:** `ReadyFrontierCanonicalPromotionInput` carries caller-selected global/project ready ceilings, reservation resource, units, capacity, decision digest, request/receipt/job digests, times, and handoff payload at `src/persistence/canonical-store.ts:96-129`. `CanonicalStore.promoteReadyFrontierJobWithInternalHandoff` is a public method at line 473. Its guard check at lines 500-504 proves only policy ID, revision, and digest. The database ceiling checks at lines 606-633 then trust the separate caller-selected maximums and resource values. The private service helper derives correct values at `src/ready-frontier/v1/promotion-service.ts:26-53`, but nothing prevents another caller with legitimate active guards from calling the canonical method directly.

**Reproduced failure:** A disposable probe enrolled a valid ready policy with `maximumActiveReadyGlobal: 1`, promoted one job through the intended service, acquired legitimate live standing- and ready-policy guards, then called the public canonical method for a second valid proposed job while supplying `maximumActiveReadyGlobal: 2`. The call succeeded:

```json
{"policyMaximumActiveReadyGlobal":1,"suppliedMaximumActiveReadyGlobal":2,"bypassReturnedReady":"ready","counts":{"ready":"2","reservations":"2","handoffs":"2"}}
```

The same seam also accepts caller-selected resource facts and only a syntactically valid receipt digest; the canonical method does not prove those values came from the authenticated ready policy and parsed receipt.

**Contract impact:** Policy capabilities are identity proofs, not authorization capabilities for the exact operation. A current policy's ready and resource ceilings can be widened inside the supposedly policy-bound operation. This leaves the complete ready-policy transaction claim false even though generic `transition` itself is fixed.

**Required remediation:** Bind the capability to the complete authenticated ready-policy claims and exact parsed promotion operation, or make the policy stores own and await the only canonical invocation. The canonical layer must not accept independently caller-selected ceilings, resource capacity, request/receipt truth, or a merely subset-checked handoff payload. Add direct-port attacks with legitimate live guards for expanded global/project ceilings, altered resource key/units/capacity, substituted request/receipt digests, and a minimal or changed handoff. Every attack must leave all canonical counts unchanged.

### AUTO030-RR-002 — High — Guard retirement and policy revocation can occur before the database transaction commits

**Observed implementation:** Both guard authorizations occur before `this.db.transaction(...)` at `src/persistence/canonical-store.ts:500-517`; there is no liveness check or guard-owned operation registration inside the transaction. Standing-policy and ready-policy stores delete their WeakMap guard capability as soon as the callback promise settles at `src/ready-frontier/v1/standing-policy-store.ts:161-168` and `src/ready-frontier/v1/ready-policy-store.ts:186-193`. A callback can start the public async canonical method without returning or awaiting its promise. The synchronous pre-await portion passes both guard checks, the callback settles and retires the guards, and the database operation remains outstanding.

**Reproduced failure:** A disposable database wrapper paused the canonical transaction before its first query. Inside both current-policy callbacks, the probe started the canonical promotion but intentionally returned without awaiting it. Both callbacks completed and retired their guards. The ready policy was then terminally revoked. Releasing the database pause still committed the job, reservation, and handoff:

```json
{"latestReadyPolicyState":"revoked","promotionAfterGuardRetirement":"ready","counts":{"ready":"1","reservations":"1","handoffs":"1"}}
```

**Contract impact:** Policy can change between authorization and canonical commit. This reproduces the central stale-persistence defect behind `AUTO030-REV-002` through the replacement port, despite removal of the original exported persistence helper.

**Required remediation:** A guard cannot be considered active merely at async method entry. The policy-store operation must structurally own and await every registered canonical mutation before it can commit, retire the capability, or admit revision/suspension/revocation. Alternatively, remove the public port and execute the exact database mutation only inside a policy-store-owned operation. Add a forced-suspension test in which the callback attempts to release before the database operation settles; revocation must not overtake the operation, and a transaction that resumes after guard retirement must fail with zero mutation.

### AUTO030-RR-003 — High — Trusted time is sampled before the queued policy guards and can authorize an already-expired commit

**Observed implementation:** `ReadyFrontierPromotionServiceV1.promote` calls `clock.now()` at `src/ready-frontier/v1/promotion-service.ts:86-89`, then waits for the standing- and ready-policy guards at lines 91-93, and only afterward builds and persists the promotion using the earlier timestamp at lines 94-98. Neither current-policy store evaluates effective/expiry time itself. The canonical transaction uses caller `occurredAt` for reservation expiry and capacity queries and does not obtain a new trusted time.

**Reproduced failure:** A first standing-policy guard was held to queue the intended service call. The service sampled `2026-08-30T18:04:00.000Z`. While it waited, the injected clock advanced to `2026-08-30T18:20:00.000Z`, beyond the ready-policy expiry at `18:10` and reservation expiry at `18:09`. After the first guard released, the intended service committed with only one clock call:

```json
{"clockCalls":1,"capturedBeforeQueue":"2026-08-30T18:04:00.000Z","clockAtCommit":"2026-08-30T18:20:00.000Z","policyExpiredAt":"2026-08-30T18:10:00.000Z","reservationExpiredAt":"2026-08-30T18:09:00.000Z","promotionState":"ready_handoff_pending","counts":{"ready":"1","reservations":"1","handoffs":"1"}}
```

**Contract impact:** This is an intended-service temporal authorization bypass. The trusted clock protects caller history only when there is no queue or transaction delay; it does not prove current policy or live reservation truth at the mutation boundary.

**Required remediation:** Obtain trusted time only after both current-policy guards are acquired and bind a fresh trusted-time check to the canonical transaction immediately before mutation. The final check must prove promotion skew, both policy intervals, materialization/job authority, and reservation lifetime at the protected write boundary. Add queued-guard and delayed-transaction tests that advance the injected clock across each expiry; all must leave the job proposed with no request, transition, reservation, outbox, or handoff row.

### AUTO030-RR-004 — Medium — The safe projection reports an expired historical handoff as currently pending

**Observed implementation:** `projectReadyFrontierPromotionV1` validates `observedAt` and receipt authentication at `src/ready-frontier/v1/promotion-projection.ts:17-25`, but lines 32-33 derive `readyPromotionState`, ready-job count, and pending-handoff count solely from `receipts.length`. It does not compare `observedAt` with reservation/handoff expiry or accept current canonical reservation/handoff state.

**Reproduced failure:** A valid receipt whose handoff expired at `18:09` was projected at `18:10` while the ready policy remained active until `19:00`:

```json
{"observedAt":"2026-08-30T18:10:00.000Z","handoffExpiredAt":"2026-08-30T18:09:00.000Z","policyExpiresAt":"2026-08-30T19:00:00.000Z","readyPromotionState":"ready_handoff_pending","pendingInternalHandoffCount":1}
```

The frontier UI renders this field as “Internal handoff pending,” so the otherwise read-only UI can present stale current truth.

**Contract impact:** `AUTO030-REV-004` is improved at canonical replay but not closed for operator truth. An authenticated historical receipt is not proof of a current active reservation or pending handoff.

**Required remediation:** Build the projection from authenticated current canonical job, reservation, and dedicated-handoff state, or fail closed when such state is unavailable. At minimum, receipt-only projection must reject or distinguish expiration at `observedAt`; it must not call an expired result pending. Add expired, released, missing, altered, and future handoff/reservation cases to the projection and rendered UI tests.

### AUTO030-RR-005 — Low — The exact diff whitespace gate does not match the acceptance claim

**Observed evidence:** Both `git diff --check 8acdbcabe300660f062c202d7850537cb20373d6..fd64e418882fb8ca8a044163b2c623f235e21976` and the remediation-only equivalent exit nonzero on two trailing-space lines in the newly committed, intentionally preserved first review. `docs/CR11B_AUTO_030_ACCEPTANCE.md` and `docs/CR11B_AUTO_030_REMEDIATION.md` nevertheless say whitespace validation passed.

**Required remediation:** Do not rewrite the preserved first review. Correct the acceptance evidence to distinguish a clean working-tree diff from the exact immutable commit-range result, or define and document an intentional Markdown hard-break exception that the actual gate implements.

## Original finding closure assessment

| Original finding | Re-review result |
|---|---|
| `AUTO030-REV-001` generic ready transition | The exact generic `CanonicalStore.transition` attack now rejects and creates zero bundle rows. The broader claim that readiness is reachable only through policy-bound ceilings is still false because `AUTO030-RR-001` bypasses those ceilings through the public canonical promotion port. |
| `AUTO030-REV-002` stale persistence after revocation | Not closed. The original standalone helper is gone and forged/retired guards reject at method entry, but `AUTO030-RR-002` starts the replacement public port while guards are live and commits after both retire and ready policy is revoked. |
| `AUTO030-REV-003` conflicting request identity | Closed for the intended local service evidence. Simultaneous exact requests return one new result and one replay; same request ID with a different job fails; tenant lock plus canonical idempotency and dedicated-table uniqueness bind one lineage. Multi-process PostgreSQL convergence remains unproved. |
| `AUTO030-REV-004` stale replay | Canonical replay now rejects a non-active reservation and verifies pending handoff, transition, resource head, and ready-job digest. It remains incomplete because stale trusted time can create an already-expired result and the operator projection still presents an expired receipt as pending. |
| `AUTO030-REV-005` invalid observation time | Closed for the tested boundary. Non-canonical, offset-form, impossible, pre-effective, exact-expiry, and post-expiry observation times cannot produce an active policy label. |

## Supplemental attack matrix

| Area | Observed result |
|---|---|
| Policy change between authorization and commit | Failed: `AUTO030-RR-002` commits after guard retirement and terminal ready-policy revocation. |
| Forged, captured, and retired guards | Forged and already-retired guards fail at entry. A legitimately live guard can authorize widened values (`RR-001`) and can escape its callback through an outstanding promise (`RR-002`). |
| Caller time and invalid instants | Invalid and non-canonical instants reject. Caller history is checked against one injected sample, but the pre-queue sample becomes stale (`RR-003`). |
| Exact and conflicting request identity | Local Promise concurrency passes: exact retry converges and changed same-ID job reuse rejects. The requests are serialized by process-local SQLite policy queues before PGlite/PostgreSQL-compatible locking, so this is not multi-process PostgreSQL evidence. |
| Global/project ready and resource ceilings | Intended service and constrained-resource concurrency tests pass. The public canonical port accepts caller-expanded ceilings and resource facts (`RR-001`). |
| Generic transition | Passes: frontier proposed-to-ready rejects before any transition, reservation, handoff, or outbox row. |
| Generic delivery | Passes: `DeliveryStore.claimOutbox` sees only the ordinary `domain.transition` event; the dedicated internal handoff is not in `control_outbox`. |
| Generic job claim | Passes: frontier-ready jobs reject before node lookup, attempt creation, or lease creation, including the replay path. |
| Replay after changed state | The canonical replay query requires exact pending handoff, exact transition, active reservation, exact resource-head capacity, and exact ready job/digest. Focused evidence dynamically rejects expired reservation replay. There is no authorized handoff state transition or consumer in AUTO-030. |
| Transaction rollback and collision | Passes locally: the forced late handoff collision leaves no new request, ready transition, reservation, transition outbox, or handoff. |
| Same-instance policy write and close | Ready-policy focused test and an independent standing-policy probe both reject synchronous write/close while a guard is active and preserve the outer transaction. This does not cure an unawaited canonical mutation escaping the callback (`RR-002`). |
| Safe projection | Invalid time and private-field cases pass; current pending-state truth fails after handoff expiry (`RR-004`). |
| UI zero controls | Passes: the ready-frontier component has no button, form, input, select, textarea, action, or click handler, and server rendering contains no frontier action control. |
| Negative authority | The dedicated handoff has no consumer and its packet denies claim/lease, dispatch/execution, provider contact, agent message, GitHub mutation, and external effects. No external client or effect was found or invoked. |

## Commands and results

All runtime commands used installed repository dependencies and disposable local test state only.

| Command or exact check | Result |
|---|---|
| `git rev-parse HEAD` | `fd64e418882fb8ca8a044163b2c623f235e21976` |
| `git cat-file -t <feature-base>`, `git cat-file -t <rejected>`, `git cat-file -t <target>` | all resolved as `commit` |
| `git merge-base <feature-base> <target>` | exact feature base |
| `git merge-base <rejected> <target>` | exact rejected candidate |
| `git status --short --branch` before report | exact branch, clean tree |
| `git diff --name-status <feature-base>..<target>` | AUTO-030 feature, remediation, preserved review, UI, test, migration, and status/decision documentation paths only |
| `git diff --name-status <rejected>..<target>` | remediation paths only |
| `shasum -a 256 docs/reviews/CR11B_AUTO_030_INDEPENDENT_REVIEW.md` | exact documented SHA-256 `5a5f2d884c28ae5397caaf27b4573aa14f3ae93fe8936687d8251d7e328ae825` |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | exit 0, `ready_for_runtime_check` |
| `node --import tsx --test tests/ready-frontier-promotion.test.ts` | 13/13 passed |
| `pnpm test:cr11b` | 57/57 passed |
| `pnpm check` | passed |
| `pnpm lint` | passed |
| `pnpm db:verify` in the restricted sandbox | blocked before verification by `tsx` temporary IPC `listen EPERM`; no migration result claimed from this attempt |
| authorized local rerun of `pnpm db:verify` | 27 migrations applied; 97 PostgreSQL tables verified |
| `git diff --check <feature-base>..<target>` | nonzero: preserved first-review lines 3-4 contain trailing whitespace |
| `git diff --check <rejected>..<target>` | same two preserved-report lines; nonzero |
| `rg` for the old persistence export and shared handoff topic | neither remains |
| `rg` for ready-frontier component form/control handlers | none found |
| `node --import tsx --input-type=module` with disposable live-guard ceiling probe on stdin | unexpectedly succeeded; policy global max 1 produced 2 ready jobs, 2 reservations, and 2 handoffs |
| `node --import tsx --input-type=module` with delayed-transaction guard-retirement probe on stdin | unexpectedly succeeded after ready-policy revocation; 1 ready job, 1 reservation, and 1 handoff |
| `node --import tsx --input-type=module` with queued-service trusted-clock probe on stdin | unexpectedly succeeded after ready-policy and reservation expiry; clock called once before queue |
| `node --import tsx --input-type=module` with expired-receipt projection probe on stdin | unexpectedly returned `ready_handoff_pending` and pending count 1 after handoff expiry |
| `node --import tsx --input-type=module` with standing-policy reentrant write/close probe on stdin | write and close rejected while guarded; guard committed; later suspension succeeded |

## Documented but not independently rerun

The acceptance record documents 639/639 registered pretests, 414/416 core tests with two intentional platform skips and zero failures, 52/52 public post-tests, production build, 2/2 rendered routes, and localhost browser QA. This review independently reran the focused/combined/type/lint/migration gates above. It did not rerun the full repository lifecycle, build, or browser because four decisive security/truth failures were already reproduced and report-only review cannot repair them.

## Residual blockers and next gate

- The canonical promotion capability must bind exact policy and receipt claims instead of accepting caller-selected ceilings and resource facts.
- Policy guard lifetime must cover the actual database promise through completion, even when a callback tries to release early.
- Trusted time must be fresh at the protected write boundary, after policy queues and before commit-sensitive expiry checks.
- Current operator projection must not infer pending state from historical receipt count.
- Exact local SQLite/PGlite evidence does not prove multi-process PostgreSQL convergence, isolation, failure recovery, or cross-service ambiguity handling.
- Production policy ingress/custody, trusted production clock custody, owner authentication, real independent-review enrollment, handoff consumer, scheduler/jobber delivery, no-relay agent operation, real capacity, hosting, and every external effect remain unimplemented and unauthorized.

AUTO-030 is not accepted. AUTO-040 must not begin on this target. The initial negative report must remain unchanged. Architect-owned remediation requires another exact immutable target and a different independent re-review; no merge is authorized by this report.

REJECTED_REMEDIATION_FINDINGS
