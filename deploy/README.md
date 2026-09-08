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
   the two restricted web role files and contacts no database. Compare its digest
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
6. Bootstrap the tenant/workspace and first owner through the existing
   `SecurityStore.bootstrapOwner` procedure after verifying a current owner
   authentication. The issuer and authenticated subject must match Access. Do not
   substitute the owner's email for the subject or copy a fixture identity/grant.
   This owner bootstrap still needs its exact verified input and execution review;
   this document does not turn invented timestamps into verified authentication.
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
