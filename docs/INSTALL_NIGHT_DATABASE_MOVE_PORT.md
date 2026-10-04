# Install-night live database move port

`moveLiveDatabaseV1` is the root-side process boundary for the database worker's
move implementation. The implementation script has one fixed installed path:

`<install-root>/updater/current/bin/move-live-database.mjs`

The port executes that script with the pinned installed Node runtime. Both the
runtime and script must pass T1 path verification before execution. It passes
exactly two arguments: `--request` and one compact JSON value with this shape:

```json
{
  "schema": "control-room.live-database-move/v1",
  "root": "/absolute/install/root",
  "scratchParent": "/absolute/install/root/pg",
  "verifiedDump": true,
  "retainSource": true,
  "accounts": {
    "builder": { "name": "_builder", "uid": 300, "gid": 300 },
    "database": { "name": "_database", "uid": 301, "gid": 301 },
    "service": { "name": "_service", "uid": 302, "gid": 302 }
  }
}
```

The names and numeric identifiers are examples, not policy. The caller supplies
the three accounts created or adopted by the installer. The script must reject
unknown fields, malformed paths, different booleans, account mismatches, and a
scratch directory outside `<install-root>/pg`.

The script owns all database behavior. It must use the production database
login, create and verify a logical dump before changing the destination, restore
into the new `_crdb` cluster, verify the restored database through the production
login, retain the live source database unchanged, and clean only scratch paths
it created. A retry after any refusal or interruption must be safe. It must not
change schema, start services, change `pg/current`, or delete the source.

On success, stdout contains only this compact JSON object (a trailing newline is
allowed):

```json
{"schema":"control-room.live-database-move-result/v1","outcome":"moved","dumpVerified":true,"sourceRetained":true}
```

Any nonzero exit, timeout, signal, extra or malformed result field, false proof,
or second concurrent move for the same install root is a hard failure. Diagnostic
text belongs on stderr and must not contain credentials.
