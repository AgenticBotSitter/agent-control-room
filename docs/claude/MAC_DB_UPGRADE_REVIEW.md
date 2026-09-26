# Mac database upgrade review packet

## Scope

`pnpm mac:provision-database -- --upgrade --protected-root ABS --ssh-target USER@HOST`
upgrades the existing dedicated `control_room` PostgreSQL 17 database. The owner
approval covers review and a read-only dry run only. Do not run the mutating
form on the VPS until the owner separately approves the reviewed output.

The upgrade fetches `main` on the VPS and stages the exact pushed upgrade
commit. It refuses if its migration ledger or role files differ from main.
Dependency preparation uses `CI=true pnpm install --frozen-lockfile --offline
--ignore-scripts`. A missing cached package stops the run; there is no network
fallback for package installation. The source worktree is temporary.

`--dry-run` sends one repeatable-read, read-only SQL transaction over SSH.
It reads PostgreSQL's migration ledger, role attributes, memberships, and
direct table, column, schema, database, and function grants. It prints the
pending migration filenames and exact role/grant differences, without passwords.
It makes no PostgreSQL or protected-root changes, and does no VPS Git fetch,
source staging, or package installation.

The mutating command applies the pending ledger migrations through the existing
restricted migrator. It reconciles the five Mac roles against the checked in
role files. The four existing login passwords are never altered. The missing
publisher login alone gets a locally generated password, kept in the protected
Mac root and sent over the existing SSH stdin channel. After remote success,
only `config/database-roles.json` is rewritten to add `publisher` with the
same private endpoint policy as the other roles. `mac-local.json` and the
owner sign-in file are never written. A retry retains the new password and
should report no remaining differences.

## Evidence before live dry run

- On disposable PostgreSQL 17, provisioned migration 0085 and the four original
  Mac logins using the 0085 source files. An extra direct grant was inserted as
  a negative probe.
- The same read-only SQL used for the VPS dry run returned the exact plan from
  that disposable cluster and left its catalog unchanged.
- Upgrade applied migrations 0086–0090 and removed the extra grant.
- Roles, memberships, and direct table and column grants matched an independent
  fresh HEAD provision exactly. The second upgrade had no role or grant diff.
- Local tests confirmed the dry run did not change protected files; the real
  path added only the publisher password and `database-roles.json` entry.
- The old dependency lockfile lacked one package in the local cache. The
  automatic approval review rejected networked installation in that disposable
  checkout. The rehearsal used the exact 0085 SQL and migration files with the
  already installed, same-version PostgreSQL queue tooling instead.

## Review focus

Check the source pin, read-only dry-run behavior, ACL catalog coverage, strict
role attributes and membership comparison, password preservation, and the
transaction boundary around grant changes. Inspect the remote command for
secret exposure and unintended effects. After approval, run the dry-run against
the real VPS and share only its sanitized report with the owner and Claude.
