# CR14B foundation acceptance

Date: 2026-09-04. **Accepted for repository component/in-process integration; CR14B private pilot is incomplete.**

Baseline: `8b892874594bfb8ddf87a86877ccc535f69c4ad5` (accepted local CR14A).

Original product: `b84dba81a2a6a99233e11524ca2f9f089539cf03`.

Accepted repair: `2de0a4760fe1d5a0f2b39894e2e19ad897486d5f`.

Accepted tree: `f30ed73082ed439a72f7d358c42af9b31f3cda97`.

Branch: `codex/cr14b-runtime-auth-project-foundation`.

## Delivered

- Explicit installed-framework Node build in `dist-vps`, separate from the preserved Sites preview.
- Bounded Access application-assertion verifier, same-origin mutation checks and safe browser return paths.
- Current canonical identity/grant checks, persistent exact-token session revocation and commit-time expiry.
  Public-key freshness is separate from the remembered session lifetime; login never grants an effect approval.
- Ordinary-project catalog/detail/create/lifecycle service and HTTP composition using real SQL transactions.
  Server-selected tenant/workspace, idempotent submissions, version conflicts, audit append and reversible archive.
- Unpublished migration 0039 adds three supplemental tables while retaining existing canonical project/identity
  authority. PGlite-only migration tests ran; no production database was attached or changed.
- The VPS artifact keeps an all-route not-configured response until B-WIRE connects the reviewed services.
  The new API works in the in-process Request/SQL test composition, not in the currently mounted website.

See `CR14B_FOUNDATION_CONTRACT.md` for exact interfaces, limits and remaining wiring.

## Verification actually observed

| Check | Result |
|---|---|
| Dependency-free macOS stage zero | Ready; no install |
| Focused foundation (`node --import tsx --test` over the three `test:cr14b` files) | 22/22 passed |
| Exact registered main test command, directly invoked at accepted repair | 449 tests: 447 passed, 2 Windows-only skips, 0 failed |
| TypeScript `--noEmit` | Passed |
| Full repository ESLint | Passed; generated `dist-vps` output excluded like `dist` |
| `node scripts/build-vps.mjs` | All five installed Vite/Vinext build phases passed |
| Default Sites build via installed Vite builder | All five phases passed; existing configuration preserved |
| `node --test tests/vps-built-handler.test.mjs tests/rendered-html.test.mjs` | 2 compiled Node and 4 Sites render tests passed |
| `node --import tsx scripts/verify-migrations.ts` | Migrations 0001-0039, 127 tables, in disposable PGlite |
| Whitespace / clean product checkout | Passed |

The main suite includes the focused tests, not an additional count of unique tests. Pretest/posttest lifecycle
scripts were not run locally. The default build used the installed builder directly rather than CLI prerender;
neither build started a listener. Compiled output was rebuilt after the build-profile edits; the later repair
changed only the unmounted project service, migration, tests and documentation. The compiled-handler checks
were repeated after the repair. Existing middleware-deprecation/dynamic-import build warnings are nonblocking;
no automatic codemod, dependency upgrade or installation was performed.

## Independent review

`reviews/CR14B_FOUNDATION_INITIAL_REVIEW.md` preserves one Medium logout finding and one Low schema note.
The logout path incorrectly depended on project access, preventing session revocation after access removal.
The repair separates exact-session revocation from project permission and adds seven regression conditions.
The schema repair removes duplicated workspace ownership from manual lifecycle heads.

`reviews/CR14B_FOUNDATION_REREVIEW.md` accepts the exact repair and closes both findings. This acceptance
does not turn pending browser, real PostgreSQL or host evidence into a pass.

## Next and not yet done

**Next block: CR14B B-WIRE, on Astra Xhigh (`gpt-6-astra`, `xhigh`).** Compose the process-owned store and
public-key refresh, shared protected page/API/stream handling, browser login/logout and project UI. Include
combined manual/Idea-project discovery, explicit unavailable states and stream expiry/revocation. Preserve
all four worker capsules as drafts until a reachable reviewed base and coordinated publication make them ready.

Actual IdP/MFA setup, private hostname/ingress, Node listener/startup/shutdown rehearsal, database roles,
real PostgreSQL preparation/restore and deployed private-pilot acceptance are still separate gated work.
No provider credentials, native key store, Hermes/Codex agent invocation, DNS, host service or deployment
was used. GitHub publication/integration state is recorded in `BUILD_STATUS.md`, not implied by local acceptance.
