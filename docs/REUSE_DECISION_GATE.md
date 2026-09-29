# Reuse-before-custom decision gate

Agent Control Room should connect dependable components, not recreate them.
This gate applies before a new **substantial** application service, adapter,
transport, scheduler, storage layer, review tool, or user-interface subsystem
is added. It does not apply to a small bug fix, a test, an integration shim, or
the narrow Control Room-specific rules that keep one task, review, approval,
and evidence history coherent.

## The required decision record

The person proposing a substantial new component records all of the following
in the relevant issue, pull request, or design note:

1. **The job to be solved**, in plain language and with the existing Control
   Room contract it must preserve.
2. **The existing component already in Control Room** that may solve it. This
   includes installed dependencies such as PostgreSQL, pg-boss, and React.
3. **Up to three credible external candidates**, with an exact pinned revision,
   license, and the exact files or API surface inspected. More candidates are
   useful only when they solve materially different versions of the problem.
4. **A fit result** for each candidate: adopt, adapt, retain an existing
   dependency, defer, or reject. "Interesting" and a README-only review are
   not a fit result.
5. **A concrete replacement calculation**: which Control Room files or planned
   work the adopted part removes, and which thin glue remains ours.
6. **A safety and authority check**: the candidate must not add a second
   scheduler, database authority, worker permission path, credential store, or
   automatic effect path.
7. **Attribution and proof**: copied or adapted material is pinned, noticed in
   `THIRD_PARTY.md`, and tested with disposable data before it is retained.

If no candidate fits, custom code is allowed only when the record explains the
specific incompatibility. "It would be faster to write" is not enough.

## What remains deliberately ours

Control Room still needs a small product-specific layer that outside projects
cannot safely supply: the task identity, assignment lease, delivery digest,
result receipt, review/correction state, owner authority, and the rule that
one installation has one PostgreSQL authority. This layer should be thin. It
may call a proven queue, database, UI library, harness interface, or
read-only monitor, but it must not duplicate them.

## Minimum self-hosting slice reuse record

The minimum self-hosting slice keeps every existing authority below in its current
role. The intake and pipeline records annotate those authorities; they do not replace
or bypass them.

| Existing record or boundary | Reuse decision |
| --- | --- |
| `projects` | Remains the tenant-scoped lifecycle and project boundary. Intake, queues and pipelines stop when the project is not active. |
| `control_requests`, `control_workflows`, `control_jobs` | Remain the canonical request, workflow and task truth. Approved batch items and pipeline stages materialize through this domain. |
| `control_attempts`, `control_leases`, `control_job_dependencies` | Remain execution lineage, exclusive assignment and dependency order. Intake and pipeline tables do not duplicate attempts, leases or edges. |
| `control_effect_intents`, `control_approvals` | Remain the only consequential-effect intent and approval records. Neither a proposal, pipeline stage nor review grants an effect. |
| `control_completion_gate_records` | Remains the profile, target, review, verification, finding, revision, preference and approval-decision ledger. Its `revisionNumber` is the only correction-round counter. |
| `control_project_coordination_proposals` and `src/project-coordination/v1/` | Supply the strict, bounded, acyclic proposal and admission rules. Work intake extends the task fields but does not add a second planning authority. |
| `control_artifact_manifests` | Remains bounded result and evidence provenance. Pull-request evidence is a URL and commit digest bound to the ordinary result; it is not a merge capability. |
| `control_idempotency` | Remains the replay boundary for proposal, approval, instantiation and transition commands. |
| `control_native_task_queue` and `control_room_queue.job` | Remain the single delivery intent and pg-boss scheduler job. Per-agent order admits only an eligible head item; it does not add another queue. |
| `audit_events` | Remains the append-only, hash-chained history for proposal, refusal, edit, decision, admission, run, check and result events. |
| `control_identities`, `control_role_grants` and `evaluatePolicy` | Remain machine identity and authorization truth. The intake credential is one existing-role grant containing only `work_batches.propose`, a low risk ceiling, no external effects and its project scope. |
| `WebSessionAuthority` | Remains the owner-only website command boundary for batch edits, approvals and rejections. A machine credential is never accepted there. |
| `notificationEnvelopeHasNoAuthorityV1` and the notification delivery ledger | Remain the notification safety and deduplication boundaries. A phone notification carries description and a deep link, never approval or dispatch authority. |
| `control_project_delegation_policies` | Remains the ceiling for sequential unattended advance. A pipeline setting can narrow that policy but cannot widen it. |
| `control_task_model_selections` | Remains the server-validated worker/model/effort choice. A requested intake value grants nothing. |
| `control_native_review_plans` and Completion Gate reviewer separation | Remain the server-created plan and independence boundary for an agent checker; human owner review continues alongside it. |
| `control_worktree_change_audit_plans`, `control_worktree_change_audit_records` and the Codex workspace lease | Remain the delivery-bound worktree scope, change-limit and preservation evidence. Pipeline code does not create another Git workspace authority. |

Only the following new records are justified. All are additive, tenant-scoped,
digest-bound and use restrictive lineage foreign keys.

| New record or column | Why the existing records cannot represent it safely |
| --- | --- |
| `work_batches` | Preserves exactly who proposed one batch, its project, state, immutable submitted digest and recorded queue-depth limit before any canonical task exists. |
| `work_batch_revisions` | Preserves every edited full proposal append-only, so submitted and approved content cannot be conflated by updating one row. |
| `work_batch_items` | Binds each selected or rejected local item to its decision evidence and eventual canonical `control_jobs` row without making the intake record executable. |
| `pipeline_templates` | Stores reusable ordered stage intent and safe settings. It has no authority foreign key and grants nothing. |
| `pipeline_runs` | Pins one template version and digest to one canonical request/workflow while retaining run-level presentation and lifecycle lineage. |
| `pipeline_stage_runs` | Holds one ordered stage projection and current canonical job/attempt pointers; complete attempt, dependency and revision history stays in the existing ledgers. |
| Nullable `control_jobs.stage_kind`, `stage_ordinal`, `pipeline_run_id` | Identifies ordinary jobs that belong to an ordered pipeline. The three values stand or fall together and existing rows are not rewritten. |

No new credential store, scheduler, task table, result table, review authority,
approval path or merge operation is justified or introduced.

## Current decisions

| Area | Decision | Reason |
| --- | --- | --- |
| PostgreSQL access and the task queue | Keep `pg` and `pg-boss`. | They already provide the database connection, durable job queue, and schedules without a second authority. |
| Website | Keep React and existing Control Room screens; consider narrowly adapted UI patterns only when they replace a real screen or interaction. | A whole external dashboard would replace identity, review, and authorization assumptions that Control Room must retain. |
| News and ABS collection | Keep the adapted `mreflow/control-center` source. | It already replaces real feed discovery, reading, safe-fetch, freshness, and curation code. |
| Hermes execution | Use Hermes-supported interfaces through the narrow Control Room adapter. | Modifying Hermes or importing a second agent framework would make upgrades and safety boundaries worse. |
| Session observation | Defer `herdrdev/herdr` to a read-only fit test. | It may improve visibility, but must never become task authority or a launcher. |
| Code review augmentation | Evaluate `alibaba/open-code-review` as a supplementary reviewer only. | It cannot approve, merge, handle credentials, or operate the worker queue. |
| Sandboxed code-writing executor | Do not adopt `jmanzo/ralph-sandbox` as-is. | Its runtime and credential assumptions conflict with Control Room; only later containment ideas may be independently rebuilt behind existing contracts. |
| Minimum self-hosting pipelines and agent work intake | Retain the existing canonical task, dependency, review, queue, audit and isolated-workspace components; add only the records justified above and one proposal-only grant. | The detailed reuse record above is the controlling ACR-006 decision. No outside component can replace this narrow lineage without creating a second task, queue, authorization or approval truth. |

The candidate register remains the source for pinned revisions and individual
findings: [REUSE_CANDIDATE_REGISTER.md](REUSE_CANDIDATE_REGISTER.md).
