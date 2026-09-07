# Saved Idea creation, stop and owner decision setup

Source configuration guide, 2026-09-07. Not an instruction to provision or launch now.

The existing private task bootstrap accepts optional `coordinator.ideaCreation`.
It saves an owner's Idea session and audit record and can record an owner stop request
for an existing run. It also accepts an explicit owner decision on a retained synthesis,
including project promotion. It can prepare a source-excerpt recap of a completed panel.
It does not run a panel, make a new model judgment, start a worker
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
schema but requires zero queue privileges. The worker startup excludes all configured
application logins (up to seven with the optional Idea runtime) from its own login;
no connection is shared.

At explicit startup, the bootstrap checks configuration before opening any resource,
then verifies each actual database login. The Idea preflight permits session creation,
run-event appends for the stop operation, session authority and audit needs. SQL grants
allow run-event inserts generally; the server operation constrains them to stop transitions.
The same role includes policy/permit/decision/project/lifecycle inserts for owner decisions
and the reads needed to validate their inputs. SQL permits these inserts generally;
the protected operation imposes the owner policy, immutable permit and atomic audit.
Synthesis INSERT is also required for owner-requested extractive recaps of completed
runs, atomically audited by the application. No UPDATE rights on those records,
contribution writes, job or queue writes
are granted. Missing or additional rights reject installation;
startup does not repair grants. Cancellation/failure closes acquired resources once.

## Acceptance and remaining work

The disposable startup test exercises all three exact SQL roles, protected save/read/replay,
web-write denial, Idea dispatch-write denial, invalid configuration, privilege drift,
cancellation and reused-resource cleanup. It uses one serialized PGlite backend with
actual test login identities and the documented TEMP metadata exception. This does not
prove independent production connections, real PostgreSQL concurrency or deployment.
Combined host tests additionally cover the sixth Idea login with an injected worker
and producer, and the seventh runtime login. They do not substitute for real pg-boss acceptance.

## Optional discussion runtime

`coordinator.ideaRuntime` is separate from saving Ideas. It supplies a distinct private
database configuration, an already prepared `runtime` (read-only accepted-material lookup,
filtered driver and current evidence/admission verifiers), and an explicit async `close`.
Startup does not construct a provider, load credentials, call lookup, mint admission or
contact a bot. Runtime methods are captured before asynchronous preflight. Fake mode is
rejected. Its login must differ from every configured application and queue-worker login.

The later approved operator setup must provision the exact offline
`db/roles/idea_runtime_roles.sql` profile. Startup calls `verifyIdeaRuntimeDatabase`
before mounting Start; it never runs the role script. Admission-store/provider ports
must independently come from the existing accepted composition, not a fabricated verifier.
The runtime SQL role is not authorization to change accepted admissions or qualifications.

After configuration and required dependency validation succeeds, bootstrap takes ownership
of the prepared runtime's close port. Configuration rejection leaves it with the caller.
Subsequent preflight/cancellation/installation failure closes it once, with a five-second
bound, and attempts closure of acquired pools. Failed or stalled cleanup is reported as
uncertain, never retried. Normal operation transfers the same memoized close to the managed
lifecycle. The caller must not concurrently reuse or close a transferred runtime.

With this optional configuration, the protected Start endpoint invokes the existing
owner start operation. It does not bypass current owner permissions or accepted live
window checks. The browser Start control appears for an untouched Idea with current
owner access; real runtime configuration remains unfinished. The synthetic startup
test deliberately has no accepted window and confirms zero calls. An uncertain start
response asks the owner to refresh saved status, never automatically repeat a provider call.

After authorized real setup, verify `/ideas` offers New idea for the scoped owner, save
and reopen a harmless draft, confirm a retry returns the original session, and confirm
logout revokes access. None of those production checks has run in this block.
The owner decision command is mounted by the managed Idea resource after preflight.
For a completed full panel without a recap, the detail page offers **Prepare recap**
when the owner has current synthesis permission. It reads saved replies without another
provider call. An uncertain response can be recovered by refreshing or explicitly trying
the same recap again; the server returns the retained recap rather than creating a second
discussion. The recap is extractive, not an AI consensus or measured business validation.
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
