# E83 — distinguish website readiness from agent operation

2026-09-06. Launcher change and local tests; no real configuration or service.

The launcher previously accepted the minimal two-role website host and emitted the
same generic readiness message as a fuller deployment. Operator configuration now
must explicitly return `mode: "website-only"` or `mode: "agent-tasks"`.

- Website-only refuses queue production/worker and native HTTP/listener configuration.
  It reports that agent execution is disabled. Existing protected project/task
  preparation and review capabilities can remain available as configured.
- Agent-tasks requires queue submission/recovery/worker, revision planning, approvals,
  quality/results, evidence, sessions and native HTTPS configuration before creating a
  host. It reports configured readiness while explicitly saying live connectivity still
  needs verification. This is the complete first task-to-result/review/revision profile,
  not a declaration that any real agent is already connected.

This early check verifies operator intent and configuration completeness only. Existing
bootstrap validation remains responsible for every actual role, resource and authority.
Empty objects can satisfy presence but must fail actual validation. No flag bypasses
security, no worker is auto-enabled and no missing resources are provisioned.

Tests cover omitted mode, website mode with worker/native settings, every missing
agent-mode component and the compiled website-mode launch/shutdown message. Existing
configuration-failure sanitization and no-host-creation checks remain. Final counts are
in BUILD_STATUS.md. Full default lifecycle is not rerun for this launcher-only change;
E82's full run remains a prior baseline, not evidence of this new guard.
Final verification: six focused tests, 48 combined compiled/launcher checks and targeted
lint pass. No compiled application source changed; no rebuild was needed.

The reviewed operator module, genuine owner signing, independently qualified checkpoint,
database/TLS setup and real task trial are still required. An explicit mode cannot
replace those. No source/downloaded credential values are inserted into configuration.
