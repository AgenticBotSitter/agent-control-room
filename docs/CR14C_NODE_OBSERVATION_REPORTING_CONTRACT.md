# Node-owned saved observation reporting

The reporting owner is node-private composition, not an application import, browser
API or new harness adapter. It does not accept a provider transport or any native
start, poll, observe, stop, reserve or update capability.

## Source and scope

`NativeObservationReporter` captures one queue ID, trusted enrollment and pinned
server identity/key. Its only source capabilities are the accepted-delivery reader
and the native journal's existing-run reader. Every report re-verifies the saved
server signature, receipt, original binding and matching native snapshot. Missing
or inconsistent evidence is refused. Historic execution deadlines are not renewed
and do not prevent reporting already-recorded observations.

The existing observation converter preserves run/attempt/lease/session identity,
version, observation timestamp and terminal evidence while removing raw native IDs,
prompt/configuration and result text. Publication uses the supplied portable bridge's
existing durable, signed, ordered and acknowledged snapshot outbox.

`report(signal)` means recorded/duplicate locally, never accepted by the server.
`readResult(exactSnapshotBody, signal)` returns a fresh bounded byte array only for
the exact latest saved completed observation. It is a trusted artifact-sender seam,
not a browser or protocol response. There is no raw output in the status receipt.

## Runtime ownership and replacement

The execution handoff optionally owns this reporter. An already-authorized start,
poll or observe call publishes its resulting saved observation automatically. Missing
reporting configuration preserves prior behavior. A publication failure closes the
handoff so retrying the failed call cannot accidentally perform another provider call.

After execution authority expires or a handoff closes, trusted node composition can
construct a new read-only reporter over the same journals. This does not prepare a
new execution handoff. No autonomous polling loop, service or timer is installed.

The same bridge/journal requeues unacknowledged snapshots on a new connection. Host
ingress must finish signed reconciliation and call the server's recorded-work recovery
before routing those automatically flushed progress frames. The test must retain
the journals and demonstrate that ordering; an empty replacement journal is not proof.
Already acknowledged snapshots remain deduplicated. An uncertain send or ACK never
authorizes a new native request.

## Failure ownership

Clock rollback, cancellation, closed/unavailable owner, missing or changed delivery,
snapshot regression and operation uncertainty refuse new work. Publication has a
five-second result bound and only one operation may be unresolved. A reporter close
does not retract or delete already journaled observations. The separate bridge owner
must disconnect a replaced transport; its generation fence owns late signing/sending.
The reporter does not close caller-owned journals or perform a physical native stop.

## Verification boundary

Use synthetic native fixtures, actual disposable journals and signed bridge/server
frames. Prove initial automatic reporting, retained pending/staged/acknowledged states,
saved completed bytes, original identity and unchanged native calls/journal state
through reconnect. Negative tests cover proof mismatches and lifecycle failures.
No actual Hermes request, credentials, listener, host setup, production database or
deployment is authorized by this contract.
