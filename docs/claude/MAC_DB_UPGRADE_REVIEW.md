# Mac database upgrade review packet

## Scope

The original SSH-based design was superseded by Claude's decision: the tagged
Mac must not receive VPS SSH access, and no plaintext password is relayed to
Johnny5. The current upgrade is a three-part handoff: a VPS-local read-only
snapshot, Mac-local plan/prepare, then VPS-local apply followed by Mac-local
finish. See `docs/JOHNNY5_DB_ROUTE_STEPS.md` for the operator sequence.

The owner approval covers source work and disposable rehearsal, not a live
upgrade. No VPS change may run before the offline plan, Claude review, and
owner approval. The VPS-local apply also refuses while migrations are pending:
the password-free restricted-migrator path is a separate security decision.
An attempted source patch for that peer-authenticated path was stopped by the
workspace safety review before it changed any file. No bypass was attempted.

The operator stages only the exact `origin/main` commit on the VPS. Mac modes
require a clean local `main` checkout at the same commit.
Dependency preparation uses `CI=true pnpm install --frozen-lockfile --offline
--ignore-scripts`. A missing cached package stops the run; there is no network
fallback for package installation. The source worktree is temporary.

The VPS snapshot command reads the migration ledger, role attributes,
memberships, and direct grants in one repeatable-read, read-only transaction.
It prints JSON with no password. The Mac's `--upgrade --dry-run --snapshot-file
ABS` validates that snapshot against the checked-out main commit and computes
the exact migration, role, membership, and grant plan without network access.

The Mac's `--prepare` generates a new publisher password under Protected and
prints only its SCRAM-SHA-256 verifier and expected main commit. Treat even the
verifier as sensitive provisioning material; never put it in GitHub or a log.
The VPS-local command receives that verifier on stdin, creates only the missing
publisher login, and reconciles grants. The four existing passwords remain
untouched. `--finish` authenticates the publisher through the approved private
PostgreSQL route before adding its entry to `database-roles.json`; it never
writes `mac-local.json` or the owner sign-in file.

## Evidence before live dry run

- On disposable PostgreSQL 17, provisioned migration 0085 and the four original
  Mac logins using the 0085 source files. An extra direct grant was inserted as
  a negative probe.
- The same read-only SQL used for the VPS dry run returned the exact plan from
  that disposable cluster and left its catalog unchanged.
- In the disposable rehearsal only, the existing restricted migrator applied
  migrations 0086–0090 before the new VPS-local role/grant step removed the
  extra grant. Production will refuse pending migrations until the peer-local
  migrator route is separately reviewed and approved.
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
coverage, password preservation, and transaction boundary around grant
changes. The remaining migration runner decision is explicit; do not mistake
the SSH refusal for an empty grant plan or a reason to restore SSH.
