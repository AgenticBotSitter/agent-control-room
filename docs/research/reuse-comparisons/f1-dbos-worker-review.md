# Independent DBOS worker/review-wait review

2026-09-08. Read-only review of the actual worker fixture, worker-mode runner,
fit report, transcribed terminal receipt and the SDK source findings in
`f1-worker-preflight.md`. No rerun, install, download, service operation or current
OS process inspection. Root retains comparison selection and final disposition.

## Disposition

No material blocker to the narrow observed result. Public DBOS4.27.6 registration,
queue dispatch, durable event/receive/send and result APIs execute synthetic workflow
bodies on the owned PostgreSQL18.4 backend. This is more than another enqueue-row
or calendar helper check, but it is not the canonical CR admission-to-pickup seam.

## What the assertions and receipt actually establish

- The fixture registers the actual function wrapper and starts it through
  `DBOS.startWorkflow` with explicit queue/workflow IDs. It does not invoke the
  synthetic body directly or implement a substitute worker loop.
- A emits an actual persisted start event before waiting in `DBOS.recv`. It cannot
  produce its asserted successful result without receiving `released`; null timeout
  would fail its assertion. B's start-event wait uses the actual DBOS event API.
- At concurrency1, B's start event is absent for the one-second observation window;
  the recorded pre-release status is ENQUEUED. At concurrency2, B's event is positively
  acknowledged and recorded status is SUCCESS before A is released. These statuses
  are **observed and emitted**, not directly asserted as constants in the harness.
  The evidence/report call them observations, so no missing assertion invalidates
  the historical result. A future reusable status-regression gate could assert them
  explicitly without relabeling this run as failed.
- Both queue variants then release A using actual `DBOS.send` and compare A/B
  results with exact expected objects. The final sorted execution list asserts one
  invocation of each of the four synthetic bodies in this run. It does not establish
  exactly-once external effects, durable deduplication under crashes or multiple
  process concurrency.
- The one-second absence is finite timing evidence. It agrees with the inspected
  PENDING-based capacity accounting but does not alone prove an unbounded scheduling
  guarantee. Two configured workflow slots are not two available native-agent slots.

## Isolation and bounds

Worker mode resolves the script absolutely and changes cwd to a newly created empty
directory inside the owned cluster child. The worker asserts that directory is
empty before candidate imports. This addresses the actual SDK's unconditional cwd
configuration read identified in preflight; no CR app entrypoint or workflow registry
is imported.

The parent passes only PATH, locale and owned TMPDIR; the worker explicitly checks
Cloud mode is absent and supplies synthetic app/version/executor/schema identities,
two allowed queues and an owned socket pool. Admin, OTLP, tracing and LISTEN/NOTIFY
are explicitly disabled; Conductor options are omitted. These are actual supported
settings, consistent with inspected launch/config/exporter code. No statement of
OS-enforced network isolation follows, and the report correctly distinguishes it.

Pool size4, connection/statement timeouts, receive15s, event/result deadlines and
the outer60s child limit bound the intended experiment. Configured1s shutdown drain
occurs after all four expected results have settled. `DBOS.shutdown` plus pool close
are in finally; the outer runner stops the owned cluster, asserts pid/socket absence
and removes only its fresh child. If cluster stop is unconfirmed it retains the
child. The reusable acquisition cohort remains intentionally retained. Cleanup is
reviewed from source and the completion receipt, not independently remeasured here.

The receipt openly identifies itself as a transcription of terminal completion,
not a raw output file. The first-attempt success claim is not conflated with the
earlier transaction fixture's preserved setup failures/corrections. Package-version
checks reuse prior acquisition provenance; no fresh all-package hash audit is claimed.

## Selection consequence and remaining boundary

The report's recommendation is appropriately limited: native durable waiting does
not automatically free the sole configured workflow slot. Keeping review as an
existing CR phase or explicitly budgeting waiting workflows are competing integration
shapes; this test does not prescribe a new scheduler or approve either production
policy. No changes to canonical claims, review authorization or native uncertainty
are justified solely by this result.

Reuse this worker evidence and the earlier separate same-session transaction proof.
The still-decisive next test is their representative joined interface or a specific
remaining recovery/eligibility mismatch against the strongest candidate. Do not
repeat the same four bodies merely to increase counts, or require an entire new
production fleet implementation before deciding the queue component.
