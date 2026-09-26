# Johnny5: VPS-local Control Room database upgrade

These are root commands **on the VPS**, not commands for the Mac. This file
contains no host address, password, or verifier. The tagged Mac has no VPS SSH
access; do not grant it SSH to make this upgrade easier. Do not run the apply
step until Claude has reviewed the source, the owner has approved the live
plan, and the pending migrations have an approved VPS-local restricted-migrator
procedure. Never paste a password or SCRAM verifier into GitHub or a log.

## 1. Verify the source and inspect migrator use

From the existing VPS checkout, with no running work using that checkout:

```sh
cd /root/agent-control-room
git fetch origin main
git switch main
git merge --ff-only origin/main
git diff --quiet
git diff --cached --quiet
git rev-parse HEAD
git rev-parse origin/main
```

The two commits must match. Stop if any command fails. Inspect the live
migrator role before changing migration execution or its password:

```sh
runuser -u postgres -- psql -X -A -t -v ON_ERROR_STOP=1 -d control_room \
  -c "SELECT usename, application_name, count(*) FROM pg_stat_activity WHERE usename='control_room_migrator' GROUP BY usename, application_name ORDER BY application_name"
rg -l 'control_room_migrator' deploy/postgres src/installer scripts/mac-local db/roles
```

The source inventory includes the owner-tool host, private installer,
provisioner, and rehearsal. Report any unexpected live migrator session or
consumer to Claude. **Do not rotate the migrator password.** The proposed
password-free path is a separate local peer-authenticated operator session
that assumes the existing restricted migrator identity before migration SQL;
it is not yet approved or implemented.

## 2. Produce a read-only snapshot

Run this only after the reviewed upgrade source is on `main`. The snapshot
contains role names, grants, and ledger rows, but no passwords. Keep it
private anyway. A missing package in the offline cache is a stop, not
permission to download on the VPS.

```sh
STAGE=$(mktemp -d /var/tmp/control-room-db-upgrade.XXXXXX)
git clone --no-local --depth 1 --branch main "file://$PWD" "$STAGE/source"
test "$(git -C "$STAGE/source" rev-parse HEAD)" = "$(git rev-parse HEAD)"
CI=true pnpm --dir "$STAGE/source" install --frozen-lockfile --offline --ignore-scripts
node --import tsx "$STAGE/source/scripts/mac-local/database-upgrade-snapshot.mjs" --print > "$STAGE/snapshot.json"
node -e 'const s=require(process.argv[1]); if(s.schema!=="control-room.mac-database-upgrade-snapshot/v1"||!s.mainCommit||!Array.isArray(s.snapshot.applied))process.exit(1); console.log("read-only snapshot: ok",s.mainCommit)' "$STAGE/snapshot.json"
```

Transfer **only** `snapshot.json` to an absolute file path on the Mac through
an owner-approved private file channel. Do not use GitHub or chat for the file.
The Mac then runs `pnpm mac:provision-database -- --upgrade --dry-run
--snapshot-file ABS` from the same clean `main` commit. This reads the file
only; it does not contact the VPS.

## 3. Apply — hold until the migration decision and owner approval

The Mac runs `--upgrade --prepare` and privately hands Johnny5 only the
expected main commit and a SCRAM-SHA-256 verifier. The verifier is not the
plaintext password, but treat it as sensitive provisioning material. Confirm
its commit equals the two commits checked above. If the snapshot plan shows
pending migrations, **stop**: the current VPS-local apply deliberately refuses
them. Do not run schema migrations as the `postgres` superuser and do not ask
the Mac for the migrator password.

After the restricted migration procedure has been reviewed, approved, and
run, repeat step 2. Only when the new snapshot shows no pending migrations,
and the owner has approved the live grant changes, run from the staged clone:

```sh
chown -R postgres:postgres "$STAGE/source"
read -r -s -p 'Paste the SCRAM verifier privately: ' CR_VERIFIER
printf '\n'
printf '%s\n' "$CR_VERIFIER" | runuser -u postgres -- node \
  "$STAGE/source/scripts/mac-local/database-upgrade-remote.mjs" \
  --apply --expected-main "$(git rev-parse HEAD)"
unset CR_VERIFIER
```

The verifier goes through standard input, never an argument or file. The
command refuses a dirty/wrong source, pending migrations, unexpected existing
roles, or grant non-convergence. It does not alter existing login passwords.
After the command reports an empty after-plan, repeat step 2 and transfer a
new snapshot. The Mac owner runs `--upgrade --finish` only after the publisher
login authenticates over the existing private PostgreSQL route. Keep the
staged checkout and snapshot until Claude has accepted the evidence; then
remove only this exact temporary directory through the normal cleanup flow.
