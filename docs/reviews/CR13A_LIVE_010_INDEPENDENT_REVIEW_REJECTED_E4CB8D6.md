# CR13A-LIVE-010 independent review — rejected target

**Disposition:** rejected

**Reviewed implementation:** `e4cb8d69b4dbe17f560303a1edad08871fcc575b`

**Base:** `91398c18560f25785ee4dc83ff18b9b42406f15b`

This record is immutable negative evidence. Later remediation does not convert this target into a pass.

## Medium — locator material can pass through identifier fields

The Connection Center item schema allowed dots and colons in `connectionId` and `nodeId`, the server copied both values
from an accepted signed enrollment into the public projection, and the UI rendered them. A valid enrollment using
`connectionId: "10.0.0.5:22"` and `nodeId: "johnny5.local:22"` therefore reached the protected browser projection while
`locationVisible`, `nativeLocatorVisible`, and `containsNativeLocators` all remained `false`.

Observed result: an address, port, and hostname could reach the browser through fields presented as identifiers.

Expected result: the browser must receive only guaranteed non-locator, domain-separated presentation references, or the
projection must reject locator-shaped identifiers. Visibility flags cannot make already returned locator material
private.

This violates the frozen packet requirement that no hostname, address, port, or SSH target can reach the API or UI and
therefore blocks acceptance of the exact reviewed target.

## Clean observations

- Authentication occurred before roster reads.
- Tenant scope came from the verified owner session.
- Roster digest, tenant, expiry, duplicate route/profile/connection, and projection digest failures closed safely.
- The empty roster was honest.
- No connection, SSH, qualification, execution, approval, or write control was added.
- Browser imports remained free of Node-only modules.
- Focused tests, typecheck, and production build passed during review.

No High or Low finding was reported. The reviewer changed no repository file and attempted no repair or live effect.
