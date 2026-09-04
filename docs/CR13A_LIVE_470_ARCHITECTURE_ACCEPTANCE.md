# CR13A-LIVE-470 architecture acceptance

**Disposition:** accepted for architecture-only integration

**Design:** `docs/CR13A_LIVE_470_PRODUCTION_CAPSULE_OWNER_NATIVE_AUTHORIZATION_DESIGN.md`

**Design SHA-256:** `29980084a8d0fd1839a79e0f5402cc0f2038179bdecadd666295bd090497f7c4`

**Independent review:** `docs/reviews/CR13A_LIVE_470_ARCHITECTURE_REVIEW.md`

**Independent review SHA-256:** `252e5f80eaca7bf78d98d50601c3472f74e73e4cd8ee1879f5fa53c8ab0dad1f`

**Final findings:** High 0; Medium 0; Low 0

## Accepted result

The production construction boundary and the separate owner-native authorization boundary are now fully specified.
The production capsule remains a private lexical graph inside the accepted LIVE-440 source-owning module, takes no
caller dependencies, and preserves source lookup, invocation, raw validation, intake, transformation, and release in
one unbroken lexical path.

An out-of-band owner-root pin authenticates independently anchored trust-registry and deployment-manifest chains. A
strict owner body binds both authorizations, exact products, keys, subjects, private destinations, reservation intents,
time relationships, and every permitted operation. Exact append-only PostgreSQL tables close owner consumption and
the product-pair attempt atomically; an independent composite owner-attempt anchor detects whole-database rollback.
Any consumption uncertainty burns the product pair and can only be reconciled to terminal evidence, never execution.

One fixed parent creates one disposable child and exchanges one bounded authenticated frame in each direction. The
child owns stages 1-31 and exits. Parent-side cleanup and finalization own stages 32-35; a different report-only review
owns stage 36. All terminal paths use one closed public schema and expose no private authorization, host, provider,
anchor, process, or diagnostic content.

The first review's 5 High and 4 Medium findings are closed. The different re-review passed with 0 High, 0 Medium, and
0 Low. All work was documentation-only and performed zero key, database, anchor, source/provider, host, process,
network, native, runtime, or external effects.

## Next safe block

CR13A-LIVE-480 may implement only the inert owner-native authorization vocabulary: exact body/envelope, reservation-
intent, operation-budget, terminal-outcome, status/authority, and hostile parser contracts plus deterministic tests.
It must report zero actual effects and false execution grants. It must stop before issuer/store/migration/key/manifest/
trust/anchor/context/capsule/provider/source/IPC/process/database/runtime/native/deployment implementation or use.

This acceptance grants no protected implementation or production authority.
