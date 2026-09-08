# F4 teamwork and coding workspace comparison — bounded checkpoint

2026-09-08. Control Room baseline `44f9064`. This is **not a completed F4 winner
selection**: actual pure modules were exercised, but decisive workspace and AMP
end-to-end fit comparisons remain. No application code changed.

Follow-up: `f4-durable-comparison.md` now exercises actual Maestro durable inbox and
Hermes hosted-room driver/planner/grants. Its13+6 scoped checks supersede the room
discovery-only row below; E3 mapping and AO backend remain open.

## Immutable candidates and actual seams

| Candidate | Pin and inspected implementation | Evidence / intended use |
| --- | --- | --- |
| [AI Maestro](https://github.com/23blocks-OS/ai-maestro/tree/2c3baa70ab8f8b2b97c943e4f97c20c5c3e5b81c) | `2c3baa70ab8f8b2b97c943e4f97c20c5c3e5b81c`, package0.38.5. `lib/meeting-inject-queue.ts`, `message-send.ts`, `message-delivery.ts`, `messageQueue.ts`, `services/messages-service.ts`, `hooks/useMeetingMessages.ts` | E2 ephemeral meeting queue; E1 actual AMP send/delivery. Candidate delivery/UI supplement, not yet fit-qualified transport. |
| [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator/tree/24e101914976a14145d7302f49626db3541ef8b5) | `24e101914976a14145d7302f49626db3541ef8b5`. `backend/internal/adapters/workspace/gitworktree/{workspace,parse}.go`, `workspace/router/router.go`, `session_manager/message_delivery.go`; frontend `workspace-file-path.ts` | E1 substantive isolated-workspace adapter; E2 frontend path helper. No backend runtime claim. |
| Existing Control Room | `src/idea-lab/v1/{coordinator,coordinator-store,lifecycle-service}.ts`, `src/web/v1/idea-service.ts`, `scripts/agent-jobber-queue.mjs` | Actual coordinator10 tests rerun; synthetic providers and disposable PGlite. Retain canonical task/attempt/promotion policy pending stronger replacement evidence. |
| Native Hermes rooms | Prior `CR11A_AGENT_TEAM_AND_WAR_ROOM_CONTRACT.md` explicitly says room RPCs not qualified. | Complementary participant transport. No new room implementation pin/test in this bounded subtask; **open** F2/F4 comparison, not rejected and not pass. |

### AI Maestro source findings

`sendFromUI` builds AMP envelopes, resolves agent identity and host, persists sent
messages, and delivers locally or forwards to remote HTTP with a ten-second timeout.
`deliver` writes the UUID-addressed AMP inbox, distinguishes notification from verified
delivery, and queues wake retries when notification is unconfirmed. This is useful
implemented machinery, not merely a dashboard screenshot. It also invokes agent
registry, content security, notification, host config, AMP keys and webhook logic.
It is not a small dependency-free message client.

`messageQueue.ts` imports the actual host registry and computes ambient-home
`.agent-messaging` paths, including an old-duplicate cleanup migration. **It was not
imported/executed**, to avoid touching installed agent state. A fit adapter must inject
an explicit isolated data root and registered peer identities, preserve Control Room
attempt IDs, and separate accepted inbox bytes from executed work.

The meeting injection queue is genuinely extractable: only a Map, timestamp, string
helpers and one environment flag; no service imports or package dependency. However,
actual execution shows duplicates retained, destructive drain without acknowledgement,
lost queue on fresh module initialization and no backlog limit observed at1,000 items.
Hermes is classified `unknown` by its kind switch; supported context routing is
Claude/Codex/Gemini, defaulting to the legacy injection path. These are narrow queue
facts, **not evidence that Maestro's durable AMP inbox loses messages**.

Therefore do not substitute this FIFO for `coordinator-store.ts` or pg-boss. It may
serve best-effort context injection after an authoritative admission/receipt adapter,
but that adapter has not been proved cheaper than the official Hermes interface.

### Agent Orchestrator source findings

The worktree adapter is a real2,002-line reusable boundary, not the whole application:
`Options` injects `ManagedRoot`, `RepoResolver`, binary and command runner;
`Create/Restore/Destroy/ForceDestroy/StashUncommitted/ApplyPreserved` cover substantial
workspace ownership and recovery. It validates physical roots, detects existing
worktrees and has Git-specific error distinctions. Router delegates scratch versus
Git project kinds through `ports.Workspace`; database operations are not required by
that router when an explicit project port is supplied. Dependencies include internal
domain/ports/gitdefault/process packages and standard Go, requiring extraction tracing.
Upstream router tests were read; broader preserve/reclaim/force-destroy test paths
were inventoried but **not all read or run**.

`WaitForMessageDeliveryReady` checks session existence/termination and activity,
polls150ms, requires750ms settled readiness, and supports harness-specific first-signal
or composer readiness. Useful to avoid pasting into a process that exists but is not
ready. That does not prove a prompt was consumed, a task claimed or external effects
completed. Its implementation depends on Manager store/runtime/agent registries.

The tested frontend path matcher is a display convenience, not a security primitive.
It normalizes separators and maps unique basenames. Our first test **failed** because
`item.ts` ambiguously matching two subdirectories selected the first suffix before the
uniqueness branch. The corrected evidence explicitly records that behavior; traversal
`../private.txt` also passes through unchanged. Do not use it to select authoritative
artifacts; adapt it only for safe navigation with exact allowlisted file IDs and reject
ambiguous matches. This does not establish a backend path traversal vulnerability.

## Executed evidence

`node research/reuse-comparisons/f4-exercise.mjs <owned-root>` transpiles actual pinned
upstream TypeScript with the existing TypeScript package; no rewritten substitutes.
Twelve assertions pass recording both useful behavior and negative fit findings.
The first ambiguous-basename assertion failed and was retained above, not concealed.
Fresh module import demonstrates initialization loss, **not physical OS restart**.
Disconnected means a named queue receiving messages with no consumer, not a live
network interruption. No worktree creation or transport service was executed.

Combined pure-module workload:31.8ms after TypeScript import, process peak RSS118,560KiB.
This includes compiler/Node overhead; **not comparable application service memory**.
`node --import tsx --test tests/idea-lab-bot-coordinator.test.ts`:10/10 pass in5.18s;
tests cover budget rejection, durable cancellation, ambiguous provider outcomes,
recovery without retry, contribution retention and evidence restrictions. Different
workload; no comparative speed ranking can be inferred.

## Integration decision and costs

| Responsibility | Preliminary decision | Exact change / effort driver |
| --- | --- | --- |
| Discussion ownership, bounded turns and project promotion | Retain current **provisionally**, supplement native transport | Existing327-line coordinator already enforces3 rounds/18 attempts and receipts; Maestro FIFO has none of these semantics. Keep `lifecycle-service.ts` and `src/web/v1/idea-service.ts` project promotion. No production deletion justified. |
| Cross-agent messaging | Maestro AMP vs native Hermes still finalists | Maestro has real durable inbox and wake machinery; Hermes avoids extra registry for Hermes-only fleet. Must execute real isolated inbox-to-existing attempt receipt with duplicate ID, lost response and unavailable participant before selection. |
| Isolated coding workspaces | AO worktree extraction **promising, not rejected** | Evaluate its injected runner/RepoResolver boundary rather than adopting desktop or SQLite state. Thin Go helper versus TypeScript translation versus existing Git wrapper remains a decision-changing local experiment. New Go build/update packaging is a cost, not disqualification. |
| Workspace file navigation | Narrow AO adaptation possible | Unique exact paths useful; reject first ambiguous suffix and traversal at existing protected file API. Small helper does not justify adopting whole AO frontend. |
| Meeting context injection | Do not adopt unchanged as durable queue | Thin ephemeral UI feature only; adding dedup/durable ACK/bounds would recreate responsibilities already held by pg-boss and coordinator. |

Weighted final scoring is deliberately withheld: execution/migration/resource costs
are unknown for the decisive service adapters; invented numerical precision would
misrepresent source-only evidence. No production files removed, no migration/backfill
performed, no dependency adopted. Research harness (fetch+exercise) is not an
estimate for a production adapter. Integration effort ranges: small for pure UI helper,
medium/large for AMP authority-preserving adapter, medium/large for Go worktree helper;
confidence low until tests below establish dependency closure and protocol needs.

## Required next fit batch (not optional before final selection)

1. Isolate Maestro `amp-inbox-writer`, send/delivery dependencies with an explicit owned
   root and injected identity/wake ports. Execute same-ID duplicate/lost ACK/restart
   cases through an existing Control Room attempt/contribution interface. Inspect and
   exercise native Hermes room client/parser against the same cases. Neither message
   receipt may grant task ownership or promotion.
2. Acquire reviewed isolated Go1.25.7+ toolchain under global allowance (no Go found on
   PATH in this subtask). Run actual AO worktree adapter plus upstream preservation/
   reclaim tests in empty local Git fixtures, no remotes. Map project/session IDs to
   existing job/attempt and capability ports. Test concurrent same-ID creation, branch
   collision, dirty tree, restart/reclaim, escaped symlink, refusal and owner review.
3. Exercise discussion transport receipts through `IdeaLabBotCoordinatorV1` with
   duplicate, cancellation and ambiguous outcomes; compare keeping current coordinator
   plus transport to adopting another planner. Test promotion through actual lifecycle
   service. No real provider is needed for these local interface comparisons.
4. Independent reviewer challenges strongest alternative and actual code-extraction
   dependency closure. Only then score final alternatives and create implementation
   batch. Rollback initially disables optional adapter; retain canonical records and
   previous coordinator until migration/parity independently pass.

## Licensing and maintenance

Pinned Maestro root MIT copyright2025 Juan Peláez/23blocks; retain notice for copied
queue/helpers. Queue itself has no third-party runtime import. Whole service package
includes native postinstall, Cozo, transformers, Claude SDK, PTY and Next dependencies;
none installed, and transitive license clearance is **not** claimed. Meeting code
credits prior swickson PRs; preserve provenance when adapting.
AO root Apache2.0; retain license/change notices when adapting. Pure frontend helper
uses a type-only import; backend module targets Go1.25.7 and includes SQLite/PTY/ACP
dependencies at application level. Narrow worktree extraction may avoid many, but
transitive closure still unverified. Neither source pin proves current issue/security
health; upstream change/issue review and update contract remain open.

All downloads are separately inventoried in `f4-source-receipt.json` and
`f4-acquisitions.md`. No source was imported into production, no services/listeners,
credentials, installed profiles, providers, SSH or GitHub writes were used.
