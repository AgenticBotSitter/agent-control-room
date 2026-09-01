# CR12B-IDEA-110B — fixed Hermes local/SSH bridge acceptance

**Status:** Initial implementation rejected by independent review; IDEA-110D remediation is implemented and awaits a
different independent re-review.

## Outcome

Control Room now has the repository half of the fixed Hermes bridge. It uses an already enrolled Hermes Desktop route
instead of modifying Hermes or starting its own SSH connection. The platform connector retains the hostname, username,
port, key, gateway value, protected value, profile path, and native session identifier. Control Room sees only signed
opaque digests, a short route lease digest, a safe session identity digest, and sanitized fixed-method receipts.

No native connector is configured by default. This block made no SSH connection, native attempt, provider call,
credential read, protected-value access, Hermes modification, deployment, or repository-external write.

## Implemented boundary

- `hermes-021-fixed-rpc-bridge.ts` converts one signed qualification request into a closed method sequence:
  `session.create`, `prompt.submit`, `session.events.since`, `session.status`, and `session.usage`, followed during required
  cleanup by `session.interrupt`, `session.status`, and `session.close`.
- Hermes Desktop remains responsible for local/SSH connection ownership, pooling, native identifiers, reconnect, and
  routing. Control Room cannot supply a host, open a shell, select a key, or recover a native session identifier.
- Gateway epoch changes, replay truncation, event gaps, terminal-order errors, malformed structured output, binding
  drift, usage arithmetic drift, unexpected fields, Proxy results, and uncertain calls fail closed. There is no retry.
- Streaming message and reasoning deltas are discarded. Only the bounded JSON terminal result, exact usage, safe
  identity digests, and cleanup proof enter the existing filtered driver.
- Attempt-bound route cleanup runs even when route opening was uncertain. A successful cleanup proves the native session
  closed, lease released, disposable state removed, and zero retained native references.
- The owner permit now signs both participant identity and runtime identity. The enrollment and permit method set now
  explicitly includes `session.close`.
- Six exact Hermes source files pin the Desktop JSON-RPC/reconnect path, gateway routing, SSH connection manager,
  connection registry, session methods, and native certification lifecycle for revision
  `a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b`.

## Verification

Seven focused hostile bridge tests cover the success and definite-failure paths, exact operation order, content
discarding, no locator leakage, replay/epoch/output/usage failures, Proxy rejection, no retry, uncertain-open cleanup,
identity drift, one-use execution/cleanup, and source-level absence of process, filesystem, network, SSH, credential, or
Hermes-modification clients. Existing driver, enrollment, and gateway tests also pass with the tightened identity and
cleanup bindings. The combined CR12B suite passes 127/127. TypeScript validation, full lint, Mac stage zero, and
whitespace validation pass. The complete npm lifecycle, production build, 3/3 rendered route tests, and all 32
migrations with 110 PostgreSQL tables also pass.

## Independent review and remediation

Independent review of commit `0a736ad16e1ea7ffef37e434eba5bd46f483f95d` found four High defects: concrete
collaborator methods lost their receivers, cleanup could report completion while execution was still pending, signed
enrollment included two unused operations, and expiry was not rechecked after durable claim. The immutable negative
report remains authoritative evidence.

IDEA-110D remediation commit `bb1faf989486bb3b16226d9a4cbec2223ef4e5f2` binds the original receivers, serializes
execution and cleanup, cancels and rechecks around every connector await, narrows enrollment to the exact seven used
operations, and rechecks trusted time immediately before bridge entry. A different independent reviewer must accept all
four repairs. After that, Control Room must still accept a platform connector, enroll its node signer, create one real
signed local or SSH enrollment, refresh every implementation/source/packet digest, and prove an effect-free preflight.
Only a new owner-attended authorization may later permit one native qualification. No previous authorization is reusable.
