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
>
> **Package 5 update (not ready to run):** `mac:up` no longer creates the first
> owner. A separate one-time VPS setup must establish the owner, three worker
> identities and review integrity before startup. That setup is still blocked
> on the precise key/checkpoint decision in
> `docs/claude/PACKAGE5_SECTION12_CONTRACT_GAPS.md`. Do not run a fresh install
> from this branch or treat the command sequence below as an accepted install.

Run every `pnpm` command from the repository root, on the Mac that holds the workers.
For a later VPS database upgrade, use the separately maintained private VPS
operator runbook; do not reuse the one-time setup command below.

## 1. First time only (one-time setup)

| # | Step | Who | Command / note |
|---|------|-----|----------------|
| 1 | Confirm the Mac's approved Tailscale client tag is showing | **Owner-only** | See the private installation checklist item 1. Bots cannot do this. |
| 2 | Create the database and protected configuration | Agent, at your request | `pnpm mac:provision-database -- --protected-root <protected-root> --ssh-target <user@host> --database-host <host> --remote-worktree <absolute-path>` — **unproven** |
| 3 | Point the Mac at the current database route | Agent | `pnpm mac:provision-database -- --repoint-only --protected-root <protected-root>` — **unproven** |
| 4 | Build once | Agent | `pnpm build` |
| 5 | Prepare the protected task keys and Hermes choice once | Agent, using the owner's recorded choice and verified provider origin | `pnpm mac:prepare-task-runtime -- --protected-root <protected-root> --hermes-profile cr --hermes-provider opencode-go --hermes-model space-bunny-free --hermes-destination https://opencode.ai:443` |
| 6 | Start (see section 2) | Owner or agent | `pnpm mac:up` |

Step 2 is a one-shot installer. It sends secrets over SSH on standard input, never as command
arguments, and never prints them. Re-running it converges: existing protected password files are
reused. Step 3 changes no password and no remote state — it only re-reads the local route.

## 2. Start the system

```
pnpm mac:up -- --protected-root <protected-root>
```

Starts in a fixed order: check database, verify the previously installed owner,
repin workers, write task provider,
start task host. The database is reached directly over the private route; **no tunnel process is
started**. Running it twice is safe — a second run reports `already running (pid ...)`.

Success ends with:

```
mac:up running: http://127.0.0.1:3210
```

Then open that address in the browser and sign in.

If `pnpm mac:up` reports `already running`, you do not need to do anything.

### Optional one-time owner action: start automatically at login

This source tree prepares a per-user launch agent but does not install it for you. When you decide “yes, start at login,” run this once while signed in as the Mac owner:

```sh
pnpm mac:up -- --protected-root <protected-root> --install-service
```

If macOS shows a background-item notification, open **System Settings → General → Login Items & Extensions** and confirm the Control Room item is allowed. Do not run the command with `sudo`; this is an owner-login service, not a system service.

Check it without changing anything:

```sh
pnpm mac:status -- --protected-root <protected-root>
```

A healthy result says `mac:status running`, includes a PID, and identifies whether the optional service is installed. `mac:status` checks the exact supervisor and task-host command lines and confirms that the loopback port responds. A dead host is reported plainly with its last recorded reason. The protected `runtime/task-host.log` captures both output streams and stop reasons; it is limited to the current 5 MiB file plus three rotated generations. The lower-level `mac:service-status` command remains available when only the launch-agent definition is being inspected.

Repeating the install command is safe: an already healthy matching service is restarted in place, while a stopped or changed definition is re-enabled/refreshed through the same fixed label. The launch agent restarts an unsuccessful host after a 15-second throttle; a deliberate `mac:down` remains stopped.

`pnpm mac:down -- --protected-root <protected-root>` stops and disables the service, so it will not return at the next login. A later ordinary `mac:up` re-enables an installed service. To remove only the login service while keeping all protected data and configuration:

```sh
pnpm mac:uninstall-service
```

The uninstall command is repeat-safe. After it reports `removed`, `mac:service-status` reports `not_installed`; an ordinary `mac:up` then uses the direct detached start again unless you explicitly pass `--install-service`.

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
the private installation checklist; do not run the provisioner again just to get a new code.

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
| Is the database reachable? | `pnpm mac:check-database <protected-root>` | four lines, one per role, ending in `connectivity ok (privilege isolation not checked)` |
| Is the site loading? | open `http://127.0.0.1:3210` | sign-in page |
| Anything left running? | `ps -axo pid,pgid,command \| grep -E "codex\|claude\|hermes"` | nothing left over after a stop |

`mac:check-database` performs the four restricted-login preflights and
zero-row denied-write probes. It must pass before `mac:up` continues, but the
new one-time owner setup is still unproven. It prints no configuration.

`mac:up` starts the task host even when there are no active projects. Create a project on the website and open its task-planning page; the running host derives its fixed local templates and registers its owner-review profile without a restart. The host supports up to 50 active projects and refuses the fifty-first with `mac_local_project_limit_50` rather than silently omitting templates. If the selected Hermes profile later sets `OPENCODE_GO_BASE_URL`, Hermes tasks fail closed because the saved network allowlist still names `https://opencode.ai:443`. The preparation command creates the protected task-runtime file once; rerunning it does not update an existing file. Stop Hermes task use and ask for a reviewed recovery procedure. Do not edit the protected file by hand or assume rerunning preparation changes its destination.
Any line ending `database_check_refused` means that role is not reachable.

### Owner-review profile v2 upgrade

Database migration 0092 is additive: it does not rewrite existing review profiles or targets.
On the first `mac:up` after the upgrade, every active project registers the v2 owner-review
profile. Existing in-flight review targets keep their recorded v1 profile and digest; newly
published results bind to v2. The owner can review both versions. Under v2, any future agent
review must have different recorded worker, agent-profile and harness provenance, and the default
policy also requires a different coarse model family. For a plain-text result, open the result,
check “I read it and it’s correct,” then choose Accept; that one explicit owner command records the
acceptance and its configured human observation together. The separate automatic text check still
has to pass before the task becomes Completed · Accepted. Restarting does not accept, reject,
migrate, or otherwise decide an existing result.

## 7. When something is not working

| Symptom | What it means | Do this |
|---------|---------------|---------|
| Site says the database is unavailable | The direct private route to the database is not working. This is expected while the Mac is off the private network, or if the Tailscale client tag is not yet effective. | 1. Open Tailscale and confirm the Mac is connected. 2. Confirm the approved client tag is showing (see the private installation checklist item 1). 3. Re-run `pnpm mac:check-database -- <protected-root>`. 4. If roles are still refused, stop and report it — do not start a tunnel, and do not change the tag or the policy. |
| `mac:up FAILED database check failed` | The database was not reachable, so the stack deliberately did not start. | Fix the route as above, then start again. |
| `mac:up FAILED repin exit 2: protected configuration is unsafe` | The protected configuration is missing, unreadable, or unsafe. | Do not start. Report it to the agent. |
| `mac:status dead` or `dead/restarting` | The exact host process is not serving. The message includes the last recorded exit code, signal, or supervisor failure when available. | If the login service is installed, wait 15 seconds and run `mac:status` once more. Otherwise run `mac:up`. If it remains dead, report the final `host stopped because ...` line from `runtime/task-host.log`. |
| `mac:up host state file runtime/task-host-state.json is unreadable` | The file that records the last stop reason is not a private file this stack can read — usually a restored backup or a manual edit. It holds no state the stack needs. | The start continues anyway. To clear the message, `rm <protected-root>/runtime/task-host-state.json` and run `mac:up` again. |
| A worker shows `unavailable` | That worker's executable could not be verified. | The other workers keep working. `pnpm mac:down` then `pnpm mac:up` re-checks it. |
| `mac:down` reports `still_running` | The host did not exit within the grace period and was force-killed. | Check `ps -axo pid,pgid,command \| grep -E "codex\|claude\|hermes"`. If something remains, report it. |
| `release build missing: run pnpm build first` | The compiled output the host needs is absent. | `pnpm build`, then start again. |

Two things never to do: do not start a tunnel or VPN by hand, and do not paste a password, access
key, certificate, or database address into chat, a ticket, or this repository.

## 8. Owner-only actions

Anything a bot cannot do is listed in the private installation checklist. Read that file rather than
repeating it here. Never paste a password, access key, database address, MagicDNS name,
certificate, or terminal output into that file.

The Tailscale client tag and the access-policy grant are both **done**. Do not re-open either
one; if a future update needs another machine on the route, give that machine the same approved
client tag and change nothing else.

### Protected model choices

Model choices are optional installation policy, not browser configuration. An installation created
before model selection has no `modelPolicy` fields and needs no migration: each such worker keeps
using its existing CLI or protected profile default, and the task form offers no model choice for
that worker.

To enable model selection later, stop Control Room and edit the protected enablement record at the
exact file `<protected-root>/config/mac-local.json`. Add `modelPolicy` inside only the worker object
you want to enable; do not add it at the top level. Keep only models the owner has approved and the
installed CLI reports. For example, the complete relevant Codex worker shape is:

```json
{
  "workerId": "worker:codex:mac-1",
  "kind": "codex",
  "executablePath": "/absolute/path/to/codex",
  "recordedVersion": "<the already-pinned version line>",
  "modelPolicy": {
    "models": ["<installed-codex-model>"],
    "defaultModel": "<installed-codex-model>",
    "efforts": ["low", "medium", "high"],
    "defaultEffort": "medium"
  }
}
```

Claude uses the same shape. Its default should be `sonnet`; put owner-approved, more limited
choices such as `opus` in `limitedModels` so the task form displays “uses more of your Claude
limit”. Hermes uses named, worker-side credential profiles:

```json
{
  "kind": "hermes",
  "modelPolicy": {
    "profiles": [
      { "name": "build", "provider": "<provider>", "model": "<provider-model>" },
      { "name": "check", "provider": "<provider>", "model": "<provider-model>" }
    ],
    "defaultProfile": "build",
    "efforts": ["default"],
    "defaultEffort": "default"
  }
}
```

Each Hermes profile's credentials stay in Hermes's own protected worker configuration. Do not put
credentials in `mac-local.json`. At every startup Control Room checks an explicitly configured
policy against the pinned installed CLI. A malformed, changed, or unsupported policy is refused
fail-closed and the task host does not start with that worker. A policy is never accepted from a
browser request. Start Control Room normally after saving the protected file. Removing a model
prevents new tasks from selecting it; existing run evidence remains readable. Removing the whole
`modelPolicy` object disables model selection for that worker and returns it to its prior default
behavior.

What is still open is the set of drills in the private installation checklist item 3: the phone-or-PC port test,
a Mac sleep and wake, the VPS-side PostgreSQL and Tailscale restarts, and a forced certificate
renewal. Those are not setup steps; they are the checks that prove the route survives real
interruptions.

### Optional private HTTPS address for a phone or PC

This is off by default. The app still binds only to `127.0.0.1`. Two optional doors lead to it:
Tailscale Serve for your phone and Cloudflare Tunnel + Access for your other computers. Both are
configured in the protected `remoteAccess` block and explained step by step in
[REMOTE_ACCESS_GUIDE.md](REMOTE_ACCESS_GUIDE.md). Use Serve, never Funnel. An older
`localOwnerSession.trustedOrigin` line still works as the Tailscale address.

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
| Automatic service at login | **Prepared, not installed.** The owner may opt in once with the exact `--install-service` command in section 2. No agent installs it automatically. |

The two rows that matter most to an owner expecting a normal product: you
cannot cancel a task, and several review steps are not usable. Do not plan
around a workflow that needs either.

### 9.3 The three workers are not equally proven

Only Codex, Claude and Hermes are supported, and each is verified at startup
by finding its pinned executable. A worker that cannot be verified shows
`unavailable` and is given no work; the others carry on. A worker can also be
`ready` and still `not_proven`, which simply means it has not published a
result yet. Neither state is a fault report.

### 9.4 One Mac, one owner, loopback listener

The site always listens on the loopback address on this Mac only. It is not
reachable from another device unless the owner configures the optional exact private HTTPS origin
above and enables Tailscale Serve. The
database is reached over a private connection to the one remote machine
holding it, and the database port is not open to your other devices.

### 9.5 What still has to be proved by a person

Three checks need you rather than an agent, and they are listed in
the private installation checklist item 3: a port test from your phone or PC (which
must fail), a sleep and wake on this Mac, and remote restarts of the
database and the private connection. Until those are done, the route has not
been shown to survive a real interruption.
