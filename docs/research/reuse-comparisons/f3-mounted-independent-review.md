# Independent review: F3 mounted follow-up

2026-09-08. Reviewer scope: source and saved evidence only. No downloads, browsers,
services, installations or reruns. Inspected mounted server/UI/types, final JSON,
fit dossier, acquisition ledger, actual `tests/helpers/web-foundation.ts`, project
browser client and protected HTTP/service seams. This is not an independent browser
execution or a live authentication qualification.

## Conclusion

**Accept the narrow component-mount/protected-project-read evidence conditionally;
one P2 test-fidelity repair is needed before treating the late-success-after-expiry
case as deterministically proved.** No production vulnerability identified. The
recommendation to combine small components instead of adopt a whole app is supported
at the declared narrow scope. Full F3 completion is correctly withheld.

## Finding F3-MR-01 — P2: held response is not positively acknowledged

`research/reuse-comparisons/f3-mounted-ui.tsx` starts `old=refresh()` after the fixture
hold toggle, sleeps40ms, then expires auth and issues the second read. The fixture
server captures whatever protected request reaches its hold branch next, but exposes
no held-response acknowledgement, status or request ID. The saved receipt records
only a total7 reads; it does not prove the held response was a successful pre-expiry
catalog response before the denial was exercised.

With a slow request or database scheduling, expiry can happen before the first request
is handled, so the held reply could itself be401. The final no-resurrection assertion
would then pass without testing that old private labels are actually prevented from
returning. Different request ordering can also hold the second read and hang until
the browser client's10s timeout. The generation fence itself looks correct in source;
the problem is proving the intended adversarial sequence reproducibly.

Required repair: fixture assigns request IDs and reports `held:{requestId,status:200,
projectCount:2}` only after real handler completes; await that bounded acknowledgement
instead of sleeping. Assert exact expired request returns401 and releases the captured
successful request afterward. Include those sanitized facts in receipt and rerun the
mounted scenario. If run unavailable, downgrade only this case to source-reviewed /
unverified ordering; do not discard other mounted evidence.

## Boundary/fidelity assessment

- Actual `createProjectBrowserClient.list()` is bundled and performs HTTP, then the
  server invokes real `createProjectHttpHandler`, Access verifier and database-backed
  `WebProjectService.listPage`. Test helper signs real disposable RSA assertions and
  bootstraps only a synthetic owner. This supports the stated E3 read seam.
- The server *supplies* assertions; browser does not authenticate via Cloudflare.
  Fixed clock with expired signed claim tests verifier rejection, not real cookie
  expiry/logout/Cloudflare redirect. The dossier discloses this appropriately.
- Composite identity, cache clearing and stale-generation fences are research glue,
  not evidence upstream apps supplied these features. The dossier correctly says so.
- Auth rejection clears projects, map, close selection and selected identity in code.
  Tests inspect map/selection and absence of Project A. Stronger optional assertions
  should also inspect Project B and WebUI scoped S; current source clears both but
  the final receipt alone does not separately exercise every hidden-cache condition.
- `controlJobs:0` verifies no canonical jobs appeared; no actual native work exists.
  Keeping `loading:true` after close proves only the synthetic record was not mutated.
  It cannot qualify close-versus-native-cancel behavior, correctly left outstanding.

## Keyboard, mobile and presentation claims

The actual browser-focus test proves Desktop div is not focusable and WebUI button is
focusable. It does not test Tab order, arrow keys, Enter/Space activation, ARIA selected
state or screen-reader navigation. The dossier explicitly withholds complete keyboard
and mobile/CSS acceptance; no claim reduction required. Decorative icon/avatar/loading
dependencies and upstream CSS were removed, so visual parity and loading semantics
are not established. Prefer preserving these boundaries in implementation packets.

## Cleanup and reproducibility

Server binds literal loopback, validates Host/Origin, caps report input, uses one
synthetic PGlite fixture, self-closes at4minutes and handles SIGINT/SIGTERM. Owned
database close is explicit. Initial setup exceptions before signal/timer registration
are not covered by a top-level finally; process exit normally releases in-memory DB,
but robust fixture future work should install cleanup ownership immediately after
acquisition. No production or persistent DB is used.

Saved acquisition ledger reports both terminal handles, database close, no listeners
and exact-root/tab cleanup. This review did not independently re-observe those past
handles; cleanup is supported by the execution record, not newly verified here.
Source SHA checks and real fragments support reproducibility. Receipt lacks source
hash/browser version/run-ID fields; adding them is useful evidence hardening, not
required to call the current narrow mount real.

## Decision review

Desktop controlled strip offers real reusable rendering; WebUI's action factory is
small and less advantageous in existing React UI. No whole-app winner, performance
ranking, RAM advantage or deleted production lines is claimed. Shared development
bundle size is explicitly not production payload. These conclusions are proportionate.
F3-MR-01 needs disposition and recheck before late-success race is accepted; all
remaining transcript/mobile/grouping/native-registration comparisons remain open.

## F3-MR-01 recheck — resolved for the narrow race scenario

Same reviewer, source+saved receipt only; no independent runtime rerun.
Inspected corrected `f3-mounted-server.mjs`, `f3-mounted-ui.tsx` and
`f3-mounted-race-evidence.json`. Server now assigns a request ID before awaiting the
handler, captures the hold flag for that request and publishes held metadata only
after actual response bytes/status exist. UI waits on bounded acknowledgement,
asserts200/two projects, then expires auth. It verifies the immediately following
request is401 before releasing the exact held ID. Server rejects mismatched release
IDs and records the prior completed request status. Both project labels are checked
absent after denial and after old request settles.

Saved17-check receipt records held request4=200/two projects, subsequent request5=401,
and release4 after request5/401. This specifically closes the earlier possibility of
passing with an already-denied held response. **F3-MR-01 resolved**; accept this local
late-success-after-expiry evidence at its documented synthetic-browser boundary.
No outstanding blocking finding in the selected mounted-component scope. Broader
mobile/full keyboard/native-registration/production-auth gates remain unchanged.
