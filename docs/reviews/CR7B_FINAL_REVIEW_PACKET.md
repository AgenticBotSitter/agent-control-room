# CR-7B final independent repository review packet

**Status:** Completed. Independent verdict: `accepted_with_residual_native_blockers`; see `CR7B_ISOLATED_RUNTIME_INDEPENDENT_REVIEW.md`.
**Reviewed base:** `14de468999b1ebf4584c13026114d40a0f66cea7` plus the owner-held local uncommitted CR-7B diff.
**Effects allowed:** Repository read, static analysis, and effect-free tests only.
**Effects forbidden:** Native process/service control, credential or Keychain access, provider calls, network-policy changes, deployment, workspace mutation outside disposable test directories, GitHub writes, commit, push, or merge.

## Review question

Does the integrated repository implementation fail closed against duplicate provider spending, uncertain native thread reuse, forged or replayed executor evidence, child/path identity substitution, provider output-limit substitution, trust-root rotation/revocation attacks, complete-registry rollback, and false claims of native qualification?

The reviewer must return `accepted`, `accepted_with_residual_native_blockers`, or `blocked`. A passing test suite is evidence, not the verdict.

## Primary files

- `src/harness/codex-v1/credential-broker.ts`
- `src/harness/codex-v1/credential-broker-sqlite.ts`
- `src/harness/codex-v1/isolated-controller.ts`
- `src/harness/codex-v1/isolated-jsonrpc.ts`
- `src/harness/codex-v1/isolated-process-transport.ts`
- `src/harness/codex-v1/isolated-runtime.ts`
- `src/harness/codex-v1/isolated-executor-security.ts`
- `src/harness/codex-v1/isolated-executor-replay-sqlite.ts`
- `src/harness/codex-v1/isolated-qualification-bundle.ts`
- `src/harness/codex-v1/isolated-trust-pins.ts`
- `src/harness/codex-v1/isolated-trust-pins-sqlite.ts`
- `src/harness/codex-v1/isolated-trust-high-water.ts`
- `src/harness/codex-v1/isolated-package-conformance.ts`
- `src/harness/codex-v1/isolated-topology.ts`
- `packages/control-room-codex-isolated-macos/`
- `tests/codex-harness-contract.test.ts`

## Normative documents

- `docs/CR7B_ACCEPTANCE.md`
- `docs/CR7B_CREDENTIAL_BROKER_CONTRACT.md`
- `docs/CR7B_AUTHENTICATED_EXECUTOR_CONTRACT.md`
- `docs/CR7B_MACOS_ISOLATED_SETUP.md`
- `docs/CR7B_OWNER_ATTENDED_QUALIFICATION_PACKAGE.md`
- `docs/CR5C_FINAL_SECURITY_CONTRACT.md`
- `docs/SECURITY_AND_AUTHORITY.md`

## Required invariants

1. A request is durably claimed before any thread start/resume request.
2. Exact terminal replay cannot dispatch; ambiguous work cannot be retried.
3. Raw provider thread handles remain broker-private and uncertain handles are globally tombstoned across permits and restarts.
4. Caller time cannot extend a permit or reverse the broker clock.
5. App-server notifications before the correlated start response cannot establish turn identity or settle a call.
6. Public results and persistent static service outputs contain no prompt, response, command, path, credential, raw thread/turn ID, or private host identity.
7. The child launch authority is exact, shell-free, environment-minimal, and cleanup remains bounded after partial failure.
8. Broker and executor mutually authenticate distinct pinned keys with fresh one-time nonces and exact channel/scope binding.
9. Native child/path evidence comes from a separately pinned collector and every required observation is true, fresh, and one-time.
10. Turn receipts bind exact channel, permit, request, ticket, native evidence, thread, turn, timing, terminal truth, and confirmed remote cancellation where required.
11. Provider output authority is a signed hard provider-request limit, not post-run accounting.
12. Qualification replay values are consumed once, together, only after every component and cross-proof chronology check succeeds.
13. Owner pin revisions are signed, monotonic, qualification-bound, identity-stable, digest-linked, and terminal after revocation.
14. The SQLite pin registry verifies its complete chain across restart and rejects owner, qualification, schema, signed-content, and row-metadata drift.
15. The independent owner high-water checkpoint exactly matches registry identity, latest revision/digest/state, and resolved pins; rollback, substitution, forgery, or an unanchored revision fails.
16. Every repository success path still returns native qualification unauthorized until separately accepted real deployment evidence exists.

## Adversarial matrix

The reviewer must inspect code and, where useful, add effect-free tests for:

- replay before and after restart; same-value nonce pairs; duplicate values in one atomic replay group;
- crash before claim, after claim, after thread creation, before correlated start, before settlement, and after terminal settlement;
- cross-permit thread reuse, old-schema binding recovery, terminal replay after raw-handle erasure, and concurrent claims;
- unsolicited/server-initiated JSON-RPC, oversized/fragmented UTF-8, queue exhaustion, stale notifications, and disconnect;
- forged broker/executor/collector/owner keys, scope drift, future/stale timestamps, expiration during turn, and chronology inversion;
- mismatched CodeDirectory, UID, argv, cwd, environment, real path, owner, mode, device, or inode;
- accounting-only output limits, wrong model/request/ticket/channel, and output authority issued outside the accepted window;
- partial replay consumption after a late component failure;
- skipped pin revision, replayed manifest, identity rotation, rotation after revocation, database tamper, unsupported schema, and capacity exhaustion;
- copied older pin database, wrong registry identity, forged high-water checkpoint, high-water rollback, and resolved-pin/checkpoint mismatch;
- cleanup failures, unconfirmed remote cancellation, lingering descendant uncertainty, and any path that upgrades uncertainty to success.

## Verification commands

Run from the repository root with the pinned dependencies already prepared:

```text
npm run check
npm run lint
node --test --import tsx tests/codex-harness-contract.test.ts
npm test
npm run build
node --test tests/rendered-html.test.mjs
git diff --check
```

Current producer evidence is 62/62 focused and 411/413 combined, with zero failures and two intentional platform skips. Type checking, lint, production build, rendered routes, and diff validation pass. The independent reviewer must record their own run rather than copying these counts as a verdict.

## Required reviewer response

For every finding, record severity, exact file and line, exploit sequence, violated invariant, whether an existing test should have caught it, and the smallest safe remediation. Separate repository defects from native evidence that cannot exist yet.

The final response must explicitly state:

- whether any repository path can spend twice, reuse uncertain native state, accept forged/replayed proof, or report false native eligibility;
- whether all retained/persisted evidence remains content-free and bounded;
- which native blockers remain after repository acceptance;
- whether another independent review round is required after remediation.

No reviewer may self-author a fix and independently approve that same fix. A blocked or incomplete review remains blocked; silence, tool exhaustion, and passing producer tests are not acceptance.
