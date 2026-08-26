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
- `agent/<route>/<capsule-id>` is an isolated producer branch created from the current named integration target after the queue controller accepts the claim. The capsule's earlier product-base commit remains an ancestry boundary.
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
- eligible routes, GitHub claimants, platform, required tools, route concurrency, and independent-verifier requirements;
- size, repair, time, and effect limits;
- explicit stop and quarantine conditions.

Only `ready` capsules may be claimed through the serialized queue controller. Agents cannot assign themselves by editing an issue, promote a draft capsule, substitute a base, or start a capsule whose dependencies are incomplete. Codex may pause a wave without converting partial work into accepted evidence.

## Fluid jobber queue

A jobber is the GitHub queue view of one capsule. Its title exposes eligibility before any agent spends time opening it:

```text
[READY][ANY|MACOS|WINDOWS|LINUX][T0|T1|T2|T3][CR-BLOCK][CAPSULE-ID] summary
```

The dedicated worker procedure is `skills/agent-build-worker/SKILL.md`. GitHub serializes all state transitions globally so two near-simultaneous comments cannot both acquire the same jobber or oversubscribe a route.

Before publishing a jobber, Codex runs `pnpm agent:capsule -- --capsule <path>` and requires `claimable`, then runs `pnpm agent:jobber <path>` to generate the canonical title, eligibility summary, queue markers, and issue body. Handwritten titles or issue bodies are not authoritative and a mismatch is rejected at claim time.

| Command | Preconditions | Result |
|---|---|---|
| `/claim <route>` | Ready title/label, eligible route and login, completed dependencies, no existing producer branch, route capacity available | Assigns the issue, records the route, changes title to `CLAIMED`, and returns exact branches |
| `/release <route> --no-work-started <reason>` | Active claim and no producer branch | Returns the untouched jobber to `READY` |
| `/blocked <route> <reason/evidence>` | Active claim after work, an attempt, ambiguity, or exhausted repair budget | Moves to `BLOCKED`, releases capacity, and waits for Codex triage |
| `/submitted <route> <PR URL>` | Open PR from the exact producer branch to exact integration target | Moves to `REVIEW` and releases capacity immediately |

Every queue transition comment contains exactly one command and no trailing explanation. A malformed command-like comment is rejected visibly and cannot silently succeed. The result manifest's `baseCommit` is copied byte-for-byte from the capsule; it is the product-base ancestry pin and is not replaced by the integration branch's current head.

A route may hold several independent claims up to the capsule's declared limit. Submission releases a slot before review finishes, so agents can continue through a prepared wave while Codex and verifier cells review in batches. Dependencies still serialize work that truly depends on an accepted predecessor.

`BLOCKED` work is not silently offered to another route. Codex reviews the preserved branch/evidence and closes, safely amends before any attempt, or issues a new capsule identity pinned to the appropriate base. An untouched release is the only automatic return to the ready pool.

## Task capsule

The normative machine-readable contract is `control-room.agent-build-capsule/v2`, validated by `scripts/validate-agent-intake.mjs`. A capsule contains one objective and one primary deliverable boundary. Required properties include:

- capsule and wave identifiers;
- summary, platform, task class, work mode, risk, and status;
- eligible routes, authorized GitHub claimants, required tools, dependencies, concurrency, and verifier separation;
- exact 40-character product-base commit and integration branch;
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

Ordinary production does not inherit single-attempt platform rules. `standard-work` may use the capsule's bounded repair iterations for failures caused by its own patch. Platform-native attempts and controlled effects retain their exact retry/effect ledgers and never gain a retry because other ordinary jobbers are fluid.

## Automated intake

Every submission uses two final commits: an implementation commit containing only product changes, followed by a metadata commit containing only one `control-room.agent-build-result/v2` document at the capsule's declared result path. The result records the implementation commit, avoiding an impossible self-reference to the commit containing the manifest. The intake gate checks before semantic review:

1. schema and identifier consistency;
2. capsule status, producer eligibility, product-base ancestry, current integration-base ancestry, implementation-commit ancestry, deterministic producer branch, and integration target;
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
