# Agent-task operator configuration assembly

Issue #172. Module: `src/web/v1/private-agent-task-operator-configuration.ts`.
Tests: `tests/private-agent-task-composition.test.ts` (operator cases) with fakes in
`tests/helpers/private-agent-task-operator-configuration.ts`.

## What it is

One pure, fail-closed assembly step between the operator's two input groups and the
existing production gate `validatePrivateTaskStartupConfiguration`. It builds the
`PrivateTaskStartupConfiguration` input shape the current task-host startup accepts,
then returns the validated (captured, frozen) composition. The module performs no
environment, filesystem, network, listener, credential-store or database access; it
only shapes already-captured inputs.

## Input groups

1. **Plain operator settings** (`control-room.agent-task-operator-settings/v1`, strict):
   integer `port` (strings, paths and URLs never convert to a port), `tenantId`,
   per-component `databaseRoles`, optional `queueWorkerConcurrency`, and explicit
   boolean `features` flags. Unknown fields refuse.
2. **Already-constructed trusted inputs**: validated web configuration, planning
   template plus checkpoint store and keys, routes, approval enrollments plus the
   approval store, and one entry per enabled optional component (quality, evidence,
   sessions, queue worker role, Codex, Codex result return, native HTTP, artifact
   storage, Idea, news).

## Fail-closed rules (each refuses as `agent_task_operator_config_invalid:<code>`)

- Website-only keys (`planning`, `assignment`, `approvals`, `submission`, …) inside
  the web profile refuse; tenant mismatch refuses.
- Every enabled component requires its trusted input (`missing_trusted_input`), and
  every supplied input requires its flag (`unexpected_trusted_input`), so a disabled
  component is never constructed.
- Feature dependency chains (recovery → queue, sessions → evidence, Codex → queue +
  sessions, result return → full composition, …) refuse before the production gate.
- Database roles must share one host/port/database, use pairwise-distinct usernames,
  and never reuse the web pool login. Exact credential validation stays downstream.
- Anything the production gate rejects surfaces as `production_gate_refused`.
- Refusal happens before return: trusted callbacks are never invoked on a refused
  assembly (asserted in tests). Key bytes are copied; the result is frozen; repeated
  construction from the same inputs is independent.

## Setting-to-service mapping

| Setting | Existing service / gate |
| --- | --- |
| `web` | `validatePrivateStartupConfiguration` (private-startup) |
| `planning` | `captureNativeTaskTemplates` (task-execution-planner) |
| `routes`, approval enrollments | `validateTaskAssignmentRoutes`, `validateNativeApprovalEnrollments` |
| database roles | `validatePrivatePostgresConfiguration` per role (private-postgres) |
| quality / evidence / sessions | task-quality-coordinator, native-evidence-receiver, managed-native-sessions |
| Codex / result return | task-assignment-coordinator permit binding, codex-result-intake |
| artifact storage | `capturePrivateArtifactStorageConfigurationV1`, bound through the one storage port |
| news | `captureNewsStartupConfiguration` with the three dedicated roles |

## Limitations (honest)

- Operator tests use injected fake trusted inputs only: no live PostgreSQL, listener,
  provider or harness execution is exercised here. Live-database composition remains
  covered by the pre-existing fixture tests in the same lane file.
- Secret/reference resolution, file ownership and deployment packaging belong to #64;
  this package only documents the required protected input names and types.
- Real database/harness inputs and assembled-release acceptance remain #63/#8/#66/#61.
