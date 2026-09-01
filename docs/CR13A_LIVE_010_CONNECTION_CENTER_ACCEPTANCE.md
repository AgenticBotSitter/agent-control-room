# CR13A-LIVE-010 Connection Center acceptance record

**Status:** original target rejected; identity-redaction remediation complete and fresh independent re-review required

**Date:** 2026-09-01

**Exact implementation:** `e4cb8d69b4dbe17f560303a1edad08871fcc575b`

**Exact remediation:** `c32bb1908323d9acb2e891722c1fd4657334c741`

**Base:** `91398c18560f25785ee4dc83ff18b9b42406f15b` (accepted CR13A Project Activity restack)

**Review packet SHA-256:** `db36f1ce2e94736dc4aa8653e192400c56dc0905d746a7643c444ac7f82b30ac`

**Remediation review packet SHA-256:** `0cbe9d35414ca3ab39d3abe8f1556234049562f6e0e88ce27721687f951de476`

## Delivered result

Control Room now has a dedicated `/connections` page and protected `GET /api/v1/connections` endpoint. The dashboard
links directly to Connection Center. The page shows an authenticated tenant-scoped connection count, local-versus-SSH
inventory, exact reviewed Hermes 0.21 revision, enrollment/profile/qualification state, and bounded blocker codes. The
repaired projection never exposes a source connection identity, source node identity, tenant identity, hostname, SSH
target, path, credential, protected value, private profile identity, or native locator. Connection and node references
are generated as view-only ordinal labels after the signed roster has been validated.

The server rebuilds every source roster through the already accepted signed-enrollment roster contract before creating
the UI projection. Roster-digest drift, duplicate identities, cross-tenant entries, expired enrollment, invalid time,
and altered browser projections fail closed. Authentication happens before the roster source can be read. The browser
accepts only the exact strict projection with a matching SHA-256 digest.

The repository-fake local pilot intentionally exposes an authenticated empty roster. Installed Hermes software, a known
computer name, an earlier native test, or an SSH-capable machine does not become an enrolled connection. When the roster
is empty, the page says so plainly and substitutes no fixture or implied live status.

## Authority boundary

- Connection Center is read-only presentation. It has no POST route, connect button, qualification button, SSH client,
  provider client, credential client, or native launcher.
- The page cannot approve, schedule, claim, lease, dispatch, retry, command, or execute work.
- Runtime compatibility means only that an accepted enrollment names the exact reviewed Hermes 0.21 revision. It is not
  native qualification, live-panel eligibility, liveness, capacity, or provider success.
- The source port is server-owned and accepts only the already sanitized enrollment roster. Browser or remote objects
  may not pass through it.
- Production connection-registry persistence and actual node health composition remain later work. No production
  database or host was contacted.

## Independent review and remediation

The first independent review rejected exact implementation `e4cb8d69b4dbe17f560303a1edad08871fcc575b`
with one Medium finding. The signed-enrollment grammar allowed locator-shaped identifier values, and Connection Center
copied `connectionId` and `nodeId` into the browser projection. A valid `10.0.0.5:22` connection and
`johnny5.local:22` node therefore exposed an address, port, and hostname while visibility flags remained false. The
immutable negative report is `docs/reviews/CR13A_LIVE_010_INDEPENDENT_REVIEW_REJECTED_E4CB8D6.md`.

Remediation `c32bb1908323d9acb2e891722c1fd4657334c741` removes source connection identity, source node identity,
tenant identity, source-result digest, and roster digest from the public contract. It substitutes exact ordinal
presentation references, keeps tenant and roster comparisons on the server, and adds a regression using the reviewer's
locator-shaped values. This remediation is not accepted until a different independent reviewer reproduces the old
defect and accepts the exact repaired target.

## Verification

On the prepared Mac checkout with Node `22.22.3` and `pnpm 11.19.0`:

- `pnpm test:cr13a-connections`: 10/10 passing;
- combined `pnpm test:cr13a`: 26/26 passing;
- registered pretests: 769/769 passing;
- core tests: 418/420 passing with two intentional Windows-only skips and zero failures;
- registered posttests: 260/260 passing;
- `pnpm check`: passing;
- `pnpm lint`: passing;
- production build: passing, including `/connections` and `/api/v1/connections`;
- rendered-route checks: 4/4 passing;
- migrations `0001` through `0033` applied and 112 PostgreSQL tables verified;
- macOS stage zero: `ready_for_runtime_check`; and
- integration diff whitespace validation: passing.

The pre-existing exact-minimum-runtime combined stack passed Node `22.13.0` before this feature. This new candidate must
still pass ordinary main-target GitHub CI at Node `22.13.0` after its parent pull requests merge and it is retargeted.
A live browser viewport pass was not claimed because starting a persistent local development service was outside this
turn's authorized effect boundary; the production renderer verified the new shell and negative controls instead.

## Open gate

A different reviewer must reproduce the predecessor leak and inspect authentication ordering, tenant isolation, roster
reconstruction, identity replacement, digest validation, version semantics, empty-state honesty, exact browser parsing,
negative authority, and client/server bundle separation at exact remediation
`c32bb1908323d9acb2e891722c1fd4657334c741`. The review must treat the accepted connector and roster contracts as
immutable dependencies and must not authorize or run any native process, provider call, SSH connection, credential read,
production database, deployment, or local persistent service.

Draft PR #230 remains stacked behind connector PR #228 and Project Activity PR #229. It is not integration-eligible
until the independent re-review accepts the exact remediation, both parents land in order, the feature is retargeted to
`main`, and ordinary GitHub CI passes.
