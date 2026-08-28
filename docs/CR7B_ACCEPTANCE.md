# CR-7B Codex worker adapter acceptance

**Status:** Effect-free adapter, durable credential broker, macOS launcher/controller, bounded JSONL runtime, child-stream transport, deadline/cancellation, and static service package complete; native qualification is blocked pending pinned child creation, independent review, and owner-authorized OS deployment.
**Scope:** CR7B-001 through CR7B-006 for the installed macOS Codex CLI. One owner-authorized provider-backed read-only call was made in a disposable profile and empty Git workspace. No credential contents, rollout, prompt, transcript, command output, raw session identifier, file path, or worktree mutation was retained.

## Frozen seam

- Adapter: `adapter.codex.exec.macos.v1`, version `1.0.0`.
- Installed CLI: `codex-cli 0.150.0-alpha.8`.
- Signed macOS CodeDirectory hash: `33f71aee6d3f281e0a63630b6f7d41659834e260`.
- Executable: `/Applications/ChatGPT.app/Contents/Resources/codex`.
- Protocol: `codex exec --json` JSON Lines.
- Supported adapter verbs: discover, start, stream, cancel, resume, and usage. Steer and approval response are not claimed.
- Official automation reference: <https://learn.chatgpt.com/docs/non-interactive-mode>.

## Delivered boundary

1. A Mac-only invocation manifest pinned to both installed version and signed binary identity. Native runtimes are now an explicit harness-manifest runtime rather than being mislabeled as Node or Python.
2. Compatibility checks for version, binary, JSON events, explicit resume, user-config isolation, rules isolation, and both accepted sandbox modes.
3. Exact authority mapping from a canonical Control Room envelope to read-only or workspace-write execution. Expired, tampered, wrong-executor, out-of-root, networked, credentialed, effectful, and unauthorized-write envelopes fail before launch.
4. Prompts travel on stdin using the `-` sentinel and never appear in process arguments. Resume always targets one explicit native thread and never uses `--last`.
5. Every plan uses `--strict-config`, `--ignore-user-config`, `--ignore-rules`, explicit sandbox, explicit working directory, JSONL, and a Control Room thread-source marker. Non-resumable work is explicitly ephemeral.
6. A bounded JSONL decoder that retains only transport, lifecycle, activity category, and usage counts. Commands, output, file paths, agent messages, reasoning, item identifiers, and raw native thread identifiers are excluded from canonical events.
7. Unknown top-level protocol events become content-free drift evidence. Invalid, oversized, or structurally malformed frames fail closed.
8. A single-run process supervisor contract with deadline abort, operator cancellation, sequence preservation, native-thread consistency, and rejection of nonzero exits lacking structured terminal truth.
9. Verification commands require a separate `codex:verify` authority operation. They are matched only at the node-local decoder and become test started/completed/failed counts; the commands themselves are discarded.
10. File changes become bounded counts with all paths discarded. The final agent message becomes a digest with its text discarded. A result projection binds those facts to exact tenant/run scope, continuous sequence, usage totals, and one terminal state.
11. Workspace-write planning requires a digest-bound lease for the exact run and checkout. The workspace manager requires canonical, disjoint repository and node-owned workspace roots, a full Git commit, an attested created checkout, and unchanged device/inode identity before cleanup. It never exposes a generic recursive-delete operation.
12. Successful changed-file results can publish a bounded, secret-scanned patch through the existing no-overwrite artifact store. Stored bytes, hash, size, tenant, project, job, attempt, and producer node are verified before content-free artifact lineage is returned.
13. Native command planning now requires a digest-protected credential-boundary permit for the exact run, broker identity, model, expiry, and provider-call ceiling. Permits are issued only when long-lived credentials and direct provider access stay outside the worker, command processes inherit no credential, and the broker capability expires within five minutes with at most three calls.
14. A broker-side call ledger now atomically consumes a provider-call allowance before dispatch. Exact retries cannot redispatch; changed retries, cross-run/model requests, endpoint substitution, expired grants, oversize inputs/outputs, and exhausted budgets fail closed.
15. A broker-private SQLite implementation survives restart, converts unsettled calls to ambiguity, requires private filesystem placement, serializes claims with immediate transactions, and stores no prompt or response content. Cancellation closes the grant and makes unsettled work ambiguous.
16. Product transport policy rejects saved-auth CLI execution and the experimental app-server WebSocket as production credential boundaries. The supported seam is a separately isolated Control Room broker; see `CR7B_CREDENTIAL_BROKER_CONTRACT.md`.
17. A digest-bound topology gate now recognizes the pinned app-server/remote-exec split only for disposable qualification. It requires distinct broker/executor identities, parent-owned stdio, one remote environment with no local fallback, no broker-side model commands, exact client methods, broker-only provider egress, executor unreadability, and ledger mediation. Production eligibility is always false because both seams are experimental.
18. The macOS launcher planner fixes three process roles: the Control Room broker controller, its parent-owned app-server child, and a loopback-only single-request remote executor. It requires separate broker release, configuration, credential, and state roots plus separate executor home/workspace, and rejects path escape or containment overlap.
19. The effect-free controller projector registers one exact remote environment, requires ready status before spending a call, atomically claims before `turn/start`, pins both thread and turn to a nonempty environment, forces read-only/no-network/never-approve behavior, disables dynamic tools and capability roots, and refuses general app-server methods or cross-thread resume.
20. Static macOS LaunchAgent and LaunchDaemon templates plus repository conformance checks define the owner-login broker and dedicated non-admin credential-free executor. They are not rendered, installed, loaded, or treated as native evidence. `CR7B_MACOS_ISOLATED_SETUP.md` records separate approval stops and sanitized failure/rollback handling.
21. A strict app-server JSONL session implements the documented initialize/initialized handshake, numeric request correlation, newline framing, safe error projection, bounded frames and pending work, and rejection of malformed, unsolicited, overlarge, server-initiated, and non-allowlisted traffic. Raw error text never crosses the boundary.
22. A content-free turn observer accepts only the exact thread/turn scope, monotonic last-turn token usage, and one terminal status. Completion requires usage and settles the claimed call once; failure/interruption receive safe codes; disconnect and protocol uncertainty settle ambiguity without redispatch.
23. An effect-free qualification runtime drives the full handshake, environment registration/readiness, thread start/resume, claim-before-turn dispatch, notifications, settlement, and close lifecycle over an injected line transport. Notification and event bounds prevent memory-growth attacks. Fake-transport tests prove success, offline denial before spending, forbidden approval-request denial, missing-usage denial, and disconnect ambiguity without starting a native process.
24. A child-stream transport reassembles fragmented UTF-8, separates complete JSONL frames, bounds partial frames and queued lines, forbids concurrent reads, drains but never captures stderr, treats partial-line exit as failure, and closes stdin/terminates at most once. It accepts an already-created child port and cannot spawn a process itself.
25. The qualification runtime now has one bounded deadline and external cancellation channel. Either closes the transport exactly once; before claim it spends nothing, and after claim it records terminal ambiguity with a safe cancellation/deadline code.

## Security disposition

- The adapter never uses `danger-full-access`, bypass flags, `--last`, shell interpolation, prompt arguments, job-provided credential references, or job-authorized network access.
- Read-only and workspace-write remain separate authority operations. A write-capable plan cannot be derived from read authority.
- Workspace-write cannot be planned from a path alone; it requires the exact active worktree lease. Replaced or symlinked directories fail closed before cleanup.
- The installed CLI's saved authentication is a node-local harness concern and is not represented in the job authority or committed fixtures.
- The structured-event fixture is derived from official documented event shapes. The separate native fixture records only the failed gate, safe reason code, call count, and confirmed cleanup.
- A future native requalification must first present a valid short-lived credential-boundary permit. Saved authentication inside the worker, readable or unknown credential-store access, direct provider network, inherited credential material, and missing/overbroad broker scope all fail closed.
- Permit and ticket digests are integrity evidence, not secrets or worker-held bearer authorization. Provisioning and settlement remain broker-internal operations behind an OS boundary; exposing either method to the worker would fail the contract.

## Automated evidence

- Focused CR-7B suite: 38 passed, 0 failed.
- Type checking and focused lint pass.
- Full suite: 389 tests, 387 passed, 0 failed, 2 intentional platform skips.
- Production build and both rendered-route tests pass.
- Migration verification applies 0001 through 0020 and verifies 68 PostgreSQL tables.

## Native negative evidence

- The owner authorized up to three short provider calls, a temporary profile, and an empty disposable Git workspace for read-only start/event/usage/cancel/explicit-ID-resume qualification.
- Call one used the pinned signed binary with JSONL, `--sandbox read-only`, `--strict-config`, `--ignore-user-config`, `--ignore-rules`, stdin prompt delivery, and no configured MCP servers or plugins.
- The only shell check tested whether the temporary `auth.json` was readable; it did not open or print the file. The check returned readable, proving that the model-controlled command boundary could reach saved authentication material despite the read-only sandbox.
- The harness stopped immediately. Resume and cancellation were not attempted, so one of the authorized three calls was consumed. Both the temporary credential profile and Git workspace were removed, and independent residue checks found neither target.
- The repository qualification harness now also refuses to start without an explicit authorized-attempt flag and attempts exact temporary-target cleanup on interruption. This is a deliberate-run guard, not permission for another attempt.
- Sanitized evidence is retained in `tests/fixtures/codex-v1/native-readonly-negative.json`. Compatibility now fails closed with `credential_isolation_missing` when the credential store is readable or unknown.

## Remaining gate

The effect-free broker contract, durable replay ledger, and qualification-only isolated-topology gate now exist, but code structure alone does not prove OS isolation. The raw native thread ID returned by the qualification runtime is explicitly a node-local resume handle; only its digest may enter canonical evidence. Hiding `CODEX_HOME` from the shell environment is insufficient because it does not create a filesystem security boundary. No further native attempt may proceed until a separately reviewed broker/remote-executor launcher proves that its credential store, ledger, and internal provisioning/settlement path are unreachable to the executor; the executor has no provider route; and remote loss cannot fall back to broker-local command execution. Start/event/usage/cancel/explicit-ID resume, followed by native workspace-write and artifact publication, remain downstream gates.
