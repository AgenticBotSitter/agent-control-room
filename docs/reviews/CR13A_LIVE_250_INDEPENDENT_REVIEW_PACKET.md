# CR13A-LIVE-250 independent review packet

**Review mode:** different independent report-only zero-repair review
**Immutable product:** `9b855d4193837fdf6d0d0fce1dcfd65a94cce49f`
**Product tree:** `b9829f61fc9b10c5566f3871c8db3ce603df6ac2`
**Design parent:** `fa76bad664269de8eb35debca30f65786e5c1c51`
**Accepted LIVE-220 product:** `2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9`
**Accepted LIVE-220 review SHA-256:**
`4ced5f64ebe99bd63b3bc68295a821f0b391126630206335dd9cabf698072d30`
**Accepted LIVE-240 product:** `71e4c737b6e681fe24d730decc3497d196cf441c`
**Accepted LIVE-240 review SHA-256:**
`1d552ac7d580d6996b5192139dee85beb4f15e1058cf2c19719e9424f82f00f8`
**Required model/effort:** `gpt-5.6-sol`, `xhigh`
**Permitted effects:** none

## Scope and fixed commands

Review only `package.json`, the safe barrel, the retrieval-bridge contract module, and its dedicated test. Read the
LIVE-250 architecture, ADR-176, exact product, and directly imported security helpers before the fixed sequence. Use a
fresh local-only detached clone with copied prepared dependencies. Do not install, download, modify, repair, create
executable review code, import or modify LIVE-220/LIVE-240, retrieve or invoke the real factory, import or patch native
code, or contact an external system.

Run exactly once and in order:

```text
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
git diff --check fa76bad664269de8eb35debca30f65786e5c1c51..9b855d4193837fdf6d0d0fce1dcfd65a94cce49f
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
npm run check
npm run lint
npm run test:cr13a-native-factory-retrieval-bridge-contract
npm run build
node --test tests/rendered-html.test.mjs
node --import tsx scripts/verify-migrations.ts
git status --short
```

After the sequence, only disposable cleanup and exact absence verification are allowed. No further inspection, broader
suite, generated program, retry, substitution, fallback, repair, or native effect is permitted. Stop, clean up, and
reject on failure or uncertainty.

## Required review groups

Report separately:

1. Exact LIVE-220 and LIVE-240 product and accepted-review bindings.
2. All ten prerequisites, nine order steps, five failure classes, eight privacy rules, and six blockers.
3. Exact order: accepted identities, module-owned identities, attempt/epoch/window/expiry, durable claim and both
   spends, and durable uncertainty marker all precede the synchronous private consumption section.
4. Consume-before-lookup behavior and ceilings of one for bridge consumption, private factory lookup, and direct
   private handoff.
5. Definite prerequisite failure, terminal consumed/missing identity failure, post-lookup ambiguity, and restart
   reconciliation without retrieval or retry.
6. Same-source-module-only custody, no public getter or exported retrieval callable, no caller implementation,
   composition, permit, or factory, and no factory return, serialization, logging, or digest.
7. Exact provenance, frozen surfaces, safe errors, hostile inputs, accessor/Proxy rejection, and post-import ambient
   replacement including `globalThis.Object`, all with zero behavior execution.
8. Safe public privacy and honest repository-only blocked status with no factory, resource, locator, capability,
   protected value, native diagnostic, command, prompt, or personal path.
9. No import or modification of LIVE-220/LIVE-240, no new native/effect import, and no runtime consumer other than the
   safe barrel.
10. Exact zero actual bridge, lookup, handoff, return, serialization, log, native, resource, listener, locator, close,
    persistence, timer, network, and protected-read totals; false wiring, effect, eligibility, blocker, and authority.

Record identities, all command results, High/Medium/Low findings, initial/final clean status, cleanup/absence evidence,
source importer/consumer lists, namespace callable names, hostile and ambient counts, all set memberships and ceilings,
and every forbidden value. Acceptance requires 0 High/Medium/Low and every forbidden value zero or false.

Acceptance grants an inert retrieval-bridge contract only. It does not authorize implementing the bridge, modifying or
retrieving LIVE-220, making the factory reachable, invoking it, creating a native resource, observing a locator,
issuing/spending live authority, calling an adapter/driver, physical qualification, runtime wiring, provider contact,
deployment, blocker clearance, or production authority.
