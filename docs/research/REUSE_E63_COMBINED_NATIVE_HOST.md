# E63 — combined browser/native host ownership

2026-09-06. Compiled local composition and simulated serving only.

The existing task host accepts optional explicit native HTTPS settings. Configuration
requires the configured native application's origin port to match; TLS settings are
captured before asynchronous database preparation. The native endpoint starts before
the browser endpoint, and readiness requires both configured services plus the checked
application. No native endpoint is inferred or enabled when settings are omitted.

Normal close owns both services and the application. Native failure immediately drops
combined readiness and initiates browser/dependency shutdown; browser close also closes
the native service and application. Existing closures are memoized so parallel close
paths do not duplicate resource release. Cleanup failures remain observable from close.
Captured intermediate credential copies are cleared after startup; the native service
owns its own copies until cleanup. This is not a guarantee of complete memory erasure.

No new wire protocol or listener implementation was added here: the E62 Node HTTPS
adapter and existing private browser service are composed through the E60 task host.
Its existing compiled entry now includes optional native serving through server-only
imports. Browser assets continue to exclude TLS setup and native host implementation.

## Evidence

The compiled managed-session test now starts both fake listeners after five real
logical SQL-role checks. In-memory Node requests pass through native service request
events, the native HTTP callback, pinned synthetic socket evidence and signed protocol
handshake. Machine listener error removes readiness and closes both listeners and all
five pools once. Browser-only recovery remains supported.

The first new test attempt cancelled three cases because its test helper incorrectly
reused a synthetic socket across exchanges and waited only for successful output.
The existing callback correctly rejects socket reuse. The helper now models the native
client's fresh connection per exchange and observes premature stream closure as failure.
No production rejection was relaxed. The subsequent managed-session rerun passes all
three cases.

The full compiled suite, 31 native delivery/denial/isolation checks and four compiled
queue/schema journeys pass. TypeScript, lint and production build pass. Final expanded
compiled totals (including setup-denial cases) are recorded in BUILD_STATUS.md.
Missing native configuration and origin/listener port mismatch are tested before pools
or fake binds. This is not a new complete default test-lifecycle run.

## Still required

All listen/close methods and TLS byte fixtures are fake. No real certificate chain,
CA, socket, provider or database service was accessed. Five logical PGlite roles are
not physical PostgreSQL concurrency. The machine handshake test does not dispatch a
real agent task; separate six-role queue journeys still use synthetic peer attachment.

Trusted operator configuration, real credential sources/provisioning, owner approval
delivery/consent/custody, process signal handling and authorized real TLS/PostgreSQL/
agent rehearsal remain. This is callable compiled composition, not an installed daemon
or deployment approval. No downloads or GitHub publication occurred.
