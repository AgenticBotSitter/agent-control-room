# CR14B private project application acceptance

Date: 2026-09-04. **Accepted for the mounted ordinary-project code path and in-process compiled integration.**
The full B-WIRE and CR14B private-pilot exits remain incomplete.

Base: `962b7cb7078e120ca2070c7aea5c4d71aac70bdc` (foundation PR #280).
Original reviewed product: `579647788023091bb939d6c5b7b91ae3ae02ea21`.
Accepted correction: `d0858a5eea7f04e600e8d80d429696c87bae394e`.
Accepted tree: `90be4edf28d12be0df8c2a81651b5d4250b9c9f6`.
Branch: `codex/cr14b-private-application-wiring`.
Publication: [PR #281](https://github.com/MarvinAi5/control-room/pull/281), stacked on PR #280; no merge claimed.

## Delivered

- A separate private route tree for project catalog, creation, Overview, Settings and session management.
  Ordinary projects have individual pages and normal browser-tab links; archive retains discoverable history.
- One server-owned process composition connects the compiled handler to the reviewed SQL service and shared
  Access verification for pages, APIs and finite project snapshots. It has explicit pool-drain ownership.
- Demand-driven bounded public-key refresh, exact-origin writes, bounded JSON input, fixed errors and
  unavailable states. Expired-session responses and cross-application logout scope are handled explicitly.
- Client-side refresh on focus/while visible, newest-read ordering, expected-version writes and explicit
  same-command retry after an uncertain save. No automatic command resubmission or durable browser restart
  recovery is claimed.
- The existing Sites/local-pilot route tree remains separate. The private application never substitutes its
  fixture APIs, caller identity headers or sample records. The project UI draft is retired before any worker
  claim; the other three draft packets remain undispatched.
- CI now includes the private compiled-handler checks and architect PRs stacked on `codex/**`.

The server runtime entry is an explicit composition interface, not a deployment bootstrap. Without its
configuration, private dynamic requests still return 503. See `CR14B_PRIVATE_APPLICATION_WIRING.md` for the
exact behavior and boundaries. No dependency, lockfile, migration, native driver or hosting binding changed.

## Verification actually observed

| Check | Result |
|---|---|
| Dependency-free macOS stage zero | Ready; no installation |
| Focused CR14B source tests | 41/41 passed, also independently observed |
| Registered main test command at the correction | 468 tests: 466 passed, 2 Windows-only skips, 0 failed |
| TypeScript and full repository lint | Passed |
| Installed Node/Vinext builder after correction | All five phases passed |
| Default Sites installed builder during this block | All five phases passed; profile preserved |
| Compiled artifact tests after correction | 3 private Node + 4 Sites render checks passed; independently repeated |
| Disposable PGlite migrations during this block | 0001-0039, 127 tables; no new migration |
| Whitespace and exact product checkout | Passed / clean |

The focused tests are included in the main-suite count, not additional unique tests. Local pretest/posttest
scripts were not run. GitHub's full lifecycle is a separate check; consult the current PR result for its exact
head rather than importing an earlier run. Both builds used installed Vite without automatic CLI upgrades
or a physical listener. Existing dynamic-import/middleware warnings were nonblocking.

The initial product `579647788023091bb939d6c5b7b91ae3ae02ea21` passed GitHub's full CI in
[run 33936877241](https://github.com/MarvinAi5/control-room/actions/runs/33936877241). That historical result
does not cover the later review correction; its exact-head CI remains a separate PR integration requirement.

Compiled tests inject test assertions and public keys into an explicitly installed process with disposable
PGlite, then call the actual built request handler. They verify saved project creation/read, private rendering,
legacy-route rejection, a finite snapshot and shared logout revocation. They do not prove browser hydration,
click behavior, edge cookies/TLS, static serving by a listener, or cross-process PostgreSQL concurrency.

## Review and remaining work

`reviews/CR14B_WIRE_INITIAL_REVIEW.md` preserves two Medium and one Low findings. The accepted independent
re-review in `reviews/CR14B_WIRE_REREVIEW.md` closes all three against the exact correction above. The later
acceptance/status/decision-log commit is documentation only and does not change that reviewed product.

**Next: remaining B-WIRE project integration, Astra Xhigh (`gpt-6-astra`, `xhigh`).** Compose the authenticated
owner-only Idea-project projection and combined catalog pagination without converting Idea records into
manual projects or bypassing their integrity history. Finish private connection presentation and define the
bounded deployment bootstrap/preparation boundary before live setup. Jobs/agents and review are CR14C/D work.

Actual IdP/MFA, private ingress, database roles, real PostgreSQL rehearsal/restore, listener/static/shutdown
and owner browser rehearsal, and private VPS deployment remain separately gated. No credentials, native
key store, provider/agent invocation, persistent host service, database provisioning or deployment was used.
