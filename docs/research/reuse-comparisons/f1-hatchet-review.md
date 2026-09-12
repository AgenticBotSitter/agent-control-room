# Root review: current Hatchet transaction seam

2026-09-08. Reviewed `f1-hatchet-seam.md`, its declared immutable source scope,
and actual Control Room `src/persistence/delivery-store.ts` and
`pg-boss-bounded-submission.ts`. No Hatchet execution or new service evidence.

Accept the narrow source disposition: the inspected maintained-v1 public trigger
does not enlist in the caller's SQL session. A passing remote trigger test cannot
establish same-transaction atomic enqueue. The internal engine transaction does
not make its private tables a supported integration API. This is not a broad
Hatchet rejection or a reason to skip its viable post-commit option.

The existing CR alternatives are concrete. `enqueueInSession` binds the caller's
session to the actual pg-boss SQL port, locks queue configuration and requires an
exact fresh returned ID. `DeliveryStore.claimOutbox` uses transactional SKIP LOCKED
claims and claim tokens. These are different responsibilities and must not be
scored as if a remote SDK has the same SQL callback.

## Required distinction in the contender experiment

`markOutboxDelivered` records delivery status; it does not store a Hatchet run ID,
compare a native task digest or prove physical agent start. Its already-delivered
fallback accepts the recorded delivered status. Therefore an outbox row marked
delivered is not by itself exact remote run receipt reconciliation. No bug is
alleged in a generic delivery method; the missing mapping belongs to the adapter.

Likewise, recovered/failed delivery eligibility is not permission to repeat an
uncertain native execution. A Hatchet test must demonstrate what happens after a
successful remote trigger with a lost acknowledgement, including restart beyond
backend deduplication expiry, without interpreting time-based expiry as renewed
canonical authority. Reuse existing canonical intent/receipt state, not another
generic outbox or a fake native success receipt.

## Next test boundary

Compare DBOS's actual same-session path with the current pg-boss path once the
documented disposable PG setup is authorized. For Hatchet's competing post-commit
route, retain it as viable until the real maintained client/engine and actual CR
outbox/receipt mapping are exercised or an exact required unsupported behavior is
demonstrated. Source-read e2e tests are not fresh passes. Do not install an entire
platform merely to reconfirm the absent SQL parameter.

No final work-engine selection follows. Existing immutable source pins, retry and
TTL caveats, unmeasured operating cost and transitive-license uncertainty remain
attached to the comparison. Embedded-engine setup may reduce operational cost;
its existence is neither a deployment authorization nor proof of caller atomicity.
