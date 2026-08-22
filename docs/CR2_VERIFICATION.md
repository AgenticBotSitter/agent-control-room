# CR-0 through CR-2 verification

Verified on 2026-08-22 with synthetic data only.

## Automated checks

- TypeScript type check passes.
- 13 contract, redaction, scheduler, tenancy, cursor, idempotency, audit, and persistence tests pass.
- 2 production server-render tests pass for portfolio, project, and worker routes.
- PostgreSQL-compatible migration test applies `0001` and `0002` and verifies 22 tables.
- Production `vinext build` succeeds.

## Interface checks

- Desktop portfolio renders without horizontal overflow.
- Phone layout hides the sidebar, shows bottom navigation, and uses one-column project cards.
- Project scope selector narrows the portfolio.
- Light/dark preference toggles and persists locally.
- Capacity simulator selects Windows when the preferred Mac is busy and can be manually pinned to the slower VPS route.
- The simulation clearly states that no live command is sent.
- Production browser console is clean after automatic link prefetch is disabled for the current beta runtime.

## Intentional stop boundary

No source system was modified. No live endpoint, database credential, Telegram bot, provider API, Unreal job, Content Blooms lease, or Wayfarer render worker is connected. Those require a separately approved integration/deployment phase.
