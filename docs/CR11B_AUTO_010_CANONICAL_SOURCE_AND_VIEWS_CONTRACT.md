# CR11B-AUTO-010 Canonical Source, Local Cycle, and Frontier View Contract

Status: implemented for the repository-only authenticated simulation

Date: 2026-08-30

## Outcome

AUTO-010 connects the AUTO-000 ready-frontier controller to four narrow repository read lanes, gives an operator one manually invoked local cycle service, derives durable latest/history views from the authenticated cycle ledger, and places the resulting proposal frontier in the portfolio and every Project Workspace.

This block improves visibility and integration only. It does not make a proposal into canonical work and does not create a timer, scheduler, approval, ready transition, claim, lease, dispatch, execution, provider call, agent message, GitHub operation, or external effect.

## Four authenticated read lanes

One cycle requires exactly one read from each channel:

1. `projects` supplies current goal identity, lifecycle state, fair-share position, and outstanding-proposal count;
2. `work` supplies bounded real-work candidates, canonical work identity, and dependency truth;
3. `attention` supplies exact review and blocker overlays for every candidate;
4. `capacity` supplies current route state, slots, platform support, risk, cost, freshness, and evidence identity.

Every read binds the same:

- tenant;
- read-group identity;
- monotonically bounded source revision;
- exact observation time;
- sorted project scope;
- explicit absence of raw input content, usable access data, and private locators.

The canonical payload digest, complete read digest, and HMAC bind the channel and its contents. Reads with altered payloads, wrong keys, duplicate or missing channels, non-canonical order, foreign scope, hostile JavaScript behavior, or a different observation cut fail before source composition.

## Source composition

The composer requires all four read lanes to agree before it produces an AUTO-000 source snapshot. It rejects:

- any project outside the exact requested scope;
- missing or duplicate candidate attention truth;
- candidate/attention project mismatch;
- future attention observations;
- duplicate project, candidate, route, dependency, work, or evidence identity;
- stale or future source truth;
- extra fields, accessors, Proxies, secret-like content, or usable private values.

Candidate review and blocker truth comes from the authenticated attention lane rather than caller inference. The resulting snapshot remains digest-bound and retains no raw prompt, article body, full message, credential, native path, provider session, or usable private locator.

## Manual local cycle service

The service accepts only an exact `manualTrigger: true` request with a null schedule identity and explicit negative authority flags. It calls each read lane once, composes one source, evaluates it through AUTO-000, and records the evaluation in the existing private tamper-evident SQLite ledger.

An exact replay is inert. A changed replay fails. A later cycle receives authenticated proposal history from the ledger and suppresses unchanged intent across restart. A stale or failed read produces no ledger record. The service has no timer, recurrence loop, network client, canonical-work store, approval store, lease store, provider client, agent messenger, GitHub client, dispatcher, or executor.

## Durable read model

Latest and bounded history projections are re-derived from the durable authenticated evaluations after every ledger verification. They therefore inherit row authentication, whole-state authentication, external rollback-checkpoint comparison, exact replay behavior, tenant separation, schema allowlisting, and restart verification.

The safe cycle view exposes:

- proposal title, route, platform, risk, cost, priority, rank, and unrequested owner-review state;
- project-level proposed, blocked, needs-review, deferred, and duplicate-suppression truth;
- bounded safe reason codes;
- cycle identity and observation time.

It omits candidate identity, objective, intent digest, source evidence, source/read/evaluation authentication tags, owner-policy digest, access data, and private locators. Non-proposed items receive derived display identity and generic gate labels rather than source content.

## Operator views

The portfolio now contains a cross-project “What should be proposed next” section with proposal, blocked, review, and deferred totals plus the highest-ranked proposal for each project. Every Project Workspace places its Ready frontier directly below current project status and before the larger Agent Team surface. It contains four explicit lanes:

- Proposed;
- Blocked;
- Needs review;
- Deferred.

Empty, missing-scope, unavailable, stale-source, and integrity-failure states are explicit. The views contain no button, form, input, approval control, work-creation control, schedule control, agent-message control, or execution control.

## Repository fixture

The authenticated fixture uses ABS News, Content Blooms, and Wayfarer repository facts. The first cycle proposes:

1. the starved Wayfarer Unreal setup guide;
2. the ABS verified-release research brief;
3. the Content Blooms source-backed article.

It simultaneously displays dependency, blocker, pending-review, route, risk, cost, canonical-duplicate, and source-duplicate gates. Later unchanged cycles propose none of the same intents.

The UI maps those three project facts into the existing repository Project Workspace identifiers. It remains clearly labelled as a repository fixture and does not claim protected/live source availability.

## Stop boundary

AUTO-010 stops before:

- a verified standing owner policy;
- frontier-to-canonical materialization;
- automatic approval or ready promotion;
- attempt, claim, lease, dispatch, execution, or retry;
- provider contact, native reads, credentials, messages to agents, or GitHub work creation;
- a timer, recurrence service, automatic cycle trigger, filesystem access outside the private fake ledger, network access, DNS, Cloudflare, hosting, deployment, or production effects.

AUTO-020 may define standing owner-policy enrollment and atomic proposal-to-canonical proposed-work materialization. It must keep ready, scheduling, dispatch, execution, and every external effect structurally absent.
