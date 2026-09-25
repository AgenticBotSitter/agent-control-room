# Mac-local finish plan: from the database route to the accepted single-Mac Control Room

**Author:** Claude (lead). **Date:** 2026-09-25. **Executor:** Codex, with Marvin as a second builder.
**Scope and rules:** this plan sequences what remains of `docs/CODEX_MAC_BUILD_EXECUTION.md` (W1–W7)
and `docs/claude/ACCEPTANCE_W6_W7.md`. Where they conflict, those two files win. This file adds order,
parallel lanes, and stop conditions. It does not change a decision.

## Who does what

**Codex (builder, integrator, live operator)**
- Owns both branches and all merges. Commits Marvin's reviewed work.
- Builds and edits all security-relevant code:
  - database route and provisioning (`scripts/mac-local/*`);
  - sign-in, host startup, composer and protected loader;
  - worker adapters;
  - the launchd service.
- Runs every live step:
  - repoint and `mac:check-database`;
  - `mac:up` and `mac:down`;
  - `acceptance-w6.mjs`;
  - real website tasks;
  - backup and restore.
- Writes the final `docs/MAC_LOCAL_EVIDENCE.md` rows and the progress log entries.
- Starts, briefs and collects Marvin's lanes. Calls Claude for the reviews listed under Budget.

**Marvin (second builder and routine reviewer, lanes M1–M6 below)**
- Writes only these, in its own worktree and branch:
  - reports;
  - browser tests;
  - the owner guide draft;
  - the evidence file skeleton.
- Reviews Codex's routine diffs: W1, W5 and W6 non-security code.
- Does the independent W7 re-check.
- Never:
  - runs live steps or starts services;
  - reads `Protected/` or credentials;
  - commits or pushes;
  - touches security-relevant files.

**Claude (plan owner and security gate)**
- Reviews any change to sign-in, host startup, the protected loader or the database route.
- Gives the final W7 ACCEPT or NOT READY. Answers plan questions.
- Does not build.

**Owner**
- Only the four actions listed at the end of this plan.

## Where things stand (verified 2026-09-25)

- **VPS side of the direct route:** accepted (`SECURE_DB_ROUTE.md` checks 1, 2, 6).
- **Mac Tailscale tags:** the Mac now shows `tag:control-room-client` and `tag:general`. There is one
  online `tag:control-room-vps` peer. The repoint preflight should now pass.
- **Repoint code:** approved by Claude (`VERDICT: APPROVE`) but **uncommitted** in
  `the repoint worktree` (branch `claude/mac-local-support`, base `25e3d7fa`).
- **Branches:** `origin/claude/mac-local-support` has 5 commits (the route docs and the cert-renewal fix)
  that are not in `origin/claude/mac-local-integration`. Integration has 21 commits not in support,
  mostly merges and docs plus version-banner and owner-bootstrap fixes.
- **Already built in source:** the W2 loopback owner sign-in, the W3 `mac-local` host and protected loader,
  the W4 three adapters and their queue bridges, W5 route wiring, and `mac:up`/`mac:down` as a spawn-based stack.
- **Not yet proven live:** W1 checks 4–5 and 7–10, W6 acceptance, all of W7.
- **Not built:** the W6 launchd user service, `docs/MAC_LOCAL_EVIDENCE.md` and `docs/OWNER_GUIDE_MAC.md`.

## Standing rules (all phases)

- The repo is public. Never commit or print addresses, MagicDNS names, certificates, passwords,
  owner codes, private paths or terminal dumps. Redact in `MAC_LOCAL_PROGRESS.md`.
- **No SSH database fallback, ever.** If the direct route fails, stop and report.
- One short-lived branch per package (`codex/mac-<Wn>-<slug>`, `hermes/mac-<Wn>-<slug>`). Merge into
  `claude/mac-local-integration` after review, then push. **Never merge to `main`.**
- Before each merge, run the package's tests, `pnpm check` and `git diff --check`, then run the review gate:
  `git diff <base>...HEAD | node scripts/mac-local/claude-review.mjs`. Exit 1 or 2 blocks the merge.
- Append one REAL or SOURCE line to `docs/MAC_LOCAL_PROGRESS.md` per package.
- Before writing any evidence row, check for leftover processes:
  `ps -axo pid,pgid,command | grep -E "codex|claude|hermes"`.
- **Stop and report** (don't work around it) on:
  - a password mismatch after the repoint;
  - any failed security check;
  - a package growing past about 800 changed lines;
  - any step that needs an owner action. Record the action in `docs/OWNER_ACTIONS.md` and continue on the other lanes.
- Stage files by name. The untracked `node_modules` symlink in `the repoint worktree` must never be committed.

## Marvin as a second builder

- **How to call Marvin:** `hermes --in <its own worktree> -z "<prompt>"`, using Hermes profile `cr`,
  model `space-bunny-free` on OpenCode Go. This is the local relay path from `CODEX_MAC_BUILD_EXECUTION.md`,
  not the GitHub job queue.
- **Every Marvin prompt contains:**
  - the objective;
  - the exact files Marvin owns;
  - the checks to run;
  - "Do not commit, push, contact GitHub, read credentials, read Protected/, or start services";
  - "End with RELAY-RESULT: done or RELAY-RESULT: blocked: <reason>".
- Marvin works only in its own worktree and branch, and never on a file Codex is editing.
  Codex reviews Marvin's diff and commits it. Marvin's output is evidence, not authority.
- **Marvin's lanes**, all file-disjoint from Codex:

| Lane | Task | Owns | Starts |
| --- | --- | --- | --- |
| M1 | Re-run `MARVIN_H2_WEBSITE_ROUTE_INVENTORY.md` against the current integration branch. List every journey step with no installed route in `mac-local` mode. | a report file only | Phase 0 |
| M2 | Browser test cases for each W5 journey step, in the existing `test:browser:private` / `test:product-browser` lane, run against a disposable PostgreSQL | new test files under `tests/` that Marvin names up front | after M1 |
| M3 | Draft `docs/OWNER_GUIDE_MAC.md`: one screen, covering the five topics in `ACCEPTANCE_W6_W7.md` | that file | Phase 0 |
| M4 | Draft the `docs/MAC_LOCAL_EVIDENCE.md` skeleton: 15 worker rows and 2 system rows, with empty cells | that file | Phase 0 |
| M5 | Routine reviews of Codex's W1, W5 and W6 diffs. Final line must be `VERDICT: APPROVE` or `VERDICT: CHANGES`. | nothing | per package |
| M6 | Independent W7 re-check: CONFIRMED or NOT FOUND for each evidence claim, using only website read routes or `pnpm mac:check-database` | a report file only | Phase 5 |

Marvin never touches `scripts/mac-local/provision-database.mjs`, `up.mjs`, `down.mjs` or `stack.mjs`,
the protected loader, sign-in, host startup or composer files, or anything under `Protected/`.

## Phase 0: land the approved route change (Codex, mechanical)

1. In `the repoint worktree`, commit the 11 reviewed files by name on `claude/mac-local-support`.
   Commit `docs: …` and `build: …` separately if you prefer. Push.
2. Add this plan to the repo as `docs/MAC_LOCAL_FINISH_PLAN.md` in the same push.
3. Merge `origin/claude/mac-local-support` into `claude/mac-local-integration`.
   - In `MAC_LOCAL_PROGRESS.md`, keep both sides' entries.
   - The integration entry saying "No Tailscale administrator change is required" is superseded by
     revision 3.1. Mark it superseded rather than deleting it.
   - Re-run the repoint test file and `pnpm check` on the merged result, then push.
4. Start Marvin lanes M1, M3 and M4 in the background.

**Done when:** both branches are pushed and the integration branch contains the repoint code.

## Phase 1: finish W1 on the direct route (Codex)

Run these from the integration checkout.

1. Run `pnpm mac:provision-database -- --repoint-only --protected-root <protected-root>`.
   It must print only `{"repointed":true}`.
2. Run `pnpm mac:check-database`. It must print `ok` for all four roles (route check 4).
   If authentication fails, **stop** (see Standing rules).
3. **Check 5:** do one live attempt with a deliberately wrong `serverName`, using a throwaway copy of the
   config rather than the protected original. It must refuse with no plaintext retry. The focused test
   already covers the code path.
4. **Check 8:**
   - Mac sleep/wake, then `mac:check-database`.
   - A VPS PostgreSQL restart and a VPS Tailscale restart, each done by the VPS operator, then
     `mac:check-database` after each.
   - If the VPS steps can't run from here, add them to OWNER_ACTIONS and continue.
5. **Check 9:** the VPS operator force-runs the renewal job. `mac:check-database` must still pass with no config change.
6. **Check 10:** confirm that owner SSH to the VPS and the website both pass, before and after.
7. **Check 3:** record the owner's attestation that the policy diff is only the tag owner plus the one
   grant. Mark it owner-attested, not machine-verified.
8. **Check 7 is an owner action.** Add to OWNER_ACTIONS: from the phone or PC, try to connect to the
   VPS on port 5432. It must fail.
9. Record one REAL progress entry listing each check as passed, failed or owner-pending.
   Marvin (M5) reviews any code that was touched.

**Done when:** checks 1–10 pass or only check 7 remains owner-pending.

## Phase 2: W6 acceptance on the spawn-based stack (Codex)

1. Run `pnpm build`, then `pnpm mac:up -- --protected-root <protected-root>`. It prints the URL,
   the location of the sign-in file, and per-worker readiness.
2. Run `node scripts/mac-local/acceptance-w6.mjs --protected-root <protected-root> --restart`.
   - Exit 0 is required. Exit 3 (restart skipped) is not done.
   - Paste only the PASS/FAIL lines into progress.
3. Fix any failure in its own package. Claude reviews anything touching sign-in, host startup or the
   protected loader. Marvin reviews the rest.

**Done when:** `acceptance-w6.mjs --restart` exits 0 against the real VPS database.

## Phase 3: W4/W5 live, on the real website (Codex fixes gaps; Marvin tests)

1. For each of Hermes, Claude and Codex, run one harmless text task through the website:
   create project, create task, assign, approve, run, result reaches pending review.
2. Take M1's inventory and close each missing route in its own package. Preview and fake panels must be
   unreachable in `mac-local` mode.
3. Merge M2's browser tests once they pass against a disposable PostgreSQL.
4. The worker status panel must reflect real readiness and recent work: make one worker unavailable
   and confirm the site shows it.

**Done when:** the full journey passes in the browser tests and live for all three workers.

## Phase 4: W6 service (Codex; owner confirms once)

1. Add a launchd **user** agent (not system):
   - starts at login and restarts on crash;
   - `pnpm mac:up` installs or refreshes it idempotently;
   - `pnpm mac:down` unloads it and never touches data.
   Reuse the macOS service lifecycle code in `src/installer` where it fits.
2. **Owner gate:** installing a persistent service needs a one-line "yes" from the owner in chat before the
   first live install. Ask once with the exact plist label and path, then proceed.
3. Prove that the service survives logout/login and a `kill -9` of the host. The logout/login step is
   owner-attended.

**Done when:** both survival checks pass and `acceptance-w6.mjs --restart` still exits 0.

## Phase 5: W7 real proof and hand-over

1. Run W7 checks 1–5 for each worker through the website only: harmless task, accept, request changes,
   cancel mid-run, restart mid-queue. Run system checks 6 (route loss and recovery) and 7 (dump `control_room`,
   restore into a scratch database, and compare project and task counts). Fill M4's evidence file
   with task ids, timestamps, final states and one-line excerpts.
2. Finalize the owner guide from M3's draft.
3. Marvin M6 runs the independent re-check.
4. **Claude final gate (one Claude session, Opus):**
   - Input: the evidence file, M6's report, and a summary of the W2–W4 diffs.
   - Output: ACCEPT or NOT READY.
5. On ACCEPT, open one PR from `claude/mac-local-integration` into `main`. **Do not merge it.**

**Done when:** all 15 worker rows and 2 system rows are real, Claude returns ACCEPT, and the PR is open.

## Owner actions across the whole plan (the only things the owner does)

1. Phase 1: try port 5432 from the phone or PC and report whether it connected (check 7).
2. Phase 1: if Codex can't reach the VPS operator, relay the VPS restart and renewal drills (checks 8–9).
3. Phase 4: say "yes" to the launchd user-agent install, then do one logout/login.
4. Phase 5: review and merge the final PR.

## Budget

- **Claude:** about 5 calls in total:
  - reviews of any sign-in, host or loader change (Phases 2–4);
  - the Phase 5 final gate.
- **Marvin:** unlimited within its lanes.
- **Codex:** does everything else.
