# CR11B-AUTO-030 Third Remediation Independent Re-review

**Review mode:** independent-review, report-only, zero repair budget

**Review date:** 2026-08-30

**Disposition:** `REJECTED_THIRD_REMEDIATION_FINDINGS`

## Exact review binding

- Immutable feature base: `8acdbcabe300660f062c202d7850537cb20373d6`
- Original feature commit: `59c81987ac178ef59c073f523581f74b954962e5`
- Rejected first candidate: `47e4000fb374eaefdfeb31e88db127505d3f11dc`
- Rejected first remediation: `fd64e418882fb8ca8a044163b2c623f235e21976`
- Rejected second remediation: `5b26a634516ca1a956edfeb67c7480343bf9104b`
- Exact third-remediation target: `9e43ea56471df1ee58dd8e94da04550ce6062063`
- Branch observed before this report: `codex/cr11b-auto-030-ready-scheduler-handoff`
- Preserved first review SHA-256: `5a5f2d884c28ae5397caaf27b4573aa14f3ae93fe8936687d8251d7e328ae825`
- Preserved first-remediation re-review SHA-256: `8f0bd318bbbf69a516f737da5cdd4367e4bd00cc6afcb0130c7c433e9e042652`
- Preserved second-remediation re-review SHA-256: `db6e7986b97a877db77cc235a8e9d83b9723ef7a5a4aacdc4fe12805cd2897b7`

The exact target, branch, and feature merge-base matched, and the repository working tree was clean before this report was created. The feature-base comparison contains the declared AUTO-030 implementation, migration, UI, tests, acceptance/remediation records, and all three preserved negative reports. Every prior report hash was independently rechecked before review; none of those reports was changed.

This reviewer inspected the exact target and independently ran its focused, combined, type, lint, and complete repository tests. A separately authorized report-only sub-auditor independently inspected the opaque-token and trusted-time boundaries and reached the same timing result. Disposable local PGlite and private SQLite state was removed after sanitized counts were captured.

No implementation, contract, acceptance record, prior report, Git state, GitHub state, network resource, provider, agent, credential, native facility, deployment, schedule, claim, lease, dispatch, execution, or external effect was changed or contacted. The only repository write is this report.

## Decision rationale

The third remediation closes most of the second-remediation findings. The canonical port now accepts only the opaque single-acquire token and derives its entire write bundle from hidden cloned authenticated bindings. Caller-owned accessors, Proxies, expanded ceilings, resource substitutions, changed digests, and positive handoff authority cannot become persistence input. Explicit policy revision, suspension, or revocation remains excluded until the registered database promise settles. Expiry during the transition, after handoff insertion, after promotion-request completion, and during replay evidence reads is rechecked and rejected inside the canonical callback. Receipt-only projection is now explicitly historical. Separate policy stores genuinely reach the claimed local canonical transaction entry boundary before converging to one result.

The central write-time invariant is still not established. The last new-promotion clock check occurs inside the application transaction callback. The database adapter commits only after that callback returns. A deterministic wrapper around the real PGlite transaction advanced trusted time beyond policy and reservation expiry after the canonical callback returned but before the underlying database transaction committed. The operation still committed the ready job, active reservation, transition, dedicated handoff, and completed promotion request. Exact replay has the equivalent return boundary: it can cross expiry after its last check and still return `replayed: true`.

ADR-102 accurately discloses that clock validity is proved only through the final transaction callback rather than an external database commit timestamp. That disclosure does not satisfy the stronger candidate and contract claims that the job becomes ready only while both policies remain current and that any crossed authorization expiry rolls back the atomic bundle. Green deterministic gates do not override the reproduced gap.

## Findings

### AUTO030-TRR-001 — High — Authorization can expire after the final callback check but before database commit

**Observed implementation:** New promotion performs its last trusted-clock check at `src/persistence/canonical-store.ts:712`, returns from the callback at line 713, and only then lets `DatabaseClient.transaction(...)` complete. Both production PostgreSQL and local PGlite adapters delegate callback completion to their transaction manager, which owns the subsequent commit at `src/persistence/database.ts:36-38` and `src/persistence/database.ts:48-50`. There is no database-owned commit-time authorization predicate or post-callback pre-commit hook visible to `CanonicalStore`.

**Independently reproduced failure:** A disposable `DatabaseClient` wrapper called the real PGlite transaction and awaited the canonical operation. After that operation returned—therefore after the line-712 check and all request-completion writes—the wrapper held the underlying transaction callback open. Trusted time was advanced from `2026-08-30T18:04:00.000Z` to `2026-08-30T18:20:00.000Z`, beyond the ready-policy expiry at `18:10`. The wrapper then returned to PGlite, which committed. Promotion resolved with `replayed: false`; the database contained exactly one ready job, reservation, transition, dedicated handoff, and completed request. Clock-call count remained eight across the held boundary, proving no later check ran.

Sanitized result:

```json
{"policyExpiresAt":"2026-08-30T18:10:00.000Z","promotion":{"replayed":false,"callsAtFinalCallback":8,"callsAfterReturn":8,"stateAfterExpiredCommit":{"ready":"1","reservations":"1","transitions":"1","handoffs":"1","requests":"1"}}}
```

**Contract impact:** The canonical state becomes visible only when the database transaction commits. On this path, visibility begins after the authorization, ready policy, reservation, handoff, and job-authority interval is no longer current. This contradicts `docs/CR11B_AUTO_030_ACCEPTANCE.md:7-9` and the unqualified rollback claim at `docs/CR11B_AUTO_030_READY_PROMOTION_AND_HANDOFF_CONTRACT.md:47`. ADR-102's explicit callback-only trade-off at `docs/CR3_DECISION_LOG.md:1230` is honest residual documentation, but it also confirms that the requested commit-time proof is absent.

**Required remediation and evidence:** Make the transaction owner enforce the trusted authorization deadline at an actual commit-sensitive boundary that can still abort the transaction, or narrow every current-at-commit claim and design an honest non-current/ambiguous result that does not leave a newly visible ready bundle presented as current. Add the exact delayed-after-callback probe and require zero request, transition, ready job, reservation, outbox, and handoff rows after expiry. An application check that runs before another unbounded commit delay is not evidence of commit-time validity.

### AUTO030-TRR-002 — Medium — Replay can cross expiry after its final check and still return success

**Observed implementation:** Replay performs its final trusted-clock check at `src/persistence/canonical-store.ts:635`, returns `replayed: true` at line 636, and then waits for the transaction manager to finish. No trusted-time check occurs after transaction completion or at the service return boundary.

**Independently reproduced failure:** After creating one genuine bundle, the same disposable wrapper held the replay transaction after the canonical callback returned. Trusted time again advanced from `18:04` to `18:20` before transaction completion. Replay still resolved with `replayed: true` after ready-policy and reservation expiry.

**Contract impact:** Replay adds no second mutation, but it reports successful current replay after authorization ceased to be current. This is the remaining end-boundary portion of `AUTO030-SRR-003` and prevents the result from being used as current ready/handoff truth.

**Required remediation and evidence:** Recheck trusted time at the latest transaction/service return boundary available and define expired or uncertain completion as a non-success result. Add a delayed transaction-return replay test that crosses every relevant expiry and cannot resolve `replayed: true` afterward.

## Prior finding closure assessment

| Prior finding | Third re-review result |
|---|---|
| `AUTO030-REV-001` generic proposed-to-ready bypass | Closed. Generic transition rejects the frontier work-order class before mutation. |
| `AUTO030-REV-002` stale exported persistence after revocation | Closed for explicit policy revision/suspension/revocation. The standalone persistence seam remains removed, the authorization is private and registered, and policy change cannot overtake the database promise. `TRR-001` is a remaining time-expiry-at-commit failure. |
| `AUTO030-REV-003` conflicting request identity | Closed for the claimed local evidence. Exact duplicate requests converge; changed same-ID lineage rejects; one request record and bundle survive. Multi-process PostgreSQL remains explicitly unproved. |
| `AUTO030-REV-004` stale replay state | The handoff, transition, reservation/resource head, and ready job are all checked. `TRR-002` leaves current-time success false after the last check. |
| `AUTO030-REV-005` invalid observation time | Closed. Canonical UTC instants are required before projection. |
| `AUTO030-RR-001` caller-expanded canonical facts | Closed structurally. The canonical port receives only the opaque token and derives all write facts from hidden clones. |
| `AUTO030-RR-002` database use outlives guards | Closed. Single acquisition registers use synchronously and both policy operations remain active until the actual database promise settles. |
| `AUTO030-RR-003` pre-queue trusted time | Queue sampling and every in-callback write phase are closed. Commit-time validity remains incomplete because of `TRR-001`. |
| `AUTO030-RR-004` expired receipt projects pending | Closed by explicitly historical projection with zero current ready and pending counts. |
| `AUTO030-RR-005` whitespace evidence | Closed for the third-remediation range. Prior immutable Markdown hard breaks remain honestly documented rather than rewritten. |
| `AUTO030-SRR-001` mutable canonical input | Closed. No caller persistence-fact object enters the canonical method. |
| `AUTO030-SRR-002` expiry during transition-to-commit | Closed during transition, handoff, and request completion, but not after the final callback check and before commit; see `TRR-001`. |
| `AUTO030-SRR-003` replay end-time crossing | Closed during the evidence reads, but not after the final callback check and before transaction/service return; see `TRR-002`. |
| `AUTO030-SRR-004` receipt-only current-pending projection | Closed. The projection reports authenticated history only and never current pending state. |
| `AUTO030-SRR-005` same-store concurrency evidence | Closed within the exact local claim. Separate stores and services overlap at the canonical transaction entry wrapper and converge. The test and documentation do not claim active simultaneous PostgreSQL sessions or multi-process proof. |

## Areas that hold on this target

Observed from exact source inspection, focused and complete tests, and disposable repository-local probes:

- Opaque authorization is privately minted, single-acquire, registered, and unavailable after retirement.
- The canonical method derives tenant, job, request, policy, ceiling, resource, transition, reservation, actor, and handoff values only from hidden cloned authenticated records.
- Hostile accessor, Proxy, wrapper, and mutable extra-field inputs cannot influence canonical writes.
- Explicit policy revision, suspension, revocation, and store close cannot overtake an active registered database operation.
- Expiry detected during the ready transition, after handoff insertion, or after request completion throws inside the transaction and rolls back the complete attempted bundle.
- Generic transition cannot ready the frontier job; generic delivery sees only the ordinary domain-transition event; generic claim rejects before attempt or lease creation.
- Exact request replay binds the request, receipt, job, reservation, transition, and handoff; changed reuse rejects.
- Tenant ready counts and resource heads serialize the tested local capacity paths. Forced late handoff collision rolls back the new request, reservation, transition, outbox, and ready state.
- Receipt-only projection is explicitly historical, shows zero current ready jobs and zero pending handoffs, survives early release/missing/advanced current state without inventing current truth, and rejects observations before promotion.
- The UI labels the evidence historical, exposes no frontier action control, and omits owner evidence, authentication tags, source material, private locators, credentials, and handoff payloads.
- The internal handoff has no consumer and grants no approval, schedule, claim, lease, dispatch, execution, provider contact, agent message, GitHub mutation, credential, or external-effect authority.
- Repository-only PGlite/SQLite evidence and the lack of multi-process/hosted PostgreSQL proof are stated explicitly rather than presented as production proof.

These positive properties do not compensate for `AUTO030-TRR-001`.

## Commands and evidence provenance

### Independently run by this reviewer

| Command or check | Result |
|---|---|
| `git rev-parse HEAD` | exact target `9e43ea56471df1ee58dd8e94da04550ce6062063` |
| `git branch --show-current` | `codex/cr11b-auto-030-ready-scheduler-handoff` |
| `git merge-base 8acdbc... 9e43ea5...` | exact feature base `8acdbcabe300660f062c202d7850537cb20373d6` |
| `git status --short --branch` before report | exact branch; clean working tree |
| `git diff --name-status 8acdbc...9e43ea5` | declared AUTO-030 implementation, UI, migration, tests, documentation, and preserved-review paths |
| `shasum -a 256` over all three prior reports | exact documented hashes `5a5f2d...ae825`, `8f0bd318...42652`, and `db6e7986...897b7` |
| `git diff --check 5b26a63...9e43ea5` | passed |
| `node --import tsx --test tests/ready-frontier-promotion.test.ts` | 19/19 passed |
| `pnpm test:cr11b` | 63/63 passed |
| `pnpm check` | passed |
| `pnpm lint` | passed |
| `pnpm test` | pretest 645/645; core 414/416 with two intentional skips and zero failures; post-test 52/52 |
| Source search for frontier forms/controls and effect clients | none found |
| Disposable PGlite transaction-return timing probe | reproduced `TRR-001` and `TRR-002`; temporary script and stores removed |

### Separately authorized report-only sub-audit

The sub-auditor independently re-ran 19/19 focused tests and selected 5/5 authorization/time tests. Its disposable three-case probe reproduced the post-callback commit/return gap and separately confirmed rollback when expiry occurs after the handoff write or after request completion but before the final callback check. It changed no repository file and removed its temporary evidence fixture.

The complete green gates demonstrate regression stability. They do not exercise the delay after the final callback check and before transaction commit/return.

## Residual blockers and next gate

AUTO-030 is not accepted on `9e43ea56471df1ee58dd8e94da04550ce6062063`. AUTO-040 must not begin from this target.

Architect-owned remediation must either establish enforceable commit/return-time freshness or narrow the architecture and all acceptance claims so a callback-current but commit-expired bundle is never represented as satisfying the protected invariant. The exact post-callback timing probes above require regression coverage. A different independent agent must then review a new immutable target.

All four negative reports must remain byte-for-byte unchanged. This report authorizes no implementation, merge, Git/GitHub mutation, production policy, consumer, schedule, claim, lease, dispatch, execution, provider/agent contact, credential access, network operation, deployment, or external effect.

REJECTED_THIRD_REMEDIATION_FINDINGS
