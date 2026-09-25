# Update for Claude: Mac-local finish, 2026-09-25 (second pass)

**From:** Marvin. **Branch:** `claude/mac-local-integration` at `237634ad`,
local = remote. `main` untouched at `d7352363`, never merged to.

Supersedes `docs/HANDOVER_MAC_LOCAL_2026_09_25.md`, which was written before
the trust decision landed. Re-verified on the Mac immediately before writing.

## 1. The one-line state

The trust decision is merged and packages 1 and 3 are reviewed and merged.
Package 2, the in-process receipt port, has not landed. Package 4, the
provider assembly, can start as soon as package 2 exists. The database route
is still proven and check 4 was re-verified green again just now.

## 2. Merged since the handover

| Commit | What | Evidence |
|--------|------|----------|
| `d649461c` | Trust decision, `docs/claude/MAC_LOCAL_TASK_RUNTIME_TRUST_DECISION.md` | Docs only, secret scan clean |
| `df335290` | Launchd user-agent service (W6) | 317 lines, 8/8 tests, `tsc` clean, not installed — owner-gated |
| `39a39f40` | Disposable-cluster teardown hardening (my M2 fix) | Back-to-back 14/14 runs, zero `EADDRINUSE` |
| `a902ffee` | W8 model-selection phase and current evidence (owner's doc) | Left intact, not edited by me |
| `237634ad` | Provider packages 1 and 3, plus the rollback checkpoint store | See below |

## 3. Provider packages 1 and 3 — reviewed, `VERDICT: APPROVE`

The gate returned `VERDICT: APPROVE` with "no defects found". I ran the
suites myself before trusting it:

| Suite | Result |
|-------|--------|
| `owner-trusted-local-cli-assert-current.test.ts` | 8/8 |
| `mac-local-task-runtime.test.ts` | 7/7 |
| `mac-local-rollback-checkpoint-store.test.ts` | 7/7 |
| Full `test:mac-local-task-runtime` lane | **22/22**, 0 skipped |
| `tsc --project tsconfig.vps.json` | clean |

Notes from reading the assertCurrent fence, since it is the security-critical
piece:

- It re-derives the lease fresh on every call through a
  `SELECT ... FOR UPDATE` on `control_leases`, requiring **exactly one**
  `state='active'` row. Zero or several fails closed rather than guessing.
- It excludes `issuedAt` and the `deliveryId`/`deliveryDigest` derived from it
  from the comparison, because each `prepare()` restamps them. The run id
  inside `identity` still binds the lease id and plan digest, so a replaced
  lease or plan still differs. That is the correct resolution of the tension in
  the decision, and it is the one place a weaker implementation would have
  been silently wrong.
- It takes the `preparation` instance as a parameter and is shared across all
  three agents, as the decision required. No per-agent copies.
- It does not catch the `prepare()` throw, so a revoked lease propagates
  rather than being swallowed.

The gate also confirmed the task-runtime file refuses rather than
regenerates: an invalid existing file is left in place, keys are canonical
base64url, exactly 32 bytes, unique across roles, writes are `wx` plus
hardlink, and a group/other-readable file or a symlink is rejected.

## 4. Two things I had to decide, and one I could not

**A `package.json` conflict, resolved additively.** Both sides added distinct
scripts and nothing genuinely collided: `test:mac-local-service` and
`mac:uninstall-service` from the launchd merge, against
`test:mac-local-task-runtime` and `mac:prepare-task-runtime` from the provider
branch. I kept all four. Nothing was dropped and no script was overwritten.

**The provider branch moved after I gated it.** Commit `28d492b6` (the
rollback checkpoint store) landed *after* the `VERDICT: APPROVE` run, so that
verdict does not cover it. I reviewed it separately: 7/7 on its own suite,
and the full lane at 22/22 includes it. The commit message says so explicitly
rather than letting the gate's verdict appear to cover code it never saw.

**I could not resolve who commits the owner's doc changes.** They arrived
unstaged in a shared checkout. I have since committed only files I authored,
staging by name, and verified each commit's file list after committing. If you
or the owner are editing `docs/MAC_LOCAL_FINISH_PLAN.md` in this same
worktree, say so and I will keep off it.

## 5. Corrections to my own earlier reporting

Three, all of which changed what my earlier messages were worth.

- **I wrongly reported a concurrent agent.** I said another agent was
  committing to this branch. The reflog proved it was my own merges, and I had
  misread it. There was no phantom. The Phase 6 edit was real and the
  owner's; I have left it alone.
- **I reported a "lost" fix that was a staging error.** My teardown fix first
  appeared missing because my `git add` was scoped to one file while the
  owner's docs were already staged, so the commit I inspected was not the
  commit I made. Fixed by staging by name and verifying the file list after
  every commit since.
- **Earlier, exit codes read after a pipe were not measurements** (`cmd | tail;
  echo $?` reports `tail`'s status), and the first check-5 attempt tested the
  wrong config file, so its `ok` results proved nothing. Both were corrected
  and re-run. Every REAL claim in this document comes from a suite summary
  line or a non-piped exit code.

## 6. The `claude-review.mjs` gate has a scoping footgun

Worth fixing before more packages land. Run as
`--base a36ee22b^` it reviewed the **working tree** rather than the intended
range, and swept in an unrelated file from a different lane. Its finding was
real and worth acting on, but the verdict was attached to the wrong diff.

Suggested change: when `--base` is given, diff `base...HEAD` and refuse to
consider unstaged changes, or require an explicit `--include-worktree` flag.
Until then, gate in a clean detached worktree of the exact commit.

## 7. What is ready, and what I need

**Ready to start the moment package 2 lands — package 4.** Assemble
`src/web/v1/mac-local-default-task-provider.ts`, add the
`vite.vps.config.ts` entry so `mac:up` stops failing at
`macLocalDefaultTaskProvider.js`, and prove it on the rehearsal database:
`mac:up` starts, `/api/v1/local-workers` lists all three workers ready, and
one fake task per worker reaches pending review exactly once. It touches host
startup, so it goes through the gate in a clean detached worktree before it
lands.

**Still owner- or VPS-operator-gated, unchanged:**

- Check 7: from the phone or PC, the database port must **fail** to connect.
- Check 8: Mac sleep and wake, VPS PostgreSQL restart, VPS Tailscale restart.
- Check 9: forced certificate renewal, with `mac:check-database` still passing
  afterwards **and no configuration change on the Mac**.
- The launchd first live install, which needs an explicit owner "yes" against
  the plist label `xyz.agentcontrolroom.mac-local-host`.

**Not started, per your instruction:** M7 and M8 (yours), M6 (waits on W7
running).

No SSH fallback was restored at any point. No password was moved, printed, or
changed. Nothing was merged to `main`. No PR is open.
