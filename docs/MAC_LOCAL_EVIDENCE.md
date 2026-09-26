# Mac-local check evidence (skeleton)

Status: SKELETON. No check has been run. Every evidence cell is empty.

Database limitation (section 10 decision): the four current Mac-local database logins inherit broad application rights. `mac:check-database` establishes connectivity and login identity only; it does **not** prove that one role is barred from another role's writes. Package 5 must narrow those grants and add denied-write probes before the installation can claim least privilege. No live grant change or privilege acceptance is recorded here.

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
