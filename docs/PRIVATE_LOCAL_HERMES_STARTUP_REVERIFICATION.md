# Private local Hermes startup re-verification

**Status:** source-only read gate with disposable test evidence. It does not
open PostgreSQL, start a queue, invoke Hermes, enable a worker, or perform a
native effect.

## Outcome

`private-local-hermes-startup-reverification.ts` closes the gap between a
completed owner setup and normal application startup. It reads the existing
settled installation journal, requires one exact current tip with every stage
passed, reconstructs the saved Hermes readiness receipt and final-review
evidence, and rechecks the exact current Hermes delivery object, qualified
runner and worker, queue database identity, role, concurrency, topology, and
release.

The resulting opaque receipt is required at the protected operator assembly
and again at the real task-start boundary. Generic readiness, backup, or
supervisor records are no longer enough to admit a local Hermes callback. A
missing, incomplete, stale, substituted, unsettled, or foreign proof refuses
before artifact storage, database pools, workers, or an agent can be opened.
Owner-admission preparation can still run before this receipt exists; only
actual application startup requires it.

## Reuse decision

The decision is **retain and narrowly adapt existing Control Room code**. The
package reuses the settled installation-journal reader, owner-admission
receipt calculation, final-review binding calculation, private Hermes
composition registry, and existing task-startup gate. This is a
repository-specific authority seam; importing another project's scheduler,
database, session store, credential store, or agent framework would duplicate
authority. No third-party source is copied and no notice changes are needed.

## Verification

Focused tests cover exact settled startup, incomplete or unsettled history,
generic-readiness bypass attempts, substituted callback identity, runner,
worker, queue role and concurrency drift, topology and release drift, and the
existing owner-admission and final-review regressions. Construction and
verification are read-only and invoke no agent.

The remaining operational work is to run setup and final review against the
real private installation, then supply this receipt to the installed startup
composition. The first real task still requires its ordinary project, task,
lease, delivery, and review authority.
