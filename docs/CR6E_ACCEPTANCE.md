# CR-6E owner acceptance record

**Status:** Ready for owner review; effect-free implementation verification is complete.

## What now works with protected data

- the dashboard reads one authenticated, tenant-bound operator snapshot rather than accepting a tenant from the browser;
- portfolio cards report canonical workflow/job counts and last activity, not invented completion percentages;
- worker fleet, active work, bottlenecks, Action Inbox, Owner Focus, service incidents, services, and schedules use bounded redacted projections;
- absent or invalid protected data fails closed and the dashboard labels its synthetic fallback instead of presenting it as real;
- Owner Focus saves only a policy-authorized P0/Today intent. It creates no reservation, scheduler override, dispatch, outbox message, or external effect; and
- project and worker detail pages are explicitly labelled synthetic fixtures until their own protected reads are implemented.

## Automated evidence

- Type checking and ESLint pass.
- Focused operator-surface, dashboard, route, and Owner Focus tests pass.
- Full repository suite: 290 passed, 0 failed, 1 intentional skip.
- Production build and rendered-route checks pass.
- Database verification applies migrations 0001 through 0019 and verifies 66 PostgreSQL tables.

## Owner review (no production action required)

1. Open the dashboard signed in through the intended platform identity.
2. Confirm that the connection indicator says **Protected data connected** only when the server-side tenant/database configuration is present and the returned data belongs to the expected tenant.
3. Confirm that unavailable authentication/configuration shows **Synthetic fixture** or an unavailable message, never protected status.
4. Review an Action Inbox item and verify that it lists evidence and permitted responses without claiming that a response already happened.
5. Set and clear an Owner Focus pin. Confirm the receipt says that no schedule or dispatch changed.
6. Resize to a phone-sized viewport and use Tab/Shift+Tab. Confirm the dashboard and fixture detail pages have visible focus and working skip links.

## Retained boundaries and remaining work

This block does not install a service, dispatch work, change an external service, spend money, change credentials, or authorize a consequential effect. Individual project and worker detail pages remain fixture-only until a later scoped protected-read slice. Live owner acceptance requires the owner's real authenticated deployment configuration; it cannot be substituted by an automated test or an agent claim.
