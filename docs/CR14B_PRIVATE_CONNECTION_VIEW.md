# CR14B — private connection inventory

Date: 2026-09-04. Repository integration on the shared-catalog base `98b6030`.
Acceptance and exact checks are recorded separately. This is an existing-enrollment read view, not the
new native-run adapter, a live fleet, onboarding completion, or a private deployment.

## Mounted behavior

The separate VPS app now includes `/connections`, linked from the common private header. Its shell carries
no inventory records. `GET /api/v1/connections` returns exactly `{projection, telemetry}` after current
Access verification and SQL session/grant authorization. The preview's existing connection endpoint and
local-pilot owner-session implementation remain separate and unchanged.

- `WebSessionAuthority` extracts the accepted project identity/session/grant transaction and logout code.
  Projects retain their prior source policy. Both features lock the same identity, exact assertion session
  and grants and recheck token/key-proof/session/grant deadlines before commit. Logout through the existing
  endpoint revokes both views, including when the caller has lost its project permissions.
- Inventory is tenant-wide, not workspace-local. Only an active human with an **owner** grant allowing
  `connections.read` (or `*`) and wildcard project scope may enumerate it. Operator, project-only,
  revoked/expired and strong-factor-required grants do not gain this read. A browser login is not a separate
  strong-factor approval. No browser-selected tenant, workspace, source or cursor is supported.
- Registry configuration is consulted only after authorization. Missing registry key gives unavailable,
  not an empty roster. Missing telemetry key is explicitly `not_configured`; all signals then remain missing.
  Keys are existing server composition inputs, copied by the stores, not generated, loaded, displayed or
  enrolled through this implementation. No configuration HTTP route exists.
- The existing registry's full stored enrollment-stream/head verification runs inside the already authorized
  session via `readInSession`. Telemetry uses only its keyed authenticated-ingress receipts in that session.
  There is no nested transaction or second pool acquisition. Mutable fleet-current rows are not substituted.
  Existing history/count ceilings remain: up to 32 currently eligible connections and the existing bounded
  history reader. Capacity/integrity errors stay unavailable; no partial/truncated successful roster is invented.
- The existing schema, privacy-safe inventory references, exact reviewed Hermes revision and four blocked
  live-qualification/authority states are preserved. Expired enrollments are omitted by the existing source;
  this is not a history browser and omission does not revoke or delete evidence. Signals describe the recorded
  check time, not a continuous liveness guarantee. Nothing here claims a working Mac/PC/VPS adapter.
- API output is no-store/noindex. It contains no tenant/node/connection/enrollment source IDs, SSH addresses,
  profile identifiers, native locators, credentials or private integrity tags. Presentation references are
  ephemeral view labels, not stable dispatch targets.

## UI behavior

The page reuses the established read-only `ConnectionCenterPanel` and private styling. It labels the
inventory as the existing Hermes 0.21 source, explicitly not a live fleet monitor, with page copy identifying
its account-wide/all-workspaces scope and a Connections browser-tab title. Refresh is a GET only,
on mount/focus/manual refresh and every 30 seconds while visible. Each refresh clears the old view while
loading; only the latest pending read can replace it. A failure clears records. The displayed check time
and wording avoid representing a background tab's snapshot as continuously current. No browser storage,
auto-POST, connect/install/update/credential control, provider call or task submission is introduced.

Private API reads request an expired-session response with `X-Requested-With: XMLHttpRequest`, disallow
redirects and use the existing ten-second fetch deadline pattern. The strict envelope and browser-safe
projection digest validation reject malformed results; this digest is consistency checking, not a replacement
for server authentication or the private registry HMAC. Sign-in recovery discloses cross-application Access logout.

`CR14B-CONNECTION-UI-001` remains an undispatched draft: its future platform/harness onboarding/readiness
presentation is different from this legacy enrollment view. Do not mark it completed or populate it with
invented native-run status. D-FLEET integration must provide real evidence before any ready-to-run label.

## Verification boundary

Tests use migrated disposable PGlite, synthetic records written through existing stores, injected public-key
transport, static React rendering and the compiled Node handler. No live browser/hydration, TLS/static socket,
PostgreSQL multi-process locking, native/provider, credentials, service or deployment evidence is claimed.
`CR14B_BOOTSTRAP_DATABASE_PREPARATION.md` records the next repository startup/role work and later effect gates.
