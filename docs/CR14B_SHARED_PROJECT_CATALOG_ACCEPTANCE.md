# CR14B shared private project catalog acceptance

Date: 2026-09-04. **Accepted for shared project reads, pagination and compiled in-process integration.**
Full B-WIRE and the CR14B private-pilot exit remain incomplete.

Base: `59373732f659096fbcf6703fb33848be164bd46e` (PR #281).
Original product: `793b8269c9695e4d38a55d79d6ce7d8b07f06d19`.
Accepted correction: `58f060cb71a4675d35e8adabea01ab521cab260c`.
Accepted tree: `1db68a494ffd3fa69d1bd2b171004c71c30ffde3`.
Branch: `codex/cr14b-shared-project-catalog`.
Publication: [PR #282](https://github.com/MarvinAi5/control-room/pull/282), stacked on #281, which depends on #280.
No merge is claimed; exact-head CI remains an integration prerequisite.

## Delivered

- Ordinary and owner-authorized Idea projects share the private catalog, detail/settings pages and finite
  snapshot reads. The existing Idea registry verifies its projection inside the authorized SQL transaction;
  no Idea record is copied into the manual catalog or given ordinary lifecycle authority.
- Catalog pagination selects 51 IDs and returns at most 50 verified records, with exclusive C-collated
  continuation, source availability, and current access checks on every page. The 211-record mixed test
  traverses five pages without duplicates or omissions.
- Cards identify project origin, archive groups are page-local, and navigation uses normal document links.
  Idea lifecycle remains read-only in this private view. Create and ordinary lifecycle controls reflect
  server-derived permission hints; actual commands still reauthorize.
- Hidden and absent project IDs have the same public response when a reader lacks the hidden source's
  authority. Neither source's permission produces a uniform 403 before lookup. No timing guarantee is claimed.
- Missing Idea configuration, wrong integrity key and inconsistent state never masquerade as an empty
  successfully loaded Idea source. Test material is synthetic; no production key was read or created.

See `CR14B_SHARED_PROJECT_CATALOG.md` for the exact wire, storage, navigation and freshness semantics.
The existing Sites preview is preserved. No dependency, lockfile, migration or hosting binding changed.

## Verification actually observed

| Check | Evidence |
|---|---|
| macOS stage zero | Ready; no installation |
| Focused CR14B at correction | 52/52 passed; independently repeated |
| Registered main command at correction | 479 tests: 477 passed, 2 Windows-only skips, 0 failures |
| TypeScript / full lint / whitespace | Passed |
| Private Node installed builder after correction | All five phases passed |
| Default Sites installed builder during this block | All five phases passed; private-only correction did not change its product source |
| Compiled checks after correction | 3 private Node + 4 Sites render tests passed; reviewer repeated 3 private checks |
| Existing Idea registry/lifecycle/session/local-fake-pilot regressions | 15/15 passed before the web-only correction |
| Disposable migration verifier | 0001-0039; 127 tables; no new migration |

Focused tests are part of the main count, not additional unique tests. Local pretest/posttest scripts were
not run. Both builds used installed Vite without CLI upgrade/prerender/listener behavior. Existing build
warnings were nonblocking. Compiled tests call the actual built handler with disposable PGlite and injected
test authentication; they are not browser clicks/hydration, actual network/static serving or real PostgreSQL
concurrency/restore proof. Separate exact-head GitHub CI is tracked on the PR, not imported from prior runs.

## Review and next block

The initial independent review found one Medium response-distinction disclosure. The correction and
`reviews/CR14B_SHARED_CATALOG_REREVIEW.md` close it with no remaining findings. The initial report is retained
in `reviews/CR14B_SHARED_CATALOG_INITIAL_REVIEW.md`. The later acceptance/status/ADR commit is documentation
only and does not change the exact reviewed product.

**Next: remaining B-WIRE private connection view and bootstrap preparation, Astra Xhigh
(`gpt-6-astra`, `xhigh`).** Connect the protected current roster presentation, define bounded process/database
ownership and roles, and prepare the scoped setup/rehearsal handoff. No owner action is needed for this
already-scoped repository work; real credentials, services, IdP/MFA, private ingress, database/listener/browser
rehearsals and deployment still need their named setup/authority gates. Live tasks/agents are CR14C/D; private
Idea lifecycle/promotion and real bot conversations remain CR14E integration, not silently enabled here.
