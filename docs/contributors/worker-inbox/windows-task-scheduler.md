# Windows — Task Scheduler

The generator writes one Task Scheduler definition that runs the watcher every five minutes.

## Generate

```powershell
node scripts\worker-inbox-platform\worker-inbox-generate.mjs --platform windows --worker-id YOUR-STABLE-WORKER-ID
```

This writes `AgentControlRoomWorkerInbox-<worker>-<digest>.xml` into the worker's
`generated\` directory and prints the steps below with your real paths.

## Start

Installing is your deliberate action; the generator never does this.

```powershell
schtasks /Create /TN "AgentControlRoomWorkerInbox-<worker>-<digest>" /XML "<generated>\AgentControlRoomWorkerInbox-<worker>-<digest>.xml" /F
```

## Inspect

```powershell
schtasks /Query /TN "AgentControlRoomWorkerInbox-<worker>-<digest>" /V /FO LIST
type "<runtime>\watch.log"
```

## Stop

Stopping keeps your files and keeps ownership.

```powershell
schtasks /Change /TN "AgentControlRoomWorkerInbox-<worker>-<digest>" /DISABLE
```

## Uninstall

```powershell
schtasks /End /TN "AgentControlRoomWorkerInbox-<worker>-<digest>"
schtasks /Delete /TN "AgentControlRoomWorkerInbox-<worker>-<digest>" /F
node scripts\worker-inbox-platform\worker-inbox-uninstall.mjs --worker-id YOUR-STABLE-WORKER-ID
```

## What the generated task contains

| Element | Value and why |
| --- | --- |
| `<Command>` | The node executable itself. Task Scheduler hands `Command` and `Arguments` straight to `CreateProcess`, so no batch wrapper is needed and no shell re-parses the paths. |
| `<Arguments>` | The script and every flag, each individually double-quoted, so a path containing spaces or `&` survives. |
| `<WorkingDirectory>` | The checkout root. |
| `<Repetition><Interval>` | `PT5M` by default, from `--interval`. |
| `<MultipleInstancesPolicy>` | `IgnoreNew`, so a slow tick cannot stack up behind itself. |
| `<LogonType>` | `InteractiveToken` with `RunLevel` `LeastPrivilege`: the least privilege that still lets a scheduled task run under your own account. |
| `<ExecutionTimeLimit>` | `PT10M`, so a hung tick cannot linger indefinitely. |

No credential appears anywhere in the file.

## Honest notes — please read this one

- The generated XML is validated as well-formed when written, and has been parsed
  successfully by a third-party XML parser. **Native `schtasks` registration was not
  performed and is not claimed by this package**, because it requires a Windows host.
- After registering, confirm the task actually exists before relying on it:

  ```powershell
  schtasks /Query /TN "AgentControlRoomWorkerInbox-<worker>-<digest>" /V /FO LIST
  ```

  That read-back is the evidence; a successful `/Create` with no follow-up `/Query` proves
  nothing.
- This package ships no `.cmd` or `.ps1` wrapper on purpose. A wrapper would be a shell
  script that cannot be syntax-checked outside Windows, and `CreateProcess` does not need
  one.
- The watcher cannot wake an idle agent; see the
  [README](README.md#honest-limitation-this-cannot-wake-an-agent).
