# Mac-local check evidence (skeleton)

Status: SKELETON. No check has been run. Every evidence cell is empty.

This file is a shape only. It records nothing until a run fills it.

**No check in this file has been run. Every cell under the column headings is empty
by design.** An empty cell means "not yet observed", never "passed". This file is
not evidence of anything until a Phase 5 run fills it with real data.

## How to fill a row

Rules for every row below, from `docs/claude/ACCEPTANCE_W6_W7.md`:

1. **Check for leftover processes before writing any row.** This is required,
   not advisory:
   `ps -axo pid,pgid,command | grep -E "codex|claude|hermes"`
   If anything is still running, resolve it first, then re-run the check. For
   check 4 (cancel mid-run) this same check is part of what the row proves.
2. **No fabricated values.** Every cell must come from something actually
   observed in that run. If a check was not run, leave the row empty. A
   plausible-looking placeholder is worse than an empty cell, because a later
   reader cannot tell it was never real.
3. **Redact before writing.** Never write real IP addresses, `.ts.net` names,
   certificates, passwords, owner codes, cookies, private filesystem paths, or
   raw terminal dumps. This repository is public. Refer to workers and roles by
   identifier only.
4. **One-line excerpt means one line.** Quote or trim the shortest excerpt that
   shows the result. Do not paste whole logs.
5. **No direct database writes.** W7 is proven through the website only, apart
   from the dump-and-restore in system check 7.

## Row identities

The three workers are the enablement kinds `codex`, `claude-code` and `hermes`
(`src/harness/v1/local-adapter-installation.ts`, `LOCAL_ADAPTER_IDS_V1`, mapped
by `kindForHarness` in `src/harness/v1/mac-local-adapter-registry.ts`). Each
runs W7 checks 1-5. Checks 6 and 7 are system-wide and run once.

Check numbering follows `ACCEPTANCE_W6_W7.md`: 1-5 repeat per worker, 6-7 are
system checks. A row is only meaningful when its `#` and its `Worker` agree.

## Worker checks: 15 rows

| # | Worker | Check | Task id | Started (UTC) | Finished (UTC) | Final state | One-line excerpt |
|---|--------|-------|---------|---------------|----------------|-------------|------------------|
| 1 | `codex` | Harmless real task |  |  |  |  |  |
| 2 | `codex` | Accept |  |  |  |  |  |
| 3 | `codex` | Request changes |  |  |  |  |  |
| 4 | `codex` | Cancel mid-run |  |  |  |  |  |
| 5 | `codex` | Restart mid-queue |  |  |  |  |  |
| 1 | `claude-code` | Harmless real task |  |  |  |  |  |
| 2 | `claude-code` | Accept |  |  |  |  |  |
| 3 | `claude-code` | Request changes |  |  |  |  |  |
| 4 | `claude-code` | Cancel mid-run |  |  |  |  |  |
| 5 | `claude-code` | Restart mid-queue |  |  |  |  |  |
| 1 | `hermes` | Harmless real task |  |  |  |  |  |
| 2 | `hermes` | Accept |  |  |  |  |  |
| 3 | `hermes` | Request changes |  |  |  |  |  |
| 4 | `hermes` | Cancel mid-run |  |  |  |  |  |
| 5 | `hermes` | Restart mid-queue |  |  |  |  |  |

### What each worker check must show

| # | Check | Pass means |
|---|-------|-----------|
| 1 | Harmless real task | The worker ran as its pinned binary, and the result reached pending review |
| 2 | Accept | The result shows accepted, and the worker shows "proven" only after this |
| 3 | Request changes | A revision task ran and produced a new result, and the old result is kept |
| 4 | Cancel mid-run | The process group was killed and reaped (no leftover process in `ps`), and the task shows cancelled |
| 5 | Restart mid-queue | `pnpm mac:down && pnpm mac:up` with one queued task: it runs exactly once after the restart |

## System checks: 2 rows

| # | Worker | Check | Task id | Started (UTC) | Finished (UTC) | Final state | One-line excerpt |
|---|--------|-------|---------|---------------|----------------|-------------|------------------|
| 6 | system | Database route loss |  |  |  |  |  |
| 7 | system | Backup and restore |  |  |  |  |  |

### What each system check must show

| # | Check | Pass means |
|---|-------|-----------|
| 6 | Database route loss | When the direct private database route is unavailable, the site reports unavailable; it recovers when the route returns. The Mac starts no tunnel process. |
| 7 | Backup and restore | A dump of `control_room` restores into a scratch database, and the project and task counts match |

## Completion

This file is done only when all 15 worker rows and both system rows hold real
observed data, the owner guide exists, and the final review diff carries a real
`VERDICT: APPROVE`. Until then it is a skeleton: 17 rows, 0 filled.

## Preconditions observed without a running stack (2026-09-25)

These are **not** W7 rows. No task has been run, so every row above stays
empty. This section records only what was directly observed, so a later W7 run
does not have to re-establish it.

| Observation | Command | Result |
|---|---|---|
| Direct database route is reachable for all four roles | `pnpm mac:check-database <protected-root>` | exit 0; `web`, `coordinator`, `results`, `queueWorker` each `ok` |
| The Mac starts no tunnel process | no `ssh`/`autossh` process present; route is direct Tailscale | confirmed, no tunnel in use |
| mac-local provider artifact is still absent | `ls dist-vps/server/macLocalDefaultTaskProvider.js` | `No such file or directory` - the known `mac:up` blocker, owned by package 4 |

The first row matters for check 6: check 6 is only meaningful once the route is
shown to be up and then deliberately down, because "unavailable" cannot be
distinguished from "never worked" without both states. That down-state
transition is still unrun and needs the owner or VPS operator.
