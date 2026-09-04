# CR13A-LIVE-260 independent review packet

**Review mode:** different independent report-only zero-repair review
**Immutable product:** `01bfa6540cc83dc6099564e4fc9043be4cafddc6`
**Product tree:** `ba38ffc47c46400cf3a8840af49b980d753a2556`
**Design parent:** `a0bd538b0d398ec1fd01d3b2b124cdaa8495cea8`
**Accepted LIVE-250 product:** `9b855d4193837fdf6d0d0fce1dcfd65a94cce49f`
**Accepted LIVE-250 review SHA-256:**
`2dcb825f522345c214064ded31134e00fecbfee9aa2121a65d507398081eaca6`
**Required model/effort:** `gpt-5.6-sol`, `xhigh`
**Permitted effects:** none

## Scope and fixed commands

Review only `package.json`, the safe barrel, the composition-shell contract module, and its dedicated test. Read the
LIVE-260 architecture, ADR-177, exact product, accepted LIVE-250 report, and directly imported security helpers before
the fixed sequence. Use a fresh local-only detached clone with copied prepared dependencies. Do not install, download,
modify, repair, create executable review code, import or modify LIVE-220/LIVE-240, implement a shell or bridge, retrieve
or invoke the real factory, import or patch native code, or contact an external system.

Run exactly once and in order:

```text
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
git diff --check a0bd538b0d398ec1fd01d3b2b124cdaa8495cea8..01bfa6540cc83dc6099564e4fc9043be4cafddc6
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
npm run check
npm run lint
npm run test:cr13a-native-composition-shell-contract
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

1. Exact LIVE-250 product and accepted-review bindings and exact product, tree, and design parent.
2. All fourteen call-graph steps, seven failure classes, eight custody rules, six restart rules, eight privacy rules,
   and seven blockers.
3. Exact call order from no-input private entry through accepted identity, module-owned identity, durable authority and
   uncertainty, consume-before-lookup, direct lexical handoff, separately recorded receipt and invocation, custody,
   adapter transfer, close, and durable no-reopen reconciliation.
4. Ceilings of one for shell entry, bridge consumption, factory lookup, receipt, invocation, native construction,
   listener attempt, locator observation, adapter acceptance, transfer, close, independent observation, tombstone,
   and checkpoint.
5. Factory receipt does not prove invocation; invocation does not prove resource creation; post-lookup uncertainty is
   ambiguous and restart cannot retrieve, invoke, replace, or reopen.
6. Continuous exact-object custody before accepted transfer, issuer retention on adapter rejection, unresolved owner on
   uncertain acceptance, and close authority held only by the exact current owner.
7. Same-source-module lexical privacy, no public shell/bridge/getter/callback/caller dependency, no factory or resource
   return/export/serialization/log/digest, and no native diagnostics or protected values in evidence.
8. Exact provenance, frozen surfaces, safe errors, hostile inputs, accessor/Proxy rejection, and post-import ambient
   replacement including `globalThis.Object`, all with zero behavior execution.
9. No import or modification of LIVE-220/LIVE-240, no native/effect import, no shell/bridge/factory implementation or
   callable, and no runtime consumer other than the safe barrel.
10. Exactly twenty zero actual totals, false wiring/effect/eligibility/blocker claims, and all eight authority grants
    false in both the fixed contract and public status.

Record identities, all command results, High/Medium/Low findings, initial/final clean status, cleanup/absence evidence,
source importer/consumer lists, namespace callable names, hostile and ambient counts, all set memberships and ceilings,
and every forbidden value. Acceptance requires 0 High/Medium/Low and every forbidden value zero or false.

Acceptance grants an inert composition-shell contract only. It does not authorize implementing the shell or bridge,
modifying or retrieving LIVE-220/LIVE-240, making the factory reachable, invoking it, constructing or retaining a native
resource, observing a locator, accepting an adapter handoff, opening a listener, issuing/spending live authority,
physical qualification, runtime wiring, provider contact, deployment, blocker clearance, or production authority.
