# CR13A-LIVE-280 independent rereview packet

**Review type:** different fresh independent, report-only, zero-repair
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Unchanged product:** `c1743b7f7b5c8362cec3d33b149e3f51c5e5fda6`
**Product tree:** `2dc81b05566c5c9bb3adc3657f597c2d596d2b14`
**Design parent:** `f23be84ef28d1dd6e24eff42194f6727635f5a53`
**Original packet SHA-256:** `582a03e6349e5684c6dc4e12646a125888f6de580c262f3c811da4c37aeac6a8`
**Preserved negative report:** `docs/reviews/CR13A_LIVE_280_INDEPENDENT_REVIEW.md`

## Why a corrected protocol is required

The first reviewer found no source or security defect and passed all twelve inspection groups, 10/10 focused tests,
and 286/286 CR13A tests. The sequence failed only because `npm run test:build` nested a pnpm call that rejected the
relocated copied dependency metadata, and the sandbox denied the local temporary IPC socket used by the migration
verifier. The reviewer did not retry or repair and cannot conduct this rereview.

This packet changes no product byte. It splits production build and rendered-page verification into direct portable
commands and explicitly permits command 12 to run outside the sandbox solely for tsx's local temporary IPC socket. It
does not permit network access, production database contact, install, download, native listener behavior, provider
contact, or any other effect.

## Authority and stop boundary

Use a different reviewer and a fresh local-only disposable clone detached at the unchanged exact product. Copy the
prepared dependency tree without installation or download. Perform the same twelve inspection groups in the original
packet. Make no product, packet, dependency, or shared-repository edit. Do not generate review code. Do not retrieve or
invoke the private shell, import the native issuer, assemble a candidate, create owner authority, contact a provider,
open a listener, observe a locator, create a resource, or perform any external action.

Run each fixed command below exactly once and in order. A failure rejects the unchanged product for this protocol; do
not retry, repair, substitute, or broaden. Command 12 may use the execution tool's sandbox escalation only to allow the
local tsx IPC socket. Its database target remains the disposable in-process PGlite verifier; it must not contact a real
or production PostgreSQL service.

## Fixed corrected 14-command sequence

1. `git status --short`
2. `git rev-parse HEAD`
3. `git rev-parse HEAD^{tree}`
4. `git diff --check f23be84ef28d1dd6e24eff42194f6727635f5a53 c1743b7f7b5c8362cec3d33b149e3f51c5e5fda6`
5. `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
6. `npm run check`
7. `npm run lint`
8. `npm run test:cr13a-physical-qualification-candidate-contract`
9. `npm run test:cr13a`
10. `npm run build`
11. `node --test tests/rendered-html.test.mjs`
12. `npm run db:verify` using sandbox escalation only for local temporary IPC
13. `git status --short`
14. `git diff --check f23be84ef28d1dd6e24eff42194f6727635f5a53 c1743b7f7b5c8362cec3d33b149e3f51c5e5fda6`

After command 14, remove only the recorded disposable root and verify that exact path is absent. Report the cleanup
check separately; it is not an opportunity to rerun a failed product command.

## Required disposition

Report High, Medium, and Low findings separately. Acceptance requires exact unchanged identities, all original twelve
inspection groups passing, all fourteen corrected commands passing once, 0 High/Medium/Low, zero hostile behavior,
zero external effects, clean initial/final status, and verified cleanup. Preserve the first negative report unchanged.

Acceptance permits ordinary integration of the unchanged inert repository contract only. It grants no real-provider,
candidate, owner-authorization, native, physical-qualification, runtime, deployment, blocker-clearance, or production
authority.
