# Handover: Mac-local finish, state as of 2026-09-25

**To:** Claude (lead). **From:** Marvin. **Branch:** `claude/mac-local-integration`
at `08f36b4d`. `main` is untouched at `d7352363` and was never merged to.

Everything below was re-verified on the Mac immediately before writing this.
Claims marked REAL were produced by a command in this session; anything
owner-attested is labelled as such and is not machine-verified.

## 1. The one-line state

The database route is **fixed and proven**. The application on top of it
**cannot start yet**, because the mac-local task provider has never been
built. Everything from Phase 2 onward is blocked on that one missing
package, not on infrastructure.

## 2. What is done

### Phase 0 — complete

The approved repoint landed. The 11 reviewed files were committed by name on
`claude/mac-local-support` (403 changed lines, under the 800-line stop
condition), the finish plan was added as `docs/MAC_LOCAL_FINISH_PLAN.md`,
and the review gate returned `VERDICT: APPROVE` (exit 0). Support was merged
into integration, both sides' progress entries kept, and the pre-revision-3.1
"no Tailscale administrator change is required" note marked superseded rather
than deleted. On the merged result the focused repoint test passed 5/5 and
`pnpm check` was clean.

The plan file had three references to a throwaway temp worktree redacted
before it entered the public repository, per its own standing rules.

### Phase 1 — checks 3, 4, 5, 10 resolved

| # | Check | Result |
|---|-------|--------|
| 3 | Policy diff | **Owner-attested.** One new rule, `tag:control-room-client` to `tag:control-room-vps`, `tcp:5432`, existing rules unchanged. The diff is not machine-verified: the tailnet policy file is not readable from the Mac. The effect is verified. |
| 4 | Four-role database check | **REAL PASS.** `web ok`, `coordinator ok`, `results ok`, `queueWorker ok`, exit 0, against the live database over the direct route. No SSH, no tunnel. Re-verified again just now. |
| 5 | Wrong `serverName` refused | **REAL PASS.** On a throwaway copy of the protected configuration, all four roles refused, exit 1, the wrong name was never echoed, no password appeared. An unmodified copy of the same files still passed, proving the refusal is caused by the wrong name and not by the copy. |
| 6 | Loopback-only database, HTTPS unchanged | Previously accepted on the VPS side. Not re-run. |
| 10 | Owner SSH and website before/after | **REAL.** The VPS peer's SSH port is reachable and the database re-check passes before and after. No SSH session was opened and no remote command was run. |

Checks 7, 8 and 9 are owner-pending, recorded in `docs/OWNER_ACTIONS.md`
item 3.

### Marvin lanes

| Lane | Deliverable | State |
|------|-------------|-------|
| M1 | `docs/MARVIN_MAC_WEBSITE_ROUTE_INVENTORY.md` | Landed |
| M2 | `tests/mac-local-browser-journeys.test.tsx` + helper, registered as `test:mac-local-browser-journeys` | Landed, 14/14 |
| M3 | `docs/OWNER_GUIDE_MAC.md` | Landed |
| M4 | `docs/MAC_LOCAL_EVIDENCE.md` skeleton, 15 worker + 2 system rows, all cells empty | Landed |
| M9 | Owner-guide known-limitations section | Landed |
| M7 | `scripts/mac-local/acceptance-w7.mjs` | Not started |
| M8 | Backup and restore drill | Not started |

## 3. The blocker, in the shape you need to decide

`pnpm mac:up` requires `dist-vps/server/macLocalDefaultTaskProvider.js`. No
`vite.vps.config.ts` entry produces it and it appears in **no branch's
history** (checked with `git ls-files` and `git log --all`). `mac:up:115`
therefore fails before `createTaskApplication` is ever reached, so no task
lifecycle operation is installed.

Your `docs/claude/DEFAULT_TASK_PROVIDER_PLAN.md` is **stale in a useful
way**: it lists `receiptPort`, `assertCurrent` and `publish` as MISSING. All
three have since landed, including the generic `publish()` in commit
`936c38f9`. The three agent delivery factories also exist
(`createOwnerTrustedLocal{Codex,Claude,Hermes}DeliveryV1`).

What is actually missing is narrower:

1. **No caller anywhere.** Grepping every call site of those three factories
   across `src/` returns nothing outside the file that defines them. They are
   built and tested in isolation and never wired to this host.
2. **No place to put the trust inputs.** `MacLocalProtectedConfigurationV1`
   is exactly six keys — schema, port, workspaceId, localOwnerSession,
   database, enablement. There is no `integrityKey`, no `receiptPort`, no
   authority source. The `Base` the delivery factories require is six keys
   including `assertCurrent` and `publish`.
3. **The trust decision is undefined.** The closest working analogue, the
   Codex VPS composition, needs `authority.assertCurrent(queueId)` plus a
   current-admission digest: a live fence proving enrolment is still valid at
   delivery time. For mac-local there is no stated answer.

`mac-local-host.ts` contains no provider reference at all, so this is a
coordinated change across the provider, the protected configuration schema,
and host startup — all Codex-and-Claude-only files.

**What I need from you:** what `assertCurrent` and the receipt port are for
mac-local, and whether `MacLocalProtectedConfigurationV1` grows a key to hold
them. I deliberately did not invent a fence — a plausible-looking
`assertCurrent` that quietly returns true would grant execution authority to
all three agents, and that is the worst available artifact.

## 4. Corrections I made to my own work

Recording these because they change what my earlier messages are worth.

- **Check 5, first attempt was invalid.** `check-database.ts` builds each
  connection from `database-roles.json`, not `mac-local.json`. I broke the
  wrong file, so all four roles returned `ok` and I nearly logged a security
  finding that did not exist. Redone against the correct file, twice, with a
  control.
- **Exit codes read after a pipe were not measurements.** `cmd | tail; echo
  $?` reports `tail`'s status, always 0. A pnpm run I reported as `EXIT=0`
  had actually failed. The 14/14 M2 result is real because it came from the
  suite's own `# pass 14 / # fail 0` summary, not from a shell variable, and
  it was later confirmed by a log-file run with a genuine `$?`.
- **`PIPESTATUS` is a bash array; zsh calls it `pipestatus`, 1-based.** A
  bash-style `${PIPESTATUS[0]}` under zsh expands to empty rather than
  erroring, so it reads as a blank instead of a failure. My first fix for the
  previous item taught that trap. Corrected in the `shell-pitfalls` skill,
  which now leads with the portable log-and-`$?` form.
- **Two stale owner-guide sections.** M3's banner claimed nothing had ever run
  against the real database, and its section 8 still listed the Tailscale tag
  as an open action. Both fixed; the guide now separates the proven database
  route from the never-started stack.
- **OWNER_ACTIONS item 1 was stale** and said the client tag was not visible
  to the Mac. It is. Marked resolved.

## 5. Two environment notes that will bite other lanes

- **`pnpm <script>` cannot run in a worktree whose `node_modules` is a
  symlink.** pnpm's dependency-status check aborts with `Command failed with
  exit code 1: pnpm install` before the script runs. A pre-existing script
  fails identically there, which is how to tell it from a real breakage. Use
  `node --import tsx --test <file>` in a symlinked worktree; use the pnpm
  wrapper only in the checkout that owns a real `node_modules`.
- **`origin/claude/mac-local-integration` is an ambiguous ref in this clone**
  and resolves to a different local branch — it silently reported `8c72d164`
  when the real head was `1dc015f2`. Every head in this document was read with
  `git ls-remote`. Worth fixing before anyone merges off that ref.

## 6. Owner actions still open

1. **Check 7, the leak test.** From the phone or PC, not the Mac: try to
   connect to the VPS on the database port. It must **fail**. If it connects,
   the client tag is not the only path in.
2. **Check 8.** Mac sleep then wake, `mac:check-database` after each; VPS
   PostgreSQL restart; VPS Tailscale restart. The last two are VPS-operator
   actions and cannot run from the Mac.
3. **Check 9.** VPS operator force-runs the certificate renewal job.
   `mac:check-database` must still pass afterwards **with no configuration
   change on the Mac**. Passing only after editing the protected files is a
   real defect, not a workaround.

No SSH fallback was restored at any point in this work. No password was
moved, printed, or changed. Nothing was merged to `main`. No PR is open.
