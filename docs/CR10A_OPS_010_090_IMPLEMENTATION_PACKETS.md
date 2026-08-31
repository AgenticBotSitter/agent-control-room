# CR10A operations implementation packets

**Purpose:** Large, real implementation wave following CR10A-OPS-000.
**Default model:** `gpt-5.6-terra`
**Reasoning:** `high`
**Rule:** These packets build effect-free reference implementations and tests. They do not authorize installation, native services, production values, network calls, credentials, deployment, backup, restore, or any external effect.

Each packet is independently claimable only after its dependencies are present in the worker checkout. A worker must declare its supported platform before claiming a platform-labelled packet and must return a blocked result rather than changing architecture or attempting a live repair.

## CR10A-OPS-010 — Compose reference stack

**Status:** Complete locally; accepted in `CR10A_OPS_010_040_ACCEPTANCE.md`
**Labels:** `all-platforms`, `containers`, `effect-free`, `no-provider`
**Depends on:** OPS-000
**Goal:** Create a value-free Compose reference that expresses the seven exact services, distinct principals, internal-only networks, immutable artifact references, health hooks, one-shot migration profile, read-only filesystems where possible, capability removal, bounded resources, and explicit volumes without embedding real hosts, ports, credentials, or image tags.

**Deliverables:** Compose schema/template, exact renderer, static security validator, synthetic fixture, operator explanation, and hostile tests for public ports, root, privileged mode, host network/PID/IPC, Docker socket, wildcard images, shared principals, undeclared flows, writable roots, unbounded resources, hidden commands, and secret-like values.

**Acceptance:** Deterministic rendering; no runtime invocation; exact match to OPS-000 topology; malformed or authority-bearing inputs fail closed; normal verification suite passes.

**Stop and return blocked when:** A production value, image digest, platform install, container runtime, provider access, credential, or real network test would be required.

## CR10A-OPS-020 — systemd reference units

**Status:** Complete locally; accepted in `CR10A_OPS_010_040_ACCEPTANCE.md`
**Labels:** `linux-only`, `systemd`, `effect-free`, `no-provider`
**Depends on:** OPS-000
**Goal:** Create value-free systemd unit templates for the six steady-state roles plus the one-shot migration runner, preserving exact identity separation, dependency order, failure behavior, resource ceilings, filesystem protections, syscall/capability boundaries, restart rules, and terminal ambiguity after change.

**Deliverables:** Unit templates, drop-in schema, deterministic renderer, static validator, fixture, operator guide, and hostile tests for root/shared user, shell interpolation, unrestricted paths, ambient capabilities, writable system directories, unbounded restart loops, credential text, broad network access, and migration persistence.

**Acceptance:** Static validation only; no `systemctl`, service install, daemon reload, process start, host inspection, or privilege escalation; exact mapping to OPS-000 identities and flows.

**Stop and return blocked when:** Native host facts, service accounts, filesystem changes, sudo, service control, or secrets are needed.

## CR10A-OPS-030 — protected-edge and access reference

**Status:** Complete locally; accepted in `CR10A_OPS_010_040_ACCEPTANCE.md`
**Labels:** `all-platforms`, `protected-edge`, `value-free`, `provider-disabled`
**Depends on:** OPS-000
**Goal:** Express provider-neutral edge, owner-access, and node-route schemas plus a value-free Cloudflare-shaped example. Preserve no-public-origin, exact audience and route identities, outbound-only connector behavior, strong owner access, node asymmetric authentication, replay limits, and deny-unknown routing.

**Deliverables:** Strict schemas, redacted templates, deterministic validator, fake provider adapter, route-table projection, disabled disposition, and hostile tests for public origin, wildcard route/audience, bypass path, redirect, credential material, node inbound listener, shared owner/node identity, stale policy, or provider response treated as authority.

**Acceptance:** Provider SDK/client absent from production contract module; fake-only tests; no DNS, tunnel, account, token, network, or provider operation; zero production values.

**Stop and return blocked when:** Account lookup, domain/DNS choice, tunnel creation, login, credential resolution, external validation, or public exposure is required.

## CR10A-OPS-040 — health, readiness, and resource checks

**Status:** Complete locally; accepted in `CR10A_OPS_010_040_ACCEPTANCE.md`
**Labels:** `all-platforms`, `observability`, `fake-only`
**Depends on:** OPS-000; integrate after OPS-010/020 reference identities settle
**Goal:** Implement the eleven health probes as injected adapters with fake observations, bounded timeouts, safe status codes, independent observer identity, freshness/expiry, exact role applicability, and resource-headroom policy. Expose a read-only operator projection without adding service control.

**Deliverables:** Probe adapter interfaces, fake suite, snapshot persistence contract, safe projection, resource policy, replay/freshness tests, and hostile tests for self-report, wrong principal, stale evidence, clock regression, skipped required probe, extra probe, foreign release/topology, status injection, and partial dependency failure.

**Acceptance:** No native probe, socket, HTTP request, process inspection, filesystem inspection, or database connection; a valid snapshot is only `ready_candidate`; failure and uncertainty are visibly distinct.

**Stop and return blocked when:** Live endpoints, native processes, credentials, host statistics, or production thresholds are required.

## CR10A-OPS-050 — backup and WAL dry-run tooling

**Status:** Complete locally; accepted in `CR10A_OPS_050_060_ACCEPTANCE.md`
**Labels:** `all-platforms`, `database`, `storage`, `dry-run-only`
**Depends on:** OPS-000; OPS-040 health evidence vocabulary
**Goal:** Implement exact backup/WAL job plans, protected reference interfaces, manifest verification, retention ceilings, bounded resource estimates, claim/marker/receipt state, and a no-command dry-run CLI. The CLI must never contain or synthesize database, storage, or encryption commands.

**Deliverables:** Job contracts, dry-run CLI, in-memory fake adapter, manifest verifier, lifecycle ledger, safe operator output, and hostile tests for locator/credential leakage, mutable manifest, cross-release/topology backup, missing WAL bounds, retention overrun, retry after marker, forged receipt, and bytes presented as evidence.

**Acceptance:** Zero database/storage client imports in the protected contract path; no subprocess, filesystem backup, network, credential resolution, or encryption-key access; terminal ambiguity preserved.

**Stop and return blocked when:** A real backup command, database connection, bucket, path, key, secret store, storage allocation, or provider SDK is needed.

## CR10A-OPS-060 — disposable PITR and clean-host recovery harness

**Status:** Complete locally; accepted in `CR10A_OPS_050_060_ACCEPTANCE.md`
**Labels:** `all-platforms`, `recovery`, `disposable-only`, `fake-only`
**Depends on:** OPS-040 and OPS-050
**Goal:** Implement an isolated fake restore coordinator for the eleven OPS-000 phases, including exact ordering, one-use claims, pre-effect markers, injected fake restore/WAL/validation adapters, node-journal reconciliation, independent attestation, RPO/RTO calculation, cleanup evidence, and terminal ambiguity.

**Deliverables:** Coordinator, durable fake ledger, restart scenarios, clean-host fixture, result/attestation projection, cleanup contract, and hostile tests for production target, reused target, wrong backup/release, out-of-window point, reordered phases, missing anchor, overwritten node truth, self-validation, failed cleanup, duplicate attempt, and uncertain restore marker.

**Acceptance:** Fake bytes/metadata only; no container/runtime/native tool/database/storage/network access; no cutover API; recovery result grants neither cutover nor production readiness.

**Stop and return blocked when:** Any existing host/database/storage target, real data, real locator, credential, restore tool, or cutover would be touched.

## CR10A-OPS-070 — monitoring and alert contract

**Status:** Complete locally; accepted in `CR10A_OPS_070_ACCEPTANCE.md`
**Labels:** `all-platforms`, `observability`, `provider-disabled`
**Depends on:** OPS-040; consume OPS-050/060 event vocabulary
**Goal:** Define safe metrics, bounded cardinality, redaction, alert rules, incident correlation, audit-anchor continuity, backup/WAL age, queue progress, resource headroom, and notification proposals. Monitoring remains read-only; notification is a separately gated effect.

**Deliverables:** Metric/alert schemas, deterministic evaluator, fake time-series store, operator projection, disabled notification adapter, runbook links, and hostile tests for secret labels, raw IDs, unbounded dimensions, stale alerts, alert loops, notification-as-approval, forged clear, foreign tenant/project, and missing-data-is-healthy errors.

**Acceptance:** All tests use synthetic signals; no telemetry endpoint, provider, notification, or network call; unknown and missing data remain visible and fail closed.

**Stop and return blocked when:** Production telemetry, external alert destinations, tokens, accounts, notification delivery, or live thresholds are needed.

## CR10A-OPS-080 — canary and rollback planner

**Status:** Complete locally; accepted in `CR10A_OPS_080_ACCEPTANCE.md`
**Labels:** `all-platforms`, `deployment`, `planner-only`, `high-risk-boundary`
**Depends on:** OPS-010/020/030/040 and OPS-050/060
**Goal:** Implement a pure canary/rollback planner around the OPS-000 lifecycle. It consumes exact evidence, produces ordered proposed actions and owner questions, and records claims, markers, receipts, and terminal ambiguity without containing a service-control, deployment, migration, or rollback adapter.

**Deliverables:** Planner, durable effect-intent ledger, reconciliation model, owner-facing projection, disabled executor seam, and hostile tests for auto-promotion, auto-rollback, down migration, retry after change, gate substitution, stale owner window, canary bypass, partial receipt, wrong release/topology, and rollback conflated with restore.

**Acceptance:** No executable command, shell, service, container, database, provider, or network client; all plans state `authorized: false`; an operator cannot click through to a real effect.

**Stop and return blocked when:** A command, host, endpoint, credential, deployment target, or actual action would be required.

## CR10A-OPS-090 — executable-but-disabled runbooks

**Status:** Complete locally; accepted in `CR10A_OPS_090_ACCEPTANCE.md`
**Labels:** `all-platforms`, `operations`, `runbooks`, `owner-gated`
**Depends on:** OPS-010 through OPS-080
**Goal:** Compile the accepted contracts into machine-checkable runbook state machines for deploy, migration, canary, rollback, backup, restore, incident isolation, and audit-anchor recovery. A runbook can validate evidence and prepare a proposed next step but its native execution slots remain absent and disabled.

**Deliverables:** Runbook schema/registry, exact step graphs, evidence requirements, stop/abort/ambiguity rules, owner decision prompts, safe rendered guides, fake end-to-end rehearsals, and hostile tests for step skipping, stale evidence, approval reuse, hidden retry, mixed operation identity, secret insertion, unknown native outcome, and cleanup omission.

**Acceptance:** Runbooks are deterministic, resumable, auditable, and non-authorizing; no native executor is shipped; every real effect terminates at an explicit owner-controlled gate.

**Stop and return blocked when:** Execution machinery, production facts, owner approval material, live target selection, or any native/external effect is required.

## Integration order and merge gates

1. OPS-010, OPS-020, and OPS-030 can proceed in parallel from OPS-000.
2. OPS-040 may build concurrently but integrates after the reference identities stabilize.
3. OPS-050 follows the health vocabulary; OPS-060 follows health and backup contracts.
4. OPS-070 consumes the settled health/recovery event vocabulary.
5. OPS-080 integrates the preceding reference evidence but remains planner-only.
6. OPS-090 compiles the accepted set into disabled runbooks.

Every packet must include focused tests, register them in the normal pretest suite, run type checking and lint, list all skipped live evidence, and receive Codex security/integration review. A packet is not allowed to weaken OPS-000 to make its implementation easier.
