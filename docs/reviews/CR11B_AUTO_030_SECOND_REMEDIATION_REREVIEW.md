# CR11B-AUTO-030 Second Remediation Independent Re-review

**Review mode:** independent-review, report-only, zero repair budget

**Review date:** 2026-08-30

**Disposition:** `REJECTED_SECOND_REMEDIATION_FINDINGS`

## Exact review binding

- Immutable feature base: `8acdbcabe300660f062c202d7850537cb20373d6`
- Original feature commit: `59c81987ac178ef59c073f523581f74b954962e5`
- Rejected first candidate: `47e4000fb374eaefdfeb31e88db127505d3f11dc`
- Preserved first review SHA-256: `5a5f2d884c28ae5397caaf27b4573aa14f3ae93fe8936687d8251d7e328ae825`
- Rejected first remediation: `fd64e418882fb8ca8a044163b2c623f235e21976`
- Preserved first remediation re-review SHA-256: `8f0bd318bbbf69a516f737da5cdd4367e4bd00cc6afcb0130c7c433e9e042652`
- Exact second-remediation target: `5b26a634516ca1a956edfeb67c7480343bf9104b`
- Branch observed before this report: `codex/cr11b-auto-030-ready-scheduler-handoff`

This reviewer independently inspected the exact second-remediation target and its authorization, policy-lifetime, lock, replay, projection, and trusted-time boundaries. The exact target and branch matched, and the working tree was clean before this report was created. Both earlier negative reports were read and their documented SHA-256 values were independently rechecked; neither report was changed.

The coordinating reviewer also supplied sanitized report-only results from a separate sibling transaction audit. Those results are identified as sibling-observed below. This report does not claim that this reviewer personally ran the sibling's probes or its complete focused, combined, type, or lint gates.

No implementation, prior report, contract, acceptance record, Git state, GitHub state, network resource, production system, provider, agent, credential, schedule, claim, lease, dispatch, execution, or external effect was changed or contacted. The only repository write is this report.

## Decision rationale

The second remediation materially improves the intended path. A privately minted opaque authorization is single-acquire, its registered database use outlives an intercepted fire-and-forget caller, both policy guards remain active until that use settles, trusted time is first sampled after the policy queues, and the canonical transaction resamples time after its tenant and resource locks. The previous generic transition, shared delivery, generic claim, request-lineage, expired-receipt, invalid-time, and reentrant-store defects are substantially improved.

The protected invariant is still not established. The canonical port validates an exact-operation authorization against a mutable caller-owned input, but continues to read that input after asynchronous database boundaries. A legitimate interceptor can therefore substitute caps, resource facts, actor attribution, or handoff payload fields after validation. The last trusted-clock check occurs before a multi-query canonical transition and before the handoff and request-completion writes. A separate sibling probe reproduced a commit after both policy and reservation expiry. Replay has the same missing end-boundary resample. Finally, receipt-only projection cannot observe an authenticated early reservation release, so it can still report a current pending handoff after current canonical state ceased to support that statement.

These are authorization and current-truth defects in the exact repository target. Green deterministic tests do not override them.

## Findings

### AUTO030-SRR-001 — High — Mutable canonical input can be substituted after exact-authorization validation

**Independently inspected implementation:** `CanonicalStore.promoteReadyFrontierJobWithInternalHandoff` acquires the one-use authorization and compares the caller-owned `input` with its hidden receipt and policy binding at `src/persistence/canonical-store.ts:472-557`. It does not create and exclusively use an exact local snapshot or derive the database values directly from the hidden binding. It then crosses asynchronous database boundaries and repeatedly reads the original `input` through the tenant/idempotency, ready-count, resource, reservation, transition, handoff, and completion operations at lines 582-724.

**Deterministic attack path:** An interceptor holding the legitimate operation call can invoke `original(input)`, allow the synchronous comparisons to pass, and mutate the same object while the first awaited query is pending. Later reads can then use increased global/project ready limits, a changed resource key/units/capacity, changed actor fields, or a changed handoff payload. The handoff insertion at lines 715-719 serializes `input.handoff.payload` without recomputing and comparing its digest at that final use. A post-validation change such as `permitsClaimOrLease: true` can therefore be written with the original safe `payloadDigest`. Similar changes can make the database reservation disagree with the authenticated receipt.

The current substitution test at `tests/ready-frontier-promotion.test.ts:247-281` modifies the input before `original(...)` enters canonical validation. It proves ordinary pre-validation substitutions reject, but does not exercise post-validation mutation, accessors, a Proxy, or a delayed database boundary.

**Contract impact:** Exact-operation authorization is reduced to a time-of-check assertion over mutable data. The committed ready, reservation, transition, and handoff facts are not guaranteed to be the facts that authorization approved.

**Required remediation and acceptance evidence:** Snapshot and validate the entire non-capability input exactly at method entry, or derive every persistence field solely from the immutable authorization binding, then use only that immutable local value. Add delayed-query hostile tests for post-validation mutation and hostile accessor/Proxy inputs. Prove the transaction rolls back with zero new request, transition, reservation, outbox, or handoff rows and that no mismatched payload/digest pair can be stored.

### AUTO030-SRR-002 — High — Trusted authorization can expire after the final clock check and before commit

**Independently inspected implementation:** The final new-promotion clock check is at `src/persistence/canonical-store.ts:709`. `transitionWith` then performs multiple awaited reads and writes through `src/persistence/canonical-store.ts:1147-1235`. The dedicated handoff and completed promotion-request writes follow at `src/persistence/canonical-store.ts:715-723`. No trusted-clock check occurs after the transition, immediately before the handoff/completion writes, or at the last callback boundary before transaction commit.

**Sibling-observed reproduction:** The separate report-only transaction audit advanced the trusted clock after the line-709 check while a transition query was deliberately delayed. After the query resumed, promotion still committed the ready job, reservation, dedicated handoff, and completed request even though the ready policy expired at `2026-08-30T18:10:00.000Z` and the reservation expired at `2026-08-30T18:09:00.000Z`.

**Contract impact:** The target can create current ready/handoff truth after the exact policy and reservation authorization ceased to be current. This directly contradicts the stated write-boundary freshness invariant.

**Required remediation and acceptance evidence:** Recheck the non-decreasing trusted clock after every delay-capable commit phase and at the final pre-commit boundary, including after `transitionWith` and before handoff/request completion. Any crossed policy, materialization, reservation, handoff, or job-authority expiry must roll back the complete transaction. Add a probe that advances time inside the transition and proves every new row remains absent.

### AUTO030-SRR-003 — Medium — Replay can cross expiry after its only trusted-time check

**Independently inspected implementation:** Replay samples current authorization time once at `src/persistence/canonical-store.ts:590`. It then awaits and verifies the handoff, transition, reservation/resource head, and ready job through line 650 without another trusted-time check before returning `replayed: true`.

**Failure path:** A replay that is current at line 590 can wait on any later row lock or query until the standing policy, ready policy, reservation, handoff, or job authority expires. The final return can then report the authenticated receipt as a successful current replay even though the authorization is no longer current. No mutation is required for this truth failure.

**Required remediation and acceptance evidence:** Resample and enforce the same non-decreasing current-state expiry checks after replay's last delay-capable read and immediately before returning. Add delayed handoff, transition, reservation, and job-query cases crossing each expiry boundary.

### AUTO030-SRR-004 — Medium — Receipt-only projection cannot see an authenticated early reservation release

**Independently inspected implementation:** `projectReadyFrontierPromotionV1` now rejects observation before promotion or at/after the receipt's declared reservation/handoff expiry. It still accepts only authenticated receipts and does not consume authenticated current canonical job, reservation, or dedicated-handoff state. It therefore cannot distinguish a still-pending bundle from one released, consumed, missing, or otherwise advanced before its declared expiry.

**Sibling-observed reproduction:** The separate report-only transaction audit created a genuine promotion, released its reservation at `2026-08-30T18:05:00.000Z`, and projected the receipt at `2026-08-30T18:06:00.000Z`. Projection returned `ready_handoff_pending` even though current reservation state no longer supported a pending ready handoff.

**Contract impact:** The first-remediation defect for a receipt after declared expiry is closed, but current operator truth remains unsupported when canonical state changes before that timestamp.

**Required remediation and acceptance evidence:** Project from an authenticated current-state cut containing the exact ready job, active reservation/resource head, and pending dedicated handoff, or label receipt-only evidence explicitly historical and never current-pending. Test release, expiry, missing rows, altered rows, consumed/non-pending handoff state, and state change racing observation.

### AUTO030-SRR-005 — Low — Local Promise concurrency does not prove canonical transaction convergence

**Independently inspected evidence:** The simultaneous exact-request test at `tests/ready-frontier-promotion.test.ts:400-421` submits two calls through one service and the same policy stores. Standing-policy `withCurrentPolicy` queues on `guardTail` at `src/ready-frontier/v1/standing-policy-store.ts:145-168`; the ready-policy store has the same queue at `src/ready-frontier/v1/ready-policy-store.ts:169-193`. The requests therefore serialize before they can contend concurrently at the tenant/idempotency locks.

**Evidence impact:** The test proves same-process queued convergence and changed request reuse rejection. It is not evidence of two concurrent canonical transactions or multi-process PostgreSQL behavior. The acceptance documents already retain multi-process PostgreSQL as unproved, so this is an evidence limitation rather than an additional authorization bypass.

**Required evidence:** When the block claims database-level convergence, use distinct service/store instances and genuinely independent PostgreSQL transactions, or keep the claim explicitly limited to serialized local repository evidence.

## Prior finding closure assessment

| Prior finding | Second re-review result |
|---|---|
| `AUTO030-REV-001` generic proposed-to-ready bypass | Holds for the inspected generic path: frontier work orders require the protected operation. `SRR-001` is a different post-validation substitution inside that operation. |
| `AUTO030-REV-002` stale exported persistence | The standalone helper remains removed. The opaque authorization and registered use close the previously reproduced fire-and-forget retirement seam. `SRR-002` shows that authorization freshness still ends too early inside the transaction. |
| `AUTO030-REV-003` conflicting request identity | Intended local lineage binding and changed same-ID rejection hold. Actual concurrent PostgreSQL convergence remains unproved as recorded in `SRR-005`. |
| `AUTO030-REV-004` stale replay | Exact lineage and current row state checks hold at the sampled point. `SRR-003` leaves a later time-of-return gap. |
| `AUTO030-REV-005` invalid observation time | Closed for canonical instant parsing. |
| `AUTO030-RR-001` caller-expanded canonical facts | Not fully closed. Immutable hidden facts are compared, but `SRR-001` substitutes the mutable caller input after that comparison. |
| `AUTO030-RR-002` database use outlives guards | Closed for the tested unawaited-call path: use registration is synchronous and policy/authorization retirement awaits the database promise. |
| `AUTO030-RR-003` pre-queue trusted time | Clock sampling now starts inside both policy guards and resamples after important locks. `SRR-002` leaves the final transition-to-commit window unchecked. |
| `AUTO030-RR-004` expired receipt projects pending | Closed for observation at or after declared receipt expiry. `SRR-004` remains for early canonical release/state change. |
| `AUTO030-RR-005` whitespace evidence | Closed for the second-remediation range; prior immutable Markdown hard breaks remain documented rather than rewritten. |

## Areas that hold on this target

Observed from inspected implementation, current tests, and the sanitized sibling transaction results:

- Generic transition cannot directly ready a frontier work order.
- The dedicated internal handoff is not visible to generic `control_outbox` delivery.
- Generic claim rejects a frontier-ready job before creating an attempt or lease.
- Request idempotency binds the intended local request, receipt, job, reservation, and handoff lineage; changed reuse rejects.
- Tenant, ready-count, job, and resource-head lock ordering is structurally coherent for the intended transaction.
- Late handoff collision rolls the intended local atomic bundle back.
- The opaque authorization is privately minted, single-acquire, and unavailable after retirement.
- Registered authorization use keeps both policy guards alive through the actual canonical database promise, including the tested unawaited-call interceptor.
- Handoff and receipt negative-authority fields deny approval, claim/lease, dispatch/execution, provider contact, agent message, GitHub mutation, credentials, and external effects.
- No internal-handoff consumer or operator action control exists in AUTO-030.

These positive properties do not compensate for `SRR-001` through `SRR-004`.

## Commands and evidence provenance

### Independently run by this reviewer

| Command or check | Result |
|---|---|
| `git rev-parse HEAD` | exact target `5b26a634516ca1a956edfeb67c7480343bf9104b` |
| `git branch --show-current` | `codex/cr11b-auto-030-ready-scheduler-handoff` |
| `git status --short` before report | clean |
| `shasum -a 256` over both prior reports | exact documented hashes `5a5f2d...ae825` and `8f0bd318...42652` |
| `git diff --check fd64e418882fb8ca8a044163b2c623f235e21976..5b26a634516ca1a956edfeb67c7480343bf9104b` | passed |
| `node --import tsx --test --test-name-pattern='exact-operation authorization\|unawaited canonical\|trusted time is sampled\|simultaneous exact requests' tests/ready-frontier-promotion.test.ts` | 4/4 selected tests passed |
| Line-by-line source inspection of promotion service, canonical store, both policy stores, projection, promotion builder, and focused tests | produced `SRR-001`, `SRR-003`, and `SRR-005`; confirmed the structural window reproduced by sibling `SRR-002` and the projection limitation in `SRR-004` |

### Sanitized report-only results received from the coordinating reviewer and sibling audit

The following are recorded as received evidence, not as commands personally run by this reviewer:

| Evidence | Received result |
|---|---|
| Complete AUTO-030 focused gate | 16/16 passed |
| Combined CR11B gate | 60/60 passed |
| `pnpm check` | passed |
| `pnpm lint` | passed |
| Delayed-transition trusted-clock probe | unexpectedly committed ready job, reservation, handoff, and request after policy and reservation expiry |
| Genuine promotion followed by early reservation release and later projection | unexpectedly returned `ready_handoff_pending` |
| Transaction-boundary assessment | generic transition/delivery/claim, request lineage/replay checks, structural resource/ready locks, collision rollback, negative authority, and zero controls held locally |

The complete local test gates demonstrate regression stability only. They do not cover the post-validation mutation, final transition-to-commit expiry, replay end-time, or authenticated early-release projection attacks above. Multi-process PostgreSQL behavior remains unproved.

## Residual blockers and next gate

AUTO-030 is not accepted on `5b26a634516ca1a956edfeb67c7480343bf9104b`. AUTO-040 must not begin from this target.

Architect-owned remediation must make committed fields immutable or binding-derived, keep trusted authorization current through the final commit-sensitive phase, close replay's end-time window, and replace receipt-only current-pending projection with authenticated current state or an explicitly historical label. Each repair requires hostile regression coverage and another different-agent review of a new exact immutable target.

Both prior negative reports must remain byte-for-byte unchanged. This report authorizes no implementation, merge, Git/GitHub mutation, production policy, consumer, schedule, claim, lease, dispatch, execution, provider/agent contact, credential access, network operation, deployment, or external effect.

REJECTED_SECOND_REMEDIATION_FINDINGS
