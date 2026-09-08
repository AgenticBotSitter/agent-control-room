# Website-only supervision and update handoff

Use an existing supervisor, not a new Control Room process manager. The supplied
`control-room-website.service.in` is a **conditional systemd review template**,
not an installed or host-approved unit. It contains intentionally unresolved paths
and identities. Do not install another supervisor just to use this template.

## Select the real execution environment first

Johnny5 must confirm where the application, PostgreSQL loopback and tunnel execute.
If systemd is not managing that exact namespace, this template is not applicable.
Report the existing supervisor and persistent configuration mechanism; adapt the
same launcher command only after review. A host systemd unit cannot be assumed to
see a container's loopback, private mounts or binaries. Do not publish a database
port, enable host networking, or replace a shared container as a shortcut.

## Conditional systemd profile

The template directly runs the pinned Node executable and existing launcher as a
dedicated non-root account. Set absolute canonical paths outside home directories,
including the immutable release and private settings. The executable operator
module and settings must satisfy the launcher's existing owner/0600 checks. Keep
credentials in the protected settings file, never the unit or command arguments.

First acceptance disables restarts. The unit grants no capabilities and makes the
filesystem read-only except its private temporary area. It intentionally does not
create a private network namespace, which would isolate the existing loopback
database. No migration, provisioning, backup or key-fetch command is installed as
an automatic pre-start hook. Only the restricted website profile is in scope.

`Type=exec` confirms process execution, **not application readiness**. Require the
launcher's ready message plus the approved loopback/authentication acceptance;
do not report a successful `systemctl start` as a usable Control Room. SIGTERM is
the existing shutdown path; the template gives 45 seconds before supervisor
termination. Forced termination is not graceful-cleanup evidence.

Validate the substituted unit with the installed systemd version's
`systemd-analyze verify` before installing it. Review each hardening option against
that namespace and filesystem; do not remove restrictions silently on failure.
No Linux/systemd validation has been performed on this Mac. Capture initial RSS and
cgroup memory alongside other applications, then approve a measured service budget;
the template does not guess a memory ceiling that could OOM-kill the application.
Keep journal contents private and report sanitized lifecycle outcomes only.

## Updates and rollback

Build and test a separate pinned release. Keep the current release/configuration
unchanged while validating the candidate. Check its migration and role delta and
backup/restore requirements before planning a switch. Never `git pull` over a
running release, copy node_modules between machines, or hot-reload trusted code.

For this first website-only profile, use a short approved maintenance window:
stop/drain only Control Room, confirm its process/port has closed, point the reviewed
unit at the new immutable release, then start once and verify. Keep restart disabled
through acceptance. Do not run two writers/listeners against the same port or claim
zero downtime. Other websites need not stop. Agent-task rolling updates require
their later queue/lease compatibility acceptance, not this website-only procedure.

On failure, leave ingress disabled or in its reviewed maintenance state and keep
the application stopped. Switch back only if the prior release is compatible with
the current database schema and exact grants. Otherwise follow the separate restore
plan; never automatically reverse SQL or restore over live data. Only enable boot
startup or a bounded restart policy after the owner approves persistence/restart
acceptance. No installation, update, restart or production start is authorized here.

Behavior references: upstream [systemd service documentation](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)
and [execution options](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).
These are upstream references, not evidence of the target's installed version.
