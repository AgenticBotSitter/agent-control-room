# How Agent Control Room changes are reviewed

Unpublished proposed policy. Maintainer identities, escalation/moderation contact and
license/contribution terms must be confirmed before this becomes an active policy.

## Responsibilities

Contributors propose and implement scoped changes, explain reused code, run relevant
checks and report limitations. Agent-assisted work is welcome; its submitter remains
responsible for the content and evidence.

Reviewers check correctness, scope, attribution and tests. Security-sensitive changes
need an independent qualified reviewer, not a second message from the change's author.
An automated review is advisory and does not become a separate human GitHub approval.

Maintainers own architectural decisions, permission boundaries, release acceptance and
integration. Only maintainers with the relevant repository permissions merge accepted
changes. A merge does not authorize deployment, use of credentials or a live agent run.

## Work assignment without constant waiting

A ready work item names its outcome, platform, prerequisites, dependencies, base revision,
scope and acceptance checks. A maintainer confirms its responsible contributor before
implementation. Asking for an assignment does not reserve it atomically.

Contributors may work on several assigned, independent items while other PRs await review.
Do not stack unrelated work on an unmerged branch. Declare genuine PR dependencies so
integration can happen in order. Keep overlapping changes under one coordinated owner.

Ordinary failed tests can be fixed and rerun within scope. If blocked, preserve the work
in a draft PR and explain the missing input. Ask for reassignment when unable to continue.
An uncertain external action is different: stop and reconcile it, following the approved
attempt limits. Do not repeatedly perform it just to obtain a successful-looking result.

## Proportionate review

Documentation and isolated presentation changes need a focused accuracy/usability check.
Behavior changes need regression evidence for the affected user flow. Authentication,
execution, database integrity, migrations, recovery and dependency changes need explicit
risk review and appropriate independent evidence before integration.

Review comments should identify a concrete defect, requirement or tradeoff. Maintainers
should distinguish required fixes from optional suggestions and avoid expanding a small
contribution into unrelated work. A check failure is evidence to investigate, not grounds
to discard a contributor's useful work or conceal what happened.

## Decisions and disagreements

For an architectural change, record the user need, alternatives considered, reuse/license
assessment, chosen approach, failure behavior and acceptance test. Maintainers decide
unresolved technical tradeoffs and record the reason. Contributors can propose a revised
decision with new evidence; repeated personal pressure is not a review mechanism.

No contributor has to provide personal infrastructure or credentials. Never run untrusted
PRs with maintainer secrets or on private agent hosts. Use disposable resources for checks.
Release claims must describe verified behavior and clearly identify unsupported scenarios.
