# CR14B private startup/database acceptance

Date: 2026-09-04. **Accepted for repository startup, bounded pool/drain and restricted database-role code.**
Full B-WIRE, real PostgreSQL rehearsal and a deployed private pilot remain incomplete.

Base: `39afa0f13c3309021e2a8cc2ee126cbdbd1bdb59` (PR #283).
Initial implementation: `c34ba89e1cb0792fb25724cc84aa871d8fff39f1`.
Rejected review candidate: `007eeb1473504a1dab4394f8b2d1d0b045a8b1c9`.
Accepted product: `09db99b3925f2197f2421b14a95ccfb35c707b80`.
Accepted tree: `48602c8361d03897197f945a9a7d72f10718a9bf`.
Branch: `codex/cr14b-private-startup-database`.
Publication: [PR #284](https://github.com/MarvinAi5/control-room/pull/284), stacked on #283.
Current-head CI and dependency-order integration #280 → #281 → #282 → #283 → #284 remain required.
No merge or deployment is claimed.

## Delivered and verified

- Inert server-only bootstrap with explicit PG17 same-host configuration, one owned pool and one startup
  attempt. Effective role/permissions, fixed connection settings, schema fingerprint and existing owner/scope
  are verified before shared application installation. No auto-setup, credential discovery or sample fallback.
- Bounded admission/checkout/statement/transaction/drain/termination, session lifetime checks and no command
  retry. Fast COMMIT/rollback failure and timeouts quarantine the pool with a truthful uncertain outcome.
- Migration 0040's constant-false lock columns and irreversible session revocation; dedicated narrow web role
  and separate operator DB ACL script. No change to the old broad application-role script or generic DB adapter.
- Actual compiled bootstrap/handler composition tested through restricted disposable SQL; no database startup
  code in browser assets. Existing Sites preview remains separately buildable and unchanged.
- Draft setup/rehearsal specification, clearly not runnable or authorized before exact host/artifact/cleanup
  choices and the later reviewed listener/real-PG harness. See `CR14B_SETUP_REHEARSAL_PACKET.md`.

| Observed check | Result |
|---|---|
| macOS stage zero | Ready, required Node/pnpm/lockfile; no install |
| Final focused CR14B suite | 90/90 passed |
| Final registered main command | 517 total, 515 passed, 2 Windows-only skips, no failures |
| TypeScript, full lint, cumulative whitespace | Passed |
| Both installed production build profiles | Passed; separate private Node and preserved Sites |
| Final compiled/rendered checks | 5 private + 4 Sites passed |
| Disposable migrations | 0001–0040, 127 tables |
| Independent re-review | 23 pool/role + 5 startup tests passed; 0 residual findings |

Counts overlap; do not add them as unique tests. Local main/focused commands used installed Node/tsx directly
without local pretest/posttest; GitHub's full lifecycle is separate. Both builds used installed Vite directly,
without CLI installs/upgrades or prerender listeners. Existing nonblocking framework/build warnings remain.

## Preserve limitations and review history

The initial independent review rejected a fast transaction-uncertainty gap. The architect corrected it, added
tests and obtained independent re-review acceptance; retain both reports in `reviews/CR14B_PRIVATE_STARTUP_*`.
Acceptance/status/ADR handoff changes are documentation-only beyond the immutable accepted runtime product.

PGlite's template1 database ACL cannot be revoked in this installed simulator. The production gate rejects
that unmodified connection; only its TEMP metadata field is injected by the startup test helper. Role/table/
column/trigger tests execute real disposable SQL. Neither the real DB ACL step nor socket cancellation,
independent-session locking, restore, browser/ingress or deployment is claimed proved by those tests.
No host services, database provisioning, listener, live credentials, agents/providers, DNS or deployment occurred.

**Next block: CR14B private Node serving and rehearsal tooling, Astra Xhigh (`gpt-6-astra`, `xhigh`).**
Implement the request/static adapter and executable disposable real-PG rehearsal harness with injected tests.
Do not run their live effects yet. Owner IdP/private hostname and scoped host/DB preparation are later gates;
there is no extra owner question for this already-scoped repository implementation. Three worker UI drafts
remain undispatched; this block does not qualify/connect a live fleet or finish the private pilot.
