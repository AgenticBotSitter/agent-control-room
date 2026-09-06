# E82 — make recent protections part of normal verification

2026-09-06. Local test integration; no GitHub Actions, download or live deployment.

The standard main test command was missing five recently added files: bounded
checkpoint calls, etcd record/access mapping, host shutdown, host lifecycle and the
launcher argument/path checks. The compiled VPS build/test command also omitted the
new compiled launcher journey. These are now included exactly once. A package-script
inventory test prevents those omissions from returning; existing CI-lane partitioning
continues to derive from the standard lifecycle without any GitHub invocation.

Retained external etcd-package research diagnostics are intentionally NOT added to
default tests: normal verification must not silently depend on an ephemeral download
directory or acquire packages. Application adapter tests use local fake transports.
The launcher still cannot start resources through help/refusal tests.

POSIX ownership/permission launcher tests are explicitly skipped on platforms without
getuid. The VPS launcher is POSIX-scoped; skipped tests are not Windows acceptance.
Argument/help checks remain portable. Mac tests execute the POSIX cases without skips.

Ten inventory/lane checks, five launcher/inventory checks and targeted lint pass.
The complete pnpm test lifecycle exited 0 in one run, retained at
`/private/tmp/cr-e82-full.log`: pretest 773 pass; main 1,872 pass/two platform skips;
posttest 481 pass. Total 3,126 pass, zero failures/cancellations, two skips.
No whole-build completion percentage or live-fleet readiness follows from test counts.
The updated standard `pnpm run test:build:vps` exited 0, rebuilding the release and
passing all 44 compiled checks, including the newly registered launcher journey.
