# Unprivileged supervisor template (operator guide)

Run the host as an unprivileged user under `systemd --user`. The template unit
is `examples/release/control-room-user.service` — copy it to
`~/.config/systemd/user/control-room.service` and substitute the bracketed
values (checkout path, config path, port). No root, no system unit, no
`DynamicUser` tricks (the config file must be owned by this UID at mode 0600).

```sh
systemctl --user daemon-reload
systemctl --user enable --now control-room
systemctl --user status control-room
```

## Restart behavior

- `Restart=on-failure` with `RestartSec=10`: crashes restart; clean exits
  (code 0) do not. A restart loop means the config or data is wrong — inspect
  logs (`journalctl --user -u control-room`), do not mask the unit and hope.
- SIGTERM is graceful: the host drains the lifecycle (`lifecycle.completed`
  must report `closed`; anything else is logged as uncertain cleanup and needs
  operator attention). `TimeoutStopSec=60` gives it room, then SIGKILLs.
- In-flight queue work survives restarts in PostgreSQL; verify queue depth and
  recent completions after every restart before accepting new work
  (see `restore-checklist.md`).

## What this template does NOT do

- No public socket, no reverse proxy, no TLS termination — loopback only.
- No database or bucket provisioning, no migrations, no role creation.
- No automatic updates: updating means the `update-rollback.md` procedure
  (new checkout, new artifact, preflight, supervised restart, smoke test).
- Service definitions and production effects are Codex-reviewed before live
  use; this template is a starting point for review, not an approved
  production deployment.
