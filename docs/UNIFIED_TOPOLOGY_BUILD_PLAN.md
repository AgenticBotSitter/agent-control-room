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

Remaining:

- connect the shared packet to the existing task dispatcher at the approved
  application composition point;
- add one common result-return composition that uses the current durable
  result and review services.

## U1 — local worker foundation

Completed in source:

- a local Hermes JSON-lines result adapter;
- bounded result and token accounting;
- a connector profile that records exactly what has and has not been proven;
- shared terminal evidence for a completed local Hermes result.

Remaining before an automatic local worker is enabled:

- an owner-configured local runner that has a restricted task policy;
- one owner-attended, text-only qualification using the existing Hermes login;
- a controlled local data directory, restart procedure, and backup/restore
  proof;
- composition with the durable result and review services.

## U2 — several-computer delivery

Build after the common local path is composed:

- enrollment of a remote worker with a versioned adapter profile;
- delivery acknowledgement, disconnect, reconnect, and revocation handling;
- a two-computer proof using the same shared delivery packet and result path;
- a compatibility rule that refuses a worker whose verified adapter version is
  not supported.

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
