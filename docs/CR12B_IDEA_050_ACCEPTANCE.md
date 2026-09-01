# CR12B-IDEA-050 acceptance — durable session resume and protected project lifecycle

**Status:** Complete locally for the owner-authenticated, repository-fake, runtime-disabled implementation snapshot.
**Date:** 2026-08-31
**Authority:** This record accepts repository code and synthetic local evidence only. It grants no native provider, credential, production database, deployment, or hosting authority.

## Delivered

- Owner-scoped session catalog and detail reads reconstruct each session from authenticated durable session, run, synthesis, decision, and project evidence.
- Read authorization uses the existing low-risk, effect-free owner path and creates no policy-decision write. Session projections use the latest durable event time, so their identity remains stable across reload and restart.
- Catalog results are tenant/workspace scoped, newest first, limited to 25 by the service and 50 by the store contract, and fail closed if any retained evidence fails verification.
- The protected Idea Lab client reloads the catalog, selects the latest session, restores its title, summary, target customer, state, and session ID, and can continue only the legal next operator step.
- A separate human-owner-only project lifecycle service implements pause, resume, complete, archive, and reopen over the accepted transition graph.
- Lifecycle commands derive tenant, owner identity, target state, policy identity, and safe reason on the server. The browser supplies only command ID, expected version, and time; project and action are route-bound.
- Exact lifecycle replay returns the already-committed projection only when the authenticated owner, command-derived reason, target state, version, and time all match.
- Optimistic versioning and the transactional store ensure that concurrent commands advance at most one version.
- Protected catalog, detail, and lifecycle routes authenticate first, return no-store responses, reject aliases and oversized/non-JSON bodies, and remain closed in the shipped composition.
- Project Settings now shows only the transitions legal from the current state. The shipped controls are visibly disabled until an explicit protected local runtime is installed.

## Safety invariants

1. Session reads require a current human owner grant and never accept tenant, workspace, or identity from the browser.
2. Read-only reloads do not create policy or lifecycle writes.
3. A lifecycle command cannot select its tenant, owner identity, target state, safe reason, or authorization evidence.
4. Operator and agent identities cannot satisfy the owner lifecycle boundary.
5. Illegal, stale, conflicting, cross-scope, and caller-extended commands fail without a lifecycle event.
6. Exact replay cannot create a second lifecycle version; a different command at the same expected version conflicts.
7. Archive remains reversible through a separate reopen command and no project history is deleted.
8. Lifecycle changes grant no approval, command, lease, dispatch, execution, provider, or automatic-project authority.
9. The default runtime performs no session read or write and every browser control remains disabled.

## Local evidence

- Eleven new tests cover stable restart reads, owner-only catalog access, the full reversible lifecycle, exact replay, restart recovery, concurrency, illegal/stale commands, operator impersonation, default-closed and route-scoped APIs, reload-safe session presentation, and legal state-aware controls.
- The combined CR12B gate passes 48/48.
- Registered pretests pass 769/769; core tests report 414/416 with zero failures and two intentional platform skips; registered posttests pass 127/127.
- TypeScript, full lint, production build, 3/3 rendered routes, all 29 migrations with 104 PostgreSQL tables, macOS stage zero, and whitespace validation pass.

## Deliberate limits

- The production composition remains absent. No owner-session adapter, protected catalog keys, durable local composition, or live browser session is installed by this block.
- No Hermes, Codex, local-model, or other native provider was contacted. Panel execution remains the zero-network repository fake.
- The visible project page remains an injected fixture until the explicit local pilot composition supplies protected reads and writes.
- No production PostgreSQL service, VPS, DNS, Cloudflare, public hosting, deployment, or external system was contacted or changed.

## Next gate

CR12B-IDEA-060 installs one explicit local non-production protected composition and runs one owner-attended repository-fake pilot. The owner must be present for the real local session and any macOS protected-key confirmation. Live provider contact remains outside that pilot and requires a separate exact authorization.
