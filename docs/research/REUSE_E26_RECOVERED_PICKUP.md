# E26 — owned recovery and audit-bound pickup

2026-09-06. Local explicit composition; simulated native execution.

## Result

The actual-package test now covers: offline first pickup -> retained unsent task ->
signed reconnect -> explicit canonical recovery -> verified recovered pickup -> one
signed dispatch -> completed bytes stored against an exact pending review target.
It observes two delivery callbacks (one offline, one connected), but only one dispatch.
Reconnecting without the explicit recovery call still produces no dispatch.

## Implementation

The owned coordinator lifecycle captures the optional recovery port and exposes scoped
server-only recover/verify methods, with input snapshots and existing admission, drain,
transaction and health fences. The private application returns this command only to
trusted server composition, never the browser router. Startup does not yet select it.

verifyRecoveredQueueDelivery rechecks original queue authority, signed approval and
never-staged state under canonical locks. The requested ordinal must match the full
current recovery sequence: exact IDs, initiating actor, target and packet digest.
Stale/missing/mismatched recovery records or current revocation deny admission.

Workers without an explicit verifier still reject retryCount > 0. An opt-in worker
allows only bounded integer recovery counts with retryLimit 0 and requires its captured
canonical verifier before invoking delivery. Verification refusal or cancellation
prevents delivery. Runtime shutdown/fault abort signals also cover verification.
The worker receives no canonical SQL access; verification remains the coordinator's job.
Stage/transmit independently revalidate current canonical authority as before.

## Evidence

- 53 actual-package integration checks pass, including the expanded offline-to-review
  journey with explicit recovery and unchanged zero automatic retry allowance.
- 71 related lifecycle, canonical recovery, managed-session, worker and runtime checks
  pass. They cover captured requests/ports, drain and retained-call refusal; exact/current
  audit ordinal and corrupted fields; missing verifier, verifier refusal, cancellation
  and over-limit pickup.
- TypeScript, targeted ESLint and whitespace checks pass.

The connected fixture uses privileged canonical setup plus restricted worker and managed
session roles on one PGlite engine. It does not prove six physical production pools or
the full host bootstrap. The native provider is fake; no live owner/browser journey is
claimed. The recovery call is explicit test orchestration, not an automatic reconnect hook.

## Next

Propagate recovery configuration through verified startup and worker bootstrap. Add the
authenticated assigned-node readiness trigger, bounded eligible-work discovery and
duplicate/stale reconnect handling. Preserve healthy result intake when recovery is
ineligible; do not close a good connection merely because a task expired. Prove that
automatic path, then exact-role/full-schema, real-PG and live-agent acceptance.

No downloads, credentials, native provider/server, deployment or GitHub publication.
