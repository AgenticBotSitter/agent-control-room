# Unprivileged supervised service

How the Control Room host runs as an unprivileged per-user service, and exactly
what has and has not been executed.

## Install

The service is a **user unit**, not a system unit. It is installed under the
operator's own account and never enabled system-wide, so nothing here needs root:
the host binds loopback only, writes only inside the operator's home, and needs no
capability grants.

```bash
mkdir -p ~/.config/systemd/user ~/.local/bin ~/control-room
cp examples/release/control-room-user.service ~/.config/systemd/user/
cp examples/release/operator.env.example ~/.config/control-room/operator.env
chmod 600 ~/.config/control-room/operator.env
cp examples/release/operator-config.example.mjs ~/control-room-config.mjs
chmod 600 ~/control-room-config.mjs     # preflight refuses other permissions

systemctl --user daemon-reload
systemctl --user enable --now control-room-user.service
```

Note the deliberate absence of `sudo` in every line. If an install needs
elevation, something is wrong with the configuration rather than missing
privileges.

## Preflight before starting

```bash
node tooling/release/preflight.mjs --configuration ~/control-room-config.mjs
```

Preflight is **static by default**: it checks the Node and pnpm versions, the
custody of the configuration file (owner-only, not a symlink), and artifact
integrity. It opens no listener.

The loopback bind probe is a real effect — it opens a socket — so it is opt-in:

```bash
node tooling/release/preflight.mjs --configuration ~/control-room-config.mjs --bind-probe
```

`--port` without `--bind-probe` is refused rather than silently ignored.

## Start, stop, restart, drain

```bash
systemctl --user start   control-room-user.service
systemctl --user status  control-room-user.service
systemctl --user restart control-room-user.service
systemctl --user stop    control-room-user.service
```

Stop **drains** rather than killing work mid-flight: the unit sends `SIGTERM` and
allows 60 seconds before the process ends, so an in-flight unit can finish or be
marked uncertain. That window is why an interrupted unit becomes an explicit
marker rather than a silent loss — see `release-and-update.md`.

## Bounded resources

- `Restart=on-failure` with `RestartSec=10`, and `StartLimitBurst=5` inside a
  300-second interval: a host that cannot start does not loop forever.
- Logs go to the journal via `SyslogIdentifier=control-room`; the release path's
  own log rotates at 256 KiB into `update.log.1`, so logs stay bounded on disk.
- The configuration example carries explicit limits (`maxConcurrentRuns`,
  `requestTimeoutMs`, `logMaxBytes`).

## Least privilege

The shipped unit sets `NoNewPrivileges=true`, `PrivateTmp=true`,
`ProtectSystem=strict`, `ProtectHome=read-only` with `ReadWritePaths` limited to
the release root, `ProtectKernelTunables`, `ProtectKernelModules`,
`ProtectControlGroups`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`,
`RestrictNamespaces` and `LockPersonality`.

## What has NOT been executed here

**Real systemd start/stop/restart/drain has not been run.** The release path was
built and tested on macOS, where systemd does not exist and no container runtime
was available to this worker — no Docker, Podman, Colima, Lima, Multipass, Vagrant
or QEMU was installed.

What *was* executed and verified is the contract the unit drives: staged
activation, refuse-on-uncertain, rollback, unsafe-target refusal, and preservation
of durable state, all in `tests/release/release-path.test.mjs` against real
archives.

So the honest split is:

- **Verified here:** the release path's behaviour, including every refusal, on a
  real filesystem with real tar archives.
- **Not verified here:** that systemd starts the unit, that the drain window
  behaves as configured, and that the sandboxing directives are accepted by the
  target systemd version.

The remaining work is a Linux integration check: install the unit, start it, send
`SIGTERM` mid-unit and confirm the uncertain marker is written, then restart and
confirm the release path resumes. Until that runs, treat the unit file as
reviewed-but-unexercised rather than proven.

Test-lane registration for `tests/release/release-path.test.mjs` is also deferred
to integration, because it requires edits to `package.json` and the CI workflow,
both outside this package's owned paths.