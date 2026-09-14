# Linux — systemd user timer

The generator writes a oneshot service and a timer that activates it periodically.

## Generate

```sh
node scripts/worker-inbox-platform/worker-inbox-generate.mjs \
  --platform systemd --worker-id YOUR-STABLE-WORKER-ID
```

This writes `agent-control-room-worker-inbox-<worker>-<digest>.service` and `.timer` into the
worker's `generated/` directory and prints the steps below with your real paths.

## Start

Installing is your deliberate action; the generator never does this.

```sh
mkdir -p "$HOME/.config/systemd/user"
cp "<generated>/agent-control-room-worker-inbox-<worker>-<digest>.service" \
   "<generated>/agent-control-room-worker-inbox-<worker>-<digest>.timer" \
   "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now agent-control-room-worker-inbox-<worker>-<digest>.timer
```

## Inspect

```sh
systemctl --user list-timers agent-control-room-worker-inbox-<worker>-<digest>.timer
systemctl --user status agent-control-room-worker-inbox-<worker>-<digest>.service
journalctl --user -u agent-control-room-worker-inbox-<worker>-<digest>.service -n 40 --no-pager
tail -n 40 "<runtime>/watch.log"
```

To check the unit files parse before enabling them, `systemd-analyze --user verify` with the
unit paths is the authoritative check on a Linux host.

## Stop

```sh
systemctl --user disable --now agent-control-room-worker-inbox-<worker>-<digest>.timer
```

## Uninstall

```sh
systemctl --user disable --now agent-control-room-worker-inbox-<worker>-<digest>.timer || true
rm -f "$HOME/.config/systemd/user/agent-control-room-worker-inbox-<worker>-<digest>.service" \
      "$HOME/.config/systemd/user/agent-control-room-worker-inbox-<worker>-<digest>.timer"
systemctl --user daemon-reload
node scripts/worker-inbox-platform/worker-inbox-uninstall.mjs --worker-id YOUR-STABLE-WORKER-ID
```

If you configured an extra signal directory (the watcher's `--signal-directory`), add
`--signal-directory DIR` to that last command. Without it the extra signal file is left in place
and the command prints the directory to name — that file is removed only when you name it.

## What the generated units contain

| Directive | Value and why |
| --- | --- |
| `Type=oneshot` | One tick per activation, so no long-lived service is left resident. |
| `ExecStart` | Every argument individually quoted, with `%` escaped as `%%`, because systemd both parses quotes itself and treats `%` as a specifier. |
| `OnUnitActiveSec` | The interval between ticks (default `300s`). `Persistent=false`, so a missed run is not replayed at login. |
| `EnvironmentFile=-"<runtime>/env"` | Optional, quoted, and the leading `-` means the service still runs when the file is absent. This is where *you* may put a token; the unit never contains one. |
| `WorkingDirectory` | Quoted, because systemd splits unquoted values on whitespace. |
| `Nice=10` | Keeps the poll out of the way of interactive work. |

## Honest notes

- A systemd **user** service does not inherit your interactive shell environment, which is
  why token use is expressed as an owner-controlled `EnvironmentFile` rather than baked into
  the unit. Create `<runtime>/env` yourself if you want one; this tool never writes it.
- The same restriction applies to `--token-from-gh`: the unit sets no `PATH`, so the flag only
  works if `gh` is on the service's default `PATH`. If it is not, the tick fails loudly with
  `worker_inbox_platform_gh_token_unavailable` and exit status 1 rather than silently falling
  back to anonymous requests (`EnvironmentFile` with `GITHUB_TOKEN`, or adding a `PATH` to the
  unit, both fix it). The launchd page shows the equivalent macOS failure in more detail.
- The generated units are validated for the quoting and escaping rules above by the focused
  tests, and `systemd-analyze --user verify` on a Linux host is the authoritative check.
  Enabling the timer is not performed or verified by this package.
- The watcher cannot wake an idle agent; see the
  [README](README.md#honest-limitation-this-cannot-wake-an-agent).
