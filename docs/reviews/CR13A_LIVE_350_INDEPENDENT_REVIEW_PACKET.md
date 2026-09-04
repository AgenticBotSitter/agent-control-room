# CR13A-LIVE-350 independent review packet

**Review type:** different independent, report-only, zero-repair
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Product:** `df7f981c539b1c7f2826ac62e64f28ff0215554e`
**Product tree:** `19aee72f1dacf33799708cf2d356c095711cf2bc`
**Design parent:** `fbecc04080c7e471e82328aa4ed52670dbe6dddf`
**Accepted LIVE-340 product:** `3108a8759863c4692ade2d5532e88cd28f259779`
**Accepted LIVE-340 review SHA-256:**
`bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af`

## Authority and stop boundary

This review is local, repository-only, and effect-free. It authorizes no install, download, product repair, shared
repository edit, authorization issuance/consumption/revocation, production key or database use, current-time authority,
private-source lookup/invocation, descriptor/process/OS/host/environment/path read, raw observation, attestation,
candidate, owner authorization, physical attempt, native listener, provider, network, deployment, DNS, hosting, or
production action.

Do not generate review code. Do not alter the product, packet, dependencies, or test selection. Run every fixed command
exactly once and in order. Any failure, mismatch, executable ambient dependency, nonzero forbidden effect, false
authority, forbidden consumer/import/implementation, incomplete cleanup, or inability to inspect rejects. Do not retry,
repair, substitute, or broaden. Return prose only; make no shared-repository edit.

## Required independent inspection

Inspect LIVE-350 architecture, ADR-186, exact product range, migration, authorization store, safe barrel, package
scripts, and tests. Verify:

1. Exact parent/tree/product and exactly five changed paths: `package.json`, migration 0037, the authorization-store
   module, safe connection-registry barrel, and focused test.
2. Exact accepted LIVE-340 product and independent-review digest binding; independently hash the preserved review.
3. The store accepts only an already sealed exact authorization for `observe_target_runtime_once`, bound to the exact
   LIVE-330/LIVE-340 products and reviews, tenant/project/connection/node/platform/runtime/candidate/attempt lineage,
   authorization ID, digest-only nonce, trusted issued/not-before/expiry values, and sealing-key identity.
4. Authorization sealing and persisted-state authentication use separate caller-supplied 32-byte keys; the store
   generates, persists, exports, logs, or returns neither key and binds configuration to the expected authorization
   key-ID digest.
5. Migration 0037 adds exactly an authenticated append-only stream head, authorization record, and tenant-scoped
   digest-only nonce reservation. Registration locks the tenant and stream and inserts all three records in one
   transaction after verifying the entire existing authenticated stream.
6. Exact replay is inert and returns the same sanitized negative-authority receipt. Changed authorization-ID reuse,
   changed nonce reuse, body/tag/key/scope/time drift, row/head/nonce tampering, deletion/reordering, and database faults
   fail closed without creating partial authority.
7. Transaction failure rolls back a half reservation; concurrent identical submissions converge to one authorization
   and one nonce; a real local PGlite filesystem close/reopen preserves exact replay.
8. Hostile input, accessors, Proxies, Symbols, widened keys, and ambient intrinsic replacement execute no caller
   behavior. Public callables, records, errors, status, and receipts are exact and frozen.
9. Public evidence exposes no raw nonce, key, tag, authorization body, locator, native value, host identity, endpoint,
   credential, command, provider content, raw diagnostic, reversible transform, or stack.
10. The store cannot issue, consume, revoke, list, or look up authorizations and cannot import/modify LIVE-330, retrieve
    or invoke a native source, inspect a descriptor, read host material, create an observation/attestation/candidate,
    open a listener, or grant owner/runtime/provider/deployment authority.
11. No application, API, worker, scheduler, Idea Lab, Hermes, startup, or runtime module consumes the store. The only
    production import is the safe barrel, and all source/native/effect totals remain zero with all grants false.
12. Cleanup removes the exact disposable root and verifies absence with no dependency/build/review residue.

## Fixed 14-command sequence

Use a fresh local-only disposable clone detached at the exact product and copy prepared dependencies without install or
download. Record the disposable root. Run exactly once and in order:

1. `git status --short`
2. `git rev-parse HEAD`
3. `git rev-parse HEAD^{tree}`
4. `git diff --check fbecc04080c7e471e82328aa4ed52670dbe6dddf df7f981c539b1c7f2826ac62e64f28ff0215554e`
5. `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
6. `npm run check`
7. `npm run lint`
8. `npm run test:cr13a-invocation-authorization-store`
9. `npm run test:cr13a`
10. `npm run build`
11. `node --test tests/rendered-html.test.mjs`
12. `npm run db:verify` using sandbox escalation only for the disposable verifier's local `tsx` IPC socket
13. `git status --short`
14. `git diff --check fbecc04080c7e471e82328aa4ed52670dbe6dddf df7f981c539b1c7f2826ac62e64f28ff0215554e`

After command 14, remove only the recorded disposable root and verify that exact path is absent. Command 12 permits
only local temporary IPC and PGlite; it does not permit a real PostgreSQL service, network, or production contact.

## Required disposition

Report High, Medium, and Low findings separately. Acceptance requires all twelve groups and fourteen commands to pass
once, exact identities, exactly five changed paths, 0 High/Medium/Low, 14/14 focused tests, 364/364 CR13A tests,
5/5 build stages, 4/4 rendered routes, 37 migrations/122 PGlite tables, zero issuance/consumption/revocation/lookup/
invocation/native-read/observation/attestation/candidate/listener/network/provider/external effects, clean status and
diffs, and verified cleanup.

Acceptance permits ordinary integration of this exact inert registration store only. It grants no production key or
database use, trusted-current-time authority, authorization issuance/consumption/revocation, source lookup/invocation,
descriptor/process/OS/host/path read, observation, attestation, candidate, owner approval, listener, physical
qualification, runtime activation, provider, deployment, blocker clearance, or production authority.
