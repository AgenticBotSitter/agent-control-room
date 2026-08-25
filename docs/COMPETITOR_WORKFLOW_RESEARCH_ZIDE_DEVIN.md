# Zide and Devin workflow research

**Status:** Accepted architecture input, 2026-08-24
**Scope:** Product and workflow lessons only; neither product becomes a Control Room dependency

## Executive conclusion

Zide and Devin validate the need for Control Room, but they expose a product-layer gap in the accepted architecture. Control Room already has the stronger neutral control plane: cross-project jobs, heterogeneous nodes, leases, capacity, exact-operation approvals, local policy ceilings, durable effects, services, schedules, incidents, artifacts, audit, and harness adapters. Zide and Devin are more mature at helping a human supervise agent work from proposal through review and correction.

Control Room will retain its project-, harness-, cloud-, and operating-system-neutral core and adopt the following product patterns:

1. a universal action inbox modeled on session-watch behavior;
2. structured verification evidence rather than undifferentiated artifacts;
3. review records that are distinct from security approvals;
4. bounded review-and-revision loops with preserved lineage;
5. independent reviewer selection and visible reviewer provenance;
6. versioned procedures and knowledge, separate from policy and authority;
7. normalized harness-run timelines and safe replay;
8. a workflow preview before fan-out or consequential execution;
9. controlled post-run learning that proposes, but never silently activates, procedure changes;
10. a simple owner focus layer above the full scheduler.

## Product boundaries

| Product | Primary role | What it coordinates well | Boundary relative to Control Room |
|---|---|---|---|
| Zide | Native developer cockpit | Local repositories, issues, worktrees, agent sessions, diffs, pull requests, CI, and operator attention | Optional northbound MCP client or protected worker console; not the control plane |
| Devin | Managed cloud software-agent platform | Cloud sessions, managed child sessions, playbooks, knowledge, schedules, code review, browser verification, and Git/chat integrations | Optional harness/provider adapter supplying cloud coding capacity; not the global authority |
| Control Room | Owner-controlled orchestration plane | Projects, workflows, jobs, attempts, machines, harnesses, deterministic executors, capacity, reviews, approvals, services, incidents, and artifacts | Authoritative coordination layer across Zide, Devin, Hermes, Codex, Claude, local tools, and future providers |

## Lessons adopted from Zide

Zide documents `Session Watch`, `Crosscheck`, worktree forking, planning before changes, queued or redirected prompts, durable project instructions, CLI-agent support, MCP connections, and a phone relay. These features make concurrent local coding work legible without turning the agent into the authority.

Control Room adopts the underlying patterns as follows:

- **Session Watch -> Action Inbox:** one portfolio queue for input, review, approval, failure, ambiguity, incident, and expiring work. Every item states why it needs attention, what it blocks, what evidence exists, and which actions are legal.
- **Crosscheck -> independent review policy:** reviews carry author and reviewer identity, model family, harness, evidence, and conflicts. A producer cannot be the sole reviewer when policy requires independence.
- **Plan mode -> workflow preview:** proposed workflows show the job graph, worker routes, expected cost/time, effects, credentials by reference, and review gates before activation.
- **Fork to worktree -> immutable alternative lineage:** an owner may fork a proposal or safe checkpoint into an isolated attempt. Control Room never pretends to roll back an external effect.
- **Session history -> normalized harness run:** adapter-specific sessions map into one safe run timeline with status, usage, tool/file activity, resumability, cancellation, and opaque native-session links.
- **Relay -> mobile continuation:** Telegram and responsive Control Room pages provide bounded decisions and deep links without making a proprietary relay service mandatory.

Control Room does not copy Zide's editor, Git client, or proprietary agent. Specialized development surfaces remain specialized.

## Lessons adopted from Devin

Devin documents managed parallel sessions, reusable Playbooks, organizational Knowledge, schedules, session analysis, API/MCP lifecycle controls, service-user RBAC, end-to-end testing, and recorded browser evidence.

Control Room adopts the underlying patterns as follows:

- **Managed Devins -> workflow fan-out with preview:** a manager may propose child jobs, limits, workers, and dependencies. Deterministic policy and owner settings decide whether the proposal activates.
- **Playbooks and Knowledge -> separate registries:** procedures explain how to do repeatable work; knowledge supplies facts and context. Neither grants authority. Both are versioned, digested, attributed, compatible with declared harnesses, and promoted through review.
- **Land PR -> Completion Gate:** submitted work passes deterministic checks, independent review, a bounded number of correction cycles, verification scenarios, an evidence bundle, and the policy-required human gate before completion or an external effect.
- **Testing recordings -> evidence bundles:** videos, screenshots, diffs, reports, audio previews, checks, and scenario results state what was tested and what each artifact proves.
- **Session analysis -> controlled improvement:** outcome analysis may propose a revised procedure, knowledge correction, capability score, or routing recommendation. It cannot silently change policy or the active procedure.
- **ACU limits -> universal reservations:** every harness route can expose cost, token, time, concurrency, and provider-specific budget measures through normalized reservations and actuals.

Control Room does not reproduce Devin's cloud VM fleet. Devin can later register as a provider-backed coding capability through its documented API or MCP interface.

## Canonical product gaps found

### Review is not approval

The current domain contains exact-operation approvals and artifact manifests. Those primitives answer whether an operation is authorized and where an artifact exists. They do not answer whether a result meets quality expectations.

The future review domain must represent at least:

- review target and immutable target version;
- review policy and required reviewer classes;
- deterministic verification plan and results;
- attributed findings with severity and evidence anchors;
- owner or policy decision;
- structured change request;
- revision lineage and finding resolution;
- expiry, supersession, and final disposition.

A favorable aesthetic or quality review never authorizes publishing, spending, deployment, secret use, or another effect. A security approval never asserts that the output is good.

### Artifacts are not evidence by themselves

An evidence bundle groups artifacts with claims and verification scenarios. It records pass, fail, blocked, or inconclusive for each scenario; identifies the tool or reviewer that produced the result; and preserves the exact target digest. A video without a test plan is a preview, not proof.

### Technical retry is not revision

Transport retry and execution retry preserve the same accepted job contract. Review-requested revision intentionally changes the proposed result or instructions and therefore creates explicit revision lineage. A policy sets the maximum automatic correction cycles; exhaustion creates attention instead of an unbounded agent loop.

### Harness sessions need a normalized operational record

Attempts remain the scheduling and authority unit. A harness run is the adapter-facing execution record beneath an attempt and stores safe normalized lifecycle data plus an opaque native identifier. Raw transcripts, credentials, and unrestricted command output do not become central state by default.

## Owner experience requirements

### Action Inbox

The Action Inbox is the default human control surface. It combines questions, reviews, approvals, failures, incidents, recovery ambiguity, expiring authority, and sessions waiting for direction. It supports project, urgency, risk, due time, blocked downstream work, age, snooze, delegation, and delivery-channel filters.

### Owner Focus

The owner can pin a small number of portfolio priorities such as `P0` or `Today`. This does not replace scheduler fairness, project allocation, deadlines, or policy. It gives the human a stable, comprehensible view of the few outcomes that must move now.

### Workflow Preview

Before activation, the owner can inspect and edit:

- jobs, dependencies, parallel groups, and completion gates;
- proposed workers and fallback routes;
- estimated duration, cost, and resource reservations;
- credential references and external effects;
- review requirements and human decisions;
- unresolved questions and consequences of partial execution.

### Completion Gate

The generic completion flow is:

```text
result submitted
  -> deterministic checks
  -> independent review where required
  -> bounded revision loop
  -> verification scenarios
  -> evidence bundle
  -> human review or automatic low-risk disposition under policy
  -> completed, rejected, or blocked
  -> separately authorized external effect when applicable
```

Project packs specialize the gate without replacing it. Code may require CI, diff review, and browser replay. Media may require technical QC, representative previews, continuity checks, and aesthetic review. Articles may require source, link, render, and editorial checks.

## Risk and reviewer policy

AI risk scoring is advisory. It may raise priority or recommend scrutiny, but it cannot reduce the deterministic risk floor derived from operation class, credentials, sensitive targets, migrations, publication, spend, policy, or project configuration.

Reviewer policy may require:

- producer may not be sole reviewer;
- different worker or agent profile;
- different model family where practical;
- deterministic checks before semantic review;
- human review for named effects or risk classes;
- a maximum number of agent correction cycles;
- explicit resolution of every blocking finding.

Joint authors may cross-review individual portions, but they do not constitute an independent final reviewer of their combined result.

## Public repositories and reuse posture

### Zide

- Product repository: <https://github.com/zide-software/Zide>
- The repository explicitly describes the application as closed-source proprietary software. It exposes community, security, version, and product metadata rather than implementation source.
- Reuse posture: borrow documented interaction patterns only. Do not copy implementation or depend on undocumented behavior.

### Devin and Cognition

- Organization: <https://github.com/CognitionAI>
- Main Devin product: proprietary; integrate through documented APIs and MCP.
- Devin Outposts Kubernetes operator: <https://github.com/CognitionAI/devin-outpost-k8s>, MIT licensed. It may inform a future Kubernetes worker-pool adapter, but it is not needed for the initial node bridge.
- QA-Devin example: <https://github.com/CognitionAI/qa-devin>. It demonstrates agent-driven end-to-end QA; no license was visible during this review, so treat it as readable reference material, not reusable code, until licensing is verified.
- Devin CLI repository: <https://github.com/CognitionAI/devin-cli>. It is a small distribution/bootstrap surface, not the orchestration engine.
- Terraform provider and Actions repositories may inform a future adapter only after per-repository and per-file license review.

Public visibility is not permission to reuse. Every imported component remains subject to the repository's SBOM, license, provenance, and upgrade-owner requirements.

## Integration disposition

1. **Initial build remains Hermes + Codex**, followed by Claude Code.
2. **Zide is a future northbound-client target.** Publish an MCP connection guide only after the Control Room MCP server is stable.
3. **Devin is a future harness/provider adapter.** Use a least-privilege service user, scoped organization/repository access, bounded compute, and recorded API fixtures.
4. Neither product can bypass Control Room policy, approvals, audit, node ceilings, project authority, or review requirements.
5. Native product links remain protected deep links; Control Room stores normalized state rather than scraping proprietary interfaces.

## Primary sources

- Zide features: <https://zide.dev/features>
- Zide pricing and license model: <https://zide.dev/pricing>
- Zide repository and proprietary notice: <https://github.com/zide-software/Zide>
- Devin advanced capabilities and managed sessions: <https://docs.devin.ai/work-with-devin/advanced-capabilities>
- Devin authentication and service users: <https://docs.devin.ai/api-reference/authentication>
- Devin testing and recordings: <https://docs.devin.ai/work-with-devin/testing-and-recordings>
- Devin playbooks: <https://docs.devin.ai/product-guides/creating-playbooks>
- Ryan Carson workflow summary: <https://www.chatprd.ai/how-i-ai/how-ryan-carson-manages-40-prs-a-day-with-devin-and-codex>

The local Zide brief and episode transcript were research inputs, not build instructions. Their useful conclusions are captured here so they are not prerequisites for a future clone.
