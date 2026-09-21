# Installation build packages

These packages turn the supported installation experience into parallel,
reviewable work. Each package must preserve one PostgreSQL authority, the
existing scheduler and the existing task/result/review lifecycle. A package is
not complete merely because its unit tests pass; its stated acceptance journey
must also pass.

## Active foundation

### I0 — Reproducible release and self-contained preflight

- **Reuse:** adapt T3 Code's pinned version-directory, staging, checksum,
  install-complete and atomic-switch mechanics; retain Control Room build and
  license inventory.
- **Output:** release archive, manifest/checksum, compiled preflight and an
  extracted-release smoke test with no developer dependencies.
- **Accept when:** an altered file, missing file, link, wrong version, oversized
  file or manifest mismatch is refused before setup; the exact accepted release
  digest is available for later activation binding.

### I1 — First-run setup page

- **Reuse:** existing React setup summary, capability cards and protected
  readiness projection; donor UI is reference only.
- **Output:** one guided page showing release, placement, authority, protected
  data, owner, recovery, service, agents and final review stages.
- **Accept when:** missing or failed proof cannot look passed, private values
  never enter browser data, and no page control itself performs an effect.

## Parallel implementation after I0/I1 contracts settle

### I2 — Resumable installation coordinator

- **Owner:** lead architecture/security implementation.
- **Reuse:** installation readiness, transition journal and first-owner marker.
- **Output:** one durable plan that records not-started, running, passed,
  failed or uncertain for each setup stage and binds every pass to I0's release
  digest.
- **Accept when:** restart resumes evidence rather than repeating an effect;
  changed input invalidates dependent proof.

### I3 — PostgreSQL setup action

- **Reuse:** existing role SQL, migration runner, ledger and schema/role
  evidence.
- **Output:** an installation-owned wrapper around a new empty target; no SQL
  or password is supplied by the browser.
- **Accept when:** creation, migration, grants, repeated preflight and a broken
  target are distinguished; no shared login or second authority is accepted.

### I4 — Protected data and recovery action

- **Reuse:** persistent local storage, protected artifact inventory, database
  backup/restore and Restic adapter.
- **Output:** owner-private data root plus a bound backup and disposable restore
  record.
- **Accept when:** database ownership/grants, required canonical rows and all
  protected result fingerprints pass after restore.

### I5 — Platform service lifecycle

- **Reuse:** existing macOS service definition/preflight plus narrowly adapted
  T3 service ordering and tests.
- **Output:** status, install, stop, drain, start, update, rollback and
  data-preserving uninstall behind explicit owner actions.
- **Accept when:** a failed update restarts the last verified release; start is
  last; stop/drain is bounded; service state never implies agent readiness.

### I6 — Clean-install and upgrade acceptance harness

- **Reuse:** release smoke, product-browser acceptance and existing disposable
  PostgreSQL lifecycle fixtures.
- **Output:** install from an extracted release into an empty destination,
  create project/task, restart, restore, upgrade, pre-write rollback and retain
  data through uninstall.
- **Accept when:** the journey uses only public release entrypoints and setup
  APIs, never repository source paths or direct fixture shortcuts.

## Agent activation packages

### I7 — Hermes first useful worker

- Bind the already-qualified runner privately to I2–I5 evidence.
- Start with one bounded text-review task; prove one delivery, one result, one
  review/correction and no duplicate after restart.
- A later code-writing route requires separate workspace/file/command and
  cancellation qualification.

### I8 — Claude local worker

- Qualify the installed CLI input/authentication/cancel/reap behavior.
- Add only the missing process host beneath the existing owned session,
  decoder, staging and recovery path.
- Prove one bounded task, denied action, cancellation and restart recovery.

### I9 — Codex local worker

- Complete the Mac executable/private-state custody proof.
- Add the smallest Mac process acquisition beneath the existing App Server
  contract; do not import a second session or task authority.
- Prove the same result/review/correction/restart journey.

## Several-computers continuation

### I10 — Remote worker placement

- Reuse I0–I9 controller, installer, database, scheduler and lifecycle.
- Add enrollment, compatibility, reconnect, revocation and controlled two-node
  proof for the existing signed delivery packet.
- An uncertain remote delivery remains uncertain until a durable receipt or
  result resolves it; it is never guessed safe to resend.

## Parallelism rules

- I0 and I1 can proceed together.
- After their public contracts settle, I3, I4 and I5 can proceed in parallel
  while the lead owns I2 and integration.
- I6 begins as soon as I0 and the inert portions of I2–I5 are available.
- I7 begins before I8/I9, but source-only I8/I9 preparation may continue in
  parallel.
- I10 may prepare source contracts in parallel but no two-computer effect is
  attempted before the local lifecycle passes I6/I7.
- Every implementation packet cites
  [INSTALLATION_REUSE_IMPLEMENTATION_MAP.md](INSTALLATION_REUSE_IMPLEMENTATION_MAP.md)
  and records why any new custom component cannot be borrowed.
