# Maintainer identity and worker watcher home setup

Use this checklist when you are at a trusted computer. It activates the contributor
handoff source that is already on public `main`; it does not deploy Control Room or
grant access to any private machine.

## Outcome

After the completed setup:

- a worker cannot authorize its own correction, acceptance, or stop instruction;
- the GitHub controller can keep an issue and pull request on the same next action;
- each worker can see accepted work, corrections, stop requests, review waits, and
  record conflicts without relying on relayed chat messages; and
- existing manual assignments remain valid until deliberately moved to the controller.

## Part 1: create the separately controlled maintainer identity

The maintainer identity must be different from every account used to submit worker
pull requests. A declared worker ID is not a security boundary.

1. Manually create one GitHub machine-user account. GitHub does not permit automated
   account creation. Choose a role-based name such as `AgentControlRoomMaintainer`.
2. Use an email address or alias controlled by the owner.
3. Enable authenticator-app multi-factor authentication.
4. Save its password, authenticator entry, and recovery codes in the owner's password
   manager.
5. Never sign this account into a shared worker installation or give its credentials
   to a worker.
6. From an organization-owner account, invite it to `AgenticBotSitter` with the least
   repository permission that permits issue and pull-request comments. Start with the
   **Triage** repository role; do not grant repository administration, deployment,
   secrets, or production access.
7. Keep its authenticated session only on the trusted maintainer computer. A separate
   username is useful only when its credentials are also separately controlled.

GitHub documents machine users as personal accounts used exclusively for automation.
The human owner must create the account and remains responsible for it:
<https://docs.github.com/en/get-started/learning-about-github/types-of-github-accounts>.

## Part 2: configure the repository allowlist

This step requires an organization owner or repository administrator. The value is a
GitHub login, not a password or secret.

In GitHub:

1. Open `AgenticBotSitter/agent-control-room`.
2. Select **Settings** → **Secrets and variables** → **Actions** → **Variables**.
3. Create the repository variable `HANDOFF_MAINTAINERS`.
4. Set its value to the exact separately controlled maintainer login. Multiple logins,
   if added later, are comma-separated.
5. Do not put a token, password, email address, or recovery code in this variable.

Equivalent command for an already authenticated repository administrator:

```sh
gh variable set HANDOFF_MAINTAINERS \
  --repo AgenticBotSitter/agent-control-room \
  --body 'EXACT_MAINTAINER_LOGIN'
```

Do not run that command from a worker account or store its login token in the repository.

## Part 3: perform one disposable activation check

The lead integrator should create one complete, effect-free disposable Ready packet.
Use a worker account to obtain a real controller-recorded `CLAIM ACCEPTED`, then open a
pull request containing exactly one `Control-Room-Issue: NUMBER` line. The pull request
may contain a harmless disposable documentation fixture, but no product or workflow
change. Record its exact current 40-character commit.

Follow the handbook's exact five-line `HANDOFF` request format, including the current
pull-request number and head. Use `previous: 0` for the first `submit`; use the applicable
latest completed controller comment ID after that, including the handbook's documented
stop exception. Exercise submit → changes → acknowledge → resubmit → accept and one
separate stop path. Check the issue and pull-request state/action labels after every
completed controller record. Verify that:

- a worker account can submit and acknowledge only its own accepted work;
- the maintainer account can request changes, accept, and stop that work;
- the maintainer account cannot be the pull-request worker actor;
- an unlisted or shared worker account cannot issue a maintainer decision;
- the issue and pull request always show the same workflow state and next action;
- the worker inbox shows each changed instruction; and
- the disposable issue, branch, and pull request are closed after retaining sanitized
  test evidence.

Do not use a blank unclaimable issue or a real in-flight contribution as the first
activation test. A controller refusal caused by a malformed packet or request does not
test the maintainer allowlist. This check makes public GitHub records but must not access
credentials, providers, private hosts, or production services.

## Part 4: start a foreground watcher on each worker machine

Give each worker installation one stable, non-secret ID. Use role and platform rather
than a personal or product name, for example `windows-runtime-worker-01` or
`linux-integration-worker-01`. Keep the same ID across restarts.

From that worker's own Agent Control Room checkout:

```sh
git switch main
git pull --ff-only
node scripts/worker-inbox-watch.mjs \
  WORKER_ID AgenticBotSitter/agent-control-room 300
```

`300` checks every five minutes. The command prints the initial inbox and then only
changed results or outages. Leave that terminal open; press Ctrl-C to stop it.

The public repository can be read without a token, but frequent anonymous checks can
reach GitHub's request limit. If necessary, use a separately created read-only GitHub
credential limited to public repository metadata, issues, and pull requests. Never use
the maintainer credential on a worker machine. Never paste a token into a command,
issue, pull request, log, or committed file.

## Current limitation: the watcher does not wake an agent

The foreground watcher is read-only terminal output. It does not install itself,
survive a reboot, start an agent, execute a task, or acknowledge an instruction.
Platform-specific background installation and safe agent wakeup remain tracked public
work. Until those packages are accepted, a worker session should run the inbox command
at startup and after pushing or receiving a review.

## Rollback

If controller behavior is uncertain:

1. stop sending `HANDOFF` commands;
2. preserve the issue, pull request, labels, and controller comments;
3. remove or empty `HANDOFF_MAINTAINERS` using repository settings;
4. return affected work to the handbook's documented manual handoff route; and
5. reconcile the exact conflicting record before enabling the controller again.

Removing the allowlist disables new controller transitions. It does not erase existing
records, revoke GitHub accounts, stop local processes, or release claimed paths.

## What the owner must do and what the lead can do

The owner must create the account, enable MFA, protect its credentials, and provide its
exact GitHub login. The lead integrator can then configure the repository variable,
run the disposable activation check, reconcile the public evidence, and verify each
watcher package. No production deployment is part of this setup.
