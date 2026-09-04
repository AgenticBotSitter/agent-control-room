# CR13A-LIVE-240 independent remediation rereview packet

**Review mode:** second different independent report-only zero-repair review
**Rejected product:** `b0652b15a944fd51511ab1218c628c5fa347961c`
**Rejected review SHA-256:** `d0fcec0026033ecff4bad87b8bfb1c232872a03917c23ef6d3f16a3f2ddd4b31`
**Remediated product:** `01e01748c2d9a06ce603caff5d0d0a92d0537fc0`
**Remediated tree:** `cf3eb5fac8e25c8dd08d66b5f38428df7f82121e`
**Remediation parent:** `5bbcec2a53d5bd905c4bc201f5ea1d5984dfe3fa`
**Design parent:** `3f5f84a4bddd4dd29baed0ef1c766daa2a795585`
**Accepted LIVE-230 product:** `3974f165f106cb0fe616b2f0e91a18e45b1b4c2d`
**Accepted LIVE-230 review SHA-256:**
`eb6957f2f577b77ce7c68fb2f8e92e80004a987e3fa83ba1bdee993f6f59d58a`
**Required model/effort:** `gpt-5.6-sol`, `xhigh`
**Permitted effects:** none

## Mandatory findings to close

Reproduce the preserved negative report and decide each finding independently:

1. M-001: the first `run()` must be permanently bound to one already-created promise before execution, and no
   post-import ambient mutation may create a synchronous escape followed by re-execution.
2. M-002: every binding, expiry, claim, marker, custody, adapter, cleanup, absence, tombstone, and checkpoint transition
   must be preserved in a new frozen append-only history while earlier status histories remain unchanged.
3. M-003: exact binding and repository-owned simulated expiry validation must each occur once, in that order, before
   the claim and every spend or factory operation.

Also rerun every original review group. A remediation is not accepted if it closes the named findings but creates any
new High, Medium, or Low issue.

## Fixed commands

Read the architecture, original packet, preserved negative report, remediation diff, exact product, and directly
imported helper before the fixed sequence. Use a fresh local-only detached clone with copied prepared dependencies. Do
not install, download, modify, repair, create executable review code, import or consume LIVE-220 or LIVE-190, invoke or
patch native code, or contact an external system.

Run exactly once and in order:

```text
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
git diff --check 5bbcec2a53d5bd905c4bc201f5ea1d5984dfe3fa..01e01748c2d9a06ce603caff5d0d0a92d0537fc0
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

## Required report

Report the exact identities and packet digest; initial/final status; all command outcomes; cleanup; M-001, M-002, and
M-003 dispositions; any new findings; immutable history order for all six scenarios; earlier-snapshot immutability;
same-promise behavior; post-import ambient execution counts; binding/expiry/claim order and counts; operation ceilings;
custody and cleanup outcomes; importer/consumer lists; privacy; all real-effect totals; and every false-authority value.

Acceptance requires each prior Medium to be closed, no new finding at any severity, every forbidden behavior zero or
false, and exact disposable cleanup. Acceptance grants only ordinary integration of the unreachable fake-tested
composition; it grants no native, persistence, adapter, qualification, wiring, deployment, or production authority.
