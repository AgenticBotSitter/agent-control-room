# CR-6C scheduler and reservation contract

**Status:** Active, effect-free implementation contract. It selects or reserves nothing by itself.

## Rules

1. A schedule decision is a tenant-scoped, deterministic recommendation until the existing authority and lease boundaries accept it. It never grants capability, approval, budget, or execution authority.
2. Hard exclusions come first: a candidate with an unsatisfied dependency, stale fleet evidence, unavailable route, maintenance state, policy conflict, exhausted budget, or unavailable resource cannot be selected by scoring.
   Declared cost ceilings, privacy allowlists, minimum quality, hard deadlines, maintenance, and draining state are evaluated by one deterministic fail-closed gate. Soft deadlines affect scoring but do not become a fabricated hard exclusion.
3. Fair-share debt is `targetShare - recentShareUsed`. It can boost an eligible project but never bypass a hard exclusion. Idle shares may be borrowed; debt is repaid only at a safe work boundary.
4. Within an eligible project, priority, deadline risk, queue age, downstream unlock value, and resource cost are explicit scoring inputs. Ties resolve by stable project/work/route identifiers.
   An otherwise eligible item waiting 1,440 minutes enters the starvation guard; the oldest guarded item wins at the next safe scheduling boundary. Hard exclusions still win.
5. A reservation is a separate atomic operation. It must bind tenant, project, work item, route, resource key, capacity units, a bounded expiry, and a decision digest. A lost or expired reservation is not an execution permission.
6. Resource contention, lease loss, and recovery are visible as stable reason codes. The scheduler reports why each candidate was excluded and which limiting resource is the bottleneck; it never invents a remedy or raw host detail.
7. Manual, exclusive, and draining resources are not borrowed. Preferred resources may be borrowed only when their preferred project has no eligible waiting work.
   Shared resources accept any otherwise eligible project. Opportunistic resources defer whenever normal eligible work is waiting. Manual placement requires an exact project/work/route assignment. Missing facts fail closed instead of silently making a constrained resource shareable.

## Effect boundary

This block is deterministic code, contracts, and tests only. It must not dispatch a job, reserve a real GPU, change a machine, spend money, or contact a provider.
