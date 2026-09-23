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

The candidate register remains the source for pinned revisions and individual
findings: [REUSE_CANDIDATE_REGISTER.md](REUSE_CANDIDATE_REGISTER.md).
