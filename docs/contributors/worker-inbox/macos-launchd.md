# macOS — launchd

The generator writes one property list that runs the watcher every `StartInterval` seconds.
It changes nothing until you install it yourself.

## Generate

```sh
node scripts/worker-inbox-platform/worker-inbox-generate.mjs \
  --platform launchd --worker-id YOUR-STABLE-WORKER-ID
```

This writes `com.agent-control-room.worker-inbox.<worker>-<digest>.plist` into the worker's
`generated/` directory and prints the same steps shown below with your real paths filled in.

Check it before installing:

```sh
plutil -lint "$HOME/Library/LaunchAgents/com.agent-control-room.worker-inbox.<worker>-<digest>.plist"
```

## Start

Installing is your deliberate action; the generator never does this.

```sh
cp "<generated>/com.agent-control-room.worker-inbox.<worker>-<digest>.plist" \
   "$HOME/Library/LaunchAgents/com.agent-control-room.worker-inbox.<worker>-<digest>.plist"
launchctl bootstrap gui/$(id -u) \
   "$HOME/Library/LaunchAgents/com.agent-control-room.worker-inbox.<worker>-<digest>.plist"
```

## Inspect

```sh
launchctl print gui/$(id -u)/com.agent-control-room.worker-inbox.<worker>-<digest> | grep -Ei "state|last exit code|last run"
tail -n 40 "<runtime>/watch.log"
tail -n 40 "<runtime>/launchd.out.log"
tail -n 40 "<runtime>/launchd.err.log"
```

`last exit code` is the result of the last tick (`0` clean, `2` read
failure); together with `watch.log` it proves the job fires, not just that
it is loaded.

## Stop

Stopping keeps your files and keeps ownership.

```sh
launchctl bootout gui/$(id -u)/com.agent-control-room.worker-inbox.<worker>-<digest>
```

## Uninstall

```sh
launchctl bootout gui/$(id -u)/com.agent-control-room.worker-inbox.<worker>-<digest> || true
rm -f "$HOME/Library/LaunchAgents/com.agent-control-room.worker-inbox.<worker>-<digest>.plist"
node scripts/worker-inbox-platform/worker-inbox-uninstall.mjs --worker-id YOUR-STABLE-WORKER-ID
```

If you configured an extra signal directory (the watcher's `--signal-directory`), add
`--signal-directory DIR` to that last command. Without it the extra signal file is left in place
and the command prints the directory to name — that file is removed only when you name it.

## What the generated file contains

| Key | Value and why |
| --- | --- |
| `ProgramArguments` | The node path and script as separate array entries, so spaces in any path are safe. |
| `StartInterval` | The poll interval in seconds (default `300`, matching the handbook's foreground watcher). |
| `RunAtLoad` | `true`, so the first tick happens at login rather than one interval later. |
| `ProcessType` | `Background`, so macOS treats the poll as low priority. |
| `StandardOutPath` / `StandardErrorPath` | `launchd.out.log` and `launchd.err.log`, deliberately separate from `watch.log`: launchd appends to these itself, and sharing the file the watcher bounds would break that bound. |

No `EnvironmentVariables` dictionary is written at all, so the agent inherits only launchd's
minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`). That matters specifically for
`--token-from-gh`, which shells out to `gh`: a Homebrew install lives in `/opt/homebrew/bin`,
which launchd does not put on `PATH`, so the flag fails even though it works in your interactive
shell.

It fails **loudly**, which is the good news — you will not quietly lose rate-limit headroom:

```text
worker-inbox-watch: worker_inbox_platform_gh_token_unavailable
```

with exit status 1. The tick does not fall back to anonymous requests.

To make `--token-from-gh` work under launchd, add a `PATH` to an `EnvironmentVariables`
dictionary in the generated property list before bootstrapping it:

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>PATH</key>
  <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
</dict>
```

Extending `PATH` is preferred to putting `GITHUB_TOKEN` here, because it keeps the credential out
of the property list entirely.

## Honest notes

- The generated property list is validated as well-formed XML when it is written, and
  `plutil -lint` accepts it.
- Loading the agent is not performed or verified by this package. `launchctl bootstrap` is
  a real machine change that you run deliberately, and `launchctl print` is the way to
  confirm it took effect.
- The watcher cannot wake an idle agent on this or any platform; see the
  [README](README.md#honest-limitation-this-cannot-wake-an-agent).
