# Task provider: required real composition

## Status

`mac:tasks` correctly refuses because no protected task-provider module has
been installed.  Writing only the module selector would change that error but
would not make a task executable.  The release-built provider must compose the
already existing queue, canonical result/review path, and all three owner-
trusted delivery ports before the task host is allowed to advertise itself as
ready.

## Existing pieces to reuse

- `src/web/v1/mac-local-current-three-agent-task-composition.ts` is the one
  shared lifecycle wrapper.  It accepts a prepared Hermes delivery input plus
  prepared Claude and Codex delivery ports.
- `src/web/v1/mac-local-restricted-task-composition.ts` owns the existing
  coordinator and results role connections.
- `src/web/v1/installed-native-queue.ts` provides the existing PostgreSQL
  pg-boss submission and worker factory.
- `src/harness/v1/owner-trusted-local-cli-composition.ts` supplies the common
  receipt, current-authority recheck, process, and result-publication bridge
  for the three local command-line agents.

None of these may be replaced with a second scheduler, a memory queue, a
placeholder result writer, or a fake successful delivery.

## Missing input boundary

The current `MacLocalProtectedConfigurationV1` intentionally contains only
the website session, one database endpoint, and executable pins.  It does not
contain the installation-owned inputs that the listed compositions require:

1. the task templates, routes, and integrity material;
2. the existing canonical approval/queue submission binding;
3. the receipt and current-authority callbacks for each local delivery;
4. the canonical result publisher and review storage binding; and
5. the fixed, protected execution settings for Hermes, Claude, and Codex.

Consequently, a provider that only receives the four current provider
arguments cannot construct a real `createMacLocalCurrentThreeAgentTaskApplicationV1`
without manufacturing authority.  It would either fail during construction or
start a site that could not safely deliver or publish a task.

## Required next package

Add one release-owned `mac-local` task-runtime composition which loads a
single owner-only, data-only runtime configuration from the protected root,
validates it, and constructs the five existing bindings above.  The runtime
configuration must be created by the local installer/rehearsal setup, never by
browser input.  The provider selector remains a 0600 one-line re-export of
the release-built module.

Acceptance is deliberately practical:

1. rehearsal writes the protected runtime configuration and provider selector;
2. `pnpm mac:tasks` starts with all three freshly pinned workers;
3. `GET /api/v1/local-workers` lists Hermes, Claude Code, and Codex; and
4. the W7 real-task journey can use the same installed lifecycle without a
   second composition or delivery route.

Until this package exists, retain the existing `mac_local_task_provider_invalid`
refusal.  It is the honest state and prevents a misleading partial launch.
