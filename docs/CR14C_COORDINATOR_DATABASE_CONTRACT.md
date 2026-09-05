# CR14C — coordinator database privilege gate

Status: independently accepted repository/disposable integration; production unconfigured.
Base: PR #297, `87f60511cb96516f5d5ab7c5159a82bb875953be`.
Evidence: `CR14C_COORDINATOR_DATABASE_ACCEPTANCE.md`.

## Scope

The private web connection and task coordinator have different, fixed database permission profiles.
`control_room_task_coordinator` is a fresh NOLOGIN role for a separately provisioned private LOGIN
with exactly that membership, no ADMIN option, privileged flags or object/database ownership.
`task_coordinator_roles.sql` is offline operator setup only. Startup never executes it, repairs
permissions, migrates, creates a login or falls back to the broad legacy application role.

This first profile supports owner-authorized planning, canonical one-attempt assignment/expiry,
their authenticated reads, session records and append-only audit/transition records. It can read
existing fleet reports, node public keys and completion profiles but cannot write them. It cannot
insert approvals, effects, native runs, result records, node-protocol frames or enrollment credentials.

Canonical inserts and named state/version/payload/timestamp updates remain trusted application SQL
authority, not a row-scoped or tenant-scoped sandbox. They do not themselves prove owner permission,
HMAC plan integrity or execution approval. Those checks stay in the reviewed application and local
admission paths. A database administrator/migrator remains trusted. This profile is not a boundary
against a fully compromised control-plane process with its other keys/capabilities.

## Locking and outbox boundary

Migration 0046 adds a constant-false `coordinator_lock` to tenants, nodes, node public keys, manual
project heads and projects. Column-only UPDATE grants permit existing locking SELECTs without
permission to change those records' authority fields. Existing web_lock columns cover identities,
grants, workspaces and completion integrity. Session UPDATE remains first revocation only under its
existing immutable-session trigger. No existing private-web UPDATE privilege is broadened.

The coordinator may insert canonical domain-transition outbox records, not dispatch commands.
An invoker-security insert trigger restricts this role's topic to domain.transition, pending state,
and request/workflow/job/attempt/lease aggregate kinds. It grants no function execution or elevated
privileges. Superuser administration is outside this application restriction; preflight rejects
superuser membership and disabled/mutated guards. No role setup script creates the runtime login.

## Exact preflight

`verifyTaskCoordinatorDatabase` selects a fixed internal policy; callers cannot supply a custom role
or allowlist. It shares the existing PG17 primary/identity/timeouts/search-path, membership, PUBLIC/
default privilege, ownership, schema fingerprint and active-owner/workspace checks with the web gate.
It requires every expected read/insert/update column and refuses every extra effective privilege,
grant option, sequence/function privilege, maintenance capability or elevated membership.
The existing `verifyPrivateDatabase` wrapper always selects its original restricted web policy.

Schema fingerprint after migrations 0001–0046:
`dab0f6b51a3f60768873d2eae4ec4804a5ed93006e1bcc9a1400a9c14e0b0b2a`.
The 132-table count is unchanged. Fixture-preparation manifests now require 0001–0046. Earlier
acceptance records preserve their historical fingerprints; they are not current setup instructions.

## Evidence and continuation

Require real restricted-role planning/assignment/expiry, negative permission and tampered preflight
tests, plus unchanged web-role behavior and full regressions. PGlite cannot revoke template1 TEMP;
the fixture injects only that metadata field while the unmodified gate rejects its actual value.
This is not real PostgreSQL ACL/socket/concurrency or host qualification evidence.

This block provides the gate, not a deployed database or startup mounting. Next implement two verified
pool startup and the shared compiled-page installation, then signed approval/local admission/dispatch
and bounded revisions. Continue on Astra Medium. No database service, listener, credentials, native/
provider call, deployment or merge is authorized here.
