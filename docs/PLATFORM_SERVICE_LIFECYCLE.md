# Platform service lifecycle preparation

**Status:** pure source preparation only. Nothing here installs a service,
launches a process, changes a release pointer, touches data, or grants an agent
permission to work.

## What it adds

`src/installer/v1/platform-service-lifecycle.ts` prepares and verifies one
redacted lifecycle request for macOS `launchd` or Linux `systemd`:

- status is a read-only inspection;
- install verifies the release and service definition, writes the definition,
  and starts the service only after all administrative writes;
- stop first pauses admission, permits a bounded drain, then stops;
- start verifies the already-installed release and definition before starting;
- update stages the same stop-before-replacement/start-last order and records a
  rollback to the exact previously verified release and definition;
- uninstall stops the service and removes only its definition. The authority
  database and protected files are explicitly retained.

The output contains opaque digests and abstract operation names. It contains
no command, path, service label, account, credential, configuration, process
argument, or database address. A separately trusted service observation is
required again during verification, so changing `running` to `stopped` and
recomputing a digest cannot authorize a different plan. The complete
installation plan must be at its ordered, running `platform_service` stage;
the exact action, platform, release, service identity, database, protected
data and observed service state are bound to that stage's input digest. An
untouched, failed, uncertain, completed or changed plan is refused. Every
non-status request also requires all four existing local-supervisor readiness
proofs.

## Reuse evidence

The source review used T3 Code pinned at
`6a699f0f2fbd8847d7ec2df8d9245ce8c2eb8707`:

- `apps/server/src/cloud/bootService.ts`
- `apps/server/src/cloud/bootService.test.ts`

The adapted concepts are stop-before-replacement, a bounded service-manager
stop, service start as the last state-changing step, recovery by restarting the
last verified service definition after a failed update, status separated from
repair, and uninstall that removes the service definition without deleting
application data.

No T3 source text, command table, Effect service, environment/profile store,
runtime downloader, server launcher, service identity, or path convention was
copied. Control Room retains its own
`macos-local-service-package`, `macos-local-service-preflight`, and
`local-supervisor-readiness` contracts. The current work is therefore a clean
concept-level implementation. T3 is MIT licensed; if later work copies or
materially adapts source, its copyright and MIT permission notice must be
added to `third_party/` and `THIRD_PARTY.md` before acceptance.

## Deliberate boundary

An effectful wrapper remains separate future work. It must re-check the
service observation, use the already-reviewed platform package, retain the
one Control Room authority database, record uncertainty after an interrupted
effect, and never infer worker readiness merely because a service started.
