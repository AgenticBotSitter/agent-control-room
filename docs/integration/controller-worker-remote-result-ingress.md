# Generic remote controller-worker result ingress

This source-only boundary accepts signed generic progress and terminal evidence
only after the controller can reread both of these existing canonical records:

- the current remote-worker enrollment, including the current node key; and
- the exact controller-worker delivery receipt for the same task attempt.

Every return binds the delivery ID and digest, full delivery receipt, tenant,
project, task, attempt, node, worker, enrollment digest, current connection,
event sequence, event time, and event digest. The authenticated server session
does not expose a result store. The private installation composition owns the
branded receiver and rejects structural copies, proxies, revoked enrollments,
changed receipts, changed workers, changed sessions, duplicate or out-of-order
progress, and changed terminal replays.

Accepted values are inert evidence. They do not start work, authorize a retry,
record task completion, release capacity, publish a result, or update a task,
attempt, lease, review, or artifact record. A lost terminal reply may later be
presented on a newly authenticated session only as fresh inert evidence after
that replacement composition rereads the same enrollment and receipt. This
package deliberately has no durable generic result-evidence record yet, so it
does not call that a replay or claim a saved terminal outcome. It never resends
the delivery.

## Deliberately missing publication seam

The repository has harness-specific durable result publishers, but it has no
reviewed generic controller-worker publisher that maps this evidence to the
canonical result, review, task, attempt, lease, and capacity lifecycle in one
transaction. Selecting one of those effects, its exact result content schema,
terminal idempotency record, review policy, and capacity-release ordering is an
architecture and authority decision. This package therefore stops before that
decision. A later package must supply a private, canonical publisher that
rereads this authenticated evidence and preserves the existing single database
and scheduler; it must not turn this ingress into a broker, second queue, retry
loop, storage authority, listener, or worker launcher.
