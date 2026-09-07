# Saved Idea creation, stop and owner decision setup

Source configuration guide, 2026-09-07. Not an instruction to provision or launch now.

The existing private task bootstrap accepts optional `coordinator.ideaCreation`.
It saves an owner's Idea session and audit record and can record an owner stop request
for an existing run. It also accepts an explicit owner decision on a retained synthesis,
including project promotion. It does not run a panel, synthesize opinions, start a worker
or authorize a provider call. Promotion produces an active project, not execution authority.

## Required configuration

In the trusted operator module's existing `PrivateTaskStartupConfiguration`:

- Configure `web.ideaProjects.integrityKey` for retained Idea reads.
- Configure `coordinator.ideaCreation.integrityKey` with the same 32-byte key.
- Supply `coordinator.ideaCreation.database` using the same private primary host,
  port and database as the existing web/coordinator connections, but a distinct login.
  It must also differ from configured result, evidence, session and queue-worker logins.
- Supply 3–6 unique `participants` matching `ideaParticipantSchemaV1`. These are
  saved roster descriptors, not evidence of connection or permission to dispatch.
  The current schema explicitly records `injected_only`, `liveConnected: false`,
  and `canDispatch: false`; do not substitute fixture bots and call them live agents.

Do not commit the operator module, key or database password. Use the existing reviewed
operator configuration/secret-loading arrangement; no new environment loader is added.
The current website-only launch mode can support these non-executing saves without
enabling the agent queue. Actual launch and credential access remain separately authorized.

## Offline database prerequisites

The operator's later approved setup must apply `db/roles/idea_creation_roles.sql` and
give the distinct login only its fixed `control_room_idea_creation` membership, without
ownership or administration. The role script creates a fresh NOLOGIN role and is not an
idempotent migration. Do not run it from startup or against an unreviewed existing role.
Use the existing private PostgreSQL configuration and exact preflight requirements,
including the current schema fingerprint, session limits and active scoped owner.
When the native queue is explicitly configured, the Idea preflight recognizes its
schema but requires zero queue privileges. The worker startup excludes all six
configured application logins from its own login; no connection is shared.

At explicit startup, the bootstrap checks configuration before opening any resource,
then verifies each actual database login. The Idea preflight permits session creation,
run-event appends for the stop operation, session authority and audit needs. SQL grants
allow run-event inserts generally; the server operation constrains them to stop transitions.
The same role includes policy/permit/decision/project/lifecycle inserts for owner decisions
and the reads needed to validate their inputs. SQL permits these inserts generally;
the protected operation imposes the owner policy, immutable permit and atomic audit.
No UPDATE rights on those records, contribution/synthesis writes, job or queue writes
are granted. Missing or additional rights reject installation;
startup does not repair grants. Cancellation/failure closes acquired resources once.

## Acceptance and remaining work

The disposable startup test exercises all three exact SQL roles, protected save/read/replay,
web-write denial, Idea dispatch-write denial, invalid configuration, privilege drift,
cancellation and reused-resource cleanup. It uses one serialized PGlite backend with
actual test login identities and the documented TEMP metadata exception. This does not
prove independent production connections, real PostgreSQL concurrency or deployment.
Combined host tests additionally cover the sixth Idea login with an injected worker
and producer. They do not substitute for real pg-boss acceptance.

After authorized real setup, verify `/ideas` offers New idea for the scoped owner, save
and reopen a harmless draft, confirm a retry returns the original session, and confirm
logout revokes access. None of those production checks has run in this block.
The owner decision command is mounted by the managed Idea resource after preflight.
The private detail page offers a choice form when a synthesis exists, no decision is
already saved, any retained run is complete, and current owner permissions allow it.
Project creation is a separately permission-checked option. Multi-bot execution remains
unfinished integration. Promotion
requires the existing `CONTROL_ROOM_IDEA_ADAPTER_V1` registry entry established by later
approved operator setup; this operation does not create an adapter or repair missing setup.
An older creation-only role must be explicitly reviewed/upgraded before this version
will accept it. Startup does not silently expand an existing database login's privileges.

The owner detail page offers **Stop discussion** only for a retained active run while
the operation is configured and the owner has current read/cancel grants. A retry targets
the same session digest and run ID and does not duplicate the audit. A saved request
prevents later turns; an already marked provider turn remains unconfirmed until settlement
or recovery. This is not physical cancellation of a provider. Disposable tests cover
lost responses, revoked access and the restricted SQL login; real agent acceptance remains open.
