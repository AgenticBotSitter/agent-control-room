# Node-owned observation reporting acceptance

Date: 2026-09-06. Base: `bc8074a` (PR #340).
Production: `d5c1ab9`, overlap correction `23fe5aa`, publication capture `8c5f861`,
and recovered-ACK correction `5220164`.
Contract: `CR14C_NODE_OBSERVATION_REPORTING_CONTRACT.md`.

## Delivered

An optional native execution handoff reports its saved observations after already
authorized start/poll/observe operations. A separate read-only reporting owner can
read the original signed delivery and existing native journal without constructing
execution authority or making a provider call. It publishes sanitized metadata
through the existing durable bridge outbox and supplies exact saved completed bytes
to the trusted result sender. Its receipt explicitly does not claim server acceptance.

The retained-journal integration reuses the same native, delivery and bridge journals
across transport replacement. It exercises offline pending evidence, sent evidence
with a lost server ACK, and acknowledged duplicates. Saved completed bytes reach the
existing pending quality review; no additional native operation or canonical execution
change occurs after the reconnect baseline.

The host ingress ordering is explicit test composition, not an installed service:
finish reconciliation, hold the full frame suffix starting at the first replayed
snapshot, recover the server binding, then drain every frame in original sequence
order. Recovered server sessions now permit the existing validated ACK path, but not
unknown ACK references, new reconciliation reports or delivery reopening.

## Verification

- Root stage zero: `ready_for_runtime_check`; no native readiness/qualification.
- Final combined reporting, lifecycle, ACK, handoff, server-session, compiled and
  adapter-isolation run: **73 passed**, zero failures/skips (43 top-level tests plus
  nested cases). This includes existing regression coverage, not 73 new tests.
- Same-journal reporting integration separately passed all four cases after correction.
- Existing managed-session, revised-child and reconnect helper consumers: **39 passed**.
- Earlier execution/bridge/lifecycle/reconnect regressions: **40 passed**.
- Final TypeScript, full ESLint and all eight test-inventory checks passed. Four new
  source test files are registered in the standard test command. VPS Node build passed;
  three existing compiled managed-session checks passed against that rebuilt artifact.
- PR #340 at `bc8074a` passed all nine GitHub checks in run `34017036823`. It is open
  and unmerged; this block needs its own current-head CI and dependency-order integration.

Independent static review accepted the production corrections and final test evidence
with no remaining finding. The reviewer did not execute tests; root ran them centrally.
Two isolated workers authored bounded source-only integration and denial files. Both
reported `setup_required` (no local dependencies) and did not install or run runtime
tests. Root committed the first worker's stopped reviewed changes after its protected
Git metadata write failed. No dependency workaround or shared checkout was introduced.

## Retained failures and corrections

1. Independent review found that the adapter's operation slot ended before reporting
   finished, allowing another provider operation during publication. `23fe5aa` adds
   a handoff-level slot through both operations. A held-publication test proves overlap
   is rejected before provider I/O, does not poison the first call, and permits a later
   ordinary poll after successful completion.
2. The first actual retained-journal integration run had **two pass and two fail**.
   The driver held replayed snapshots but routed a later ACK ahead of them, violating
   authenticated sequence order. The corrected driver (`f49a9cc`) holds and drains
   the entire suffix. `5220164` permits the trailing validated ACK in recovered state.
   All four corrected cases passed; no frame or sequence was dropped or invented.
3. The initial reporter/ACK run had **32 pass and one fail**: root's unknown-ACK test
   used invalid sequence ceiling zero and failed schema construction before reaching
   the intended check. It now signs a schema-valid ACK with ceiling one and an unknown
   message ID. Both ACK negative tests and the final combined suite passed.
4. Root added cloned publisher input, explicit body-digest checking and strict returned
   disposition validation. Independent review accepted these; mutation and malformed
   disposition tests passed. These were defensive review changes, not a live incident.

## Limits and next work

All provider behavior is fake; canonical setup remains privileged synthetic fixture
work. There is no live listener, credential operation, physical PostgreSQL, deployment,
agent installation or new owner-signing custody. A five-second reporter timeout closes
new reporting but does not erase durable queued evidence; bridge ownership remains
responsible for transport replacement and late signing/send fences. Private result
text is returned only through the exact-body trusted byte-read seam, never in status.

Next, replace the explicit test ingress driver with a bounded runtime input owner that
serializes handshake/recovery/progress/ACK routing and cannot reorder or restart work.
Owner signing, scoped host/database preparation and the first useful real task remain
later gates. PR #329's upstream completion issue is separate and unresolved. No merge
or deployment is claimed here.
