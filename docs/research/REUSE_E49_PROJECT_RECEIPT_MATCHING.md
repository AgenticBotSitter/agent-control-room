# E49 — project save response matching

2026-09-06. Local browser-client change using the existing project command protocol.

The client previously accepted any schema-valid project in a successful save response.
Creation now requires the normalized requested title/summary and the initial active
version-one state with matching creation/update timestamps. Lifecycle changes require
the requested project ID, lifecycle and next version, preserving the original immutable
title/summary/creation time. Expected fields are captured before the asynchronous call.

A mismatched response remains uncertain and does not clear the existing pending
request/key. Only an explicit identical retry is allowed; another command is refused.
No new retry mechanism, command API or database authority is introduced. This custom
comparison is product glue for the existing receipt contract, not reusable infrastructure
that an external workflow package could supply without the same domain fields.

Historical receipts remain historical: a real handler/PGlite test drops the first
successful create response, archives the project through a second request, then retries
the original create through the browser client. The original version-one receipt matches;
a fresh GET returns archived state. Two audited effects exist, not a duplicate creation.
The test uses synthetic authentication and an in-process database, not a real browser
or production PostgreSQL.

Focused tests cover mismatched title, summary, initial state/timestamps, foreign project,
wrong lifecycle, stale or skipped versions and changed immutable fields, retaining the
same explicit retry key. The project/client suite, type/lint and compiled build checks
are recorded in BUILD_STATUS.md. No response-body transport redesign was included.

No downloads, new dependencies, provider calls, credentials, service activation,
GitHub publication or deployment. Interactive browser and real-agent acceptance remain.
