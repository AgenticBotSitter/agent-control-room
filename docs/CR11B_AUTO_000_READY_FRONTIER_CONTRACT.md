# CR11B-AUTO-000 continuous ready-frontier contract

**Status:** Frozen for the repository-only authenticated fake simulation
**Date:** 2026-08-30
**Authority:** ADR-096 and the existing Control Room security/authority contracts

## Purpose

The ready-frontier controller removes the owner from routine queue-stocking work. It continuously derives a bounded list of useful real-work proposals from current project goals, dependency truth, blockers, review state, canonical work, earlier frontier proposals, route capacity, cost, risk, and owner policy.

Its output is not a job queue. Every selected item remains an authenticated proposal that requires a separate reviewed materialization boundary. The controller has no approval, ready-state, claim, lease, dispatch, execution, provider, or external-effect capability.

## Exact inputs

One source snapshot contains:

- one tenant and monotonically identified canonical-source revision;
- a separate frontier-history revision;
- bounded project goal/state/share/outstanding-proposal facts;
- bounded route availability, platform, risk, cost, freshness, and evidence facts;
- dependency state with observed evidence;
- safe real-work candidates with intent digests, route/platform/capability requirements, dependency IDs, review truth, blockers, priority, downstream impact, time, cost, and risk;
- canonical work intent truth across all states;
- earlier frontier proposal identities and states;
- explicit negative raw-input, usable-access-data, and private-locator retention truth;
- one digest over the complete canonical snapshot.

One repository policy fixture contains:

- one tenant, policy identity, revision, activation interval, digest, `repository_fixture` source, and explicit `ownerPolicyVerified: false` truth;
- global risk, per-proposal cost, cycle cost, count, route-count, freshness, starvation, and proposal-expiry limits;
- per-project enablement, route allowlist, risk, per-proposal cost, cycle cost, cycle-count, outstanding-count, and owner-policy digest;
- fixed proposal-only behavior and explicit denial of automatic approval, ready transition, claim/lease, dispatch/execution, provider contact, and external effects.

Every boundary accepts only bounded ordinary JSON data. Extra fields, accessors, Proxies, prototype behavior, secret-like material, scope drift, non-canonical order, invalid chronology, and digest drift fail closed.

## Gate order

For each candidate, the controller evaluates hard truth before ranking:

1. exact project scope and active state;
2. current enabled project policy;
3. duplicate intent within the source, canonical work, or prior frontier history;
4. declared blockers;
5. pending or rejected review truth;
6. dependency presence, state, scope, and freshness;
7. route presence, availability, freshness, platform support, and project allowlist;
8. global, project, and route risk/cost limits;
9. deadline validity;
10. global, project, outstanding, route-slot, and cycle-cost capacity.

The exact dispositions are `proposed`, `blocked`, `needs_review`, `duplicate_suppressed`, `deferred_policy`, or `deferred_capacity`. Missing or stale truth never becomes eligibility.

## Deterministic priority and starvation

Only candidates that pass all hard gates enter ranking. The score combines declared priority, downstream unlock count, bounded queue age, project fair-share debt, and estimated cost. Stable project/candidate identity breaks ties.

Once queue age reaches the policy starvation bound, starvation candidates rank before ordinary scored candidates. The oldest eligible starvation candidate ranks first. Starvation never overrides a dependency, review, duplicate, route, platform, risk, cost, freshness, project, or capacity gate.

## Authenticated proposal identity

Every proposal binds the cycle, tenant, project, candidate, exact intent, project goal, source snapshot, repository policy fixture, negative owner-policy-verification truth, route, platform, capability, risk, cost, priority, rank, proposal time, and expiry. A SHA-256 digest binds its full negative-authority content. A separate HMAC tag authenticates proposal identity with a key held outside the source and stored record.

The complete evaluation also has a digest and HMAC. Re-digesting changed content without the private integrity key does not produce an accepted proposal or evaluation.

## Continuous duplicate suppression

The durable simulation feeds its own authenticated proposal history into every later cycle. An unchanged intent is therefore suppressed before another proposal can be emitted, including after restart. Replaying the same cycle reconstructs only the history that preceded that cycle, so exact replay is inert. Retrying dismissed, expired, failed, cancelled, or rejected work requires a new intent digest; the controller never silently retries an exact intent.

## Restart-safe fake ledger

The fake service stores canonical evaluation JSON in a private SQLite database. Each row and complete ordered state are HMAC-authenticated. An external compare-and-swap checkpoint must exactly match the database revision, record count, state digest, and state tag.

Exact cycle replay returns the existing evaluation. Changed replay, wrong key, foreign tenant, row change/deletion, metadata drift, added triggers/views/tables, complete database rollback, and capacity overflow fail closed. The repository checkpoint implementation remains test-only and is not production key or rollback custody.

## Safe operator projection

The operator view shows proposal title, project, route, platform, risk, cost, priority, rank, review requirement, project counts, and reason counts. It omits objective text, candidate and intent identity, source evidence, policy evidence, authentication tags, private locators, raw input, and usable access data. It has no approval, ready, claim, lease, dispatch, or execution control.

## Synthetic result

The three-project fixture uses ABS News, Content Blooms, and Lo-Fi Wayfarer real-work candidates. It proposes, in order:

1. the starved Wayfarer Unreal setup guide;
2. an ABS verified-AI-release research brief;
3. a Content Blooms source-backed article draft.

It separately preserves blocked dependency and content-hold truth, pending review, canonical and same-source duplicates, missing route, and over-risk/over-cost policy deferrals. A later unchanged cycle emits no duplicate proposal for the three selected intents.

## Explicitly absent

There is no verified standing owner policy, timer, schedule activation, hosted source adapter, canonical job materializer, approval writer, ready-state transition, claim, lease, dispatcher, executor, provider client, agent message, GitHub issue/PR creator, credential access, native integration, network path, DNS, Cloudflare, hosting, deployment, publication, or production effect.

## Next boundary

CR11B-AUTO-010 may connect authenticated canonical repository sources to the controller and render the durable frontier in portfolio and Project Workspace views. It must remain proposal-only. Standing-policy materialization and automatic ready/dispatch behavior require later separately reviewed phases.
