# Remote terminal record decision

**Status:** accepted source design, September 24. No migration, database
operation, service, or worker is performed by this document.

**Source progress:** `remote-terminal-record.ts` supplies the strict,
data-only stable identity contract and focused disposable checks. A first
ledger-writing draft was rejected by independent security review because it
did not bind the worker, delivery receipt, and enrollment to durable authority
inside its transaction. It was removed before commit. The later private ledger
ingestion, bounded byte material, and publisher mounting remain separate.

## Decision

Use the existing append-only **harness run and harness-run-event ledger** as
the canonical home for a generic remote worker's durable terminal record.
Do not create a second “remote result” table.

Each accepted remote delivery must already have one canonical harness-run row
with the delivery's run, project, job, attempt, node, adapter, connector
profile, and authority identity. A completed remote return then appends one new
typed terminal event to that same run ledger. The new event type will contain
only:

- a stable terminal identity derived from the saved delivery, enrolled worker,
  enrollment revision, completed outcome, content hash, and byte count;
- the existing receipt and enrollment digests;
- the bounded terminal evidence digest; and
- safe observed start and finish times.

It will **not** contain result text, model prompts, provider details, file
paths, credentials, or private transport information. Result bytes stay with
the existing protected artifact storage and durable publisher.

## Why this is the right reuse

`HarnessRunStoreV1` already locks a run, sequences append-only events, hashes
and authenticates each event, detects a changed replay through its source-event
key, and makes terminal run states immutable. That provides exactly one durable
record per accepted terminal event without adding another authority database or
queue.

## Reconnect rule

A signed network envelope is intentionally short-lived and includes its
connection and sequence. It is not the durable identity. On reconnect, the
worker may send a fresh authenticated envelope that names the same stable
terminal identity. The controller re-reads the run ledger:

- the same identity and content facts return the existing terminal record;
- changed content, outcome, worker, enrollment, receipt, or lineage refuse;
- a missing record may be appended only if current delivery, enrollment,
  authority, lease, and deadline checks pass.

## Required source packages

1. Extend the shared harness-event schema with a narrowly typed
   `remote_terminal` event and a private authenticated ingestion method that
   locks and verifies the durable delivery, enrolled worker, and current
   authority before it changes a run.
   Generic callers cannot append it.
2. Make remote delivery create/reuse the canonical harness run before any work
   is represented as started. The stored run identity is re-read at terminal
   ingress.
3. Define a bounded completed-result material frame whose bytes hash and length
   must equal the durable terminal event. Failed, cancelled, or uncertain
   terminal states have no publisher route.
4. Privately compose the existing durable publisher, PostgreSQL reservation
   adapter, review-submission service, and remote inspection source. Publication
   is still pending owner review, never automatic completion.

## Accepted safe-ingress build order

The receipt, worker-enrollment, dispatch-intent, lease, and run-ledger records
already exist, but are not yet one complete authority chain. In particular, a
receipt alone does not retain the worker-enrollment revision, and remote
delivery does not yet create the canonical run record that a terminal result
would later close. The next package must close those links together; it must
not add a result table, second scheduler, or general-purpose message broker.

1. When a receipt is accepted, create or replay one **discovered** remote run
   in that same protected database operation. Its narrow registration carries
   the existing lease, input, delivery, receipt, enrollment, and deadline
   fingerprints. Registration does not mean that work has started.
2. Add the typed terminal event to the existing run ledger, but reject it from
   the public append API just as native snapshots are rejected today.
3. Mint a one-use terminal intake only from the already protected remote
   controller composition. A copied object, a browser caller, or a generic run
   store must not be able to manufacture that intake.
4. In one database transaction, the intake rereads and locks the current
   enrollment and node key, exact receipt, signed dispatch intent, registered
   run, task attempt, and lease. It compares every worker, node, delivery,
   receipt, enrollment, run, attempt, lease, deadline, content, and timing
   fingerprint before it appends the terminal event.
5. Immediately before commit it rereads the current session and authority. An
   exact reconnect replay returns the existing event; changed evidence or any
   expired, revoked, missing, or foreign binding is refused.

The private intake must reuse these existing parts: the remote materialization
reference and prepared delivery, signed terminal-return contract, current
enrollment reader, delivery-receipt reader, task-plan read, and the run
ledger's authenticated sequencing. It must add only the narrow locked helpers
required to join them.

Required disposable proof includes a successful first record, exact reconnect
replay, changed-evidence refusal, foreign-worker refusal, missing/rejected
receipt refusal, lease/authority expiration, node-key rotation, enrollment
drain/quarantine/revocation, concurrent completion versus revocation, and
transaction rollback. It must also prove that recording alone publishes no
bytes, completes no review, releases no capacity, retries no work, and starts
no worker.

## Crash and review handling

If the terminal record saves but artifact storage or publication is uncertain,
the terminal remains visible as unresolved evidence; work is not rerun. If
publication succeeds but review submission fails, the existing publisher's
review-recovery path re-reads the durable receipt instead of rerunning the
worker. Capacity is released only later by the existing quality coordinator
after a verified inspection and owner review.
