# CR13A-LIVE-220 independent review packet

**Review mode:** different independent report-only zero-repair review
**Immutable product:** `2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9`
**Product tree:** `bf01065eec3e66d59fbbb85be9cf792243a89113`
**Design parent:** `09e42eded661d480227325344dd9b2cabfd68b25`
**Accepted LIVE-210 product:** `c4cac41561214117161c9764604f5dc06ecd63b6`
**Accepted LIVE-210 review SHA-256:**
`c25e22dfa2c8601b23547a8a6f32b68d78da23458a696cd9461678ce084ec2c7`
**Required model/effort:** `gpt-5.6-sol`, `xhigh`
**Permitted effects:** none

## Scope and fixed commands

Review only `package.json`, the existing physical-native-driver isolation test, the new quarantined native issuer module,
and its dedicated test. Read the LIVE-220 boundary, acceptance criteria, ADR-173, exact product, and directly imported
security helpers before the fixed sequence. Use a fresh local-only detached clone with copied prepared dependencies. Do
not install, download, modify, repair, create executable review code, invoke or monkey-patch a native primitive, import
the private factory through a generated module, or contact an external system.

Run exactly once and in order:

```text
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
git diff --check 09e42eded661d480227325344dd9b2cabfd68b25..2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
npm run check
npm run lint
node --import tsx --test tests/connection-enrollment-private-loopback-native-retained-resource-issuer-implementation.test.ts tests/connection-enrollment-private-loopback-physical-native-driver.test.ts
npm run build
node --test tests/rendered-html.test.mjs
node --import tsx scripts/verify-migrations.ts
git status --short
```

After the sequence, only disposable cleanup and exact absence verification are allowed. No further inspection, broader
suite, executable probe, `pnpm`, `npx`, generated program, retry, substitution, fallback, repair, or native effect is
permitted. Stop, clean up, and reject on failure or uncertainty.

## Required review groups

Report separately:

1. Exact LIVE-210 product and accepted-review bindings.
2. The exact runtime `node:net` import and five captured primitives, with no post-import ambient resolution.
3. Literal IPv4 loopback, kernel-assigned unobserved private port, one construction, one listen, and one close ceilings.
4. The private no-input factory, retained exact server identity, one-use close, sanitized failure, and no retry/rebind/
   reopen behavior.
5. Module-private factory custody: one private WeakMap set, no retrieval, no export, no safe-barrel exposure, and no
   source consumer.
6. The public construction function fails with `native_issuer_unavailable` before every native call and ignores hostile
   extra arguments without behavior.
7. Exact implementation/status provenance, frozen records/collections/callables, safe errors, hostile parsers, and
   ambient validation replacements with zero behavior execution.
8. No server, listener, socket, resource, locator, address, port, descriptor, handle, callback, capability, protected
   value, raw error, or authority in any public record or export.
9. Honest current truth: code present but unreachable/uninvoked; no locator inspection, resource transfer, claim/spend,
   persistence, runtime wiring, qualification, candidate, activation, or blocker clearance.
10. Native importer allowlist contains only the established physical driver and this isolated issuer; the established
    type-only adapter remains type-only; neither native module has a runtime consumer.
11. Tests use source inspection and disabled public paths only; they do not invoke, patch, substitute, or fake the real
    native factory or any captured primitive.
12. Exact zero actual host, port, resource, capability, driver, persistence, native, listener, close, socket, timer,
    network, protected-read, wiring, external-effect, and authority totals.

Record identities, all command results, High/Medium/Low findings, initial/final clean status, cleanup/absence evidence,
runtime and type-only importer lists, native-authority and consumer lists, hostile and ambient execution counts, and
every forbidden value. Acceptance requires 0 High/Medium/Low and every forbidden value zero or false.

Acceptance grants ordinary integration of unreachable code only. It does not authorize retrieving or invoking the
factory, creating a server, observing or selecting a locator, opening or closing a listener, issuing or spending a
handoff, calling the adapter or driver, making a physical attempt, wiring runtime use, contacting a provider, deploying,
clearing a blocker, or granting production authority.
