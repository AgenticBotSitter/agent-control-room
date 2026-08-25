# Agent Build System V2

**Status:** Owner-approved coordination contract  
**Effective:** 2026-08-25  
**Scope:** Repository work delegated to Hermes or any other external agent  
**Authority:** Codex owns capsules, contracts, security boundaries, intake dispositions, integration, and block completion.

## Outcome

External agents operate as a bounded production system, not as independent project planners. Codex freezes a build wave, dispatches non-overlapping task capsules, quarantines invalid submissions before semantic review, and integrates accepted work into one Codex-owned block pull request.

```text
Owner priorities and effect approvals
                |
        Codex architecture lane
                |
     frozen wave and task capsules
        /                   \
producer cells         verifier cells
        \                   /
         automated intake gate
            |          |
       quarantine   eligible result
                         |
               Codex integration branch
                         |
               one block pull request
                         |
                        main
```

Agent pull requests and patches are evidence. They are never architectural authority and never advance a build block by themselves.

## Branch and ownership model

- `main` accepts only coherent, Codex-reviewed block integrations and emergency architect-owned corrections.
- `integration/<block>` is created and owned by Codex for one frozen wave or block. Worker results target this branch, never `main`.
- `agent/<route>/<capsule-id>` is an isolated producer branch created from the capsule's immutable base commit.
- A verifier uses a separate checkout and branch or performs a report-only review. A producer cannot be its own required verifier.
- Workers do not edit wave definitions, capsule contracts, architecture, acceptance criteria, or integration metadata unless a capsule explicitly makes one of those files its sole deliverable.

Codex promotes accepted commits into the integration branch. The worker account never approves or merges its own result. Branch protection is an enforcement layer; this contract remains controlling when GitHub cannot express every rule.

## Frozen wave

A wave is the smallest managed batch. Before its status becomes `ready`, Codex records:

- the CR block and immutable base commit;
- the integration branch;
- frozen contract references and acceptance commands;
- a dependency graph;
- exact, non-overlapping product paths per capsule;
- producer and independent-verifier assignments;
- size, repair, time, and effect limits;
- explicit stop and quarantine conditions.

Only `ready` capsules may be claimed. Agents cannot self-assign an issue, promote a draft capsule, substitute a base, or start a capsule whose dependencies are incomplete. Codex may pause a wave without converting partial work into accepted evidence.

## Task capsule

The normative machine-readable contract is `control-room.agent-build-capsule/v2`, validated by `scripts/validate-agent-intake.mjs`. A capsule contains one objective and one primary deliverable boundary. Required properties include:

- capsule and wave identifiers;
- task class, work mode, risk, status, producer route, and verifier separation;
- exact 40-character base commit and required branches;
- accepted contract references and immutable inputs;
- exact allowed product paths and forbidden path prefixes;
- acceptance commands and semantic conditions;
- changed-file, changed-line, and repair limits;
- effect boundary and stop conditions;
- exact result-manifest path.

Allowed paths are exact repository-relative files. Wildcards, parent traversal, directories standing in for an unknown output set, and personal paths are invalid. Result metadata is permitted only at the capsule's declared result path.

## Production and verification cells

Production cells are optimized for settled, mechanically reviewable work:

- fixtures and negative cases from frozen contracts;
- isolated components from accepted UI/data contracts;
- adapters against pinned recordings;
- deterministic tests and portability helpers;
- documentation, inventories, and packaging maintenance.

Codex retains architecture, authorization, protocol design, migrations, secret handling, acceptance selection, cross-module integration, production effects, and final security decisions.

Verification is a separate task. The verifier compares the result with the capsule, attempts named negative cases, and reports a disposition without repairing the producer branch. Independence requirements follow ADR-044. A verifier's pass is evidence for Codex, not merge authority.

## Automated intake

Every submission uses two final commits: an implementation commit containing only product changes, followed by a metadata commit containing only one `control-room.agent-build-result/v2` document at the capsule's declared result path. The result records the implementation commit, avoiding an impossible self-reference to the commit containing the manifest. The intake gate checks before semantic review:

1. schema and identifier consistency;
2. capsule status, product-base ancestry, current integration-base ancestry, implementation-commit ancestry, branch names, and integration target;
3. exact changed paths and forbidden prefixes;
4. changed-file and changed-line ceilings;
5. recorded acceptance commands and honest non-zero exits;
6. producer/verifier separation;
7. repair count and effect count;
8. safety confirmations and the no-self-merge declaration;
9. clean `git diff --check` output.

The gate returns `eligible` or `quarantined`; it never returns `accepted`. Missing metadata, stale or invented capsules, direct-to-main pull requests, unapproved effects, scope expansion, or contradictory claims are quarantined automatically.

## Integration and completion

Codex reviews eligible results in dependency order. It may reject, request one bounded correction, accept with follow-up, or accept. Accepted commits are promoted onto `integration/<block>`, where Codex resolves interactions and runs the block-level deterministic suite. One Codex-owned pull request then represents the whole block.

The owner sees one block-level decision surface. Native attempts, installs, credentials, persistent services, destructive cleanup, production effects, and new external authority remain separate owner gates. A build-system wave never inherits those permissions.

## Route qualification

Routes are promoted per task class, not by model reputation:

| Tier | Permitted work | Initial state |
|---|---|---|
| T0 mechanical | docs, exact fixtures, inventories, formatting | calibration required |
| T1 bounded implementation | isolated code under frozen contracts | requires successful T0 evidence |
| T2 integration candidate | pinned foreign interfaces and larger bounded modules | elevated verification required |
| T3 platform validation | immutable harness evidence on a named host | explicit packet and owner gates |
| architect-only | architecture, security, migrations, authority, final integration | never delegated |

A scope or authority violation quarantines the result and removes promotion eligibility until a new calibration wave passes. Track first-pass success, semantic defects, scope/security violations, review minutes, corrections, accepted versus discarded lines, and completion time.

## Migration from the legacy queue

As of adoption:

- no new agent work may start from a legacy open issue without a V2 capsule;
- legacy issues are inventory, not an active queue;
- existing direct-to-main agent pull requests are quarantined until Codex either closes them or creates a fresh capsule against current architecture and requests a clean redelivery;
- speculative scaffolds for future blocks are closed rather than kept merge-ready;
- current platform qualification evidence remains governed by its immutable qualification packet and owner-attended boundaries.

The first intake pilot is recorded in `docs/agent-intake/2026-08-25-open-pr-triage.md`. It does not authorize a new native macOS attempt or advance CR-5C.9H.
