# RC4 Maestro delivery semantics beyond the inbox writer

2026-09-08. Pin `2c3baa70ab8f8b2b97c943e4f97c20c5c3e5b81c`.
**Nine new checks pass through actual deliver/wake-chain/queue code.** This adds
decision-changing evidence beyond the previous six writer-only checks: the local
delivery layer itself accepts changed content under the same message ID and queues
another wake. It distinguishes persistence from wake confirmation, but its confirmation
semantics are not immutable per-attempt execution acknowledgements.

## Exact actual code and substitutions

Acquired8 exact public files (URLs/hashes in `f4-delivery-acquisitions.json`). Actual
whole `lib/message-delivery.ts`, `wake-chain.ts`, `wake-queue.ts`, `content-security.ts`,
`amp-inbox-writer.ts`, `amp-canonical-json.ts` and `types/agent.ts` were transpiled with
installed TypeScript. From notification-service.ts only the exact pure messageRef
function AST is executed; the remaining native notification implementation is **not**
exercised. All source hashes checked before evaluation. MIT source pin and prior
notice inspection retained; full-platform dependency licensing not qualified.

Real fs/path and a disposable os.homedir return are supplied; no HOME environment
variable changed, registry/home initialization or personal directory read. Actual
content wrapper runs, but its regex/tag behavior is not prompt-injection safety or
sender-authentication qualification. Inbound route/signature verification is outside
this seam; synthetic inputs contain just the envelope/payload fields used here.

Only external boundaries are substituted: stream session availability/push; channel
push/session-verification; pane idle/readback notification; WebSocket; registry with
no webhook metadata. Actual default wake adapters select between these outcomes.
Actual queue enqueue/status/reset runs; ticker is cleared by upstream reset in
finally. No timer-driven retry flush, network, SSH, tmux, native session or webhook
attempt is made. Fetch is a throwing guard. VM restrictions are an import allowlist,
not hostile-code sandboxing.

## New observations

| Scenario | Actual delivery/chain decision | Fit consequence |
|---|---|---|
| Recipient has no available wake route, WS says pushed | Inbox persisted; delivered=true, notified=false, verified=false; retry queue1 | Disk is not consumer receipt, and WS success is correctly not promoted to wake proof. |
| Same message ID, changed body, unavailable recipient | Another successful deliver, same single inbox file overwritten with secured changed body; queue2 | The local delivery layer does not supply immutable-ID conflict handling or deduplicate queued wakes. An upstream route may impose additional checks; not tested. |
| Channel push with no verified session | notified=true but verified=false; actual chain tries pane and queues | Useful sent-versus-confirmed distinction; avoids suppressing fallback merely because transport accepted bytes. |
| Channel session verification true | verifiedBy=channel and fallback stops | Source comment/code uses a session's prior ACK, not a per-message ID+digest ACK. Receipt cannot stand in for CR attempt acknowledgement. |
| Pane busy | deferred=true, verified=false, one queued wake | Deferred is not arrival. |
| Pane fixture reports readback verified | verifiedBy=pane | Actual mapping works; no real pane-readback/agent consumption proved. |
| In-process stream accepts text | verifiedBy=stream and chain stops first | Actual route preference works; accepting input is not completed work or approved execution. |
| Recipient UUID missing | Refusal before writing/notifying | Existing local layer requires explicit recipient identity; no fallback display-name directory used. |

This is E2 for actual local decision machinery with external transport substitutions.
It is not E3 CR integration, durable agent ACK, authenticated routing, remote delivery,
retry recovery, or execution. The candidate writer is included as a dependency, but
its unchanged six earlier checks were not rerun. New assertions concern the actual
caller/queue/confirmation behavior across repeated deliver calls.

## CR mapping and viable scope

`src/node-bridge/journal.ts` records canonical frame/receipt digests and attempt
identity; load verifies integrity, and repeated snapshot run/version with changed
digest is rejected. `src/idea-lab/v1/coordinator-store.ts` retains authenticated
versioned participant-run state. Maestro's envelope.id/to/from and recipient UUID can
be mapped to a separately bound informational message, but cannot replace those
canonical job/attempt/run, content and receipt bindings merely by copying strings.

The meaningful reusable part is **optional heterogeneous-agent notification routing**:
ordered adapters and distinct unavailable/sent/deferred/confirmed status can avoid
inventing a new notification fallback chain. A thin CR adapter must preserve its
own immutable message/digest and task authority, distinguish wake from task delivery,
and decide explicitly whether repeated nudges are permissible. Root owns that
protocol/auth decision; this experiment does not author it.

Strong alternative: retain current task dispatch/receipts and use existing native
participant interfaces directly, adding optional informational notifications only
when needed. Hermes room/planner evidence remains separate; its policy mismatch
does not make AMP execution authority acceptable by default. Maestro is not rejected
for platform size or writer-only evidence; now its actual delivery layer has been
exercised and a concrete usable boundary identified.

Current production deletion0. Candidate can avoid future fallback routing, not
replace current journal/receipt/coordinator. Wholesale reuse would also import
registry, session wake queue and native transports, which this source subset does
not qualify. Whole-service maintenance/resources unknown; no arbitrary footprint
or complete dependency claim. Scoped judgment0–5: informational wake routing fit4;
immutable task delivery fit1–2 unchanged; adaptation effort2–3 (identity/receipt
boundary remains); custom notification logic avoided3–4. No weighted final winner.

## Next decisive gate and evidence limits

If required fleet interoperability needs this optional route, map a CR informational
message through actual AMP route validation and consumer receipt with synthetic peers:
same/different digest replay, recipient restart, unavailable→available, ACK bound to
message and digest, stale ACK and queued wake recovery. Do not mistake the existing
session-level channel ACK or pane marker for that test. Test actual supported
transport modules separately before selection; webhook's best-effort retry path was
not used and receives no approval from these results.

Command: `node research/reuse-comparisons/f4-delivery-fit.mjs`. Stagezero ready.
First invocation failed at authored JavaScript parse before candidate execution
(quoted variable identifier). One focused syntax repair only; second invocation
exit0,9checks, actual queue empty after reset. Failure retained in
`f4-delivery-evidence.json` with condensed terminal outcomes. No source changes or
relaxed assertions to make the candidate pass.

Public requests bounded15s, streaming file cap100KB each; total source cohort116KiB
allocated. Disk remained above20GiB; no installs or services. Cleanup recorded below
after preserving provenance and results. Root owns final RC4 selection.

Exact owned root `/private/tmp/cr-f4-delivery.CmEyjB` removed; absence test exit0.
Candidate sources and synthetic inbox files were deleted, recoverable from the
logged pins; actual queue ticker stopped before process completion. No other source
cohort, profile or user data touched. Reports and authored reproduction fixtures remain.
