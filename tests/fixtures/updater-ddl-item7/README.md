# Item 7's updater DDL, verbatim

These files are `git show 00722d26c:<path>` of `src/updater/v1/ddl/*.sql` and
`db/roles/updater_release_reader_roles.sql`: the updater schema as item 7
shipped it. `tests/updater-passkey-postgres.test.ts` (DB-3) applies them, seeds
rows, applies the current DDL over them, and requires the result to match a
fresh install's catalog. Do not edit them; they are the "before" of an upgrade.

## The one exception: `0004_backups.sql`

`0004_backups.sql` is NOT item 7's. It is a verbatim copy of this tree's file,
and it is here because of how the loader works, not because item 7 had it.

`applyUpdaterSchemaV1` takes its file LIST from `updaterDdlFilesV1()` — the
current tree's list, not a directory listing — and only the DIRECTORY from its
caller. So when DB-3 points it at this fixture, it reads every file the current
tree declares, and item 7 never had a `0004`. Without a copy here the read fails
with ENOENT on the first apply, and the test never reaches the assertion the
fixture exists to make: that applying the old DDL through the current loader is
refused with the exact list of tables item 7 was missing.

With the file present, applying the fixture creates the backup tables too, so
they are not part of that missing list. The four the assertion still names —
`passkey_open_registrations`, `passkey_registrations_limits`,
`approval_refusals`, `approval_refusal_buckets` — are item 7's real gap, which
is the point.

If `src/updater/v1/ddl/0004_backups.sql` changes, copy it here again.
