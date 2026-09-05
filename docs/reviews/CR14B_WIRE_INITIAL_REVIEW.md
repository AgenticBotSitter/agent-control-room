# CR14B B-WIRE — initial independent review

Date: 2026-09-04. Reviewer: `remaining_gate_audit`, independent of the producing agent.
The producing agent retained this report from the returned review. It is historical negative evidence,
not acceptance of a later correction.

Exact product: `579647788023091bb939d6c5b7b91ae3ae02ea21`.
Tree: `b32bf57f172a719ce85b3b139a62b5c78d16e947`.
Base: `962b7cb7078e120ca2070c7aea5c4d71aac70bdc`.

**Disposition: bounded correction required. 0 High / 2 Medium / 1 Low.**

## CR14B-WIRE-REV-001 — Medium: expired edge-session handling

`src/web/v1/browser-client.ts:21-27` omits `X-Requested-With: XMLHttpRequest`. Access can return an
interactive redirect/HTML instead of 401 when the edge session expires. With `redirect: error`, this
becomes generic unavailable/uncertain rather than the session-ended path. Add the marker to every private
browser API request and test presence plus 401 mapping. The producer also identified this from the primary
documentation during review; it remains a finding against the exact reviewed product.

## CR14B-WIRE-REV-002 — Medium: post-failure backoff

`src/web/v1/access-key-cache.ts:51,69` measures retry-after from load start. A loader that uses the five-second
deadline can immediately retry after failure, contrary to the advertised five-second failure backoff.
Measure from a fail-closed failure-time clock reading and test delayed and timed-out failures.

## CR14B-WIRE-REV-003 — Low: sign-out scope disclosure

The Access logout endpoint ends sessions across applications, not only Control Room. Disclose this before
sign-out in the session UI and contract, keeping local exact-token revocation distinct from Access logout.

## Other results and observed verification

Common page/API/finite-stream verification, logout after authority loss, manual-adapter filtering,
private route separation, no fixture fallback, single-flight/no-stale key handling, browser command
idempotency/read generation and process admission/drain were coherent in the bounded scope.
Remaining Idea integration, pagination, bootstrap, IdP/database/listener rehearsal, deployment and pilot
work were stated truthfully.

Observed: stage zero ready; focused CR14B 37/37; compiled VPS/Sites checks 7/7; TypeScript, focused lint and
whitespace passed. The checkout was clean at the reviewed target. The earlier intermediate commit 6bfbee2
omitted the producer's build-profile edit from staging; 5796477 included it before exact verification.

The reviewer made no edits/builds, browser QA, network, credential, provider, native, listener, production
database, Sites or deployment operations. Tests used the installed deterministic dependencies and previously
built artifacts. The later correction must receive a separately recorded re-review.
