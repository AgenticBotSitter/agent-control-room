# CR14B private Node serving acceptance

Date: 2026-09-05. **Accepted for repository serving code and in-process compiled integration.**
This does not complete real database rehearsal, deployed B-WIRE or the private-pilot exit.

- Base: `0c520fbe2a9b13199ac19b93236726054bcbd47e` (PR #284).
- Rejected initial product: `61845c45ca2b98fda110117258389af832493863`.
- Accepted product: `070a1405a0441ca1225271d6a1d74773df29c3e0`.
- Accepted tree: `4aacfed5b2372589202de4cfb1740fd42cc722c3`.
- Branch: `codex/cr14b-private-node-serving`.
- Publication: [PR #285](https://github.com/MarvinAi5/control-room/pull/285), stacked on #284.

## Delivered

The private build now exports an inert serving entry. Its explicit service owns the reviewed application's
lifecycle, a fixed loopback HTTP/1.1 factory, bounded request/stream handling and an immutable client-asset
snapshot. Host/peer/framing/body limits precede application dispatch; the existing signature/session/SQL
authority still protects pages and APIs. No forwarded-origin, cookie identity or sample fallback is added.

The bridge handles GET/HEAD/POST, bounded backpressure, disconnect/late response disposal, admission/drain,
terminal bind/close uncertainty and no command retries. It serves only fixed compiled browser assets, not
request-chosen filesystem paths or server intermediates. The compiled SQL integration creates/reads a project,
renders its page, resolves its JS/CSS asset references, exercises HEAD and verifies logout denial.
See `CR14B_PRIVATE_SERVING_CONTRACT.md` for ownership, limits, response exceptions and operator composition.

## Observed verification

| Check | Result |
|---|---|
| macOS stage zero | Ready; no install |
| Final focused CR14B | 115/115 passed |
| Final pretest script | 769/769 passed |
| Final main script | 542 total, 540 passed, 2 existing Windows-only skips |
| Final posttest script | 392/392 passed |
| TypeScript, full lint, cumulative whitespace | Passed |
| Private VPS production build + compiled checks | Passed; 7/7 checks |
| Preserved Sites production build + rendered checks | Passed; 4/4 checks |
| Disposable PGlite migrations | 0001–0040, 127 tables |
| Independent re-review | 25/25 focused; no remaining findings |

The full pretest/main/posttest scripts were run sequentially with installed Node/tsx, not through a package
manager install. Focused counts overlap. Builds used installed Vite, with no upgrade or prerender listener.
The preserved Sites build/migrations were verified before the HTTP-only review correction; the corrected
private artifact and full lifecycle were rerun. Existing framework/build warnings are nonblocking.
GitHub current-head checks are separate and remain required before integration. No merge is claimed.

## Preserve the initial rejection and limits

The first candidate passed current focused checks but failed the old native-authority source inventory
(391/392 posttests). Independent review rejected that gap and three Low ownership/cleanup/header claims.
The correction explicitly inventories the new HTTP authority, preserves the old allowlist, fixes the lifecycle
behavior and obtains independent re-review. Retain both reports in `reviews/CR14B_PRIVATE_SERVING_*`.

Tests use in-memory Node streams, fake server callbacks, disposable asset directories and PGlite; startup's
documented TEMP metadata injection is unchanged. No physical listener or server socket, real PostgreSQL,
live credentials, provider/agent, native qualification, browser, DNS/IdP/MFA, deployment or merge occurred.
Node-generated pre-handler timeout responses and OS absence/real ingress remain separate rehearsal evidence.
Current merge approvals and live-effect gates are unchanged; no self-approved release is inferred.

**Next: CR14B disposable PostgreSQL rehearsal tooling, Astra Xhigh (`gpt-6-astra`, `xhigh`).**
Build/review the bounded executable workload and exact preparation/cleanup handoff; do not run a real DB,
listener, provisioning, credential or deployment effect without the corresponding scoped authority.
