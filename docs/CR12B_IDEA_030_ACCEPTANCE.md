# CR12B-IDEA-030 acceptance — protected Bot Mode coordinator and owner decision

**Status:** Complete for the repository-only, provider-disabled implementation snapshot.
**Authority:** This document accepts code and local synthetic evidence only. It authorizes no Hermes/provider contact, credential access, deployment, production database, or project creation outside a configured protected runtime.

## Delivered

- An exact provider-session evidence contract binds one panel identity to one idea session, adapter revision, filtered-event capability, usage reporting, cancellation, disabled tools/MCP, expiry, and safe-content retention.
- Live evidence cannot authorize itself. A live Hermes driver requires a separate server-held evidence authority. The shipped runtime supplies none and is disabled.
- A sequential, bounded coordinator enforces the session's participant, round, message, duration, and cost limits. The repository fake contacts no provider.
- Every attempted turn receives a durable pre-call marker. A throw, malformed receipt, contact-evidence mismatch, or restart after that marker is terminally ambiguous and never automatically retried.
- Append-only PostgreSQL run events retain HMAC-authenticated state, marker, safe receipt digest, contribution digest, known usage, and terminal disposition. PGlite is used only for the local tests.
- The owner-decision service derives tenant and owner identity from verified server authentication, narrows policy to a human owner grant, and persists an immutable owner permit before recording the decision/project effect.
- The protected HTTP endpoint accepts only an opaque session credential, a route-bound idea session, and an exact decision intent. Caller identity and tenant headers have no authority.
- The production composition remains closed by default.

## Safety invariants

1. Panel advice grants no approval, command, lease, execution, or automatic project-creation authority.
2. A shaped or digest-valid live evidence document is insufficient without the independent server verifier.
3. At most one panel turn is in flight, and the exact maximum is `participants × rounds` (3–18).
4. No automatic retry occurs after a provider marker or ambiguous outcome.
5. Provider content is not retained by the coordinator; only the strict safe contribution and digest evidence cross the boundary.
6. A browser cannot supply tenant, workspace, owner identity, policy-decision identity, or permit identity.
7. Operator or agent grants cannot satisfy the owner write boundary.
8. An immutable owner permit must pre-exist every protected decision/project write.
9. The default runtime performs zero provider calls and zero project mutations.

## Local evidence

- Focused CR12B-IDEA-030 tests cover successful bounded fake orchestration, terminal ambiguity, restart recovery, expired/mismatched/accessor evidence, append-only mutation guards, forged live authorization, owner-only promotion, exact replay, identity substitution, missing permits, and the disabled/configured HTTP boundary.
- The new focused gate passes 12/12 and the combined CR12B gate passes 26/26.
- Registered pretests pass 769/769; the core suite reports 414/416 with zero failures and two intentional platform skips; registered posttests pass 105/105.
- TypeScript, full lint, production build, 3/3 rendered routes, all 29 migrations with 104 PostgreSQL tables, macOS stage zero, and whitespace checks pass.

## Deliberate limits

- No live Hermes/provider driver is configured or contacted.
- No owner-session adapter or production runtime composition is installed.
- The `/ideas` presentation remains an injected fixture and has no live browser mutation control.
- Session creation and synthesis are still internal seams. The next block protects those operations and connects the operator workflow without enabling live provider contact.
