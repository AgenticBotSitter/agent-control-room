# Item 7's updater DDL, verbatim

These files are `git show 00722d26c:<path>` of `src/updater/v1/ddl/*.sql` and
`db/roles/updater_release_reader_roles.sql`: the updater schema as item 7
shipped it. `tests/updater-passkey-postgres.test.ts` (DB-3) applies them, seeds
rows, applies the current DDL over them, and requires the result to match a
fresh install's catalog. Do not edit them; they are the "before" of an upgrade.
