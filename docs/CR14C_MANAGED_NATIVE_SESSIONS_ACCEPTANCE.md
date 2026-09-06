# Managed native sessions — local acceptance

Implementation `e194154` and transport-health correction `dbcc08a` are independently
statically reviewed with no remaining actionable production findings. Integrated
initial/revised managed-session, fifth-role startup and compiled refusal tests passed.
This is accepted locally as supplied-resource integration, not a deployed system.

## Observed evidence

- Stage zero: ready for runtime check; no dependency installation or native check.
- Types and scoped lint passed initially. Full lint identified the session manager
  initialization style; `cec1ad7` uses an explicit holder for the constructor-time
  health closure, then types and full lint passed.
- Existing protocol/session, evidence receiver/startup and web/coordinator permission
  checks: **68 passed** with migration0057.
- Disposable schema fingerprint after all migrations:
  `5829041bedc0606f08cc72f823b88c183d5224dee10b75077554d182a2025706`.
- Private VPS artifact rebuilt after the transport-health correction and prerequisite
  integration. No deployment bootstrap was configured.
- All **32** existing compiled tests passed after that rebuild.
- New initial managed-session tests passed **14** entries: actual restricted key and
  replay SQL before hello, signed dispatch/receipt, captured progress and bytes,
  replacement, cancellation, permissions, replay refusal and captured capabilities.
  Canonical approval/dispatch setup remains explicitly privileged fixture work.
- Combined initial session/startup run: **26 passed, 1 failed**. The failed assertion
  expected a per-session error after runtime close, but the outer coordinator correctly
  rejected first. The test expectation was corrected without production changes.
- Static review of the new compiled fixture caught an invalid assumption that a fresh
  connection could report work delivered on another session. It was changed to prove
  refusal absent same-session delivery. First execution of that corrected test failed
  while constructing its input: it tried to read a native snapshot before a fake run
  existed. A bounded signed fixture-body correction was required; no native attempt
  was made and that failed run was not accepted.
- The compiled correction now builds and validates a synthetic prepared snapshot
  directly, then signs it on the fresh connection. Both compiled tests passed,
  proving handshake/authentication ownership, undispatched-progress refusal and
  browser isolation; they do not prove compiled full dispatch. The startup file
  passed all **13** entries after its error expectation correction.
- Revised-child coverage and the extended initial helper passed with initial session
  and replay-precommit tests: **18 passed**. The revised child uses its own managed
  connection and restricted writers, retains v2 lineage and exact bytes, and leaves
  source canonical execution, native call counts and original artifacts unchanged.
  Cancellation/replacement at authentication precommit proves both inserted replay
  and connection rows roll back before any send. Independent review accepted these
  tests. Original-source setup and three-slot child capacity remain labelled fixtures.
- Final new coverage totals **33** passing entries across separately executed
  suites (18 backend/fences/revision, 13 startup, 2 compiled), not a live trial.
  Types, full lint and all eight CI inventory checks passed. Four source test files
  and one compiled test file are registered in standard commands.
- All disposable migrations 0001–0057 passed with **138 tables**.

## Retained prerequisite issue

PR #338 at `1dcbd95` failed the existing native-adapter isolation check in GitHub
run `34015087088`, main-2. The pure registration converter was imported from the
adapter directory. The unchanged converter now lives in the neutral harness/v1
layer; the old path re-exports it. The test was not weakened. Independent review
accepted this correction and **11** isolation/observation/receiver tests passed on
this integration checkout. The correction was backported to #338 as `cb32295`;
current-head CI remains required. The corrected prerequisite is integrated here.

## Authority and limitations

No native/provider calls, listeners, credentials, services, physical PostgreSQL,
deployment or GitHub merges. New role SQL is offline operator preparation only.
The current manager accepts supplied transports and a supplied signer. It does not
create network connections, discover machines, sign owner approvals, or restart work.
New connection generations require their own signed handshake and reconciliation.
Recovery of already-sent work and automatic fleet polling remain separate integration.
Current-head GitHub checks and dependency-order integration are still required.

Model guidance was refreshed using OpenAI Docs on 2026-09-06:
[official Astra guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)
recommends preserving effective effort rather than automatically increasing it.
Astra Medium remains the root allocation; independent review and test agents retain
their existing assignments. These are project choices, not benchmark guarantees.
