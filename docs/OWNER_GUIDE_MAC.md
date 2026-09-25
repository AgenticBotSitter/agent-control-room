# Owner Guide: Running the Control Room on One Mac (DRAFT)

> **PARTLY PROVEN. Read section 9 before you rely on anything here.**
>
> The database route is **real and working**: the four database roles were verified against the
> live database on 2026-09-25, and a deliberately wrong server name was confirmed to be refused
> with no password in any output. The commands and output strings in sections 1 and 2 are still
> read from the scripts in this branch rather than captured from a full run of the stack.
>
> The stack itself has **never been started**, because the mac-local task provider is not built
> yet. Until it is, starting the system will stop with `release build missing` or
> `<module> missing: run pnpm build`. Section 9 lists every known limitation, including the
> parts of the journey that are routed but cannot work.
> The repository is public: nothing here contains secrets, addresses, or private paths.

Run every `pnpm` command from the repository root, on the Mac that holds the workers.

## 1. First time only (one-time setup)

| # | Step | Who | Command / note |
|---|------|-----|----------------|
| 1 | Confirm the Mac's approved Tailscale client tag is showing | **Owner-only** | See `docs/OWNER_ACTIONS.md` item 1. Bots cannot do this. |
| 2 | Create the database and protected configuration | Agent, at your request | `pnpm mac:provision-database -- --protected-root <protected-root> --ssh-target <user@host> --database-host <host> --remote-worktree <absolute-path>` — **unproven** |
| 3 | Point the Mac at the current database route | Agent | `pnpm mac:provision-database -- --repoint-only --protected-root <protected-root>` — **unproven** |
| 4 | Build once | Agent | `pnpm build` |
| 5 | Start (see section 2) | Owner or agent | `pnpm mac:up` |

Step 2 is a one-shot installer. It sends secrets over SSH on standard input, never as command
arguments, and never prints them. Re-running it converges: existing protected password files are
reused. Step 3 changes no password and no remote state — it only re-reads the local route.

## 2. Start the system

```
pnpm mac:up -- --protected-root <protected-root>
```

Starts in a fixed order: repin workers, check database, bootstrap owner, write task provider,
start task host. The database is reached directly over the private route; **no tunnel process is
started**. Running it twice is safe — a second run reports `already running (pid ...)`.

Success ends with:

```
mac:up running: http://127.0.0.1:3210
```

Then open that address in the browser and sign in.

If `pnpm mac:up` reports `already running`, you do not need to do anything.

## 3. Sign in

The owner sign-in code is created once, during section 1 step 2, and stored in the protected
directory:

```
<protected-root>/config/owner-sign-in.txt
```

| Rule | Detail |
|------|--------|
| Read it with a text editor, or `open <protected-root>/config/owner-sign-in.txt` | Single line of text. No leading or trailing spaces. |
| **Never share it.** Not in chat, not in email, not in this repository, not in a screenshot. | This repository is public. |
| Never paste it into a terminal you are screen-sharing | It is a password. |
| Sessions last 8 hours | Re-enter the code when the site asks again. |

If the file is missing, the Mac was provisioned against a different protected root. See
`docs/OWNER_ACTIONS.md`; do not run the provisioner again just to get a new code.

## 4. Stop the system

```
pnpm mac:down -- --protected-root <protected-root>
```

Prints one line, `mac:down task host stopped` (or `not_running` if it was already off). Queued
work drains before the host exits, so a stop is not abrupt. Exit code 1 means the host is
`still_running` — see section 7.

## 5. What "ready" and "proven" mean

Per worker (Codex, Claude, Hermes) the site shows one of two states and one of two proofs.

| Label | Means | Changes when |
|-------|-------|--------------|
| **ready** | The pinned worker executable was found and its version verified at startup. | Set at every `mac:up`. Cleared to `unavailable` if a later readiness check fails. |
| **unavailable** | That worker's executable could not be verified. It will not be given work. | Cleared only by a fresh `mac:up` re-verifying it. Never "recovers" on its own. |
| **proven** | The worker has actually published a result at least once. | Set on first published result, and only if the worker was not `unavailable`. |
| **not_proven** | No result has been published yet. | Normal on a fresh install. |

**ready is not proven.** A worker can be ready and still not_proven — it is installed and checked
but has not yet done any work. "Proven" only ever appears after you accept a result.

## 6. Check whether it is healthy

| Check | Command | Good result |
|-------|---------|-------------|
| Is the task host up? | `pnpm mac:up -- --protected-root <protected-root>` | `already running (pid ...)` |
| Is the database reachable? | `pnpm mac:check-database <protected-root>` | four lines, one per role: `web ok`, `coordinator ok`, `results ok`, `queueWorker ok` |
| Is the site loading? | open `http://127.0.0.1:3210` | sign-in page |
| Anything left running? | `ps -axo pid,pgid,command \| grep -E "codex\|claude\|hermes"` | nothing left over after a stop |

`mac:check-database` is read-only. It never writes, never retries, and prints no configuration.
Any line ending `database_check_refused` means that role is not reachable.

## 7. When something is not working

| Symptom | What it means | Do this |
|---------|---------------|---------|
| Site says the database is unavailable | The direct private route to the database is not working. This is expected while the Mac is off the private network, or if the Tailscale client tag is not yet effective. | 1. Open Tailscale and confirm the Mac is connected. 2. Confirm the approved client tag is showing (see `docs/OWNER_ACTIONS.md` item 1). 3. Re-run `pnpm mac:check-database -- <protected-root>`. 4. If roles are still refused, stop and report it — do not start a tunnel, and do not change the tag or the policy. |
| `mac:up FAILED database check failed` | The database was not reachable, so the stack deliberately did not start. | Fix the route as above, then start again. |
| `mac:up FAILED repin exit 2: protected configuration is unsafe` | The protected configuration is missing, unreadable, or unsafe. | Do not start. Report it to the agent. |
| A worker shows `unavailable` | That worker's executable could not be verified. | The other workers keep working. `pnpm mac:down` then `pnpm mac:up` re-checks it. |
| `mac:down` reports `still_running` | The host did not exit within the grace period and was force-killed. | Check `ps -axo pid,pgid,command \| grep -E "codex\|claude\|hermes"`. If something remains, report it. |
| `release build missing: run pnpm build first` | The compiled output the host needs is absent. | `pnpm build`, then start again. |

Two things never to do: do not start a tunnel or VPN by hand, and do not paste a password, access
key, certificate, or database address into chat, a ticket, or this repository.

## 8. Owner-only actions

Anything a bot cannot do is listed in `docs/OWNER_ACTIONS.md`. Read that file rather than
repeating it here. Never paste a password, access key, database address, MagicDNS name,
certificate, or terminal output into that file.

The Tailscale client tag and the access-policy grant are both **done**. Do not re-open either
one; if a future update needs another machine on the route, give that machine the same approved
client tag and change nothing else.

What is still open is the set of drills in `OWNER_ACTIONS.md` item 3: the phone-or-PC port test,
a Mac sleep and wake, the VPS-side PostgreSQL and Tailscale restarts, and a forced certificate
renewal. Those are not setup steps; they are the checks that prove the route survives real
interruptions.

## 9. Known limitations (read before you rely on this)

Nothing in this section is a bug report; it is the honest state of the
single-Mac Control Room on 2026-09-25. Each item says what you can and
cannot do today.

### 9.1 You cannot start the system yet

`pnpm mac:up` does not complete. The task host needs a build artifact that
no build step currently produces, so it stops with a "missing: run pnpm
build" message even after a successful build. This is missing source, not a
misconfiguration, and it is being worked on. Sections 2 and 4 describe the
intended behaviour once that lands.

### 9.2 The database is proven; the website on top of it is not

| Part | State |
| --- | --- |
| Direct route to the database | **Working.** All four roles verified. |
| Wrong server name refused, no password echoed | **Working.** |
| Sign-in, projects, creating a project or a task | Covered by automated tests against a disposable database. **Not** yet run by you on the real one. |
| Assigning, approving, accepting, requesting changes, planning | **Routed but unusable.** The page exists and answers "service unavailable", because the operation behind it is not installed. |
| Cancelling a running task | **Not available at all.** There is no cancel action anywhere in the local product. A task that is running cannot be stopped from the website. |
| Automatic service at login | **Not built.** Starting is a manual command for now. |

The two rows that matter most to an owner expecting a normal product: you
cannot cancel a task, and several review steps are not usable. Do not plan
around a workflow that needs either.

### 9.3 The three workers are not equally proven

Only Codex, Claude and Hermes are supported, and each is verified at startup
by finding its pinned executable. A worker that cannot be verified shows
`unavailable` and is given no work; the others carry on. A worker can also be
`ready` and still `not_proven`, which simply means it has not published a
result yet. Neither state is a fault report.

### 9.4 One Mac, one owner, loopback only

The site is served on the loopback address on this Mac only. It is not
published to the network, and it is not reachable from your phone. The
database is reached over a private connection to the one remote machine
holding it, and the database port is not open to your other devices.

### 9.5 What still has to be proved by a person

Three checks need you rather than an agent, and they are listed in
`docs/OWNER_ACTIONS.md` item 3: a port test from your phone or PC (which
must fail), a sleep and wake on this Mac, and remote restarts of the
database and the private connection. Until those are done, the route has not
been shown to survive a real interruption.
