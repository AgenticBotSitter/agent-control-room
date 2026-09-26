# Private PostgreSQL owner adapter

## Reuse decision

**Adopt:** the existing append-only installation-plan transaction and its
terminal receipt remain the only durable authority.

**Adapt:** the existing `provision-database.sql`, `applyMigrations`,
`collectDatabaseEvidence`, migration ledger, and structured PostgreSQL target
format are placed behind one injected private tool boundary. The adapter fixes
their entrypoints, arguments, environment names, and reviewed release-file
identities. It introduces no migration engine, SQL, database client, process
launcher, retry queue, or second receipt store.

**Build:** only the missing private configuration/custody binding is new. It
accepts explicit loopback PostgreSQL 17 fields, role passwords and required
evidence tables. It never accepts a connection URL, ambient `PG*` setting,
arbitrary command, arbitrary module, or caller-selected file path.

## Contract and safety boundary

Private composition supplies a custody handle that lends configuration only
for one callback and can then be closed. The adapter itself retains only an
opaque marker. Passwords are passed to the injected tool boundary through
structured targets or the three environment names already consumed by the
existing migration applier; they never enter the returned observation,
command arguments, digest body, error, or installation journal.

Every structured Node target pins TLS mode, client encoding, replication mode,
application name, search path, timezone, binary-result mode and
connection/statement/lock limits. Both Node module requests require the tool
host to replace rather than inherit `process.env`; this is essential because
node-postgres consults ambient `PGBINARY` when a false boolean is supplied.
The `psql` request likewise requires a replacement environment containing only
its reviewed `PG*` values. Host process `PG*` settings therefore cannot redirect
or weaken any route.

The provisioning request is fixed to `psql`, `ON_ERROR_STOP`, the selected
database variable and the reviewed provisioning SQL. Migration and evidence
requests name the exact existing module exports and reviewed ledger. Every
request is bound to the runner's release and request digest and carries the
four reviewed file identities.

The accepted owner runner still owns release verification, full migration-file
verification, attached-terminal confirmation, deadlines, cancellation and
terminal evidence validation. A definite pre-effect refusal remains a refusal.
Migration success is accepted only with the existing bounded result shape and
an exact dense plain applied-entry array (no sparse, subclassed or
method-overridden arrays):
ordered migration filenames and digests, finite nonnegative object count, an
honest no-op flag and exact `applied` login/grant states. Arbitrary status text
is not retained or hashed.

Malformed output, thrown errors, cancellation, lost replies or cleanup failure
after a tool might have started are uncertain and must remain visible for owner
inspection rather than being retried.

Adapter cleanup first closes admission and aborts every active tool signal,
then starts tool cleanup without allowing a non-cooperative cleanup promise to
prevent an independent private-custody close attempt. All waits are bounded by
the runner-owned cleanup signal. A delayed custody callback rechecks both
cancellation and closure and cannot start a post-cleanup tool operation.

## Deliberately not performed

This source package does not read credentials, contact PostgreSQL, launch
`psql` or Node, inspect a live installation, create a database, or publish a
terminal setup receipt. A production custody loader, concrete process/module
boundary and owner-attended rehearsal remain separately authorized work.
