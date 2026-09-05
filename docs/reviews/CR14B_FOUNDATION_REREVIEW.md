# CR14B foundation — bounded independent re-review

Date: 2026-09-04. Reviewer: `remaining_gate_audit`, independent of the producing agent. The producing agent
retained this summary from the returned report. The same reviewer checked its bounded repair; this is not
a claim that a second different reviewer participated.

Accepted repair: `2de0a4760fe1d5a0f2b39894e2e19ad897486d5f`.

Accepted tree: `f30ed73082ed439a72f7d358c42af9b31f3cda97`.

Parent/original reviewed product: `b84dba81a2a6a99233e11524ca2f9f089539cf03`.

**Disposition: accepted; both findings closed with no remaining blocker.**

CR14B-AUTH-1 is closed. Logout now uses a separate transaction with no project policy/grant dependency,
resolves the exact existing human even when suspended/revoked, and binds revocation to tenant, token digest,
identity and issued time. It checks proof freshness before entry and immediately before commit, creates and
revokes an exact-session tombstone when necessary, preserves the first revocation with `coalesce`, and is
idempotent without affecting distinct assertions. Seven regression cases cover loss of authority, repeated
logout, rejection after authority restoration and successful use of a distinct assertion.

The Low schema note is closed. Removing the redundant workspace column leaves the canonical project as
workspace authority. Service insert/query behavior is consistent. The integrity test confirms column absence
and rejection of an absent canonical project.

Observed checks: focused CR14B 22/22, compiled Node handler 2/2, TypeScript, focused lint and whitespace passed.
The working tree remained clean. The initial report accurately preserves the original product/findings.

This acceptance is for the foundation correction only, not B-WIRE, deployment, production PostgreSQL,
IdP setup, a listener rehearsal or private-pilot completion. The review made no edits, live calls or deployments.
