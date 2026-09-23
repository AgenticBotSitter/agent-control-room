# Prepared local adapter installation ports

The optional server-only `preparedLocalAdapters` startup field retains already
composed Hermes, Codex and Claude delivery callbacks. Operator assembly and
startup validation copy and freeze their worker/adapter/revision bindings and
capture each callback with its original receiver. Construction performs no
delivery, database access, runner invocation or qualification callback.

All three callbacks receive the existing controller delivery packet, route,
receipt time and cancellation signal. Their harness-specific return types remain
distinct. A start observation or acquired process is not a completed result.
The existing receipt, result verification, owner review, correction and completion
services remain authoritative; this package adds no lifecycle state or storage.

These ports are trusted installation inputs, never browser settings. Raw captured
callbacks remain installation-owned preparation material. They are not mounted
in the scheduler, task application or HTTP handlers. The shared
`deliverPreparedLocalAdapterV1` boundary refuses absent, mismatched and source-only
ports before invoking any callback. Its admission remains intentionally closed:
this change supplies no production qualification or enablement implementation.
Do not call a raw prepared callback as a substitute for admission. Existing
Hermes enablement and delivery remain under their separate existing proof gates.

## Gates outside this source package

- Owner-selected private runner, profile, provider/model and permitted folder.
- Hermes no-agent preflight and owner-attended fixed-runner bridge qualification.
- Codex protected private-state and executable custody qualifications, plus the
  exact installed harness start/read/result qualification and current admission.
- Claude installed-process permissions, bounded cancellation, terminal bytes and
  restart-result behavior qualification.
- Approved PostgreSQL, protected result-byte storage and disposable restore proof.
- Authorized persistent supervisor, restart/recovery and rollback procedure.
- Separately reviewed production admission wiring that verifies those exact
  harness proofs. Generic installation readiness or a caller-supplied boolean
  cannot enable this preparation seam.

The focused installation tests prove capture without calls and fail-closed
delivery for all three adapters. Existing three-local conformance proves the
shared corrected-result lifecycle with disposable data. Neither is native or
owner-attended evidence.
