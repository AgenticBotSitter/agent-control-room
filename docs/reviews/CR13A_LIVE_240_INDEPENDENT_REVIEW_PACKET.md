# CR13A-LIVE-240 independent review packet

**Review mode:** different independent report-only zero-repair review
**Immutable product:** `b0652b15a944fd51511ab1218c628c5fa347961c`
**Product tree:** `4a105b809c24c6115c0d02bf6685ed26b2f66ea2`
**Design parent:** `3f5f84a4bddd4dd29baed0ef1c766daa2a795585`
**Accepted LIVE-230 product:** `3974f165f106cb0fe616b2f0e91a18e45b1b4c2d`
**Accepted LIVE-230 review SHA-256:**
`eb6957f2f577b77ce7c68fb2f8e92e80004a987e3fa83ba1bdee993f6f59d58a`
**Required model/effort:** `gpt-5.6-sol`, `xhigh`
**Permitted effects:** none

## Scope and fixed commands

Review only `package.json`, the safe barrel, the composition-implementation module, and its dedicated test. Read the
LIVE-240 architecture, ADR-175, exact product, and directly imported security helpers before the fixed sequence. Use a
fresh local-only detached clone with copied prepared dependencies. Do not install, download, modify, repair, create
executable review code, import or consume LIVE-220 or LIVE-190, invoke or patch native code, or contact an external
system.

Run exactly once and in order:

```text
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
git diff --check 3f5f84a4bddd4dd29baed0ef1c766daa2a795585..b0652b15a944fd51511ab1218c628c5fa347961c
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
npm run check
npm run lint
npm run test:cr13a-native-issuer-composition-implementation
npm run build
node --test tests/rendered-html.test.mjs
node --import tsx scripts/verify-migrations.ts
git status --short
```

After the sequence, only disposable cleanup and exact absence verification are allowed. No further inspection, broader
suite, generated program, retry, substitution, fallback, repair, or native effect is permitted. Stop, clean up, and
reject on failure or uncertainty.

## Required review groups

Report separately: exact LIVE-230 product/review binding; six scenarios and eight states; all twelve one-use ceilings;
durable claim/locator-spend/custody-spend/uncertainty order before factory retrieval; exact-resource construction,
retention, locator observation, custody, adapter offer, atomic transfer, and close counts; definite pre-effect rejection;
post-marker ambiguity; adapter rejection with issuer cleanup; uncertain acceptance without guessed ownership; cleanup
failure with observation-only recovery; serialized promise identity; exact provenance, frozen surfaces, safe errors,
hostile values/receivers and ambient replacements with zero behavior; safe public privacy; no native/effect/LIVE-220/
LIVE-190 import or runtime consumer; and exact zero real-effect/false-authority totals.

Record identities, all command results, High/Medium/Low findings, initial/final clean status, cleanup/absence evidence,
source importer/consumer lists, hostile and ambient counts, all scenario/state memberships and ceilings, per-scenario
operation counts, custody owner and cleanup outcomes, and every host, port, factory, resource, listener, close, locator,
capability, adapter, driver, persistence, timer, network, protected-read, wiring, external-effect, blocker, and authority
value. Acceptance requires 0 High/Medium/Low and every forbidden value zero or false.

Acceptance grants ordinary integration of the exact unreachable fake-tested composition only. It does not authorize
retrieving or invoking LIVE-220, using a real resource or locator, calling LIVE-190 or a driver, writing live persistence,
physical qualification, runtime wiring, provider contact, deployment, blocker clearance, or production authority.
