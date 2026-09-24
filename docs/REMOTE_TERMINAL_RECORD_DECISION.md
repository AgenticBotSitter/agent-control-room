# Remote terminal record decision

**Status:** accepted source design, September 24. No migration, database
operation, service, or worker is performed by this document.

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
   `remote_terminal` event and add a private authenticated ingestion method.
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

## Crash and review handling

If the terminal record saves but artifact storage or publication is uncertain,
the terminal remains visible as unresolved evidence; work is not rerun. If
publication succeeds but review submission fails, the existing publisher's
review-recovery path re-reads the durable receipt instead of rerunning the
worker. Capacity is released only later by the existing quality coordinator
after a verified inspection and owner review.
