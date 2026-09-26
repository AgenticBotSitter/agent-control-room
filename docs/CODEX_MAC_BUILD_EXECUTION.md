# Codex execution plan: finish the single-Mac Control Room

**Plan owner:** Claude, lead architect. **Builder and integrator:** Codex. **Second builder and routine reviewer:** Marvin (Hermes Agent).
**Branch:** `claude/mac-local-integration`, already on GitHub. Scope and decisions: [`MAC_LOCAL_CRITICAL_PATH.md`](MAC_LOCAL_CRITICAL_PATH.md).
Follow this file in order. Where this file conflicts with any older plan, this file wins. Only a Claude checkpoint may change this plan (see "How to ask Claude").

## Finish line

The owner opens the Control Room website on this Mac and signs in. They create a project and task and assign it to Hermes, Claude or Codex, then watch it run. They read the saved result and either accept it or request a correction. The existing VPS PostgreSQL is the only authority.

**Owner effort at the end:** zero or one command, plus reading a one-page guide. Everything else is automated or scripted.

## The three-bot team

Codex drives the build and calls the other two bots through their command-line tools. The owner does not have to relay messages.

| Bot | Role | Builds | Reviews | Why |
| --- | --- | --- | --- | --- |
| **Codex** | Builder and integrator: owns the branch, merges packages, runs the real bring-up | W1, W3, W4, W6, W7 and most of W2/W5 | Marvin's code | Has the most usage and can run for hours |
| **Marvin (Hermes)** | Second builder for bounded, file-disjoint work; routine reviewer; independent checker | Route inventory, flag cross-checks, W5 journey test cases, owner guide draft, the independent re-check of the W7 evidence | Codex's routine packages (W1, W5, W6) | Runs locally at no Claude cost, so it can work in parallel |
| **Claude** | Plan owner and architect; security reviewer; final gate | Nothing by default. The owner may open a Claude session to have Claude build W2 (sign-in), which is small and security-critical. | W2, W3, W4 and the W7 final gate; answers plan questions | Limited usage, so it is spent only where judgment matters most |

### How Codex calls Marvin

Run from the relevant worktree. Marvin's final answer comes back on stdout.

```
hermes --in <worktree> -z "<task prompt>"
```

- **Parallel work:** start a Marvin job in the background at the start of a package. Write its output to a log. Collect it before merging.
- **Marvin's code:** Marvin works in its **own** worktree and branch, `hermes/mac-<Wn>-<slug>`. Codex reviews that branch and merges it.
- **Owned files:** give Marvin an explicit list of files it owns. Never assign a file Codex is editing at the same time.
- **Every Marvin prompt must include:**
  - the objective
  - the files it owns
  - the checks to run
  - "Do not commit, push, contact GitHub, read credentials, or start services"
  - "End with RELAY-RESULT: done or RELAY-RESULT: blocked: <reason>"

  Codex commits Marvin's work.
- **Marvin reviews:** send the review prompt plus the output of `git diff <base>...HEAD`. Require a final line of `VERDICT: APPROVE` or `VERDICT: CHANGES`.

### How Codex calls Claude

The Claude CLI lives under Hermes's Node prefix: `$(npm prefix -g)/bin/claude`. Call it read-only:

```
claude -p --model opus --permission-mode dontAsk \
  --allowedTools "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*)" \
  --no-session-persistence
```

- Send the prompt on stdin, from the worktree.
- Use **Opus** for first reviews and plan questions, and **Sonnet** for re-reviews after fixes.
- **Budget:** at most 2 Claude calls per package and about 12 in total. Send only the diff plus the relevant plan section, never the whole history.
- **Plan questions:** 20 lines or fewer, with the options listed. Follow the answer and record it in `docs/MAC_LOCAL_PROGRESS.md`.

### Sandbox note

Codex must run in a mode that is allowed to start `hermes` and `claude`. Both need network access to reach their model providers. If Codex's sandbox blocks this, record it once in `docs/OWNER_ACTIONS.md` and continue without reviews until it is resolved. Never skip the W7 Claude gate.

## Anti-goals (why the build stalled before; do not repeat)

- **No new custody layers.** No native helpers, sealed runtimes, Mach-O checks, receipt ceremonies or WeakMap brands. The trust model is **owner-trusted local CLI** and is final for this phase (critical path decision 3).
- **No second queue, scheduler, database, task lifecycle or approval system.** Reuse:
  - `private-task-host` and `private-task-startup`
  - the pg-boss queue worker
  - the existing planning, approval, result and review services
  - the per-harness `local-delivery-composition`
- **No multi-machine work.** No Linux, remote nodes or Cloudflare. Only follow the five "transition rules" in `BUILD_RELAY_PLAN.md`, which shape records.
- **Fake tests are necessary but never the finish line.** Each package ends with something that really works, or a named owner action.
- **Small packages.** If a package grows past roughly 800 changed lines, stop and ask Claude.

## Operating rules

1. **Branches.** One short-lived branch per package, `codex/mac-<Wn>-<slug>`. Merge it into the integration branch after review, then push. Never merge to `main`.
2. **Checks before merge:** the package's tests, `pnpm check` and `git diff --check`.
3. **Progress log.** After each package, add a short entry to `docs/MAC_LOCAL_PROGRESS.md` (the owner follows it from a phone). It records:
   - what now really works
   - the evidence
   - review verdicts
   - what's next
4. **Owner-only steps.** Add them to `docs/OWNER_ACTIONS.md` as numbered, copy-paste-ready items, then **keep going** on other packages.
5. **The repo is public.** Never commit or print secrets, connection strings, private paths, tailnet hostnames or IP addresses. Protected configuration goes only in the protected Application Support `Protected/config` directory, with mode 0600.
6. **Authority already granted.** The takeover handoff authorizes:
   - the dedicated database and accounts
   - the Mac background service
   - real local agent tasks
   - private routing work

   Do not ask again. Do not touch the owner's other services.

## Work packages

W1 and W4 can run in parallel. Marvin's items run alongside Codex's.

### W1: Mac → existing VPS PostgreSQL (Codex builds; Marvin reviews)

1. `scripts/mac-local/check-database.ts`: a read-only check for each component role. See packet `docs/claude/assignments/CODEX_A2_VPS_DATABASE_READ_CHECK.md`.
2. `scripts/mac-local/provision-database.mjs`: reuses `deploy/postgres/provision-database.sql`, `apply-migrations.mjs` and `migration-ledger.json`.
   - Generates role passwords locally.
   - Writes `Protected/config/database.json` (0600) and never prints it.
   - Creates roles and applies migrations to the existing `control_room` database.
   - Is idempotent.
3. **Reaching the VPS:**
   - If the Mac already has non-interactive SSH access, run the provisioning over SSH.
   - Otherwise add one `OWNER_ACTIONS.md` item: a single command to paste on the VPS.
4. **Private route:**
   - PostgreSQL stays bound to loopback.
   - It is exposed only to the tailnet through Tailscale Serve TCP, with PostgreSQL TLS required.
   - Never run `tailscale serve reset`.
   - Keep the existing 443 forwarding.
5. **Done when:** the check prints `ok` for every role, run from the Mac.

### W2: Website sign-in on this Mac (Codex builds, or Claude if the owner opens a session; Claude reviews)

1. Add a local owner sign-in profile **alongside** the Cloudflare Access verifier. Reuse `src/local-pilot/v1/session-http.ts`.
2. Requirements:
   - binds to `127.0.0.1` only
   - origin is `http://127.0.0.1:<port>`, allowed only when this profile is selected
   - the owner code is generated once and stored hashed
   - the plain code is written only to `Protected/config/owner-sign-in.txt` (0600)
   - cookies are HTTP-only, SameSite=Strict and expiring
   - sign-in attempts are rate-limited
   - maps to the existing owner identity and tenant
3. **Done when** tests prove each of these:
   - no session means refusal
   - a wrong code is refused and rate-limited
   - a foreign `Origin`/`Host` header or a non-loopback bind is refused
   - the correct code reaches the existing project routes

### W3: `mac-local` host mode + one protected configuration (Codex builds; Claude reviews)

1. Add launcher mode `mac-local` in `scripts/run-private-vps.mjs` and `requirePrivateVpsMode`.
   - **Requires:** planning, approvals, quality, results, the native queue, queue recovery, the queue worker, and at least one local worker.
   - **Does not require:** `nativeHttp`, `nativeHttps`, `evidence`, `sessions` or Access.
2. `deploy/mac-local-config.mjs`: a fixed loader. It reads only `Protected/config/*.json` and builds the existing `PrivateTaskStartupConfiguration`.
3. In `mac-local` mode only, replace the admission receipts that cannot be obtained today (`claudeCodeLocalStartupReverification` and the `requireReadyLocalHermesInstallation` gates) with an owner-trusted enablement record. It lists each worker with its absolute executable path and recorded `--version`. Startup refuses if an executable is missing or its version changed.
4. Worker records carry `nodeId: "mac-1"`.
5. **Done when** all of these hold:
   - the host starts in `mac-local` mode with no workers against the real VPS database
   - the owner can sign in
   - projects and tasks survive a restart

### W4: One owner-trusted local CLI worker port + three adapters (Codex builds; Marvin cross-checks flags; Claude reviews)

1. **One generic `deliver` capability** at the queue worker's existing final-authority point. It reuses the `local-delivery-composition` flow:
   - persist the receipt
   - on replay, return recovery instead of running again
   - call `recheckBeforeLaunch` immediately before spawn
   - publish exactly one result to pending review
2. **Per-task controls:**
   - an empty directory at `Protected/runtime/tasks/<taskId>`
   - an environment allowlist
   - a new process group
   - deadline, then TERM, then KILL, then reap
   - a 1 MiB output cap
   - no retry and no resume
3. **Adapters** (text-only first):
   - **Codex:** the CLI bundled in the ChatGPT app, run as `codex exec --json --sandbox read-only --ephemeral --skip-git-repo-check -C <dir> -` with the prompt on stdin. Packet: `CODEX_A1_LOCAL_EXEC_ADAPTER.md`.
   - **Claude:** `claude -p --output-format stream-json --verbose --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --disable-slash-commands` with the prompt on stdin. Reuse the existing strict stream-json decoder.
   - **Hermes:** the existing stream host plus the preserved runner patch (commit `4bd0c6ca`). Make its free-standing admission internal and derive the port from the exact canonical delivery. Tools disabled.
4. **Marvin, in parallel:** run the check in `MARVIN_H3_ADAPTER_FLAG_CROSSCHECK.md` before the adapters are finalized.
5. **Done when** fake-executable tests prove:
   - no spawn after revocation or a task change
   - no second spawn on replay or restart
   - exactly one result published
   - cancel and deadline kill the whole process group
   - no environment leak

### W5: Website journey on real services (Marvin inventories and writes tests; Codex fixes gaps; Marvin reviews)

1. **Marvin:** `MARVIN_H2_WEBSITE_ROUTE_INVENTORY.md`. Report which journey steps lack an installed route.
2. **Codex:** close every gap so each step runs on installed services:
   - create project
   - create task
   - assign worker
   - approve
   - live status (pending, running, failed, review, correction)
   - result
   - accept
   - request correction
   - cancel
   - worker status panel, driven by real readiness and recent work

   Preview and fake panels must be unreachable in `mac-local` mode.
3. **Marvin, in its own branch:** browser test cases for each journey step, in the existing `test:browser:private` / `test:product-browser` lane.
4. **Done when:** the full journey passes against a disposable PostgreSQL.

### W6: One command, as a service (Codex builds and runs; Marvin reviews)

1. `scripts/mac-local/up.mjs`, run as `pnpm mac:up`. It is idempotent. In order, it:
   1. prepares dependencies from the frozen lockfile
   2. builds `dist-vps`
   3. runs the W1 check, provisioning first if needed
   4. writes any missing protected configuration: owner code, integrity keys, the enablement record with pinned executables and versions
   5. installs or refreshes one launchd **user** agent that starts at login and restarts on crash (reuse the macOS service lifecycle code in `src/installer` where it fits)
   6. waits until the host is ready
   7. prints only the URL, the location of the sign-in code file, and ready/not-ready for each worker
2. `pnpm mac:down` unloads the service and never touches data.
3. **Codex runs `pnpm mac:up` itself.**
4. **Done when:** the service survives logout/login and a `kill -9`.

### W7: Real proof, then hand-over (Codex runs; Marvin independently re-checks; Claude final gate)

1. **Codex,** on the real website and service:
   - one harmless task per worker, producing three distinct saved results
   - accept one result
   - request one correction and see it completed
   - cancel a running task
   - make one worker unavailable and confirm the website shows it as unavailable
   - restart the host mid-queue: nothing runs twice, nothing is lost
   - back up the VPS database and restore it into a scratch database
2. **Codex writes:**
   - `docs/MAC_LOCAL_EVIDENCE.md`: what ran, when, result IDs and plain limitations, with no secrets
   - `docs/OWNER_GUIDE_MAC.md`: one page, drafted by Marvin
3. **Marvin re-checks independently.** It uses the website's read routes, or the read-only database check. For each claim in the evidence file it reports CONFIRMED or NOT FOUND.
4. **Claude final gate** on Opus. Input: the evidence file, Marvin's re-check, and a summary of the W2–W4 diffs. Output: ACCEPT or NOT READY.
5. **On ACCEPT:** open one PR from `claude/mac-local-integration` into `main` for the owner. **Do not merge it.**

## What the owner does at the end

- **Best case:** nothing. Open the URL in `OWNER_GUIDE_MAC.md` and sign in with the code from the protected file.
- **Possible one-line items in `OWNER_ACTIONS.md`:**
  - one VPS command, if there is no SSH access
  - approving a macOS or Tailscale prompt, if one appears
  - merging the final PR

## After W7 (out of scope until then)

- The Build Relay (`BUILD_RELAY_PLAN.md`), which lets the three bots keep working unattended through GitHub issues
- Cloudflare Access
- A write/build capability for workers
- VPS, Windows and cloud nodes
