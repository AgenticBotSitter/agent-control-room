# F8 actual-library caller review

2026-09-08; baseline `c437014` plus current research changes. Source-only review of
shared candidate adapter, modified bootstrap harness, dispatch harness, three receipts
and relevant current bootstrap/task/news/private-process code. No rerun, acquisition,
connection, application edit or Git write. Final security selection remains open.

## Disposition and precise evidence qualification

No blocking defect for the bounded caller-seam evidence. One distinction must survive
the final report: **jose's discarded-precommit result records three completed
verifications at commit**, whereas jsonwebtoken records four. The async wrapper now
increments only after `await verify`. Thus jose demonstrates reaching the fake commit
while its final async check is pending, not positive acknowledgement that the authored
fourth-verification held gate has been reached. Both support returning/awaiting the
precommit Promise; do not label both as gate-acknowledged held-result experiments.
No rerun is required merely to retain that narrower, useful observation.

## Actual code versus stand-ins

- Shared adapter imports actual jose/jsonwebtoken APIs, checks selected pinned package
  file hashes and hashes the CR verifier before replacing its decode/signature block.
  Library-verified payload reaches unchanged claims policy; decoded header only selects
  a captured deployment key through strict header validation. No fake candidate result
  replaces library verification in these runs. Selected file guards are not full-tree
  import confinement or a fresh license audit.
- Bootstrap factory now uses that adapter and awaits its result before authored delay.
  Actual source control-flow adaptation returns the precommit Promise in the correct
  variants; the deliberately discarded variant retains the defect. Synchronous
  jsonwebtoken coverage includes 30 cases; jose omits impossible synchronous positives
  and records 23. These counts are different variant matrices, not a speed/quality
  ranking. Receipts retain exit 0 and expected positive/negative outcomes.
- Real task/news/private-process modules are hash-checked and transpiled. jose replaces
  exactly their identity assignment with `await`; synchronous jsonwebtoken does not.
  One cached candidate auth module is shared with actual HTTP error handling, so its
  `WebAccessError` identity is preserved at these seams. Other current imports execute
  outside that selected hash set, as the emitted scope states. VM is not a sandbox.
- The fake private pool now provides required transaction method shapes whose invocation
  increments a counter and throws. That fixes constructor compatibility without
  replacing the real constructor or silently returning database success. The initial
  constructor failure is retained. Successful route checks report zero DB calls.

## What the 36 dispatch cases cover

Actual selected routes are task **list**, news **propose**, and private **Idea options**.
Each library runs valid/missing/bad-signature/wrong-audience/expired cases through each
route. Assertions establish expected status, no-store, denial body and service-call
delta; positive consumers see a frozen non-Promise identity with the expected subject.
This is weaker than rechecking all six identity fields, which belongs to prior
consolidated evidence. It does not prove list authorization or correctness of a news
proposal/Idea option: those operations are authored injected services.

Six jose held valid/invalid cases keep an unresolved gate before actual verification,
observe no service call, release, then assert success calls once or denial calls zero.
The pre-release observation is event-loop-based, not explicit gate-entry acknowledgement;
positive post-release completion makes these useful await-ordering checks, not a timed
latency benchmark or expiry-during-hold test. Neither task submissions/revisions nor
news approval nor private Idea execution/stop/synthesis routes are qualified here.
Private close is an injected pool-close count, not physical process cleanup.

## Remaining limitations and next decision

Bootstrap retains fake SecurityStore and fake transaction/open/commit counters, not
PostgreSQL grants, rollback or durable commit. Candidate execution strengthens the
earlier async-contract experiment without removing those limits. The illustrative
post-await freshness patch still does not establish a global post-await high-water
fence; preserve the earlier monotonic-time limitation before production adaptation.
These tests do not evaluate invalid factory trust, rehearsal resource acquisition,
whole private-process draining, every injected effect or all routes' downstream time
checks. Do not promote successful identity delivery to whole-auth approval.

The evidence now supports real-library caller feasibility, not merely source estimates.
It fairly preserves synchronous jsonwebtoken's lower caller-change cost and jose's
smaller dependency closure. Final integration should account for remaining key-cache
factory/rehearsal and route-authority regression work; no new generic auth service or
database migration is justified by these comparisons. Production files changed: zero.
