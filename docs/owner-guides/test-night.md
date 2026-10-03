# Your first test night

Use these two rehearsals before giving Control Room six real tasks. They use a new throwaway local database and leave the installed database alone.

## 1. Practice

Run `pnpm night:practice`.

Control Room proposes a three-step batch, approves and queues it, creates the normal build → check → sign-off pipeline, and uses a fake worker to make one predictable in-memory text change. The last step records that it would prepare a draft pull request. It does not commit, push, open a pull request, or touch the live installation. The throwaway database is closed when the command finishes or fails.

The final message should say **Practice night completed** and list all three stages. If it says paused, drained, stopped, capped, or failed, do not move on until the named condition is understood.

## 2. Shadow night

Before running shadow night, the lead must prepare an installed worker catalog containing Codex, Claude Code and Hermes, with an explicit model policy for each through the approved protected-policy procedure. An installation using local defaults without `modelPolicy` can run normally but cannot pass this rehearsal. Do not guess or hand-edit model choices.

Set `CONTROL_ROOM_PROTECTED_ROOT` to the same protected root used by the installed Control Room, then run `pnpm night:shadow`. You can instead pass `pnpm night:shadow -- --protected-root <protected-root>`.

`night_shadow_worker_catalog_required` means no catalog was supplied; `night_shadow_three_worker_selection_required` means one of the three kinds is missing; `night_worker_model_policy_required` means a selected worker lacks an explicit policy. Stop and have the lead correct that prerequisite, then retry the rehearsal.

This reads the installed worker identities and model policies, verifies their current local versions, and uses the normal protected worker-catalog selection path for builder, checker, and validator. It does not open the installed database. Repository actions are still recording-only: the output lists the commit, push, and draft pull request that would have happened. None of them is performed. The run allows at most three tasks, one at a time, zero recorded external-effect cost, and two attempts per stage.

Pause prevents the next stage from starting. Drain lets the current stage finish and starts nothing else. Stop halts at the next safe boundary. Already recorded evidence stays visible. The command accepts the supervisor's same four-state operations port; its foreground helper also maps `SIGUSR1` to Pause, `SIGUSR2` to Drain, and Ctrl+C or `SIGTERM` to Stop.

## 3. Then try six real tasks

Only continue when both commands complete, all recorded actions look reasonable, and no unexpected files or remote activity appear. Keep merging and final acceptance human-only. Start with six small, independent tasks and use Pause or Stop if the first result is surprising.

PostgreSQL verification is a separate DB-capable check. Run:

`PG_BIN=/opt/homebrew/opt/postgresql@17/bin pnpm test:night-kit:postgres`
