# CR13A-LIVE-230 independent review packet

**Review mode:** different independent report-only zero-repair review
**Immutable product:** `3974f165f106cb0fe616b2f0e91a18e45b1b4c2d`
**Product tree:** `2a2eff5d2a6020ff9e415f0c29e15d940d0bfe34`
**Design parent:** `ee8b52a5ac584be18b4efad6f55bf9b1d282fffa`
**Accepted LIVE-220 product:** `2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9`
**Accepted LIVE-220 review SHA-256:**
`4ced5f64ebe99bd63b3bc68295a821f0b391126630206335dd9cabf698072d30`
**Required model/effort:** `gpt-5.6-sol`, `xhigh`
**Permitted effects:** none

## Scope and fixed commands

Review only `package.json`, the safe barrel, the composition-contract module, and its dedicated test. Read the LIVE-230
architecture, ADR-174, exact product, and directly imported security helpers before the fixed sequence. Use a fresh
local-only detached clone with copied prepared dependencies. Do not install, download, modify, repair, create executable
review code, import or consume LIVE-220, invoke or patch native code, or contact an external system.

Run exactly once and in order:

```text
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
git diff --check ee8b52a5ac584be18b4efad6f55bf9b1d282fffa..3974f165f106cb0fe616b2f0e91a18e45b1b4c2d
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
npm run check
npm run lint
npm run test:cr13a-native-issuer-composition-contract
npm run build
node --test tests/rendered-html.test.mjs
node --import tsx scripts/verify-migrations.ts
git status --short
```

After the sequence, only disposable cleanup and exact absence verification are allowed. No further inspection, broader
suite, generated program, retry, substitution, fallback, repair, or native effect is permitted. Stop, clean up, and
reject on failure or uncertainty.

## Required review groups

Report separately: exact LIVE-220 product/review binding; all 18 bindings, 10 markers, 16 order steps, five failure
classes, 15 proofs, and eight blockers; all seven one-use ceilings; durable claim/spend/uncertainty before factory
retrieval; exact-server custody and atomic transfer; cleanup and no-reopen recovery; exact provenance, frozen surfaces,
safe errors, hostile inputs, and ambient replacements with zero behavior; safe public privacy; honest repository-only
blocked status; no native/effect/LIVE-220 import or runtime consumer; and exact zero effect/false authority totals.

Record identities, all command results, High/Medium/Low findings, initial/final clean status, cleanup/absence evidence,
source importer/consumer lists, hostile and ambient counts, all set memberships and ceilings, and every host, port,
factory, resource, listener, close, locator, capability, adapter, driver, persistence, timer, network, protected-read,
wiring, external-effect, blocker, and authority value. Acceptance requires 0 High/Medium/Low and every forbidden value
zero or false.

Acceptance grants an inert composition contract only. It does not authorize importing or retrieving LIVE-220, invoking
the factory, creating a resource, observing a locator, issuing/spending live authority, calling an adapter/driver,
physical qualification, runtime wiring, provider contact, deployment, blocker clearance, or production authority.
