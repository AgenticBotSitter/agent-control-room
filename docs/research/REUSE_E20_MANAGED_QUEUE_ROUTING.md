# E20 — route approved queue delivery through managed sessions

2026-09-06. Local implementation, synthetic signed transports only.

The coordinator resolves a queue reference to its currently approved assigned node
under ADR-251 authority, canonical state checks and signed packet revalidation. The
managed-session manager uses that node's current record and retains it across stage
and transmission. Replacement, disconnection, cancellation or an incompatible
attempt-bound connection prevents delivery; no alternate node or endpoint is selected.

The application lifecycle supplies these optional routes only when prepared submission
and managed sessions are configured. Its server-only queueDelivery callback delegates
to the manager and returns delivered only for confirmed delivery. A not-yet-confirmed
receipt remains unresolved, without disconnecting the healthy session just because the
queue callback cannot yet claim confirmation. Later authenticated receipt intake remains
available. No new browser request input or authentication token is introduced.

## Evidence

49 focused managed-session, queue-routing, coordinator-lifecycle and startup checks pass.
New tests cover delivery after browser logout, later signed receipt acceptance, missing
assigned connection, session replacement between stage/transmit, and owner demotion
after staging. The latter two produce no dispatch on either connection generation.
Typecheck, targeted lint and whitespace validation pass. New tests are in the default
test command.

The fixture explicitly uses privileged canonical setup plus restricted authentication,
evidence and result roles; it does not prove new coordinator grants. Its queue-submission
port is a nonexecuted stand-in; actual pg-boss pickup is tested separately in E19. Native
provider execution is fake. Do not relabel this as a complete production fleet journey.

## Remaining

Compose host startup using application.queueDelivery, the verified worker bootstrap and
joint lifecycle view before installation. Test the whole application/queue/session path
under the exact six database roles, then real PostgreSQL and scoped native acceptance.
Browser enqueue UI, complete queue schema acceptance, deployment packaging and offline
node recovery remain unfinished. No automatic retry of uncertain effects or retargeting.
No download, native service, credentials, deployment or GitHub publication.
