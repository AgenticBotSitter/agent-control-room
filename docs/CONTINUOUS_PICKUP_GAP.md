# Consecutive agent tasks: remaining integration gap

2026-09-08, inspected against `68e8af3`. This is a source-backed completion plan,
not authorization to install a service or a claim of continuous fleet operation.

## What works and why a restart loop is not the answer

The existing one-task connector can exchange signed dispatch and progress, execute
through the approved runtime, register exact result bytes and recover an uncertain
result response without restarting the native run in disposable integration tests.
Its caller owns retained journals. Native host acceptance remains separate.

Three bindings deliberately restrict the current composition:

- `src/web/v1/native-http-host.ts`: every authenticated mTLS peer captures one exact
  `task`; opening a connection passes that configured task to `attachWire`.
- `src/web/v1/managed-native-sessions.ts`: `attachInputOwned` pins that task's attempt
  and creates one `ManagedNativeInput`; delivery refuses a different attempt.
- `src/harness/hermes-native-v1/node-runtime.ts`: one runtime captures one `queueId`
  and refuses signed dispatch for another queue item. The connector owns one run
  and closes its runtime/client at the end.

Consequently a launcher restart does not discover the next job. Removing the queue
or attempt checks would remove protection, not add a valid scheduling mechanism.
An ordinary job-offer record is not sufficient to construct a native runtime.

## Next implementation slice

Design and review server-side selection of the next **already authorized canonical
task** for an authenticated idle node. Reuse installed pg-boss, `NativeQueueAuthority`,
verified delivery envelopes and managed per-attempt sessions. Do not add another
queue, scheduler or machine transport. The node must not choose an arbitrary task
ID and have that choice interpreted as execution authority.

The matching node composition must create a fresh task-bound runtime from accepted
dispatch and retained durable evidence, preserve the existing per-task restrictions,
and close/drain the old runtime before admitting another task. Define restart and
drain behavior before enabling automatic pickup. A server-side selector alone is
not a complete deliverable; both ends and their combined acceptance must work.

This requires an architectural lifecycle decision, not just operator values. No
new selection protocol, migration, dynamic peer mode or daemon is approved by this
gap report. The existing single-task path remains supported while this is built.

## Required acceptance for the combined slice

1. Two separately approved tasks assigned to the same node complete sequentially,
   retaining distinct attempts, source digests, results and review destinations.
2. Reconnect reconciles the exact outstanding task, never an unrelated or already
   executed task. Restart does that reconciliation before considering fresh pickup.
3. Ambiguous delivery, runtime state or resource cleanup blocks next-task admission;
   no uncertainty becomes an automatic retry or permission to discard journals.
4. Revoked approval, expired lease, disabled node and incompatible enrollment/profile
   each refuse pickup through existing authoritative checks.
5. Draining blocks fresh pickup while preserving current-task/result evidence.
6. An idle node with no eligible work does not spin, create attempts or consume a
   provider call. Bounded waiting is not falsely reported as a completed task.

Run these first with disposable canonical storage, synthetic signatures and fake
native transport. Passing them supports local integration only. Real Mac/VPS/Windows
setup, owner keys and provider qualification still need their own explicit scope.

Independent source audit identified the bindings above; the lead inspected the
actual peer attachment, managed attempt check and queue dispatch guard. No live
node, GitHub action, credential store or production service was used for this audit.
