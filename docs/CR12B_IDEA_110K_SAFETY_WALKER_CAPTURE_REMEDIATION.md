# CR12B-IDEA-110K — shared safety-walker capture remediation

**Status:** Provider-disabled implementation candidate frozen at
`2aa4f8e0dce52045100a2a10394d86bb934df93e`; fresh independent review is mandatory.

**Replacement review packet:** `docs/reviews/CR12B_IDEA_110K_SAFETY_WALKER_CAPTURE_REVIEW_PACKET.md` at SHA-256
`8a5d2f18615f796dcedef27dc004e7720aa26c18a337e8592d24d93cc4f72296`.

## Why IDEA-110J remained rejected

Independent review of exact IDEA-110J product `5707ecb05221e708beefa196fc0fa2e0c9d8515d` confirmed that the
ambient-Set path was closed, then reproduced a High bypass in the shared no-secret and safe-projection walkers. Replacing
post-import `Object.entries` with a function returning an empty list executed twice and made both walkers retain a
secret-bearing value. The durable report is
`docs/reviews/CR12B_IDEA_110J_HOST_OPERATION_CAPTURE_REVIEW_REV_001.md`.

## Structural repair

IDEA-110K freezes the safety traversal itself:

- secret detection captures array identification, object entries, regular-expression test, Reflect apply, array append
  and join, object definition, and native Error construction at module initialization;
- secret and redaction recursion use direct indexed loops rather than `forEach`, `some`, `map`, `for...of`, or
  `Object.fromEntries`;
- safe projection captures array identification, object entries, regular-expression test/replace, string lowercase and
  includes, Reflect apply, and native Error construction;
- projection recursion and forbidden-pattern/key scans use direct indexed loops, while key normalization invokes the
  captured RegExp replace method directly and never dynamically resolves `Symbol.replace`;
- the shared Idea Lab exact parser already uses captured object/array/number operations and now also invokes its captured
  RegExp test when classifying a safety rejection.

Four new regressions cover both layers and both directions. Direct redaction and projection tests replace their former
ambient helpers, retain the exact rejection/redaction result, and never execute a hostile replacement. An exact
connector prompt containing a secret is rejected before private prompt dispatch. A provider-result secret is rejected,
then the same bridge completes the mandatory interrupt/status/session-close/route-close cleanup while traversal globals
remain replaced.

## Authority boundary

This remediation configures no port, signer, route, native or SSH attempt, provider call, credential access, live-panel
permission, production database, deployment, hosting, or DNS effect. Fresh independent review of the exact product
commit and replacement packet is mandatory; acceptance may remove only the provider-disabled connector implementation
review gate.

## Producer verification

- CR12B focused suite: 163/163 passed;
- repository preparation suite: 769/769 passed;
- core suite: 416 passed, zero failed, and two intentional platform skips out of 418;
- repository post-test suite: 242/242 passed;
- TypeScript, full lint, production build, 3/3 sequential rendered routes, all 32 migrations/110 PostgreSQL tables,
  macOS stage zero, and whitespace validation passed.

These are producer checks, not review acceptance.
