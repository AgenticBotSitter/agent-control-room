# W6 and W7 acceptance (the finish line)

**From:** Claude (lead). **To:** Codex. A package is done only when its check passes against the real running system. Source changes or unit tests alone never count.

## W6: `pnpm mac:up`

When you build `mac:up`, make it run `pnpm mac:repin --protected-root <protected root>` before starting the hosts:

- Exit 0: pins are current, or were updated to the same vendor install.
- Exit 1: one worker's CLI moved outside its known install location. Start anyway. That worker shows unavailable, and the others keep working.
- Exit 2: the protected config is missing, unreadable or unsafe. **Do not start.**
- Log its output, because it records every version change.

Run:

```
node scripts/mac-local/acceptance-w6.mjs --protected-root <protected root> --restart
```

- **Exit 0 means W6 is done.**
- Exit 3 means every check passed except the restart check, which was skipped. That is **not done**.
- Paste the PASS/FAIL lines into `MAC_LOCAL_PROGRESS.md` as a REAL entry. The script prints no owner code and no cookie.

## Review gate (every package)

Run:

```
git diff <base>...HEAD | node scripts/mac-local/claude-review.mjs
```

- Exit codes: 0 means approve, 1 means changes requested, 2 means no verdict.
- Codes 1 and 2 both block the package.
- Diffs over 300 KB are refused: split them by package or directory.
- For an untracked file, run `git add -N <file>` first so it appears in the diff.

## W7: real proof, all through the website with no direct database writes

For **each** of Codex, Claude and Hermes, record in `docs/MAC_LOCAL_EVIDENCE.md`: task id, timestamps, final state and a one-line result excerpt.

| # | Check | Pass means |
|---|-------|-----------|
| 1 | Harmless real task | The worker ran as its pinned binary, and the result reached pending review |
| 2 | Accept | The result shows accepted, and the worker shows "proven" only after this |
| 3 | Request changes | A revision task ran and produced a new result, and the old result is kept |
| 4 | Cancel mid-run | The process group was killed and reaped (no leftover process in `ps`), and the task shows cancelled |
| 5 | Restart mid-queue | `pnpm mac:down && pnpm mac:up` with one queued task: it runs exactly once after the restart |

Two checks for the whole system:

| # | Check | Pass means |
|---|-------|-----------|
| 6 | Database route loss | When the direct private database route is unavailable, the site reports unavailable; it recovers when the route returns. The Mac starts no tunnel process. |
| 7 | Backup and restore | A dump of `control_room` restores into a scratch database, and the project and task counts match |

Before writing a table row, always check that nothing leftover is still running: `ps -axo pid,pgid,command | grep -E "codex|claude|hermes"`.

`docs/OWNER_GUIDE_MAC.md` must fit on one screen:

- start the system (`pnpm mac:up`)
- stop it
- sign in (where the owner code is)
- what "ready" and "proven" mean
- what to do if the site says the database is unavailable

## Done

W6 is done when the script above exits 0. W7 is done when:

- the 15 worker rows (5 checks × 3 workers) and the 2 system rows are filled with real data
- the owner guide exists
- the final diff has a real `VERDICT: APPROVE`
- everything is pushed, with nothing merged to main
