# CR13A-LIVE-340 independent review packet

**Review type:** different independent, report-only, zero-repair
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Product:** `3108a8759863c4692ade2d5532e88cd28f259779`
**Product tree:** `b9a077fa9f4ffa9a53740f236a68a8631f70100c`
**Design parent:** `7856adc8ab8e5e46c346e11755c999fb2bd295be`
**Accepted LIVE-330 product:** `06be655d188c45902c015f85225673dfc31c445d`
**Accepted LIVE-330 review SHA-256:**
`da2c7529b8a5e023b706df8e6ab912e2096c2742edfda0e74758991721031f85`

## Authority and stop boundary

This review is local, repository-only, and effect-free. It authorizes no install, download, product repair, shared
repository edit, authorization store/key/token creation, trusted clock or nonce read, replay lookup/write, spend,
private-source lookup/invocation, descriptor/process/OS/host/environment/path read, raw observation, attestation,
candidate, owner authorization, physical attempt, native listener, provider, network, persistence, deployment, DNS,
hosting, or production action.

Do not generate review code. Do not alter the product, packet, dependencies, or test selection. Run every fixed command
exactly once and in order. Any failure, mismatch, executable ambient dependency, nonzero effect, false authority,
forbidden consumer/import/implementation, or incomplete cleanup rejects. Do not retry, repair, substitute, or broaden.
Return prose only; make no shared-repository edit.

## Required independent inspection

Inspect LIVE-340 architecture, ADR-185, exact product range, contract module, safe barrel, package scripts, and tests.
Verify:

1. Exact parent/tree/product and exactly four changed paths: `package.json`, the one-use invocation contract module,
   safe connection-registry barrel, and focused test.
2. Exact accepted LIVE-330 product and independent-review digest binding; independently hash the preserved review.
3. Exactly one operation, `observe_target_runtime_once`; exactly 15 required bindings, 15 rules, 16 ordered stages,
   15 blockers, and five outcome classes; all arrays and public material are exact and frozen.
4. The future path requires one authenticated authorization bound to the exact accepted source, full tenant/project/
   connection/node/platform/runtime/candidate/attempt lineage, exact operation, fresh nonce, and trusted issued,
   not-before, and expiry instants.
5. Replay and time are independently checked; consumption is atomic and precedes lookup; trusted time is rechecked
   immediately after the consuming transaction; uncertainty at or after commit is terminal and cannot retry, replace,
   fall back, reconstruct, look up, invoke, or infer.
6. A future accepted path permits at most one authorization, one same-module private lookup, and one synchronous
   invocation. Raw observation may flow only to a same-module private attestation handoff and cannot reach a caller,
   public record, API, UI, log, digest, telemetry, error, database row, or worker message.
7. LIVE-340 implements no authorization store, authentication key, token, trusted clock, nonce, replay checkpoint,
   spend, private bridge, lookup, invocation, raw observation, attestation, candidate, owner authorization, listener,
   runtime wiring, or persistence.
8. The module imports no native source or `node:`/filesystem/network/HTTP/DNS/child-process/crypto-signer/database/timer/
   SSH/credential/provider/deployment module. Only the safe barrel imports it; no application, API, worker, scheduler,
   Idea Lab, Hermes, startup, or runtime module consumes it.
9. Public truth reports the contract present while every downstream implementation/use fact remains false. Public
   status contains exactly 39 zero actual totals and eight false authority grants.
10. Contract/status singleton provenance rejects copies, Symbols, accessors, Proxies, alternate material, hostile
    extras, and ambient parser-intrinsic replacements without executing caller behavior. Exact records, arrays,
    parsers, errors, and error prototype are frozen.
11. Public records and errors contain no native value, version/path/PID/OS/host/user identity, private locator,
    endpoint, credential, key, nonce, authorization tag, candidate/attempt secret, command, provider content, raw
    diagnostic, reversible transform, or stack.
12. Cleanup removes the exact disposable root and verifies absence with no dependency/build/review residue.

## Fixed 14-command sequence

Use a fresh local-only disposable clone detached at the exact product and copy prepared dependencies without install or
download. Record the disposable root. Run exactly once and in order:

1. `git status --short`
2. `git rev-parse HEAD`
3. `git rev-parse HEAD^{tree}`
4. `git diff --check 7856adc8ab8e5e46c346e11755c999fb2bd295be 3108a8759863c4692ade2d5532e88cd28f259779`
5. `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
6. `npm run check`
7. `npm run lint`
8. `npm run test:cr13a-one-use-native-observation-invocation-contract`
9. `npm run test:cr13a`
10. `npm run build`
11. `node --test tests/rendered-html.test.mjs`
12. `npm run db:verify` using sandbox escalation only for the disposable verifier's local `tsx` IPC socket
13. `git status --short`
14. `git diff --check 7856adc8ab8e5e46c346e11755c999fb2bd295be 3108a8759863c4692ade2d5532e88cd28f259779`

After command 14, remove only the recorded disposable root and verify that exact path is absent. Command 12 permits
only local temporary IPC and PGlite; it does not permit a real PostgreSQL service, network, or production contact.

## Required disposition

Report High, Medium, and Low findings separately. Acceptance requires all twelve groups and fourteen commands to pass
once, exact identities, exactly four changed paths, 0 High/Medium/Low, 11/11 focused tests, 350/350 CR13A tests, 5/5
build stages, 4/4 rendered routes, 36 migrations/119 PGlite tables, zero authorization/clock/nonce/replay/spend/lookup/
invocation/native-read/observation/attestation/candidate/listener/network/provider/external effects, clean status and
diffs, and verified cleanup.

Acceptance permits ordinary integration of this exact inert contract only. It grants no authorization issuance or
consumption, clock/nonce/replay use, source lookup/invocation, descriptor/process/OS/host/path read, observation,
attestation, persistence, candidate, owner approval, listener, physical qualification, runtime activation, provider,
deployment, blocker clearance, or production authority.
