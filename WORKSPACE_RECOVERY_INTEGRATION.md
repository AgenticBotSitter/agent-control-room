# Workspace recovery integration contract

Status: durable journal and observation implemented; automatic recovery/re-adoption
and runtime integration are not implemented or accepted.

## Reuse and authority

Use native Git for detached checkout mechanics and the existing SQLite bridge
journal for node-local recovery evidence. Do not add another database service,
worktree daemon or custom stash/merge engine. PostgreSQL remains the global write
authority for work admission and leases. Local records cannot renew a lease,
approve work, dispatch an agent or declare a job complete.

The current reusable port is intentionally unwired. Its injected runner still
requires reviewed executable/configuration isolation, bounded execution/output,
no inherited credential helpers and no network. The disposable fixture only
qualifies an empty repository whose configuration it created itself.

## Durable record and transition requirements

Extend the bridge journal rather than replacing its authenticated intake. Bind
each workspace record to exact tenant, project, node, job, attempt, run, lease ID
and lease epoch. Capture admitted revision, canonical repository/workspace roots,
physical identities and operation identity in protected node-local storage.
Never send raw paths through public logs, browser projections or worker receipts.

1. Persist an intent before invoking Git. A unique target reservation must prevent
   two local processes from issuing creation for that same target. This is local
   effect exclusion, not a new global work lease.
2. Record verified creation only after exact detached HEAD, common Git directory
   and physical identity readback. Persist before returning a usable workspace.
3. A crash, missing response or failed readback leaves an unresolved intent. On
   restart, include it in the existing bounded restart inventory; never silently
   treat missing success as proof that creation did not happen.
4. Recovery is initially observation-only. Recheck saved binding against current
   authenticated admission before any new effect. A stale or missing global lease
   does not authorize resume, takeover or deletion.
5. An absent target, exact matching target, changed identity, unexpected branch/
   revision and dirty target are distinct observations. Preserve uncertain or
   changed targets. Only exact reconciled ownership can become usable again.
6. Persist removal intent before Git removal. Retain the current dirty/index-flag/
   committed-work checks. Confirm absence before recording removal success.
   A failed response must not release the reservation as if absence were proven.

Normal removal must never hide a preservation operation. If committed or dirty
work needs recovery, retain it and use the evaluated Agent Orchestrator preservation
route as the next donor candidate; do not grow new automatic stash/merge mechanics.
Closing a project tab is never workspace deletion authority.

## Concrete implementation order

- Add versioned journal records and transactional transitions with exact binding
  checks, bounded inventory and duplicate/conflict tests.
- Connect manager/port intent and readback stages to that journal without changing
  the existing authenticated delivery or global lease rules.
- Add a restart observation path that cannot invoke create/remove/resume.
- Exercise two journal clients, crashes at each intent/readback boundary, missing
  acknowledgement, changed inode/path, dirty files and changed revision using
  disposable local repositories and the existing native test harness.
- Independently review the above and the trusted runner before runtime wiring.

## Acceptance evidence required

Prove one target reservation across concurrent processes, persisted uncertainty
after restart, exact replay without a second create, preservation of tracked/
staged/untracked/ignored/flag-hidden/newly committed work, and no removal for
foreign or changed identity. Prove expired/revoked admission cannot authorize a
new effect. Confirm terminal test processes and exact fixture cleanup. Fake ports,
in-memory maps and a newly constructed service object are not crash-recovery proof.

Platform qualification and production startup remain separate. None of this
document enables a daemon, modifies a live database or grants new credentials.

## Observation implementation checkpoint

The native port now exposes `observeCheckout` separately from create/remove.
Given saved creation identity, it reports absent, unchanged, changed, preserve,
or unavailable. It checks pinned roots/common Git directory, physical checkout
identity, detached HEAD, admitted revision, index flags and all ignored/untracked
status. Optional Git index refresh is disabled for observation commands. Errors
do not become proof of absence. No observation populates process ownership,
releases a journal reservation or grants permission to resume/remove.

These are advisory multi-read observations, not an atomic filesystem snapshot.
Same-user races and mutations after observation remain possible; authorization
and physical checks must be repeated at any future effect boundary. Safe
re-adoption, process-kill recovery and trusted-runner qualification remain open.
Disposable native evidence covers clean/absent/changed identity, untracked and
ignored work, hidden index edits, new commits, failed reads and non-adoption.

## Native interruption evidence

`node --import tsx scripts/test-workspace-git-crash.ts /usr/bin/git` uses a
fixture-owned repository, isolated Git configuration and four exact child workers.
Each worker is stopped with SIGKILL after its Git subprocess has exited: after
creation before readback, after saved creation with unfinished files, after removal
before its marker, and after the saved removal marker. Parent waits for terminal
signal before reopening the journal and checking the physical checkout.

All four passed: expected records survived; existing content was preserved;
removed checkouts were absent; fresh composition refused duplicate creation;
fresh native ports did not adopt removal authority. Exact fixture cleanup passed.
This does not test killing Git mid-command, power loss, arbitrary repository
configuration, or resuming a worker. Safe re-adoption and current global admission
binding remain required before runtime use.

Journal schema8 now retains immutable pre-creation physical root identities.
New journaled creation requires the native root snapshot before its effect;
existing creation without root evidence cannot be retroactively stamped with
current identities. Observation can compare these saved roots with the newly
opened native port. A disposable replacement-root test returns changed even when
the child path is absent in the new root. Supplying no saved roots still produces
only an advisory observation and cannot support adoption.
