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
schtasks /Query /TN "AgentControlRoomWorkerInbox-<worker>-<digest>" /V /FO LIST | findstr /C:"Last Run Time" /C:"Last Result" /C:"Next Run Time" /C:"Status"
type "<runtime>\watch.log"
```

`Last Result` is the exit code of the last tick (`0` is a clean read, `2` a
read failure); `Last Run Time` plus `watch.log` together prove the schedule
actually fires, not just that it is registered.

## If the importer rejects the XML

A contributor had to convert the generated file before Task Scheduler
accepted it. The emitted bytes are UTF-8 and match the `encoding="UTF-8"`
declaration (a fixture test asserts the on-disk bytes, the declaration, the
absence of a BOM, and LF endings), so the defect is on the importer side, not
in the artifact. Do not "fix" the generator without new evidence. Convert a
COPY to UTF-16 and import that instead:

```powershell
powershell -NoProfile -Command "Get-Content '<path>\<task>.xml' -Raw | Set-Content -Encoding unicode '<path>\<task>-utf16.xml'"
schtasks /Create /TN "<task>" /XML "<path>\<task>-utf16.xml" /F
```

The UTF-8 file stays the owned original; the converted copy is an
importer-side workaround, verified only by your own successful import.

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

If you configured an extra signal directory (the watcher's `--signal-directory`), add
`--signal-directory DIR` to that last command. Without it the extra signal file is left in place
and the command prints the directory to name — that file is removed only when you name it.

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
- Task Scheduler runs the task under your user account and normally receives the user's persistent
  environment, so a normal `gh` installation is on `PATH` and `--token-from-gh` works. That is the
  usual case rather than a guarantee: a `PATH` change made only for one shell session or in a shell
  profile the task does not read is not inherited. If `gh` cannot be found, the tick fails loudly
  with `worker_inbox_platform_gh_token_unavailable` and exit code 1 instead of quietly making
  anonymous requests.
