# CR-7B authenticated executor and native evidence contract

**Status:** Effect-free repository contract implemented. No native identity, service, credential, network, provider, or deployment evidence has been collected.

## Boundary

The Codex app-server protocol supplies application messages; it is not the Control Room trust boundary. Before a remote executor can be treated as the intended Mac identity, the broker and executor must mutually authenticate through pinned Ed25519 keys and bind that exchange to one channel, broker identity, executor identity, environment, and lifetime. A topology declaration, loopback address, PID, or self-reported process field cannot replace this exchange.

The protocol remains aligned with the official Codex app-server lifecycle while adding a Control Room-owned security envelope outside it. Official references:

- <https://developers.openai.com/codex/app-server/>
- <https://learn.chatgpt.com/docs/app-server>

## Mutual channel authentication

1. The broker signs a versioned challenge containing pinned broker/executor key IDs, broker/executor/environment identity digests, one channel ID, a unique nonce, and a maximum 60-second lifetime.
2. The executor verifies the broker signature and returns a signed proof bound to the digest of the entire signed challenge, the same channel and executor key, a second unique nonce, and a lifetime contained by the challenge.
3. The broker verifies both signatures using separately pinned SPKI keys, exact scope, clock skew of no more than five seconds, and unexpired lifetimes.
4. Challenge nonce, proof nonce, and challenge digest are consumed atomically. Restart-safe production consumption uses a private SQLite guard that stores only SHA-256 digests, has a hard capacity ceiling, and rejects replay or partial group insertion.
5. A successful exchange produces a content-free channel-binding digest. It does not expose private keys, raw host identity, credentials, paths, commands, or provider content.

## Native execution evidence

The executor cannot attest itself into trust. A separately pinned native verifier must sign fresh evidence for the exact executor/environment and record only digests plus required observations:

- canonical executable real path and signed CodeDirectory identity;
- exact spawn specification, UID, argv, cwd real path, and environment digests;
- observed child process, matching UID/image/argv/cwd/environment;
- correct path owner and private mode;
- stable device/inode identity across the observation.

Every required observation must be exactly `true`. Evidence lives for no more than 60 seconds, is one-time replay guarded, and fails on extra fields, scope drift, signature failure, future time, expiry, or incomplete proof. The contract does not collect this evidence and therefore does not clear the current native blocker.

## Executor turn receipt

The executor signs one content-free receipt for the exact authenticated channel, permit, run, request digest, broker ticket, native thread digest, turn digest, environment, and native-evidence digest. It records only terminal state and start/completion times. An interrupted turn may report only `executor_reported`; that label is not confirmation. Completed and failed turns require `not_requested`. Receipt IDs are one-time replay guarded.

An interrupted bundle additionally requires a separately pinned collector signature over the exact channel, executor, environment, native thread and turn digests, interrupt request and acknowledgement digests, and an independently observed empty descendant set. The collector evidence must be fresh, acknowledge the interrupt, report zero descendants, and bind the same collector identity and key as the native observation. Only that proof can produce `remoteCancellationConfirmed: true`.

The receipt proves binding only when its referenced native evidence and channel session were independently accepted. It never settles the provider-call ledger by itself and never contains prompts, outputs, raw thread/turn IDs, commands, or paths.

## Provider output authority

Post-run token accounting is not spending authority. The provider-side blocker clears only when broker-signed evidence binds an exact provider request digest, permit, request, ticket, model, and maximum output tokens with enforcement `provider_request_hard_limit`. `accounting_only`, drifted, unsigned, expired, or replayed evidence fails closed. The pinned app-server seam has not produced this evidence, so `provider_output_cap_unenforced` remains active.

## Qualification evidence bundle

`isolated-qualification-bundle.ts` composes the signed channel, native observation, provider-output authority, turn receipt, and, for interrupted turns, independent cancellation evidence into one exact lineage graph. Component verification is staged through an in-memory buffer; no durable replay value is consumed until every signature, scope, digest, and chronology check passes. The final durable replay operation atomically consumes all six values for non-interrupted turns or all seven values for interrupted turns. A bad late-stage receipt or cancellation proof therefore cannot burn an otherwise valid challenge or native observation.

The bundle additionally requires:

- the pinned CodeDirectory identity and the same executor/environment across channel and native evidence;
- identical permit, request, ticket, and channel binding across output authority and turn receipt;
- authentication before native observation, native observation before turn start, and native evidence valid through completion;
- provider output authority issued after authentication, before turn start, and valid through completion;
- the turn receipt to name the digest of the exact accepted native evidence.

A successful repository bundle reports `contractSatisfied: true` but always reports `nativeQualificationAuthorized: false` with `trusted_native_deployment_not_observed`. Repository-generated keys and fake signatures cannot authorize a native attempt.

## Owner-rooted trust pins

An owner-signed, qualification-specific manifest supplies three distinct public-key pins for the broker, executor, and native collector plus their stable identity/environment digests. Every Ed25519 SPKI must be the exact canonical DER and base64url encoding; fingerprints derive from the canonical DER so parser-tolerated trailing bytes cannot disguise one semantic key as multiple roles. Revisions form an exact digest-linked chain. Revisions cannot be skipped or replayed, identity scope cannot drift during key rotation, and revocation is terminal.

The broker-private SQLite registry verifies the entire owner-signed chain on open, stores no private key, survives restart, rejects a different owner root or qualification, detects signed-content and row-metadata tampering, and preserves rotation and revocation. It uses private path checks, full synchronous writes, a hard revision limit, and exact schema-version handling.

A separately owner-signed high-water checkpoint binds the qualification, protected-registry identity, latest manifest revision/digest/state, recording time, and prior checkpoint digest. The anchored bundle verifier requires that checkpoint to match both the durable registry and resolved active pins before it verifies the evidence bundle. Older copied registry state, a substituted registry identity, a forged checkpoint, or an unanchored newer revision fails closed. The repository defines and tests this comparison but does not provide or claim the independent owner-controlled storage that must supply the native checkpoint.

Bundle verification accepts public keys only from the resolved active manifest and still returns native authorization false. The later host workflow and approval boundaries are frozen in `CR7B_OWNER_ATTENDED_QUALIFICATION_PACKAGE.md`.

## Implementation evidence

- `src/harness/codex-v1/isolated-executor-security.ts`
- `src/harness/codex-v1/isolated-executor-replay-sqlite.ts`
- `src/harness/codex-v1/isolated-qualification-bundle.ts`
- `src/harness/codex-v1/isolated-trust-pins.ts`
- `src/harness/codex-v1/isolated-trust-pins-sqlite.ts`
- `src/harness/codex-v1/isolated-trust-high-water.ts`
- `tests/codex-harness-contract.test.ts`

The tests cover valid mutual authentication, attacker keys, same-value and prior replay, scope drift, expiry, restart persistence, raw-value exclusion, atomic capacity failure, hostile SQLite trigger rejection, incomplete or drifted native evidence, exact turn-receipt binding, separately signed cancellation acknowledgement and descendant absence, accounting-only output limits, cross-proof lineage, chronology, no partial replay consumption on bundle failure, owner-signed pin rotation/revocation, semantic-key alias rejection, durable pin-chain restart, at-rest tamper detection, high-water rollback/substitution/forgery denial, and exact anchored bundle binding.

## Remaining native gate

Repository types and fake signed evidence are contract tests, not host qualification. Advancement still requires owner-authorized creation or selection of distinct keys/identities, installed authenticated IPC, native verifier implementation, signed fresh host evidence, proven credential and ledger unreadability, broker-only provider egress, executor egress denial, a provider-enforced output limit, and confirmed remote descendant cancellation. Each external action remains a separate approval stop.
