# Combined local worker qualification

An owner can run the existing Hermes and Claude checks from one attached
Terminal command:

```sh
pnpm run qualify:local:workers -- --owner-attended --reuse-owner-login \
  --hermes-executable /absolute/path/to/hermes \
  --hermes-profile PRIVATE_PROFILE --hermes-model PRIVATE_MODEL \
  --hermes-provider PRIVATE_PROVIDER --hermes-workdir /absolute/hermes/workdir \
  --claude-executable /absolute/path/to/claude \
  --claude-workdir /absolute/claude/workdir
```

The owner must review every private selection before running the command. The
launcher invokes the existing qualification scripts directly, without a shell.
It runs Hermes once, then runs Claude once only if Hermes passed. A failed or
unavailable first check stops the sequence; no check is retried. Any later
attempt requires a new owner decision.

The one JSON report contains only the two existing schema-checked sanitized
reports and fixed orchestration status. It does not print the executable or
work paths, Hermes profile, model, provider, prompts, answers, login state, raw
process output, or child error output.

This remains qualification only. It does not configure or enable a worker,
start a service, create or assign a task, save the report, grant execution or
retry authority, or replace either route's separate installation and owner
enablement gates.
