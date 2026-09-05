# Node-native delivery intake

The optional portable-bridge handler receives only authenticated server frames after native feature
negotiation and connection reconciliation. It requires the configured local enrollment, verifies exact
task binding and both separate owner signatures, and records the exact signed delivery plus intake
receipt in one synchronous SQLite transaction. Channel, time, cancellation and owner-trust fences run
through that transaction. Owner verification is bounded to five seconds; uncertainty closes the handler.

This reuses the node bridge journal, not a second global queue. Its host must supply protected private
node storage before live use: the record contains project input and signatures and must not enter
diagnostics or public evidence. Append-only rows are bounded to 1,024 and unique by queue, message and
tenant/job/attempt. Metadata readback checks hashes and exact binding but is not current authority;
local digests are corruption checks, not protection against a privileged attacker rewriting the file.
Later execution must reverify current owner/local policy and use existing durable effect claims.

After commit the bridge produces a dedicated signed native receipt, checking its exact signer material
and negotiated frame size. The server's actual authenticated receipt store can retain that evidence.
No generic protocol acknowledgement substitutes for this receipt. No native adapter, admission marker
or provider call is invoked during intake. Recorded means stored input, not admitted or running work.

Duplicate delivery is not replay permission. Receipt-send uncertainty preserves the intake/outbox
record without re-running intake. Native receipts are excluded from automatic cross-connection outbox
replay. Receipt acknowledgement/recovery, capacity management and execution routing remain later work.
The host owns transport serialization and bounded transport shutdown; the five-second intake limit
does not claim to bound an arbitrary supplied transport's send implementation.

Every awaited native-dispatch failure is fenced to its captured connection generation, so old failures
cannot invalidate a replacement. Reconciliation reports the current connection's highest inbound
sequence, not an unrelated historical maximum. A failed handler remains closed; trusted host composition
must replace failed resources explicitly, never automatically retry an uncertain task.

The optional handler is not mounted into a live bootstrap or advertised by an existing production
process. Tests configure synthetic resources explicitly. PostgreSQL schema/roles remain0052/138 tables.
