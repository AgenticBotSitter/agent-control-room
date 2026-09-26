# Private local operator command reuse decision

## Decision

Retain the existing Control Room installation journal, private installation
operator, runtime assembly, setup dispatcher, and task bootstrap. Add only a
small fixed-command release connector for `status`, `setup-next`, and `start`.
No donor scheduler, database, daemon, session store, credential store, or
authority model is adopted.

This is a **build a small Control Room-specific connector** decision. The
remaining gap is the product boundary between an already accepted operator and
an extracted release, not a missing command framework or agent runtime.

## Source inspected

- T3 Code, MIT, revision
  `6a699f0f2fbd8847d7ec2df8d9245ce8c2eb8707`: `scripts/install.sh` and
  `apps/server/src/cloud/bootService.ts`. Its version staging and
  stop-before-replace/start-last ordering remain useful references. Its Effect
  services, service-state files, profiles, environment handling, and runtime
  authority are not imported.
- Herdr, Apache-2.0, revision
  `309749ad65f3aa596f077ec23a1bf3ee428b7a04`: `src/cli/server.rs` and
  `src/cli/server_not_running.rs`. Its fixed commands and explicit unavailable
  responses are useful references. Its socket, daemon, session, and remote
  authority remain outside Control Room, and path-bearing errors are not
  copied.
- The retained Hermes UI/Desktop, Ralph Sandbox, and earlier T3 audits in
  `SINGLE_MACHINE_REUSE_AUDIT.md` and
  `INSTALLATION_REUSE_IMPLEMENTATION_MAP.md` were rechecked for fit. None
  replaces this narrow release connector.

No donor source is copied or materially adapted by this package, so no new
third-party notice is required. The existing pinned license records remain the
authoritative attribution evidence.

## Required boundary

The connector must:

- expose only the fixed commands `status`, `setup-next`, and `start`;
- load only release-relative, verified Control Room assets;
- reuse the installed private-configuration custody and canonical journal;
- keep help, import, and malformed commands inert;
- dispatch at most one setup stage per command;
- retain the exact startup result and its owned shutdown lifecycle;
- serialize only bounded, sanitized status; and
- leave missing credentials, database setup, native custody, and owner
  ceremonies as explicit blockers.

It must not add automatic setup loops, arbitrary command execution,
environment-selected factories, browser setup effects, or a second bootstrap.
Real installation and startup remain owner-attended operations.
