# Improve Control Room desk

**Status:** design and first-slice contract  
**Scope:** the built-in Control Room self-project, from an owner request through an update candidate  
**Not active in the first slice:** installation mutation, database upgrade, restart, rollback and GitHub publication

## Product outcome

“Improve Control Room” is a built-in project template for changing Control Room through Control Room. The owner writes an improvement in plain language, chooses a reviewed three-stage pipeline, confirms its workers and lead, and submits it to the ordinary project/task machinery. The resulting work uses the same proposal, owner decision, queue, task, result, review, worktree and audit records as any other project.

A successful pipeline may publish an **update candidate**. Home then shows one “Update ready” card with the bounded change summary, test results and database-change declaration. The owner may Accept or Decline that exact candidate. In the first slice both choices only append an owner decision: neither choice changes the running installation.

The desk is deliberately not a second scheduler, task system, approval system or deployment daemon.

## Existing components reused

The desk builds on the minimum self-hosting slices in `MULTI_AGENT_PIPELINES_DESIGN.md`:

- S1 proposal intake remains the machine-facing proposal boundary.
- S2 batch approval remains the point where proposed work becomes ordinary proposed tasks.
- S3 per-worker queues, depth limits and exact worker/model selections remain authoritative.
- S4 linear build → check → sign-off pipeline templates supply the worker and lead choices shown by the request form.
- S5 independent agent review remains separate from execution and owner authority.
- S6 isolated worktrees, changed-path evidence and the existing code publication record supply the candidate revision and change evidence. The desk uses a local integration branch instead of making day-to-day pull requests.
- S7 bounded sequential advance, loop caps, current delegation checks and authenticated pipeline history remain the only unattended continuation path.

Batch approval, queues, pipeline runs, checker sign-off and ordinary task/result pages remain visible from the project. The desk adds a small request record that binds the owner’s text to one immutable pipeline template revision, and a candidate/decision record after successful integration. It does not copy pipeline state.

The installation-upgrade work is also reused rather than reimplemented. Existing reviewed backup/restore, database-upgrade, service lifecycle, health and rollback primitives form the later executor. Upgrade PRs 1–5 provide the current command and safety base. Planned upgrade slices 7–9 add a durable upgrade request/approval table, a signature over the exact release and migration plan, and the in-app Approve action. Until those slices exist, this desk cannot deploy.

## Built-in self-project

The portable product configuration always includes this reserved template:

| Field | Value |
| --- | --- |
| Template ID | `control-room` |
| Display name | `Control Room` |
| Optional modules | none; the desk is a core project surface |

An installation creates one ordinary project from that template. The project keeps normal Overview, Tasks, Pipelines, Agents, Files, Reviews, Activity and Settings pages and adds an Improvements page. Selecting the template does not grant filesystem, Git, database, service or release authority.

## Private integration repository configuration

The managed integration repository is installation-private configuration, not a database value supplied by a worker and never public source content. Its future configuration record contains:

- an absolute, operator-owned local repository path;
- the managed integration branch name;
- the expected remote and release branch names;
- the last accepted candidate revision;
- bounded worktree roots that are separate from the live installation;
- the reviewed commands allowed by each test profile; and
- the service and protected-data identities used only by the later upgrade executor.

Startup must resolve the repository and branch to canonical values, reject symlink/path escape, reject a dirty or unexpected branch when publishing a candidate, and never reveal the local path in browser records, audit metadata, logs or exported configuration. Workers receive an isolated worktree capability, not the integration-repository path and never the live-install path.

Control Room is the sole writer to the managed integration branch. A lead may integrate authenticated worker publications after independent checks. The live installation is never a worker worktree.

## Improvement request

The form contains:

1. plain-text requested improvement;
2. one existing pipeline template for this project;
3. the build/check workers derived from that authenticated template; and
4. the sign-off worker, labelled as the lead.

Submission stores the exact template ID, version and digest plus the selected worker and lead IDs, then instantiates the existing pipeline with one idempotency key. The saved request points to that pipeline run. A lost response is reconciled with the same request and pipeline-run key; it must not create a second run. The template’s current authenticated definition must still match the displayed workers at submit time.

The first slice does not invent arbitrary worker selection independent of a template. To choose a different worker/model/effort for a step, the owner creates or selects the corresponding ordinary pipeline template. This keeps one authoritative selection record.

## Test profiles

The lead selects or confirms the profiles suggested from the authenticated changed-path manifest. Profiles run in a worker sandbox against the candidate worktree, never against the live install.

| Profile | Selection | Minimum contents |
| --- | --- | --- |
| `fast` | every candidate | changed unit/contract tests, type checking and formatting/static checks |
| `db` | migrations, SQL, persistence, grants, schema digest or database-facing services changed | disposable real PostgreSQL as the production roles, migration up/down and least-privilege checks, ledger and schema digest |
| `full` | release candidate, shared infrastructure, uncertain targeting, or owner/lead request | all non-live repository gates plus all applicable real-PostgreSQL suites |
| `targeted` | derived from changed paths in addition to `fast` | the registered lane(s), mutation tests for changed guards and relevant browser journeys |

Path rules are versioned, reviewed desk configuration. Unknown paths select `full`; no rule may silently select fewer tests. Security, authentication, authority, database, ingress, installer, supervisor and release changes always require independent review, even when all automated profiles pass.

Each result records command/profile ID, candidate revision, outcome, test count when available, duration, evidence digest, worker identity and observed time. “Not run”, “blocked” and “unavailable” are not passes.

## Update candidate

An update candidate is immutable evidence for one successful pipeline/integration revision:

- tenant and Control Room project;
- source improvement request and pipeline run;
- base revision and candidate revision;
- bounded plain-language summary and changed-area list;
- all test-profile results, including failures and unavailable results;
- database-change declaration (`none` or migration IDs plus compatibility/rollback notes);
- required independent reviews and their accepted result digests;
- lead identity and sign-off time;
- record digest and integrity tag; and
- state: `ready`, `accepted` or `declined`.

Only a completed pipeline whose sign-off stage is accepted, whose candidate revision matches the managed integration branch, and whose required profiles/reviews pass may become `ready`. The first slice stores the bounded candidate evidence and decision contract; branch observation and automatic candidate publication are the next slice.

Home shows ready candidates before normal activity. The card says what changed, tests passed/failed/not run, and whether the candidate declares database changes. It links to the self-project and offers one decision. An unreadable candidate source must show unavailable, never “no updates”.

## Owner decisions and signed deploy approval

Accept and Decline are append-only owner decisions bound to the exact candidate ID, version, record digest and candidate revision. The decision records the authenticated owner identity, time, idempotency key, decision digest and integrity tag. A stale card, changed candidate or reused key with different content is refused.

In the first slice:

- `Accept` changes only `ready` → `accepted` and records `startsDeploy: false`;
- `Decline` changes only `ready` → `declined` and records `startsDeploy: false`; and
- no signed deploy approval is created.

The later deploy slice requires a **separate signed owner approval**. Its signed material includes the accepted candidate digest/revision, release artifact digest, exact migration plan/digest, verified backup plan, previous release, health checks, rollback plan, expiry and one-use nonce. The signing operation requires a current strong owner session. Code review, lead sign-off, candidate acceptance, network location and possession of an integrity key do not substitute for that signature.

## Deploy, restart and rollback state machine (later slice)

The future executor has a single durable state machine:

```text
accepted
  -> awaiting_signed_approval
  -> approval_verified
  -> draining
  -> backup_running -> backup_verified
  -> database_rehearsed
  -> database_upgrading
  -> building
  -> restarting
  -> health_checking
  -> deployed
```

Before the first live mutation, a missing/expired/mismatched/used approval returns to `awaiting_signed_approval`. Once mutation begins, any known failure enters `rollback_pending` and follows:

```text
rollback_pending
  -> service_stopped
  -> previous_release_restored
  -> database_rollback_or_verified_restore
  -> previous_service_started
  -> previous_health_checking
  -> rolled_back
```

If the executor cannot prove whether a command committed, whether migration state is compatible, or whether rollback restored the prior service, it enters `uncertain` and stops. It never guesses, retries a consequential step with a new identity, or reports the prior version healthy without evidence.

The state machine uses the existing verified backup/restore and platform service lifecycle components. Drain preserves uncertain work; database upgrade uses the reviewed `mac:upgrade`/rehearsal path and exact schema digest; restart is graceful; health checks cover the web process, database preflight, owner read and worker reconnect. Automatic rollback is permitted only by the exact signed plan and cannot delete retained evidence.

## GitHub release job (later slice)

GitHub is a publication destination, not the daily work authority. An owner setting chooses weekly or monthly release cadence or disables publication. The scheduled job selects only the latest deployed, healthy candidate not already released, then:

1. creates a clean public-source worktree at the deployed revision;
2. runs the private-name/secret guard and the full public release profile;
3. builds a changelog from accepted improvement records using bounded public summaries;
4. creates one squash release commit on the public release branch;
5. creates an annotated version tag and release artifacts with digests; and
6. records the remote commit, tag, artifact digests and publication outcome.

Publication requires separate current GitHub release credentials held by the release service, never a worker. A candidate can be deployed privately without being publishable. A guard failure, remote conflict, lost acknowledgement or partial upload records blocked/uncertain and does not move or recreate a tag blindly.

## Security invariants

- Workers never read or write the live installation, protected configuration, database credentials, service manager or deployment signing key.
- Worker and checker sandboxes operate only on isolated candidate worktrees and disposable test databases.
- Only a current, one-use, signed owner deploy approval can cross from accepted candidate to live mutation.
- Accepting a result, passing tests, lead sign-off and accepting an update candidate are quality/intent records, not deployment authority.
- Security, authentication, authorization, database, ingress, installer, supervisor and release changes require independent review by a principal distinct from the builder.
- Database changes require the assigned migration range, real-PostgreSQL production-role tests, least-privilege grants, down/refusal behavior, ledger verification and a recomputed schema digest.
- Browser output contains no repository paths, machine names, secrets, private hostnames or raw worker output.
- Every command is idempotent and bound to immutable evidence. Uncertain effect outcomes stop the state machine.

## Delivery slices

1. **First slice (this document):** built-in template, improvement request → pipeline run, update-candidate/owner-decision records, Home “Update ready”, and explicit inactive deploy/restart copy.
2. **Candidate publication:** private repository binding, changed-path classifier, sandbox test runner evidence, independent-review binding and lead publication from a successful pipeline.
3. **Signed approval:** durable upgrade request/approval tables, strong-session signature, exact migration/release/rollback binding and in-app Approve.
4. **Safe deploy:** verified backup, rehearsal, database upgrade, build, graceful restart, health checks, automatic rollback and uncertain-state recovery.
5. **Release train:** weekly/monthly setting, public-name guard, changelog, squash commit, version tag, artifacts and publication reconciliation.

