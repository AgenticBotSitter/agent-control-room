# F4 durable messaging and native Hermes rooms

2026-09-08 follow-up. This supersedes the earlier E0 room entry in `f4-teamwork.md`
for the specific modules below. It does not complete the AO worktree comparison or
qualify remote/native execution. All sources immutable; no application changes.

## Result

**Hermes now has substantial implemented room orchestration worth reusing.** It is
not just a conversation screen: typed durable room events, deterministic discussion
planning, fenced task leases, recovery to indeterminate and scoped remote grants.
Actual selected modules passed13 local synthetic assertions. Maestro's actual
durable AMP writer passed6 checks, exposing materially different replay semantics.

For Idea Lab, Hermes is the stronger *evidenced starting point* for discussion and
native session integration. However, its current hosted-room execution policy is
**not a drop-in match**: it requires `bot_room` tools whereas the accepted Idea driver
requires tools disabled. Keep one Control Room PostgreSQL authority, not a parallel
room scheduler deciding unapproved work. Do not silently relax this boundary.

## Pins, implementation and license scope

- [Hermes source](https://github.com/NousResearch/hermes-agent/tree/fb3446a281e4bddc733a04bf92a5ec5f0d6decc9)
  `fb3446a281e4bddc733a04bf92a5ec5f0d6decc9`: `gateway/hosted_rooms.py`,
  `hosted_rooms_common.py`, `hosted_room_driver.py`, `hosted_room_discussion.py`,
  `hosted_room_execution_policy.py`, `hosted_room_peer.py`, `hosted_room_links.py`;
  WAL dependency `hermes_state_wal.py`, `hermes_cli/sqlite_runtime.py`.
  Root MIT2025 Nous Research. Desktop group-rounds/turns source and module MIT2026
  inspected, not mounted/executed. Runtime subset uses Python stdlib/SQLite only.
- [Maestro source](https://github.com/23blocks-OS/ai-maestro/blob/2c3baa70ab8f8b2b97c943e4f97c20c5c3e5b81c/lib/amp-inbox-writer.ts)
  `2c3baa70ab8f8b2b97c943e4f97c20c5c3e5b81c`: actual `amp-inbox-writer.ts`,
  `message-delivery.ts`, `types/amp.ts`. MIT2025 Juan Peláez/23blocks. Writer's tested
  direct-UUID path uses Node fs/path/os only; registry fallback was explicitly blocked.
- Standalone `NousResearch/Hermes-Bot-Mode` HEAD
  `80fee22582b871b9765a65e2992b8b5a8211c9f8` path inventory inspected. Its group-chat
  tests remain unevaluated; the current official Hermes implementation above is the
  tested candidate, not a blanket approval of the standalone repository.

No selected code copied into the product; exact receipts record downloaded hashes.
Future copied modules require notices and changed-file records. Full product
dependency/asset redistribution clearance is not established by this stdlib subset.

## Actual shared behavior comparison

| Behavior | Maestro actual durable writer | Hermes actual room driver/planner |
| --- | --- | --- |
| Same message/task ID repeated | Same recipient/sender/id file path | Same task identity+payload returns idempotent |
| Same ID, changed payload | Overwrites file with changed content | `TaskConflictError` |
| Duplicate after read | Resets stored `local.status` to unread | Does not recreate task on matching admission |
| Recipient isolation | Separate direct-UUID paths, tested | Room/task/profile identity with lease scope, tested for local state |
| Lost consumer / restart | File persists; writer has no consumer ACK state machine | Expired running lease recovers indeterminate, never automatically queued |
| Unavailable discussion member | Not supplied by this writer | Deferred member permits next participant, actual planner tested |
| Turn bound | Not supplied by this writer | Planner terminates within3 rounds/10-message cap;2-member fixture tested |
| Permission scope | Writer itself not authentication layer | Actual synthetic status grant cannot dispatch and expires correctly |

These compare modules with different responsibilities, **not whole-platform claims**.
Maestro's `deliver` layer includes content/security/wake verification and retries; it
was inspected, not executed end-to-end. The writer's overwrite behavior can be safe
behind an idempotent validated envelope controller; that controller remains untested
for this integration. No claim of an upstream exploit or total delivery unreliability.

## Precisely how it connects to Control Room

Current `src/idea-lab/v1/coordinator.ts` owns participant/round markers before provider
contact and accepts structured `IdeaLabBotDriverResultV1` (opinion, risk, experiment,
cost and provider receipt). Its evidence schema requires `toolsDisabled:true` and
`mcpDisabled:true`; it never grants task/lease/approval or auto-project authority.
`coordinator-store.ts` retains exact attempts; `lifecycle-service.ts` and protected
`src/web/v1/idea-service.ts` own promotion. Preserve these until an actual replacement
crosses their contracts and migration tests pass.

Hermes `TaskIdentity` supplies room/task/thread/turn IDs and execution/cancellation
generations. `HostedMemberDispatch` additionally binds home+target installation,
profile, authority epoch, member, prompt digest, capability/policy digests and trace.
An adapter can map canonical project/session/participant/attempt IDs to these fields
in an explicit server-owned binding. Do not use free text or display handles as IDs.
Driver payload schema rejects additional fields: global IDs/cost budgets must remain
in binding records, not be shoved into the upstream payload.

Its driver writes **SQLite execution state** for the gateway. That can be local
participant state subordinate to a PostgreSQL admitted task, just as native sessions
already have local journals. It must not become another global queue/lease authority.
The pure discussion planner could instead be adapted to project log events with no
second room DB, but that requires TypeScript porting or a bounded Python helper and
new parity tests. This is a real reuse-vs-port cost decision, not a free replacement.

The precise direct-execution mismatch is exercised: `RoomExecutionPolicy.from_mapping`
requires nonempty `enabled_toolsets` containing `bot_room`, even for a one-iteration
manual-approval policy. Our zero-tool policy is rejected. Resolution candidates:

1. Use the supported ordinary Hermes participant session interface for execution,
   keep Control Room turn admission, and reuse room UI/planner/protocol ideas only.
2. Add an upstream-supported read-only/no-tool room capability, then qualify it.
3. Explicitly design and review a narrowly permitted room tool policy. **Not currently
   authorized by this comparison or interchangeable with toolsDisabled evidence.**

Maestro AMP `payload.context` can preserve canonical IDs but is arbitrary JSON, not
a checked Control Room receipt. Use `thread_id` only for correlation; source-signature
and admitted attempt mapping must precede existing structured contribution intake.
Do not convert successful inbox write, UI websocket send or wake notification into
provider execution/result acceptance. A Maestro transport becomes attractive for a
mixed-harness fleet already running AMP, less so for a Hermes-only discussion because
of its additional agent/host identity and delivery-store integration.

## Executed evidence and limits

### Strong alternative: upstream planner with current zero-tool execution

This is technically viable at the source boundary without enabling room tools:
`plan_next_task(room, typedEvents, local_profiles)` is pure; `plan_publication` returns
event append plans and makes no I/O. A Python helper can import the unmodified792-line
planner plus driver/room/common modules (3,005lines total import source), with **zero
SQLite writes if only planning functions are called**. Imported classes/constants
include `driver.TaskIdentity`, identifier/prompt bounds, payload-field sets, room-label
limits and common exact-field/JSON validators. It is not necessary to start a Hermes
gateway or call the room execution-policy constructor to use those functions.

Mapping: sessionId→room_id; participantId→member_id; explicit registered profile→profile;
roundIndex+1→current round; typed CR contribution event→message.member+turn.settled
projection; run/attempt IDs↔deterministic returned TaskIdentity in a saved binding;
unknown result→no completed publication; returned member+prompt→existing admitted
`IdeaLabBotPanelDriverV1.invoke`. CR still owns provider marker, usage/cost, auth,
cancellation, result validation and project promotion. Never reconstruct a settled
room event from an unverified conversational string.

Cost/semantic mismatches are concrete: upstream selects @mentions, supports pass/defer,
uses fixed3rounds/10messages and no dollar/time budget; current schema supports
3–6participants, configurable1–3rounds, up to18messages and time/cost limits. Current
coordinator's scheduling itself is one nested `for` line at235, surrounded by required
admission/receipt handling. Replacing all327lines would lose that authority. Deletion
candidates are only selection-loop mechanics and compatible portions of
`discussion-prompt.ts` **after parity**; `coordinator-store.ts` and protected promotion
remain. Upstream's10-message cap cannot silently replace an accepted18-message panel.

Two defensible implementation choices to compare: (a) versioned new discussion mode
with explicit10-message UX/contract, imported pure Python planner and current zero-tool
ports; (b) narrow parameterization/port preserving existing1–3round and18-message
contract, with upstream test vectors retained. Neither is a thin drop-in today. This
alternative **must get E3 mapped planner tests** before rejection as more costly than
our current loop; source lines alone do not prove maintainability or user-value cost.
Required cases include3and6participants,1and3rounds,18-message requested plan, explicit
mentions, unavailable member, duplicate terminal events, stale generation and cost
stop before provider marker. No such complete mapping test was executed in this E2
checkpoint, so final planner winner remains open.

Reproduction: `f4-durable-fetch.mjs <owned-root>`, then
`node research/reuse-comparisons/f4-durable-maestro.mjs <owned-root>` and Python3.12+
`research/reuse-comparisons/f4-durable-hermes.py <owned-root>`.

Maestro test transpiles unchanged source with existing TypeScript, executes CommonJS
in VM with only os.homedir replaced by a disposable root and real fs/path. No HOME
environment variable overwritten, no ambient registry or initAgentAMPHome called.
Six checks pass;3.48ms measured after transpilation,119,904KiB Node/compiler peak RSS.

Hermes test uses actual unmodified modules and fresh explicit-path SQLite. Python3.12
bundled runtime,13 checks pass;148.8ms workload,31,670,272bytes macOS maxRSS (~30.2MiB).
Local lease-clock expiry/reopen is not actual gateway crash/network reconnect. Driver
does not run native agents. Pure grant test uses disposable synthetic bytes, no native
identity/secret accessor or gateway config resolution invoked. No grant/token retained.

First two Hermes attempts failed on missing WAL/runtime helper modules; acquired
exact pinned dependencies and reran, not stubbed. Both failed fixture directories
were automatically removed. Upstream discussion/driver tests read for fixture and
recovery cases, not run in their pytest suite. No external pytest/package install.

## Decision, next batch and custom-code exception

Select **retain canonical coordinator + narrow native participant adapter** as the
current implementation direction; prioritize actual Hermes ordinary-session versus
room-protocol adapter experiment before adding custom terminal/team orchestration.
Maestro durable AMP remains conditional for heterogeneous fleet messaging, not rejected
because of whole-platform size. AO workspace backend remains a separate decisive gap.

Next local batch must feed actual candidate responses through existing Idea driver
and promotion interfaces, test mismatched IDs/costs, late result/cancel, and isolate
project scope. This is E3 and is **not completed here**. Current E2 supports preference
but not a final overall winner. Physical HTTP RoomLink transport and native host
qualification remain separate gates. The direct zero-tool failure is decisive against
unchanged room execution **only**, not against planner, status or protocol reuse.

Integration size: Maestro writer-alone wrapper is small but insufficient; whole AMP
transport requires registry/content/notification boundaries. Hermes room-to-CR binding
requires lifecycle/result/usage/cancel translation and policy resolution; medium/large
uncertainty. Reuse pure policy may remove future discussion routing code, but production
lines removed now0. Existing security/approval boundaries are a justified custom
adapter responsibility because neither candidate supplies Control Room's exact
project/attempt/result authority contracts. Revisit after an upstream compatible seam.

Rollback for future optional adapter: disable dispatch, retain immutable receipts and
local state for reconciliation, never requeue ambiguous attempts. No database migration
or upstream fork selected now. Weighted final scores withheld pending E3 rather than
turn unknown costs into low scores for alternative projects.
