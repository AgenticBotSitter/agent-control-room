# E06 — Hermes cross-machine messages and files

Date: 2026-09-06. Control Room baseline: local `7ec4cab`.
Disposition: **evaluate merged remote-sandbox retrieval first; RoomLink is a separate bot-to-bot candidate**.
Source research only; no transfer, provider call, plugin activation or runtime integration.

## Owner clarification — the Twitter feature is merged remote-sandbox retrieval

The owner supplied the exact claim after the initial research. It matches
[PR #103600](https://github.com/NousResearch/hermes-agent/pull/103600), verified merged
2026-09-05T10:39:47Z, merge commit `b499ab11fe8b081470e269f2fb27abae03000da5`.
This corrects the initial assumption about which feature the owner meant. It does not
change the observed open status of the separate Group Chat file PRs.

The gateway recognizes `MEDIA:<path>` for output in the active session's remote
terminal environment, retrieves bytes through `BaseEnvironment.fetch_file`, stages
them in the gateway's document cache, and passes the local copy through normal delivery.
The shared transport uses the existing execution channel with bounded base64 output;
it is not a new direct peer protocol. The change names SSH, Modal, Daytona, Singularity
and Vercel backends. Source and three regression tests were inspected via the PR diff;
none were executed here. Upstream reports one real SSH scenario, not independent live
evidence for every named provider.

Important source limits: 50 MiB fetch cap; strict media-delivery mode disables fetching;
unknown remote home uses conservative path rejection (including some `/root` outputs);
unresolvable paths are rejected. A copy lands on the Hermes gateway host, not necessarily
the owner's laptop. User delivery depends on the gateway surface. This is output retrieval,
not incoming file injection, independent-agent file sharing, or whole-workspace sync.
Merged source is not confirmation of any installed host version.

**Changed next action:** evaluate this smaller merged transport and its delivery hook
before the unmerged RoomLink stack for ordinary task outputs. Check how canonical run
results expose retrieved files to Control Room; the gateway's chat hook is not proof
that our `/v1/runs` adapter receives an attachment manifest automatically. Keep the
RoomLink investigation for Idea Lab bot-to-bot handoff. No new custom SSH transport.
The RoomLink test-closure acquisition was paused on this clarification; no tests ran.

## Answer and product gap

Yes: fleet work needs instructions/status/results and, separately, actual file bytes
(research PDFs, generated guides, images). A filename on Marvin's Mac is not a file
on Johnny5's VPS. Machines do not all need direct access to each other's filesystem.
Control Room should own project/task access and durable result references, with approved
local/R2 bytes. Hermes can supply its native bot discussion and attachment delivery.

The current `src/artifacts/v1/native-results.ts::checkedResultBytes` accepts verified
UTF-8 text up to 65,536 bytes. The native adapter/result receiver does not establish
general binary attachment exchange. Do not enlarge that text contract silently.
Git source handoff remains separate; do not synchronize live checkouts, credentials,
state directories or node_modules through bot file sharing.

## Verified upstream state

Public GitHub API state was checked this task, separately from cached web descriptions.
Main was pinned to `14ca27fa0601144b6ea4af1408a3b37c22456072`.

| Interface | Observed state | Fit |
|---|---|---|
| Native peer run/DM | Main `hermes_cli/subcommands/peer.py` resolves a Bot Chat; run posts to `/v1/runs` with an idempotency key. DM sends a text turn. | Existing Control Room run adapter already targets this API family; no second dispatcher needed. |
| A2A plugin | Main plugin supports agent discovery, tasks and conversations. Inspected converter advertises text/plain and renders file references/base64 descriptions into text; it does not download or decode those bytes. | Optional interoperability, not evidence of complete binary transfer or a replacement scheduler. |
| [Cross-gateway Group Chats #99244](https://github.com/NousResearch/hermes-agent/pull/99244) | Merged 2026-08-31. | Relevant native transport for Hermes discussions across machines. Merged does not certify the installed fleet. |
| [Group Chat files #98072](https://github.com/NousResearch/hermes-agent/pull/98072) | Open, not merged; inspected head `5bc71c54fefb52e6d9f646c950cc04466c2c5a9b`, fork `dokterdok/hermes-agent`. | Candidate for actual input-file delivery, bounded staging and recovery. |
| [Bot-generated file handoff #99159](https://github.com/NousResearch/hermes-agent/pull/99159) | Open, not merged; inspected head `9dbc7097e02ff1c22a265b6078695259eabb6e4d`, same fork. | Candidate for handing a generated file to another bot/user. Composed prerequisites are significant, not a single drop-in helper. |

The last two proposals likely describe the owner's discovery. Do not equate an open
proposal, a merged main commit, a release, and what is installed on each host.
PR descriptions cite test results from other hashes; those are upstream claims, not
Control Room acceptance or exact-head tests executed here. #99159's first file-list
page contains 100 entries; this is a targeted inspection, not a complete diff audit.

## Actual source inspected

Pinned files and hashes are in [the acquisition ledger](../REUSE_DOWNLOAD_LOG.md).

- `gateway/hosted_room_attachments.py` (#98072): local SQLite metadata/private blob
  storage, SHA256 verification, idempotent upload identity, per-room/gateway quotas.
  Constants bound a file at 15,000,000 bytes, message at 25,000,000 bytes and eight files.
- `gateway/platforms/api_server_room_attachments.py` (#98072): POST manifest at
  `/v1/room-members/attachments`; PUT bytes at
  `/v1/room-members/attachments/{task_id}/{execution_generation}/{attachment_id}`;
  DELETE a task/generation batch. Upload checks `attachment.stage` grants and profile
  scope and bounds streamed bytes. These are RoomLink-scoped operations, not generic
  uploads for arbitrary callers.
- `gateway/hosted_room_artifacts.py` (#99159): private artifact outbox, no-follow path
  opening, hashes and receipts, cleanup. Immutable scope binds room, task, generation,
  member, target profile, both installation IDs, authority gateway and epoch.
- Main A2A protocol/tools and peer/DM source: text generation and run identity paths.
  A2A `best` orchestration chooses the longest successful reply; that is not our review
  or approval criterion. Discovery metadata does not enforce advertised tool limits.

These checks identify interfaces and design fit, not a complete security review.
Hermes local SQLite can remain a native delivery journal; it must not become a second
global authority for Control Room jobs, reviews or permissions.

## Reuse decision and integration shape

1. Keep native Hermes run APIs for ordinary assigned work. Evaluate native Group Chats
   for bounded Idea Lab discussion; retain Control Room budgets, participants and review.
2. Put RoomLink file delivery/output handoff first in the artifact-transfer shortlist.
   Prefer a versioned upstream API over copying thousands of coupled Python lines into
   our TypeScript app. Open status does not forbid a disposable pinned experiment.
3. Add only the bridge that maps verified native file manifests to canonical project,
   job, attempt and access records. Preserve original native IDs and transfer receipts.
   Hermes room membership alone cannot authorize another project or approve a result.
4. Preserve a harness-neutral artifact service for Codex and downloads in the website.
   Hermes-only delivery cannot be the sole way all workers access project files.
5. Use private authenticated reachability already planned (Tailscale/HTTPS where
   supported). Do not build a new SSH copy protocol or open peer listeners just for this.

Reason for custom code is limited and specific: neither native RoomLink room scopes
nor a generic object store supplies Control Room's cross-harness project/attempt/review
authorization. A thin mapping adapter is justified; a new blob store, retry engine or
second scheduler is not justified by this research.

## Next bounded evaluation and acceptance

First acquire the minimum pinned dependency/test closure and license notices, then run
offline source tests with synthetic profiles/data. No owner's Hermes authentication or
installed Hermes patch is required. Log additions before acquisition. Check the composed
PR requirements, exact version and named-profile binary URL behavior, not just each PR
alone. A real network/agent qualification remains separately scoped work.

| Case | Required result |
|---|---|
| Generated Markdown, PDF and PNG | Receiver/download gets identical size/hash/bytes, not a remote path string. |
| Named profiles and multiple projects | Exact target profile and authorized project/recipient only; no fallback profile. |
| Disconnect or lost acknowledgement | Reconcile the same transfer identity; do not rerun an already-completed agent. |
| Cancel, revoke, supersede | Stale generation cannot publish; unrelated or already-published files survive cleanup. |
| Bad path, symlink, corruption, oversize | Reject without leaking source files or accepting altered bytes. |
| Restart and quota/retention | Recover valid pending receipts; cleanup is bounded and does not delete canonical evidence. |
| Mixed Hermes/Codex workflow | Canonical artifact remains accessible through the authorized harness-neutral path. |

No tests from this table were run here. Do not block the first text-only usable task on
completion of rich file sharing; prepare this during blocks B/C and use it for D's Idea
Lab/ABS handoffs. No application code or dependency was adopted in E06.

Main's retained license is MIT (NousResearch copyright). Before copying PR code, verify
licenses/notices at each exact PR head and the dependency closure; main's license alone
is not a complete fork/dependency audit. Preserve attribution if adaptation is selected.
