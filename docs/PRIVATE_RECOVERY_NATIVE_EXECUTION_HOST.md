# Private recovery native execution host

**Status:** source-only process/session boundary with injected fake-host tests.
It has not started a process, read a credential, connected to PostgreSQL,
created or provisioned a cluster, written a backup, restored data, copied an
artifact, or performed a live recovery effect.

## Narrow role

`private-recovery-native-execution-host.ts` fills the missing process-custody
seam between the accepted read-only recovery-tool preflight and the existing
`private-recovery-rehearsal-adapter.ts`. It does not replace either package.

The existing rehearsal adapter still owns the only accepted recovery order and
the final combined database-and-protected-artifact proof. This host supplies
only the adapter's five-method private session shape:

1. inspect the source and disposable destinations;
2. run the already-selected database and protected-artifact backup operation;
3. re-inspect the destinations;
4. restore the exact selected backup;
5. verify restricted logins, then retire the session.

Those methods are fixed and ordered. Callers cannot submit a command, argv,
module, export name, environment, pid, process-group identifier, alternate
tool, alternate recovery sequence, or retry policy.

## Process and tool boundary

Construction is inert and there is no default filesystem, process, database or
network implementation. A future owner-held native implementation must supply
the exact verification and process-group ports.

The source host binds the release, request, native-host pin, all retained
PostgreSQL recovery source pins, and the `node`, `pg_dump` and `pg_restore`
pins into one toolchain digest. It accepts one fixed argv only:

```text
--protocol control-room.private-recovery-native-execution-host/v1
--session isolated-disposable-recovery
--require-fresh-process-group
```

Private source or target addresses and credentials are not argv or environment
fields. They remain inside the injected owner-held native implementation. The
replacement environment exposed by this boundary contains only the fixed
production and C-locale fields.

Launch is deliberately two phase. First, `prepareLaunch` returns a dormant
handle containing the complete start, cancellation, TERM, KILL and group-reap
surface. The host rejects a malformed handle before `start` can run. It then
performs a synchronous current-authority fence immediately before the fixed
start request. A promise is never launch permission. If start is uncertain,
the already captured handle is used to retire and reap the group; custody is
not recovered from a malformed post-launch return value.

Every verification, operation and graceful close is deadline-bounded and gets
an actively cancelled signal. Owner cancellation begins retirement. Retirement
requests a graceful session close, waits for the complete process group, then
escalates to group TERM and group KILL within the fixed retirement window.
Success requires a receipt that the leader and every descendant were reaped.
Forced, malformed, cancelled or timed-out retirement is uncertainty and cannot
produce recovery readiness.

## Disposable-cluster invariant

This package does not infer isolation from a different database name. Before
backup, and again immediately before restore, it requires the exact observation
used by the existing adapter:

- the source is read-only and quiesced;
- the disposable database and protected-artifact destination are empty and
  owner-held;
- the source and restore target identities differ; and
- PostgreSQL role state is isolated at the cluster level.

An invalid observation poisons the session before its stage advances. Catching
that refusal cannot make backup callable. A database on the live source cluster
therefore cannot masquerade as the disposable restore cluster.

## Effect and authority boundary

This source may call an injected native host only after exact verification and
the synchronous authority fence. It cannot acquire credentials, choose private
paths, discover executables, provision roles or a cluster, connect to a
database, create the protected backup destination, implement artifact copying,
or execute any tool by itself. It has no scheduler, journal, receipt store,
browser API, retry, resume, cleanup policy, restore promotion, or recovery
approval authority.

The native implementation remains responsible for securely holding private
inputs, safely joining the retained backup/restore modules and protected
artifact operations, and truthfully producing the adapter's observations.
The owner must still provide an actually isolated disposable PostgreSQL
cluster and allow the real backup/restore rehearsal. Until that native port is
implemented, independently reviewed and owner-qualified, this package is not
live recovery readiness and does not clear the recovery installation gate.

## Verification and integration status

The focused source checks are:

```text
node --import tsx --test tests/private-recovery-native-execution-host.test.ts
./node_modules/.bin/tsc --noEmit --incremental false --project tsconfig.vps.json
```

The focused suite covers inert construction, exact adapter compatibility,
fixed argv and environment, two-phase launch custody, asynchronous-authority
refusal, isolated-cluster refusal before backup, ordered operations, active
cancellation, close-signal cancellation, TERM-to-KILL escalation, complete
group reaping, single use and sanitized uncertainty.

The focused test is registered in the repository's explicit
`test:backup-recovery` lane. Independent review first reproduced cancellation,
error-redaction and cleanup-budget defects. The corrected host combines each
operation signal with the session lifetime, sanitizes native failures only
after retirement, and reserves one absolute deadline across graceful close,
TERM, KILL and final process-group reaping. Short valid cleanup budgets cannot
suppress the final KILL request. Fourteen focused adversarial checks and the
repository TypeScript check pass.

This remains source and disposable-fake evidence. A concrete native port,
protected backup destination, private inputs, and actually isolated disposable
PostgreSQL cluster are still required before an owner-attended recovery run.
