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
launchctl print gui/$(id -u)/com.agent-control-room.worker-inbox.<worker>-<digest>
tail -n 40 "<runtime>/watch.log"
tail -n 40 "<runtime>/launchd.out.log"
tail -n 40 "<runtime>/launchd.err.log"
```

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

## What the generated file contains

| Key | Value and why |
| --- | --- |
| `ProgramArguments` | The node path and script as separate array entries, so spaces in any path are safe. |
| `StartInterval` | The poll interval in seconds (default `300`, matching the handbook's foreground watcher). |
| `RunAtLoad` | `true`, so the first tick happens at login rather than one interval later. |
| `ProcessType` | `Background`, so macOS treats the poll as low priority. |
| `StandardOutPath` / `StandardErrorPath` | `launchd.out.log` and `launchd.err.log`, deliberately separate from `watch.log`: launchd appends to these itself, and sharing the file the watcher bounds would break that bound. |

No `EnvironmentVariables` containing a credential is written. launchd does not inherit your
interactive shell environment, so if you want to avoid the anonymous rate limit either use
`--token-from-gh` when generating, or add an `EnvironmentVariables` dictionary yourself.

## Honest notes

- The generated property list is validated as well-formed XML when it is written, and
  `plutil -lint` accepts it.
- Loading the agent is not performed or verified by this package. `launchctl bootstrap` is
  a real machine change that you run deliberately, and `launchctl print` is the way to
  confirm it took effect.
- The watcher cannot wake an idle agent on this or any platform; see the
  [README](README.md#honest-limitation-this-cannot-wake-an-agent).
