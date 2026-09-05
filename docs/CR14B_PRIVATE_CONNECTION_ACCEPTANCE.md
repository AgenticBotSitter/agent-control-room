# CR14B private connection view acceptance

Date: 2026-09-04. **Accepted for the private connection read view and bootstrap/database preparation design.**
Full B-WIRE, implemented startup/roles and private-pilot acceptance remain incomplete.

Base: `98b60306f9b62d2f7bcda26723a22880ddcd9c3e` (PR #282).
Initial product: `2c97b9d65d236377120720fdeee624a9ae987582`.
Accepted product: `e6fa438dbb2e71cb4435c6872051722171928d22`.
Accepted tree: `3434d4aa0f4ca966631a8e4c1eb0eda7c91d6609`.
Branch: `codex/cr14b-private-connection-view`.
Publication: [PR #283](https://github.com/MarvinAi5/control-room/pull/283), stacked on #282.
Integrate #280 → #281 → #282 → #283 after accepted scope and current checks. No merge or deployment claimed.

## Delivered

- Private `/connections` page, shared navigation and `GET /api/v1/connections` use the same exact-session
  revocation and grant transaction as project views. Inventory is owner-only and account-wide/all-workspaces.
- Existing keyed enrollment history and authenticated telemetry verification run in that transaction. Missing
  configuration, missing/stale signal evidence and integrity failures are distinct from a verified empty roster.
- Browser output retains privacy-safe view references, blocked execution status, explicit last-check timing,
  refresh-only controls and the legacy Hermes 0.21 source boundary. It does not discover hosts or run agents.
- Extracted shared session code preserves project and logout policy. The older Sites preview remains separate.
- `CR14B_BOOTSTRAP_DATABASE_PREPARATION.md` names startup/pool/shutdown ownership, proposed finite limits,
  actual required tables, the row-lock/least-privilege issue and later scoped real setup/rehearsal/pilot gates.
  Those roles, pool deadlines and bootstrap are **not yet implemented or provisioned**.

See `CR14B_PRIVATE_CONNECTION_VIEW.md`. No migration, dependency/lockfile, production role script or hosting
binding changed. Three UI worker drafts remain undispatched; the future multi-platform connection-onboarding
packet is not satisfied by this existing-enrollment view.

## Verification actually observed

| Check | Evidence |
|---|---|
| macOS stage zero | Ready; Node >=22.13, pnpm 11.19.0 baseline; no install |
| Focused CR14B | 62/62 passed; independently repeated at final product |
| Registered main command at final product | 489 tests: 487 passed, 2 Windows-only skips, no failures |
| TypeScript, full lint, cumulative whitespace | Passed at final product |
| Private installed Node builder | Five phases passed; rebuilt after metadata/scope correction |
| Compiled/rendered checks | 3 private handler + 4 preserved Sites render checks passed |
| Default Sites installed builder | Five phases passed before private-only metadata correction; its source unchanged by that correction |
| Connection registry/preview regressions | Producer final dedicated run 15/15 passed; reviewer separate run 16/16 |
| Disposable migration verifier | 0001-0039; 127 tables; no migration changed |

Focused and component counts overlap the main suite; they are not additional unique tests. Local
pretest/posttest were not run. Both builds used installed Vite directly without CLI update/prerender/listener
behavior. Nonblocking existing build warnings remain. All database records/keys were synthetic and disposable.
Compiled/static checks are not actual browser clicks/hydration, network/static delivery, TLS, real PostgreSQL
concurrency/restore or private deployment evidence. Exact-head GitHub CI is separate and tracked on the PR.
PR #282's exact head `98b6030` passed run `33939343152`; that result is base evidence, not this PR's CI.

## Independent review and next block

`reviews/CR14B_CONNECTION_VIEW_REVIEW.md` retains two Low findings and their corrections: role-matrix table
accuracy and page metadata/scope. Final review accepts `e6fa438` with no remaining findings. Later acceptance,
status and ADR recording is documentation-only and does not alter the reviewed runtime product.

**Next: CR14B bounded startup/pool and database-role implementation, Astra Xhigh (`gpt-6-astra`, `xhigh`).**
Implement the already-scoped repository pieces and prepare one exact setup/rehearsal packet. No owner action
is needed for that repository work. Real credential/IdP/MFA/network/service/database/listener/browser and
deployment operations still need their separate scope and prerequisites. No automatic real-agent qualification,
worker dispatch, production migration or deployment is authorized by this acceptance.
