# CR13A-LIVE-190 independent review packet

**Review mode:** different independent report-only zero-repair review
**Immutable product target:** `7d45aae9db4c4012e2be3a072a85f7f4279f4874`
**Product tree:** `cd771b3b090e02a370a6ee2555c2377cf8f2e030`
**Design parent:** `b5f9675e8a6a1007a7fcb04875a384eeb59d8e69`
**Stacked LIVE-180 base:** `5225f0a57ee661d4a865a5ea91148afc6ede4273`
**Accepted LIVE-180 product:** `052afc3b4a61f1c6f1957a567f5305f3a2c5bca0`
**Accepted LIVE-180 review SHA-256:**
`05c4d57ad9f247916102acdc090c071b22a9b7a9623d1984779caf41d8acfd76`
**Required model/effort:** `gpt-5.6-sol`, `xhigh`
**Permitted effects:** none

## Exact scope and commands

Review only `package.json`, the safe connection-registry barrel,
`private-loopback-native-retained-resource-adapter.ts`, its dedicated test, and the narrow source-import assertion change
in `connection-enrollment-private-loopback-physical-native-driver.test.ts`. Read the LIVE-190 boundary, acceptance,
ADR-170, exact product, and directly imported security helpers before starting the fixed command sequence. Use a fresh
local-only detached clone with copied prepared dependencies. Do not install, download, modify, repair, create executable
review code, or contact an external system.

Run exactly once and in order:

```text
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
git diff --check b5f9675e8a6a1007a7fcb04875a384eeb59d8e69..7d45aae9db4c4012e2be3a072a85f7f4279f4874
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
npm run check
npm run lint
node --import tsx --test tests/connection-enrollment-private-loopback-native-retained-resource-adapter.test.ts tests/connection-enrollment-private-loopback-physical-native-driver.test.ts
npm run build
node --test tests/rendered-html.test.mjs
node --import tsx scripts/verify-migrations.ts
git status --short
```

After this sequence, only disposable-root cleanup and exact absence verification are allowed. No further inspection,
broader suite, dynamic test list, `tsx` executable/version probe, `pnpm`, `npx`, generated program, retry, substitution,
fallback, repair, or native effect is permitted. Stop, clean up, and reject on failure or uncertainty.

## Required twelve groups

Report separately:

1. exact LIVE-180 product and accepted-review binding;
2. type-only `node:net.Server` contract and proof of no runtime import;
3. private fake-server identity, continuous custody, one acceptance, and no replacement;
4. four scenarios, seven states, serialized promise identity, and replay without second attempt;
5. exact implementation/status/adapter provenance and cross-adapter status rejection;
6. frozen adapter, methods, records, exported callables, error/prototype, and borrowed receivers;
7. copies, accessors, symbols, Proxies, invalid inputs/order, safe errors, and zero behavior execution;
8. captured intrinsic resistance with zero replacement execution;
9. honest issuer-absent, fake-only, numeric-port-incompatible, blocker-retaining truth;
10. no public resource, locator, address, port, listener, socket, descriptor, handle, capability, protected value, or
    authority;
11. no physical-driver import, native/resource operation, issuer, effect client, or runtime consumer; and
12. exact zero actual effect and authority totals.

Record immutable identities, command results, hostile and ambient attempt/execution counts from committed tests,
High/Medium/Low findings, initial/final clean status, cleanup/absence evidence, executable and type-only `node:net`
importer lists, and every host, port, server/resource, handoff, driver, native, listener, socket, timer, network,
protected-read, wiring, external-effect, and authority count. Acceptance requires 0 High/Medium/Low and every forbidden
count zero.

Acceptance is ordinary integration only. It grants no native issuer/adapter/resource, locator, port, custody, driver
handoff, candidate, physical attempt, blocker clearance, runtime activation, network, provider, or production authority.
