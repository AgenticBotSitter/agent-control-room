# CR14B private Node serving — initial independent review

Date: 2026-09-05. Reviewer: `cr13a_live290_review`. Architect records the returned review.

- Base: `0c520fbe2a9b13199ac19b93236726054bcbd47e`.
- Rejected product: `61845c45ca2b98fda110117258389af832493863`.
- Tree: `46bf7c062fe21bb4aaae99804604309c9c8af017`.
- Disposition: **REJECTED: 0 High / 1 Medium / 3 Low**.

1. **CR14B-SERVE-REV-001, Medium:** the new `node:http` createServer/listen authority lacks an explicit
   positive source inventory. An incidental Socket type import causes the old `node:net` inventory to fail;
   removing it alone would conceal rather than record the new HTTP authority. Add a separate explicit HTTP
   source-boundary regression while retaining the old custom-listener allowlist and disabled consumers.
2. **REV-002, Low:** owned 417 responses omit the contract's full privacy headers; Node can emit pre-handler
   timeout 408s not covered by these injected tests. Apply owned headers and accurately state the parser exception.
3. **REV-003, Low:** ownership is documented as transferring on start, but close-before-start closes the app.
   Align construction ownership and verify the unstarted close path.
4. **REV-004, Low:** Promise.all may report a network close error before app cleanup settles. Use bounded
   all-settled cleanup and verify that early network failure still awaits application cleanup.

The reviewer otherwise found request origin/peer/header/framing/body ceilings, response streaming/cancellation,
the 4 MiB response limit, asset snapshot and terminal start/bind/close behavior bounded and fail-closed.
Reviewer tests: 21/21 focused and cumulative whitespace passed. Producer verification: 111/111 CR14B,
main 536 pass/2 skips, TypeScript/full lint, VPS 7/7, Sites 4/4, 127-table migrations, pretest 769/769.
Posttest failed 1 of 392 at the authority inventory; do not label this original product full-regression green.

No reviewer edits, installs, source repairs, physical listener/socket, external network/database, credentials,
native/provider, browser, ingress or deployment effects occurred. These results do not prove real HTTP parser,
OS cleanup, PostgreSQL, TLS/MFA or private-pilot behavior. Re-review of a corrected immutable product is required.
