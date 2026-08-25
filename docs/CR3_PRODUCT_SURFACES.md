# CR-3 dashboard, review, and operator surfaces

**Status:** Accepted 2026-08-22
**Principle:** One control room, many projects and workers; progressive disclosure from portfolio to evidence.

## Navigation model

Primary navigation:

- Home
- Projects
- Requests
- Work
- Workers
- Attention
- Reviews
- Services & schedules
- Incidents
- Artifacts
- Audit
- Settings

A persistent project selector changes the scope without creating separate control rooms. “All projects” is a real portfolio view. Worker pages remain global because one worker may serve several projects.

## Home

The default page answers:

- What is running now?
- What needs me?
- What is blocked or unhealthy?
- Which projects are progressing?
- Which workers are online, idle, saturated, or unavailable?
- What is the current bottleneck?
- What changed since I last looked?

The page uses compact summaries and links to evidence. It does not display raw agent transcripts.

An **Owner Focus** strip lets the owner pin a deliberately small set of `P0` or `Today` outcomes. These pins influence declared priority but never bypass project allocation, fairness, eligibility, authority, or approval policy.

## Projects

Portfolio view shows health, authority mode, progress, attention, current bottleneck, recent throughput, forecast, and allocated capacity.

Project detail tabs:

- Overview
- Workflow/board
- Requests
- Work and attempts
- Reviews
- Workers and allocation
- Capabilities and bottlenecks
- Artifacts
- Services/schedules
- Incidents
- Decisions/audit
- Project settings

Domain-specific project panels are declarative and safely rendered. They cannot inject arbitrary browser code in the core UI.

## Requests and conversational intake

The owner can enter a short or long request from dashboard, Telegram, or MCP. The manager proposes:

- project or new-project placement;
- workflow steps and dependencies;
- suggested workers/routes;
- required credentials without revealing values;
- estimated time/cost;
- review/approval points;
- unresolved questions.

The owner can edit, approve activation, save as a template, or keep it advisory. A conversational explanation never replaces the structured workflow shown beside it.

## Work views

The board is one projection, not the whole product. Alternate views include:

- Kanban by normalized state;
- dependency graph;
- chronological attempts;
- queue by worker/capability;
- critical path;
- calendar/schedule;
- blocked/review-only filters.

Every card exposes project, job type, authority mode, assigned/eligible worker, lease state, progress, cost/time estimate, evidence, and safe reason for blocking.

## Worker pages

Worker names are editable; immutable IDs remain visible in details.

Tabs:

- Status: online state, current work, slots, uptime, last heartbeat.
- Resources: CPU/GPU/RAM/storage/network/power observations and trends.
- Capabilities: declared, provisional, verified, expired, unavailable routes.
- Software: OS, bridge, harness, executor, and relevant version fingerprints.
- Skills/packages: availability, source/trust, version, compatibility.
- Projects: allocations, recent shares, preferences, availability windows.
- Performance: benchmark and observed duration/quality/reliability history.
- Queue/history: attempts, outcomes, cancellations, retries.
- Security: enrollment/key state, local policy version, allowed risk classes, incidents; never secret values.
- Recommendations: evidence-backed changes with assumptions and projected impact.
- Native consoles: protected Hermes or platform-specific links where available.

Resource histories distinguish physical capacity from current free capacity. Storage alerts show whether cleanup/offload is safe and which queued jobs are affected.

## Bottleneck views

Portfolio and project bottleneck panels show:

- capability demand versus verified eligible slots;
- queue depth and oldest age;
- utilization and observed service rate;
- critical downstream work blocked;
- failure/retry contribution;
- alternative slower/paid/privacy routes;
- projected effect of policy, software, storage, RAM, GPU, or node changes.

Suggestions state confidence and assumptions. The owner can simulate a change before accepting it.

## Attention inbox

One queue combines questions, approvals, reviews, decisions, security events, and recovery ambiguities. It supports urgency, project, risk, due time, quiet-hour exception, and delivery status.

It also provides the cross-harness **Session Watch** projection: running, waiting for input, blocked, failed, ready for review, and expiring sessions appear together even though their native Hermes, Codex, Claude, Zide, or future interfaces differ.

Attention items show:

- exactly what is being requested;
- why it is needed;
- what remains blocked;
- who/what already reviewed it;
- evidence/previews;
- allowed responses;
- expiry and consequences;
- whether Telegram is sufficient or strong dashboard approval is required.

Items support acknowledge, answer, approve where authorized, deny, request changes, delegate, snooze, cancel, and open-native-session actions according to policy. Snooze changes presentation only; it never extends a lease, approval, authority, deadline, or effect reservation.

## Review surface

Review supports:

- still-image comparison;
- streamed video/audio preview;
- code diff and test report;
- document/report preview;
- structured deterministic QC;
- AI reviewer comments with model/agent attribution;
- owner approve, reject, request changes, annotate, or choose variant.

Approval and aesthetic preference remain different records. “I like version B” does not automatically authorize publishing it.

Rejected work returns to the workflow with structured notes and revision lineage. The original artifact remains auditable and may be retained/quarantined according to policy.

### Completion Gate

Every reviewable result enters a project-neutral Completion Gate:

1. deterministic checks run against an immutable target;
2. required independent reviewers examine the result and evidence;
3. blocking findings create a bounded revision request;
4. the corrected result explicitly resolves or disputes each finding;
5. verification scenarios produce pass/fail/blocked/inconclusive results;
6. the owner or configured low-risk policy accepts, rejects, or requests changes;
7. any consequential effect is authorized separately.

The review screen groups an **evidence bundle** by claim. A video or screenshot states which scenario it demonstrates; a test result names its target digest and environment; an AI observation shows model, agent, worker, and run provenance. Unattached media remains a preview rather than proof.

Review policy can require a different worker, agent profile, harness, or model family from the producer. When several agents jointly authored the target, cross-review among those authors does not satisfy an independent-final-review requirement.

Automatic correction cycles have a configured maximum. Exhaustion, conflicting reviewers, inconclusive verification, or unresolved blocking findings create attention instead of an indefinite self-repair loop.

## Procedures and knowledge

The control surface maintains two distinct reusable libraries:

- **Procedures:** repeatable methods, expected outputs, checks, and correction guidance.
- **Knowledge:** project facts, conventions, architecture references, and approved context.

Every entry shows version, digest, source/provenance, trust state, compatible harnesses/capabilities, usage history, outcome metrics, and promotion history. Policy and authority are displayed separately. A session analysis may propose an updated procedure or knowledge entry, but it cannot activate that version without the configured review gate.

## Services and schedules

This surface covers continuous work that does not fit a completion board:

- website uptime checks;
- certificate/backup/traffic reports;
- scheduled publishing or generation;
- recurring project maintenance;
- node health and dead-man checks.

It shows desired state, last observation, next run, owner, current executor, failure streak, escalation, and recent incidents. Reusable blueprints can instantiate standard checks for a new website/project.

## Incidents

Incident detail separates evidence, diagnosis, actions, and approvals:

- detection source and timestamps;
- affected service/project/node;
- deterministic observations/retries;
- agent diagnosis clearly labeled;
- allowed automatic recovery;
- operator actions and status;
- post-incident decision and follow-up.

Security quarantine controls are prominent and require confirmation proportional to impact.

## Settings

### Preferences

- notification channels and destinations;
- quiet hours and timezone;
- digest frequency;
- default project/view;
- display names;
- preferred routes and availability schedules.

### Policies

- approval thresholds and risk classes;
- cost/time/provider limits;
- project/worker allocations;
- credential-reference grants;
- retention and backup targets;
- adapter/package trust;
- automatic retry/recovery ceilings;
- Telegram action permissions.

### Invariants

Security invariants such as no plaintext secrets, no child authority expansion, mandatory audit, replay rejection, and cross-tenant isolation are visible but not casual toggles.

## Telegram interaction

Telegram messages are short and actionable:

```text
Wayfarer • Review requested
Wooded river transition v3 • 00:42 preview
AI QC: passed motion/continuity; flagged bright reflection at 00:31

[Open preview] [Approve review] [Request changes]
```

For high-risk actions:

```text
ABS • Production publish requested
Strong approval required. This button opens the protected Control Room operation digest.

[Review in Control Room]
```

Callbacks are idempotent, recipient-bound, expiring, and auditable. Free-text replies attach to the attention item but do not become an approval unless the contract explicitly permits that response.

## Mobile behavior

- Primary attention and review actions work at phone widths.
- Heavy status tables collapse into cards with drill-down.
- Video/audio previews use adaptive delivery and never force raw multi-gigabyte downloads.
- Security-sensitive controls require deliberate confirmation and are not placed beside routine buttons.
- Native dashboards that are poor on mobile are summarized; deep links remain optional.

## Accessibility and clarity

- State is conveyed by text/icon as well as color.
- Keyboard navigation and visible focus are required.
- Approval language names the actual effect.
- Timestamps show timezone and relative age.
- “Queued,” “leased,” “running,” “waiting,” and “complete” remain distinct.
- Offline/ineligible workers remain visible with cause and remedy.
- AI-generated explanations are labeled and linked to deterministic evidence.
