# Johnny5: VPS-local Control Room database upgrade

These are root commands **on the VPS**, not commands for the Mac. This file
contains no host address, password, or verifier. The tagged Mac has no VPS SSH
access; do not grant it SSH to make this upgrade easier. Do not run the apply
step until Claude has reviewed the printed plan and the owner has said "go".
Never paste a password or SCRAM verifier into GitHub or a log. The owner may
relay the verifier privately by chat; it cannot be used to log in by itself.

## 1. Verify the source

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

The two commits must match. Stop if any command fails. The approved local
migration path preserves the existing migrator role and password; it uses a
Unix-socket operator session that assumes the restricted migrator identity
before migration SQL. Do not rotate any existing login password.

## 2. Print the read-only plan for Claude and the owner

Run this only after the reviewed upgrade source is on `main`. A missing
package in the offline cache is a stop, not permission to download on the VPS.
The plan contains only migration filenames and role/grant differences.

```sh
STAGE=$(mktemp -d /var/tmp/control-room-db-upgrade.XXXXXX)
git clone --no-local --depth 1 --branch main "file://$PWD" "$STAGE/source"
test "$(git -C "$STAGE/source" rev-parse HEAD)" = "$(git rev-parse HEAD)"
CI=true pnpm --dir "$STAGE/source" install --frozen-lockfile --offline --ignore-scripts
chown -R postgres:postgres "$STAGE/source"
chown postgres:postgres "$STAGE"
MAIN=$(git -C "$STAGE/source" rev-parse HEAD)
runuser -u postgres -- node "$STAGE/source/scripts/mac-local/database-upgrade-remote.mjs" \
  --plan --expected-main "$MAIN" | tee "$STAGE/plan.json"
```

Send the printed, non-secret plan and digest to Claude for review. Wait for
Claude's assessment and the owner's explicit "go". If approval is delayed,
the later apply command will recompute the plan and refuse if anything changed.
Keep the exact `STAGE` path in private operator notes; if the shell closes,
restore that exact path manually rather than selecting a directory by glob.
The optional Mac `--upgrade --dry-run --snapshot-file ABS` remains available,
but it is not part of this operator sequence.

## 3. One guarded apply after the owner says "go"

The Mac runs `--upgrade --prepare` and privately hands Johnny5 only the
expected main commit and a SCRAM-SHA-256 verifier. The verifier is not the
plaintext password, but treat it as sensitive provisioning material. Confirm
its commit equals `MAIN`. Keep the staged clone and approved `plan.json` from
step 2. The next command compares the plan digest before any write, applies
pending migrations as the restricted migrator through a local peer session,
then creates the publisher and reconciles grants in one operator run. It
refuses unless the final plan is empty. It never takes or changes the existing
migrator password.

```sh
PLAN_DIGEST=$(node -e 'const p=require(process.argv[1]); if(!/^sha256:[a-f0-9]{64}$/.test(p.digest))process.exit(1); process.stdout.write(p.digest)' "$STAGE/plan.json")
read -r -s -p 'Paste the SCRAM verifier privately: ' CR_VERIFIER
printf '\n'
printf '%s\n' "$CR_VERIFIER" | runuser -u postgres -- node \
  "$STAGE/source/scripts/mac-local/database-upgrade-remote.mjs" \
  --apply --expected-main "$MAIN" --expected-plan-digest "$PLAN_DIGEST"
unset CR_VERIFIER
```

The verifier goes through standard input, never an argument or file. The
command refuses a dirty/wrong source, a changed plan, unexpected existing
roles, or grant non-convergence. It does not alter existing login passwords.
Check that the printed `after` object has no pending migrations, missing roles,
memberships, or grant differences. The Mac runs `--upgrade --finish` only
after the publisher login authenticates over the existing private PostgreSQL
route. Keep the staged checkout and plan until Claude accepts the evidence;
then remove only this exact temporary directory through normal cleanup.
