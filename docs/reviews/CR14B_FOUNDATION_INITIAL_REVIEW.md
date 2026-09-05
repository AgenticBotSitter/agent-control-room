# CR14B foundation — initial independent review

Date: 2026-09-04. Reviewer: independent agent `remaining_gate_audit`. The producing agent retained this
summary from the returned report; the reviewer performed report-only source review and existing local tests.

Reviewed commit: `b84dba81a2a6a99233e11524ca2f9f089539cf03`.

Reviewed tree: `dca0230b661f662d20db91d7fda241396ca872ec`.

Parent: `8b892874594bfb8ddf87a86877ccc535f69c4ad5`.

Disposition: needs one bounded correction before foundation acceptance. Worktree remained clean.

## CR14B-AUTH-1 — Medium, blocking

`WebProjectService.logout` uses ordinary `projects.read` authorization, requiring an active identity,
current owner/operator grant, policy approval and wildcard project scope. A valid assertion therefore cannot
revoke its exact session after suspension, grant revocation/expiry, permission removal or scope narrowing.
The endpoint returns 403 rather than revoking the session; restored authority can make it usable again.
The original test restored the grant before logout and missed this case.

Required correction: separate exact-session revocation bound to verified tenant, token digest and identity,
without project/wildcard/strong-factor permission requirements. Test logout after suspension, grant
revocation/expiry and scope narrowing. Do not reinterpret this review as a native qualification failure.

## Schema note — Low, nonblocking

Manual lifecycle heads separately reference workspace and project without tying their workspace IDs together.
Current trusted service writes and canonical-workspace query filters are consistent; no present authorization
bypass was found. Remove the redundant workspace column or enforce the composite relationship.

## Checks and scope

- Focused CR14B: 14/14 passed; compiled Node handler: 2/2 passed.
- TypeScript, focused lint and whitespace: passed.
- Build-profile separation and the all-route VPS 503 guard are coherent; default Sites behavior remains preserved.
- Other transactional create/lifecycle/audit/idempotency structure matched the contract.
- No rebuild, listener, production database, credentials, provider, deployment or native qualification occurred.
- Explicitly unmounted B-WIRE and live pilot work was not treated as complete.

This report is retained for the exact original product. Corrections and later acceptance are separate records.
