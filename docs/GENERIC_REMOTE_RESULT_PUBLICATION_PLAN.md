# Generic remote result publication plan

**Status:** source-design checkpoint, September 24. This is the next
multi-computer package after receipt-bound remote result ingress. It creates
no service, worker, database, credential, network route, or task.

## Plain-English purpose

The remote-worker path can now accept a worker's signed progress update or
final report for the one task that was already delivered to that worker. It
does **not** yet save the actual result, put it in the owner review screen, or
call the task finished.

This plan closes that gap by reusing the product's existing safe result-saving
and owner-review machinery. It does not create a second result system for
remote machines.

## Reuse that is already available

| Need | Reuse | Why it remains authoritative |
| --- | --- | --- |
| Save one result safely | `publishDurableResultV1` | Stores exact bytes, checks them, records one receipt, and handles exact replay after restart. |
| Prevent concurrent duplicate saves | `DurableReservationPostgresPort` and migration 0077 | The existing PostgreSQL reservation row locks one result lineage. |
| Put saved work in owner review | `DurableResultReviewSubmissionServiceV1` | Re-reads saved evidence and registers the existing pending-review target. |
| Let the owner review/correct it | `WebTaskReviewService` and `TaskQualityCoordinator` | Existing review, correction, capacity, and completion lifecycle. |
| Prove the result is still the same | remote enrollment, delivery receipt, and signed session | Already bind the machine, worker, task, and current connection. |

## Missing pieces that must be built before publication

1. **Exact result material.** The current final remote report has only a
   digest, not the result text or a protected read handle. A new bounded
   result-material frame must carry at most the existing 64 KiB text limit,
   with no secrets, files, private paths, or provider transcript.
2. **Durable remote terminal record.** The current final report is remembered
   only during its current session. Before saving bytes, the controller needs
   one canonical record that binds the signed terminal event, delivery receipt,
   enrollment, and content digest so a reconnect can replay the same result
   without rerunning work.
3. **Recorded run and lifecycle facts.** The existing durable publisher checks
   a canonical run record. Remote delivery must create or bind that run before
   execution and retain only verified start/finish timing and lease facts.
4. **Private composition.** The installed remote composition, not a browser or
   worker-supplied callback, must assemble the existing PostgreSQL reservation
   port, protected artifact storage, result/review keys, review submission,
   and authority check.
5. **Read and completion bridge.** The existing result reader and quality
   coordinator need a remote-capable inspection source. It must re-read the
   durable receipt, review plan, profile, run, and terminal record before it
   permits a review, correction, capacity release, or completion.

## Required ordering

1. Write a source-only remote terminal-material and durable terminal-record
   contract. It must be bound to the existing delivery receipt; it must not
   launch, retry, or complete work.
2. Add the private composition that re-reads that record and calls the existing
   durable publisher. Use the PostgreSQL reservation adapter already present;
   do not add a table or a new result store.
3. Add the remote inspection bridge to the existing owner-review and quality
   paths. Result publication still means “waiting for review,” not “approved.”
4. Test one saved result, exact restart replay, wrong-worker and changed-byte
   refusal, disconnection before/after saving, review, correction, capacity
   release, and final completion.
5. Only after source proof, mount the same components in the protected installed
   worker composition and run the separately authorized two-node proof.

## Non-negotiable boundaries

- One Control Room PostgreSQL database remains the authority.
- The current scheduler, review flow, and result reader remain the only ones.
- A remote worker never approves itself, frees capacity, or turns a result into
  task completion.
- No generic broker, alternate queue, synchronization service, or second
  database is allowed.
- A network disconnect or storage uncertainty stays unresolved; it never
  silently causes a rerun or a replacement result.

## Acceptance evidence

Extend the existing durable publication, review-submission, task-reader,
quality, revision, and two-worker conformance tests. Use disposable data only.
The package is not considered live until a protected installed composition and
the controlled two-node proof both pass.
