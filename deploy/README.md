# Initial private website deployment

This profile serves the protected project website using the existing restricted
PostgreSQL web login. No task coordinator, queue worker, agent connection, news
collector, or live Idea Lab runtime is started. This is a first usable website
stage, not a completed orchestration deployment.

The Idea-project lifecycle release changes the web role's exact grants. See
`docs/IDEA_PROJECT_LIFECYCLE_DELIVERY.md` before preparing or updating a role.
Older grants intentionally fail the new startup preflight. No role script is run
automatically, and these source changes do not authorize a production privilege update.

## Supplied configuration module

`deploy/operator-config.mjs` is executable operator configuration for the existing
launcher. Leave it inside this pinned release, owned by the service account, mode
0600. Set `CONTROL_ROOM_SETTINGS_FILE` to an absolute, canonical, service-owned
0600 JSON file outside Git and the web root. Parent directories must be controlled
by the operator, not writable by other accounts. Never paste its contents into a
report. The required shape is:

```json
{
  "port": 3210,
  "web": {
    "origin": "https://private.example.invalid",
    "issuer": "https://team.example.invalid",
    "audience": "REPLACE_WITH_EXACT_ACCESS_APP_AUDIENCE",
    "tenantId": "tenant:owner",
    "workspaceId": "workspace:owner",
    "ownerIdentityId": "identity:owner",
    "maxSessionSeconds": 604800,
    "database": {
      "host": "127.0.0.1",
      "port": 5432,
      "database": "REPLACE_WITH_APPROVED_DATABASE",
      "username": "REPLACE_WITH_RESTRICTED_LOGIN",
      "password": "REPLACE_PRIVATELY",
      "majorVersion": 17
    }
  }
}
```

These are placeholders, not approved server values. Verify an unused application
port in the **same network namespace** as PostgreSQL and the tunnel. The service
always binds loopback. Do not use `localhost` to conceal a namespace mismatch,
expose a container port publicly, or enable a second private hostname.

The Access loader reuses the existing bounded JWKS reader and JWT verifier; its
issuer is operator-selected, never obtained from an incoming token. The database
preflight still requires the exact schema, restricted role, owner and workspace.
The module does not seed owners, apply migrations, or infer identity from email.

### Optional saved Idea and news capabilities

The same protected JSON may optionally include a top-level `savedViews` object
with `ideaIntegrityKeyHex`, `newsIntegrityKeyHex`, or both. Each value must be the
exact existing 32-byte integrity key encoded as 64 hexadecimal characters. Keep
these values private in the protected settings file, never Git or reports. Omit
the object entirely when neither capability is configured; empty/unknown fields
are rejected. No extra fields are accepted under `web`.

Use the retained data's actual key: do not generate a replacement to make a failed
integrity check pass. New-install key creation and custody need separate operator
approval. No key is generated, discovered or rotated by this module.

This enables the existing saved Idea/project and news services, including their
already-authorized local record actions. It is **not a read-only database mode**.
It does not enable new Idea creation, bot discussions, news collection or research
execution: those need separately configured coordinators/workers and acceptance.
The launcher rejects Idea runtime or news-worker configuration in website-only
mode before opening runtime resources. Actual saved-data setup remains optional;
the minimal configuration above works unchanged.

### Optional Idea authoring, without bot execution

With the saved Idea key configured, a top-level `ideaAuthoring` object may contain
only `database` and `participants`. The database uses the same shape as `web.database`
and must target the same primary/database with a different restricted LOGIN that
inherits the existing `control_room_idea_creation` role. Its exact role preflight
runs separately from the web preflight. Provisioning that login and applying
`db/roles/idea_creation_roles.sql` still require exact-target operator approval.

`participants` is the existing three-to-six configured Idea participant descriptors
(`src/idea-lab/v1/schemas.ts`), with distinct IDs, identities and perspectives,
including a skeptic. Supply reviewed descriptors; never copy fixture identities
or claim they are connected. The same saved Idea integrity key is used by both
read and writer services; a second independently generated key is not accepted.

This adds roster options, saving Ideas, recaps of already-completed retained
discussions, and owner decisions/project promotion. It starts no discussion and
does not manufacture contributions. New Ideas remain saved/not-started until a
separately authorized runtime is configured. No native-task planning/checkpoint
configuration, task coordinator login, queue, provider, or native listener is
required by this authoring profile. It cannot be combined with a task coordinator;
use the existing full task composition for that separate deployment stage.

The existing web request drain owns both bounded database connections. Failed
preflight or installation closes acquired resources; an uncertain close is not
reported as a clean shutdown. This package supplies configuration, not authority
to provision roles, access credentials, or start production.

The existing database-only command now recognizes the expanded authoring profile
and verifies both web and writer roles using the same acquisition and preflight
code as authoring startup. It closes both connections before returning a sanitized
receipt. It does not construct services, install the application, contact an issuer,
or start a listener. Minimal configurations still check only the web role.
The receipt explicitly leaves backup verification and production readiness false.
The check still reads private settings and connects to the database, so it requires
authorization for that exact target. It is not an effect-free local source check.

Local verification: `pnpm test:idea-authoring:build` compiles the release and runs
the source/compiled configuration, role, launcher and cleanup tests sequentially
with disposable data. It does not provision or start the production service.

## Database procedure — exact target review required

Use the existing PostgreSQL 17 primary; do not install another primary. First
establish its data-directory persistence across container replacement, ownership,
disk budget and current backup mechanism. Allocate an empty, dedicated Control
Room database and a separate non-login owner/migrator role. Do not apply this to
another application's database. PostgreSQL roles are cluster-wide: an existing
role name is a review condition, not permission to alter or drop it.

1. Protect existing affected application data before changing shared infrastructure.
   Establish durable storage and verify restoration of those existing backups before
   relocation. A Control Room backup is produced after its database exists; it is
   not a prerequisite for creating its first empty database.
2. Record the pinned release and hashes of all 64 `db/migrations/*.sql` files using
   `node scripts/private-deployment-inventory.mjs`. This command also inventories
   the two restricted web role files and contacts no database. For the optional
   Idea-authoring profile, use `node scripts/private-deployment-inventory.mjs --profile idea-authoring`
   instead; it additionally hashes `db/roles/idea_creation_roles.sql` and
   `db/setup/private_idea_adapter.sql`. Compare the
   digest for the selected profile, not a minimal-profile inventory,
   with the accepted release inventory before executing any SQL. It is source
   identification, not a migration executor or proof of live database state.
3. In the dedicated empty database only, apply those files in lexicographic order
   with psql `-X -v ON_ERROR_STOP=1`, using the separately approved migration identity.
   Record each file's completion. Startup never reruns migrations. Stop on any
   failure; do not repeat a partially applied sequence or mark it complete.
4. Apply `db/roles/private_web_database.sql` and `db/roles/private_web_roles.sql`
   to that database using the appropriately authorized operator. Review default
   privileges for the actual schema owner. These files revoke broad permissions
   and create a NOLOGIN group; they are not generic shared-database scripts.
5. Provision a distinct restricted LOGIN with INHERIT, NOSUPERUSER, NOCREATEDB,
   NOCREATEROLE, NOREPLICATION, NOBYPASSRLS and membership only in
   `control_room_private_web`, without ADMIN or object ownership. Supply its secret
   privately. Keep the migrator/admin credentials out of the application settings.
6. Create the reviewed tenant/workspace under separate provisioning authority.
   Bootstrap only the first owner through the existing primitive and the bridge in
   `deploy/OWNER_BOOTSTRAP.md` after verifying a current owner
   authentication. The issuer and authenticated subject must match Access. Do not
   substitute the owner's email for the subject or copy a fixture identity/grant.
   This owner bootstrap still needs its exact verified input and execution review;
   this document does not turn invented timestamps into verified authentication.
   When authoring is selected, first also apply the inventoried
   `db/roles/idea_creation_roles.sql` under separate exact-target approval and
   provision a different restricted LOGIN inheriting only `control_room_idea_creation`,
   without ADMIN, object ownership or privileged role attributes. Do not grant the
   web login this writer role or make the writer inherit the web group. Both logins
   must reach the same dedicated database; verify actual database connection access
   without granting CREATE or TEMPORARY. Default privileges apply to the actual
   object-creating owner, not an unrelated operator role. The role script creates a
   cluster-wide group and is not a repeatable update script: an existing group
   requires review, not an automatic drop/recreate or reapplication.
   Before authoring preflight, register the built-in Idea project adapter using
   the inventoried `db/setup/private_idea_adapter.sql` in this dedicated database.
   In the same approved operator connection, set the session-only
   `control_room.setup_tenant_id` setting to the reviewed existing tenant ID (for
   example through parameterized `set_config` with its third argument false).
   Do not use ALTER SYSTEM or a server-wide default. Then execute the setup file
   with stop-on-error and close that operator connection. This writes one registry
   row with pending status; it does not enroll a bot or claim connectivity.
   An existing row causes failure and requires comparison/review, not overwrite.
   The fixed adapter ID is single-tenant; a record owned by another tenant cannot
   be reused. Both authoring and full task startup check this prerequisite through
   the existing web read role and refuse missing, mismatched or disabled records.
   Startup and the database-only checker never create or repair this row.
7. Run the unchanged production database preflight without starting the website:
   `node scripts/check-private-vps-database.mjs --configuration /APPROVED/RELEASE/deploy/operator-config.mjs`.
   This still requires explicit authorization for the selected private database
   connection and protected settings. It must pass without a PGlite override or
   relaxed ACL/schema check. First authorized startup repeats the checks.

## Backup, restore and rollback acceptance

Follow `deploy/BACKUP_RESTORE.md` for the ordered dedicated-database procedure and
the database-only check on the disposable restore. No new backup engine is introduced.

Use PostgreSQL 17 `pg_dump` custom format for the dedicated database with an
authorized backup role. Preserve protected role/configuration material separately;
a database dump alone does not reproduce cluster roles or application secrets.
Keep backups off the release path with restrictive permissions and an approved
encrypted off-host copy. Do not upload database contents to GitHub.

A successful dump is not a verified backup. Restore using `pg_restore` into a
separate, explicitly disposable database, with fail-on-error enabled. Verify schema,
required rows, ownership/ACLs and application preflight under the restricted login.
Keep the restored application unexposed and agent execution disabled. Record exact
exit codes, sanitized checks and cleanup of only the authorized disposable target.
No actual backup/restore has been performed by this source change.

For a failed first startup: close only Control Room, leave ingress disabled, and
preserve its database for diagnosis. For an update: retain the previous immutable
release and private configuration; stop/drain Control Room before switching back.
Do not run reverse SQL or restore over a live database automatically. If the prior
release is incompatible with the migrated schema, leave Control Room stopped and
review a restore into a separate target. Never roll back unrelated websites.

## Supervisor and first startup

`deploy/SUPERVISION.md` supplies the execution-namespace decision and a conditional
systemd template, plus a website-only maintenance update procedure. The template
is not installed or approved for the currently unidentified target supervisor.

Use the existing persistent supervisor **inside the correct execution namespace**.
Do not assume host systemd can see container loopback or filesystem paths. The
operator must identify its actual supervisor, persistent config location and
unprivileged service account before installing a unit. Use this command with an
absolute pinned-release path:

```text
node /APPROVED/RELEASE/scripts/run-private-vps.mjs --configuration /APPROVED/RELEASE/deploy/operator-config.mjs
```

Set the working directory to the release, `NODE_ENV=production`, and the settings
file path. Keep configuration secrets out of command arguments and logs. Allow
SIGTERM and at least 40 seconds for drain/close. Disable automatic restart during
first acceptance; a startup failure must not create a restart loop. Capture only
sanitized lifecycle messages. No supervisor configuration is approved until its
actual persistence mechanism and account are established.

Before enabling ingress, confirm: application schema/role preflight passes; only
the selected loopback port is listening; anonymous API/assets are denied; a bad
Host is rejected; other websites remain healthy. Reuse the saved owner-only
Cloudflare Access application and exact audience, authenticator MFA and selected
private hostname. Verify the tunnel preserves the expected Host. Never change the
public informational site to serve the private application.

The owner must then test real login/MFA, projects, logout, deep links and persistence
across a controlled restart. Measure application RSS and PostgreSQL memory at idle
and under that small workload. No agent execution is included in this stage.

## Remaining private inputs

Before production execution, return only a sanitized confirmation of: dedicated DB
target/isolation, schema-owner and web-role availability, verified backup/restore,
supervisor and persistent data layout, selected unused port, and current verified
owner-subject bootstrap availability. Supply actual credentials/identities only
through the approved private operator channel. These cannot be inferred from
successful compilation or from a previous fixture run.
