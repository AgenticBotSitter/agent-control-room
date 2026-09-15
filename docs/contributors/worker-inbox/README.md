# Local worker inbox watchers

A small, read-only watcher that runs the accepted public worker inbox on a schedule and
tells you when your assigned action changes. It exists so an operator stops re-checking the
queue by hand while a review is pending.

It now also signals when Ready offers appear or change, even if this worker has no
assignment. `ready-candidate` means inspect and request a claim; `queue-blocked` means
the maintainer must repair the packet, labels or open dependencies. All platforms are
shown so missing capability information never silently hides work. The worker chooses
based on the full assignment; the claim controller makes the reservation decision.

Existing scheduler commands pick up this behavior when their checkout receives the
merged update. Use a fast-forward update only on a clean watcher checkout. Preserve
active implementation branches. A continuously running Node watcher must be restarted
through its existing approved supervisor after updating; scheduled one-shot runs read
the updated code on their next invocation. No new scheduler installation is required.

It reuses [`scripts/public-worker-inbox.mjs`](../../../scripts/public-worker-inbox.mjs) as
the only GitHub client. It does not implement a second queue client, and it never writes to
GitHub: every request it makes is a `GET`.

## Honest limitation: this cannot wake an agent

GitHub cannot wake an idle local process, and this tool does not try to pretend otherwise.
The signal is a bounded local file plus one line on the console. Something that is already
running has to act on it. If you need an agent to start work by itself, that is not this
package; it is the separate scheduler work tracked elsewhere.

Direct agent-wake integration is deliberately not claimed here.

## Requirements

- Node.js 22.13 or newer.
- A checkout of this repository (the watcher reuses the accepted inbox client from it).
- Optional: a GitHub token, to avoid the anonymous rate limit. Set `GITHUB_TOKEN` in your
  environment, or pass `--token-from-gh` to use `gh auth token` in memory. An authenticated `gh`
  by itself is **not** enough: the flag is opt-in, so without one of these the watcher makes
  anonymous requests and will hit the rate limit on a busy repository. Note that under a scheduler
  `--token-from-gh` also needs `gh` on that scheduler's `PATH` — see the platform page for your
  system.

## Quick start

Run one tick by hand. This is read-only and safe:

```sh
node scripts/worker-inbox-platform/worker-inbox-watch.mjs --once \
  --worker-id YOUR-STABLE-WORKER-ID
```

Add `--token-from-gh` to that command if the anonymous rate limit bites. It reads
`gh auth token` in memory; no token value is written anywhere.

You will see one of these, exactly as printed:

```text
Action detected for worker YOUR-STABLE-WORKER-ID: 63:changes-required.
Assigned action changed for worker YOUR-STABLE-WORKER-ID: 63:changes-required.
All assigned action cleared for worker YOUR-STABLE-WORKER-ID.
worker-inbox-watch: No action assigned to worker YOUR-STABLE-WORKER-ID.
worker-inbox-watch: Unchanged for worker YOUR-STABLE-WORKER-ID.
```

A line that tells you to do something is printed on its own. The quieter lines carry a
`worker-inbox-watch: ` prefix, so that in a shared log you can tell the watcher's routine
bookkeeping apart from a line that is asking for your attention.

Then generate the scheduler definition for your platform and follow the instructions it
prints:

```sh
node scripts/worker-inbox-platform/worker-inbox-generate.mjs --all \
  --worker-id YOUR-STABLE-WORKER-ID
```

Generation only writes text files and prints the setup steps. **Installing** the scheduler
entry is a separate, deliberate action you perform; nothing in this package loads a
launchd agent, enables a systemd timer, or registers a Windows task.

## Commands

| Purpose | Command |
| --- | --- |
| One tick, human output | `node scripts/worker-inbox-platform/worker-inbox-watch.mjs --once --worker-id ID` |
| One tick, JSON output | add `--json` |
| Run continuously (default 300s) | `node scripts/worker-inbox-platform/worker-inbox-watch.mjs --worker-id ID` |
| Generate scheduler files | `node scripts/worker-inbox-platform/worker-inbox-generate.mjs --all --worker-id ID` |
| Show what cleanup would remove | `node scripts/worker-inbox-platform/worker-inbox-uninstall.mjs --worker-id ID --dry-run` |
| Remove owned local files | `node scripts/worker-inbox-platform/worker-inbox-uninstall.mjs --worker-id ID` |

Run any command with `--help` for the full flag list.

Cleanup removes only what this tool created. One file is deliberately excluded: if the watcher
was given `--signal-directory DIR`, the extra signal file lives outside the runtime directory,
and it is removed **only** when you name that directory on the uninstall command:

```bash
node scripts/worker-inbox-platform/worker-inbox-uninstall.mjs \
  --worker-id YOUR-STABLE-WORKER-ID --signal-directory DIR
```

Run uninstall without the flag and it prints the directory to pass. This is on purpose: the
ownership marker records where the file went, but recorded state never authorises a deletion.
Anything able to write that marker could otherwise aim cleanup at a file of its own choosing.
Naming the directory yourself is what makes the removal your decision.

## When does it signal?

It fingerprints the whole assignment as the accepted inbox client reports it — every field of
each action, not a hand-picked subset — and compares that to the last value it stored. Any
field changing counts, including the requested state, the trust level, the head, and the pull
request. That matters because the client reports several different situations through the same
broad `state: attention` while carrying what actually changed in other fields; a narrower
fingerprint would call that "unchanged" and the operator would never be told. It signals on:

- **first action seen** (`baseline-action`) — there is now something for you to do;
- **a change** (`action-changed`) — for example a correction, a reassignment, a new head on a
  pull request you are already watching, or a move from `working` to `changes-required`;
- **action cleared** (`action-cleared`) — the work you had is gone.

Notifications name the state the controller requested. Where the client reports only a broad
disposition such as `attention`, the requested state is the one shown, so a correction reads
as `63:changes-required` rather than the uninformative `63:attention`. This package does not
decide authority: trust, dispositions, and whether a record is advisory or a controller record
are the accepted client's, and are surfaced as it reports them.

It rereads the inbox on every tick — that is how it notices a change at all — and it stays quiet
when nothing has changed. What it deduplicates is **notifications**, not requests: an unchanged
inbox still costs the same GitHub reads as a changed one, so the fingerprint saves you console
noise, not rate limit. Budget for the reads accordingly, and use a token (see Requirements) if
the anonymous limit is a concern.

In loop mode the console is for you, not a transcript. It prints when there is something to
act on, when a change has been confirmed, and once for a failure — a repeated identical
failure is recorded in the log but not reprinted every interval. An unchanged poll is
recorded in the bounded log and **not** printed, so a quiet hour produces no console output
at all: no news is the point. `--once` always prints, because you asked for exactly one
result.

An unchanged inbox never rewrites the signal file, so `signal.json` always shows the most
recent *change* rather than the most recent *poll*.

## A read failure is not a change

If the read fails — offline, rate limited, GitHub erroring — the tick records
`lastOutcome: "failure"` and **leaves the observed action untouched**. This matters: if a
failure were treated as an empty inbox, the next successful read would look like a brand-new
assignment, and a real correction could arrive disguised as noise. Recovery therefore
re-reports `unchanged`, not a false change.

## Credentials

No credential is generated, copied, printed, or stored by this tool.

- By default it uses `GITHUB_TOKEN` from your environment if you set one.
- Nothing is required: unauthenticated reads work for a public repository, subject to
  GitHub's anonymous rate limit. If you hit it, the tick reports
  `worker_inbox_api_403` and exits `2`; it never presents a partial result as a full one.
- `--token-from-gh` reads `gh auth token` into memory for the request only. It is never
  written to a file, and any value appearing in an error message is replaced with
  `[REDACTED]` before being logged.
- Generated scheduler definitions contain no token. The systemd unit references an optional
  owner-controlled `EnvironmentFile` with a leading `-`, meaning the service still runs when
  that file is absent.

## Local files

Everything lives under one runtime directory per worker,
`~/.agent-control-room/worker-inbox/<worker>-<digest>/` (override with `--runtime-root` or
`WORKER_INBOX_RUNTIME`):

| File | Contents |
| --- | --- |
| `worker-inbox-platform.marker` | Ownership marker. Its presence is what allows cleanup. |
| `state.json` | Last observed fingerprint and the last outcome. |
| `watch.log` | Bounded log of every tick, including ones that printed nothing. |
| `signal.json` | The most recent change worth acting on. |
| `generated/` | Scheduler definitions produced by the generator. |
| `launchd.out.log` / `launchd.err.log` | macOS only: the console output launchd captures. Kept separate from `watch.log` so two writers never share the file the watcher bounds. |

The log is bounded (64 KiB by default, `--max-log-bytes`). When it would overflow it is
reduced to its recent half with an explicit truncation line, so an unattended watcher cannot
fill a disk and cannot silently lose the newest evidence.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Tick completed (whether or not anything changed). |
| `1` | Configuration error: bad worker ID, bad repository, bad interval, unusable `gh`. |
| `2` | Read failure. Retryable. |
| `3` | Uninstall refused: the directory is not owned by this tool. |

## Uninstall

Unload the scheduler entry first using the command in your platform page, then remove the
local files:

```sh
node scripts/worker-inbox-platform/worker-inbox-uninstall.mjs --worker-id YOUR-STABLE-WORKER-ID
```

Cleanup removes only what this tool created. A directory without the ownership marker is
refused outright (exit `3`), and any file inside an owned directory that this tool did not
create is preserved and reported rather than deleted. Use `--dry-run` to see the list first.

If a `--signal-directory` was configured, add `--signal-directory DIR` here to remove the extra
signal file as well. Without it the file is left alone and the command prints the directory to
name — see the note above.

## Platforms

- [macOS — launchd](macos-launchd.md)
- [Linux — systemd user timer](linux-systemd.md)
- [Windows — Task Scheduler](windows-task-scheduler.md)

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `worker_inbox_api_403` | Anonymous GitHub rate limit. Set `GITHUB_TOKEN`, or pass `--token-from-gh`. |
| `worker_inbox_worker_id_invalid` | The worker ID must match the shape the inbox enforces: `[A-Za-z0-9][A-Za-z0-9._:-]{2,79}`. |
| `worker_inbox_platform_signal_file_not_owned` | Something already exists at the extra-signal path that is not this tool's own signal for this worker. The watcher refuses to overwrite it rather than destroy a file it cannot prove it created. Point `--signal-directory` somewhere else, or move the file deliberately. |
| `worker_inbox_platform_signal_path_is_symlink` | The extra-signal path is a symlink. It is refused whatever it points at: a link is not evidence of ownership and writing through it would replace the link rather than the file it names. Point `--signal-directory` at a directory, and let the tool create the signal file itself. |
| Never signals anything | Run the inbox client itself — `node scripts/public-worker-inbox.mjs --worker-id YOUR-STABLE-WORKER-ID` — and read its `Record:` line; the watcher above does not print it. That line, not the labels, says whether the record is a controller record or advisory. Only a controller **claim** or **handoff** for your worker can be an actionable assignment: the issue must be open, carry **exactly one** matching `status:<state>` label, and a handoff — but not a claim — also needs **exactly one** matching `action:<action>` label. A legacy action marker is **advisory**: the client reports it as needing attention, never as an actionable assignment, so adding labels cannot make it one. Two labels of the same kind are ambiguous and are reported as needing attention rather than as an assignment. |
| Signals stopped | Check `watch.log` for failures. Repeated failures mean the action is *unknown*, not cleared. |
| `Cannot wake an agent` | Expected. See the limitation above. |

## What containment does and does not guarantee

The generator refuses an output directory outside the worker's own `generated/` directory, refuses
a symlinked one outright, and re-checks containment after the artifacts are written. That closes
misconfiguration and the ordinary symlink cases.

It does **not** guarantee that nothing can be written outside the runtime directory. A concurrent
local process that replaces the checked directory with a symlink in the window between the check
and the write can still cause artifacts to go elsewhere, and the post-write check reports that
rather than preventing it. Plain Node has no race-free "open this directory and write through the
handle" call, so this is **best-effort detection, not a boundary against a local attacker who
already has write access to the runtime directory**. It is stated here rather than left implied.

Two related rules, both narrower than they may look:

- Files inside the tool's **own** runtime directory whose names are a temporary this tool can write
  — `state.json`, `signal.json`, or the ownership marker, followed by `.<digits>.tmp` — are treated
  as owned. That is what lets a run killed mid-write still be cleaned up; the alternative is a
  runtime directory that can never be removed. Nothing outside the runtime directory is removed on
  that basis.
- The extra signal file is the one file written **outside** the runtime directory. It is removed
  only when the operator names its directory on the uninstall command, and it is only ever
  overwritten when the file already there parses as this tool's own signal for this worker. A
  symlink at that path is refused outright, whatever it points at.

## Scope

This package is source, documentation, and tests. It performs no install, registers no
persistent scheduler, accesses no credential store, and wakes no agent. Native scheduler
installation is separately authorized and is not claimed by these fixtures.
