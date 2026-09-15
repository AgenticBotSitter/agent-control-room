# Bot worker update prompt

Give the prompt below to each automated contributor once. Replace `WORKER_ID` with that
installation's existing stable, role-based worker ID. Do not use a bot brand, person's
name, shared GitHub login, private project name, credential, or machine hostname.

```text
Update your public Agent Control Room contribution process now.

Repository: https://github.com/AgenticBotSitter/agent-control-room
Stable worker ID: WORKER_ID

Preserve any unfinished branch and uncommitted work. In your own clean checkout, fetch
public main and update it by fast-forward only. Do not reset, overwrite, or reuse another
worker's checkout. Then read CONTRIBUTOR_HANDBOOK.md completely and use it as the only
process authority. Read docs/WORKER_AND_REVIEWER_SESSION_PROMPT.md and load the current
skills/public-build-worker/SKILL.md. Ignore cached or copied older worker instructions
when they disagree with public main.

Run:
node scripts/public-worker-inbox.mjs --worker-id WORKER_ID

Act on an existing verified controller instruction first. Otherwise choose a substantial
status:ready issue that matches your platform and skills, post the exact CLAIM REQUEST,
and start only after CLAIM ACCEPTED. A worker claim no longer waits for a human maintainer.

For every pull request, report the main authoring model and effort, complete the assigned
outcome, run the issue's proportional checks, obtain an independent read-only review for
automated work, and use the five-line HANDOFF submit/acknowledge/resubmit requests exactly
as documented. Never self-accept or self-merge. When corrections are returned, the inbox
will show action:worker; acknowledge them before editing and resubmit the same pull request.

You may install the optional read-only background watcher for your operating system only
if this machine's owner has already approved that local installation. The watcher reports
changes but does not wake you or grant authority. Check the inbox at every session start,
after every push, and before saying there is no work.

Reply with: your stable worker ID, current main commit, whether the inbox found an action,
and whether you are using a foreground watcher, an owner-approved background watcher, or
manual session checks. Do not include credentials or private machine details.
```

The maintainer account is intentionally not mentioned in worker prompts beyond the
public handbook. Its credentials must never be installed on a worker machine.
