# CR-7B Codex worker adapter acceptance

**Status:** Effect-free adapter, worktree boundary, result, file, test, usage, and artifact-lineage core complete; native qualification is blocked by accepted negative credential-isolation evidence.
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

## Security disposition

- The adapter never uses `danger-full-access`, bypass flags, `--last`, shell interpolation, prompt arguments, job-provided credential references, or job-authorized network access.
- Read-only and workspace-write remain separate authority operations. A write-capable plan cannot be derived from read authority.
- Workspace-write cannot be planned from a path alone; it requires the exact active worktree lease. Replaced or symlinked directories fail closed before cleanup.
- The installed CLI's saved authentication is a node-local harness concern and is not represented in the job authority or committed fixtures.
- The structured-event fixture is derived from official documented event shapes. The separate native fixture records only the failed gate, safe reason code, call count, and confirmed cleanup.
- A future native requalification must first present a valid short-lived credential-boundary permit. Saved authentication inside the worker, readable or unknown credential-store access, direct provider network, inherited credential material, and missing/overbroad broker scope all fail closed.

## Automated evidence

- Focused CR-7B suite: 14 passed, 0 failed.
- Type checking and focused lint pass.
- Full suite: 365 tests, 363 passed, 0 failed, 2 intentional platform skips.
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

A credential-isolated execution design must keep long-lived saved authentication outside every model-controlled command process. Hiding `CODEX_HOME` from the shell environment is insufficient because it does not create a filesystem security boundary. No further native attempt may proceed until a separately reviewed broker/proxy or equivalent OS-enforced design proves that the credential store is unreadable. Start/event/usage/cancel/explicit-ID resume, followed by native workspace-write and artifact publication, remain downstream gates.
