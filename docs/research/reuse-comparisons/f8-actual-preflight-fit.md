# RC8 actual candidate cache and rehearsal fit

2026-09-08, base `af6bcb4` plus root's hash-pinned research fixtures. **Both actual jsonwebtoken9.0.3 and jose6.2.12 preserved the selected cache/rehearsal boundary scenarios: 23 each,46 total.** No production changes, database calls, network requests during tests, provider, credential, listener or Git writes. This closes the candidate-execution gap in those specific fixtures, not security-design acceptance or all async callers.

## Real implementation versus test ports

`research/reuse-comparisons/f8-actual-preflight-fit.mjs` checks hashes for the existing cache source, candidate adapter, key-cache fixture and awaited rehearsal fixture before evaluating them. It imports the existing candidate adapter without changing it. That adapter checks existing selected published package files against the prior16-package integrity ledger before loading actual libraries and checks unchanged verifier source. It retains current CR key/admission/framing/claims policies; standard decoding and signature/claim verification use actual candidate library APIs. jose returns an async verifier; jsonwebtoken remains synchronous inside a deliberately held async test gate.

Actual `src/web/v1/access-key-cache.ts` is transpiled unchanged; its access-verifier import is redirected to the actual candidate-backed module. The13 original cache tests run unchanged except import removal and an in-memory sequential test callback registrar. Nine invalid key/trust conditions test **the retained CR factory admission policy**, not candidate signature code. Four held-load cases exercise actual cache expiration, backwards clock, closed-cache rejection, coalescing and defensive copy behavior. An additional three cases consume an actual cache-produced trust object with each actual candidate: valid token accepted, wrong issuer denied, expired token denied. This prevents claiming library verification merely because a factory was constructed.

The7 existing rehearsal modes execute the original research fixture with only its imported auth module supplied by the candidate adapter and its source URL resolved for the wrapper. The fixture's actual rehearsal source is independently pinned. Its previously reviewed sole product-source adaptation inserts `await` before `createAccessVerifier(...)(...)`. The same held gate, synthetic clock changes and throw-on-open/probe sentinels remain unchanged. Valid reaches exactly one database-open sentinel which immediately throws **before any pool exists**; wrong owner/expired token/abort/elapsed/wall expiry/backwards cases produce zero opens. Every replay returns already_attempted; probes0, realPostgresAccepted false. These are real control-flow boundaries with fake effects, not PostgreSQL or end-to-end owner acceptance.

| Cases per candidate | Result |
| --- | --- |
| Invalid trust: empty, too many, duplicate/empty ID, wrong key type, private material, wrong alg/use, malformed modulus |9 pass; invalid load backoff then valid recovery |
| Held key load: expired, backwards, closed, valid |4 pass; coalescing/copy assertions preserved |
| Cache trust to actual candidate token verification |3 pass; valid, wrong issuer, expired |
| Held rehearsal: valid, wrong owner, expired token, abort, elapsed, wall expired, wall backwards |7 pass; all sentinel/replay assertions preserved |

The first and only execution exited0. No fixture repair or negative result suppressed. `f8-actual-preflight-evidence.json` retains direct parsed stdout and diagnostic. Node emitted its experimental SQLite warning through the existing helper import graph; no SQLite connection, PGlite fixture function or SQL operation was invoked. The test uses VM/module-loader seams, not a security sandbox. Temporary keys and synthetic assertion data stay in process, not receipts. A diagnostic PID was replaced with an owned placeholder.

## Source changes and limitations

No application or root research files changed. The authored wrapper uses the existing pinned adapter's substitutions, the already-reviewed rehearsal await insertion, and import injection. It does not add new freshness policy or claim to fix root's separate bootstrap high-water design. Existing pins and receipt output identify every source seam. No original99 JWT cases repeated; prior semantics/identity-output evidence remains at its exact scope. These scenarios do not prove delayed verification cannot outlive every production request deadline, rollback handling at other call sites, real JWKS/network caching, owner login, deployment, or real database side effects. Root's separate freshness/security review remains authoritative.

Scoped E3: actual candidate libraries through representative current cache and adapted rehearsal control-flow seams. Cache invalid trust tests are retained-policy execution, not independent upstream trust-validation equivalence. No broad safety/security approval follows.

## Decision/cost contribution

Neither candidate showed a new mismatch here. jsonwebtoken can retain sync caller shape; jose needs deliberate awaiting at rehearsal, as already identified, but does not need a cache redesign just to construct its verifier: factory key validation remains synchronous and only the returned token verifier is async. Keep cache backoff/coalescing/expiration and effect preflight policy. Do not remove these controls as duplicate library work. Candidate verification implementation reuse remains reasonable; one maintained token library does not replace application authorization or owner consent.

This experiment supports the existing comparison, not a new winner selected from46 passes. No new dependencies added to the app, upstream patches, database migrations or deleted code. Root must integrate its selected library and review all delayed-caller freshness boundaries separately. License facts/pins remain in `f8-jwt-fit.md` and acquisition ledgers; rootlicenses alone do not clear distribution dependency notices.

## Acquisition, resource and cleanup

139 GiB free before acquisition. Scoped other comparison roots measured227004KiB, well under4GiB aggregate with this cohort. Owned `/private/tmp/cr-f8-jwt.8b8w0O` used1.3MiB including owncache; exact16 prior-version/integrity packages installed with frozen generated research lock, scripts/audit disabled. No app manifest/lock copied or changed. Acquisition receipt retains all16 archiveURLs/integrities, implementation pins and resulting lock hash; post-install identities/integrities matched16/16. Install reported280ms; execution tool reported0.808s, neither is a comparative benchmark. RSS/per-library CPU not measured; don't infer production memory from disk allocation.

Exact owned root removed after terminal receipts; absence check succeeded. No listeners, persistent services or live handles. Research evidence retained; acquired package/cache files removed. Root review required; author has not self-approved.
