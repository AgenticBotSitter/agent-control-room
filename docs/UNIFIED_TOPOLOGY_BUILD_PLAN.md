# Unified installation build plan

Agent Control Room has two installation choices:

- **This computer** — the controller and one or more workers run on the same
  computer.
- **Several computers** — the controller reaches enrolled workers on other
  computers.

They are two ways to run one product. They do not create separate products,
forks, databases, schedulers, permission systems, or task lifecycles.

Any substantial new component in either route must pass the documented
[reuse-before-custom decision gate](REUSE_DECISION_GATE.md). The installation
choice never justifies adding a second scheduler, authority database, or
agent framework.

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
- a read-only installation-topology plan that gives both setup choices one
  migration-safe configuration record. It refuses one worker being assigned to
  both routes, treats a changed worker route or adapter as a fresh recheck,
  preserves the selected database and scheduler authority
  fingerprints, and lists the owner proofs required before any worker is
  enabled. It does not create, connect, launch, or enable anything.
- the protected Workers page now presents that reviewed setup plan beside the
  existing saved connection inventory. It keeps planned routes, recorded
  signals, and a running agent distinct; it shows no worker identifiers,
  host details, credentials, or start controls.
- a plan-bound, read-only proof-status surface now shows which setup checks are
  not started, passed, failed, or unavailable. It accepts only non-secret
  evidence fingerprints, cannot enable workers, and does not make missing
  proof records look successful.

## U1 — local worker foundation

Completed in source:

- a local Hermes JSON-lines result adapter;
- bounded result and token accounting;
- a connector profile that records exactly what has and has not been proven;
- shared terminal evidence for a completed local Hermes result.
- an owner-run, text-only qualification launcher with a bounded one-turn
  invocation and sanitized output.
- a separate owner-run qualification launcher for the exact fixed-argument
  local runner bridge. It produces only a bounded, plan-bindable evidence
  fingerprint and cannot create a task, configure a worker, or enable work.
- an effect-free preflight for that runner. It checks only that the
  installation-selected program and working directory are usable and redacts
  those values from its result, so it cannot spend a real qualification on an
  avoidable local configuration error.
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
- immediately before the local launcher can create a run record or contact
  Hermes, that prepared packet is rechecked against the same authoritative
  task, lease, plan, worker binding, authority, and review contract. A late
  revoke, expiry, reassignment, or changed binding refuses the launch; this
  adds no new scheduler, database, authority, or automatic retry.
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
- the existing protected task queue now accepts a separately authenticated
  Hermes-0.21 local intent. Its companion approval evidence and queue record
  are HMAC-protected, bind the exact reviewed V5/V6 plan, lease, authority,
  route and connector profile, and are rechecked at queue pickup. This is the
  existing scheduler and database, not a second local queue; no queue write
  starts Hermes. The lifecycle has an explicit, guarded injection point for a
  verified pickup. The local executor bridge converts only that verified
  pickup into the existing dispatch, controlled-runner and pending-review
  composition; the normal startup configuration accepts this local route
  without requiring a remote-session transport. Constructing either bridge
  does not start Hermes.
- the normal operator configuration assembly now accepts an
  installation-owned local Hermes executor for that queue route. It preserves
  the same one-database startup composition and does not require a remote
  session manager; construction captures the callback but cannot invoke
  Hermes.
- the shared native queue-worker contract is now exercised with the local
  Hermes route itself: it reconstructs the approved packet, rechecks the
  local route, invokes the private executor once, records the ordinary
  pending-review result, and rejects an exact replay without a second Hermes
  invocation. This is a disposable source test; it is not a live worker
  activation.

Remaining before an automatic local worker is enabled:

- a successful owner-attended, text-only qualification recorded for the
  individual installation. Source code cannot claim that an installation has
  passed; it accepts only a fingerprint derived from the check's sanitized
  successful report;
- a separately recorded successful owner-attended qualification of the exact
  Control Room runner bridge. The text-only check proves Hermes can respond;
  it does not prove the runner that receives Control Room work can reach it;
- a controlled local data directory, restart procedure, and backup/restore
  proof.
- owner selection and installation-owned binding of the tested stream-json
  runner bridge to the actual Hermes process, followed by a real local restart
  proof. This must retain the owner's existing tool, model, provider and
  workspace rules privately; source code must not guess or record them.
- a successful owner-attended qualification, local data recovery proof, and
  terminal-byte recovery remain separate prerequisites for enabling an
  automatic local worker. The disposable local/remote lifecycle and correction
  conformance proofs do not replace them.

The permanent local-installation recovery model, including the boundary
between the one authoritative database and local result bytes, is documented
in [LOCAL_INSTALLATION_OPERATIONS.md](LOCAL_INSTALLATION_OPERATIONS.md).
The single operator procedure that proves either installation choice is
documented in [UNIFIED_OPERATOR_PROOF_RUNBOOK.md](UNIFIED_OPERATOR_PROOF_RUNBOOK.md).

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
  saved result receipt, one ordinary pending-review record, and no delivery to the other worker. Separate shared
  local/remote journeys cover normal review and correction handling.

Remaining:

- delivery acknowledgement through a real enrolled transport, including its
  verified adapter-version compatibility boundary and the same result, review,
  and correction path.

The source-side private certificate-checked transport host is already composed
behind the existing managed-session service. Enabling it and running a genuine
two-computer proof remain owner-authorized operations; the proof sequence is
in [UNIFIED_OPERATOR_PROOF_RUNBOOK.md](UNIFIED_OPERATOR_PROOF_RUNBOOK.md).

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
