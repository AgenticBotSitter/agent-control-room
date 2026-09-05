# CR14C approval lifecycle and reconciliation

The optional trusted coordinator approval port combines preparation, signed-packet storage and safe
receipt readback under the existing shared active-operation ceiling and shutdown/drain owner. Configuration
is absent by default, so the existing planning/assignment surface stays unchanged. Configured enrollment
is copied by the assignment coordinator; owner public trust/integrity dependencies remain supplied resources.
The lifecycle does not install or close independently owned trust stores.

Approval operations use the same pool/session guards, no-queue capacity limit, precommit invalidation and
bounded uncertain-save handling as planning/assignment. Packet bytes are copied before the scheduling
microtask, then copied/validated again at the canonical coordinator boundary. Forced shutdown cannot permit
a late transaction to write or convert uncertain cleanup into a success. Admitted normal work may finish
during graceful drain; new work is denied. No retry is performed.

Receipt reconciliation requires current authenticated owner `tasks.read`/`tasks.approve` access, the current
ordinary project and integrity-checked execution plan, and the exact expected input digest. It takes the
same tenant/project/job locks as assignment, reads only the deterministic attempt's immutable packet row,
checks its HMAC and row/scope/input projections, and returns only digest/time identifiers. No signatures,
prompt, enrollment, key material or native locators appear in the receipt.

A receipt is explicitly `stored_signatures_only` and grants no execution authority. A closed ordinary
project, expired work reservation or closed owner pin store does not erase historical evidence. Current
owner/session access remains mandatory. Saving a packet still requires current reservation/signatures;
readback is the alternative after a lost acknowledgement, not automatic resubmission.

This block implements the trusted lifecycle port, not an HTTP handler, browser page, signing service,
bootstrap enrollment configuration or agent delivery. Those integrations, signed dispatch, supervisor
persistence and revisions remain. No schema/privilege change, live credential/provider, listener, real
PostgreSQL operation, deployment or merge is performed. Continue repository integration on Astra Medium.
