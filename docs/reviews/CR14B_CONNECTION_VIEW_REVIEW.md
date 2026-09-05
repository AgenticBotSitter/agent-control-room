# CR14B private connection view — independent review

Date: 2026-09-04. Reviewer: `cr13a_live290_review`, independent of the producer.
The producing agent retained this report from the returned review.

Base: `98b60306f9b62d2f7bcda26723a22880ddcd9c3e`.
Initial product: `2c97b9d65d236377120720fdeee624a9ae987582`, tree `7521f5fc48e97d9926572b57c294092f7ed60e8e`.
Accepted final product: `e6fa438dbb2e71cb4435c6872051722171928d22`.
Accepted tree: `3434d4aa0f4ca966631a8e4c1eb0eda7c91d6609`.

**Disposition: accepted for the repository connection view and preparation documentation.**
Initial findings: 0 High / 0 Medium / 2 Low. Residual findings: 0 High / 0 Medium / 0 Low.

## Findings retained and closed

1. **Low — database role inventory accuracy.** The initial preparation table named nonexistent `adapters`
   and omitted `workspaces`, which the project create path reads and locks. A future role authored from that
   table would miss actual required permissions. Closed by `cc7f64972697926a96a79e84e481cb6c0906bd07`:
   the row now names `workspaces`, `adapter_registry`, `projects`, `control_manual_project_heads`, including
   read/lock authority on the existing workspace. This was a preparation-document defect, not deployed roles.
2. **Low — mounted page identity and scope labels.** `/connections` inherited Projects metadata and did not
   explain that its owner-only inventory covers all workspaces while sharing a Private workspace header.
   Closed by `e6fa438`: route-specific Connections title/description, explicit all-workspaces page copy, and
   static/compiled assertions. The private artifact was rebuilt for the correction.

A separate mechanical extra blank EOF line in the extracted session module was corrected by
`c8dcf71f990bf986fad4a8a8c2e6fac51397e478`; it is not counted as a semantic finding. Earlier candidate and
correction commits remain in history. No failed review evidence is converted into initial acceptance.

## Accepted properties

The shared session extraction preserves project/logout behavior. Connection inventory requires a current
human owner with tenant-wide wildcard `connections.read` authority. Token, verification, stored session and
grant freshness are checked before commit. Existing keyed registry and authenticated telemetry reads remain
inside that authorized SQL transaction. Projection output is bounded and sanitized. UI is read-only and
describes the last check, not a live fleet. No native, provider, listener, preview, execution or deployment
authority was added. Startup and role preparation remain clearly unimplemented design for later gates.

## Independently observed checks

- Exact final identity/tree, clean checkout and cumulative `git diff --check`: passed.
- Focused CR14B: 62/62 passed.
- Existing rebuilt private compiled handler + connection client/view checks: 7/7 passed (3 + 4).
- Existing registry/Connection Center regressions: 16/16 passed on the same runtime source before the
  documentation/metadata-only corrections. This is the reviewer's executed count, not extra unique coverage.

The reviewer did not rerun the producer's main command, TypeScript/full lint, builds or migration verifier.
No edits, Git writes, installs, downloads, browser operations, network, credentials, providers, native calls,
listeners, services, deployment or real PostgreSQL effects occurred. Acceptance does not cover hydration,
implemented bootstrap/roles, real PostgreSQL, the complete B-WIRE/private-pilot exit or deployment.
