# Unified task-dispatch composition

This document defines the next application-composition step for the shared
controller-to-worker delivery contract. It does not introduce a queue,
database, scheduler, or permission system.

## Existing authoritative sources

The existing task-assignment and planning services already own the facts a
worker packet needs:

| Packet fact | Existing authoritative source |
| --- | --- |
| tenant, project, job, prompt, instructions, input digest | canonical task-execution plan |
| authority digest and expiry | canonical job authority and active lease |
| attempt, node and lease epoch | canonical attempt and lease |
| acceptance profile | canonical task-execution plan |
| run identifier | already-created canonical harness-run record |
| worker adapter and exact connector profile | installation enrollment/configuration |

The composition reads and locks those records together. It must never accept a
worker packet, workspace, authority digest, profile digest, or run identifier
from a browser request or worker reply.

## One dispatch path

1. The existing scheduler or owner-approved assignment creates the canonical
   job, attempt, lease, and harness run.
2. The task-assignment coordinator locks and revalidates those records.
3. It creates one `controller-worker-delivery/v1` packet from those facts.
4. The selected route is local or remote, outside that packet.
5. The local policy or remote enrollment verifies the same packet before a
   worker is allowed to receive it.
6. A received receipt is stored once in the shared append-only
   `control_worker_delivery_receipts` record. It is delivery evidence only: it
   does not say a task ran, succeeded, or needs retrying.
7. A verified terminal result follows the existing durable-result and review
   path.

The route cannot change task identity. A disconnect stays uncertain. A
reconnect may reconcile only the original receipt and may not create another
task or transmit the packet again.

## Required connector-profile decision

The older `task-execution-plan/v1` and `/v2` Hermes-native plans intentionally
have no connector-profile digest. That was safe for their older native adapter,
but it is insufficient for Marvin's Hermes 0.21 adapter: Control Room must
bind the task to the exact reviewed connector profile and source revision.

Therefore the dispatcher must **not** reinterpret an old Hermes-native plan as
a Marvin 0.21 task. Control Room now uses the versioned Hermes-0.21
execution-plan forms: V5 for an initial task and V6 for a correction task.
They carry:

- the fixed Hermes-0.21 adapter identity;
- the reviewed connector-profile digest;
- the same canonical prompt, instructions, authority, acceptance profile,
  task, attempt, lease, and run lineage as existing plans.

They are read alongside—not substituted for—the existing V1/V2 plans. Old
plans stay on their existing adapter path or refuse if no qualified adapter is
available. This preserves compatibility without allowing an unpinned Hermes
version to receive work.

## What the schema change must prove

- a packet produced from the new plan has the same canonical task identity on
  local and remote routes;
- changing the adapter, profile digest, run, attempt, lease, authority,
  prompt, or instructions refuses before receipt or runner invocation;
- an old V1/V2 plan cannot enter the Hermes-0.21 path;
- one completed local or remote result enters the existing pending-review
  path exactly once; and
- no path creates a second scheduler, task table, database, or permission
  record.
