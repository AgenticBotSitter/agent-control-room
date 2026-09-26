# Mac database upgrade review packet

## Scope

The original SSH-based design was superseded by Claude's decision: the tagged
Mac must not receive VPS SSH access, and no plaintext password is relayed to
Johnny5. The current upgrade is a VPS-local read-only plan, Mac-local prepare,
then one VPS-local plan-pinned apply followed by Mac-local finish. See
`docs/JOHNNY5_DB_ROUTE_STEPS.md` for the operator sequence.

The owner approval covers source work and disposable rehearsal, not a live
upgrade. No VPS change may run before Claude reviews the VPS-printed plan and
the owner says "go". The approved VPS-local migration path connects through
the Unix socket as the local PostgreSQL operator, assumes the existing
restricted migrator identity before migration SQL, and leaves its role,
password, and membership unchanged. A prior source patch was stopped by the
workspace safety review before this explicit approval; no bypass was attempted.

The operator stages only the exact `origin/main` commit on the VPS. Mac modes
require a clean local `main` checkout at the same commit.
Dependency preparation uses `CI=true pnpm install --frozen-lockfile --offline
--ignore-scripts`. A missing cached package stops the run; there is no network
fallback for package installation. The source worktree is temporary.

The VPS `--plan` command reads the migration ledger, role attributes,
memberships, and direct grants. It prints the non-secret plan and its digest.
The Mac's optional `--upgrade --dry-run --snapshot-file ABS` still computes a
plan from a read-only JSON snapshot, but no transfer is required in the
operator sequence. The VPS apply recomputes the plan and refuses a changed
digest before any write.

The Mac's `--prepare` generates a new publisher password under Protected and
prints only its SCRAM-SHA-256 verifier and expected main commit. Treat even the
verifier as sensitive provisioning material; never put it in GitHub or a log.
The VPS-local command receives that verifier on stdin, applies pending
migrations through the restricted identity, creates only the missing publisher
login, reconciles grants, and requires an empty after-plan. The four existing
Mac login passwords, migrator, app, and scheduler passwords remain untouched.
`--finish` authenticates the publisher through the approved private
PostgreSQL route before adding its entry to `database-roles.json`; it never
writes `mac-local.json` or the owner sign-in file.

## Evidence before live dry run

- On disposable PostgreSQL 17, provisioned migration 0085 and the four original
  Mac logins using the 0085 source files. An extra direct grant was inserted as
  a negative probe.
- The same read-only SQL used for the VPS dry run returned the exact plan from
  that disposable cluster and left its catalog unchanged.
- The disposable one-run rehearsal applied migrations 0086–0090 under a
  Unix-socket session that assumed the restricted migrator identity, then
  removed the extra grant and created the publisher from its verifier.
- PostgreSQL 17's `pg_authid.rolpassword` values were byte-identical before
  and after for the migrator, app, scheduler, and four existing Mac logins.
- Roles, memberships, and direct table and column grants matched an independent
  fresh HEAD provision exactly. The second upgrade had no role or grant diff.
- Local tests confirmed the offline plan did not change protected files;
  prepare added only the publisher password and protected preparation record,
  while finish added only its `database-roles.json` entry after verification.
- The disposable PostgreSQL 17 test proved a publisher login created from
  the Mac-derived SCRAM verifier accepts the Mac password.
- The old dependency lockfile lacked one package in the local cache. The
  automatic approval review rejected networked installation in that disposable
  checkout. The rehearsal used the exact 0085 SQL and migration files with the
  already installed, same-version PostgreSQL queue tooling instead.

## Live read-only attempt

The original SSH dry run was attempted on 2026-09-26 and refused by the
intentional tailnet policy before SQL ran. An independent `SELECT 1` over SSH
was also refused. This prompted the local-only design above; no VPS database,
file, grant, or SSH policy was changed. A VPS-local snapshot remains pending.

## Review focus

Check the exact-main pin on both hosts, read-only snapshot, offline plan,
SCRAM derivation, publisher authentication before finish, ACL catalog
coverage, unchanged existing role passwords, peer-session identity checks,
plan-digest guard before mutation, and the transaction boundary around grant
changes. Do not mistake the historical SSH refusal for an empty grant plan or
a reason to restore SSH.
