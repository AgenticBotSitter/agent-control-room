# Unified installation build plan

Agent Control Room has two installation choices:

- **This computer** — the controller and one or more workers run on the same
  computer.
- **Several computers** — the controller reaches enrolled workers on other
  computers.

They are two ways to run one product. They do not create separate products,
forks, databases, schedulers, permission systems, or task lifecycles.

## Non-negotiable decisions

1. Each installation has one authoritative PostgreSQL database. Local workers
   and remote workers both receive tasks derived from that authority; neither
   becomes a second source of truth.
2. A task has one identity and one delivery digest regardless of where its
   worker runs. The route is local or remote delivery information, not part of
   the task's authority or a reason to rewrite the task.
3. The existing scheduler remains the only scheduler. A local launcher may
   wake a worker, but may not invent a second queue or silently retry a task
   whose start or result is uncertain.
4. Workers return evidence and results. They do not approve their own work,
   release capacity, or turn an uncertain delivery into a completed task.
5. Private details — executable locations, logins, selected models, provider
   settings, workspaces, and network routes — stay in the installation-owned
   runner. They are not Control Room task data.

## Shared lifecycle

Every worker follows the same sequence:

1. Control Room creates a task, its allowed work, and its review requirement.
2. The controller creates one signed-by-digest delivery packet.
3. A local or remote route receives that exact packet and returns a receipt.
4. The worker produces a bounded terminal result or an explicit failure or
   uncertainty.
5. Control Room records the result as evidence, stores the result through its
   existing result path, and presents it for review.
6. Review either accepts it, requests a correction, or closes it without
   claiming that an uncertain run succeeded.

The local and remote routes are interchangeable at step 3. The controller,
result, review, correction, and audit records do not change.

## U0 — topology-neutral foundation

Completed in source:

- a shared controller-to-worker delivery packet and receipt;
- separate local/remote route selection that cannot alter packet identity;
- tests proving a packet cannot be delivered to the wrong worker or accepted
  with an altered receipt.
- one append-only, signed receipt record in the installation's existing
  PostgreSQL database. It records a local or remote acknowledgement exactly
  once, survives a controller restart, and cannot start a worker or grant new
  authority by itself.
- a common local completed-result composition that derives the result binding
  from the controller-prepared packet, then uses the current durable result
  and review services. It does not rerun a task when a prior delivery was
  recorded, and it does not claim recovery of terminal bytes it did not save.
- disposable conformance journeys that carry both a complete task/result/review
  lifecycle and its correction/revised-result lifecycle through either local or
  remote route metadata while preserving the same canonical records and one
  database. These are route doubles, not installed transport claims.

## U1 — local worker foundation

Completed in source:

- a local Hermes JSON-lines result adapter;
- bounded result and token accounting;
- a connector profile that records exactly what has and has not been proven;
- shared terminal evidence for a completed local Hermes result.
- an owner-run, text-only qualification launcher with a bounded one-turn
  invocation and sanitized output.
- composition that sends a verified local Hermes terminal result through the
  existing durable-result receipt and pending-review services, including
  restart-safe exact replay.
- a normal local-runner seam that requires the Mac-owned policy to approve the
  exact controller packet before Hermes can be invoked.
- local delivery composition that records Marvin's accepted shared receipt in
  the one authoritative database before invoking the controlled runner. A
  restart sees that receipt and refuses to automatically invoke the same task
  a second time.
- a versioned Hermes-0.21 task plan that binds the reviewed connector profile,
  task type, and worker capability rather than reusing an unpinned legacy
  Hermes plan, including a separate correction-task form.
- the existing task-assignment coordinator accepts that same pinned local
  worker capability, so Marvin uses the ordinary bounded lease path rather
  than a second local scheduler.
- dispatch preparation now locks and rechecks that ordinary assignment, its
  active lease, the matching task plan, and the pinned Hermes profile before
  it creates the shared local delivery packet. It starts neither Hermes nor a
  second queue, and is covered by the same local/remote receipt tests.
- an application composition now connects that prepared packet directly to
  Marvin's controlled local delivery seam. The first accepted handoff invokes
  the injected local runner once; an exact restart replay reports the earlier
  delivery and never invokes Marvin twice.
- the completed-record publisher now accepts only a verified terminal record
  from the local runner and creates the normal pending-review item with exact
  replay protection. The normal in-process composition derives its result
  binding only from the controller-prepared packet and invokes that existing
  publisher; Marvin cannot accept its own result.
- a normal harness-run record is created before the controlled local launcher
  is called. It binds the run to the task, attempt, approved authority, and
  connector profile without recording a local login, model, provider, or
  workspace.
- the same harness-run history now records the controlled launch as starting,
  running, bounded usage, and succeeded (or an explicit failed/disconnected
  outcome). A restarted handoff reuses its matching historical run and does
  not create a second Hermes invocation or rewrite that history.
- durable result publication now checks the recorded task-authority fingerprint
  separately from the completed-result fingerprint. This avoids treating a
  result's contents as if they were the task's approval while preserving both
  checks before a pending-review record is written, and also refuses a result
  when the task's current recorded authority no longer matches the run.
- a protected terminal-result staging contract now lets the installation-owned
  local runner save one exact terminal Hermes line before it returns. An exact
  delivery replay can read that saved line and continue ordinary publication
  without launching Hermes a second time. The staging bytes are not task
  ownership, a retry queue, or a second database.

Remaining before an automatic local worker is enabled:

- one owner-attended, text-only qualification using the existing Hermes login
  that completes successfully (the first bounded attempt ended before model
  use; its sanitized report is evidence of a failed qualification, not an
  operational worker);
- a controlled local data directory, restart procedure, and backup/restore
  proof.
- installation-owned binding of the tested stream-json runner bridge to the
  actual Hermes process, followed by a real local restart proof.
- a successful owner-attended qualification, local data recovery proof, and
  terminal-byte recovery remain separate prerequisites for enabling an
  automatic local worker. The disposable local/remote lifecycle and correction
  conformance proofs do not replace them.

The permanent local-installation recovery model, including the boundary
between the one authoritative database and local result bytes, is documented
in [LOCAL_INSTALLATION_OPERATIONS.md](LOCAL_INSTALLATION_OPERATIONS.md).

## U2 — several-computer delivery

Completed in source:

- a remote-worker enrollment contract with no host, address, key, or tunnel
  material;
- adapter-version compatibility checks before remote delivery;
- explicit refusal of revoked workers; and
- disconnect and timeout outcomes that remain uncertain and never retry on
  their own.
- controlled reconnect reconciliation that accepts only a receipt for the
  original packet and never retransmits it; an exact recovered receipt is
  retained through the same PostgreSQL receipt record used for local delivery.
- a disposable two-enrolled-worker proof: a task stays with its intended
  worker even when another worker reconnects, while incompatible or revoked
  workers cannot become a ready substitute. This is not a real transport or
  machine-enrollment claim.
- the same temporary two-worker proof now carries the intended worker's
  progress and completed result through the managed result receiver, with one
  saved result receipt and no delivery to the other worker. Separate shared
  local/remote journeys cover normal review and correction handling.

Remaining:

- delivery acknowledgement through a real enrolled transport, including its
  verified adapter-version compatibility boundary and the same result, review,
  and correction path.

## Acceptance checks

Before either installation choice is described as operational, prove all of
the following with disposable data:

- the same task works through a local route and a remote-route test double;
- an altered packet, altered receipt, wrong worker, duplicate terminal result,
  lost reply, and restart are each handled honestly;
- a completed result reaches review exactly once;
- local and remote routes cannot produce a second authoritative result;
- no private configuration or credential appears in Control Room records,
  logs, tests, or public documentation.
