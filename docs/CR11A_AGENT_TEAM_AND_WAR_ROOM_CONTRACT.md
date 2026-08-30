# CR11A Agent Team and bounded War Room contract

**Status:** Architect-frozen for effect-free implementation
**Decision date:** 2026-08-30
**Scope:** Project-scoped agent roster, evidence-backed presence, reviewed profile summaries, routines, bounded collaboration rooms, owner attention, and mention-to-handoff proposals
**Authority:** This contract and ADR-090 control CR11A. Hermes Bot Mode integration, durable message content, live schedules, dispatch, provider access, hosting, DNS, and deployment remain separately gated.

## Outcome

Control Room gains a people-first Agent Team view inside every Project Workspace. The owner can see who is working, what each agent is prepared to do, which routines are scheduled, which rooms need attention, and which handoffs are waiting for review. This view composes existing worker identity, package registry, schedules, canonical work, Action Inbox, approval, evidence, and audit truth. It does not replace any of them.

The product rule is:

```text
Hermes-style visibility for who is working
+ Control Room authority for what they may do and whether work finished
```

The official Hermes Bot Mode documentation and repository informed named profiles, persistent team visibility, routines, group rooms, device-disambiguated handles, and mentions. Control Room deliberately does not inherit fire-and-forget agent messaging, shared provider access, desktop-local audit, unproved “active now” state, or unbounded conversational loops. Sources: [Bot Mode guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/bot-mode.md), [Bot Mode repository](https://github.com/NousResearch/Hermes-Bot-Mode/blob/main/README.md), and [Hermes profile routing](https://github.com/NousResearch/hermes-agent/blob/main/docs/profile-routing.md).

## 1. Project and identity binding

Every Agent Team record binds one tenant, workspace, and project. Agent, routine, room, message, and handoff identifiers are strict safe codes. Cross-project reuse fails closed even when the outer projection is re-signed.

An agent profile is a safe projection of:

- display identity and device-disambiguated handle;
- harness kind, role, platform, and model class;
- evidence-backed status and safe current-work summary;
- queue and routine counts; and
- reviewed procedure/knowledge package identifiers.

It never contains a native profile path, raw system prompt, memory body, provider session, authentication value, MCP configuration, usable locator, private infrastructure value, or full conversation content. A profile grants no provider, command, or execution access.

## 2. Presence is evidence, not decoration

`working` requires either an active canonical lease or a current authenticated heartbeat plus exact current work and an observation time. `last_known` can render only `stale`; it cannot claim current work. `offline` and `stale` agents cannot carry a current-work identifier.

The interface distinguishes:

- `working`: current evidence and bound work;
- `available`: current authenticated observation without current work;
- `blocked`: current observation plus a visible blocker or owner need;
- `stale`: last-known non-current evidence; and
- `offline`: no current evidence.

A recent message, open desktop, or Bot Mode animation is never sufficient presence evidence.

## 3. Routines remain schedule projections

A routine binds one project, agent, and canonical schedule identity. It shows safe purpose, state, next occurrence when scheduled, last safe outcome, and owner attention. `scheduled` requires a next occurrence; `disabled` cannot claim one.

A routine is not a timer callback, cron authority, worker lease, command, or approval. Later Hermes routine reads must normalize into this projection. Live routine creation, modification, or execution remains behind the existing schedule and authority contracts.

## 4. War Rooms are bounded collaboration, not orchestration

Each room has two to six exact project members and one purpose: planning, build, review, research, or incident. The frozen ceiling is:

| Ceiling | Value |
|---|---:|
| Members | 6 |
| Serial rounds | 3 |
| Total messages | 10 |
| Reciprocal agent-pair messages | 4 |
| Duration | 30 minutes |
| Reasoning units | 100,000 |
| Cost | US$25 |

The first reached ceiling stops the room. Membership, sequence, round, mention, and linked-work bindings are exact. Unknown members, self-mentions, duplicated identifiers, sequence gaps, post-round messages, and pairwise loops fail closed. A room that needs the owner must be in `needs_owner` state.

The current projection stores only bounded safe message summaries. Full canonical audit remains mandatory, but CR11A-TEAM-010 does not retain full messages. A later durable ledger must freeze minimization, retention, legal-hold, redaction, project-isolation, integrity, and cleanup rules before storing more content.

## 5. Mentions create proposals only

An `@agent` mention may prepare one draft handoff only when:

- source room, source message, target agent, and project match;
- the target is an exact room member;
- the source message actually mentions that target; and
- title, goal, route profile, and platform pass the strict safe boundary.

The handoff binds a stable idempotency key and its own digest. It is always `draft`, requires owner review, does not create a work item, and has `dispatchState: not_requested`. It grants no approval, command, lease, provider, network, or execution authority. Materialization later must use the existing proposal review, route eligibility, package, audit, and canonical job boundaries.

## 6. Hermes adapter ceiling

The accepted Hermes adapter remains pinned to package `0.20.6` and installed revision `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`. Its qualified lifecycle surface remains discover/start/stream/steer/cancel/resume/usage with approval observe-only. Bot profile, group room, routine, and direct-message RPCs are not qualified and are not called by CR11A.

TEAM-040 now provides a separate repository-only read adapter pinned to that exact package and revision. Its source mode is `injected_only`; its ordered read ceiling is profiles, rooms, routines, and safe-summary events; and its write set is empty. It accepts strict ordinary-data fixtures, produces the existing digest-bound Agent Team safe projection, distinguishes observed, absent, and unknown source truth, and remains incapable of native discovery, provider contact, full-message reads, dispatch, or authority mutation.

Stable normalized identity binds project, profile-key digest, and device-key digest. `working` still requires a current Control Room lease or authenticated heartbeat rather than Bot Mode activity. The conformance harness rejects hidden methods, pin drift, mutable or cyclic manifests, unsafe fixtures, authority substitution, and output substitution. This is repository conformance only: real profile and device identity remain unproved until a separately owner-authorized TEAM-050 qualification. See `CR11A_TEAM_040_HERMES_BOT_MODE_CONTRACT.md` and `CR11A_TEAM_040_ACCEPTANCE.md`.

## 7. Hosted boundary

`agentcontrolroom.xyz` is recorded as the owner's intended future Control Room domain. It is inventory context, not a configured destination or deployment authorization. Current implementation remains hosting-neutral and value-free.

Before any hosted use, the existing production contract still requires private Cloudflare Access, no public origin, separated owner/node routes, exact audiences, protected value custody, reviewed deployment topology, backup/recovery evidence, monitoring, canary/rollback, and an attended owner window. No DNS record, account, zone, tunnel, hostname binding, certificate, secret, deploy, upload, or provider contact belongs in CR11A-TEAM-000/010.

## 8. Implementation blocks

| Block | Output | Model/effort | Effect ceiling |
|---|---|---|---|
| CR11A-TEAM-000 | Frozen identity, presence, room, routine, handoff, and authority contract | Sol/high | contract only |
| CR11A-TEAM-010 | Strict digest-bound view model, synthetic fixture, responsive Project Team UI, hostile tests | Sol/high | local presentation only |
| CR11A-TEAM-020 | Authenticated durable room-event, unread/needs-you, and handoff-proposal ledger | Sol/high | local fake persistence only |
| CR11A-TEAM-030 | Reviewed handoff materialization into canonical proposed work and Action Inbox | Sol/high | no dispatch |
| CR11A-TEAM-040 | Read-only pinned Hermes Bot Mode normalization and conformance harness | Sol/xhigh | injected fixtures only |
| CR11A-TEAM-050 | Owner-authorized one-profile/one-room native read qualification or disabled disposition | Sol/xhigh | one frozen read-only attempt |
| CR11A-TEAM-060 | Metadata-only filtered Hermes read bridge contract and upstream method requirements | Sol/high | repository-only; no native contact |

CR11A-TEAM-000/010 do not install or update Hermes, call a provider, create a routine, dispatch an agent, retain full messages, mutate a workspace, deploy Control Room, or use the reserved domain.

CR11A-TEAM-020 is accepted for the authenticated local fake-persistence boundary. It stores only safe summary events, owner read receipts, saved draft handoffs, and revisioned preservation/legal-hold hooks in an exact private SQLite ledger with HMAC and independent checkpoint verification. It retains no full message and exposes no cleanup, materialization, dispatch, Hermes, provider, hosted-storage, or network path. See `CR11A_TEAM_020_DURABLE_LEDGER_CONTRACT.md` and `CR11A_TEAM_020_ACCEPTANCE.md`.

CR11A-TEAM-030 is accepted for the local reviewed-materialization boundary. One authenticated exact owner decision records accepted, rejected, or withdrawn truth. Accepted review alone can atomically create a draft request, proposed workflow, proposed zero-effect job, and resolved Action Inbox item. Exact replay is inert, conflict rolls back every new record, and no attempt, lease, approval, dispatch, provider, network, or effect authority exists. See `CR11A_TEAM_030_REVIEWED_HANDOFF_CONTRACT.md` and `CR11A_TEAM_030_ACCEPTANCE.md`.

CR11A-TEAM-040 is accepted for the repository-only injected-fixture boundary. The exact pinned adapter normalizes profiles, routines, rooms, and safe-summary events into the existing safe workspace while retaining digest-only identity and collection truth. It has no native reader, runtime client, provider path, message body, write method, schedule mutation, materializer, approval, dispatch, or executor. TEAM-050 remains a separate owner gate. See `CR11A_TEAM_040_HERMES_BOT_MODE_CONTRACT.md` and `CR11A_TEAM_040_ACCEPTANCE.md`.

CR11A-TEAM-050 is accepted with `blocked_before_attempt`. Exact installed-source inspection found no native read that can select one profile and one room and remove content before crossing the reader boundary. The official list RPC returns every profile plus raw room-message text; describe reads SOUL and configuration; direct profile metadata also contains room-message text. No runtime, profile, room, provider, or write contact occurred. Native Bot Mode reads remain disabled. See `CR11A_TEAM_050_NATIVE_READ_QUALIFICATION.md` and `CR11A_TEAM_050_ACCEPTANCE.md`.
