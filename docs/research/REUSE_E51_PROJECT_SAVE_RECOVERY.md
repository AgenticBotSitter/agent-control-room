# E51 — usable original project-save retry

2026-09-06. Local UI/client implementation; no live-browser acceptance.

An unconfirmed lifecycle change could remain stuck after polling returned a newer
project version: clicking its ordinary status button constructed a different request,
which the correct pending-request guard refused. Project creation also allowed editing
the draft even though a different save could not proceed.

The browser client now exposes hasPending and an explicit retryPending operation.
It retains the original path, serialized body, key and response matcher in memory.
Retry cannot adopt a refreshed project version or mutable caller fields. Other commands
remain blocked while pending; reads do not clear it. This reuses existing server
idempotency and does not add a retry timer, new API or durable command store.

The project page displays one Retry original save control, pauses creation/lifecycle
controls until resolution, and keeps retry gated behind the current ready page state.
After lifecycle reconciliation it fetches current project state instead of installing
a historical receipt as current. Creation routes to the saved project's protected page.
Server authentication and authorization still run on every explicit retry.

Pending memory does not survive page reload or closure. The recovery text tells the
owner to keep the tab open; this block does not claim durable browser recovery. No
protected draft or request key is persisted in browser storage. Task execution retries
and their separate uncertainty rules are unchanged.

Tests cover a newer GET, caller mutation, unchanged body/key, empty retry rejection,
pending clearance on matching receipt, inert recovery markup, and the actual protected
handler/PGlite lost-create-plus-other-tab-archive scenario through retryPending. Test,
build and compiled results are recorded in BUILD_STATUS.md. Actual DOM clicks remain
unverified while the Mac is locked. No downloads, GitHub, credentials or service effects.
