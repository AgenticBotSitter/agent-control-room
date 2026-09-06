# Managed native sessions and evidence routing

Root-owned contract, based on PR #338 at `1dcbd95`.

An optional runtime-owned manager constructs the existing ServerNodeSession from
fixed server/node configuration and a supplied transport. No caller can supply an
already authenticated session or replace its authenticator. Public node keys and
durable replay state use a fifth fixed restricted role on the same private primary;
the earlier four roles are unchanged. Enrollment/key mutation is not permitted.
The supplied signer is captured, never loaded from credentials by this module.

Only trusted server composition receives the manager. It is not an HTTP route or
listener. Attach returns an opaque closure-backed connection handle, not a raw
session, database, signer or transport. Its explicit hello, reconciliation, stage,
transmit, receipt and progress methods call the existing protocol/coordinator/receiver
operations. Stage/transmit still require current verified owner identity and exact
saved plan/approval evidence. A transport attachment grants no execution authority.

The host supplies transport identity through fixed node configuration, not frame
claims. Authentication checks the pinned node/key and scope before replay writes.
All operations use shared bounded coordinator admission plus one operation per
connection. Frames and file bytes are bounded and copied before asynchronous work.
Pool health, transport health, cancellation, monotonic time and closed/replaced
identity fence SQL and transport work. Uncertainty disconnects; it never resends.

Replacement invalidates the old handle synchronously, closes its transport exactly
once with a bounded wait, and cannot restore the old session. A new hello/reconciliation
is required. Existing sent-task recovery is not inferred from reconnection, and no
dispatch, native execution or saved frame is automatically retried. Durable partial
progress/replay/receipts survive later failure. Transport close uncertainty is reported
without retry. Manager shutdown invalidates every handle and attempts every transport
close before the authentication pool can be considered cleanly closed.

Tests must use actual restricted authentication/replay SQL and real signed synthetic
handshakes. Cover replacement/retained handles, failure and cancellation fences,
permission/topology/cleanup, captured capabilities, and the integrated native evidence
path. Initial/revised results use existing result contracts; no public/demo activation,
physical database, native/provider calls, service, credential operation or deployment.
