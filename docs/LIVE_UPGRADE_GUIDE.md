# Live database upgrade: owner guide

Use this only for a reviewed Control Room release. It is designed for one person
at two terminals: the Mac that runs Control Room and the VPS that holds its
database. Do not run it during active work. The rehearsal is a safety check; it
does not change the live database.

## Before you start

- Choose the reviewed release commit and pause merges until the upgrade is over.
- Make sure the VPS has a recent **verified** database backup. A verified backup
  has been restored and checked in a disposable database, not merely created.
- Make sure the VPS upgrade command and its offline package cache were installed
  in the earlier one-time setup. Keep both terminals open.
- Tell anyone using Control Room to stop. Keep the Mac connected until the end.

## Step 1 — on the Mac

Run:

```sh
pnpm mac:upgrade
```

This stops Control Room, fetches and builds the reviewed release, and prints the
short upgrade commit. Leave this command waiting. On a first upgrade it may also
print one login code. Treat that code like a password: paste it only at the VPS
prompt and never save it in a note or message.

## Step 2 — on the VPS

First rehearse the exact release the Mac printed:

```sh
cr-db-upgrade --rehearse COMMIT
```

`COMMIT` is the short commit from the Mac. The command restores the latest
verified backup into a temporary, socket-only database, shows the same plan, and
runs it there. It uses temporary login values if the plan adds a login. It never
uses the live database port or data directory, and removes the temporary database
whether the rehearsal passes or fails.

If rehearsal says `REHEARSAL DONE`, run the real upgrade:

```sh
cr-db-upgrade COMMIT
```

Read the plain-language plan. If a login code is requested, paste the one from
the Mac. Then type `y` only when the commit and plan are the ones you reviewed.
Any other answer, including Enter, safely cancels it.

When the VPS prints `DONE`, return to the Mac and press Enter. It finishes any
new login setup, restarts Control Room, and checks its database connection.

## What success looks like

The VPS prints `REHEARSAL DONE` first and `DONE COMMIT·LEDGER` for the real run.
The Mac then completes `mac:status` without an error, and Control Room opens as
usual. Keep the new pre-upgrade backup; it is the recovery point for this run.

## If it refuses

Stop there. The refusal message says what it preserved and the safe next action.
Common causes are no verified backup, not enough backup-disk space, a busy
throwaway port, a changed commit, or a connected Mac. Fix that condition, then
start again from the Mac command so both machines agree on the release. Do not
force the command, hand-edit database tables, or retry a partly applied real
upgrade without review.

## Roll back

If the VPS refused before changing the database, use:

```sh
pnpm mac:upgrade --rollback
```

That rebuilds the Mac's previous release and is allowed only while the database
ledger did not move. If the real VPS upgrade changed the ledger or the outcome is
unclear, do not use that shortcut. Stop Control Room, preserve the output and
backup, and follow the approved database-recovery procedure to restore the
pre-upgrade backup into the approved recovery target.
