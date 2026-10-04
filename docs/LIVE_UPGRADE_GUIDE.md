# Live database upgrade: owner guide

This is the legacy Mac checkout plus remote-database route, not the install-night system-service updater. Use this only for a reviewed release, with Control Room idle. The rehearsal is a
safety check: it never changes the live database.

## Before you start

- Pause merges. Have the lead prepare a clean `main` checkout and confirm the fetched `origin/main` tip is exactly the reviewed release. This command fetches and fast-forwards to that tip; it has no selected-commit flag. Keep merges paused until it finishes. If the tip changes, stop and have the lead review it before running anything.
- Have the lead supply the existing absolute protected-root path. Replace `<protected-root>` below with that path; do not create a new root or guess it.
- Ensure the VPS has a recent **verified** database backup: one restored and
  checked in a disposable database, not just a new dump.
- Ensure the VPS command and its offline package cache were installed earlier.
- Tell everyone to stop using Control Room. Keep both terminals open.

## Step 1 — on the Mac

Run:

```sh
pnpm mac:upgrade -- --protected-root <protected-root>
```

It checks the clean `main` checkout, fetches and fast-forwards to the current main tip, then stops Control Room and builds it, and prints a short commit. Compare it with the reviewed release before proceeding; a mismatch needs the lead.
Leave it waiting. A first upgrade may print one login code; treat it like a
password and paste it only at the VPS prompt.

## Step 2 — on the VPS

First rehearse the exact release the Mac printed:

```sh
cr-db-upgrade --rehearse COMMIT
```

Replace `COMMIT` with the short commit from the Mac. This restores the latest
verified backup into a temporary database and runs the same plan there. It never
uses the live database port or data directory, and removes the temporary database
whether it passes or fails.

If rehearsal says `REHEARSAL DONE`, run the real upgrade:

```sh
cr-db-upgrade COMMIT
```

Read the plan. If asked, paste the Mac's login code. Type `y` only when the
commit and plan are the reviewed ones; Enter cancels safely.

When the VPS prints `DONE`, return to the Mac and press Enter. It completes
login setup, restarts Control Room, and checks the database connection.

## What success looks like

The VPS prints `REHEARSAL DONE`, then `DONE COMMIT·LEDGER` for the real run. The
Mac completes `mac:status` without error and Control Room opens. Keep the new
pre-upgrade backup.

## If it refuses

Stop there. Common causes are no verified backup, low disk space, a busy
throwaway port, a changed commit, or a connected Mac. Fix the stated condition,
then restart from the Mac command so both machines agree. Never force it,
hand-edit tables, or retry a partly applied real upgrade without review.

## Roll back

If the VPS refused before changing the database, use:

```sh
pnpm mac:upgrade -- --protected-root <protected-root> --rollback
```

This is allowed only while the database ledger did not move. If the real VPS
upgrade changed the ledger, or the outcome is unclear, do not use it. Stop
Control Room, preserve the output and backup, and follow the approved recovery
procedure for the pre-upgrade backup.
